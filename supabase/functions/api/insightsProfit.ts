// ============================================================================
// Insights → Pure Profit (Чиста добивка) + Margins (Маржи) — the pure half of
// GET /api/insights/profit (migration 20260941000300_insights_profit).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// insightsProfit.test.ts against this file in Node, and index.ts imports it.
//
// The SQL returns the P&L INPUTS of one clock at a time — sales, their value,
// lines split by price weight, known product cost, parcels, today's
// per-package bonus raw per owner. This file does the P&L:
//
//   revenue     cohort: what MEX collected on the period's sales (paid +
//               paid by ruling / legacy import); cash: MEX COD delivered in
//               the period + the card money of card-paid web orders
//   − VAT       PER LINE (owner, 01.10.2026; migration 20260944000900):
//               Σ line value × r / (1 + r) — prices are gross; r = the
//               line's product rate from Sigma (products.vat_rate: 5 % food
//               supplements, 18 % cosmetics / devices). A line with no
//               product or no rate is taxed at DEFAULT_VAT_RATE (5 %) and
//               shown apart as "unclassified". Replaces the flat 18 % of
//               28.09 (docs/VAT.md)
//   − COGS      known: the unit cost × packages (never invented) — Sigma
//               CalcBuyPrice through each product's approved recipe at the
//               sale day (owner 01.10.2026, migration 20260945000800, payload
//               cost_mode 'sigma'), or the old catalogue cost_price (EUR ×
//               61,5, cost_mode 'legacy' — the contract's default switch);
//               estimated: the uncosted revenue × the cost share of the
//               costed packages of the same view — LABELLED, never silent
//   − extra     Phase B (stock_v2.profit.extra_goods, Sigma only): gifts and
//               other goods PACKED in the parcel beyond the order lines (the
//               collabBox goods lines' cost − the lines' cost; a MEX-only
//               parcel with known contents = its packed goods) — cogs_extra
//   − courier   MEX rate card (courier_rates 'mex': 2,439 € = 150 ден per
//               delivered parcel) × the parcels delivered
//   − returns   the rate card's return fee (MEX: 0) × the parcels returned
//   − lead cost the slot stays wired at 0 — "not configured" (no rates yet)
//   − commission today's rule, UNCHANGED: index.ts orderPackageBonus() on
//               every order whose status is paid, only when its owner
//               (confirmed_by_name ?? assigned_agent_name, normAgent) is an
//               agent that is not an admin / manager — the same gate as
//               /management-insights' agent_commissions
//   = net profit, margin % of revenue
//
// Every money figure leaves as whole денари (`*_mkd`); nothing here is ×61,5
// again except the EUR the SQL names `_eur` (cost price, bonus, the rate
// card), at the FROZEN peg.
// ============================================================================

import type { InsightsWindow } from "./insightsCommon.ts";
import { addDaysYmd, skopjeDayEndIso, skopjeMidnightIso, skopjeTodayYmd } from "./overview.ts";
import { DEFAULT_VAT_RATE, VAT_RATES, vatShare } from "./vatRates.ts";
import { isValidYmd, skopjeYmd } from "./skopjeTime.ts";

/** VAT is per product from Sigma (owner decision 01.10.2026, docs/VAT.md; it
 *  replaces the flat 18 % of 28.09). A line whose product has no rate yet — a
 *  MEX-only parcel, a sale without lines, an unmatched name, a new product — is
 *  taxed at DEFAULT_VAT_RATE, the rate of the core range (food supplements), and
 *  reported apart (vatRates.ts). */
export { DEFAULT_VAT_RATE, VAT_RATES, vatShare };
/** per_product_sigma = the body computes VAT per line (20260944000900);
 *  flat_default = an older body answered: every line at the default rate. */
export type VatMode = "per_product_sigma" | "flat_default";

/** The FROZEN peg (src/lib/currency.ts MKD_PER_EUR) — only to express a EUR
 *  amount (cost price, bonus, rate card) in денари, never to re-price. */
export const MKD_PER_EUR = 61.5;

/** The departments in the owner's display order (28.09.2026 — migrations
 *  20260942000500 and 20260942001000, each bumping insights_profit_cache_version so no
 *  cached month built with fewer sources is merged: 3 → 4 for the six). Менаџмент is the
 *  7th (owner 02.10.2026, 20260947001000): its row is 0 until the SQL sends it. */
export const PROFIT_SOURCES = ["altercpa", "elyon_crm", "teleshop_out", "teleshop_other", "social", "web", "management"] as const;
export type ProfitSource = (typeof PROFIT_SOURCES)[number];

/** The previous-period comparison runs only up to this many days: it is a
 *  second full scan, and a year against a year would double the heaviest
 *  request of the page. */
export const PROFIT_PREV_MAX_DAYS = 93;

/** Product rows sent (by revenue); the rest fold into one "others" row. */
export const PROFIT_PRODUCTS_MAX = 400;

// ── the RPC payload (insights_profit) ───────────────────────────────────────

export interface AggRow {
  g: "collected" | "returned" | "open" | "unproven" | string;
  dim: "s" | "d" | "w" | string;
  key: string;
  n: number; rev: number; card: number; pw: number;
  rc: number; ru: number; rn: number; cm: number;
  pc: number; pu: number; fr: number; lb: number;
  /** VAT per line (20260944000900): vt = Σ line value × r/(1+r); vc = the same
   *  over the costed packages; vu = the value of lines with no rate (taxed at the
   *  default, inside v05); v00 / v05 / v10 / v18 = the value by rate. Absent on
   *  an older body. */
  vt?: number; vc?: number; vu?: number; v00?: number; v05?: number; v10?: number; v18?: number;
  /** Phase B (20260945000800, 0 when off): cx = the extra packed goods (signed), cxm = its
   *  MEX-only part, cxn = its negative part, xr = MEX-only revenue now costed, xn = sales
   *  compared. Absent on an older body. */
  cx?: number; cxm?: number; cxn?: number; xr?: number; xn?: number;
}
export interface CommRow { dim: "s" | "d" | "w" | string; key: string; o: string | null; b: number; n: number }
export interface ProductRpcRow {
  s: string; g: string; k: string; name: string | null; kind: string | null; reviewed: boolean | null;
  pkg: boolean | null; cost_eur: number | null; n: number; qty?: number; pkgs: number; fr: number;
  rev: number; cm: number; sh: number; lb: number;
  /** The product's VAT (Σ per line), its rate, and whether that rate is the
   *  default (no product / no rate). Absent on an older body. */
  vt?: number; vr?: number | null; vd?: boolean | null;
  /** 20260945000800: the highest unit cost in денари, the costed packages and revenue (a
   *  recipe may start inside the window) and the product's share of Phase B. Absent on an
   *  older body (then cost_eur alone decides). */
  cost_mkd?: number | null; pc?: number; rc?: number; cx?: number; xr?: number;
}
export interface HistRow { s: string; u: number; q: number; v: number }
/** One (source, bucket) cell of insights_profit's cohort strip. `nb` = collabBox bookings awaiting
 *  their parcel (20260942001900); an older body without it counts none. */
export interface StripRow { s: string; b: string; n: number; v: number; c: number; no: number; nw: number; nm: number; nb?: number }
export interface ProfitRpc {
  clock?: "cohort" | "cash";
  granularity?: "day" | "month";
  /** "per_line" = VAT is computed per line (20260944000900); absent = an older body. */
  vat_mode?: "per_line";
  /** The unit cost's source (20260945000800): sigma = product_cost_history (Sigma
   *  CalcBuyPrice through the recipes); legacy = the catalogue cost_price. Absent = an
   *  older body (legacy). */
  cost_mode?: "legacy" | "sigma" | "mixed";
  /** Phase B ran (extra packed goods, Sigma only). */
  extra_goods?: boolean;
  agg?: AggRow[];
  comm?: CommRow[];
  wm_names?: Record<string, string> | null;
  strip?: StripRow[];
  products?: ProductRpcRow[] | null;
  hist?: HistRow[] | null;
  no_items?: { n: number; v: number } | null;
  returned_parcels?: { s: string; d: string; n: number }[];
}

// ── today's commission gate (twins of the /management-insights handler) ─────

/** index.ts normAgent (management-insights), verbatim: trim, collapse
 *  whitespace, drop a trailing single-letter initial; blank → "Unknown operator". */
export function normAgent(raw: unknown): string {
  let n = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!n) return "Unknown operator";
  n = n.replace(/\s+\p{L}\.?$/u, "").trim();
  return n || "Unknown operator";
}

/** Who earns the per-package bonus today: an agent-role user who is NOT an
 *  admin / manager (a super-admin earns nothing even with an agent role),
 *  by normAgent(full name) — exactly the /management-insights agentNames set. */
export function commissionAgentNames(
  profiles: readonly { user_id: string; full_name: string | null }[] | null | undefined,
  roles: readonly { user_id: string; role: string }[] | null | undefined,
): Set<string> {
  const agentIds = new Set<string>();
  const superIds = new Set<string>();
  for (const r of roles ?? []) {
    if (r.role === "admin" || r.role === "manager") superIds.add(r.user_id);
    else if (r.role === "agent" || r.role === "pending_agent" || r.role === "prediction_agent") agentIds.add(r.user_id);
  }
  const names = new Set<string>();
  for (const p of profiles ?? []) {
    if (agentIds.has(p.user_id) && !superIds.has(p.user_id)) names.add(normAgent(p.full_name));
  }
  return names;
}

