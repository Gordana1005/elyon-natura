// ============================================================================
// Access LEVELS in the api (owner's decisions 02.10.2026; DB: 20260947001600_access_levels).
//
// One money level per person — app roles still decide the PAGES:
//   super_admin · owner · finance   everything: revenue, margins, purchase costs, profit, MEX cash
//                                   → can_see_margins(uid)
//   administrator                   revenue + returns company-wide; NO margins / purchase cost /
//                                   net profit / MEX cash tab → can_see_revenue(uid) (=
//                                   is_business_owner) without can_see_margins
//   dept_admin                      revenue + наплата + returns of THEIR departments only →
//                                   dept_scope(uid) = their cohort keys
//   everyone else                   unchanged (no company money)
//
// This file is the pure half: the department / team / MEX-account maps, the margin strips a
// revenue-but-not-margin viewer gets, and the department scoping of the insights payloads a
// dept_admin gets. Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// accessLevels.test.ts against it in Node, and index.ts imports it as ALV.
// A strip REMOVES keys (absent, never 0) and never mutates its input.
// ============================================================================

/** The seven departments (cohort keys) in the owner's display order. */
export const DEPT_KEYS = ["altercpa", "elyon_crm", "teleshop_out", "teleshop_other", "social", "web", "management"] as const;
export type DeptKey = (typeof DEPT_KEYS)[number];

/** Тим Центар's and Тим Маџари's departments (owner 02.10.2026). */
export const CENTAR_DEPTS: readonly DeptKey[] = ["teleshop_out", "teleshop_other", "social"];
export const MADZARI_DEPTS: readonly DeptKey[] = ["altercpa", "elyon_crm"];

/** The sales team (sales_teams.key / insights_people team_key) whose people sell for a
 *  department: Тим Центар = teleshop, Тим Маџари = affiliate, Менаџмент = management. The web
 *  shop has no team. */
export const TEAM_OF_DEPT: Record<DeptKey, string | null> = {
  altercpa: "affiliate", elyon_crm: "affiliate",
  teleshop_out: "teleshop", teleshop_other: "teleshop", social: "teleshop",
  web: null, management: "management",
};

/** The MEX account a department ships with (owner 29.09.2026): BIO NATURAL = Тим Маџари,
 *  NATURA = Тим Центар AND the web shop. Менаџмент has no account of its own. */
export const MEX_ACCOUNT_OF_DEPT: Record<DeptKey, "natura" | "bio_natural" | null> = {
  altercpa: "bio_natural", elyon_crm: "bio_natural",
  teleshop_out: "natura", teleshop_other: "natura", social: "natura", web: "natura",
  management: null,
};
export const MEX_ACCOUNTS = ["natura", "bio_natural"] as const;
export type MexAccount = (typeof MEX_ACCOUNTS)[number];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// ── the caller's scope ─────────────────────────────────────────────────────

/**
 * dept_scope(uid)'s answer → null (every department) or the known keys in display order.
 * Anything malformed (an error, a string) is the restrictive answer: [] (no department).
 */
export function parseDeptScope(raw: unknown): DeptKey[] | null {
  if (raw === null) return null;
  if (!Array.isArray(raw)) return [];
  return DEPT_KEYS.filter((k) => raw.includes(k));
}

/**
 * What the api serves a person, from the three gates:
 *   margins  — can_see_margins: everything
 *   revenue  — can_see_revenue (company-wide revenue + returns), no margins
 *   dept     — a dept_admin: revenue of `scope` only
 *   none     — no company money (today's manager / agent view)
 */
export type MoneyView =
  | { kind: "margins" }
  | { kind: "revenue" }
  | { kind: "dept"; scope: DeptKey[] }
  | { kind: "none" };

export function moneyViewOf(o: { margins: boolean; revenue: boolean; level: string | null; scope: DeptKey[] | null }): MoneyView {
  if (o.margins) return { kind: "margins" };
  if (o.revenue) return { kind: "revenue" };
  if (o.level === "dept_admin" && o.scope && o.scope.length) return { kind: "dept", scope: [...o.scope] };
  return { kind: "none" };
}

/** The departments a dept_admin's request may count: what was asked ∩ their scope; nothing in
 *  common (or nothing asked) → the whole scope. Display order. */
