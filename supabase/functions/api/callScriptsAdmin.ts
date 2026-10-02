/**
 * Targeted call scripts — the api's pure helpers (contract docs/CALL-SCRIPTS.md; routes in index.ts
 * "CALL SCRIPTS (targeted)"). No network, no Deno globals: vitest covers it.
 *
 *   parse*            request bodies / queries → validated input (the SQL writers re-validate)
 *   mapWriterError    a call_script_* writer error (SQLSTATE + HINT) → HTTP status + {error, code}
 *   duplicateTargets  split none | product | group | cell → the writer's targets (≤ 50)
 *   buildCallContext  what the route fetched → ScriptContext + ScriptVars + the match context
 *   redactVars        privacy flags → name / city / last_* dropped
 *   shapeLibrary      call_scripts rows → TargetedScript[] (+ lint, updated_by_name), filtered
 *   shapeCoverage     call_script_demand() rows × lists × scripts → the coverage grid
 */
import {
  ALL_GROUPS, buildTwins, groupOfLeadStatus, groupOfListName, isScriptGroup, lintScript, matchScripts,
  productFamilyKey, validateSections,
  type MatchableScript, type MatchContext, type MatchTier, type ScriptGroup,
} from "./callScriptMatch.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

export type Fail = { ok: false; status: number; code: string; error: string };
const fail = (code: string, error: string, status = 400): Fail => ({ ok: false, status, code, error });

// ── Mode ────────────────────────────────────────────────────────────────────

export const SCRIPTS_MODES = ["off", "preview", "on"] as const;
export type ScriptsMode = typeof SCRIPTS_MODES[number];

/** app_settings.call_scripts.value → the mode (anything unknown = off). */
export function modeOf(value: unknown): ScriptsMode {
  const m = (value && typeof value === "object" ? (value as any).mode : null) as unknown;
  return (SCRIPTS_MODES as readonly string[]).includes(m as string) ? (m as ScriptsMode) : "off";
}

/** off → nobody; preview → admins / managers; on → every caller of /calls. */
export const scriptsEnabledFor = (mode: ScriptsMode, isAdminOrManager: boolean) =>
  mode === "on" || (mode === "preview" && isAdminOrManager);

export function parseNote(raw: unknown): { ok: true; note: string | null } | Fail {
  if (raw == null) return { ok: true, note: null };
  if (typeof raw !== "string") return fail("bad_note", "note must be text");
  const n = raw.trim();
  if (n.length > 500) return fail("note_too_long", "note is too long (max 500)");
  return { ok: true, note: n || null };
}

export function parseMode(raw: unknown): { ok: true; mode: ScriptsMode; note: string | null } | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_body", "Body must be {mode, note?}");
  const b = raw as Record<string, unknown>;
  if (!(SCRIPTS_MODES as readonly string[]).includes(b.mode as string)) return fail("bad_mode", "mode is off, preview or on");
  const n = parseNote(b.note);
  if (!n.ok) return n;
  return { ok: true, mode: b.mode as ScriptsMode, note: n.note };
}

// ── Script patches ──────────────────────────────────────────────────────────

const PATCH_KEYS = ["title", "description", "status", "groups", "product_ids", "priority", "sections", "helpers", "translations", "script_text"] as const;
export type ScriptPatchIn = Partial<Record<typeof PATCH_KEYS[number], unknown>>;

/**
 * A patch's shape (the SQL writer re-validates everything and owns the legacy / derived rules).
 * Refuses unknown fields, bad groups / product ids / priority / status and invalid sections early,
 * with the same codes the writer uses.
 */