// ── settings the api hands in ───────────────────────────────────────────────

export interface ProfitSettings {
  /** The rate of a line with no product rate (DEFAULT_VAT_RATE, 5 %) — and of
   *  every line when an older insights_profit() body answers (flat_default). */
  defaultVatRate: number;
  /** courier_rates 'mex' (EUR): deliver per parcel, return per returned parcel. */
  deliverEur: number;
  returnEur: number;
  /** Where the rate came from: the 'mex' row, or the api's fallback. */
  rateSource: "courier_rates" | "fallback";
  agentNames: ReadonlySet<string>;
  /** The Sigma snapshot day of the loaded costs (sigmaCostAsOf) — meta.cost.as_of; absent → SIGMA_COST_AS_OF. */
  costAsOf?: string | null;
}

/** The MEX row of the rate card (loadCourierRates' map), per parcel in EUR. */
export function mexRate(
  rates: Record<string, { deliver: number; return_: number }> | null | undefined,
  fallback: { deliver: number; return_: number },
): { deliverEur: number; returnEur: number; rateSource: "courier_rates" | "fallback" } {
  const r = rates?.["mex_door"] ?? rates?.["mex_office"];
  if (r) return { deliverEur: Number(r.deliver) || 0, returnEur: Number(r.return_) || 0, rateSource: "courier_rates" };
  return { deliverEur: Number(fallback.deliver) || 0, returnEur: Number(fallback.return_) || 0, rateSource: "fallback" };
}

// ── the P&L ─────────────────────────────────────────────────────────────────

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
// whole denars, snapped to 0,0001 first: a sum of monthly pieces and one live sum
// differ in the last float bits, and a share of 150 ден often lands on exactly ,5
const r0 = (v: number) => Math.round(Math.round(v * 1e4) / 1e4);
const share = (a: number, b: number): number | null => (b > 0 ? a / b : null);

interface Measures {
  n: number; rev: number; card: number; pw: number; rc: number; ru: number; rn: number; cm: number;
  pc: number; pu: number; fr: number; lb: number;
  vt: number; vc: number; vu: number; v00: number; v05: number; v10: number; v18: number;
  cx: number; cxm: number; cxn: number; xr: number; xn: number;
}
const ZERO: Measures = {
  n: 0, rev: 0, card: 0, pw: 0, rc: 0, ru: 0, rn: 0, cm: 0, pc: 0, pu: 0, fr: 0, lb: 0,
  vt: 0, vc: 0, vu: 0, v00: 0, v05: 0, v10: 0, v18: 0,
  cx: 0, cxm: 0, cxn: 0, xr: 0, xn: 0,
};
const MKEYS = Object.keys(ZERO) as (keyof Measures)[];

/** Did this payload come from a body that computes VAT per line? (an empty
 *  window of a new body says so too — the marker, not the rows, decides) */
export const vatPerLine = (rpc: Pick<ProfitRpc, "vat_mode"> | null | undefined): boolean => rpc?.vat_mode === "per_line";

/** The value by rate of a measure, as {rate, value} (zero rates dropped). */
const RATE_KEYS: [number, keyof Measures][] = [[0, "v00"], [0.05, "v05"], [0.1, "v10"], [0.18, "v18"]];

function addM(a: Measures, b: Partial<Measures> | AggRow): Measures {
  const o = { ...a };
  for (const k of MKEYS) o[k] += num((b as Record<string, unknown>)[k]);
  return o;
}

/** Σ of the agg rows of one group × dim (× key when given). */
function measure(agg: AggRow[] | undefined, g: string, dim: string, key?: string): Measures {
  let m = { ...ZERO };
  for (const a of agg ?? []) if (a.g === g && a.dim === dim && (key === undefined || a.key === key)) m = addM(m, a);
  return m;
}

/** Today's commission: Σ bonus (EUR) of the rows whose owner is an agent. */
export function gatedBonusEur(comm: CommRow[] | undefined, dim: string, key: string | null, agents: ReadonlySet<string>): number {
  let b = 0;
  for (const c of comm ?? []) {
    if (c.dim !== dim || (key !== null && c.key !== key)) continue;
    if (agents.has(normAgent(c.o))) b += num(c.b);
  }
  return b;
}

/** One rate's part of the VAT line: the gross value taxed at it and its VAT. */
export interface VatPart { rate: number; revenue_mkd: number; vat_mkd: number }

export interface PLRow {
  key: string;
  sales: number;
  revenue_mkd: number;
  card_mkd: number;
  /** Σ per line, each line at its product's Sigma rate (flat default on an older body). */
  vat_mkd: number;
  /** The VAT of the costed packages alone (the waterfall's "costed" basis). */
  vat_costed_mkd: number;
  /** The VAT line by rate (5 % / 18 % …), Σ = vat_mkd up to rounding. */
  vat_split: VatPart[];
  /** The value whose rate is unknown (no product, no rate yet), taxed at the default — shown apart. */
  vat_unclassified: { revenue_mkd: number; vat_mkd: number };
  cogs_known_mkd: number;
  /** null when nothing in the view has a cost to estimate from. */
  cogs_est_mkd: number | null;
  /** Phase B — "Подароци и дополнително спакувано": what the parcels held beyond their order
   *  lines (signed; 0 when Phase B is off or on an older body). Part of the costed basis. */
  cogs_extra_mkd: number;
  /** Its parts: MEX-only parcels whose packed contents are known (and their revenue, now
   *  costed), the negative part (a recipe that costs more than what was packed), sales compared. */
  cogs_extra_detail: { mex_only_mkd: number; mex_only_revenue_mkd: number; negative_mkd: number; sales: number };
  courier_mkd: number;
  returns_mkd: number;
  commission_mkd: number;
  lead_cost_mkd: number;
  net_mkd: number;
  /** The same with every uncosted package at 0 — an upper bound, never the headline. */
  net_upper_mkd: number;
  margin: number | null;
  /** The P&L of the costed packages alone (their revenue, their known cost;
   *  courier / returns / commission allocated by revenue share). */
  costed: { revenue_mkd: number; net_mkd: number; margin: number | null };
  revenue_costed_mkd: number;
  revenue_uncosted_mkd: number;
  revenue_other_mkd: number;
  packages: number;
  free_packages: number;
  packages_costed: number;
  packages_uncosted: number;
  coverage_packages: number | null;
  coverage_revenue: number | null;
  parcels_delivered: number;
  parcels_returned: number;
  /** Returned sales (cohort) / parcels MEX returned (cash); null when unknown. */
  returned: number | null;
  returned_mkd: number | null;
  return_rate: number | null;
  aov_mkd: number | null;
  cost_per_sale_mkd: number | null;
  profit_per_sale_mkd: number | null;
  packages_per_sale: number | null;
}

interface PLInputs {
  key: string;
  m: Measures;
  /** The measures carry VAT per line (vatPerLine of the payload); false = an older body. */
  perLine: boolean;
  commissionEur: number;
  returnedParcels: number;
  /** null = not known on this clock (a webmaster's returns by MEX return day). */
  returnedSales: number | null;
  returnedValue: number | null;
  costRatio: number | null;
}

/**
 * The VAT of a measure: per line when the body computes it (Σ value × r/(1+r),
 * r = the line's product rate), else every value at the default rate — and
 * then all of it is "unclassified", which is what it is.
 */
export function vatOf(m: Measures, perLine: boolean, defaultRate: number): {
  vat: number; costed: number; split: VatPart[]; unclassified: { revenue: number; vat: number };
} {
  if (!perLine) {
    return {
      vat: m.rev * vatShare(defaultRate),
      costed: m.rc * vatShare(defaultRate),
      split: m.rev !== 0 ? [{ rate: defaultRate, revenue_mkd: r0(m.rev), vat_mkd: r0(m.rev * vatShare(defaultRate)) }] : [],
      unclassified: { revenue: m.rev, vat: m.rev * vatShare(defaultRate) },
    };
  }
  const split: VatPart[] = [];
  for (const [rate, k] of RATE_KEYS) {
    if (m[k] !== 0) split.push({ rate, revenue_mkd: r0(m[k]), vat_mkd: r0(m[k] * vatShare(rate)) });
  }
  // an unclassified line is taxed at the default the SQL uses (5 %)
  return { vat: m.vt, costed: m.vc, split, unclassified: { revenue: m.vu, vat: m.vu * vatShare(DEFAULT_VAT_RATE) } };
}

