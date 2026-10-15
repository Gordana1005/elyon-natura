import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadError } from '@/components/insights/shared/LoadError';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import type { InsightsPeriod } from '@/components/insights/shared/useInsightsPeriod';
import { apiGetInsightsProfit, profitQueryKey } from '@/lib/insightsApi/profit';
import { useAuth } from '@/contexts/AuthContext';
import { apiWebPage, ratio } from '@/lib/webApi';
import { Section, Tile, poasTone, xText } from './parts';

/**
 * Профит (margin viewers) — the web row of THE profit calculation (GET /insights/profit, the
 * cohort clock: Sigma purchase cost, VAT per product, courier, returns), never a second one.
 * POAS = the web profit carried by the paid-social orders ÷ the Meta spend — an estimate: the
 * web's own margin applied to the paid-social share of the sales value (labelled so).
 */
export function WebProfitTab({ period, f }: { period: InsightsPeriod; f: InsightsFormat }) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const { from, to } = period;
  const profit = useQuery({
    queryKey: profitQueryKey(user?.id, { from, to }),
    queryFn: ({ signal }) => apiGetInsightsProfit({ from, to }, signal),
    placeholderData: keepPreviousData,
  });
  const page = useQuery({
    queryKey: ['insights-web-page', from, to],
    queryFn: ({ signal }) => apiWebPage(from, to, signal),
    placeholderData: keepPreviousData,
  });
  if ((profit.isError && !profit.data) || (page.isError && !page.data)) {
    return <LoadError text={t('webPage.loadFailed')} onRetry={() => { void profit.refetch(); void page.refetch(); }} />;
  }
  if (!profit.data || !page.data) return <div className="space-y-3" aria-hidden><Skeleton variant="card" className="h-28" /><Skeleton variant="card" className="h-64" /></div>;

  const w = profit.data.cohort.by_source.find((r) => r.key === 'web');
  if (!w || !w.sales) return <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">{t('webPage.profit.none')}</p>;
  const p = page.data;
  const spend = p.ads?.spend_mkd ?? 0;
  const psShare = p.total.value_mkd > 0 ? p.paid_social.value_mkd / p.total.value_mkd : 0;
  const adsProfit = w.net_mkd * psShare;
  const poas = ratio(adsProfit, spend);
  const afterAds = w.net_mkd - spend;
  const cost = w.cogs_known_mkd + (w.cogs_est_mkd ?? 0) + (w.cogs_extra_mkd ?? 0);

  const lines: [string, number, boolean?][] = [
    ['revenue', w.revenue_mkd],
    ['vat', -w.vat_mkd],
    ['cogs', -cost],
    ['courier', -w.courier_mkd],
    ['returns', -w.returns_mkd],
    ['net', w.net_mkd, true],
    ['ads', -spend],
    ['afterAds', afterAds, true],
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Tile label={t('webPage.profit.net')} value={f.den(w.net_mkd)} sub={t('webPage.profit.margin', { m: f.pct(w.margin) })}
          tone={w.net_mkd < 0 ? 'text-red-700 dark:text-red-400' : undefined} testId="web-profit-net" />
        <Tile label={t('webPage.profit.afterAds')} value={f.den(afterAds)} sub={t('webPage.profit.afterAdsSub', { v: f.den(spend) })}
          tone={afterAds < 0 ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'} />
        <Tile label={t('webPage.profit.poas')} value={xText(poas, i18n.language)} tone={poasTone(poas)}
          sub={t('webPage.profit.poasSub')} />
        <Tile label={t('webPage.profit.perSale')} value={w.profit_per_sale_mkd != null ? f.den(w.profit_per_sale_mkd) : '—'}
          sub={t('webPage.profit.sales', { n: f.int(w.sales) })} />
      </div>

      <Section title={t('webPage.profit.waterfall')} note={t('webPage.profit.waterfallNote')} id="web-profit-waterfall">
        <dl className="divide-y text-sm" data-testid="web-profit-lines">
          {lines.map(([k, v, strong]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 py-1.5">
              <dt className={strong ? 'font-semibold' : 'text-muted-foreground'}>{t(`webPage.profit.line.${k}`)}</dt>
              <dd className={`tabular-nums ${strong ? 'font-semibold' : ''} ${v < 0 && strong ? 'text-red-700 dark:text-red-400' : ''}`}>{f.den(v)}</dd>
            </div>
          ))}
        </dl>
        {w.coverage_revenue != null && w.coverage_revenue < 0.95 && (
          <p className="mt-2 text-[11px] text-amber-800 dark:text-amber-300">
            {t('webPage.profit.coverage', { pct: f.pct(w.coverage_revenue) })}
          </p>
        )}
      </Section>
    </div>
  );
}
