import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Store } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { FreshnessLine } from '@/components/shops/FreshnessLine';
import { VsAvgBadge } from '@/components/shops/parts';
import { hasKey, numOrNull, sortShops } from '@/components/shops/shopsModel';
import { useShopsSummary } from '@/components/shops/useShopsData';
import { useShopsFormat } from '@/components/shops/useShopsFormat';
import { switchTabParams, type DayRange } from '../shared/period';

/** How many shops the card names (the rest are one click away, on the Продавници tab). */
const TOP_N = 3;

/**
 * Продавници on the Overview (owner 15.10.2026): the 22 shops' sales in the same period, right
 * under the departments — a card of its own, NEVER inside the call centre's total or its parts
 * (a shop receipt has no parcel: no Наплатено / Кај курирот / Вратено). For owners one line adds
 * the two: "кол-центар + продавници = вкупно". The numbers are the Продавници tab's (the same
 * query key), so the card and the tab can never disagree.
 *
 * Hidden while a department / team chip is on (the shops are no department) and for whoever the
 * shops api refuses; money only when its key arrived (the api strips it per access level).
 */
export function ShopsOverviewCard({
  range, today, callCentreMkd, selected = false,
}: {
  range: DayRange;
  today: string;
  /** The call centre's sales in the period (the cohort total, денари) — null without money. */
  callCentreMkd: number | null;
  /** The call-centre figure is only the chosen departments (a department chip is on). */
  selected?: boolean;
}) {
  const f = useShopsFormat();
  const { t } = f;
  const [sp] = useSearchParams();
  const q = useShopsSummary(range, today);
  const s = q.data;
  const money = !!s && hasKey(s.totals, 'sales_mkd');
  const top = useMemo(() => (s ? sortShops(s.shops, money ? 'sales_mkd' : 'units').slice(0, TOP_N) : []), [s, money]);
  const tabHref = `/insights?${switchTabParams(sp, 'shops')}`;

  if (q.isError) {
    // 403 (apiFetch throws the api's "Forbidden") = not this reader's figures: no card. Anything
    // else is said in one quiet line, never a hole.
    if (/^(Forbidden|HTTP 403)$/i.test(q.error instanceof Error ? q.error.message : '')) return null;
    return (
      <section aria-labelledby="ov-shops-title" className="rounded-xl border bg-card p-4 shadow-sm">
        <h2 id="ov-shops-title" className="inline-flex items-center gap-2 text-base font-semibold">
          <Store className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />{t('overview.shops.title')}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('overview.shops.loadFailed')}</p>
      </section>
    );
  }

  const sales = s ? numOrNull(s.totals.sales_mkd) : null;
  const avg = s ? numOrNull(s.totals.avg_receipt_mkd) : null;
  const active = s ? s.shops.filter((r) => r.shop.active).length : 0;
  const group = money && sales != null && callCentreMkd != null ? callCentreMkd + sales : null;

  return (
    <section aria-labelledby="ov-shops-title" className="rounded-xl border bg-card p-4 shadow-sm" data-testid="ov-shops">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 id="ov-shops-title" className="inline-flex items-center gap-2 text-base font-semibold">
            <Store className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />{t('overview.shops.title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('overview.shops.subtitle')}</p>
        </div>
        <Link to={tabHref} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline">
          {t('overview.shops.open')}<ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>

      {!s ? (
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12" />)}
        </div>
      ) : (
        <div className={cn('mt-3 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]', q.isPlaceholderData && 'opacity-60')}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 lg:grid-cols-2 2xl:grid-cols-4">
            {money && <Stat label={t('shops.kpi.sales')} value={sales != null ? f.den(sales) : '—'} strong />}
            <Stat label={t('shops.kpi.receipts')} value={f.int(s.totals.receipts)} strong={!money} />
            {money ? (
              <Stat label={t('shops.kpi.avgReceipt')} value={avg != null ? f.den(avg) : '—'} />
            ) : (
              <Stat label={t('shops.kpi.units')} value={f.int(s.totals.units)} />
            )}
            <Stat
              label={t('shops.kpi.shopsOpen')}
              value={active > 0 ? `${f.int(s.totals.shops_open ?? 0)} / ${f.int(active)}` : f.int(s.totals.shops_open ?? 0)}
            />
          </dl>

          <div className="min-w-0">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('overview.shops.top')}</h3>
            {top.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">{t('overview.shops.empty')}</p>
            ) : (
              <ol className="mt-1 space-y-1">
                {top.map((r, i) => (
                  <li key={r.shop.code} className="flex min-w-0 items-baseline gap-2 text-sm">
                    <span className="w-4 shrink-0 text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
                    <span className="min-w-0 flex-1 break-words">
                      {r.shop.name}
                      {r.shop.city && r.shop.city !== r.shop.name && <span className="text-xs text-muted-foreground"> · {r.shop.city}</span>}
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">
                      {money && numOrNull(r.sales_mkd) != null ? f.den(r.sales_mkd) : t('overview.shops.units', { n: f.int(r.units), count: r.units })}
                    </span>
                    <VsAvgBadge pct={r.vs_avg_pct} f={f} className="hidden w-16 shrink-0 justify-end sm:inline-flex" />
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}

      {group != null && (
        <p className="mt-3 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="ov-shops-group">
          {t(selected ? 'overview.shops.groupTotalSelected' : 'overview.shops.groupTotal', { cc: f.den(callCentreMkd), shops: f.den(sales) })}{' '}
          <b className="font-semibold tabular-nums text-foreground">{f.den(group)}</b>
        </p>
      )}
      {s && <FreshnessLine fresh={s.freshness} f={f} live={s.live} className="mt-2" />}
    </section>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 break-words tabular-nums leading-tight', strong ? 'text-lg font-semibold' : 'text-base font-medium')}>{value}</dd>
    </div>
  );
}