export function plRow(x: PLInputs, s: ProfitSettings): PLRow {
  const { m } = x;
  const rev = m.rev;
  const v = vatOf(m, x.perLine, s.defaultVatRate);
  const vat = v.vat;
  const deliverMkd = r0(s.deliverEur * MKD_PER_EUR);
  const returnMkd = r0(s.returnEur * MKD_PER_EUR);
  const courier = m.pw * deliverMkd;
  const returns = x.returnedParcels * returnMkd;
  const commission = x.commissionEur * MKD_PER_EUR;
  const lead = 0;
  const cogsEst = x.costRatio == null ? null : m.ru * x.costRatio;
  // Phase B: the extra packed goods belong to fully costed sales (the SQL compares only those)
  const extra = num(m.cx);   // absent on a caller older than 20260945000800 = 0
  const net = rev - vat - m.cm - extra - (cogsEst ?? 0) - courier - returns - commission - lead;
  const netUpper = net + (cogsEst ?? 0);
  const sigma = rev > 0 ? m.rc / rev : 0;
  const costedNet = m.rc - v.costed - m.cm - extra - sigma * (courier + returns + commission + lead);
  const decided = m.n + (x.returnedSales ?? 0);
  return {
    key: x.key,
    sales: m.n,
    revenue_mkd: r0(rev),
    card_mkd: r0(m.card),
    vat_mkd: r0(vat),
    vat_costed_mkd: r0(v.costed),
    vat_split: v.split,
    vat_unclassified: { revenue_mkd: r0(v.unclassified.revenue), vat_mkd: r0(v.unclassified.vat) },
    cogs_known_mkd: r0(m.cm),
    cogs_est_mkd: cogsEst == null ? null : r0(cogsEst),
    cogs_extra_mkd: r0(extra),
    cogs_extra_detail: { mex_only_mkd: r0(num(m.cxm)), mex_only_revenue_mkd: r0(num(m.xr)), negative_mkd: r0(num(m.cxn)), sales: Math.round(num(m.xn)) },
    courier_mkd: r0(courier),
    returns_mkd: r0(returns),
    commission_mkd: r0(commission),
    lead_cost_mkd: lead,
    net_mkd: r0(net),
    net_upper_mkd: r0(netUpper),
    margin: share(net, rev),
    costed: { revenue_mkd: r0(m.rc), net_mkd: r0(costedNet), margin: share(costedNet, m.rc) },
    revenue_costed_mkd: r0(m.rc),
    revenue_uncosted_mkd: r0(m.ru),
    revenue_other_mkd: r0(m.rn),
    packages: m.pc + m.pu,
    free_packages: m.fr,
    packages_costed: m.pc,
    packages_uncosted: m.pu,
    coverage_packages: share(m.pc, m.pc + m.pu),
    coverage_revenue: share(m.rc, m.rc + m.ru),
    parcels_delivered: Math.round(m.pw * 100) / 100,
    parcels_returned: Math.round(x.returnedParcels * 100) / 100,
    returned: x.returnedSales,
    returned_mkd: x.returnedValue == null ? null : r0(x.returnedValue),
    return_rate: x.returnedSales == null ? null : share(x.returnedSales, decided),
    aov_mkd: m.n > 0 ? r0(rev / m.n) : null,
    cost_per_sale_mkd: m.n > 0 ? r0((rev - net) / m.n) : null,
    profit_per_sale_mkd: m.n > 0 ? r0(net / m.n) : null,
    packages_per_sale: m.n > 0 ? Math.round(((m.pc + m.pu) / m.n) * 100) / 100 : null,
  };
}

/** The cost share of the costed packages (known COGS + Phase B's extra packed
 *  goods ÷ their revenue) of one clock's collected sales, all sources — what an
 *  uncosted package is estimated at. null when nothing is costed. (Phase B off:
 *  cx = 0, the ratio of 20260941000300.) */
export function costRatioOf(agg: AggRow[] | undefined): number | null {
  const m = measure(agg, "collected", "s");
  return m.rc > 0 ? (m.cm + num(m.cx)) / m.rc : null;
}

// ── products ────────────────────────────────────────────────────────────────

export interface ProductRow {
  key: string;
  name: string | null;
  /** product | gift | loyalty_point | delivery | note | flyer | unknown */
  kind: string;
  /** false = the kind comes from the name heuristic, not a reviewed alias. */
  reviewed: boolean;
  /** A real package (product / gift); false for points, delivery, notes, MEX-only. */
  package: boolean;
  sources: string[];
  sales: number;
  packages: number;
  free_packages: number;
  revenue_mkd: number;
  /** Every package of the product is costed (Sigma: an approved recipe with every article
   *  costed, on every sale day of the window). */
  cost_known: boolean;
  /** Some packages are costed and some not (a recipe or a cost that starts inside the window). */
  cost_partial: boolean;
  /** The average unit cost of the costed packages (денари) — null when none is costed. */
  unit_cost_mkd: number | null;
  packages_costed: number;
  cogs_mkd: number;
  cogs_est_mkd: number | null;
  /** The product's share of Phase B's extra packed goods (gifts …), by its share of each sale. */
  cogs_extra_mkd: number;
  /** The product's VAT, Σ per line at its Sigma rate. */
  vat_mkd: number;
  /** The rate used: the product's own, else the default (vat_classified false); null = a
   *  folded "others" row of mixed rates. */
  vat_rate: number | null;
  /** false = no product or no rate on file (MEX-only, no lines, an unmatched name, a new
   *  product): taxed at the default rate and listed as unclassified. */
  vat_classified: boolean;
  courier_mkd: number;
  commission_mkd: number;
  /** Commissionable share of this product's packages (today's gate), 0..1. */
  commission_share: number | null;
  net_mkd: number;
  margin: number | null;
  returned_packages: number;
  returned_mkd: number;
  return_rate: number | null;
}

/** The product P&L on the cohort clock, folded across sources by product key.
 *  Commission is today's total per source, spread over that source's
 *  products by their package tiers (Σ products = the P&L line). */
