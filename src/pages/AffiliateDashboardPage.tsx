import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AppLayout } from '@/layouts/AppLayout';
import { apiGetAffiliatePortalStats, apiGetAffiliatePortalLeads } from '@/lib/api';
import { formatEurExact } from '@/lib/currency';
import { DateRangePicker, type DateRange } from '@/components/DateRangePicker';
import { format, subDays } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { AffiliateKpiCards } from '@/components/affiliates/AffiliateKpiCards';
import { AffiliateLeadsTable } from '@/components/affiliates/AffiliateLeadsTable';

// Affiliate-facing money is EUR: payout_eur_snapshot IS euro, and it is what
// the webmaster invoices us for. This is the one deliberate exception to the
// Macedonian denari-only UI rule (operator decision 2026-08-10) — see
// CLAUDE.md and .grok/skills/elyon-currency. Do not "correct" it to formatMoney.

// Default range = the last 30 days, matching the staff Dashboard tab.
const last30Days = (): DateRange => ({
  from: format(subDays(new Date(), 29), 'yyyy-MM-dd'),
  to: format(new Date(), 'yyyy-MM-dd'),
});

export default function AffiliateDashboardPage() {
  const { t } = useTranslation();
  const [range, setRange] = useState<DateRange>(last30Days);
  const [stage, setStage] = useState('all');
  const [page, setPage] = useState(1);
  const limit = 30;

  // The stats endpoint defaults a missing `from` to the last 30 days
  // server-side, so "All time" (both bounds empty) needs an explicit floor
  // older than any lead. The leads endpoint has no default; omitted bounds
  // already mean all time there.
  const statsFrom = range.from || '2020-01-01';

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['affiliate-portal-stats', range.from, range.to],
    queryFn: () => apiGetAffiliatePortalStats(statsFrom, range.to || undefined),
  });
  const { data: leads, isLoading: leadsLoading } = useQuery({
    queryKey: ['affiliate-portal-leads', stage, page, range.from, range.to],
    queryFn: () => apiGetAffiliatePortalLeads({
      page, limit,
      stage: stage === 'all' ? undefined : stage,
      from: range.from || undefined,
      to: range.to || undefined,
    }),
  });

  const totals = stats?.totals;
  const rows = leads?.rows || [];
  const total = leads?.total || 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <AppLayout title={t('affiliate.dashboardTitle')}>
      <div className="space-y-6">
        <DateRangePicker value={range} onChange={(r) => { setRange(r); setPage(1); }} />

        {statsLoading || !totals ? (
          <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : (
          <AffiliateKpiCards
            totals={totals}
            fmtMoney={formatEurExact}
            labels={{
              sent: t('affiliate.kpiSent'),
              approveRate: t('affiliate.kpiApproveRate'),
              buyoutRate: t('affiliate.kpiBuyoutRate'),
              approved: t('affiliate.kpiHold'),
              payoutEarned: t('affiliate.kpiPayoutEarned'),
            }}
          />
        )}

        <AffiliateLeadsTable
          title={t('affiliate.myLeads')}
          rows={rows}
          isLoading={leadsLoading}
          page={page}
          pages={pages}
          total={total}
          onPageChange={setPage}
          stage={stage}
          onStageChange={(v) => { setStage(v); setPage(1); }}
          fmtMoney={formatEurExact}
          extIdLabel={t('affiliate.colYourId')}
          emptyTitle={t('affiliate.noLeads')}
          emptyDesc={t('affiliate.noLeadsDesc')}
        />
      </div>
    </AppLayout>
  );
}
