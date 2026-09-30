// ============================================================================
// Product brand lines (plan 30.09.2026, "Фаза 4 — Мапа на производите по линија")
// — the pure half of
//   GET  /api/products/brand-line-proposal   public.product_brand_line_proposal()  (…001300)
//   POST /api/products/brand-line            public.products_set_brand_line()      (…001300)
// and of the brand-line guard on PATCH /api/products/:id.
//
// Owner ruling 30.09.2026: when the CRM ships an order via MEX the product line
// decides the MEX profile — Bio Natural and Dr.Becker ship with BIO NATURAL,
// Natura Therapy and Ad Astra with NATURA (mexProfileForLine, the twin of the
// SQL mex_profile_for_line()).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// brandLine.test.ts against this file in Node, and index.ts imports it.
//
// The SQL decides everything (the parcel counts, the suggestion, the audit row).
// This file only validates the query string and the POST body before an RPC
// runs, and shapes each RPC payload into the exact response contract the
// /products page codes against — a whitelist of keys with numbers coerced, so a
// key added to an RPC later never leaks into a response by accident.
// ============================================================================

/** The four brand lines, in the owner's order. NULL on a product = not yet decided. */
export const BRAND_LINES = ["natura_therapy", "bio_natural", "ad_astra", "dr_becker"] as const;
export type BrandLine = typeof BRAND_LINES[number];

/** The two MEX accounts (orders.mex_account). */
export const MEX_PROFILES = ["bio_natural", "natura"] as const;
export type MexProfile = typeof MEX_PROFILES[number];

/** The columns only products_set_brand_line() may write (a DB trigger enforces it). */
export const BRAND_LINE_COLUMNS = ["brand_line", "brand_line_set_by", "brand_line_set_at"] as const;

/** One call sets at most this many products (the SQL refuses more). */
export const MAX_SET_IDS = 1000;
export const DEFAULT_PROPOSAL_DAYS = 180;
export const MAX_PROPOSAL_DAYS = 3650;

export const PROPOSAL_BUCKETS = ["sure", "mixed", "none"] as const;
export type ProposalBucket = typeof PROPOSAL_BUCKETS[number];
export const PROPOSAL_CONFIDENCES = ["hint", "conflict", "anchor", "high", "low", "none"] as const;
export type ProposalConfidence = typeof PROPOSAL_CONFIDENCES[number];
export const PROPOSAL_REASONS = [
  "hint_name", "anchor_conflict", "anchor_name", "parcels_sure", "parcels_mixed", "parcels_tie", "no_parcels",
] as const;
export type ProposalReason = typeof PROPOSAL_REASONS[number];

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

export const isBrandLine = (v: unknown): v is BrandLine => oneOf(v, BRAND_LINES) !== null;

/** The MEX account a line ships with (owner 30.09): the twin of SQL mex_profile_for_line(). */
export function mexProfileForLine(line: unknown): MexProfile | null {
  switch (line) {
    case "bio_natural":
    case "dr_becker":
      return "bio_natural";
    case "natura_therapy":
    case "ad_astra":
      return "natura";
    default:
      return null;
  }
}

// ── GET /products/brand-line-proposal ────────────────────────────────────────

/** `?days=` → the parcel window; missing / empty = 180. */
export function parseProposalDays(raw: string | null | undefined): Ok<{ days: number }> | Err {
  if (raw == null || String(raw).trim() === "") return { ok: true, days: DEFAULT_PROPOSAL_DAYS };
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return { ok: false, error: "days must be a whole number" };
  const days = Number(s);
  if (days < 1 || days > MAX_PROPOSAL_DAYS) return { ok: false, error: `days must be 1..${MAX_PROPOSAL_DAYS}` };
  return { ok: true, days };
}

export interface ProposalRow {
  id: string;
  name: string;
  sku: string | null;
  is_active: boolean;
  brand_line: BrandLine | null;
  brand_line_set_at: string | null;
  brand_line_set_by_name: string | null;
  bio_natural: number;
  natura: number;
  parcels: number;
  majority: MexProfile | null;
  /** The majority account's share of the parcels, 0..1; null without parcels. */
  share: number | null;
  bucket: ProposalBucket;
  /** The Bio Natural anchor word the name matched (squashed, e.g. "neurofix"). */
  anchor: string | null;
  hint: "ad_astra" | "dr_becker" | null;
  suggested: BrandLine | null;
  suggested_profile: MexProfile | null;
  confidence: ProposalConfidence;
  conflict: boolean;
  reason: ProposalReason;
  /** "Accept all ≥ 90 %" / apply-brand-lines may set it: undecided, anchor or high. */
  auto: boolean;
}

export interface ProposalSummary {
  products: number;
  sure: number;
  mixed: number;
  none: number;
  anchors: number;
  conflicts: number;
  hints: { ad_astra: number; dr_becker: number };
  decided: number;
  auto: number;
  few_parcels_auto: number;
}

export interface ProposalResponse {
  days: number;
  generated_at: string | null;
  summary: ProposalSummary;
  rows: ProposalRow[];
}

