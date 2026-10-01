// ============================================================================
// AlterCPA 30% guarantee — the pure model behind GET /api/altercpa/guarantee/*
// (plan 01.10.2026, Фаза 3–5). Dependency-free: unit-tested in
// altercpaGuarantee.test.ts; index.ts only fetches and calls these.
//
// Owner decision 01.10.2026: rate = (approved + cancel_other) ÷ ALL Macedonian
// leads, target 30%. Test leads are excluded and shown apart. The read model is
// migration 20260944000210 (altercpa_guarantee_base / _rates / _open / _journal);
// the alert sweep is 20260944000300 — alertDecisions() below is its twin.
//
//   N  leads (not test)      C  counted = approved + cancel_other
//   O  open (no decision)    required = ceil(target·N/100) — integer arithmetic,
//                            never 0.3·N in floating point
//   need = max(0, required − C)   reachable = need ≤ O
//   cancellable = max(0, O − need)   margin = C − required when C ≥ required
//
// Managers are not owners: nothing here carries money.
// ============================================================================

export const GUARANTEE_DECISIONS = ["approved", "cancel_other", "cancelled", "trashed", "open"] as const;
export type GuaranteeDecision = (typeof GUARANTEE_DECISIONS)[number];

export const GUARANTEE_SETTING_KEYS = [
  "altercpa_rate_target_pct",
  "altercpa_rate_min_cohort",
  "altercpa_rate_settle_days",
  "altercpa_rate_geo",
  "altercpa_rate_excluded_webmasters",
  "altercpa_rate_digest_hour",
] as const;

export interface GuaranteeSettings {
  /** The guaranteed % (30). */
  target: number;
  /** No verdict below this many (non-test) leads. */
  minCohort: number;
  /** A cohort is final this many days after its arrival day. */
  settleDays: number;
  geo: string;
  excludedWebmasters: string[];
  digestHour: number;
}

export const DEFAULT_GUARANTEE_SETTINGS: GuaranteeSettings = {
  target: 30, minCohort: 20, settleDays: 3, geo: "MK", excludedWebmasters: [], digestHour: 18,
};

const unwrap = (v: unknown): unknown => (typeof v === "string" ? v.replace(/^"+|"+$/g, "") : v);
const finite = (v: unknown, d: number): number => {
  const n = Number(unwrap(v));
  return Number.isFinite(n) ? n : d;
};

/** app_settings rows → settings, with the defaults of 20260922000000 / 20260944000210. */
export function parseGuaranteeSettings(rows: Array<{ key: string; value: unknown }> | null | undefined): GuaranteeSettings {
  const get = (k: string) => (rows || []).find((r) => r?.key === k)?.value;
  const d = DEFAULT_GUARANTEE_SETTINGS;
  const ex = get("altercpa_rate_excluded_webmasters");
  const geo = String(unwrap(get("altercpa_rate_geo")) ?? "").trim();
  const hour = Math.trunc(finite(get("altercpa_rate_digest_hour"), d.digestHour));
  return {
    target: Math.min(100, Math.max(1, finite(get("altercpa_rate_target_pct"), d.target))),
    minCohort: Math.max(1, Math.trunc(finite(get("altercpa_rate_min_cohort"), d.minCohort))),
    settleDays: Math.max(1, Math.trunc(finite(get("altercpa_rate_settle_days"), d.settleDays))),
    geo: geo || d.geo,
    excludedWebmasters: Array.isArray(ex) ? ex.map((x) => String(x)).filter(Boolean) : [],
    digestHour: hour >= 0 && hour <= 23 ? hour : d.digestHour,
  };
}

// ── the arithmetic ──────────────────────────────────────────────────────────

/** ceil(target·leads/100) with integers only: 30 × 70 → 21, 30 × 157 → 48. */
export function requiredConfirms(leads: number, target: number): number {
  const n = Math.max(0, Math.floor(Number(leads) || 0));
  const t = Math.round(Math.max(0, Number(target) || 0) * 100); // hundredths of a percent
  const num = t * n;
  const den = 10_000;
  return Math.floor(num / den) + (num % den === 0 ? 0 : 1);
}

