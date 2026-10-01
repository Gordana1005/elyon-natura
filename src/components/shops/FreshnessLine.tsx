import { useEffect, useState } from 'react';
import { Clock, Package, Receipt } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ShopsFreshness } from '@/lib/shopsTypes';
import { TONE_TEXT } from '@/components/insights/overview/palette';
import { salesLate, snapshotIsRecent } from './shopsModel';
import type { ShopsFormat } from './useShopsFormat';

/**
 * "сметки пред 4 мин · залиха од 23:30" — how old the receipts and the stock snapshot are,
 * re-read every 30 s so "N min ago" never goes stale. Receipts more than 30 min old during the
 * shops' hours are flagged (the reader reads them every 15 min).
 */
export function FreshnessLine({ fresh, f, live, className }: { fresh: ShopsFreshness | null | undefined; f: ShopsFormat; live?: boolean; className?: string }) {
  const { t } = f;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!fresh) return null;
  const late = !!live && salesLate(fresh, now);
  const snap = fresh.last_stock_snapshot_at;
  const title = [
    t('shops.fresh.sales', { ago: f.ago(fresh.last_sales_at, now) }),
    t('shops.fresh.docs', { ago: f.ago(fresh.last_docs_at, now) }),
    snap ? t('shops.fresh.stock', { time: f.dayTime(snap) }) : t('shops.fresh.stockNever'),
    t('shops.fresh.reader', { ago: f.ago(fresh.reader_last_run_at, now) }),
  ].join(' · ');
  return (
    <p className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground', className)} title={title} data-testid="shops-freshness">
      <span className={cn('inline-flex items-center gap-1', late && cn('font-semibold', TONE_TEXT.warning))}>
        {late ? <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Receipt className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        {fresh.last_sales_at ? t('shops.fresh.sales', { ago: f.ago(fresh.last_sales_at, now) }) : t('shops.fresh.salesNever')}
        {late && <span>· {t('shops.fresh.late')}</span>}
      </span>
      <span aria-hidden>·</span>
      <span className="inline-flex items-center gap-1">
        <Package className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {snap ? t('shops.fresh.stock', { time: snapshotIsRecent(snap, now) ? f.time(snap) : f.dayTime(snap) }) : t('shops.fresh.stockNever')}
      </span>
    </p>
  );
}