export function shapeProposalRow(r: unknown): ProposalRow | null {
  if (!isObj(r) || !str(r.id)) return null;
  const bucket = oneOf(r.bucket, PROPOSAL_BUCKETS) ?? "none";
  return {
    id: String(r.id),
    name: String(r.name ?? ""),
    sku: str(r.sku),
    is_active: r.is_active === true,
    brand_line: oneOf(r.brand_line, BRAND_LINES),
    brand_line_set_at: str(r.brand_line_set_at),
    brand_line_set_by_name: str(r.brand_line_set_by_name),
    bio_natural: num(r.bio_natural),
    natura: num(r.natura),
    parcels: num(r.parcels),
    majority: oneOf(r.majority, MEX_PROFILES),
    share: numOrNull(r.share),
    bucket,
    anchor: str(r.anchor),
    hint: oneOf(r.hint, ["ad_astra", "dr_becker"] as const),
    suggested: oneOf(r.suggested, BRAND_LINES),
    suggested_profile: oneOf(r.suggested_profile, MEX_PROFILES),
    confidence: oneOf(r.confidence, PROPOSAL_CONFIDENCES) ?? "none",
    conflict: r.conflict === true,
    reason: oneOf(r.reason, PROPOSAL_REASONS) ?? "no_parcels",
    auto: r.auto === true,
  };
}

export function shapeProposal(data: unknown): ProposalResponse {
  const d = isObj(data) ? data : {};
  const s = isObj(d.summary) ? d.summary : {};
  const h = isObj(s.hints) ? s.hints : {};
  const rows = (Array.isArray(d.rows) ? d.rows : [])
    .map(shapeProposalRow)
    .filter((r): r is ProposalRow => r !== null);
  return {
    days: num(d.days) || DEFAULT_PROPOSAL_DAYS,
    generated_at: str(d.generated_at),
    summary: {
      products: num(s.products),
      sure: num(s.sure),
      mixed: num(s.mixed),
      none: num(s.none),
      anchors: num(s.anchors),
      conflicts: num(s.conflicts),
      hints: { ad_astra: num(h.ad_astra), dr_becker: num(h.dr_becker) },
      decided: num(s.decided),
      auto: num(s.auto),
      few_parcels_auto: num(s.few_parcels_auto),
    },
    rows,
  };
}

// ── POST /products/brand-line ────────────────────────────────────────────────

export interface SetBrandLineArgs {
  ids: string[];
  /** null = back to "not yet decided". */
  line: BrandLine | null;
}

/**
 * Body `{ids: uuid[], line: BrandLine | null}`. The ids are lower-cased and
 * de-duplicated (first-seen order); `line` must be present — null clears on
 * purpose, a missing key is a mistake.
 */
export function parseSetBrandLineBody(body: unknown): Ok<{ args: SetBrandLineArgs }> | Err {
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
  if (!("line" in body)) return { ok: false, error: "line is required (null = not yet decided)" };
  if (body.line !== null && !isBrandLine(body.line)) {
    return { ok: false, error: `line must be one of ${BRAND_LINES.join(", ")} or null` };
  }
  return { ok: true, args: { ids, line: body.line as BrandLine | null } };
}

export function setBrandLineRpcArgs(args: SetBrandLineArgs, actorId: string) {
  return { p_ids: args.ids, p_line: args.line, p_actor: actorId };
}

export interface SetBrandLineChange {
  id: string;
  name: string;
  from: BrandLine | null;
  to: BrandLine | null;
}

export interface SetBrandLineResult {
  line: BrandLine | null;
  mex_profile: MexProfile | null;
  requested: number;
  updated: number;
  unchanged: number;
  missing: string[];
  changes: SetBrandLineChange[];
}

export function shapeSetResult(data: unknown): SetBrandLineResult {
  const d = isObj(data) ? data : {};
  return {
    line: oneOf(d.line, BRAND_LINES),
    mex_profile: oneOf(d.mex_profile, MEX_PROFILES),
    requested: num(d.requested),
    updated: num(d.updated),
    unchanged: num(d.unchanged),
    missing: (Array.isArray(d.missing) ? d.missing : []).map((x) => String(x)),
    changes: (Array.isArray(d.changes) ? d.changes : []).filter(isObj).map((c) => ({
      id: String(c.id ?? ""),
      name: String(c.name ?? ""),
      from: oneOf(c.from, BRAND_LINES),
      to: oneOf(c.to, BRAND_LINES),
    })),
  };
}

/** A SQL refusal (22023 = bad input) is the caller's 400 with its message; anything else is sanitised by index.ts. */
export function brandLineRpcError(err: { code?: string; message?: string } | null | undefined): { error: string } | null {
  if (!err) return null;
  if (err.code === "22023") return { error: String(err.message || "invalid input") };
  return null;
}

// ── PATCH /products/:id ──────────────────────────────────────────────────────

/**
 * The line is set only through POST /products/brand-line (audited). A PATCH
 * body carrying the line columns — e.g. a whole product row sent back — has
 * them dropped here instead of failing on the DB guard. Returns the keys it
 * removed (mutates `body`).
 */
export function stripBrandLineFields(body: unknown): string[] {
  if (!isObj(body)) return [];
  const removed: string[] = [];
  for (const k of BRAND_LINE_COLUMNS) {
    if (k in body) { delete body[k]; removed.push(k); }
  }
  return removed;
}