export interface CohortCounts { leads: number; counted: number; open: number }

export interface GuaranteeMath {
  leads: number;
  counted: number;
  open: number;
  target: number;
  /** C / N as a fraction (0.355), null when N = 0. */
  rate: number | null;
  required: number;
  /** More confirmations needed to reach the target (0 when there). */
  need: number;
  /** The open leads can still carry the cohort to the target. */
  reachable: boolean;
  /** need − O when unreachable, else 0. */
  shortfall: number;
  /** (C + O) / N — the best this cohort can still end at. */
  maxRate: number | null;
  /** Open leads that may be cancelled and the target still holds. */
  cancellable: number;
  /** C − required when at or over the target, else null. */
  margin: number | null;
  /** Confirmations needed per 10 new leads to hold the target (3 at 30%). */
  per10: number;
}

export function guaranteeMath(c: CohortCounts, target: number): GuaranteeMath {
  const leads = Math.max(0, Math.floor(Number(c.leads) || 0));
  const counted = Math.max(0, Math.floor(Number(c.counted) || 0));
  const open = Math.max(0, Math.floor(Number(c.open) || 0));
  const required = requiredConfirms(leads, target);
  const need = Math.max(0, required - counted);
  const reachable = need <= open;
  return {
    leads, counted, open, target,
    rate: leads > 0 ? counted / leads : null,
    required,
    need,
    reachable,
    shortfall: reachable ? 0 : need - open,
    maxRate: leads > 0 ? (counted + open) / leads : null,
    cancellable: Math.max(0, open - need),
    margin: counted >= required ? counted - required : null,
    per10: Math.round(target) / 10,
  };
}

export type CohortState = "settling" | "too_few" | "below" | "met" | "stuck";

/**
 * too_few  N < min_cohort (never judged, never alarmed)
 * stuck    open leads older than settle_days — the cohort cannot close
 * met      C ≥ required
 * settling younger than settle_days, under target, still has open leads
 * below    under target with nothing left open
 */
export function cohortState(c: CohortCounts, ageDays: number, s: Pick<GuaranteeSettings, "target" | "minCohort" | "settleDays">): CohortState {
  if ((Number(c.leads) || 0) < s.minCohort) return "too_few";
  if ((Number(c.open) || 0) > 0 && ageDays >= s.settleDays) return "stuck";
  const m = guaranteeMath(c, s.target);
  if (m.need === 0) return "met";
  if (m.open > 0) return "settling";
  return "below";
}

/** Unreachable first (by shortfall), then below / stuck / settling by need, then met by margin, then too few. */
export function riskRank(v: { state: CohortState; math: GuaranteeMath }): number {
  if (v.state !== "too_few" && !v.math.reachable) return 0;
  switch (v.state) {
    case "below": return 1;
    case "stuck": return 2;
    case "settling": return 3;
    case "met": return 4;
    default: return 5;
  }
}

export function riskOrder<T extends { state: CohortState; math: GuaranteeMath; webmaster?: string | null }>(a: T, b: T): number {
  const ra = riskRank(a);
  const rb = riskRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0 && a.math.shortfall !== b.math.shortfall) return b.math.shortfall - a.math.shortfall;
  if (ra <= 3 && a.math.need !== b.math.need) return b.math.need - a.math.need;
  if (ra === 4 && (a.math.margin ?? 0) !== (b.math.margin ?? 0)) return (a.math.margin ?? 0) - (b.math.margin ?? 0);
  if (a.math.leads !== b.math.leads) return b.math.leads - a.math.leads;
  return String(a.webmaster ?? "").localeCompare(String(b.webmaster ?? ""));
}

// ── Skopje days ────────────────────────────────────────────────────────────