export function parseScriptPatch(raw: unknown): { ok: true; patch: ScriptPatchIn } | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_body", "patch must be an object");
  const p = raw as Record<string, unknown>;
  for (const k of Object.keys(p)) {
    if (!(PATCH_KEYS as readonly string[]).includes(k)) return fail("unknown_field", `unknown field: ${k}`);
  }
  if ("title" in p && (typeof p.title !== "string" || p.title.trim().length > 200)) return fail("bad_title", "title must be text ≤ 200");
  if ("description" in p && p.description !== null && (typeof p.description !== "string" || p.description.length > 2000)) {
    return fail("bad_description", "description must be text ≤ 2000");
  }
  if ("status" in p && !["draft", "published", "archived"].includes(p.status as string)) return fail("bad_status", "status is draft, published or archived");
  if ("groups" in p) {
    if (!Array.isArray(p.groups) || !p.groups.every(isScriptGroup)) return fail("bad_group", "groups must be group ids");
  }
  if ("product_ids" in p) {
    if (!Array.isArray(p.product_ids) || !p.product_ids.every(isUuid)) return fail("unknown_product", "product_ids must be product ids");
    if (new Set(p.product_ids as string[]).size > 300) return fail("too_many_products", "at most 300 products per script");
  }
  if ("priority" in p && (typeof p.priority !== "number" || !Number.isInteger(p.priority) || p.priority < -100 || p.priority > 100)) {
    return fail("bad_priority", "priority must be a whole number between -100 and 100");
  }
  if ("sections" in p) {
    const v = validateSections(p.sections);
    if (!v.ok) return fail("bad_sections", `invalid sections: ${v.errors.map((e) => `${e.code}${e.index >= 0 ? `:${e.index + 1}` : ""}`).join(", ")}`);
  }
  if ("helpers" in p && !Array.isArray(p.helpers)) return fail("bad_helpers", "helpers must be a list");
  if ("translations" in p && p.translations !== null && (typeof p.translations !== "object" || Array.isArray(p.translations))) {
    return fail("bad_translations", "translations must be {sq: …}");
  }
  if ("script_text" in p && typeof p.script_text !== "string") return fail("bad_script_text", "script_text must be text");
  return { ok: true, patch: p as ScriptPatchIn };
}

export function parseCreateBody(raw: unknown): { ok: true; patch: ScriptPatchIn; note: string | null } | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_body", "Body must be {patch, note?}");
  const b = raw as Record<string, unknown>;
  const p = parseScriptPatch(b.patch);
  if (!p.ok) return p;
  if ("script_text" in p.patch) return fail("script_text_derived", "script_text is derived from the sections");
  if ("status" in p.patch && p.patch.status === "archived") return fail("bad_status", "a new script is a draft or published");
  const n = parseNote(b.note);
  if (!n.ok) return n;
  return { ok: true, patch: p.patch, note: n.note };
}

export function parseUpdateBody(raw: unknown): { ok: true; expected_version: number; patch: ScriptPatchIn; note: string | null } | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_body", "Body must be {expected_version, patch, note?}");
  const b = raw as Record<string, unknown>;
  if (typeof b.expected_version !== "number" || !Number.isInteger(b.expected_version) || b.expected_version < 1) {
    return fail("expected_version_required", "expected_version (the version you edited) is required");
  }
  const p = parseScriptPatch(b.patch);
  if (!p.ok) return p;
  const n = parseNote(b.note);
  if (!n.ok) return n;
  return { ok: true, expected_version: b.expected_version, patch: p.patch, note: n.note };
}

export function parseRestore(raw: unknown): { ok: true; version: number; note: string | null } | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_body", "Body must be {version, note?}");
  const b = raw as Record<string, unknown>;
  if (typeof b.version !== "number" || !Number.isInteger(b.version) || b.version < 1) return fail("bad_version", "version must be a version number");
  const n = parseNote(b.note);
  if (!n.ok) return n;
  return { ok: true, version: b.version, note: n.note };
}

// ── Duplicate ───────────────────────────────────────────────────────────────

export type DuplicateSplit = "none" | "product" | "group" | "cell";
export interface DuplicateTarget { title: string; groups: ScriptGroup[]; product_ids: string[] }
export const MAX_DUPLICATES = 50;

/** Macedonian group names for generated copy titles (the UI shows its own i18n labels). */
export const GROUP_LABEL_MK: Readonly<Record<ScriptGroup, string>> = {
  lead_new: "Нов лид",
  lead_callback: "Повторен повик",
  newcomers: "Нови купувачи",
  d21: "21–57 дена",
  d57: "57–120 дена",
  m4_6: "4–6 месеци",
  m6_12: "6–12 месеци",
  y1_2: "1–2 години",
  y2plus: "Над 2 години",
  cancels: "Откажувања",
  never_converted: "Никогаш не купиле",
  trash: "Корпа",
};

