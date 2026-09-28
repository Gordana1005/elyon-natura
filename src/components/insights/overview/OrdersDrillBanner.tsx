import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowLeft, Filter, X } from 'lucide-react';
import type { OrdersDrillParams } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { dm } from './useOverviewFormat';
import { NO_PARCEL_DEFAULT_DAYS } from '@/lib/noParcelRule';

/** outcome param → the label the Overview showed next to that number. */
const OUTCOME_LABEL: Record<string, string> = {
  preparing: 'to_pack', 'preparing,packed': 'preparing', 'preparing,packed,courier': 'to_collect',
};

const range = (a?: string, b?: string) =>
  a && b ? (a === b ? dm(a, true) : `${dm(a)} – ${dm(b, true)}`) : a ? `${dm(a, true)} →` : b ? `→ ${dm(b, true)}` : '';

/**
 * On /orders when it was opened from an Overview number: says in words which
 * orders the list is restricted to, and removes the restriction in one click.
 */
export function OrdersDrillBanner({ drill, label, onClear }: { drill: OrdersDrillParams; label: string | null; onClear: () => void }) {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (label) parts.push(label);
  if (drill.cohort_source) {
    // the Insights sources (Social media, Teleshop – Lead in, …) say it better than a sale_source list
    // (`teleshop_other` would read as an i18next plural form, so its key is camelCase)
    parts.push(drill.cohort_source.split(',').map((s) =>
      t(`insights.common.source.${s === 'teleshop_other' ? 'teleshopOther' : s}`, { defaultValue: s })).join(' + '));
  } else if (drill.sale_source) {
    parts.push(drill.sale_source.split(',').map((s) => t(`overview.saleSource.${s}`, { defaultValue: s })).join(' + '));
  }
  if (drill.sale_source_detail) {
    // the cohort's split words first (bridge, history, …), then the Overview's older ones
    const d = drill.sale_source_detail;
    parts.push(t(`insights.common.split.${d.replace(/_other$/, 'Other')}`, { defaultValue: t(`overview.split.${d}`, { defaultValue: d }) }));
  }
  if (drill.cohort_bucket) {
    parts.push(drill.cohort_bucket === 'total'
      ? t('overview.drill.cohortTotal')
      : drill.cohort_bucket.split(',').map((k) => t(`insights.common.bucket.${k}`, {
        defaultValue: t(`insights.common.outside.${k}`, { defaultValue: k }),
      })).join(' + '));
  }
  if (drill.outcome) {
    const known = OUTCOME_LABEL[drill.outcome];
    parts.push(known
      ? t(`overview.bucket.${known}`)
      : drill.outcome.split(',').map((o) => t(`overview.bucket.${o}`, { defaultValue: o })).join(' + '));
  }
  // Opened from the Overview / Settings the label (with the rule's real days) is
  // in the URL; a bare /orders?attention=… link falls back to the default window.
  if (drill.attention && !label) parts.push(t(`overview.attention.kind.${drill.attention}`, { days: NO_PARCEL_DEFAULT_DAYS, defaultValue: drill.attention }));
  if (drill.paid_basis) parts.push(t('overview.drill.paidBasis', { basis: drill.paid_basis }));
  if (drill.created_from || drill.created_to) parts.push(t('overview.drill.created', { period: range(drill.created_from, drill.created_to) }));
  if (drill.sold_from || drill.sold_to) {
    // with cohort_bucket the days are the cohort's sale day, not "confirmed that day"
    parts.push(t(drill.cohort_bucket ? 'overview.drill.soldCohort' : 'overview.drill.sold', { period: range(drill.sold_from, drill.sold_to) }));
  }
  if (drill.cash_from || drill.cash_to) parts.push(t('overview.drill.cash', { period: range(drill.cash_from, drill.cash_to) }));
  if (drill.proof) parts.push(t(`overview.drill.proof.${drill.proof}`, { defaultValue: drill.proof }));
  for (const k of ['cpa_webmaster', 'cpa_stream', 'prediction_list', 'product', 'city'] as const) {
    if (drill[k] && !label) parts.push(drill[k]!);
  }

  return (
    <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
      <Filter className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="text-muted-foreground">{t('overview.drill.from')}</span>
      <span className="font-medium">{parts.join(' · ')}</span>
      <span className="ml-auto flex items-center gap-1">
        <Button asChild variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
          <Link to="/insights?tab=overview"><ArrowLeft className="h-3.5 w-3.5" aria-hidden />{t('overview.drill.back')}</Link>
        </Button>
        <Button variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={onClear}>
          <X className="h-3.5 w-3.5" aria-hidden />{t('overview.drill.clear')}
        </Button>
      </span>
    </div>
  );
}
