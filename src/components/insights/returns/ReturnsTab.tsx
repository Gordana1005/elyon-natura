import i18n from '@/i18n';
import { Coins, MapPin, Package, PackageX, RotateCcw, Trash2 } from 'lucide-react';
import type { InsightsResponse } from '@/lib/api';
import { formatMoney } from '@/lib/currency';
import { cancelReasonLabel } from '@/lib/cancellationReasons';
import { KpiCard as Kpi } from '@/components/insights/KpiCard';
import { ListCard } from '@/components/insights/shared/ListCard';
import { cap, pct } from '@/components/insights/shared/tabFormat';

// Insights → Returns. Moved verbatim out of ManagementInsightsPage (WP0) so
// the Returns & Stock package edits its own file.
export default function ReturnsTab({ data }: { data: InsightsResponse }) {
  const r = data.returns;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={RotateCcw} label={i18n.t('insights.returnRate')} value={pct(r.rate)} tone="bg-orange-100 text-orange-700" />
        <Kpi icon={Coins} label={i18n.t('insights.valueLost')} value={formatMoney(r.value_lost)} tone="bg-red-100 text-red-700" />
        <Kpi icon={PackageX} label={i18n.t('insights.cancellations')} value={data.cancellations.total.toLocaleString()} tone="bg-zinc-100 text-zinc-700" />
        <Kpi icon={Trash2} label={i18n.t('insights.trashed')} value={data.cancellations.trashed.toLocaleString()} sub={i18n.t('insights.junkSub')} tone="bg-zinc-100 text-zinc-700" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ListCard title={i18n.t('insights.returnsByReason')} icon={RotateCcw} rows={r.by_reason} nameKey="reason" cols={[{ k: 'count', label: i18n.t('insights.count') }]} transformName={cap} />
        <ListCard title={i18n.t('insights.returnsByProduct')} icon={Package} rows={r.by_product} nameKey="product" cols={[{ k: 'count', label: i18n.t('insights.count') }]} />
        <ListCard title={i18n.t('insights.returnsByCity')} icon={MapPin} rows={r.by_city} nameKey="city" cols={[{ k: 'count', label: i18n.t('insights.count') }]} />
        <ListCard title={i18n.t('insights.cancellationsByReason')} icon={PackageX} rows={data.cancellations.by_reason} nameKey="reason" cols={[{ k: 'count', label: i18n.t('insights.count') }]} transformName={cancelReasonName} />
      </div>
    </div>
  );
}

// A reason that has a label (cancelReason.* — including the system-only
// no_parcel_7d) shows it in the reader's language; server markers without one
// (pending_cleanup, "(unspecified)") keep the plain prettified value.
const cancelReasonName = (s: string) => (i18n.exists(`cancelReason.${s}`) ? cancelReasonLabel(s) : cap(s));