export function scopeSources(requested: readonly string[], scope: readonly string[]): DeptKey[] {
  const inScope = DEPT_KEYS.filter((k) => scope.includes(k));
  const both = inScope.filter((k) => requested.includes(k));
  return both.length ? both : inScope;
}

/** The sales teams of a scope (Тим Центар → teleshop, Тим Маџари → affiliate). */
export function teamsOfScope(scope: readonly string[]): string[] {
  const out: string[] = [];
  for (const k of DEPT_KEYS) {
    if (!scope.includes(k)) continue;
    const t = TEAM_OF_DEPT[k];
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The MEX accounts of a scope, in the tab's order (natura, bio_natural). */
export function mexAccountsOfScope(scope: readonly string[]): MexAccount[] {
  const want = new Set(scope.map((k) => MEX_ACCOUNT_OF_DEPT[k as DeptKey]).filter(Boolean));
  return MEX_ACCOUNTS.filter((a) => want.has(a));
}

// ── generic strips ─────────────────────────────────────────────────────────

/** Remove every key for which `drop(key)` is true, at any depth. */
export function dropKeysDeep<T>(v: T, drop: (key: string) => boolean): T {
  if (Array.isArray(v)) return v.map((x) => dropKeysDeep(x, drop)) as unknown as T;
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (drop(k)) continue;
      out[k] = dropKeysDeep(x, drop);
    }
    return out as T;
  }
  return v;
}

const MONEY_SUFFIX_RE = /(_mkd|_eur)$/;
/** Every *_mkd / *_eur key removed, at any depth. */
export const stripMoneyDeep = <T>(v: T): T => dropKeysDeep(v, (k) => MONEY_SUFFIX_RE.test(k));

// ── margin strips (revenue viewers: administrator; also a dept_admin) ──────

/** GET /agent-performance: profit is margin-class (it subtracts the purchase cost). */
export const AGENT_PERF_MARGIN_KEYS = new Set(["total_profit", "net_contribution", "profit_per_lead"]);
export const stripAgentPerformanceMargins = <T>(rows: T): T => dropKeysDeep(rows, (k) => AGENT_PERF_MARGIN_KEYS.has(k));

/** GET /management-insights: the profit / margin / cost blocks (top level) and any cost,
 *  profit or bonus key inside the rest (product cost_price, agents' bonus_paid, …). */
export const MI_MARGIN_BLOCKS = ["profit", "pure_profit", "margin_lab", "logistics", "channel_pl"] as const;
export const MI_MARGIN_KEYS = new Set([
  "cost_price", "bonus_paid", "profit", "total_profit", "net_contribution", "profit_per_lead",
  "cogs", "gross_profit", "gross_profit_from_cost", "clear_profit", "margin", "margin_pct", "unit_cost",
]);
export function stripManagementInsightsMargins(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if ((MI_MARGIN_BLOCKS as readonly string[]).includes(k)) continue;
    out[k] = dropKeysDeep(v, (x) => MI_MARGIN_KEYS.has(x));
  }
  const meta = isObj(out.meta) ? out.meta : {};
  out.meta = { ...meta, margins: false };
  return out;
}

/** GET /insights/returns: the courier round trip (return_cost_mkd / deliver_cost_mkd — the
 *  logistics loss, priced from the rate card) is margin-class. */
export function stripReturnsMargins(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...(body ?? {}) };
  if (isObj(out.kpis)) {
    const kpis = { ...out.kpis };
    delete kpis.round_trip;
    out.kpis = kpis;
  }
  return dropKeysDeep(out, (k) => k === "round_trip");
}

/** GET /insights/stock: the purchase cost and the stock value at cost. */
export const STOCK_MARGIN_KEYS = new Set(["cost_mkd", "stock_value_mkd", "valuation"]);
export const stripStockMargins = <T>(body: T): T => dropKeysDeep(body, (k) => STOCK_MARGIN_KEYS.has(k));

/** GET /shops/*: costs and margins (cost_mkd, group_cost_mkd, group_margin_mkd, shop_margin_mkd,
 *  avg_cost_mkd, value_cost_mkd, natura_cost_mkd, natura_margin_mkd — any *_mkd naming a cost or
 *  a margin) and any margin share. Sales and stock values at the shop's price stay. */
