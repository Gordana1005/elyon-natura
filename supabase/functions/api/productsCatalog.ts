// ============================================================================
// Производи 2.0 (owner 01.10.2026) — the pure half of
//   GET  /api/products/catalogue          the lean catalogue the /products page reads
//   GET  /api/products/kind-proposal      public.product_kind_proposal()   (…001400)
//   POST /api/products/kind               public.products_set_kind()       (…001400)
// and of the kind guard / field whitelist on POST + PATCH /api/products.
//
// Owner 01.10.2026: /products shows too much in one list — 706 rows where bundles, promotions,
// gifts and objects (a body scale, blender, toaster, shakers …) sit next to the products. The first
// thing the page shows must be the ordinary PRODUCTS; everything else gets a KIND:
//   product  a single supplement / cosmetic sold as a product (the default view)
//   bundle   "Пакети и промоции" — 1+1, 2+1, 2x, 3x, сет, PACK, Combo, пакет, гратис, подарок …
//   gift     "Подароци" — an item used as a free gift (mostly a 0-денари line next to a paid one)
//   other    "Друго" — a physical object that is not a supplement (вага, блендер, тостер, шејкер …)
//   NULL     "Неодредено"
//
// The classifier runs in SQL (product_kind_by_name() + product_kind_proposal()) and here
// (classifyKindByName / proposeKind, used by vitest and by the product form's live hint). The
// regex SOURCES below are copied verbatim into the migration; productsCatalog.test.ts reads the
// migration and fails if one drifts. Keep both to the subset POSIX ARE and JavaScript agree on:
// no \b / \y, explicit Cyrillic ranges, lookarounds allowed, input lower-cased first.
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs it in Node.
// ============================================================================

import { productVatOf, type VatRate } from "./vatRates.ts";

export const PRODUCT_KINDS = ["product", "bundle", "gift", "other"] as const;
export type ProductKind = typeof PRODUCT_KINDS[number];
export const isProductKind = (v: unknown): v is ProductKind =>
  typeof v === "string" && (PRODUCT_KINDS as readonly string[]).includes(v);

/** The columns only products_set_kind() may write (a DB trigger enforces it). */
export const KIND_COLUMNS = ["kind", "kind_set_by", "kind_set_at"] as const;

// ── the name classifier (SQL twin: public.product_kind_by_name) ─────────────
/** A letter or digit (Latin, Cyrillic incl. ѐ–џ = ѓ ѕ ј љ њ ќ џ). A "word boundary" is anything else. */
const W = "a-zа-яѐ-џ0-9";

/** 1+1, 2+1, 2 + 2, 30+30 … */
export const KIND_RE_PROMO = "[0-9]+\\s*\\+\\s*[0-9]+";
/** сет / set as a word, pack, пакет, combo, gratis, подарок, gift, box … anywhere. */
export const KIND_RE_BUNDLE_WORD =
  "pack|пакет|paket|combo|комбо|gratis|гратис|подар|podar|gift|box|(^|[^a-zа-яѐ-џ])(сет|set)([^a-zа-яѐ-џ]|$)";
/** 2x / 3х / 4× followed by a space, or a leading count "2 СНАИЛ …" (not "5 in 1" / "4 во 1"). */
export const KIND_RE_MULTI_PACK =
  "(^|[^a-zа-яѐ-џ0-9])[2-9]\\s*[xх×]\\s|^[2-9]\\s+(?!(in|во)\\s)(?=[a-zа-яѐ-џ])";
/** One nutrient of a single formula ("MAGNESIUM+B6", "D3+K2+BOR", "EISEN+B9+B12", "Zinc + Chromium"). */
const NUTRIENT =
  "(a|b|c|d|e|k|б|ц|д|е|к|b[0-9]{1,2}|б[0-9]{1,2}|d3|д3|k2|к2|zinc|zink|цинк|bor|бор|magnesium|магнезиум|магнесиум|chromium|хром|selenium|селен|eisen|iron|железо|calcium|калциум|folic)";
