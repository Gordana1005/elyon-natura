import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Store } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { ChipGroup } from '@/components/assigner/parts';
import type { InsightsPeriod } from '@/components/insights/shared/useInsightsPeriod';
import { periodText } from '@/components/insights/shared/period';
import { FreshnessLine } from './FreshnessLine';
import { ShopsTable } from './ShopsTable';
import { Loading, Section, ShopsLoadError } from './parts';
import {
  SORT_LABEL, availableSorts, hasKey, parseSort, sortShops, tabParams, withParam, type ShopSortKey,
} from './shopsModel';
import { useShopsSummary } from './useShopsData';
import type { ShopsFormat } from './useShopsFormat';

/**
 * Продавници: the shops ranked over the period by one metric (sales / margins for owners;
 * receipts, units, returns, vs-average for everyone). The metric and its direction live in the
 * URL (sort / dir); a header click sorts, a second click flips. Each shop opens its detail.
 */
export function RankingTab({ period, f }: { period: InsightsPeriod; f: ShopsFormat }) {
  const { t } = f;
  const [sp, setSp] = useSearchParams();
  const q = useShopsSummary(period.range, period.today);
  const s = q.data;
  const money = !!s && hasKey(s.totals, 'sales_mkd');
  const available = useMemo(() => (s ? availableSorts(s.shops, s.totals) : []), [s]);
  const sortKey = parseSort(sp.get('sort'), available, money);
  const dir: 'asc' | 'desc' = sp.get('dir') === 'asc' ? 'asc' : 'desc';
  const rows = useMemo(() => (s ? sortShops(s.shops, sortKey, dir) : []), [s, sortKey, dir]);

  if (q.isLoading) return <Loading />;
  if (q.isError || !s) return <ShopsLoadError error={q.error} onRetry={() => void q.refetch()} f={f} />;

  const setSort = (k: ShopSortKey, d: 'asc' | 'desc' = 'desc') =>
    setSp(withParam(withParam(sp, 'sort', k), 'dir', d === 'asc' ? 'asc' : null), { replace: true });
  const onHeader = (k: ShopSortKey) => setSort(k, k === sortKey && dir === 'desc' ? 'asc' : 'desc');
  const hrefFor = (code: string) => `/shops?${tabParams(sp, 'shop', { shop: code })}`;

  return (
    <div className="space-y-4" data-testid="shops-ranking-tab">
      <FreshnessLine fresh={s.freshness} f={f} live={s.live} />
      <Section
        id="shops-ranking" title={t('shops.ranking.title')}
        subtitle={t('shops.ranking.subtitle', { period: periodText(period.range) })}
      >
        <ChipGroup<ShopSortKey>
          label={t('shops.ranking.metric')} value={sortKey}
          options={available.map((k) => ({ value: k, label: t(`shops.metric.${SORT_LABEL[k]}`) }))}
          onChange={(k) => setSort(k)}
        />
        {rows.length === 0 ? (
          <EmptyState icon={<Store className="h-5 w-5" />} title={t('shops.list.empty')} description={t('shops.list.emptyHint')} size="sm" />
        ) : (
          <ShopsTable rows={rows} variant="ranking" mode={s.kind === 'day' ? 'day' : 'period'} sortKey={sortKey} dir={dir}
            onSort={onHeader} hrefFor={hrefFor} f={f} />
        )}
        <p className="text-[11px] text-muted-foreground">{t('shops.ranking.hint')}</p>
      </Section>
    </div>
  );
}