export const isShopsMarginKey = (k: string): boolean =>
  (/_mkd$/.test(k) && /(^|_)(cost|margin)(_|$)/.test(k)) || /(^|_)margin(_|$)/.test(k);
export const stripShopsMargins = <T>(body: T): T => dropKeysDeep(body, isShopsMarginKey);

/** /stock/v2/* for a revenue viewer: every money key EXCEPT a parcel's COD (cod_mkd is the
 *  buyer's price, revenue-class; everything else there is cost / value at cost). The key list
 *  is stockV2.ts STOCK_MONEY_KEYS + any *_mkd / *_eur. */
const STOCK_V2_MONEY = new Set(["cost_mkd", "value_mkd", "cod_mkd", "value_diff_mkd", "cost_price", "calc_buy_price", "cost_price_eur"]);
export const stockV2RevenueView = <T>(v: T): T =>
  dropKeysDeep(v, (k) => k !== "cod_mkd" && (STOCK_V2_MONEY.has(k) || MONEY_SUFFIX_RE.test(k)));

/** GET /dashboard-stats: the bonus a person earned is payout maths (margin-class here). */
export function stripDashboardMargins(body: Record<string, unknown>): Record<string, unknown> {
  const out = { ...(body ?? {}) };
  delete out.payout_earned;
  if (isObj(out.personalMetrics)) {
    const pm = { ...out.personalMetrics };
    delete pm.payout_earned;
    out.personalMetrics = pm;
  }
  return out;
}

/** GET /products suggested_price: the agents' default. Derived from the purchase cost (cost × 3)
 *  only for a margin viewer — for anyone else a product with no price gets the floor, so the
 *  number never reveals the cost. */
export function suggestedPrice(price: unknown, cost: unknown, margins: boolean, multiplier = 3, floor = 15): number {
  const p = Number(price || 0);
  if (p > 0) return p;
  return margins ? Math.max(Number(cost || 0) * multiplier, floor) : floor;
}

// ── dept_admin: the insights payloads scoped to their departments ──────────

/** The Overview for a dept_admin: the outer payload has already been stripped of money
 *  (stripOverviewMoney); the cohort is their departments' (with money). */
export function scopeOverviewMeta(body: Record<string, unknown>, scope: readonly string[]): Record<string, unknown> {
  const meta = isObj(body.meta) ? body.meta : {};
  return { ...body, meta: { ...meta, money: true, dept_scope: [...scope] } };
}

/** Any insights payload with `meta`: money on and the scope named. */
export function withDeptMeta(body: Record<string, unknown>, scope: readonly string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const meta = isObj(body.meta) ? body.meta : {};
  return { ...body, meta: { ...meta, money: true, dept_scope: [...scope], ...extra } };
}

/**
 * GET /insights/sales?part=core for a dept_admin.
 *   counts  the counts-only body (buildSalesResponse for a non-owner — no money anywhere)
 *   raw     the same RPC body WITH money (p_money true) — only its trend is read, per department
 *   cohort  insights_cohort for their departments, with money (+ prev when compared)
 * total / buckets / outside / by_source / quality / prev are the cohort's (they equal the sales
 * cohort's by construction); trend points keep only their departments (count and value summed
 * from those); channels and timing stay company-wide COUNTS (no department split exists there).
 */