export function productRows(
  rpc: ProfitRpc,
  s: ProfitSettings,
  costRatio: number | null,
): { rows: ProductRow[]; others: ProductRow | null; total: number } {
  const agg = rpc.agg ?? [];
  // gate ratio per source: gated ÷ ungated bonus of its collected sales
  const ratio: Record<string, number> = {};
  for (const src of PROFIT_SOURCES) {
    const ungated = measure(agg, "collected", "s", src).lb;
    const gated = gatedBonusEur(rpc.comm, "s", src, s.agentNames);
    ratio[src] = ungated > 0 ? gated / ungated : 0;
  }
  const deliverMkd = r0(s.deliverEur * MKD_PER_EUR);
  const returnMkd = r0(s.returnEur * MKD_PER_EUR);
  const perLine = vatPerLine(rpc);
  // 20260945000800 sends the costed packages / revenue per product (a recipe may start inside
  // the window); an older body sends only cost_eur, which then decides for the whole product
  const perLineCost = (rpc.products ?? []).some((p) => p.pc !== undefined);
  type Acc = {
    key: string; name: string | null; kind: string; reviewed: boolean; pkg: boolean; sources: Set<string>;
    cost_eur: number | null; n: number; pkgs: number; fr: number; rev: number; cm: number; sh: number;
    lbUngated: number; commEur: number; rPkgs: number; rRev: number; rSh: number;
    vt: number; vr: number | null; vd: boolean;
    pc: number; rc: number; cx: number; xr: number;
  };
  const by = new Map<string, Acc>();
  for (const p of rpc.products ?? []) {
    const a = by.get(p.k) ?? {
      key: p.k, name: p.name ?? null, kind: p.kind ?? "product", reviewed: !!p.reviewed, pkg: !!p.pkg,
      sources: new Set<string>(), cost_eur: null, n: 0, pkgs: 0, fr: 0, rev: 0, cm: 0, sh: 0,
      lbUngated: 0, commEur: 0, rPkgs: 0, rRev: 0, rSh: 0, vt: 0, vr: null, vd: false,
      pc: 0, rc: 0, cx: 0, xr: 0,
    };
    if (p.name && (!a.name || p.name < a.name)) a.name = p.name;
    if (p.kind && p.kind < a.kind) a.kind = p.kind;
    if (p.cost_eur != null && num(p.cost_eur) > 0) a.cost_eur = Math.max(a.cost_eur ?? 0, num(p.cost_eur));
    a.pkg = a.pkg || !!p.pkg;
    a.reviewed = a.reviewed || !!p.reviewed;
    // one product key = one catalogue product = one rate (collected or returned rows alike)
    if (p.vr != null) a.vr = Math.max(a.vr ?? 0, num(p.vr));
    a.vd = a.vd || !!p.vd;
    if (p.g === "collected") {
      a.sources.add(p.s);
      a.n += num(p.n); a.pkgs += num(p.pkgs); a.fr += num(p.fr); a.rev += num(p.rev); a.cm += num(p.cm);
      a.sh += num(p.sh); a.lbUngated += num(p.lb); a.commEur += num(p.lb) * (ratio[p.s] ?? 0);
      a.vt += num(p.vt);
      a.pc += num(p.pc); a.rc += num(p.rc); a.cx += num(p.cx); a.xr += num(p.xr);
    } else if (p.g === "returned") {
      a.rPkgs += num(p.pkgs); a.rRev += num(p.rev); a.rSh += num(p.sh);
    }
    by.set(p.k, a);
  }
  const vatOfAcc = (a: Acc) => (perLine ? a.vt : a.rev * vatShare(s.defaultVatRate));
  /** Known: every package costed; partial: some; the uncosted revenue is what the estimate covers. */
  const costOf = (a: Acc) => {
    if (!perLineCost) {
      const whole = a.cost_eur != null && a.pkg;
      return {
        known: whole, partial: false, pc: whole ? a.pkgs : 0,
        unit: whole ? r0((a.cost_eur ?? 0) * MKD_PER_EUR) : null,
        uncostedRev: a.pkg && !whole ? a.rev : a.kind === "unknown" ? a.rev : 0,
      };
    }
    return {
      known: a.pkg && a.pkgs > 0 && a.pc >= a.pkgs,
      partial: a.pkg && a.pc > 0 && a.pc < a.pkgs,
      pc: a.pc,
      unit: a.pkg && a.pc > 0 ? r0(a.cm / a.pc) : null,
      uncostedRev: a.pkg ? Math.max(0, a.rev - a.rc) : a.kind === "unknown" ? Math.max(0, a.rev - a.xr) : 0,
    };
  };
  const toRow = (a: Acc): ProductRow => {
    const c = costOf(a);
    const vat = vatOfAcc(a);
    const classified = perLine && !a.vd && a.vr != null;
    const courier = a.sh * deliverMkd + a.rSh * returnMkd;
    const commission = a.commEur * MKD_PER_EUR;
    const uncostedRev = c.uncostedRev;
    const est = uncostedRev > 0 && costRatio != null ? uncostedRev * costRatio : null;
    const net = a.rev - vat - a.cm - a.cx - (est ?? 0) - courier - commission;
    return {
      key: a.key,
      name: a.name,
      kind: a.kind,
      reviewed: a.reviewed,
      package: a.pkg,
      sources: PROFIT_SOURCES.filter((x) => a.sources.has(x)),
      sales: a.n,
      packages: a.pkgs,
      free_packages: a.fr,
      revenue_mkd: r0(a.rev),
      cost_known: c.known,
      cost_partial: c.partial,
      unit_cost_mkd: c.unit,
      packages_costed: c.pc,
      cogs_mkd: r0(a.cm),
      cogs_est_mkd: est == null ? null : r0(est),
      cogs_extra_mkd: r0(a.cx),
      vat_mkd: r0(vat),
      vat_rate: classified ? a.vr : s.defaultVatRate,
      vat_classified: classified,
      courier_mkd: r0(courier),
      commission_mkd: r0(commission),
      commission_share: a.lbUngated > 0 ? a.commEur / a.lbUngated : null,
      net_mkd: r0(net),
      margin: share(net, a.rev),
      returned_packages: a.rPkgs,
      returned_mkd: r0(a.rRev),
      return_rate: share(a.rPkgs, a.pkgs + a.rPkgs),
    };
  };
  // to the cent, then the key in byte order: the same order however the rows were summed
  const cents = (v: number) => Math.round(v * 100);
  const all = [...by.values()].sort((x, y) => cents(y.rev) - cents(x.rev) || cents(y.rRev) - cents(x.rRev)
    || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  const head = all.slice(0, PROFIT_PRODUCTS_MAX);
  const tail = all.slice(PROFIT_PRODUCTS_MAX);
  let others: ProductRow | null = null;
  if (tail.length) {
    const o: Acc = {
      key: "__others__", name: null, kind: "product", reviewed: false, pkg: true, sources: new Set(), cost_eur: null,
      n: 0, pkgs: 0, fr: 0, rev: 0, cm: 0, sh: 0, lbUngated: 0, commEur: 0, rPkgs: 0, rRev: 0, rSh: 0,
      vt: 0, vr: null, vd: false, pc: 0, rc: 0, cx: 0, xr: 0,
    };
    const rates = new Set<number | null>();
    for (const a of tail) {
      for (const x of a.sources) o.sources.add(x);
      o.n += a.n; o.pkgs += a.pkgs; o.fr += a.fr; o.rev += a.rev; o.cm += a.cm; o.sh += a.sh;
      o.lbUngated += a.lbUngated; o.commEur += a.commEur; o.rPkgs += a.rPkgs; o.rRev += a.rRev; o.rSh += a.rSh;
      o.vt += a.vt; o.vd = o.vd || a.vd || a.vr == null;
      o.pc += a.pc; o.rc += a.rc; o.cx += a.cx; o.xr += a.xr;
      rates.add(a.vd ? null : a.vr);
    }
    others = toRow(o);
    // several products: one rate only when they all share it
    others.vat_rate = rates.size === 1 && !rates.has(null) ? [...rates][0] : null;
    others.vat_classified = perLine && !o.vd;
    // the tail's known costs are already in cogs_mkd; only its uncosted part is estimated
    const uncosted = tail.reduce((t, a) => t + costOf(a).uncostedRev, 0);
    const est = uncosted > 0 && costRatio != null ? uncosted * costRatio : null;
    others.cost_known = false;
    others.cost_partial = false;
    others.unit_cost_mkd = null;
    others.cogs_est_mkd = est == null ? null : r0(est);
    const vat = vatOfAcc(o);
    const net = o.rev - vat - o.cm - o.cx - (est ?? 0) - (o.sh * deliverMkd + o.rSh * returnMkd) - o.commEur * MKD_PER_EUR;
    others.net_mkd = r0(net);
    others.margin = share(net, o.rev);
  }
  return { rows: head.map(toRow), others, total: all.length };
}

// ── realized денари per paid package (Margin Lab) ───────────────────────────

export interface Distribution {
  packages: number;
  avg_mkd: number | null;
  min_mkd: number | null;
  p25_mkd: number | null;
  median_mkd: number | null;
  p75_mkd: number | null;
  max_mkd: number | null;
}

/** Weighted order statistics over the denar-binned histogram (q packages at
 *  u денари): the smallest price at which the running count reaches p × total. */
export function distributionOf(hist: HistRow[] | null | undefined, source: string | null): Distribution {
  const bins = new Map<number, { q: number; v: number }>();
  for (const h of hist ?? []) {
    if (source !== null && h.s !== source) continue;
    const b = bins.get(num(h.u)) ?? { q: 0, v: 0 };
    b.q += num(h.q); b.v += num(h.v);
    bins.set(num(h.u), b);
  }
  const sorted = [...bins.entries()].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((t, [, b]) => t + b.q, 0);
  if (!total) return { packages: 0, avg_mkd: null, min_mkd: null, p25_mkd: null, median_mkd: null, p75_mkd: null, max_mkd: null };
  const at = (p: number) => {
    let cum = 0;
    for (const [u, b] of sorted) { cum += b.q; if (cum >= p * total) return u; }
    return sorted[sorted.length - 1][0];
  };
  const value = sorted.reduce((t, [, b]) => t + b.v, 0);
  return {
    packages: total,
    avg_mkd: Math.round(value / total),
    min_mkd: sorted[0][0],
    p25_mkd: at(0.25),
    median_mkd: at(0.5),
    p75_mkd: at(0.75),
    max_mkd: sorted[sorted.length - 1][0],
  };
}

// ── one clock ───────────────────────────────────────────────────────────────

export interface TrendPoint { d: string; sales: number; revenue_mkd: number; net_mkd: number }
export interface AffiliateRow {
  key: string;
  name: string | null;
  /** All the period's sales of this webmaster (collected + returned + still open). */
  sales_total: number;
  open: number;
  pl: PLRow;
}
export interface ProfitClock {
  clock: "sale" | "delivered";
  cost_ratio: number | null;
  total: PLRow;
  by_source: PLRow[];
  prev: { revenue_mkd: number; net_mkd: number; sales: number; margin: number | null } | null;
  trend: TrendPoint[];
  affiliates: AffiliateRow[];
  /** Cohort only: the sales still open (courier / label / to pack) and unproven paid. */
  open: { count: number; value_mkd: number } | null;
  unproven: { count: number; value_mkd: number } | null;
}

function returnedParcelsCash(rpc: ProfitRpc, source: string | null, day?: string): number {
  let n = 0;
  for (const r of rpc.returned_parcels ?? []) {
    if (source !== null && r.s !== source) continue;
    if (day !== undefined && r.d !== day) continue;
    n += num(r.n);
  }
  return n;
}

/** Every day (YYYY-MM-DD) or month (YYYY-MM) bucket from `from` to `to` — the
 *  trend shows the empty ones too. */
export function bucketKeys(from: string, to: string, granularity: "day" | "month"): string[] {
  const out: string[] = [];
  const YMD = /^\d{4}-\d{2}-\d{2}$/;
  if (!YMD.test(from) || !YMD.test(to) || from > to) return out;
  if (granularity === "month") {
    let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
    const ey = Number(to.slice(0, 4)), em = Number(to.slice(5, 7));
    while (y < ey || (y === ey && m <= em)) {
      out.push(`${y}-${String(m).padStart(2, "0")}`);
      m++; if (m > 12) { m = 1; y++; }
      if (out.length > 800) break;
    }
    return out;
  }
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end && out.length <= 800) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function buildClock(rpc: ProfitRpc, prev: ProfitRpc | null, s: ProfitSettings, keys?: readonly string[]): ProfitClock {
  const cohort = rpc.clock !== "cash";
  const agg = rpc.agg ?? [];
  const costRatio = costRatioOf(agg);
  const retOf = (dim: string, key: string | null): { parcels: number; sales: number | null; value: number | null } => {
    if (!cohort) {
      // MEX return days are known per source and per day, not per webmaster
      if (dim === "w") return { parcels: 0, sales: null, value: null };
      const n = dim === "s" ? returnedParcelsCash(rpc, key) : returnedParcelsCash(rpc, null, key ?? undefined);
      return { parcels: n, sales: n, value: null };
    }
    const m = key === null ? measure(agg, "returned", dim) : measure(agg, "returned", dim, key);
    return { parcels: m.pw, sales: m.n, value: m.rev };
  };
  const row = (key: string, dim: string, k: string | null): PLRow => {
    const m = k === null ? measure(agg, "collected", dim) : measure(agg, "collected", dim, k);
    const ret = retOf(dim, k);
    return plRow({
      key, m, perLine: vatPerLine(rpc),
      commissionEur: gatedBonusEur(rpc.comm, dim, k, s.agentNames),
      returnedParcels: ret.parcels,
      returnedSales: ret.sales,
      returnedValue: ret.value,
      costRatio,
    }, s);
  };
  const total = row("total", "s", null);
  const by_source = PROFIT_SOURCES.map((src) => row(src, "s", src));

  // trend: every day / month bucket the SQL saw (collected), in order
  const days = [...new Set([...(keys ?? []), ...agg.filter((a) => a.dim === "d").map((a) => a.key)])].sort();
  const trend: TrendPoint[] = days.map((d) => {
    const r = row(d, "d", d);
    return { d, sales: r.sales, revenue_mkd: r.revenue_mkd, net_mkd: r.net_mkd };
  });

  // AlterCPA per webmaster (Σ collected = the AlterCPA row)
  const wms = [...new Set(agg.filter((a) => a.dim === "w").map((a) => a.key))];
  const affiliates: AffiliateRow[] = wms.map((w) => {
    const pl = row(w, "w", w);
    let all = 0, open = 0;
    for (const a of agg) {
      if (a.dim !== "w" || a.key !== w) continue;
      all += num(a.n);
      if (a.g === "open") open += num(a.n);
    }
    const name = w === "__none__" ? null : (rpc.wm_names?.[w] ?? null);
    return { key: w, name, sales_total: all, open, pl };
  }).sort((a, b) => b.pl.revenue_mkd - a.pl.revenue_mkd || b.sales_total - a.sales_total || a.key.localeCompare(b.key));

  let prevOut: ProfitClock["prev"] = null;
  if (prev) {
    const pc = buildClockTotalsOnly(prev, s);
    prevOut = { revenue_mkd: pc.revenue_mkd, net_mkd: pc.net_mkd, sales: pc.sales, margin: pc.margin };
  }
  const openM = cohort ? measure(agg, "open", "s") : null;
  const unprovenM = cohort ? measure(agg, "unproven", "s") : null;
  return {
    clock: cohort ? "sale" : "delivered",
    cost_ratio: costRatio,
    total,
    by_source,
    prev: prevOut,
    trend,
    affiliates,
    open: openM ? { count: openM.n, value_mkd: r0(openM.rev) } : null,
    unproven: unprovenM ? { count: unprovenM.n, value_mkd: r0(unprovenM.rev) } : null,
  };
}

/** The whole-business P&L row of a detail-less RPC (the previous period). */
export function buildClockTotalsOnly(rpc: ProfitRpc, s: ProfitSettings): PLRow {
  const cohort = rpc.clock !== "cash";
  const agg = rpc.agg ?? [];
  const m = measure(agg, "collected", "s");
  const ret = cohort ? measure(agg, "returned", "s") : null;
  const retParcels = cohort ? ret!.pw : returnedParcelsCash(rpc, null);
  return plRow({
    key: "total", m, perLine: vatPerLine(rpc),
    commissionEur: gatedBonusEur(rpc.comm, "s", null, s.agentNames),
    returnedParcels: retParcels,
    returnedSales: cohort ? ret!.n : retParcels,
    returnedValue: cohort ? ret!.rev : null,
    costRatio: costRatioOf(agg),
  }, s);
}

// ── the cohort strip (CohortBar-compatible) ─────────────────────────────────

const IN_TOTAL = ["paid", "paid_unproven", "paid_legacy", "courier", "courier_problem", "label", "to_pack", "returned"] as const;
const OUTSIDE = ["cancelled_after_sale", "trashed_after_sale", "replacement"] as const;

interface StripPart { key: string; count: number; value_mkd: number; cod_mkd?: number; orders: number; web: number; mex_only: number; booked: number }
export interface ProfitStrip {
  total: { count: number; value_mkd: number; cod_mkd: number; orders: number; web: number; mex_only: number; booked: number };
  buckets: StripPart[];
  outside: StripPart[];
  by_source: { key: string; total: ProfitStrip["total"]; buckets: StripPart[]; outside: StripPart[] }[];
}

export function buildStrip(rows: StripRow[] | undefined): ProfitStrip {
  const part = (key: string, src: string | null, withCod: boolean): StripPart => {
    let count = 0, v = 0, c = 0, o = 0, w = 0, m = 0, bk = 0;
    for (const r of rows ?? []) {
      if (r.b !== key || (src !== null && r.s !== src)) continue;
      count += num(r.n); v += num(r.v); c += num(r.c); o += num(r.no); w += num(r.nw); m += num(r.nm); bk += num(r.nb);
    }
    return { key, count, value_mkd: r0(v), ...(withCod ? { cod_mkd: r0(c) } : {}), orders: o, web: w, mex_only: m, booked: bk };
  };
  const block = (src: string | null) => {
    const buckets = IN_TOTAL.map((k) => part(k, src, true));
    const outside = OUTSIDE.map((k) => part(k, src, false));
    const total = buckets.reduce((t, b) => ({
      count: t.count + b.count, value_mkd: t.value_mkd + b.value_mkd, cod_mkd: t.cod_mkd + (b.cod_mkd ?? 0),
      orders: t.orders + b.orders, web: t.web + b.web, mex_only: t.mex_only + b.mex_only, booked: t.booked + b.booked,
    }), { count: 0, value_mkd: 0, cod_mkd: 0, orders: 0, web: 0, mex_only: 0, booked: 0 });
    return { total, buckets, outside };
  };
  const all = block(null);
  return { ...all, by_source: PROFIT_SOURCES.map((k) => ({ key: k, ...block(k) })) };
}

// ── quality ─────────────────────────────────────────────────────────────────

export type ProfitQualityKind =
  | "uncosted_packages" | "mex_only_contents" | "unproven_paid" | "non_product_lines"
  | "orders_without_lines" | "vat_unclassified" | "vat_flat_default" | "lead_cost_missing" | "return_fee_unconfirmed"
  // Sigma costs (20260945000800): the old catalogue costs are still in use · products with
  // no approved recipe / no Sigma cost · Phase B parcels whose recipe costs more than what was packed
  | "cost_legacy" | "recipe_missing" | "extra_goods_negative";

/** Where the unclassified VAT value of one clock's collected sales comes from (cohort:
 *  per product key). Taxed at the default rate, never silently: MEX-only parcels (contents
 *  unknown), sales without lines, names that match no catalogue product, catalogue
 *  products with no rate yet. */
export interface VatUnclassified {
  revenue_mkd: number;
  vat_mkd: number;
  mex_only_mkd: number;
  no_lines_mkd: number;
  unmatched_mkd: number;
  no_rate_mkd: number;
  /** product keys behind it (MEX-only and sales without lines count as one each) */
  products: number;
}

export function vatUnclassifiedOf(rpc: ProfitRpc): VatUnclassified | null {
  if (!vatPerLine(rpc)) return null;
  const by = new Map<string, number>();
  for (const p of rpc.products ?? []) {
    if (p.g !== "collected" || !p.vd) continue;
    by.set(p.k, (by.get(p.k) ?? 0) + num(p.rev));
  }
  let mex = 0, none = 0, unmatched = 0, noRate = 0;
  for (const [k, v] of by) {
    if (k === "__mex_only__") mex += v;
    else if (k === "__unknown__") none += v;
    else if (k.startsWith("p:")) noRate += v;
    else unmatched += v;
  }
  const total = mex + none + unmatched + noRate;
  return {
    revenue_mkd: r0(total),
    vat_mkd: r0(total * vatShare(DEFAULT_VAT_RATE)),
    mex_only_mkd: r0(mex),
    no_lines_mkd: r0(none),
    unmatched_mkd: r0(unmatched),
    no_rate_mkd: r0(noRate),
    products: [...by.values()].filter((v) => v !== 0).length,
  };
}

export interface ProfitQuality {
  kind: ProfitQualityKind;
  severity: "critical" | "warning" | "info";
  count: number;
  value_mkd?: number;
  share?: number | null;
  /** uncosted_packages: the biggest ones (name, packages, revenue). */
  top?: { key: string; name: string | null; packages: number; revenue_mkd: number }[];
}

export function buildQuality(
  cohortRpc: ProfitRpc,
  cohortClock: ProfitClock,
  products: ProductRow[],
  s: ProfitSettings,
): ProfitQuality[] {
  const t = cohortClock.total;
  const out: ProfitQuality[] = [];
  const unc = products.filter((p) => p.package && !p.cost_known);
  const sigma = costModeOf(cohortRpc) === "sigma";
  if (!sigma) out.push({ kind: "cost_legacy", severity: "warning", count: 1 });
  out.push({
    // Sigma: a package is uncosted because its product has no approved recipe or an article no cost
    kind: sigma ? "recipe_missing" : "uncosted_packages",
    severity: t.packages_uncosted > 0 ? "warning" : "info",
    count: t.packages_uncosted,
    value_mkd: r0(unc.reduce((a, p) => a + p.revenue_mkd, 0)),
    share: t.coverage_packages == null ? null : 1 - t.coverage_packages,
    top: [...unc].sort((a, b) => b.packages - a.packages || b.revenue_mkd - a.revenue_mkd).slice(0, 10)
      .map((p) => ({ key: p.key, name: p.name, packages: p.packages, revenue_mkd: p.revenue_mkd })),
  });
  const mex = products.find((p) => p.key === "__mex_only__");
  out.push({ kind: "mex_only_contents", severity: "info", count: mex?.sales ?? 0, value_mkd: mex?.revenue_mkd ?? 0 });
  out.push({
    kind: "unproven_paid", severity: "critical",
    count: cohortClock.unproven?.count ?? 0, value_mkd: cohortClock.unproven?.value_mkd ?? 0,
  });
  const nonProduct = (cohortRpc.products ?? []).filter((p) => p.g === "collected" && !p.pkg && !p.reviewed
    && p.kind && !["product", "gift", "unknown"].includes(p.kind));
  out.push({
    kind: "non_product_lines", severity: "info",
    count: nonProduct.reduce((a, p) => a + num(p.qty ?? 0), 0),
    value_mkd: r0(nonProduct.reduce((a, p) => a + num(p.rev), 0)),
  });
  out.push({
    kind: "orders_without_lines", severity: "warning",
    count: num(cohortRpc.no_items?.n), value_mkd: r0(num(cohortRpc.no_items?.v)),
  });
  // VAT per product from Sigma (01.10.2026): what had no rate is taxed at the default and listed here
  if (vatPerLine(cohortRpc)) {
    const unclassified = products.filter((p) => !p.vat_classified && p.revenue_mkd !== 0);
    out.push({
      kind: "vat_unclassified", severity: "info",
      count: unclassified.length,
      value_mkd: t.vat_unclassified.revenue_mkd,
      share: t.revenue_mkd > 0 ? t.vat_unclassified.revenue_mkd / t.revenue_mkd : null,
      top: [...unclassified].sort((a, b) => b.revenue_mkd - a.revenue_mkd).slice(0, 10)
        .map((p) => ({ key: p.key, name: p.name, packages: p.packages, revenue_mkd: p.revenue_mkd })),
    });
  } else {
    // an older insights_profit() answered: every line at the default rate — say so
    out.push({ kind: "vat_flat_default", severity: "warning", count: 1 });
  }
  if (t.cogs_extra_detail.negative_mkd < 0) {
    out.push({ kind: "extra_goods_negative", severity: "info", count: 1, value_mkd: t.cogs_extra_detail.negative_mkd });
  }
  out.push({ kind: "lead_cost_missing", severity: "info", count: cohortClock.by_source.find((r) => r.key === "altercpa")?.sales ?? 0 });
  if (s.returnEur === 0) out.push({ kind: "return_fee_unconfirmed", severity: "info", count: r0(t.parcels_returned) });
  return out;
}

// ── the response ────────────────────────────────────────────────────────────

/** The previous window, or null past PROFIT_PREV_MAX_DAYS (see there). */
export function profitPrevWindow(win: InsightsWindow): { fromIso: string; toEndIso: string } | null {
  if (!win.prev || win.days > PROFIT_PREV_MAX_DAYS) return null;
  return { fromIso: win.prev.fromIso, toEndIso: win.prev.toEndIso };
}

export interface ProfitRpcs {
  cohort: ProfitRpc;
  cash: ProfitRpc;
  prevCohort?: ProfitRpc | null;
  prevCash?: ProfitRpc | null;
}

export interface VatMeta {
  /** per_product_sigma = Σ per line at each product's Sigma rate; flat_default = an
   *  older insights_profit() answered and every line is at default_rate. */
  mode: VatMode;
  default_rate: number;
  /** = default_rate — kept for a client older than 01.10.2026 that labels the VAT line with it. */
  rate: number;
  /** Kept for that older client (it showed "pending" when false); the decision is the owner's, 01.10.2026. */
  confirmed: true;
  source: "sigma";
  decided: "2026-10-01";
  /** The collected sales' VAT by rate, per clock — {"0.05": {revenue_mkd, vat_mkd}, "0.18": …}. */
  by_rate: { cohort: Record<string, Omit<VatPart, "rate">>; cash: Record<string, Omit<VatPart, "rate">> };
  /** VAT ÷ revenue net of VAT, per clock (5 % if everything were a supplement); null without revenue. */
  effective_rate: { cohort: number | null; cash: number | null };
  /** What had no rate (taxed at default_rate): the cohort's by kind; the cash clock's total only. */
  unclassified: { cohort: VatUnclassified | null; cash: { revenue_mkd: number; vat_mkd: number } };
}

/** The Sigma snapshot the first cost load came from (owner 01.10.2026: CalcBuyPrice of
 *  Ф00001-04, StockObject of 29.09.2026) — the label's date when the loaded costs do not say
 *  one (ProfitSettings.costAsOf, from sigmaCostAsOf()). */
export const SIGMA_COST_AS_OF = "2026-09-29";

export interface SigmaCostRefRow { source_ref?: unknown; valid_from?: unknown }

const REF_YMD_RE = /(\d{4})-(\d{2})-(\d{2})/;
const REF_DMY_RE = /(\d{1,2})\.(\d{1,2})\.(\d{4})/;

/** The day a cost row's Sigma snapshot was taken: the date in its source_ref ("Ф00001-04 StockObject
 *  2026-09-30", "… 30.09.2026"), else its valid_from's Skopje day; '-infinity' / nothing → null. */
export function sigmaCostRowDay(r: SigmaCostRefRow): string | null {
  const ref = typeof r.source_ref === "string" ? r.source_ref : "";
  let m = REF_YMD_RE.exec(ref);
  if (m && isValidYmd(`${m[1]}-${m[2]}-${m[3]}`)) return `${m[1]}-${m[2]}-${m[3]}`;
  m = REF_DMY_RE.exec(ref);
  if (m) {
    const ymd = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    if (isValidYmd(ymd)) return ymd;
  }
  if (typeof r.valid_from === "string" && /^\d{4}-/.test(r.valid_from)) {
    const ms = Date.parse(r.valid_from);
    if (Number.isFinite(ms)) return skopjeYmd(ms) || null;
  }
  return null;
}

/**
 * The label's date from the Sigma cost rows actually loaded (the newest rows of
 * stock_article_costs with a Sigma source): the day most of them name; a tie → the later day.
 * null when none names a day (the caller keeps SIGMA_COST_AS_OF).
 */
export function sigmaCostAsOf(rows: readonly SigmaCostRefRow[] | null | undefined): string | null {
  const n = new Map<string, number>();
  for (const r of rows || []) {
    const d = r ? sigmaCostRowDay(r) : null;
    if (d) n.set(d, (n.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [d, c] of n) {
    const bc = best === null ? -1 : n.get(best)!;
    if (c > bc || (c === bc && d > best!)) best = d;
  }
  return best;
}

/** The unit cost's source of a payload: sigma / legacy (an older body = legacy). */
export const costModeOf = (rpc: Pick<ProfitRpc, "cost_mode"> | null | undefined): "legacy" | "sigma" | "mixed" =>
  rpc?.cost_mode === "sigma" ? "sigma" : rpc?.cost_mode === "mixed" ? "mixed" : "legacy";

export interface CostMeta {
  /** sigma = Sigma CalcBuyPrice through the approved recipes at the sale day (owner 01.10.2026);
   *  legacy = the old catalogue cost_price; mixed = the clocks disagree (a switch mid-request). */
  source: "sigma" | "legacy" | "mixed";
  basis: "sigma_calcbuyprice" | "catalogue_cost_price";
  /** The Sigma snapshot date (YYYY-MM-DD); null for legacy. */
  as_of: string | null;
  /** Phase B (extra packed goods) ran on both clocks. */
  extra_goods: boolean;
  /** Share of the collected packages / revenue that is costed, per clock. */
  coverage: { cohort: { packages: number | null; revenue: number | null }; cash: { packages: number | null; revenue: number | null } };
  /** Products (cohort) with packages but no cost, and with a partial one. */
  uncosted_products: number;
  partial_products: number;
}

function costMeta(
  cohortRpc: ProfitRpc, cashRpc: ProfitRpc, cohort: ProfitClock, cash: ProfitClock, products: ProductRow[], asOf?: string | null,
): CostMeta {
  const a = costModeOf(cohortRpc), b = costModeOf(cashRpc);
  const source = a === b ? a : "mixed";
  const cov = (r: PLRow) => ({ packages: r.coverage_packages, revenue: r.coverage_revenue });
  return {
    source,
    basis: source === "sigma" ? "sigma_calcbuyprice" : "catalogue_cost_price",
    as_of: source === "sigma" ? (asOf && isValidYmd(asOf) ? asOf : SIGMA_COST_AS_OF) : null,
    extra_goods: !!cohortRpc.extra_goods && !!cashRpc.extra_goods,
    coverage: { cohort: cov(cohort.total), cash: cov(cash.total) },
    uncosted_products: products.filter((p) => p.package && !p.cost_known && !p.cost_partial && p.packages > 0).length,
    partial_products: products.filter((p) => p.package && p.cost_partial).length,
  };
}

function vatMeta(cohortRpc: ProfitRpc, cashRpc: ProfitRpc, cohort: ProfitClock, cash: ProfitClock, s: ProfitSettings): VatMeta {
  const byRate = (row: PLRow) => Object.fromEntries(row.vat_split.map((p) => [String(p.rate), { revenue_mkd: p.revenue_mkd, vat_mkd: p.vat_mkd }]));
  const eff = (row: PLRow) => (row.revenue_mkd - row.vat_mkd > 0 ? row.vat_mkd / (row.revenue_mkd - row.vat_mkd) : null);
  const perLine = vatPerLine(cohortRpc) && vatPerLine(cashRpc);
  return {
    mode: perLine ? "per_product_sigma" : "flat_default",
    default_rate: s.defaultVatRate,
    rate: s.defaultVatRate,
    confirmed: true,
    source: "sigma",
    decided: "2026-10-01",
    by_rate: { cohort: byRate(cohort.total), cash: byRate(cash.total) },
    effective_rate: { cohort: eff(cohort.total), cash: eff(cash.total) },
    unclassified: { cohort: vatUnclassifiedOf(cohortRpc), cash: cash.total.vat_unclassified },
  };
}

/**
 * GET /api/insights/profit (owners only). Both clocks, the cohort strip (Σ =
 * insights_cohort), the product P&L (cohort), the realized-price
 * distributions (Margin Lab) and the quality rail.
 */
export function buildProfitResponse(
  r: ProfitRpcs,
  win: InsightsWindow,
  s: ProfitSettings,
  now: Date = new Date(),
  cache: ProfitCacheMeta | null = null,
): Record<string, unknown> {
  const gran = r.cohort.granularity === "month" ? "month" : "day";
  const keys = bucketKeys(win.from, win.to, gran);
  const cohort = buildClock({ ...r.cohort, clock: "cohort" }, r.prevCohort ? { ...r.prevCohort, clock: "cohort" } : null, s, keys);
  const cash = buildClock({ ...r.cash, clock: "cash" }, r.prevCash ? { ...r.prevCash, clock: "cash" } : null, s, keys);
  const products = productRows(r.cohort, s, cohort.cost_ratio);
  const realized: Record<string, Distribution> = { all: distributionOf(r.cohort.hist, null) };
  for (const src of PROFIT_SOURCES) realized[src] = distributionOf(r.cohort.hist, src);
  const prevWin = profitPrevWindow(win);
  return {
    meta: {
      from: win.from,
      to: win.to,
      days: win.days,
      partial: win.partial,
      prev_from: prevWin ? win.prev!.from : null,
      prev_to: prevWin ? win.prev!.to : null,
      prev_to_end: prevWin ? win.prev!.toEndIso : null,
      prev_skipped: !!win.prev && !prevWin,
      prev_max_days: PROFIT_PREV_MAX_DAYS,
      generated_at: now.toISOString(),
      money: true,
      granularity: gran,
      vat: vatMeta(r.cohort, r.cash, cohort, cash, s),
      // the purchase cost's source (owner 01.10.2026: Sigma CalcBuyPrice for everything)
      cost: costMeta(r.cohort, r.cash, cohort, cash, products.rows, s.costAsOf),
      courier: {
        deliver_mkd: r0(s.deliverEur * MKD_PER_EUR),
        return_mkd: r0(s.returnEur * MKD_PER_EUR),
        source: s.rateSource,
      },
      lead_cost: { configured: false },
      commission: { rule: "per_package_paid_agents", agents: s.agentNames.size },
      mkd_per_eur: MKD_PER_EUR,
      // windows over PROFIT_CACHE_MIN_DAYS: which closed months came from the
      // monthly cache (insights_profit_monthly) and how old the oldest is
      cache,
    },
    strip: buildStrip(r.cohort.strip),
    cohort,
    cash,
    products: products.rows,
    products_others: products.others,
    products_total: products.total,
    realized,
    quality: buildQuality(r.cohort, cohort, products.rows, s),
  };
}

// ── the monthly cache (migration 20260942000200) ────────────────────────────
//
// A window longer than PROFIT_CACHE_MIN_DAYS reads whole CLOSED months from
// insights_profit_monthly and computes only the rest live (the partial first
// month, the current month, and any month not cached with today's logic /
// catalogue). Every block insights_profit() returns is a sum per key, so the
// pieces add up to exactly what one live call over the window returns —
// scripts/verify-tab-profit.mjs --cache proves it on live data.

/** Windows up to this many days are computed live (daily granularity). */
export const PROFIT_CACHE_MIN_DAYS = 62;

export interface ProfitCacheMeta {
  /** Closed months of the window read from the cache, per clock. */
  months: { cohort: number; cash: number };
  /** Closed months the window holds (cacheable). */
  closed_months: number;
  /** The oldest / newest snapshot used ("cached until"), ISO; null when none. */
  refreshed_min: string | null;
  refreshed_max: string | null;
  /** The pieces computed live (Skopje days). */
  live: { clock: "cohort" | "cash"; from: string; to: string }[];
}

export interface DayRange { from: string; to: string }

const monthStart = (ymd: string) => `${ymd.slice(0, 7)}-01`;
function monthEnd(ymd: string): string {
  const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);   // day 0 of the next month
}

/**
 * The window cut at month boundaries: each piece is either a whole CLOSED
 * month (a cache candidate, keyed YYYY-MM-01) or a live day range.
 */
export function profitPieces(win: Pick<InsightsWindow, "from" | "to">, now: Date = new Date()): {
  months: string[];
  live: DayRange[];
} {
  const todayMonth = monthStart(skopjeTodayYmd(now));
  const months: string[] = [];
  const live: DayRange[] = [];
  for (let m = monthStart(win.from); m <= win.to; m = addDaysYmd(monthEnd(m), 1)) {
    const from = m < win.from ? win.from : m;
    const end = monthEnd(m);
    const to = end > win.to ? win.to : end;
    if (from === m && to === end && m < todayMonth) months.push(m);
    else live.push({ from, to });
    if (months.length + live.length > 40) break;
  }
  return { months, live };
}

/** Day ranges joined where one ends the day before the next starts (fewer live calls). */
export function coalesceRanges(ranges: DayRange[]): DayRange[] {
  const sorted = [...ranges].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const out: DayRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && addDaysYmd(last.to, 1) >= r.from) {
      if (r.to > last.to) last.to = r.to;
    } else out.push({ ...r });
  }
  return out;
}

