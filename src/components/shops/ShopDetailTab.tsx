import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronRight, Search, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/EmptyState';
import { Chip } from '@/components/assigner/parts';
import { DmyDateInput } from '@/components/insights/shared/DmyDateInput';
import { addDays, isYmd } from '@/components/insights/shared/period';
import type { InsightsPeriod } from '@/components/insights/shared/useInsightsPeriod';
import { isShopCode } from '@/lib/shopsApi';
import type { ShopDetail, ShopRef } from '@/lib/shopsTypes';
import { cn } from '@/lib/utils';
import { DocList } from './DocList';
import { FreshnessLine } from './FreshnessLine';
import { ShopsKpis } from './ShopsKpis';
import { StockList } from './StockList';
import { ControlBadge, Loading, ShopsLoadError, Tile, VsAvgBadge } from './parts';
import { filterStock, hasKey, numOrNull, parseStockBasis, tabParams, withParam } from './shopsModel';
import { useShopDetail, useShopsSummary } from './useShopsData';
import type { ShopsFormat } from './useShopsFormat';

const ARTICLES_PREVIEW = 10;

/**
 * Продавница (?shop=003): the period's tiles, sales by article, the stock at `at` (now by default:
 * the nightly snapshot + the movements after it), goods in / out and the counts. The search and
 * "само нула" filter live in the URL (q / zero), as does the stock day (at).
 */
