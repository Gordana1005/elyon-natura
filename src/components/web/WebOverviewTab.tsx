import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Ban, CreditCard, Percent, ShoppingBasket, Undo2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadError } from '@/components/insights/shared/LoadError';
import { CohortBar } from '@/components/insights/shared/CohortBar';
import { dm } from '@/components/insights/overview/useOverviewFormat';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import type { InsightsPeriod } from '@/components/insights/shared/useInsightsPeriod';
import { apiWebCohort, apiWebPage, groupChannels, type WebChannelRow } from '@/lib/webApi';
import { ResponsiveTable, Section, Tile } from './parts';

/**
 * Преглед — the web shop's sales of the period. The headline bar is THE cohort (GET
 * /insights/cohort?source=web — the same numbers as Insights and the TV board); under it the
 * shop's own breakdowns of exactly those rows (channels, products, coupons, cities, payment) and,
 * apart, what never became a sale (cancelled, failed card checkouts).
 */
export function WebOverviewTab({ period, f }: { period: InsightsPeriod; f: InsightsFormat }) {
  const { t } = useTranslation();
  const { from, to, compare } = period;
  const cohort = useQuery({
    queryKey: ['insights-web-cohort', from, to, compare],
    queryFn: ({ signal }) => apiWebCohort(from, to, compare, signal),
    placeholderData: keepPreviousData,
  });
  const page = useQuery({
    queryKey: ['insights-web-page', from, to],
    queryFn: ({ signal }) => apiWebPage(from, to, signal),
    placeholderData: keepPreviousData,
  });
  const groups = useMemo(() => groupChannels(page.data?.channels ?? []), [page.data]);

  if ((cohort.isError && !cohort.data) || (page.isError && !page.data)) {
    return <LoadError text={t('webPage.loadFailed')} onRetry={() => { void cohort.refetch(); void page.refetch(); }} />;
  }
  if (!cohort.data || !page.data) {
    return <div className="space-y-3" aria-hidden><Skeleton variant="card" className="h-44" /><Skeleton variant="card" className="h-64" /></div>;
  }
  const c = cohort.data;
  const p = page.data;
  const money = c.meta?.money !== false;
  const tot = p.total;
  const channelLabel = (ch: string) => t(`webPage.channel.${ch}`, { defaultValue: ch });

  return (
    <div className="space-y-4">
      <CohortBar
        title={t('webPage.overview.sold', { period: f.period(from, to) })}
        total={c.total} buckets={c.buckets} outside={c.outside} money={money}
        rows={c.by_source} range={period.range}
        prev={compare ? c.prev?.total ?? null : null}
        spark={(c.spark ?? []).map((s) => ({ d: s.d, v: money && s.value_mkd != null ? s.value_mkd : s.count }))}
        f={f}
      />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <Tile icon={ShoppingBasket} label={t('webPage.overview.aov')} value={tot.orders ? f.den(tot.value_mkd / tot.orders) : '—'} />
        <Tile icon={Percent} label={t('webPage.overview.paidShare')} value={f.pct(tot.orders ? tot.paid / tot.orders : null)}
          sub={f.den(tot.paid_mkd)} />
        <Tile icon={Undo2} label={t('webPage.overview.returnedShare')} value={f.pct(tot.orders ? tot.returned / tot.orders : null)}
          sub={f.den(tot.returned_mkd)} />
        <Tile icon={CreditCard} label={t('webPage.overview.cardUnpaid')} value={f.int(p.lost.card_unpaid.orders)}
          sub={f.den(p.lost.card_unpaid.value_mkd)} tone={p.lost.card_unpaid.orders ? 'text-amber-700 dark:text-amber-400' : undefined} />
        <Tile icon={Ban} label={t('webPage.overview.cancelled')} value={f.int(p.lost.cancelled.orders)} sub={f.den(p.lost.cancelled.value_mkd)} />
      </div>
      <p className="text-[11px] text-muted-foreground">{t('webPage.overview.lostNote')}</p>

      {p.daily.length > 1 && (
        <Section title={t('webPage.overview.daily')} id="web-daily">
          <div className="h-56 w-full" data-testid="web-daily-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={p.daily.map((d) => ({ d: d.d, v: d.value_mkd, n: d.orders }))} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} className="stroke-border" />
                <XAxis dataKey="d" tickFormatter={(d: string) => dm(d)} tick={{ fontSize: 10 }} minTickGap={12} />
                <YAxis tick={{ fontSize: 10 }} width={48} tickFormatter={(v: number) => f.int(Math.round(v / 1000)) + 'k'} />
                <Tooltip formatter={(v: number, k: string) => (k === 'v' ? [f.den(v), t('webPage.col.value')] : [f.int(v), t('webPage.col.orders')])}
                  labelFormatter={(d: string) => dm(d, true)} />
                <Bar dataKey="v" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      <Section title={t('webPage.overview.channels')} note={t('webPage.overview.channelsNote')} id="web-channels">
        <div className="mb-3 flex flex-wrap gap-2" data-testid="web-channel-groups">
          {groups.map((g) => (
            <div key={g.group} className="min-w-[8rem] flex-1 rounded-lg border bg-background/60 px-2.5 py-1.5">
              <p className="text-[11px] text-muted-foreground">{t(`webPage.group.${g.group}`)}</p>
              <p className="text-sm font-semibold tabular-nums">{f.int(g.orders)} · {f.share(g.orders, tot.orders)}</p>
              <p className="text-[11px] tabular-nums text-muted-foreground">{f.den(g.value_mkd)}</p>
            </div>
          ))}
        </div>
        <ResponsiveTable<WebChannelRow>
          rows={p.channels} rowKey={(r) => `${r.channel}|${r.source}`} empty={t('webPage.empty')} testId="web-channels-table"
          cols={[
            { key: 'ch', label: t('webPage.col.channel'), primary: true,
              render: (r) => <span>{channelLabel(r.channel)}{r.source ? <span className="text-muted-foreground"> · {r.source}</span> : null}</span> },
            { key: 'n', label: t('webPage.col.orders'), align: 'right', render: (r) => f.int(r.orders) },
            { key: 'v', label: t('webPage.col.value'), align: 'right', render: (r) => f.den(r.value_mkd) },
            { key: 'p', label: t('webPage.col.paid'), align: 'right', render: (r) => f.den(r.paid_mkd) },
            { key: 'r', label: t('webPage.col.returned'), align: 'right', render: (r) => (r.returned ? `${f.int(r.returned)} · ${f.den(r.returned_mkd)}` : '—') },
          ]}
        />
      </Section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title={t('webPage.overview.products')} id="web-products">
          <ResponsiveTable
            rows={p.products.slice(0, 10)} rowKey={(r) => r.name} empty={t('webPage.empty')}
            cols={[
              { key: 'name', label: t('webPage.col.product'), primary: true, render: (r) => r.name },
              { key: 'q', label: t('webPage.col.qty'), align: 'right', render: (r) => f.int(r.qty) },
              { key: 'v', label: t('webPage.col.value'), align: 'right', render: (r) => f.den(r.value_mkd) },
            ]}
          />
        </Section>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <Section title={t('webPage.overview.payment')} id="web-payment">
            <ResponsiveTable
              rows={p.payment} rowKey={(r) => r.method} empty={t('webPage.empty')}
              cols={[
                { key: 'm', label: t('webPage.col.method'), primary: true, render: (r) => t(`webPage.payment.${r.method}`, { defaultValue: r.method }) },
                { key: 'n', label: t('webPage.col.orders'), align: 'right', render: (r) => f.int(r.orders) },
                { key: 'v', label: t('webPage.col.value'), align: 'right', render: (r) => f.den(r.value_mkd) },
                { key: 'r', label: t('webPage.col.returned'), align: 'right', render: (r) => f.int(r.returned) },
              ]}
            />
          </Section>
          <Section title={t('webPage.overview.coupons')} id="web-coupons">
            <ResponsiveTable
              rows={p.coupons} rowKey={(r) => r.code} empty={t('webPage.overview.noCoupons')}
              cols={[
                { key: 'c', label: t('webPage.col.coupon'), primary: true, render: (r) => <span className="font-mono text-xs">{r.code}</span> },
                { key: 'n', label: t('webPage.col.orders'), align: 'right', render: (r) => f.int(r.orders) },
                { key: 'v', label: t('webPage.col.value'), align: 'right', render: (r) => f.den(r.value_mkd) },
              ]}
            />
          </Section>
          <Section title={t('webPage.overview.cities')} id="web-cities" className="sm:col-span-2 xl:col-span-1 2xl:col-span-2">
            <ResponsiveTable
              rows={p.cities.slice(0, 10)} rowKey={(r) => r.city} empty={t('webPage.empty')}
              cols={[
                { key: 'c', label: t('webPage.col.city'), primary: true, render: (r) => r.city },
                { key: 'n', label: t('webPage.col.orders'), align: 'right', render: (r) => f.int(r.orders) },
                { key: 'v', label: t('webPage.col.value'), align: 'right', render: (r) => f.den(r.value_mkd) },
                { key: 'r', label: t('webPage.col.returned'), align: 'right', render: (r) => f.int(r.returned) },
              ]}
            />
          </Section>
        </div>
      </div>
    </div>
  );
}