function sumInto(a: object, b: object, keys: readonly string[]) {
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  for (const k of keys) x[k] = num(x[k]) + num(y[k]);
}

const AGG_KEYS = ["n", "rev", "card", "pw", "rc", "ru", "rn", "cm", "pc", "pu", "fr", "lb",
  "vt", "vc", "vu", "v00", "v05", "v10", "v18", "cx", "cxm", "cxn", "xr", "xn"] as const;
const PROD_KEYS = ["n", "qty", "pkgs", "fr", "rev", "cm", "sh", "lb", "vt"] as const;
/** 20260945000800's per-product cost keys: summed only when the pieces carry them (an older
 *  piece without them must not turn a product's "cost decided by cost_eur" into "0 costed"). */
const PROD_COST_KEYS = ["pc", "rc", "cx", "xr"] as const;

/**
 * Pieces of one clock (cached months + live ranges) → one payload, exactly as
 * insights_profit() returns it for the whole window: sums per key; a product's
 * name / kind the byte-order minimum (the SQL's COLLATE "C"), its cost the
 * maximum, its flags OR-ed.
 */
export function mergeProfitRpcs(pieces: ProfitRpc[], clock: "cohort" | "cash", granularity: "day" | "month"): ProfitRpc {
  const agg = new Map<string, AggRow>();
  const comm = new Map<string, CommRow>();
  const strip = new Map<string, StripRow>();
  const products = new Map<string, ProductRpcRow>();
  const hist = new Map<string, HistRow>();
  const ret = new Map<string, { s: string; d: string; n: number }>();
  const wm: Record<string, string> = {};
  let noItems = { n: 0, v: 0 };
  for (const p of pieces) {
    for (const a of p.agg ?? []) {
      const k = `${a.g}|${a.dim}|${a.key}`;
      const cur = agg.get(k);
      if (cur) sumInto(cur, a, AGG_KEYS);
      else { const c = { ...a }; sumInto(Object.assign(c, Object.fromEntries(AGG_KEYS.map((x) => [x, 0]))), a, AGG_KEYS); agg.set(k, c); }
    }
    for (const c of p.comm ?? []) {
      const k = `${c.dim}|${c.key}|${c.o === null ? "\u0000" : c.o}`;
      const cur = comm.get(k);
      if (cur) { cur.b = num(cur.b) + num(c.b); cur.n = num(cur.n) + num(c.n); } else comm.set(k, { ...c, b: num(c.b), n: num(c.n) });
    }
    for (const r of p.strip ?? []) {
      const k = `${r.s}|${r.b}`;
      const cur = strip.get(k);
      if (cur) sumInto(cur, r, ["n", "v", "c", "no", "nw", "nm", "nb"]);
      else strip.set(k, { ...r, n: num(r.n), v: num(r.v), c: num(r.c), no: num(r.no), nw: num(r.nw), nm: num(r.nm), nb: num(r.nb) });
    }
    for (const r of p.products ?? []) {
      const k = `${r.s}|${r.g}|${r.k}`;
      const cur = products.get(k);
      if (!cur) {
        const c = { ...r };
        sumInto(Object.assign(c, Object.fromEntries(PROD_KEYS.map((x) => [x, 0]))), r, PROD_KEYS);
        if (r.pc !== undefined) sumInto(Object.assign(c, Object.fromEntries(PROD_COST_KEYS.map((x) => [x, 0]))), r, PROD_COST_KEYS);
        products.set(k, c);
        continue;
      }
      sumInto(cur, r, PROD_KEYS);
      if (r.pc !== undefined || cur.pc !== undefined) sumInto(cur, r, PROD_COST_KEYS);
      if (r.cost_mkd != null && (cur.cost_mkd == null || num(r.cost_mkd) > num(cur.cost_mkd))) cur.cost_mkd = num(r.cost_mkd);
      if (r.name != null && (cur.name == null || r.name < cur.name)) cur.name = r.name;
      if (r.kind != null && (cur.kind == null || r.kind < cur.kind)) cur.kind = r.kind;
      cur.reviewed = !!cur.reviewed || !!r.reviewed;
      cur.pkg = !!cur.pkg || !!r.pkg;
      if (r.cost_eur != null && (cur.cost_eur == null || num(r.cost_eur) > num(cur.cost_eur))) cur.cost_eur = num(r.cost_eur);
      if (r.vr != null && (cur.vr == null || num(r.vr) > num(cur.vr))) cur.vr = num(r.vr);
      if (r.vd != null || cur.vd != null) cur.vd = !!cur.vd || !!r.vd;
    }
    for (const h of p.hist ?? []) {
      const k = `${h.s}|${h.u}`;
      const cur = hist.get(k);
      if (cur) { cur.q = num(cur.q) + num(h.q); cur.v = num(cur.v) + num(h.v); } else hist.set(k, { s: h.s, u: num(h.u), q: num(h.q), v: num(h.v) });
    }
    for (const r of p.returned_parcels ?? []) {
      const k = `${r.s}|${r.d}`;
      const cur = ret.get(k);
      if (cur) cur.n += num(r.n); else ret.set(k, { s: r.s, d: r.d, n: num(r.n) });
    }
    if (p.no_items) noItems = { n: noItems.n + num(p.no_items.n), v: noItems.v + num(p.no_items.v) };
    Object.assign(wm, p.wm_names ?? {});
  }
  const out: ProfitRpc = { clock, granularity, agg: [...agg.values()], comm: [...comm.values()], wm_names: wm };
  // VAT per line only when EVERY piece computed it (the cache version keeps them alike;
  // a mix would read an older piece's missing VAT as 0)
  if (pieces.length > 0 && pieces.every((p) => vatPerLine(p))) out.vat_mode = "per_line";
  // the cost source: one mode when every piece agrees (the cache signature keeps them alike), else "mixed"
  if (pieces.length > 0) {
    const modes = new Set(pieces.map((p) => costModeOf(p)));
    out.cost_mode = modes.size === 1 ? [...modes][0] : "mixed";
    out.extra_goods = pieces.every((p) => !!p.extra_goods);
  }
  if (clock === "cohort") {
    out.strip = [...strip.values()];
    out.products = [...products.values()];
    out.hist = [...hist.values()];
    out.no_items = noItems;
  } else {
    out.returned_parcels = [...ret.values()];
  }
  return out;
}