export function ShopDetailTab({ period, f }: { period: InsightsPeriod; f: ShopsFormat }) {
  const { t } = f;
  const [sp, setSp] = useSearchParams();
  const rawShop = sp.get('shop');
  const code = isShopCode(rawShop) ? rawShop : null;
  const rawAt = sp.get('at');
  const atDay = isYmd(rawAt) && rawAt < period.today ? rawAt : null;
  // the shop list for the picker: the same (cached) report the other tabs read
  const summary = useShopsSummary(period.range, period.today);
  const q = useShopDetail(code, period.range, atDay, period.today);
  const shops: ShopRef[] = useMemo(() => {
    const list = summary.data?.shops.map((r) => r.shop) ?? [];
    if (q.data?.shop && !list.some((s) => s.code === q.data!.shop.code)) list.push(q.data.shop);
    return list.sort((a, b) => a.code.localeCompare(b.code));
  }, [summary.data, q.data]);
  const set = (k: string, v: string | boolean | null) => setSp(withParam(sp, k, v), { replace: true });

  const picker = (
    <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">{t('shops.detail.select')}</span>
      <select
        className="min-h-9 min-w-0 max-w-full flex-1 rounded-md border bg-background px-2 text-sm text-foreground sm:flex-none"
        value={code ?? ''}
        onChange={(e) => setSp(withParam(withParam(withParam(sp, 'shop', e.target.value || null), 'q', null), 'zero', null))}
      >
        {!code && <option value="">{t('shops.detail.pick')}</option>}
        {shops.map((s) => <option key={s.code} value={s.code}>{`${s.code} ${s.name}`}</option>)}
      </select>
    </label>
  );

  if (!code) {
    return (
      <div className="space-y-4" data-testid="shops-detail-pick">
        {picker}
        {summary.isLoading ? <Loading /> : shops.length === 0 ? (
          <EmptyState icon={<Store className="h-5 w-5" />} title={t('shops.detail.pick')} description={t('shops.detail.pickHint')} size="sm" />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {shops.map((s) => (
              <li key={s.code}>
                <Link to={`/shops?${tabParams(sp, 'shop', { shop: s.code })}`}
                  className="flex items-center justify-between gap-2 rounded-xl border bg-card p-3 shadow-sm hover:bg-muted/50">
                  <span className="min-w-0">
                    <span className="mr-1.5 font-mono text-xs text-muted-foreground">{s.code}</span>
                    <span className="font-medium">{s.name}</span>
                    <span className="block text-xs text-muted-foreground">{s.city}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="shops-detail-tab">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {picker}
        {q.data && <FreshnessLine fresh={q.data.freshness} f={f} live={period.range.to === period.today} />}
      </div>
      {q.isLoading ? <Loading /> : q.isError || !q.data ? (
        <ShopsLoadError error={q.error} onRetry={() => void q.refetch()} f={f} />
      ) : (
        <DetailBody d={q.data} atDay={atDay} period={period} f={f}
          q={sp.get('q') ?? ''} zero={sp.get('zero') === '1'}
          onQ={(v) => set('q', v)} onZero={(v) => set('zero', v)} onAt={(v) => set('at', v)} />
      )}
    </div>
  );
}

function DetailBody({ d, atDay, period, f, q, zero, onQ, onZero, onAt }: {
  d: ShopDetail; atDay: string | null; period: InsightsPeriod; f: ShopsFormat;
  q: string; zero: boolean; onQ: (v: string) => void; onZero: (v: boolean) => void; onAt: (v: string | null) => void;
}) {
  const { t } = f;
  const s = d.summary;
  const [allArticles, setAllArticles] = useState(false);
  const stock = useMemo(() => filterStock(d.stock ?? [], { q, zero }), [d.stock, q, zero]);
  const zeroCount = (d.stock ?? []).filter((r) => r.qty <= 0).length;
  const artMoney = (d.sales_by_article ?? []).some((a) => hasKey(a, 'sales_mkd'));
  // by sales for owners, by units otherwise — the bars and the rank follow the same measure
  const articles = useMemo(() => [...(d.sales_by_article ?? [])].sort((a, b) =>
    (artMoney ? (numOrNull(b.sales_mkd) ?? 0) - (numOrNull(a.sales_mkd) ?? 0) : 0) || b.units - a.units || a.name.localeCompare(b.name)),
  [d.sales_by_article, artMoney]);
  const shownArticles = allArticles ? articles : articles.slice(0, ARTICLES_PREVIEW);
  const artMax = Math.max(0, ...articles.map((a) => (artMoney ? numOrNull(a.sales_mkd) ?? 0 : a.units)));
  const basis = parseStockBasis(d.stock_basis);
  const totals = d.stock_totals;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">
          <span className="mr-2 font-mono text-sm text-muted-foreground">{d.shop.code}</span>{d.shop.name}
        </h2>
        <p className="text-xs text-muted-foreground">
          {[d.shop.city, d.shop.sigma_object ? t('shops.detail.sigmaObject', { n: d.shop.sigma_object }) : null,
            !d.shop.active ? t('shops.list.inactive') : null].filter(Boolean).join(' · ')}
        </p>
      </div>

      <ShopsKpis totals={s} shopsTotal={null} f={f} extra={(
        <Tile label={t('shops.detail.lastReceipt')}
          value={s.last_receipt_at ? (d.from === d.to ? f.time(s.last_receipt_at) : f.dayTime(s.last_receipt_at)) : '—'}
          sub={s.first_receipt_at && d.from === d.to ? t('shops.detail.firstReceipt', { time: f.time(s.first_receipt_at) }) : undefined}>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <VsAvgBadge pct={s.vs_avg_pct} f={f} />
            <ControlBadge ok={s.control_ok} f={f} />
          </div>
        </Tile>
      )} />

      <section aria-labelledby="shop-articles" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="shop-articles" className="text-base font-semibold">{t('shops.detail.byArticle')}</h2>
            <p className="text-xs text-muted-foreground">{t('shops.detail.byArticleSub', { n: f.int(articles.length) })}</p>
          </div>
        </div>
        {articles.length === 0 ? (
          <p className="rounded-xl border bg-card p-4 text-center text-sm text-muted-foreground">{t('shops.detail.noSales')}</p>
        ) : (
          <div className="rounded-xl border bg-card shadow-sm">
            <ol className="divide-y">
              {shownArticles.map((a, i) => {
                const v = artMoney ? numOrNull(a.sales_mkd) ?? 0 : a.units;
                return (
                  <li key={a.code} className="px-3 py-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <div className="min-w-0 flex-1 basis-48">
                        <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
                        <span className="font-medium">{a.name}</span>
                        <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{a.code}</span>
                      </div>
                      <div className="flex flex-wrap items-baseline justify-end gap-x-4 gap-y-0.5 text-sm tabular-nums">
                        <span title={t('shops.metric.units')}>{t('shops.detail.unitsN', { n: f.int(a.units) })}</span>
                        {hasKey(a, 'sales_mkd') && <span className="font-semibold">{numOrNull(a.sales_mkd) != null ? f.den(a.sales_mkd) : '—'}</span>}
                        {hasKey(a, 'shop_margin_mkd') && (
                          <span className="text-xs text-muted-foreground" title={t('shops.metric.shopMargin')}>
                            {t('shops.detail.marginShort', { value: numOrNull(a.shop_margin_mkd) != null ? f.den(a.shop_margin_mkd) : '—' })}
                          </span>
                        )}
                        {hasKey(a, 'group_margin_mkd') && (
                          <span className="text-xs text-muted-foreground" title={t('shops.metric.groupMargin')}>
                            {t('shops.detail.groupShort', { value: numOrNull(a.group_margin_mkd) != null ? f.den(a.group_margin_mkd) : t('shops.detail.pendingShort') })}
                          </span>
                        )}
                      </div>
                    </div>
                    {artMax > 0 && (
                      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <div className="h-full rounded-full bg-[var(--sh-bar)]" style={{ width: `${(v / artMax) * 100}%` }} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {articles.length > ARTICLES_PREVIEW && (
              <div className="border-t p-2 text-center">
                <Button variant="ghost" size="sm" onClick={() => setAllArticles((v) => !v)}>
                  {allArticles ? t('shops.detail.showLess') : t('shops.detail.showAll', { n: f.int(articles.length) })}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="shop-stock" className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <h2 id="shop-stock" className="text-base font-semibold">
              {atDay ? t('shops.detail.stockAt', { at: f.dayFull(atDay) }) : t('shops.detail.stockTitle')}
            </h2>
            <p className="text-xs text-muted-foreground" data-testid="shops-stock-basis">
              {basis
                ? t('shops.detail.basis', { at: basis.at, count: basis.movements })
                : d.stock_basis ? t('shops.detail.basisRaw', { text: d.stock_basis }) : null}
              {' · '}{t('shops.detail.stockAtTime', { at: f.dayTime(d.stock_at) })}
            </p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {t('shops.detail.stockTotals', { articles: f.int(totals.articles), units: f.int(totals.units) })}
              {hasKey(totals, 'value_cost_mkd') && ` · ${t('shops.detail.valueCost', { value: f.den(totals.value_cost_mkd) })}`}
              {hasKey(totals, 'value_retail_mkd') && ` · ${t('shops.detail.valueRetail', { value: f.den(totals.value_retail_mkd) })}`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="relative min-w-0 flex-1 basis-full sm:basis-56">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={q} onChange={(e) => onQ(e.target.value)} placeholder={t('shops.detail.search')} aria-label={t('shops.detail.search')} className="pl-9" />
          </div>
          <Chip on={zero} onClick={() => onZero(!zero)}>{t('shops.detail.onlyZero', { n: f.int(zeroCount) })}</Chip>
          <div className={cn('min-w-0')}>
            <DmyDateInput label={t('shops.detail.stockDay')} value={atDay} max={addDays(period.today, -1)} min={addDays(period.today, -730)}
              onChange={(v) => { if (v === null || isYmd(v)) onAt(v); }} />
          </div>
          {atDay && <Button variant="ghost" size="sm" className="h-9" onClick={() => onAt(null)}>{t('shops.detail.stockNow')}</Button>}
        </div>
        <StockList key={`${d.shop.code}-${q}-${zero}`} rows={stock} f={f} />
      </section>

      <DocList id="shop-in" title={t('shops.detail.goodsIn')} rows={d.goods_in ?? []} f={f} />
      <DocList id="shop-out" title={t('shops.detail.goodsOut')} rows={d.goods_out ?? []} f={f} />
      <DocList id="shop-counts" title={t('shops.detail.counts')} rows={d.counts ?? []} f={f} />
    </div>
  );
}