/** A "+" between two nutrients of ONE formula — replaced by " & " before looking for a joiner. */
export const KIND_RE_NUTRIENT_PLUS =
  `(?<![${W}])${NUTRIENT}\\s*\\+\\s*(?=${NUTRIENT}(?![${W}]))`;
/**
 * A "+" that joins another item: "+ Slim Complex", "+2 DR.SLIM", "+ 2x Slim", "+ C1000",
 * "+ D-Mannose" — not "+35  50 ml" (an age) and not "Ф+Ф ампули" (a one-letter name).
 */
export const KIND_RE_JOINER = "\\+\\s*([0-9]+\\s*[xх×]?\\s*)?[a-zа-яѐ-џ][a-zа-яѐ-џ0-9.-]";
/** Physical objects that are not supplements (mk / en / sq / bg words). */
export const KIND_RE_OBJECT =
  "везна|scale|peshore|бленде|blender|тостер|toaster|миксер|mixer|шејкер|шейкер|shaker|маталк|matalk|мерач|правосм|vacuum|fshes|" +
  "фигаро|пегла|ютия|телевизор|television|televizor|телефон|phone|соковник|сокоизстисквачка|juicer|бокал|kettle|" +
  "глукометар|глюкомер|glucometer|термометар|термометър|thermometer|termometer|оксиметар|оксиметър|oximeter|оксиметер|" +
  "бастун|маиц|тениск|t-shirt|хеланки|leggings|стегач|бандаж|ќебе|одеяло|blanket|batanij|апарат|бричење|самобръсначка|shaver|" +
  "машин|yoga|јога|йога|ролер|roller|roler|масажер|масажор|massager|masazhues|gua sha|гуа ша|device|divice|pajisje|" +
  "постур|posture|sponge|сунѓер|гъба за|тупфер|sharpener|острилк|brush|четк|furç|апликатор|applicator|сецко|chopper|" +
  "(^|[^a-zа-яѐ-џ])(фен|тава|тиган|таблет|уред|апар|маш)([^a-zа-яѐ-џ]|$)|" +
  // a word START only: "ашВАГАнда" is not a scale, "оРЕШОк" is not a stove
  "(^|[^a-zа-яѐ-џ])(вага|решо)";

export type KindReason =
  | "promo" | "bundle_word" | "multi_pack" | "plus_joiner" | "object_set" | "object_word"
  | "free_in_orders" | "single" | "empty_name";

export interface KindByName {
  kind: ProductKind | null;
  reason: KindReason;
  /** The words that decided it ("1+1", "подарок", "вага" …), trimmed; null for a single product. */
  hit: string | null;
}

const RE = {
  promo: new RegExp(KIND_RE_PROMO),
  bundleWord: new RegExp(KIND_RE_BUNDLE_WORD),
  multiPack: new RegExp(KIND_RE_MULTI_PACK),
  nutrientPlus: new RegExp(KIND_RE_NUTRIENT_PLUS, "g"),
  joiner: new RegExp(KIND_RE_JOINER),
  object: new RegExp(KIND_RE_OBJECT),
};

/** lower(), whitespace collapsed and trimmed — the same as the SQL's first step. */
export const kindNorm = (name: unknown): string =>
  String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** The decisive words, without the boundary characters around them (SQL: the same regexp_replace). */
export const KIND_RE_HIT_TRIM = "^[^a-zа-яѐ-џ0-9+]+|[^a-zа-яѐ-џ0-9+]+$";
const HIT_TRIM = new RegExp(KIND_RE_HIT_TRIM, "g");
const hitOf = (re: RegExp, s: string): string | null => {
  const m = s.match(re);
  if (!m) return null;
  const h = m[0].replace(HIT_TRIM, "");
  return h === "" ? m[0].trim() || m[0] : h;
};

/**
 * The kind a NAME says, first rule that fires:
 *   promo (1+1) → bundle_word (сет, pack, подарок …) → multi_pack (2x, "3 MAGNESIUM …") →
 *   a "+" joining another item (nutrient pairs of one formula don't count): every part an object →
 *   other (object_set), else bundle (plus_joiner) → an object word → other → else a single product.
 */