/** TS twin of the SQL's webmaster names (wmn): the latest non-empty name per
 *  wm_id, by named_at (nulls last) then updated_at. */
export function webmasterNames(
  rows: readonly { wm_id: string; name: string | null; named_at?: string | null; updated_at?: string | null }[] | null | undefined,
): Record<string, string> {
  const best = new Map<string, { name: string; named: number; updated: number }>();
  for (const r of rows ?? []) {
    if (!r.name || !r.name.trim()) continue;
    const named = r.named_at ? Date.parse(r.named_at) : -Infinity;
    const updated = r.updated_at ? Date.parse(r.updated_at) : -Infinity;
    const cur = best.get(r.wm_id);
    if (!cur || named > cur.named || (named === cur.named && updated > cur.updated)) best.set(r.wm_id, { name: r.name, named, updated });
  }
  return Object.fromEntries([...best.entries()].map(([k, v]) => [k, v.name]));
}

export interface ProfitCacheRow { month: string; clock: "cohort" | "cash"; refreshed_at: string; payload: ProfitRpc }

export interface ProfitLoadDeps {
  /** insights_profit(range, clock, granularity, detail) — one live piece. */
  live: (range: { fromIso: string; toEndIso: string }, clock: "cohort" | "cash", granularity: "day" | "month" | null, detail: boolean) => Promise<ProfitRpc>;
  /** insights_profit_cache_read(months) — valid cached rows only. */
  readCache: (months: string[]) => Promise<ProfitCacheRow[]>;
  /** altercpa_webmasters rows (names for the merged keys). */
  webmasters: () => Promise<{ wm_id: string; name: string | null; named_at?: string | null; updated_at?: string | null }[]>;
}