const YMD = /^\d{4}-\d{2}-\d{2}$/;
export const isYmd = (s: unknown): s is string => {
  if (typeof s !== "string" || !YMD.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** Today on the Europe/Skopje calendar. */
export function skopjeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Skopje", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** The Skopje wall-clock hour (0–23). */
export function skopjeHour(now: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Skopje", hour: "2-digit", hourCycle: "h23" }).format(now);
  return Number(h) % 24;
}

/** Calendar arithmetic on a YYYY-MM-DD (no timezone can shift it). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export const MAX_RANGE_DAYS = 92;

/**
 * ?from&to → an inclusive Skopje-day range: a missing / bad day falls back
 * (to = today, from = to − (defaultDays − 1)), a reversed pair is swapped,
 * nothing runs past today, and the span is capped at maxDays (the start moves).
 */
export function parseDayRange(
  from: string | null | undefined,
  to: string | null | undefined,
  today: string,
  opts: { defaultDays?: number; maxDays?: number } = {},
): { from: string; to: string } {
  const def = Math.max(1, opts.defaultDays ?? 14);
  const max = Math.max(1, opts.maxDays ?? MAX_RANGE_DAYS);
  let t = isYmd(to) ? to : today;
  let f = isYmd(from) ? from : addDays(t, -(def - 1));
  if (f > t) [f, t] = [t, f];
  if (t > today) t = today;
  if (f > today) f = today;
  if (daysBetween(f, t) > max - 1) f = addDays(t, -(max - 1));
  return { from: f, to: t };
}

/** ?day&back for the Денес tab: day defaults to today (never after it), back 0–6 (default 2). */
export function parseTodayQuery(sp: URLSearchParams, today: string): { day: string; back: number } {
  const raw = sp.get("day");
  let day = isYmd(raw) ? raw : today;
  if (day > today) day = today;
  const b = Number(sp.get("back"));
  const back = Number.isFinite(b) && sp.get("back") !== null && sp.get("back") !== "" ? Math.min(6, Math.max(0, Math.trunc(b))) : 2;
  return { day, back };
}

export interface JournalQuery {
  from: string;
  to: string;
  wm: string | null;
  stream: string | null;
  offer: string | null;
  decision: GuaranteeDecision | null;
  q: string | null;
  includeTest: boolean;
  page: number;
  limit: number;
  offset: number;
}

const cleanText = (v: string | null, max: number) => {
  const s = (v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** ?from&to&wm&stream&offer&decision&q&test=1&page&limit for the Лидови tab (default today, ≤ 92 days, ≤ 100 a page). */
export function parseJournalQuery(sp: URLSearchParams, today: string): JournalQuery {
  const { from, to } = parseDayRange(sp.get("from"), sp.get("to"), today, { defaultDays: 1 });
  const d = sp.get("decision");
  const decision = (GUARANTEE_DECISIONS as readonly string[]).includes(d ?? "") ? (d as GuaranteeDecision) : null;
  const lim = Math.trunc(Number(sp.get("limit")));
  const limit = Number.isFinite(lim) && lim >= 1 ? Math.min(100, lim) : 50;
  const pg = Math.trunc(Number(sp.get("page")));
  const page = Number.isFinite(pg) && pg >= 1 ? Math.min(pg, 10_000) : 1;
  const t = sp.get("test");
  return {
    from, to,
    wm: cleanText(sp.get("wm"), 120),
    stream: cleanText(sp.get("stream"), 120),
    offer: cleanText(sp.get("offer"), 200),
    decision,
    q: cleanText(sp.get("q"), 80),
    includeTest: t === "1" || t === "true",
    page, limit,
    offset: (page - 1) * limit,
  };
}

// ── rows from the RPCs ──────────────────────────────────────────────────────

export type RateGrain = "day" | "webmaster" | "stream" | "offer";

export interface RateRow {
  grain: RateGrain;
  day: string;
  webmaster: string | null;
  stream: string | null;
  offer_name: string | null;
  leads: number;
  test_excluded: number;
  approved: number;
  cancel_other: number;
  cancelled: number;
  trashed: number;
  open: number;
  counted: number;
  mex_shipped: number;
  crm_sticky: number;
}

export interface OpenLeadRow {
  lead_id: string;
  altercpa_id: string | null;
  day: string;
  arrived_at: string;
  webmaster: string;
  stream: string;
  offer_name: string;
  customer_name: string | null;
  order_id: string | null;
  display_id: string | null;
  crm_status: string | null;
  mex_status_id: number | null;
  mex_tracking_id: string | null;
}

export interface Freshness {
  leads_seen_at: string | null;
  decisions_seen_at: string | null;
  newest_arrival_at: string | null;
}

const COUNT_KEYS = ["leads", "test_excluded", "approved", "cancel_other", "cancelled", "trashed", "open", "counted", "mex_shipped", "crm_sticky"] as const;
type CountKey = (typeof COUNT_KEYS)[number];
export type Counts = Record<CountKey, number>;

const zeroCounts = (): Counts => Object.fromEntries(COUNT_KEYS.map((k) => [k, 0])) as Counts;
const countsOf = (r: Partial<RateRow> | null | undefined): Counts => {
  const c = zeroCounts();
  if (r) for (const k of COUNT_KEYS) c[k] = Math.max(0, Math.floor(Number((r as Record<string, unknown>)[k]) || 0));
  return c;
};

export interface CohortView extends Counts {
  day: string;
  age_days: number;
  state: CohortState;
  math: GuaranteeMath;
  oldest_open_at: string | null;
}

export interface OpenLeadView {
  lead_id: string;
  altercpa_id: string | null;
  day: string;
  arrived_at: string;
  age_min: number;
  webmaster: string;
  stream: string;
  offer_name: string;
  customer_name: string | null;
  order_id: string | null;
  display_id: string | null;
  crm_status: string | null;
  mex_status_id: number | null;
  mex_tracking_id: string | null;
  /** The CRM already counts it a sale; AlterCPA has not decided yet. */
  crm_confirmed: boolean;
}

export interface WebmasterView extends CohortView {
  webmaster: string;
  open_leads?: OpenLeadView[];
}

export interface BreakdownRow extends Counts {
  key: string;
  rate: number | null;
}

export interface WebmasterRatesView extends CohortView {
  webmaster: string;
  streams: BreakdownRow[];
  offers: BreakdownRow[];
}

const CRM_SALE = new Set(["confirmed", "shipped", "delivered", "paid", "returned"]);

function cohortView(day: string, counts: Counts, today: string, s: GuaranteeSettings, oldestOpen: string | null = null): CohortView {
  const age = Math.max(0, daysBetween(day, today));
  const c = { leads: counts.leads, counted: counts.counted, open: counts.open };
  return {
    day, ...counts, age_days: age,
    state: cohortState(c, age, s),
    math: guaranteeMath(c, s.target),
    oldest_open_at: oldestOpen,
  };
}

function openLeadView(r: OpenLeadRow, nowMs: number, maskName: ((v: unknown) => string) | null): OpenLeadView {
  const at = Date.parse(r.arrived_at);
  return {
    lead_id: r.lead_id,
    altercpa_id: r.altercpa_id ?? null,
    day: r.day,
    arrived_at: r.arrived_at,
    age_min: Number.isFinite(at) ? Math.max(0, Math.floor((nowMs - at) / 60_000)) : 0,
    webmaster: r.webmaster ?? "(none)",
    stream: r.stream ?? "(none)",
    offer_name: r.offer_name ?? "(blank)",
    customer_name: r.customer_name == null ? null : maskName ? maskName(r.customer_name) : r.customer_name,
    order_id: r.order_id ?? null,
    display_id: r.display_id ?? null,
    crm_status: r.crm_status ?? null,
    mex_status_id: r.mex_status_id ?? null,
    mex_tracking_id: r.mex_tracking_id ?? null,
    crm_confirmed: CRM_SALE.has(String(r.crm_status ?? "")),
  };
}

const settingsMeta = (s: GuaranteeSettings) => ({
  target: s.target,
  min_cohort: s.minCohort,
  settle_days: s.settleDays,
  geo: s.geo,
  per10: Math.round(s.target) / 10,
  excluded_webmasters: s.excludedWebmasters,
});

// ── GET /altercpa/guarantee/today ───────────────────────────────────────────

export interface TodayInput {
  day: string;
  today: string;
  back: number;
  rates: RateRow[];
  /** Open leads of `day` (altercpa_guarantee_open(day, day)). */
  open: OpenLeadRow[];
  /** Open leads of cohorts at least settle_days old (today − 30 … today − settle_days). */
  stuckOpen: OpenLeadRow[];
  stuckLimit?: number;
  freshness: Freshness | null;
  settings: GuaranteeSettings;
  now: Date;
  /** Masks the customer name for a viewer without the name privilege; null = show. */
  maskName?: ((v: unknown) => string) | null;
}

export function buildToday(input: TodayInput) {
  const { day, today, back, settings: s } = input;
  const nowMs = input.now.getTime();
  const mask = input.maskName ?? null;
  const rows = input.rates || [];

  const openViews = (input.open || [])
    .filter((r) => r.day === day)
    .map((r) => openLeadView(r, nowMs, mask))
    .sort((a, b) => a.arrived_at.localeCompare(b.arrived_at));
  const openByWm = new Map<string, OpenLeadView[]>();
  for (const o of openViews) {
    const list = openByWm.get(o.webmaster) ?? [];
    list.push(o);
    openByWm.set(o.webmaster, list);
  }

  const dayTotals = (d: string, oldest: string | null = null) =>
    cohortView(d, countsOf(rows.find((r) => r.grain === "day" && r.day === d)), today, s, oldest);

  const webmastersOf = (d: string, withOpen: boolean): WebmasterView[] =>
    rows
      .filter((r) => r.grain === "webmaster" && r.day === d)
      .map((r) => {
        const wm = r.webmaster ?? "(none)";
        const open = withOpen ? openByWm.get(wm) ?? [] : undefined;
        const v: WebmasterView = { webmaster: wm, ...cohortView(d, countsOf(r), today, s, open?.[0]?.arrived_at ?? null) };
        if (withOpen) v.open_leads = open;
        return v;
      })
      .sort(riskOrder);

  const previous = [];
  for (let i = 1; i <= back; i++) {
    const d = addDays(day, -i);
    previous.push({ day: d, totals: dayTotals(d), webmasters: webmastersOf(d, false) });
  }

  const stuck = (input.stuckOpen || []).filter((r) => daysBetween(r.day, today) >= s.settleDays);
  const byDay = new Map<string, number>();
  for (const r of stuck) byDay.set(r.day, (byDay.get(r.day) ?? 0) + 1);

  return {
    meta: {
      day, today, back,
      generated_at: input.now.toISOString(),
      ...settingsMeta(s),
    },
    freshness: input.freshness ?? { leads_seen_at: null, decisions_seen_at: null, newest_arrival_at: null },
    totals: dayTotals(day, openViews[0]?.arrived_at ?? null),
    webmasters: webmastersOf(day, true),
    previous,
    stuck: {
      count: stuck.length,
      capped: stuck.length >= (input.stuckLimit ?? 500),
      oldest_arrived_at: stuck.length ? stuck.reduce((m, r) => (r.arrived_at < m ? r.arrived_at : m), stuck[0].arrived_at) : null,
      from: stuck.length ? [...byDay.keys()].sort()[0] : null,
      to: addDays(today, -s.settleDays),
      by_day: [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([d, n]) => ({ day: d, open: n })),
    },
  };
}

export type TodayPayload = ReturnType<typeof buildToday>;

// ── GET /altercpa/guarantee/rates ───────────────────────────────────────────

function breakdown(rows: RateRow[], key: (r: RateRow) => string | null): BreakdownRow[] {
  return rows
    .map((r) => {
      const c = countsOf(r);
      return { key: key(r) ?? "(none)", ...c, rate: c.leads > 0 ? c.counted / c.leads : null };
    })
    .sort((a, b) => b.leads - a.leads || a.key.localeCompare(b.key));
}

export interface RatesInput {
  from: string;
  to: string;
  today: string;
  rates: RateRow[];
  settings: GuaranteeSettings;
  now?: Date;
}

export function buildRates(input: RatesInput) {
  const { from, to, today, settings: s } = input;
  const rows = input.rates || [];
  const days: string[] = [];
  for (let d = to; d >= from; d = addDays(d, -1)) days.push(d);

  const wmTotals = new Map<string, number>();
  for (const r of rows) {
    if (r.grain === "webmaster" && r.webmaster) wmTotals.set(r.webmaster, (wmTotals.get(r.webmaster) ?? 0) + (Number(r.leads) || 0) + (Number(r.test_excluded) || 0));
  }

  const dayViews = days.map((d) => {
    const totals = cohortView(d, countsOf(rows.find((r) => r.grain === "day" && r.day === d)), today, s);
    const webmasters: WebmasterRatesView[] = rows
      .filter((r) => r.grain === "webmaster" && r.day === d)
      .map((r) => {
        const wm = r.webmaster ?? "(none)";
        return {
          webmaster: wm,
          ...cohortView(d, countsOf(r), today, s),
          streams: breakdown(rows.filter((x) => x.grain === "stream" && x.day === d && x.webmaster === wm), (x) => x.stream),
          offers: breakdown(rows.filter((x) => x.grain === "offer" && x.day === d && x.webmaster === wm), (x) => x.offer_name),
        };
      })
      .sort((a, b) => b.leads - a.leads || a.webmaster.localeCompare(b.webmaster));
    return { day: d, age_days: totals.age_days, settled: totals.age_days >= s.settleDays, totals, webmasters };
  });

  const sum = (list: CohortView[], k: CountKey) => list.reduce((acc, v) => acc + v[k], 0);
  const allTotals = dayViews.map((d) => d.totals);
  const settledTotals = dayViews.filter((d) => d.settled).map((d) => d.totals);
  const judged = dayViews.filter((d) => d.settled).flatMap((d) => d.webmasters).filter((w) => w.leads >= s.minCohort);
  const rate = (c: number, n: number) => (n > 0 ? c / n : null);
  const allLeads = sum(allTotals, "leads");
  const settledLeads = sum(settledTotals, "leads");

  return {
    meta: { from, to, today, generated_at: (input.now ?? new Date()).toISOString(), ...settingsMeta(s) },
    webmasters: [...wmTotals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([webmaster, leads]) => ({ webmaster, leads })),
    days: dayViews,
    summary: {
      settled_days: settledTotals.length,
      settled: { leads: settledLeads, counted: sum(settledTotals, "counted"), rate: rate(sum(settledTotals, "counted"), settledLeads) },
      all: {
        leads: allLeads,
        counted: sum(allTotals, "counted"),
        open: sum(allTotals, "open"),
        rate: rate(sum(allTotals, "counted"), allLeads),
        math: guaranteeMath({ leads: allLeads, counted: sum(allTotals, "counted"), open: sum(allTotals, "open") }, s.target),
      },
      cohorts_judged: judged.length,
      days_under: judged.filter((w) => w.math.need > 0).length,
      test_excluded: sum(allTotals, "test_excluded"),
      crm_sticky: { counted: sum(allTotals, "crm_sticky"), leads: allLeads, rate: rate(sum(allTotals, "crm_sticky"), allLeads) },
      mex_shipped: { count: sum(allTotals, "mex_shipped"), rate: rate(sum(allTotals, "mex_shipped"), allLeads) },
    },
  };
}

export type RatesPayload = ReturnType<typeof buildRates>;

// ── GET /altercpa/guarantee/leads ───────────────────────────────────────────

export interface JournalRow {
  lead_id: string;
  altercpa_id: string | null;
  day: string;
  arrived_at: string;
  webmaster: string;
  stream: string;
  offer_name: string;
  offer_ext_id: string | null;
  decision: Exclude<GuaranteeDecision, "open"> | null;
  reason: number | null;
  decided_at: string | null;
  decided_by_altercpa_user: number | null;
  operator_name: string | null;
  order_id: string | null;
  display_id: string | null;
  crm_status: string | null;
  mex_status_id: number | null;
  mex_tracking_id: string | null;
  customer_name: string | null;
  phone_raw: string | null;
  is_test: boolean;
  mex_shipped: boolean;
}

/** The PII masker of index.ts, injected (maskNameValue / maskPhoneValue + the viewer's flags). */
export function maskJournalRow<T extends Partial<JournalRow>>(
  row: T,
  flags: { name: boolean; phone: boolean },
  maskers: { name: (v: unknown) => string; phone: (v: unknown) => string },
): T {
  const x: T = { ...row };
  if (!flags.name && x.customer_name != null) x.customer_name = maskers.name(x.customer_name);
  if (!flags.phone && x.phone_raw != null) x.phone_raw = maskers.phone(x.phone_raw);
  return x;
}

// ── the /altercpa mirror summary for a non-owner (money stripped) ──────────

/** Every key a non-owner may receive from altercpa_summary; anything else (revenue_eur and any later money) is dropped. */
const SUMMARY_KEYS = new Set([
  "totals", "geos", "offers", "webmasters",
  "leads", "mirrored", "ledger_only", "approved", "priced", "unpriced",
  "geo", "currencies", "offer", "mapped", "webmaster",
]);
const MONEY_KEY_RE = /(_eur|_mkd)$/;

export function stripSummaryMoney(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSummaryMoney);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (!SUMMARY_KEYS.has(k) || MONEY_KEY_RE.test(k)) continue;
      out[k] = k === "currencies" ? x : stripSummaryMoney(x);
    }
    return out;
  }
  return v;
}

/** The explicit column list of GET /altercpa/leads (no payload; prices only for owners). */
export function mirrorLeadColumns(isOwner: boolean): string {
  const base = [
    "id", "account_id", "altercpa_id", "order_id", "geo", "offer_name", "offer_ext_id", "product_id", "webmaster",
    "phase", "status", "reason", "phase_seen_at", "created_remote", "phone_raw", "phone_e164", "customer_name", "city",
    "quantity", "skip_reason", "first_seen_at", "last_seen_at", "decision", "decided_by_altercpa_user", "decided_at",
  ];
  if (isOwner) base.push("price_raw", "currency_raw", "price_eur");
  return `${base.join(", ")}, orders(display_id, status)`;
}

// ── 20260944000300's twin: which alerts the hourly sweep fires ─────────────

export type AlertKind = "digest" | "unreachable" | "verdict_close" | "verdict_final";

export interface AlertCohort { day: string; webmaster: string; leads: number; counted: number; open: number }

export interface AlertDecision {
  kind: AlertKind;
  /** '*' for the digest (one notification for all webmasters). */
  webmaster: string;
  day: string;
  items?: Array<{ webmaster: string; rate: number | null; need: number; open: number }>;
}

/**
 * The rules of altercpa_guarantee_sweep() (20260944000300), at the local hour:
 *   digest        at digestHour — once, only if some webmaster of TODAY with N ≥ min
 *                 still needs confirmations; lists them by need, largest first
 *   unreachable   12–20 h — TODAY, N ≥ min, C + O < required (once a day per webmaster)
 *   verdict_close 21 h — TODAY, N ≥ min, under target
 *   verdict_final 10 h — the cohort settle_days old, N ≥ min, still under target
 * The ledger (altercpa_rate_alerts) makes each fire once; this twin ignores it.
 */
export function alertDecisions(input: { hour: number; today: string; cohorts: AlertCohort[]; settings: GuaranteeSettings }): AlertDecision[] {
  const { hour, today, settings: s } = input;
  const judged = (day: string) =>
    (input.cohorts || [])
      .filter((c) => c.day === day && c.leads >= s.minCohort)
      .map((c) => ({ c, m: guaranteeMath(c, s.target) }));
  const out: AlertDecision[] = [];

  if (hour >= 12 && hour <= 20) {
    for (const { c, m } of judged(today)) if (!m.reachable) out.push({ kind: "unreachable", webmaster: c.webmaster, day: today });
  }
  if (hour === s.digestHour) {
    const items = judged(today)
      .filter(({ m }) => m.need > 0)
      .sort((a, b) => b.m.need - a.m.need || a.c.webmaster.localeCompare(b.c.webmaster))
      .map(({ c, m }) => ({ webmaster: c.webmaster, rate: m.rate, need: m.need, open: m.open }));
    if (items.length) out.push({ kind: "digest", webmaster: "*", day: today, items });
  }
  if (hour === 21) {
    for (const { c, m } of judged(today)) if (m.need > 0) out.push({ kind: "verdict_close", webmaster: c.webmaster, day: today });
  }
  if (hour === 10) {
    const d = addDays(today, -s.settleDays);
    for (const { c, m } of judged(d)) if (m.need > 0) out.push({ kind: "verdict_final", webmaster: c.webmaster, day: d });
  }
  return out;
}