export function parseDuplicate(raw: unknown): { ok: true; groups: ScriptGroup[]; product_ids: string[]; split: DuplicateSplit; note: string | null } | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_body", "Body must be {groups, product_ids, split, note?}");
  const b = raw as Record<string, unknown>;
  const groups = b.groups ?? [];
  const products = b.product_ids ?? [];
  if (!Array.isArray(groups) || !groups.every(isScriptGroup)) return fail("bad_group", "groups must be group ids");
  if (!Array.isArray(products) || !products.every(isUuid)) return fail("unknown_product", "product_ids must be product ids");
  const split = (b.split ?? "none") as DuplicateSplit;
  if (!["none", "product", "group", "cell"].includes(split)) return fail("bad_targets", "split is none, product, group or cell");
  const n = parseNote(b.note);
  if (!n.ok) return n;
  const g = ALL_GROUPS.filter((x) => (groups as string[]).includes(x)) as ScriptGroup[];
  const p = [...new Set(products as string[])];
  if ((split === "product" || split === "cell") && p.length === 0) return fail("bad_targets", "split by product needs products");
  if ((split === "group" || split === "cell") && g.length === 0) return fail("bad_targets", "split by group needs groups");
  return { ok: true, groups: g, product_ids: p, split, note: n.note };
}

/**
 * The writer's targets: none → one copy with every group + product; product → one per product
 * (all the groups); group → one per group (all the products); cell → one per group × product.
 * Titles: "<source> · <group> · <product>". Refuses more than 50.
 */
export function duplicateTargets(
  sourceTitle: string,
  input: { groups: ScriptGroup[]; product_ids: string[]; split: DuplicateSplit },
  productName: (id: string) => string | null,
): { ok: true; targets: DuplicateTarget[] } | Fail {
  const base = (sourceTitle || "").trim() || "Скрипта";
  const gName = (g: ScriptGroup) => GROUP_LABEL_MK[g];
  const pName = (id: string) => productName(id) ?? id.slice(0, 8);
  const title = (parts: string[]) => [base, ...parts].join(" · ").slice(0, 200);
  const out: DuplicateTarget[] = [];
  const { groups, product_ids, split } = input;
  if (split === "none") out.push({ title: base.slice(0, 200), groups, product_ids });
  else if (split === "product") for (const p of product_ids) out.push({ title: title([pName(p)]), groups, product_ids: [p] });
  else if (split === "group") for (const g of groups) out.push({ title: title([gName(g)]), groups: [g], product_ids });
  else for (const g of groups) for (const p of product_ids) out.push({ title: title([gName(g), pName(p)]), groups: [g], product_ids: [p] });
  if (out.length > MAX_DUPLICATES) return fail("too_many", `at most ${MAX_DUPLICATES} copies at once (this split makes ${out.length})`);
  return { ok: true, targets: out };
}

// ── Bulk ────────────────────────────────────────────────────────────────────

export interface BulkOpIn {
  add_groups?: ScriptGroup[];
  remove_groups?: ScriptGroup[];
  add_products?: string[];
  remove_products?: string[];
  status?: "draft" | "published" | "archived";
  priority?: number;
}