export function scopeSalesCore(
  counts: Record<string, unknown>,
  raw: Record<string, unknown> | null,
  cohort: Record<string, unknown> | null,
  scope: readonly string[],
  compared: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...counts };
  const co = cohort ?? {};
  for (const k of ["total", "buckets", "outside", "by_source", "quality"] as const) {
    if (co[k] !== undefined) out[k] = co[k];
  }
  if (Array.isArray(out.by_source)) {
    out.by_source = (out.by_source as unknown[]).filter((r) => isObj(r) && scope.includes(String(r.key)));
  }
  const prev = isObj(co.prev) ? co.prev : null;
  out.prev = compared && prev && isObj(prev.total)
    ? { total: prev.total, buckets: Array.isArray(prev.buckets) ? prev.buckets : [], by_source: Array.isArray(prev.by_source) ? prev.by_source : [] }
    : null;
  const trend = raw && isObj(raw.trend) ? raw.trend : null;
  if (trend && Array.isArray(trend.points)) {
    out.trend = {
      ...(isObj(counts.trend) ? counts.trend : {}),
      points: (trend.points as unknown[]).filter(isObj).map((p) => {
        const bs = (Array.isArray(p.by_source) ? p.by_source : []).filter((r: unknown) => isObj(r) && scope.includes(String(r.key))) as Record<string, unknown>[];
        const point: Record<string, unknown> = { d: p.d, count: bs.reduce((s, r) => s + num(r.count), 0), by_source: bs };
        if (bs.some((r) => typeof r.value_mkd === "number")) point.value_mkd = bs.reduce((s, r) => s + num(r.value_mkd), 0);
        return point;
      }),
    };
  }
  if (out.channels !== undefined) out.channels = stripMoneyDeep(out.channels);
  if (out.timing !== undefined) out.timing = stripMoneyDeep(out.timing);
  return withDeptMeta(out, scope);
}

/** GET /insights/sales?part=detail for a dept_admin: products / cities / buyers / basket have no
 *  department split, so they stay the company's COUNTS — said so in meta. */
export function scopeSalesDetail(counts: Record<string, unknown>, scope: readonly string[]): Record<string, unknown> {
  const meta = isObj(counts.meta) ? counts.meta : {};
  return { ...stripMoneyDeep(counts), meta: { ...meta, money: false, dept_scope: [...scope], company_wide: true } };
}

/**
 * GET /insights/agents for a dept_admin (`raw` = the full RPC body with money, already wrapped by
 * buildPeopleResponse as an owner). Only the people and teams of their sales team(s) stay, with
 * money; the totals keep only their departments (sales / value / with- and without-person summed
 * from those) — cod / paid / prev / conversion have no department split and are left out; the
 * spark is the kept teams' (counts); "sales with no seller" only their departments'; a person
 * drill outside the team answers no detail.
 */
export function scopePeople(raw: Record<string, unknown>, scope: readonly string[], drilledPerson: string | null): Record<string, unknown> {
  const teams = teamsOfScope(scope);
  const inTeam = (r: unknown) => isObj(r) && teams.includes(String(r.team_key ?? r.key));
  const people = (Array.isArray(raw.people) ? raw.people : []).filter(inTeam) as Record<string, unknown>[];
  const keptTeams = (Array.isArray(raw.teams) ? raw.teams : []).filter((t) => isObj(t) && teams.includes(String(t.key))) as Record<string, unknown>[];
  const out: Record<string, unknown> = { ...raw, people, teams: keptTeams };

  const t = isObj(raw.totals) ? raw.totals : {};
  const bs = (Array.isArray(t.by_source) ? t.by_source : []).filter((r: unknown) => isObj(r) && scope.includes(String(r.key))) as Record<string, unknown>[];
  const sales = bs.reduce((s, r) => s + num(r.sales), 0);
  const value = bs.reduce((s, r) => s + num(r.value_mkd), 0);
  const withP = bs.reduce((s, r) => s + num(r.with_person), 0);
  const withPv = bs.reduce((s, r) => s + num(r.with_person_mkd), 0);
  const sumTeams = (k: string) => keptTeams.reduce((s, tm) => s + num(tm[k]), 0);
  out.totals = {
    sales,
    value_mkd: value,
    with_person: withP,
    with_person_mkd: withPv,
    without_person: Math.max(0, sales - withP),
    without_person_mkd: Math.max(0, value - withPv),
    by_source: bs,
    booked: sumTeams("booked"),
    worked: sumTeams("worked"),
    sale_decisions: sumTeams("sale_decisions"),
    cancel_decisions: sumTeams("cancel_decisions"),
    trash_decisions: sumTeams("trash_decisions"),
    callback_decisions: sumTeams("callback_decisions"),
    unmapped_decisions: 0,
  };

  const byDay = new Map<string, { d: string; sales: number; worked: number; sale_decisions: number }>();
  for (const tm of keptTeams) {
    for (const p of Array.isArray(tm.spark) ? tm.spark : []) {
      if (!isObj(p) || typeof p.d !== "string") continue;
      const e = byDay.get(p.d) ?? { d: p.d, sales: 0, worked: 0, sale_decisions: 0 };
      e.sales += num(p.sales); e.worked += num(p.worked); e.sale_decisions += num(p.sale_decisions);
      byDay.set(p.d, e);
    }
  }
  out.spark = [...byDay.values()].sort((a, b) => a.d.localeCompare(b.d));

  const ns = isObj(raw.no_seller) ? raw.no_seller : null;
  if (ns) {
    const reasons = (Array.isArray(ns.reasons) ? ns.reasons : []).filter((r: unknown) => isObj(r) && scope.includes(String(r.source))) as Record<string, unknown>[];
    out.no_seller = { ...ns, reasons, count: reasons.reduce((s, r) => s + num(r.count), 0), handles: [] };
  }

  if (drilledPerson && !people.some((p) => p.person_id === drilledPerson)) out.detail = null;
  return withDeptMeta(out, scope, { access: "dept" });
}

