import { Boxes, Clock, PackageOpen, Send } from 'lucide-react';
import { Tile } from '@/components/insights/returns/RsBits';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import type { QueueCounts } from '@/lib/warehouseApi';

/**
 * The four tiles on top of /warehouse — straight from the queue's counts (one
 * call, public.warehouse_queue): no 22k-order download to count a tile.
 */
export function WarehouseKpis({ counts, lowStock, f }: { counts: QueueCounts | undefined; lowStock: number | null; f: InsightsFormat }) {
  const { t } = f;
  const n = (v: number | undefined | null) => (counts && v != null ? f.int(v) : '—');
  const waiting = counts ? counts.send_over_3d + counts.pack_over_3d : null;
  return (
    <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label={t('nav.warehouse')}>
      <Tile icon={Send} label={t('warehousePage.kpi.send')} value={n(counts?.send)}
        sub={counts ? t('warehousePage.kpi.sendSub', { noAddress: f.int(counts.send_no_address), noZone: f.int(counts.send_no_zone) }) : undefined} />
      <Tile icon={PackageOpen} label={t('warehousePage.kpi.pack')} value={n(counts?.pack)}
        sub={counts ? t('warehousePage.kpi.packSub', { stale: f.int(counts.pack_stale), days: counts.stale_days }) : undefined} />
      <Tile icon={Clock} label={t('warehousePage.kpi.waiting')} value={waiting == null ? '—' : f.int(waiting)}
        alert={waiting && waiting > 0 ? 'warning' : null}
        sub={counts ? t('warehousePage.kpi.waitingSub', { send: f.int(counts.send_over_3d), pack: f.int(counts.pack_over_3d) }) : undefined} />
      <Tile icon={Boxes} label={t('warehousePage.kpi.products')} value={n(counts?.active_products)}
        sub={lowStock != null ? t('warehousePage.kpi.productsSub', { low: f.int(lowStock) }) : undefined} />
    </ul>
  );
}