export function parseBulk(raw: unknown): { ok: true; ids: string[]; op: BulkOpIn; note: string | null } | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_body", "Body must be {ids, op, note?}");
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.ids) || b.ids.length === 0 || !b.ids.every(isUuid)) return fail("bad_op", "ids must be script ids");
  const ids = [...new Set(b.ids as string[])];
  if (ids.length > 200) return fail("too_many", "at most 200 scripts at once");
  const op = b.op;
  if (!op || typeof op !== "object" || Array.isArray(op)) return fail("bad_op", "op must be an object");
  const o = op as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return fail("bad_op", "op is empty");
  const out: BulkOpIn = {};
  for (const k of keys) {
    const v = o[k];
    if (k === "add_groups" || k === "remove_groups") {
      if (!Array.isArray(v) || !v.every(isScriptGroup)) return fail("bad_group", `${k} must be group ids`);
      out[k] = v as ScriptGroup[];
    } else if (k === "add_products" || k === "remove_products") {
      if (!Array.isArray(v) || !v.every(isUuid)) return fail("unknown_product", `${k} must be product ids`);
      out[k] = v as string[];
    } else if (k === "status") {
      if (!["draft", "published", "archived"].includes(v as string)) return fail("bad_status", "status is draft, published or archived");
      out.status = v as BulkOpIn["status"];
    } else if (k === "priority") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < -100 || v > 100) return fail("bad_priority", "priority must be a whole number between -100 and 100");
      out.priority = v;
    } else return fail("bad_op", `unknown op: ${k}`);
  }
  const n = parseNote(b.note);
  if (!n.ok) return n;
  return { ok: true, ids, op: out, note: n.note };
}

// ── Writer errors ───────────────────────────────────────────────────────────

/** A PostgREST / supabase-js error from a call_script_* writer → HTTP. The machine code is the HINT. */
export function mapWriterError(err: { code?: string | null; hint?: string | null; details?: string | null; message?: string | null } | null | undefined):
  { status: number; body: { error: string; code: string; current_version?: number; detail?: string } } {
  const sqlstate = err?.code ?? "";
  const hint = (err?.hint ?? "").trim();
  const message = (err?.message ?? "The call script could not be saved").slice(0, 300);
  if (sqlstate === "CS409") {
    const v = Number(err?.details);
    return { status: 409, body: { error: "Somebody saved a newer version — reload it before saving again.", code: "stale", ...(Number.isFinite(v) ? { current_version: v } : {}) } };
  }
  if (sqlstate === "CS404") return { status: 404, body: { error: message, code: "not_found" } };
  if (sqlstate === "42501") return { status: 403, body: { error: message, code: hint || "forbidden" } };
  if (sqlstate === "22023") {
    return { status: 400, body: { error: message, code: hint || "invalid", ...(err?.details ? { detail: String(err.details).slice(0, 300) } : {}) } };
  }
  return { status: 500, body: { error: "The call script could not be saved", code: "failed" } };
}

// ── Rows → TargetedScript ───────────────────────────────────────────────────