export function classifyKindByName(name: unknown): KindByName {
  const n = kindNorm(name);
  if (!n) return { kind: null, reason: "empty_name", hit: null };
  let hit = hitOf(RE.promo, n);
  if (hit) return { kind: "bundle", reason: "promo", hit };
  hit = hitOf(RE.bundleWord, n);
  if (hit) return { kind: "bundle", reason: "bundle_word", hit };
  hit = hitOf(RE.multiPack, n);
  if (hit) return { kind: "bundle", reason: "multi_pack", hit };
  const joined = n.replace(RE.nutrientPlus, "$1 & ");
  hit = hitOf(RE.joiner, joined);
  if (hit) {
    const parts = joined.split("+").map((p) => p.trim()).filter(Boolean);
    if (parts.length > 0 && parts.every((p) => RE.object.test(p))) {
      return { kind: "other", reason: "object_set", hit: hitOf(RE.object, n) };
    }
    return { kind: "bundle", reason: "plus_joiner", hit: "+" };
  }
  hit = hitOf(RE.object, n);
  if (hit) return { kind: "other", reason: "object_word", hit };
  return { kind: "product", reason: "single", hit: null };
}

// ── the proposal (SQL twin: public.product_kind_proposal) ────────────────────
/** A single product whose order lines are mostly free (0 ден beside a paid product) is a gift. */
export const GIFT_MIN_LINES = 20;
export const GIFT_SHARE_LOW = 0.6;
export const GIFT_SHARE_SURE = 0.9;
export const GIFT_MIN_LINES_SURE = 30;

export type KindConfidence = "high" | "low";

export interface KindStats {
  /** order lines of the product */
  lines: number;
  /** of them at 0 ден in an order that has a PAID line of another product */
  free: number;
}

export interface ProposedKind extends KindByName {
  confidence: KindConfidence;
  freeShare: number | null;
}

/**
 * The proposed kind of one product. A name that says bundle / other wins (confidence high). A
 * single product whose lines are ≥ 60 % free (≥ 20 lines) is a gift: high from ≥ 90 % of ≥ 30
 * lines, low otherwise (the owner decides). Objects stay "other" even when given away free
 * (owner: shakers are Друго).
 */
export function proposeKind(name: unknown, stats?: Partial<KindStats> | null): ProposedKind {
  const byName = classifyKindByName(name);
  const lines = Number(stats?.lines ?? 0);
  const free = Number(stats?.free ?? 0);
  const freeShare = lines > 0 ? Math.round((free / lines) * 10000) / 10000 : null;
  if (byName.kind === "product" && freeShare !== null && lines >= GIFT_MIN_LINES && freeShare >= GIFT_SHARE_LOW) {
    const sure = freeShare >= GIFT_SHARE_SURE && lines >= GIFT_MIN_LINES_SURE;
    return { kind: "gift", reason: "free_in_orders", hit: null, confidence: sure ? "high" : "low", freeShare };
  }
  return { ...byName, confidence: "high", freeShare };
}

// ── GET /products/kind-proposal ──────────────────────────────────────────────
export const KIND_REASONS: readonly KindReason[] = [
  "promo", "bundle_word", "multi_pack", "plus_joiner", "object_set", "object_word", "free_in_orders", "single", "empty_name",
];

export interface KindProposalRow {
  id: string;
  name: string;
  sku: string | null;
  is_active: boolean;
  kind: ProductKind | null;
  kind_set_at: string | null;
  kind_set_by_name: string | null;
  suggested: ProductKind | null;
  confidence: KindConfidence;
  reason: KindReason;
  hit: string | null;
  lines: number;
  free_lines: number;
  free_share: number | null;
  /** "Accept all sure" / apply-product-kinds may set it: undecided and high confidence. */
  auto: boolean;
}

export interface KindProposalSummary {
  products: number;
  suggested: Record<ProductKind | "none", number>;
  decided: number;
  auto: number;
  low: number;
  differs: number;
}

