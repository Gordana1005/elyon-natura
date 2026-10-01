/**
 * /altercpa — the AlterCPA 30% guarantee (plan 01.10.2026, Фаза 3–4).
 *
 *   GET /altercpa/guarantee/today?day=&back=   the Денес tab
 *   GET /altercpa/guarantee/rates?from&to      the Стапки tab (≤ 92 Skopje days)
 *   GET /altercpa/guarantee/leads?…            the Лидови tab (one page, PII masked by the server)
 *
 * Rate = (approved + cancel_other) ÷ every Macedonian lead; test leads apart.
 * Counts only — no money in any payload (managers are not owners). The shapes
 * mirror supabase/functions/api/altercpaGuarantee.ts (buildToday / buildRates).
 */
import { apiFetch } from './api';

export const GUARANTEE_DECISIONS = ['approved', 'cancel_other', 'cancelled', 'trashed', 'open'] as const;
export type GuaranteeDecision = (typeof GUARANTEE_DECISIONS)[number];
export type CohortState = 'settling' | 'too_few' | 'below' | 'met' | 'stuck';

export interface GuaranteeMath {
  leads: number;
  counted: number;
  open: number;
  target: number;
  /** C / N as a fraction, null when N = 0. */
  rate: number | null;
  required: number;
  need: number;
  reachable: boolean;
  shortfall: number;
  maxRate: number | null;
  cancellable: number;
  margin: number | null;
  per10: number;
}

export interface GuaranteeCounts {
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

export interface CohortView extends GuaranteeCounts {
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
  crm_confirmed: boolean;
}

export interface WebmasterView extends CohortView {
  webmaster: string;
  open_leads?: OpenLeadView[];
}

export interface BreakdownRow extends GuaranteeCounts {
  key: string;
  rate: number | null;
}

export interface WebmasterRatesView extends CohortView {
  webmaster: string;
  streams: BreakdownRow[];
  offers: BreakdownRow[];
}

export interface GuaranteeMeta {
  target: number;
  min_cohort: number;
  settle_days: number;
  geo: string;
  per10: number;
  excluded_webmasters: string[];
  generated_at: string;
}

export interface TodayPayload {
  meta: GuaranteeMeta & { day: string; today: string; back: number };
  freshness: { leads_seen_at: string | null; decisions_seen_at: string | null; newest_arrival_at: string | null };
  totals: CohortView;
  webmasters: WebmasterView[];
  previous: Array<{ day: string; totals: CohortView; webmasters: WebmasterView[] }>;
  stuck: {
    count: number;
    capped: boolean;
    oldest_arrived_at: string | null;
    from: string | null;
    to: string;
    by_day: Array<{ day: string; open: number }>;
  };
}

export interface RatesDay {
  day: string;
  age_days: number;
  settled: boolean;
  totals: CohortView;
  webmasters: WebmasterRatesView[];
}

export interface RatesPayload {
  meta: GuaranteeMeta & { from: string; to: string; today: string };
  webmasters: Array<{ webmaster: string; leads: number }>;
  days: RatesDay[];
  summary: {
    settled_days: number;
    settled: { leads: number; counted: number; rate: number | null };
    all: { leads: number; counted: number; open: number; rate: number | null; math: GuaranteeMath };
    cohorts_judged: number;
    days_under: number;
    test_excluded: number;
    crm_sticky: { counted: number; leads: number; rate: number | null };
    mex_shipped: { count: number; rate: number | null };
  };
}

export interface JournalRow {
  lead_id: string;
  altercpa_id: string | null;
  day: string;
  arrived_at: string;
  webmaster: string;
  stream: string;
  offer_name: string;
  offer_ext_id: string | null;
  decision: Exclude<GuaranteeDecision, 'open'> | null;
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

export interface JournalPayload {
  from: string;
  to: string;
  page: number;
  limit: number;
  total: number;
  rows: JournalRow[];
}

export interface JournalParams {
  from: string;
  to: string;
  wm?: string | null;
  stream?: string | null;
  offer?: string | null;
  decision?: GuaranteeDecision | null;
  q?: string | null;
  test?: boolean;
  page?: number;
  limit?: number;
}

const qs = (o: Record<string, string | number | boolean | null | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    sp.set(k, v === true ? '1' : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

export const apiGetGuaranteeToday = (p: { day?: string; back?: number } = {}): Promise<TodayPayload> =>
  apiFetch(`altercpa/guarantee/today${qs({ day: p.day, back: p.back })}`);

export const apiGetGuaranteeRates = (from: string, to: string): Promise<RatesPayload> =>
  apiFetch(`altercpa/guarantee/rates${qs({ from, to })}`);

export const apiGetGuaranteeLeads = (p: JournalParams): Promise<JournalPayload> =>
  apiFetch(`altercpa/guarantee/leads${qs({
    from: p.from, to: p.to, wm: p.wm, stream: p.stream, offer: p.offer, decision: p.decision,
    q: p.q, test: p.test, page: p.page, limit: p.limit,
  })}`);

/** i18n key segment of a decision: `cancel_other` would read as an i18next plural form. */
export const decisionKey = (d: GuaranteeDecision | null | undefined): string =>
  d == null || d === 'open' ? 'open' : d === 'cancel_other' ? 'cancelOther' : d;