export interface ScriptRow {
  id: string;
  context_type: string;
  status: string;
  title: string;
  description: string | null;
  script_text?: string | null;
  sections: unknown;
  helpers: unknown;
  translations: unknown;
  groups: string[] | null;
  product_ids: string[] | null;
  priority: number | null;
  version: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
  updated_by: string | null;
  published_at: string | null;
  published_by: string | null;
  copied_from: string | null;
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** A database row in the contract's TargetedScript shape (arrays / objects never null; only sq translations). */
export function shapeScriptRow(r: ScriptRow, opts: { lint?: boolean; names?: ReadonlyMap<string, string> } = {}) {
  const tr = obj(r.translations);
  const sq = tr.sq && typeof tr.sq === "object" && !Array.isArray(tr.sq) ? tr.sq : undefined;
  const out: Record<string, any> = {
    id: r.id,
    context_type: r.context_type,
    status: r.status,
    title: r.title ?? "",
    description: r.description ?? null,
    sections: arr(r.sections),
    helpers: arr(r.helpers),
    translations: sq ? { sq } : {},
    groups: arr<string>(r.groups).filter(isScriptGroup),
    product_ids: arr<string>(r.product_ids),
    priority: r.priority ?? 0,
    version: r.version ?? 1,
    created_at: r.created_at,
    created_by: r.created_by ?? null,
    updated_at: r.updated_at,
    updated_by: r.updated_by ?? null,
    published_at: r.published_at ?? null,
    published_by: r.published_by ?? null,
    copied_from: r.copied_from ?? null,
    script_text: r.script_text ?? "",
  };
  if (opts.lint) out.lint = lintScript(out as any);
  if (opts.names) out.updated_by_name = r.updated_by ? opts.names.get(r.updated_by) ?? null : null;
  return out;
}

export interface LibraryQuery {
  status: "draft" | "published" | "archived" | "all";
  group: ScriptGroup | "none" | null;
  product: string | null;
  q: string | null;
}

export function parseLibraryQuery(sp: URLSearchParams): { ok: true; query: LibraryQuery } | Fail {
  const status = (sp.get("status") || "all") as LibraryQuery["status"];
  if (!["draft", "published", "archived", "all"].includes(status)) return fail("bad_status", "status is draft, published, archived or all");
  const g = sp.get("group");
  if (g && g !== "none" && !isScriptGroup(g)) return fail("bad_group", "unknown group");
  const product = sp.get("product");
  if (product && !isUuid(product)) return fail("unknown_product", "product must be a product id");
  const q = (sp.get("q") || "").trim().slice(0, 100) || null;
  return { ok: true, query: { status, group: (g as LibraryQuery["group"]) || null, product: product || null, q } };
}

/**
 * The library: targeted rows + the legacy `product` rows (the order / prediction_lead rows have
 * their own tabs). Agents see published rows only. Filters: status, group ("none" = every-group
 * scripts), product, a text search over title / description / script_text (both languages).
 * Order: published, draft, archived; then the newest change first.
 */
export function shapeLibrary(rows: ScriptRow[], opts: { canSeeDrafts: boolean; query: LibraryQuery; names: ReadonlyMap<string, string> }) {
  const { query } = opts;
  const needle = query.q ? query.q.toLowerCase() : null;
  const rank: Record<string, number> = { published: 0, draft: 1, archived: 2 };
  return rows
    .filter((r) => r.context_type === "targeted" || r.context_type === "product")
    .filter((r) => opts.canSeeDrafts || r.status === "published")
    .filter((r) => query.status === "all" || r.status === query.status)
    .filter((r) => {
      if (!query.group) return true;
      const g = arr<string>(r.groups);
      return query.group === "none" ? g.length === 0 : g.includes(query.group);
    })
    .filter((r) => !query.product || arr<string>(r.product_ids).includes(query.product))
    .filter((r) => {
      if (!needle) return true;
      const sq = obj(obj(r.translations).sq);
      return [r.title, r.description, r.script_text, sq.title, sq.description, sq.script_text]
        .some((t) => typeof t === "string" && t.toLowerCase().includes(needle));
    })
    .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
    .map((r) => shapeScriptRow(r, { lint: true, names: opts.names }));
}

export interface ProductIndexSource { id: string; name: string; brand_line: string | null; kind: string | null; is_active: boolean | null; price?: number | null }

export function shapeProductIndex(rows: ProductIndexSource[]) {
  return rows
    .map((p) => ({ id: p.id, name: p.name, brand_line: p.brand_line ?? null, kind: p.kind ?? null, is_active: p.is_active !== false, family: productFamilyKey(p.name) }))
    .sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name));
}

// ── The call context ────────────────────────────────────────────────────────

export interface CallOrderRow {
  id: string;
  display_id: string | null;
  status: string;
  created_at: string;
  product_id: string | null;
  product_name: string | null;
  customer_name: string | null;
  customer_city: string | null;
}
export interface CallMemberRow {
  customer_name: string | null;
  last_paid_at: string | null;
  trigger_order_id: string | null;
  product_name: string | null;
}
export interface LastSaleRow { product_id: string | null; product_name: string | null; sale_at: string | null }

export interface CallContextInput {
  source: "lead" | "prediction" | "manual";
  /** How the group was decided (the route resolves manual). */
  basis: "order_status" | "list_name" | "attribution" | "none";
  /** The open lead order (lead basis). */
  order?: CallOrderRow | null;
  orderItems?: { product_id: string | null; product_name: string | null }[];
  /** The list (list_name / attribution basis). */
  list?: { id: string; name: string } | null;
  member?: CallMemberRow | null;
  /** The member's trigger order and its items. */
  triggerOrder?: { product_id: string | null; product_name: string | null; customer_city: string | null } | null;
  triggerItems?: { product_id: string | null; product_name: string | null }[];
  lastSale?: LastSaleRow | null;
  /** Catalogue lookup: id → {name, price EUR}. */
  products: ReadonlyMap<string, { name: string; price: number | null }>;
  knownName?: string | null;
  agentName: string | null;
  now: Date;
}