export interface KindProposalResponse {
  generated_at: string | null;
  summary: KindProposalSummary;
  rows: KindProposalRow[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v == null || v === "" ? null : num(v));
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;

export function shapeKindProposalRow(r: unknown): KindProposalRow | null {
  if (!isObj(r) || !str(r.id)) return null;
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    sku: str(r.sku),
    is_active: r.is_active === true,
    kind: oneOf(r.kind, PRODUCT_KINDS),
    kind_set_at: str(r.kind_set_at),
    kind_set_by_name: str(r.kind_set_by_name),
    suggested: oneOf(r.suggested, PRODUCT_KINDS),
    confidence: r.confidence === "low" ? "low" : "high",
    reason: oneOf(r.reason, KIND_REASONS) ?? "single",
    hit: str(r.hit),
    lines: num(r.lines),
    free_lines: num(r.free_lines),
    free_share: numOrNull(r.free_share),
    auto: r.auto === true,
  };
}

export function shapeKindProposal(data: unknown): KindProposalResponse {
  const d = isObj(data) ? data : {};
  const s = isObj(d.summary) ? d.summary : {};
  const sg = isObj(s.suggested) ? s.suggested : {};
  const rows = (Array.isArray(d.rows) ? d.rows : [])
    .map(shapeKindProposalRow)
    .filter((r): r is KindProposalRow => r !== null);
  return {
    generated_at: str(d.generated_at),
    summary: {
      products: num(s.products),
      suggested: {
        product: num(sg.product), bundle: num(sg.bundle), gift: num(sg.gift), other: num(sg.other), none: num(sg.none),
      },
      decided: num(s.decided),
      auto: num(s.auto),
      low: num(s.low),
      differs: num(s.differs),
    },
    rows,
  };
}

// ── POST /products/kind ──────────────────────────────────────────────────────
export const MAX_SET_IDS = 1000;

export interface SetKindArgs {
  ids: string[];
  /** null = back to "Неодредено". */
  kind: ProductKind | null;
}

/** Body `{ids: uuid[], kind: ProductKind | null}` — ids lower-cased and de-duplicated; `kind` must be present. */
export function parseSetKindBody(body: unknown): Ok<{ args: SetKindArgs }> | Err {
  if (!isObj(body)) return { ok: false, error: "body must be an object" };
  if (!Array.isArray(body.ids)) return { ok: false, error: "ids must be an array of product ids" };
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of body.ids) {
    const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!UUID_RE.test(id)) return { ok: false, error: "ids must be product ids (uuid)" };
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  if (ids.length === 0) return { ok: false, error: "ids is empty" };
  if (ids.length > MAX_SET_IDS) return { ok: false, error: `at most ${MAX_SET_IDS} products per call` };
  if (!("kind" in body)) return { ok: false, error: "kind is required (null = not decided)" };
  if (body.kind !== null && !isProductKind(body.kind)) {
    return { ok: false, error: `kind must be one of ${PRODUCT_KINDS.join(", ")} or null` };
  }
  return { ok: true, args: { ids, kind: body.kind as ProductKind | null } };
}

export const setKindRpcArgs = (args: SetKindArgs, actorId: string) => ({ p_ids: args.ids, p_kind: args.kind, p_actor: actorId });

export interface SetKindResult {
  kind: ProductKind | null;
  requested: number;
  updated: number;
  unchanged: number;
  missing: string[];
  changes: { id: string; name: string; from: ProductKind | null; to: ProductKind | null }[];
}

export function shapeSetKindResult(data: unknown): SetKindResult {
  const d = isObj(data) ? data : {};
  return {
    kind: oneOf(d.kind, PRODUCT_KINDS),
    requested: num(d.requested),
    updated: num(d.updated),
    unchanged: num(d.unchanged),
    missing: (Array.isArray(d.missing) ? d.missing : []).map((x) => String(x)),
    changes: (Array.isArray(d.changes) ? d.changes : []).filter(isObj).map((c) => ({
      id: String(c.id ?? ""),
      name: String(c.name ?? ""),
      from: oneOf(c.from, PRODUCT_KINDS),
      to: oneOf(c.to, PRODUCT_KINDS),
    })),
  };
}

