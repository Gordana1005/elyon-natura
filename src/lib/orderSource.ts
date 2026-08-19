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

/** MONADLIST is a proper noun — the imported Bulgarian legacy list — not a label to translate. */
const SOURCE_LITERAL: Record<string, string> = { monadon_legacy: 'MONADLIST' };

/** Translated label for an order source. Unknown values fall back to Manual, as before. */
export function sourceLabel(t: TFunction, source: string | null | undefined): string {
  if (!source) return t('ordersPage.sourceManual');
  const literal = SOURCE_LITERAL[source];
  if (literal) return literal;
  return t(SOURCE_I18N_KEY[source] ?? 'ordersPage.sourceManual');
}

/** Badge variant for the source chip. Kept with the labels so the two cannot drift. */
export function sourceBadgeVariant(source: string | null | undefined): 'destructive' | 'secondary' | 'outline' {
  if (source === 'monadon_legacy') return 'destructive';
  if (
    source === 'prediction_lead' || source === 'inbound_lead' || source === 'opencart' ||
    source === 'opencart_abandoned' || source === 'affiliate' || source === 'altercpa'
  ) return 'secondary';
  return 'outline';
}

/** The five source values the filter dropdown offers, in the order it offers them. */
export const SOURCE_FILTER_VALUES = [
  'altercpa', 'import', 'affiliate', 'opencart', 'inbound_lead', 'prediction_lead', 'monadon_legacy',
] as const;

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
  order: { cpa_webmaster_id?: string | null; cpa_offer_id?: string | null } | null | undefined,
): boolean {
  return Boolean(order?.cpa_webmaster_id || order?.cpa_offer_id);
}