export interface BuiltContext {
  context: {
    source: "lead" | "prediction" | "manual";
    group: ScriptGroup | null;
    group_basis: "order_status" | "list_name" | "attribution" | "none";
    list_name: string | null;
    order: { id: string; display_id: string | null; status: "pending" | "take" | "call_again"; created_at: string } | null;
    product: { id: string; name: string; price_eur: number | null } | null;
    products: { id: string; name: string }[];
    last_purchase: { at: string; product_name: string | null } | null;
    days_since_purchase: number | null;
    callback: boolean;
  };
  vars: {
    customer_name: string | null; first_name: string | null; agent_name: string | null; product: string | null; price_eur: number | null;
    last_product: string | null; last_purchase_at: string | null; days_since_purchase: number | null; city: string | null; order_id: string | null;
  };
  match: Omit<MatchContext, "twins">;
}

const clean = (s: string | null | undefined) => (typeof s === "string" && s.trim() ? s.trim() : null);

/** Everything the dock needs about a call, from what the route fetched. Unredacted — redactVars next. */
export function buildCallContext(input: CallContextInput): BuiltContext {
  const ids: string[] = [];
  const push = (id: string | null | undefined) => { if (id && !ids.includes(id)) ids.push(id); };
  let primary: string | null = null;
  let group: ScriptGroup | null = null;
  let order: BuiltContext["context"]["order"] = null;
  let city: string | null = null;
  let name: string | null = null;

  if (input.basis === "order_status" && input.order) {
    const o = input.order;
    group = groupOfLeadStatus(o.status);
    order = group ? { id: o.id, display_id: o.display_id ?? null, status: o.status as "pending" | "take" | "call_again", created_at: o.created_at } : null;
    primary = o.product_id ?? null;
    push(o.product_id);
    for (const it of input.orderItems ?? []) push(it.product_id);
    if (!primary) primary = ids[0] ?? null;
    city = clean(o.customer_city);
    name = clean(o.customer_name);
  } else if ((input.basis === "list_name" || input.basis === "attribution") && input.list) {
    group = groupOfListName(input.list.name);
  }

  if (input.basis !== "order_status") {
    const t = input.triggerOrder;
    if (t?.product_id || (input.triggerItems ?? []).some((i) => i.product_id)) {
      primary = t?.product_id ?? null;
      push(t?.product_id);
      for (const it of input.triggerItems ?? []) push(it.product_id);
      if (!primary) primary = ids[0] ?? null;
    } else if (input.lastSale?.product_id) {
      primary = input.lastSale.product_id;
      push(primary);
    }
    city = clean(t?.customer_city);
    name = clean(input.member?.customer_name);
  }
  name = name ?? clean(input.knownName);

  // last purchase: the member's last paid, else the last real sale
  const lastAt = input.member?.last_paid_at ?? input.lastSale?.sale_at ?? null;
  const lastName = clean(input.lastSale?.product_name) ?? clean(input.member?.product_name) ?? clean(input.triggerOrder?.product_name);
  const lastMs = lastAt ? Date.parse(lastAt) : NaN;
  const days = Number.isFinite(lastMs) ? Math.max(0, Math.floor((input.now.getTime() - lastMs) / 86_400_000)) : null;

  const products = ids.map((id) => ({ id, name: input.products.get(id)?.name ?? "" })).filter((p) => p.name);
  const prim = primary ? input.products.get(primary) : undefined;
  const product = primary && prim ? { id: primary, name: prim.name, price_eur: typeof prim.price === "number" ? prim.price : null } : null;
  const fallbackProductName = clean(input.order?.product_name) ?? clean(input.triggerOrder?.product_name);

  return {
    context: {
      source: input.source,
      group,
      group_basis: input.basis,
      list_name: input.list?.name ?? null,
      order,
      product,
      products,
      last_purchase: lastAt ? { at: lastAt, product_name: lastName } : null,
      days_since_purchase: days,
      callback: group === "lead_callback",
    },
    vars: {
      customer_name: name,
      first_name: name ? name.split(/\s+/)[0] : null,
      agent_name: clean(input.agentName),
      product: product?.name ?? fallbackProductName,
      price_eur: product?.price_eur ?? null,
      last_product: lastName,
      last_purchase_at: lastAt,
      days_since_purchase: days,
      city,
      order_id: order ? (order.display_id ?? order.id) : null,
    },
    match: { group, primary, products: ids },
  };
}