/**
 * Both clocks of a window. Up to PROFIT_CACHE_MIN_DAYS: two live calls (as
 * before). Longer: cached closed months + live pieces, merged; a cache that
 * cannot be read falls back to live for everything (never a wrong number).
 */
export async function loadProfitClocks(
  win: InsightsWindow,
  deps: ProfitLoadDeps,
  now: Date = new Date(),
): Promise<{ cohort: ProfitRpc; cash: ProfitRpc; cache: ProfitCacheMeta | null }> {
  if (win.days <= PROFIT_CACHE_MIN_DAYS) {
    const [cohort, cash] = await Promise.all([
      deps.live({ fromIso: win.fromIso, toEndIso: win.toEndIso }, "cohort", null, true),
      deps.live({ fromIso: win.fromIso, toEndIso: win.toEndIso }, "cash", null, true),
    ]);
    return { cohort, cash, cache: null };
  }
  const plan = profitPieces(win, now);
  // the window's last piece ends where the window does (today: its elapsed part)
  const bounds = (r: DayRange) => ({
    fromIso: r.from === win.from ? win.fromIso : skopjeMidnightIso(r.from),
    toEndIso: r.to === win.to ? win.toEndIso : skopjeDayEndIso(r.to),
  });
  const clocks = ["cohort", "cash"] as const;
  const live: ProfitCacheMeta["live"] = [];
  const liveBy: Record<"cohort" | "cash", Promise<ProfitRpc>[]> = { cohort: [], cash: [] };
  const cachedBy: Record<"cohort" | "cash", ProfitCacheRow[]> = { cohort: [], cash: [] };
  const goLive = (clock: "cohort" | "cash", r: DayRange) => {
    live.push({ clock, from: r.from, to: r.to });
    const p = deps.live(bounds(r), clock, "month", true);
    p.catch(() => {});   // awaited below; never an unhandled rejection meanwhile
    liveBy[clock].push(p);
  };
  // the edges are live whatever the cache holds: they start while it is read
  for (const clock of clocks) for (const r of coalesceRanges(plan.live)) goLive(clock, r);
  let rows: ProfitCacheRow[] = [];
  if (plan.months.length) {
    try { rows = (await deps.readCache(plan.months)) ?? []; } catch { rows = []; }
  }
  for (const clock of clocks) {
    const mine = rows.filter((r) => r.clock === clock && plan.months.includes(r.month));
    const have = new Set(mine.map((r) => r.month));
    cachedBy[clock] = mine;
    const missing = plan.months.filter((m) => !have.has(m)).map((m) => ({ from: m, to: monthEnd(m) }));
    for (const r of coalesceRanges(missing)) goLive(clock, r);
  }
  const [co, ca, wmRows] = await Promise.all([
    Promise.all(liveBy.cohort), Promise.all(liveBy.cash),
    deps.webmasters().catch(() => null),
  ]);
  const names = wmRows ? webmasterNames(wmRows) : null;
  const finish = (clock: "cohort" | "cash", liveParts: ProfitRpc[]) => {
    const merged = mergeProfitRpcs([...cachedBy[clock].map((r) => r.payload), ...liveParts], clock, "month");
    if (names) {
      const keys = new Set((merged.agg ?? []).filter((a) => a.dim === "w").map((a) => a.key));
      merged.wm_names = Object.fromEntries(Object.entries(names).filter(([k]) => keys.has(k)));
    }
    return merged;
  };
  const used = [...cachedBy.cohort, ...cachedBy.cash].map((r) => r.refreshed_at).sort();
  return {
    cohort: finish("cohort", co),
    cash: finish("cash", ca),
    cache: {
      months: { cohort: cachedBy.cohort.length, cash: cachedBy.cash.length },
      closed_months: plan.months.length,
      refreshed_min: used[0] ?? null,
      refreshed_max: used[used.length - 1] ?? null,
      live,
    },
  };
}

/** The closed months a window touches (whole or partly) — what an owner's
 *  refresh recomputes (the current month is always live). */
export function refreshMonths(win: Pick<InsightsWindow, "from" | "to">, now: Date = new Date()): string[] {
  const todayMonth = monthStart(skopjeTodayYmd(now));
  const out: string[] = [];
  for (let m = monthStart(win.from); m <= win.to && out.length < 30; m = addDaysYmd(monthEnd(m), 1)) {
    if (m < todayMonth) out.push(m);
  }
  return out;
}
