// ============================================================================
// VAT per product, from Sigma (owner decision, Mile, 01.10.2026 — docs/VAT.md;
// migration 20260944000900_product_vat_rate) — the pure half of
//   POST /api/products/vat-rate     public.products_set_vat_rate()  (audited)
//   GET  /api/products, /catalogue  the products.vat_* columns, owners only
// and the per-product VAT of GET /api/management-insights (the legacy blocks).
//
// It replaces the flat 18 % of 28.09.2026: every product carries the rate
// Natura's own books (Sigma Item.VatId) charge for it — food supplements 5 %,
// cosmetics / gels / creams / oils / devices / chia drinks 18 %. A product or a
// line with no rate is taxed at DEFAULT_VAT_RATE (5 %, the core range) and the
// amount is always reported apart as "unclassified" — never silently.
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// vatRates.test.ts against this file in Node, and index.ts imports it.
// ============================================================================

/** The rate of a line with no product rate (the core range: food supplements). */
export const DEFAULT_VAT_RATE = 0.05;
/** The Macedonian rates a product can carry (Sigma Item.VatId 0 / 2 / 3 / 1). */
export const VAT_RATES = [0, 0.05, 0.1, 0.18] as const;
export type VatRate = (typeof VAT_RATES)[number];

/** The share of a gross (VAT-inclusive) amount that is VAT at rate r: r / (1 + r). */
export const vatShare = (r: number): number => r / (1 + r);

/** The columns only products_set_vat_rate() may write (a DB trigger enforces it). */
export const VAT_COLUMNS = [
  "vat_rate", "vat_source", "vat_sigma_code", "vat_sigma_name", "vat_evidence", "vat_set_by", "vat_set_at",
] as const;

/** One call sets at most this many products (the SQL refuses more). */
export const MAX_SET_IDS = 1000;
export const MAX_NOTE = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

/** A rate as one of the four (numeric(4,3) arrives as "0.050"); null for anything else. */
export function asVatRate(v: unknown): VatRate | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const hit = VAT_RATES.find((r) => Math.abs(r - n) < 1e-9);
  return hit === undefined ? null : hit;
}

// ── POST /products/vat-rate ──────────────────────────────────────────────────

export interface SetVatArgs {
  ids: string[];
  /** null = back to unclassified. */
  rate: VatRate | null;
  note: string | null;
}

/**
 * Body `{ids: uuid[], rate: 0 | 0.05 | 0.10 | 0.18 | null, note?: string}`. The ids
 * are lower-cased and de-duplicated (first-seen order); `rate` must be present —
 * null clears on purpose, a missing key is a mistake.
 */
export function parseSetVatBody(body: unknown): Ok<{ args: SetVatArgs }> | Err {
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
  if (!("rate" in body)) return { ok: false, error: "rate is required (null = unclassified)" };
  let rate: VatRate | null = null;
  if (body.rate !== null) {
    if (typeof body.rate !== "number" && typeof body.rate !== "string") return { ok: false, error: "rate must be 0, 0.05, 0.10, 0.18 or null" };
    rate = asVatRate(body.rate);
    if (rate === null) return { ok: false, error: "rate must be 0, 0.05, 0.10, 0.18 or null" };
  }
  let note: string | null = null;
  if (body.note != null) {
    if (typeof body.note !== "string") return { ok: false, error: "note must be text" };
    note = body.note.trim() || null;
    if (note && note.length > MAX_NOTE) return { ok: false, error: `note is too long (max ${MAX_NOTE})` };
  }
  return { ok: true, args: { ids, rate, note } };
}

export function setVatRpcArgs(args: SetVatArgs, actorId: string) {
  return { p_ids: args.ids, p_rate: args.rate, p_actor: actorId, p_note: args.note };
}

export interface SetVatChange {
  id: string;
  name: string;
  from: VatRate | null;
  to: VatRate | null;
  from_source: string | null;
}

export interface SetVatResult {
  rate: VatRate | null;
  requested: number;
  updated: number;
  unchanged: number;
  missing: string[];
  changes: SetVatChange[];
}

export function shapeSetVatResult(data: unknown): SetVatResult {
  const d = isObj(data) ? data : {};
  return {
    rate: asVatRate(d.rate),
    requested: num(d.requested),
    updated: num(d.updated),
    unchanged: num(d.unchanged),
    missing: (Array.isArray(d.missing) ? d.missing : []).map((x) => String(x)),
    changes: (Array.isArray(d.changes) ? d.changes : []).filter(isObj).map((c) => ({
      id: String(c.id ?? ""),
      name: String(c.name ?? ""),
      from: asVatRate(c.from),
      to: asVatRate(c.to),
      from_source: str(c.from_source),
    })),
  };
}

/** A SQL refusal (22023 = bad input) is the caller's 400 with its message; anything else is sanitised by index.ts. */
export function vatRpcError(err: { code?: string; message?: string } | null | undefined): { error: string } | null {
  if (!err) return null;
  if (err.code === "22023") return { error: String(err.message || "invalid input") };
  return null;
}

