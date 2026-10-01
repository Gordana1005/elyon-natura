import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Store } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Toggle } from '@/components/insights/sales/SalesTrend';
import type { InsightsPeriod } from '@/components/insights/shared/useInsightsPeriod';
import { cn } from '@/lib/utils';
import { FreshnessLine } from './FreshnessLine';
import { NaturaBlock } from './NaturaBlock';
import { ShopsBarChart } from './ShopsBarChart';
import { chartRows } from './chartRows';
import { ShopsKpis } from './ShopsKpis';
import { ShopsTable } from './ShopsTable';
import { Loading, Section, ShopsLoadError } from './parts';
import { hasKey, sortShops, tabParams, withParam } from './shopsModel';
import { useShopsSummary } from './useShopsData';
import type { ShopsFormat } from './useShopsFormat';

/**
 * Денес / Период: the tiles, the hours of the day (or the days of the period), the shops by
 * sales (owners) or units, and — for a period — what Natura invoiced the shops. Today is live
 * (refreshed every minute; the reader reads receipts every 15 min).
 */
export function DayTab({ period, f }: { period: InsightsPeriod; f: ShopsFormat }) {
  const { t } = f;
  const [sp, setSp] = useSearchParams();
  const q = useShopsSummary(period.range, period.today);
  const s = q.data;
  const money = !!s && hasKey(s.totals, 'sales_mkd');
  const sortKey = money && sp.get('sort') !== 'units' ? 'sales_mkd' : 'units';
  const rows = useMemo(() => (s ? sortShops(s.shops, sortKey) : []), [s, sortKey]);
  const chart = useMemo(() => (s ? chartRows(s, period.today) : []), [s, period.today]);

  if (q.isLoading) return <Loading />;
  if (q.isError || !s) return <ShopsLoadError error={q.error} onRetry={() => void q.refetch()} f={f} />;

  const hrefFor = (code: string) => `/shops?${tabParams(sp, 'shop', { shop: code })}`;
  const isPeriod = s.kind === 'period';

  return (
    <div className="space-y-5" data-testid="shops-day-tab">
      <FreshnessLine fresh={s.freshness} f={f} live={s.live} />
      <ShopsKpis totals={s.totals} shopsTotal={s.shops.filter((r) => r.shop.active).length} f={f} />

      <div className={cn('grid min-w-0 gap-5', isPeriod && 'xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]')}>
        <ShopsBarChart
          key={s.kind}
          id="shops-chart" f={f} rows={chart}
          title={t(isPeriod ? 'shops.chart.dailyTitle' : 'shops.chart.hourlyTitle')}
          subtitle={t(isPeriod ? 'shops.chart.dailySub' : s.live ? 'shops.chart.hourlySubLive' : 'shops.chart.hourlySub')}
          emptyText={t('shops.chart.empty')}
        />
        {s.kind === 'period' && s.period.natura && (
          <NaturaBlock natura={s.period.natura} deliveriesHref={`/shops?${tabParams(sp, 'deliveries')}`} f={f} />
        )}
      </div>

      <Section
        id="shops-list" title={t('shops.list.title')}
        subtitle={t(isPeriod ? 'shops.list.subPeriod' : 'shops.list.subDay')}
        actions={money ? (
          <Toggle label={t('shops.list.sortBy')} value={sortKey === 'units' ? 'units' : 'sales'}
            onChange={(v) => setSp(withParam(sp, 'sort', v === 'units' ? 'units' : null), { replace: true })}
            options={[['sales', t('shops.list.bySales')], ['units', t('shops.list.byUnits')]]} />
        ) : undefined}
      >
        {rows.length === 0 ? (
          <EmptyState icon={<Store className="h-5 w-5" />} title={t('shops.list.empty')} description={t('shops.list.emptyHint')} size="sm" />
        ) : (
          <ShopsTable rows={rows} variant="day" mode={isPeriod ? 'period' : 'day'} sortKey={sortKey} dir="desc" hrefFor={hrefFor} f={f} />
        )}
      </Section>
    </div>
  );
}