/**
 * GET /insights/mex-cash for a dept_admin: only the MEX account(s) of their departments
 * (Тим Маџари → BIO NATURAL, Тим Центар → NATURA — which also carries the web shop, said in
 * meta.account_note). `body` is the full response with money.
 */
export function scopeMexCash(body: Record<string, unknown>, scope: readonly string[]): Record<string, unknown> {
  const accounts = mexAccountsOfScope(scope);
  const drop = MEX_ACCOUNTS.filter((a) => !accounts.includes(a));
  const keep = (o: unknown): unknown => {
    if (!isObj(o)) return o;
    const x = { ...o };
    for (const a of drop) delete x[a];
    return x;
  };
  const out: Record<string, unknown> = { ...body };
  if (Array.isArray(out.days)) out.days = out.days.map(keep);
  if (Array.isArray(out.halves)) out.halves = out.halves.map(keep);
  if (isObj(out.total)) out.total = keep(out.total);
  if (isObj(out.now)) out.now = keep(out.now);
  return withDeptMeta(out, scope, {
    accounts,
    ...(accounts.includes("natura") ? { account_note: "natura_includes_web" } : {}),
  });
}

/** An /orders row outside a dept_admin's departments: no price, no line prices, no *_mkd /
 *  *_eur — and `value_hidden: true` so the list shows "—", never 0. */
const ORDER_PRICE_KEYS = new Set(["price", "actual_logistics_cost", "suggested_price"]);
const LINE_PRICE_KEYS = ["price_per_unit", "total_price"] as const;
export function hideOrderValue<T extends Record<string, unknown>>(row: T): T {
  const x: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    if (ORDER_PRICE_KEYS.has(k) || MONEY_SUFFIX_RE.test(k)) continue;
    x[k] = v;
  }
  if (Array.isArray(row?.order_items)) {
    x.order_items = (row.order_items as Record<string, unknown>[]).map((it) => {
      const y: Record<string, unknown> = { ...it };
      for (const k of LINE_PRICE_KEYS) delete y[k];
      return y;
    });
  }
  x.value_hidden = true;
  return x as T;
}

/** The /orders page for a dept_admin: rows whose department (order_departments) is outside the
 *  scope lose their value; a row with no known department too (fail-closed). */
export function scopeOrderValues<T extends Record<string, unknown>>(rows: readonly T[], scope: readonly string[]): T[] {
  return rows.map((r) => (typeof r.department === "string" && scope.includes(r.department) ? r : hideOrderValue(r)));
}

/** GET /operations-center for a dept_admin: their departments' sales today (count + value) from
 *  the scoped cohort, beside the company's counts. */
export function scopeOperationsKpi(kpi: Record<string, unknown>, scopedCohort: Record<string, unknown> | null, scope: readonly string[]): Record<string, unknown> {
  const out = { ...kpi };
  delete out.sales_value_today_mkd;
  delete out.collected_value_today_mkd;
  const total = scopedCohort && isObj(scopedCohort.total) ? scopedCohort.total : null;
  out.dept_scope = [...scope];
  out.dept_sales_today = total ? num(total.count) : null;
  if (total && typeof total.value_mkd === "number") out.sales_value_today_mkd = total.value_mkd;
  return out;
}
