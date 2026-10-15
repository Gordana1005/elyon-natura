import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Coins, Megaphone, MousePointerClick, ShoppingCart, Target, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadError } from '@/components/insights/shared/LoadError';
import { formatDmy } from '@/components/insights/shared/period';
import { dm } from '@/components/insights/overview/useOverviewFormat';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import type { InsightsPeriod } from '@/components/insights/shared/useInsightsPeriod';
import { apiWebPage, type WebCampaign } from '@/lib/webApi';
import { ResponsiveTable, Section, Tile, roasTone, xText } from './parts';

/**
 * Реклами (margin viewers) — Meta spend against the orders it brought: ROAS on the sales value,
 * "платено ROAS" on what MEX actually paid, cost per order, and Meta's own purchase count next
 * to ours. A campaign is matched by the id the order carries. Spend counts from the floor day
 * (the ad links' campaign tags); the chat (Messenger / Instagram Direct) spend is shown apart.
 */
export function WebAdsTab({ period, f }: { period: InsightsPeriod; f: InsightsFormat }) {
  const { t, i18n } = useTranslation();
  const { from, to } = period;
  const q = useQuery({
    queryKey: ['insights-web-page', from, to],
    queryFn: ({ signal }) => apiWebPage(from, to, signal),
    placeholderData: keepPreviousData,
  });
  if (q.isError && !q.data) return <LoadError text={t('webPage.loadFailed')} onRetry={() => q.refetch()} />;
  if (!q.data) return <div className="space-y-3" aria-hidden><Skeleton variant="card" className="h-28" /><Skeleton variant="card" className="h-72" /></div>;
  const p = q.data;
  const a = p.ads;
  if (!a) return <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">{t('webPage.ads.marginsOnly')}</p>;
  const x = (v: number | null | undefined) => xText(v, i18n.language);
  const ps = p.paid_social;

  return (
    <div className="space-y-4">
      {p.spend_from > p.from && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          {t('webPage.ads.floorNote', { date: formatDmy(p.spend_from) })}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3 2xl:grid-cols-6">
        <Tile icon={Coins} label={t('webPage.ads.spend')} value={f.den(a.spend_mkd)} testId="web-ads-spend"
          sub={a.spend_other_mkd ? t('webPage.ads.chatSpend', { v: f.den(a.spend_other_mkd) }) : null} />
        <Tile icon={TrendingUp} label={t('webPage.ads.roas')} value={x(a.roas)} tone={roasTone(a.roas)} testId="web-ads-roas"
          sub={t('webPage.ads.roasSub', { v: f.den(ps.value_mkd) })} />
        <Tile icon={Target} label={t('webPage.ads.paidRoas')} value={x(a.paid_roas)} tone={roasTone(a.paid_roas)}
          sub={t('webPage.ads.paidRoasSub', { v: f.den(ps.paid_mkd) })} />
        <Tile icon={ShoppingCart} label={t('webPage.ads.cpo')} value={a.cost_per_order != null ? f.den(a.cost_per_order) : '—'}
          sub={t('webPage.ads.ordersSub', { n: f.int(ps.orders) })} />
        <Tile icon={Megaphone} label={t('webPage.ads.metaVsOurs')} value={`${f.int(a.meta_purchases)} / ${f.int(ps.orders)}`}
          sub={t('webPage.ads.metaVsOursSub')} />
        <Tile icon={MousePointerClick} label={t('webPage.ads.clicks')} value={f.int(a.link_clicks)}
          sub={t('webPage.ads.clicksSub', { ctr: f.pct(a.ctr, 2), cpc: a.cpc != null ? f.den(a.cpc) : '—' })} />
      </div>

      {p.daily.length > 1 && (
        <Section title={t('webPage.ads.daily')} note={t('webPage.ads.dailyNote')} id="web-ads-daily">
          <div className="h-60 w-full" data-testid="web-ads-chart">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={p.daily.map((d) => ({ d: d.d, spend: d.spend_mkd ?? 0, ps: d.paid_social_mkd }))} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
                <XAxis dataKey="d" tickFormatter={(d: string) => dm(d)} tick={{ fontSize: 10 }} minTickGap={12} />
                <YAxis tick={{ fontSize: 10 }} width={48} tickFormatter={(v: number) => f.int(Math.round(v / 1000)) + 'k'} />
                <Tooltip formatter={(v: number, k: string) => [f.den(v), k === 'spend' ? t('webPage.ads.spend') : t('webPage.ads.psValue')]}
                  labelFormatter={(d: string) => dm(d, true)} />
                <Legend formatter={(k: string) => (k === 'spend' ? t('webPage.ads.spend') : t('webPage.ads.psValue'))} wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="ps" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                <Line dataKey="spend" stroke="#d97706" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      <Section title={t('webPage.ads.campaigns')} note={t('webPage.ads.campaignsNote')} id="web-campaigns">
        <ResponsiveTable<WebCampaign>
          rows={p.campaigns} rowKey={(r, i) => r.id ?? `x${i}`} empty={t('webPage.ads.noCampaigns')} testId="web-campaigns-table"
          cols={[
            { key: 'name', label: t('webPage.col.campaign'), primary: true, render: (r) => (
              <span className="block min-w-0 max-w-[22rem]">
                <span className="block break-words">{r.name ?? t('webPage.ads.unnamed', { id: r.id ?? '—' })}</span>
                {r.status && <span className={cn('text-[10px] uppercase', r.status === 'ACTIVE' ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground')}>{t(`webPage.ads.status.${r.status}`, { defaultValue: r.status })}</span>}
              </span>
            ) },
            { key: 'spend', label: t('webPage.ads.spend'), align: 'right', render: (r) => f.den(r.spend_mkd ?? 0) },
            { key: 'n', label: t('webPage.col.orders'), align: 'right', render: (r) => f.int(r.orders) },
            { key: 'v', label: t('webPage.col.value'), align: 'right', render: (r) => f.den(r.value_mkd) },
            { key: 'roas', label: t('webPage.ads.roasShort'), align: 'right', render: (r) => <span className={cn('font-semibold', roasTone(r.roas))}>{x(r.roas)}</span> },
            { key: 'proas', label: t('webPage.ads.paidRoasShort'), align: 'right', render: (r) => <span className={roasTone(r.paid_roas)}>{x(r.paid_roas)}</span> },
            { key: 'cpo', label: t('webPage.ads.cpoShort'), align: 'right', render: (r) => (r.cost_per_order != null ? f.den(r.cost_per_order) : '—') },
            { key: 'mp', label: t('webPage.ads.metaShort'), align: 'right', render: (r) => f.int(r.meta_purchases ?? 0) },
          ]}
        />
      </Section>
      <p className="text-[11px] text-muted-foreground">
        {t('webPage.ads.footer', { synced: a.synced_at ? formatDmy(a.synced_at.slice(0, 10)) : '—', currency: a.currency ?? '—' })}
      </p>
    </div>
  );
}