// ── GET /products, /products/catalogue ───────────────────────────────────────

/** The VAT columns a product row carries for an owner (rate as a number). */
export interface ProductVat {
  vat_rate: VatRate | null;
  vat_source: string | null;
  vat_sigma_code: string | null;
  vat_sigma_name: string | null;
  vat_evidence: string | null;
  vat_set_at: string | null;
}

/** An owner's view of the VAT columns of a products row; `vat_set_by` stays server-side. */
export function productVatOf(p: Record<string, unknown>): ProductVat {
  return {
    vat_rate: asVatRate(p.vat_rate),
    vat_source: str(p.vat_source),
    vat_sigma_code: str(p.vat_sigma_code),
    vat_sigma_name: str(p.vat_sigma_name),
    vat_evidence: str(p.vat_evidence),
    vat_set_at: str(p.vat_set_at),
  };
}

/**
 * The VAT columns on a products row: owners see them shaped (rate as a number),
 * everyone else sees none — the rate is part of the owners' money view (the
 * margins), like the cost price. Mutates and returns `row`.
 */
export function applyVatVisibility<T extends Record<string, unknown>>(row: T, src: Record<string, unknown>, owner: boolean): T {
  for (const k of VAT_COLUMNS) delete (row as Record<string, unknown>)[k];
  if (owner) Object.assign(row, productVatOf(src));
  return row;
}

/** PATCH /products/:id: the VAT columns go only through POST /products/vat-rate (audited). Returns the keys it removed. */
export function stripVatFields(body: unknown): string[] {
  if (!isObj(body)) return [];
  const removed: string[] = [];
  for (const k of VAT_COLUMNS) {
    if (k in body) { delete body[k]; removed.push(k); }
  }
  return removed;
}

// ── GET /management-insights (the legacy blocks): VAT per product name ───────

export interface NamedProduct {
  id?: string | null;
  name: string | null;
  vat_rate?: unknown;
  cost_price?: unknown;
  is_active?: boolean | null;
}

/**
 * The catalogue's rate per product NAME (the legacy blocks key products by
 * name). Where several products share a name: a rated one, then one with a
 * cost, then an active one, then the smaller id — deterministic whatever order
 * the rows came in.
 */
export function vatRateByName(products: readonly NamedProduct[] | null | undefined): Map<string, VatRate> {
  const rank = (p: NamedProduct): [number, number, number, string] => [
    asVatRate(p.vat_rate) === null ? 1 : 0,
    num(p.cost_price) > 0 ? 0 : 1,
    p.is_active ? 0 : 1,
    String(p.id ?? ""),
  ];
  const best = new Map<string, NamedProduct>();
  for (const p of products ?? []) {
    if (!p.name) continue;
    const cur = best.get(p.name);
    if (!cur) { best.set(p.name, p); continue; }
    const a = rank(p), b = rank(cur);
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) { best.set(p.name, p); break; }
      if (a[i] > b[i]) break;
    }
  }
  const out = new Map<string, VatRate>();
  for (const [name, p] of best) {
    const r = asVatRate(p.vat_rate);
    if (r !== null) out.set(name, r);
  }
  return out;
}

export interface NamedVat {
  /** Σ revenue × r/(1+r), r = the product's rate, default where none (same unit as the revenue). */
  vat: number;
  /** vat ÷ total — the gross share to allocate the VAT of a part (a channel) by its cash. */
  share: number;
  by_rate: Record<string, { revenue: number; vat: number }>;
  /** revenue with no rate (no product of that name, no rate on it, or no line at all). */
  unclassified: { revenue: number; vat: number };
}

/**
 * The VAT of a total split over named products: each name at its product's rate,
 * the names without a rate and the part of the total no line explains (orders
 * without lines) at the default — and both reported as unclassified.
 */
export function vatOfNamedRevenue(
  rows: readonly { name: string; revenue: number }[],
  rates: ReadonlyMap<string, VatRate>,
  total: number,
  defaultRate: number = DEFAULT_VAT_RATE,
): NamedVat {
  const by: Record<string, { revenue: number; vat: number }> = {};
  let vat = 0;
  let explained = 0;
  let uRev = 0;
  const add = (rate: number, revenue: number) => {
    const k = String(rate);
    const v = revenue * vatShare(rate);
    (by[k] ??= { revenue: 0, vat: 0 }).revenue += revenue;
    by[k].vat += v;
    vat += v;
  };
  for (const r of rows) {
    const revenue = num(r.revenue);
    explained += revenue;
    const rate = rates.get(r.name);
    if (rate === undefined) { uRev += revenue; add(defaultRate, revenue); } else add(rate, revenue);
  }
  const rest = num(total) - explained;
  if (Math.abs(rest) > 1e-9) { uRev += rest; add(defaultRate, rest); }
  return {
    vat,
    share: num(total) !== 0 ? vat / num(total) : vatShare(defaultRate),
    by_rate: by,
    unclassified: { revenue: uRev, vat: uRev * vatShare(defaultRate) },
  };
}
