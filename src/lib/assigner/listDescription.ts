/**
 * What a prediction list IS, in the reader's language — generated from the
 * list's name, never from the English DB text (that is only the fallback for
 * a list the parser does not know, e.g. an uploaded campaign list).
 *
 * The engine names bands "<recency> ≤N|N+ (<orders> orders)"; the wording
 * below follows what the engine actually does (the DB descriptions it writes,
 * migration 20260629000000): "(1-3 orders)" means 1–2 lifetime PAID orders,
 * "(3+)" 3–4, "(5+)" 5–6, "(7+)" 7 or more; the value band is the LAST paid
 * order's price (stored EUR → shown in денари).
 *
 * ⚠️ DISPLAY ONLY. List names are engine keys (exact-name match, memberships
 * deleted before resolving): nothing here is ever written back or used as a key.
 */
import { formatMoney } from '@/lib/currency';
import { parsePredictionListName, type ParsedListName } from '@/lib/predictionListLabel';
import { ordersId, recencyId, type LabelT } from '@/components/insights/lists/listModel';

export function listDescription(
  t: LabelT,
  name: string | null | undefined,
  fallback?: string | null,
  parsed: ParsedListName = parsePredictionListName(name),
): string | null {
  const orders = (o: string | null) => {
    const id = ordersId(o);
    return id ? t(`assigner.listDesc.orders.${id}`) : null;
  };
  if (parsed.kind === 'pen' && parsed.pen) {
    return t(`assigner.listDesc.pen.${parsed.pen}`, { defaultValue: fallback ?? '' }) || null;
  }
  if (parsed.kind === 'newcomers') {
    return [t('assigner.listDesc.recency.newcomers'), orders(parsed.orders)].filter(Boolean).join(' · ');
  }
  if (parsed.kind === 'band') {
    const rid = recencyId(parsed.recency);
    if (rid && parsed.threshold != null) {
      const value = formatMoney(parsed.threshold);
      return [
        t(`assigner.listDesc.recency.${rid}`),
        t(parsed.band === 'le' ? 'assigner.listDesc.bandLe' : 'assigner.listDesc.bandGt', { value }),
        orders(parsed.orders),
      ].filter(Boolean).join(' · ');
    }
  }
  const fb = (fallback ?? '').trim();
  return fb ? fb : null;
}

// ── Groups (the Assigner's Lists tab) ───────────────────────────────────────

/** New buyers, the recency bands in engine order, then the pens. */
export type AssignerListGroupKey =
  | 'newcomers' | 'd21' | 'd57' | 'm4_6' | 'm6_12' | 'y1_2' | 'y2plus'
  | 'cancels' | 'returns' | 'trash' | 'other';

export const ASSIGNER_LIST_GROUPS: AssignerListGroupKey[] = [
  'newcomers', 'd21', 'd57', 'm4_6', 'm6_12', 'y1_2', 'y2plus', 'cancels', 'returns', 'trash', 'other',
];

const RECENCY_GROUP: Record<string, AssignerListGroupKey> = {
  NEWCOMERS: 'newcomers', '21d': 'd21', '57d': 'd57', '4-6m': 'm4_6', '6-12m': 'm6_12', '1-2yr': 'y1_2', '2yr+': 'y2plus',
};

/** The group a list belongs to (by its parsed name; `category` decides unknown names). */
export function listGroupOf(name: string | null | undefined, category?: string | null): AssignerListGroupKey {
  const p = parsePredictionListName(name);
  if ((p.kind === 'band' || p.kind === 'newcomers') && p.recency && RECENCY_GROUP[p.recency]) return RECENCY_GROUP[p.recency];
  if (p.kind === 'pen') {
    switch (p.pen) {
      case 'current_cancels': case 'never_converted_recent': case 'never_converted_old': case 'cancelled_pendings':
        return 'cancels';
      case 'current_returns': return 'returns';
      case 'trash': return 'trash';
      default: return 'other';
    }
  }
  if (category === 'cancel') return 'cancels';
  if (category === 'return') return 'returns';
  return 'other';
}

/** The group's heading: the Insights recency labels, the Assigner's own for the pens. */
export function listGroupLabel(t: LabelT, key: AssignerListGroupKey): string {
  switch (key) {
    case 'cancels': case 'returns': case 'trash': case 'other':
      return t(`assigner.group.${key}`);
    default:
      return t(`insights.lists.table.groupName.recency.${key}`);
  }
}