/** Privacy: no name without show_customer_name, no city without show_customer_address, no last_* without show_order_history. */
export function redactVars<T extends BuiltContext>(built: T, pii: { name: boolean; addr: boolean }, showOrderHistory: boolean): T {
  const vars = { ...built.vars };
  const context = { ...built.context };
  if (!pii.name) { vars.customer_name = null; vars.first_name = null; }
  if (!pii.addr) vars.city = null;
  if (!showOrderHistory) {
    vars.last_product = null;
    vars.last_purchase_at = null;
    vars.days_since_purchase = null;
    context.last_purchase = null;
    context.days_since_purchase = null;
  }
  return { ...built, vars, context };
}

// ── Coverage ────────────────────────────────────────────────────────────────

export interface DemandRow {
  kind: "member" | "lead";
  list_id: string | null;
  lead_group: string | null;
  product_id: string | null;
  product_name: string | null;
  waiting: number;
  assigned: number;
}

interface Cell {
  waiting: number;
  assigned: number;
  winner: { script_id: string; title: string; tier: MatchTier } | null;
  draft_winner: { script_id: string; title: string; tier: MatchTier } | null;
  overlap: number;
}

type CoverageScript = MatchableScript & { title: string };

/**
 * The coverage grid: waiting clients per group × product (members by their list's group, leads by
 * status), the published winner of each cell, the draft that would win in preview, how many
 * published scripts compete. families → twins share one row. assignedOnly → count assigned only.
 * Members of null-group lists (Current Returns, uploaded lists) are outside the grid and reported apart.
 */
