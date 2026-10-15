import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AtSign, BadgeCheck, Coins, Repeat, Users } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadError } from '@/components/insights/shared/LoadError';
import { formatDmy } from '@/components/insights/shared/period';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { RECENCY_KEYS, apiWebCustomers } from '@/lib/webApi';
import { ResponsiveTable, Section, Tile } from './parts';

/**
 * Купувачи — the shop's customers (mirrored hourly) as COUNTS for the coming e-mail campaigns:
 * how many have an e-mail / the marketing tick / an account / loyalty points, and the recency
 * segments (the last purchase anywhere — web or a call-centre sale on the same phone). No names
 * and no e-mails ever reach the browser. Brevo is prepared, not switched on.
 */
export function WebCustomersTab({ f }: { f: InsightsFormat }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['insights-web-customers'], queryFn: ({ signal }) => apiWebCustomers(signal), staleTime: 5 * 60_000 });
  if (q.isError && !q.data) return <LoadError text={t('webPage.loadFailed')} onRetry={() => q.refetch()} />;
  if (!q.data) return <div className="space-y-3" aria-hidden><Skeleton variant="card" className="h-28" /><Skeleton variant="card" className="h-64" /></div>;
  const c = q.data;
  const rows = RECENCY_KEYS.map((k) => ({ k, ...c.recency[k] }));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
        <Tile icon={Users} label={t('webPage.customers.total')} value={f.int(c.total)} testId="web-customers-total" />
        <Tile icon={AtSign} label={t('webPage.customers.withEmail')} value={f.int(c.with_email)} sub={f.share(c.with_email, c.total)} />
        <Tile icon={BadgeCheck} label={t('webPage.customers.optedIn')} value={f.int(c.opted_in)} sub={f.share(c.opted_in, c.total)} />
        <Tile icon={Repeat} label={t('webPage.customers.repeat')} value={f.int(c.repeat)} sub={f.share(c.repeat, c.total)} />
        <Tile icon={Coins} label={t('webPage.customers.points')} value={f.int(c.with_points)}
          sub={t('webPage.customers.pointsSub', { n: f.int(c.points_total) })} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Section title={t('webPage.customers.segments')} note={t('webPage.customers.segmentsNote')} id="web-segments">
          <ResponsiveTable
            rows={rows} rowKey={(r) => r.k} empty={t('webPage.empty')} testId="web-segments-table"
            cols={[
              { key: 'k', label: t('webPage.customers.segment'), primary: true, render: (r) => (
                <span>
                  <span className="block">{t(`webPage.customers.recency.${r.k}`)}</span>
                  <span className="block text-[11px] text-muted-foreground">{t(`webPage.customers.use.${r.k}`)}</span>
                </span>
              ) },
              { key: 'n', label: t('webPage.customers.count'), align: 'right', render: (r) => f.int(r.count) },
              { key: 'e', label: t('webPage.customers.withEmailShort'), align: 'right', render: (r) => f.int(r.with_email) },
            ]}
          />
        </Section>
        <Section title={t('webPage.customers.cities')} id="web-cust-cities">
          <ResponsiveTable
            rows={c.cities} rowKey={(r) => r.city} empty={t('webPage.empty')}
            cols={[
              { key: 'c', label: t('webPage.col.city'), primary: true, render: (r) => r.city },
              { key: 'n', label: t('webPage.customers.count'), align: 'right', render: (r) => f.int(r.count) },
            ]}
          />
        </Section>
      </div>

      <Section title={t('webPage.customers.campaigns')} id="web-campaigns-soon">
        <p className="text-sm text-muted-foreground">{t('webPage.customers.campaignsText')}</p>
      </Section>
      <p className="text-[11px] text-muted-foreground">
        {t('webPage.customers.footer', { synced: c.synced_at ? formatDmy(c.synced_at.slice(0, 10)) : '—' })}
      </p>
    </div>
  );
}
