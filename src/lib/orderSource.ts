import type { TFunction } from 'i18next';

/**
 * How an order's `source_type` is rendered, in one place.
 *
 * This existed as a hand-written ternary chain in four spots inside Orders.tsx
 * — the desktop chip, the expanded panel, the mobile card and the XLSX export —
 * and they had already drifted apart: only the chip was translated, the
 * expanded panel printed the raw column (hence the lowercase "altercpa" the
 * operator saw), and the export and mobile card carried two different hardcoded
 * English wordings for the same values.
 */
const SOURCE_I18N_KEY: Record<string, string> = {
  altercpa: 'ordersPage.sourceAltercpa',
  import: 'ordersPage.sourceImport',
  affiliate: 'ordersPage.sourceAffiliate',
  prediction_lead: 'ordersPage.sourceLead',
  inbound_lead: 'ordersPage.sourceWebhook',
  opencart: 'ordersPage.sourceSite',
  opencart_abandoned: 'ordersPage.sourceSiteAbandoned',
  manual: 'ordersPage.sourceManual',
};

/** Translated label for an order source. Unknown values fall back to Manual, as before.
 *  (The Bulgarian "MONADLIST" legacy list never existed in MK — 0 rows — and is gone.) */
export function sourceLabel(t: TFunction, source: string | null | undefined): string {
  if (!source) return t('ordersPage.sourceManual');
  return t(SOURCE_I18N_KEY[source] ?? 'ordersPage.sourceManual');
}

/** Badge variant for the source chip. Kept with the labels so the two cannot drift. */
export function sourceBadgeVariant(source: string | null | undefined): 'destructive' | 'secondary' | 'outline' {
  if (
    source === 'prediction_lead' || source === 'inbound_lead' || source === 'opencart' ||
    source === 'opencart_abandoned' || source === 'affiliate' || source === 'altercpa'
  ) return 'secondary';
  return 'outline';
}

/** The departments (owner law 28–29.09.2026; Менаџмент 7th since 02.10.2026, 20260947001000) —
 *  the keys GET /orders sends as `department` (order_departments → cohort_order_source). Labels are
 *  the Insights ones; the Lead-in key is `teleshopOther` because `_other` is an i18next plural suffix. */
const DEPARTMENT_I18N_KEY: Record<string, string> = {
  altercpa: 'insights.common.source.altercpa',
  elyon_crm: 'insights.common.source.elyon_crm',
  teleshop_out: 'insights.common.source.teleshop_out',
  teleshop_other: 'insights.common.source.teleshopOther',
  social: 'insights.common.source.social',
  web: 'insights.common.source.web',
  management: 'insights.common.source.management',
};

/** The order's department label, or null when the api sent none (then show the intake label). */
export function departmentLabel(t: TFunction, department: string | null | undefined): string | null {
  const key = department ? DEPARTMENT_I18N_KEY[department] : undefined;
  return key ? t(key) : null;
}

/** Who is credited with the sale, for display: the sold_* seller (a collabBox order is "confirmed"
 *  by the sync but sold by its document's author), else the confirmer, the last actor, the assignee. */
export function creditName(o: {
  seller_name?: string | null; confirmed_by_name?: string | null; last_action_by?: string | null; assigned_agent_name?: string | null;
}): string | null {
  return o.seller_name || o.confirmed_by_name || o.last_action_by || o.assigned_agent_name || null;
}

/** The source values the /orders filter offers: the only source_type values that
 *  exist in MK (import · altercpa · manual). The BG-era affiliate / opencart /
 *  inbound_lead / prediction_lead / MONADLIST matched 0 rows and are gone
 *  (the api refuses them: supabase/functions/api/ordersList.ts LIST_SOURCE_TYPES). */
export const SOURCE_FILTER_VALUES = ['altercpa', 'import', 'manual'] as const;

// ── CPA attribution ─────────────────────────────────────────────────────────
// AlterCPA identifies the affiliate only by a numeric `wm`; their merchant API
// has no directory endpoint, so names come from altercpa_webmasters, which an
// admin maintains. Orders store the ID, never the name — renaming a partner is
// one row and every historical order follows.

/** Map of wm_id → display name, as served by GET /altercpa/webmasters. */
export type WebmasterNames = Record<string, string | null | undefined>;

/**
 * An affiliate never renders as a bare number. An id we have no name for shows
 * as "#3225" — visibly unnamed, so it reads as a gap to fill rather than as
 * data, which is exactly the state the naming queue exists to clear.
 */
export function affiliateLabel(wmId: string | null | undefined, names: WebmasterNames = {}): string {
  if (!wmId) return '—';
  return names[wmId] || `#${wmId}`;
}

/** The offer name as their record had it when the lead arrived. */
export function offerLabel(
  order: { cpa_offer_name?: string | null; cpa_offer_id?: string | null } | null | undefined,
): string {
  if (!order) return '—';
  if (order.cpa_offer_name) return order.cpa_offer_name;
  return order.cpa_offer_id ? `#${order.cpa_offer_id}` : '—';
}

/** True when this order carries any CPA provenance worth showing. */
export function hasCpaAttribution(
  order: { cpa_webmaster_id?: string | null; cpa_offer_id?: string | null; cpa_stream_id?: string | null } | null | undefined,
): boolean {
  return Boolean(order?.cpa_webmaster_id || order?.cpa_offer_id || order?.cpa_stream_id);
}