export function shapeCoverage(
  demand: DemandRow[],
  lists: { id: string; name: string }[],
  scripts: CoverageScript[],
  products: ProductIndexSource[],
  opts: { families: boolean; assignedOnly?: boolean; now?: Date },
) {
  const groupOfList = new Map(lists.map((l) => [l.id, groupOfListName(l.name)]));
  const twins = buildTwins(products);
  const byId = new Map(products.map((p) => [p.id, p]));
  const count = (r: DemandRow) => (opts.assignedOnly ? r.assigned : r.waiting);

  const blank = (): Cell => ({ waiting: 0, assigned: 0, winner: null, draft_winner: null, overlap: 0 });
  const blankRow = () => Object.fromEntries(ALL_GROUPS.map((g) => [g, blank()])) as Record<ScriptGroup, Cell>;

  // product id → row key
  const keyOf = (pid: string) => {
    if (!opts.families) return pid;
    const fam = twins[pid];
    if (!fam || fam.length === 0) return pid;
    return productFamilyKey(byId.get(pid)?.name ?? pid);
  };
  const rows = new Map<string, { key: string; product_ids: string[]; name: string; brand_line: string | null; kind: string | null; waiting: number; cells: Record<ScriptGroup, Cell> }>();
  const allProducts = blankRow();
  let outside = 0;
  const outsideByList = new Map<string, number>();

  for (const r of demand) {
    const g = r.kind === "lead" ? (isScriptGroup(r.lead_group) ? r.lead_group : null) : (r.list_id ? groupOfList.get(r.list_id) ?? null : null);
    const n = count(r);
    if (!g) {
      outside += n;
      if (r.list_id) outsideByList.set(r.list_id, (outsideByList.get(r.list_id) ?? 0) + n);
      continue;
    }
    allProducts[g].waiting += r.waiting;
    allProducts[g].assigned += r.assigned;
    if (!r.product_id) continue;
    const key = keyOf(r.product_id);
    let row = rows.get(key);
    if (!row) {
      const p = byId.get(r.product_id);
      row = { key, product_ids: [], name: p?.name ?? r.product_name ?? r.product_id, brand_line: p?.brand_line ?? null, kind: p?.kind ?? null, waiting: 0, cells: blankRow() };
      rows.set(key, row);
    }
    if (!row.product_ids.includes(r.product_id)) row.product_ids.push(r.product_id);
    row.cells[g].waiting += r.waiting;
    row.cells[g].assigned += r.assigned;
    row.waiting += n;
  }
  // a product a script names but nobody waits for still gets a row (so the owner sees his script)
  for (const s of scripts) {
    for (const pid of s.product_ids ?? []) {
      if (!byId.has(pid)) continue;
      const key = keyOf(pid);
      if (!rows.has(key)) {
        const p = byId.get(pid)!;
        rows.set(key, { key, product_ids: [pid], name: p.name, brand_line: p.brand_line ?? null, kind: p.kind ?? null, waiting: 0, cells: blankRow() });
      }
    }
  }
  // folded families: every twin id in the row
  if (opts.families) {
    for (const row of rows.values()) {
      for (const pid of [...row.product_ids]) for (const t of twins[pid] ?? []) if (!row.product_ids.includes(t)) row.product_ids.push(t);
    }
  }

  const winners = (ctx: MatchContext) => {
    const pub = matchScripts(scripts, ctx, { alternatives: 0 });
    const dr = matchScripts(scripts, ctx, { includeDrafts: true, alternatives: 0 });
    const w = pub.best ? { script_id: pub.best.script.id, title: pub.best.script.title, tier: pub.best.match.tier } : null;
    const d = dr.best && dr.best.script.id !== w?.script_id ? { script_id: dr.best.script.id, title: dr.best.script.title, tier: dr.best.match.tier } : null;
    return { winner: w, draft_winner: d, overlap: pub.ranked.length };
  };

  let total = 0;
  let covered = 0;
  let emptyCells = 0;
  for (const g of ALL_GROUPS) {
    const ctx: MatchContext = { group: g, primary: null, products: [], twins };
    Object.assign(allProducts[g], winners(ctx));
  }
  for (const row of rows.values()) {
    for (const g of ALL_GROUPS) {
      const c = row.cells[g];
      Object.assign(c, winners({ group: g, primary: row.product_ids[0] ?? null, products: row.product_ids, twins }));
    }
  }
  // totals over the cells that hold clients: product rows + the clients with no product (the all-products winner)
  for (const g of ALL_GROUPS) {
    let inRows = 0;
    for (const row of rows.values()) {
      const c = row.cells[g];
      const n = opts.assignedOnly ? c.assigned : c.waiting;
      inRows += n;
      total += n;
      if (c.winner) covered += n;
      else if (n > 0) emptyCells++;
    }
    const all = allProducts[g];
    const rest = Math.max(0, (opts.assignedOnly ? all.assigned : all.waiting) - inRows);
    total += rest;
    if (all.winner) covered += rest;
    else if (rest > 0) emptyCells++;
  }

  const targeted = scripts.filter((s) => s.context_type === "targeted");
  return {
    generated_at: (opts.now ?? new Date()).toISOString(),
    groups: [...ALL_GROUPS],
    all_products: allProducts,
    rows: [...rows.values()].sort((a, b) => b.waiting - a.waiting || a.name.localeCompare(b.name)),
    outside: { waiting: outside, lists: [...outsideByList.entries()].map(([list_id, waiting]) => ({ list_id, name: lists.find((l) => l.id === list_id)?.name ?? null, waiting })) },
    totals: {
      waiting: total,
      covered,
      covered_pct: total > 0 ? Math.round((covered / total) * 1000) / 10 : 0,
      empty_cells_with_waiting: emptyCells,
      published: targeted.filter((s) => s.status === "published").length,
      drafts: targeted.filter((s) => s.status === "draft").length,
    },
  };
}