/** A SQL refusal (22023 = bad input) is the caller's 400 with its message; anything else is sanitised by index.ts. */
export function kindRpcError(err: { code?: string; message?: string } | null | undefined): { error: string } | null {
  if (!err) return null;
  if (err.code === "22023") return { error: String(err.message || "invalid input") };
  return null;
}

/** PATCH /products/:id: the kind is set only via POST /products/kind — drop its columns (mutates `body`). */
export function stripKindFields(body: unknown): string[] {
  if (!isObj(body)) return [];
  const removed: string[] = [];
  for (const k of KIND_COLUMNS) {
    if (k in body) { delete body[k]; removed.push(k); }
  }
  return removed;
}

// ── machine text (owner 01.10: "unprofessional" — never shown) ───────────────
/**
 * Descriptions the catalogue scripts wrote on products they created ("Креиран автоматски
 * (complete-catalogue, run …): производ со продажби …", "Created for the AlterCPA history import …").
 */
export const MACHINE_DESCRIPTION_RE = /^\s*(Креиран автоматски \(|Created for the AlterCPA history import)/;
/** Categories the same scripts set ("Од продажби — collabBox/web (28.09.2026)", "Без каталог — …", "AlterCPA — нови понуди (…)"). */
export const MACHINE_CATEGORY_RE = /^\s*(Од продажби — |Без каталог — |AlterCPA — нови понуди)/;

export const isMachineDescription = (v: unknown): boolean => typeof v === "string" && MACHINE_DESCRIPTION_RE.test(v);
export const isMachineCategory = (v: unknown): boolean => typeof v === "string" && MACHINE_CATEGORY_RE.test(v);
export const humanDescription = (v: unknown): string => (typeof v === "string" && !isMachineDescription(v) ? v : "");
export const humanCategory = (v: unknown): string => (typeof v === "string" && !isMachineCategory(v) ? v : "");

// ── GET /products/catalogue ──────────────────────────────────────────────────
/**
 * One row of the lean catalogue: what the /products list, its filters and the product form need —
 * no audit columns, no photo, machine text blanked. `cost_price` only for a business owner (showCost).
 */
export interface CatalogueRow {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  price: number;
  cost_price?: number;
  suggested_price: number;
  stock_quantity: number;
  low_stock_threshold: number;
  days_of_supply_per_unit: number;
  is_active: boolean;
  category: string;
  description: string;
  supplier_id: string | null;
  supplier_name: string | null;
  brand_line: string | null;
  kind: ProductKind | null;
  created_at: string | null;
  /**
   * Stock v2 (stock_v2_product_overview, 20260945000510) — owners only (showCost + the overview):
   * the current COMPLETE Sigma purchase cost in денари without VAT (null = no complete cost; an exempt
   * product 0) and the recipe status. Absent when the caller is not an owner or the reader is not installed.
   */
  cost_mkd?: number | null;
  recipe_status?: RecipeStatus;
  /** VAT per product from Sigma (20260944000900) — present only for an owner (showVat). */
  vat_rate?: VatRate | null;
  vat_source?: string | null;
  vat_sigma_code?: string | null;
  vat_sigma_name?: string | null;
  vat_evidence?: string | null;
  vat_set_at?: string | null;
}

/** The catalogue's columns before 20260944000900 (the api falls back to it if the VAT columns are not there yet). */
export const CATALOGUE_SELECT_NO_VAT =
  "id, name, sku, barcode, price, cost_price, stock_quantity, low_stock_threshold, days_of_supply_per_unit, is_active, category, description, supplier_id, brand_line, kind, created_at, suppliers:supplier_id(name)";
export const CATALOGUE_SELECT =
  "id, name, sku, barcode, price, cost_price, stock_quantity, low_stock_threshold, days_of_supply_per_unit, is_active, category, description, supplier_id, brand_line, kind, created_at, vat_rate, vat_source, vat_sigma_code, vat_sigma_name, vat_evidence, vat_set_at, suppliers:supplier_id(name)";

/** A PostgREST error about a missing VAT column (the migration is not applied yet). */
export const isMissingVatColumn = (err: { message?: string; code?: string } | null | undefined): boolean =>
  !!err && (err.code === "42703" || /column .*vat_/i.test(String(err.message ?? ""))) && /vat_/i.test(String(err.message ?? ""));

/** Suggested selling price (the agents' default): the price when set, else max(cost × 3, €15). Same rule as GET /products. */
export const suggestedPrice = (priceEur: number, costEur: number): number =>
  priceEur > 0 ? priceEur : Math.max((costEur || 0) * 3, 15);

// ── Stock v2: the recipe status + Sigma cost of each product (owners) ────────
/** approved = moves stock and cost · proposed = waits for an owner · none · exempt = no goods (delivery, ПОЕН …). */
export const RECIPE_STATUSES = ["approved", "proposed", "none", "exempt"] as const;
export type RecipeStatus = typeof RECIPE_STATUSES[number];
export interface RecipeOverview { recipe_status: RecipeStatus; cost_mkd: number | null }

/**
 * stock_v2_product_overview() (20260945000510: [{product_id, recipe_status, cost_mkd}], only products
 * with something) → product id → overview. Anything malformed is skipped; an unknown status is 'none'.
 */
export function recipeOverviewMap(data: unknown): Map<string, RecipeOverview> {
  const out = new Map<string, RecipeOverview>();
  for (const r of Array.isArray(data) ? data : []) {
    if (!isObj(r) || typeof r.product_id !== "string" || !UUID_RE.test(r.product_id)) continue;
    const cost = r.cost_mkd == null || r.cost_mkd === "" ? null : Number(r.cost_mkd);
    out.set(r.product_id.toLowerCase(), {
      recipe_status: oneOf(r.recipe_status, RECIPE_STATUSES) ?? "none",
      cost_mkd: cost !== null && Number.isFinite(cost) ? cost : null,
    });
  }
  return out;
}

/** A product with nothing in the overview: no recipe, no cost. */
export const NO_RECIPE: RecipeOverview = { recipe_status: "none", cost_mkd: null };

export function shapeCatalogueRow(
  p: Record<string, unknown>,
  opts: { showCost: boolean; showVat?: boolean; recipes?: Map<string, RecipeOverview> | null },
): CatalogueRow {
  const price = num(p.price);
  const cost = num(p.cost_price);
  const sup = isObj(p.suppliers) ? p.suppliers : null;
  const row: CatalogueRow = {
    id: String(p.id),
    name: String(p.name ?? ""),
    sku: str(p.sku),
    barcode: str(p.barcode),
    price,
    suggested_price: suggestedPrice(price, cost),
    stock_quantity: num(p.stock_quantity),
    low_stock_threshold: num(p.low_stock_threshold),
    days_of_supply_per_unit: num(p.days_of_supply_per_unit) || 15,
    is_active: p.is_active === true,
    category: humanCategory(p.category),
    description: humanDescription(p.description),
    supplier_id: str(p.supplier_id),
    supplier_name: sup ? str(sup.name) : null,
    brand_line: str(p.brand_line),
    kind: oneOf(p.kind, PRODUCT_KINDS),
    created_at: str(p.created_at),
  };
  if (opts.showCost) row.cost_price = cost;
  // the Sigma cost and the recipe: owners only, and only once the reader answered (else the UI says "—")
  if (opts.showCost && opts.recipes) {
    const o = opts.recipes.get(String(p.id).toLowerCase()) ?? NO_RECIPE;
    row.cost_mkd = o.cost_mkd;
    row.recipe_status = o.recipe_status;
  }
  if (opts.showVat) Object.assign(row, productVatOf(p));
  return row;
}

// ── POST / PATCH /products: the editable fields ──────────────────────────────
/**
 * What a product form may write. Anything else in a PATCH body is dropped (line / kind / VAT have their
 * own audited routes). Stock v2 (docs/STOCK-V2.md, owner 01.10.2026): `stock_quantity` is the stock
 * ledger's mirror (products_stock_mirror_refresh) and `cost_price` the Sigma purchase-cost mirror
 * (product_costs_rebuild) — both behind guard triggers, so neither is a form field any more.
 */
export const EDITABLE_FIELDS = [
  "name", "description", "price", "sku", "barcode", "low_stock_threshold",
  "days_of_supply_per_unit", "is_active", "category", "supplier_id", "photo_url",
] as const;
export type EditableField = typeof EDITABLE_FIELDS[number];

/** The columns a product form may no longer write (derived mirrors since Stock v2). */
export const DERIVED_FIELDS = ["stock_quantity", "cost_price"] as const;

const LIMITS = {
  price: 10_000_000, low_stock_threshold: 100_000, days_of_supply_per_unit: 3650,
};

/**
 * A product row as it goes back to a caller: `cost_price` (money — the Sigma purchase cost in EUR)
 * only for a business owner (is_business_owner(), not a role). Returns a copy.
 */
export function withCostVisibility<T extends Record<string, unknown>>(row: T, owner: boolean): T {
  const out = { ...(row ?? {}) } as Record<string, unknown>;
  if (!owner) delete out.cost_price;
  return out as T;
}

/**
 * A PATCH /products/:id body → the whitelisted, validated update.
 * Returns {ok, update, dropped} or {ok: false, error}. An empty update is valid (nothing to do).
 */
export function parseProductPatch(body: unknown):
  Ok<{ update: Record<string, unknown>; dropped: string[] }> | Err {
  if (!isObj(body)) return { ok: false, error: "body must be an object" };
  const update: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(k)) { dropped.push(k); continue; }
    switch (k as EditableField) {
      case "name": {
        const s = typeof v === "string" ? v.trim() : "";
        if (!s) return { ok: false, error: "Product name is required" };
        if (s.length > 200) return { ok: false, error: "Product name is too long (max 200)" };
        update.name = s;
        break;
      }
      case "description":
      case "category": {
        if (v != null && typeof v !== "string") return { ok: false, error: `${k} must be text` };
        const s = String(v ?? "");
        if (s.length > (k === "description" ? 2000 : 200)) return { ok: false, error: `${k} is too long` };
        update[k] = s;
        break;
      }
      case "sku":
      case "barcode": {
        if (v != null && typeof v !== "string") return { ok: false, error: `${k} must be text` };
        const s = v == null ? "" : String(v).trim();
        if (s.length > 50) return { ok: false, error: `${k} is too long (max 50)` };
        update[k] = s || null;
        break;
      }
      case "photo_url": {
        if (v != null && typeof v !== "string") return { ok: false, error: "photo_url must be text" };
        update.photo_url = v == null || v === "" ? null : String(v);
        break;
      }
      case "supplier_id": {
        if (v == null || v === "") { update.supplier_id = null; break; }
        if (typeof v !== "string" || !UUID_RE.test(v)) return { ok: false, error: "supplier_id must be a uuid" };
        update.supplier_id = v.toLowerCase();
        break;
      }
      case "is_active": {
        if (typeof v !== "boolean") return { ok: false, error: "is_active must be true or false" };
        update.is_active = v;
        break;
      }
      case "price": {
        const n = typeof v === "number" ? v : NaN;
        const max = LIMITS.price;
        if (!Number.isFinite(n) || n < 0 || n > max) return { ok: false, error: `${k} must be a number 0..${max}` };
        update[k] = n;
        break;
      }
      case "low_stock_threshold":
      case "days_of_supply_per_unit": {
        const n = typeof v === "number" ? v : NaN;
        const min = k === "days_of_supply_per_unit" ? 1 : 0;
        const max = LIMITS[k as "low_stock_threshold" | "days_of_supply_per_unit"];
        if (!Number.isInteger(n) || n < min || n > max) return { ok: false, error: `${k} must be a whole number ${min}..${max}` };
        update[k] = n;
        break;
      }
    }
  }
  return { ok: true, update, dropped };
}
