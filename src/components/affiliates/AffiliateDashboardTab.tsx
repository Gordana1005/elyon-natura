import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { apiGetAffiliates, apiGetAffiliateStats, apiGetAffiliateAdminLeads } from '@/lib/api';
import { formatEurExact, formatMoney } from '@/lib/currency';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DateRangePicker, type DateRange } from '@/components/DateRangePicker';
import { format, subDays } from 'date-fns';
import { Handshake, Loader2 } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { AffiliateKpiCards } from './AffiliateKpiCards';
import { AffiliateLeadsTable } from './AffiliateLeadsTable';
import { approveRatePct } from './affiliateStage';

// Default range = the last 30 days, matching what the partner portal shows.
const last30Days = (): DateRange => ({
  from: format(subDays(new Date(), 29), 'yyyy-MM-dd'),
  to: format(new Date(), 'yyyy-MM-dd'),
});

// Staff Dashboard tab on /affiliates-admin: the exact partner-portal view
// (same KPI tiles + leads table) PLUS staff-only super-metrics — outcome
// funnel, conversion %, avg confirmed order value, payout cost per lead and
// test counters. Read-only, so manager access is inherently safe.
//
// Money split (operator decision 2026-08-10): payout figures are EUR
// (formatEurExact) because payout_eur_snapshot is a euro obligation to the
// webmaster; avg ORDER value is Macedonian selling-side revenue and stays in
// денари (formatMoney) per this market's currency rule.
export function AffiliateDashboardTab() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [range, setRange] = useState<DateRange>(last30Days);
  const [stage, setStage] = useState('all');
  const [page, setPage] = useState(1);
  const limit = 30;

  const { data: affiliates = [], isLoading: affLoading } = useQuery({
    queryKey: ['affiliates'],
    queryFn: apiGetAffiliates,
  });

  // ?affiliate= deep-links a partner; falls back to the first one.
  const urlAff = searchParams.get('affiliate') || '';
  const affId = affiliates.some((a) => a.id === urlAff) ? urlAff : (affiliates[0]?.id ?? '');
  const selectAffiliate = (id: string) => {
    setPage(1);
    setSearchParams((prev) => ({ ...Object.fromEntries(prev), affiliate: id }));
  };

  // The stats endpoint defaults a missing `from` to the last 30 days
  // server-side, so "All time" (both bounds empty) needs an explicit floor
  // older than any lead. The leads endpoint has no default; omitted bounds
  // already mean all time there.
  const statsFrom = range.from || '2020-01-01';
  const statsTo = range.to || undefined;

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['affiliate-admin-stats', affId, range.from, range.to],
    queryFn: () => apiGetAffiliateStats(affId, statsFrom, statsTo),
    enabled: !!affId,
  });
  const { data: leads, isLoading: leadsLoading } = useQuery({
    queryKey: ['affiliate-admin-leads', affId, stage, page, range.from, range.to],
    queryFn: () => apiGetAffiliateAdminLeads(affId, {
      page, limit,
      stage: stage === 'all' ? undefined : stage,
      from: range.from || undefined,
      to: range.to || undefined,
    }),
    enabled: !!affId,
  });

  const totals = stats?.totals;
  const rows = leads?.rows || [];
  const total = leads?.total || 0;
  const pages = Math.max(1, Math.ceil(total / limit));

  const costPerLead = totals && totals.sent > 0 ? totals.payout_earned / totals.sent : 0;

  // Funnel = the outcome of the affiliate's job ONLY (operator decision:
  // nothing after confirm matters here). Confirmed = ever-confirmed, so
  // shipped/delivered/paid/returned fold into it; cancelled/trashed are
  // pre-confirm kills; pending = still-unworked leads (incl. taken);
  // call again is the current retry pile.
  const funnel = useMemo(() => {
    const tot = stats?.totals;
    if (!tot) return [];
    const s = stats?.statuses || {};
    return [
      { status: 'pending', count: (s.pending || 0) + (s.take || 0) },
      { status: 'call_again', count: s.call_again || 0 },
      { status: 'confirmed', count: tot.approved },
      { status: 'trashed', count: tot.trashed },
      { status: 'cancelled', count: tot.cancelled },
    ];
  }, [stats]);

  if (affLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  }
  if (!affId) {
    return (
      <EmptyState
        icon={<Handshake className="h-5 w-5" />}
        title={t('affiliatesAdmin.noAffiliates')}
        description={t('affiliatesAdmin.noAffiliatesDesc')}
        size="sm"
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={affId} onValueChange={selectAffiliate}>
          <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {affiliates.map((a) => <SelectItem key={a.id} value={a.id}>{a.name} ({a.code})</SelectItem>)}
          </SelectContent>
        </Select>
        <DateRangePicker value={range} onChange={(r) => { setRange(r); setPage(1); }} />
      </div>

      {statsLoading || !totals ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : (
        <>
          {/* Same KPI row the partner sees */}
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

          {/* Staff-only super-metrics */}
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">{t('affiliatesAdmin.metricsHeading')}</h2>
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="rounded-xl border bg-card shadow-sm px-4 py-4">
                <p className="text-xl font-bold">{approveRatePct(totals)}%</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('affiliatesAdmin.conversionPct')}</p>
              </div>
              <div className="rounded-xl border bg-card shadow-sm px-4 py-4">
                {/* Selling side — Macedonian retail, so денари. */}
                <p className="text-xl font-bold">{formatMoney(stats?.revenue?.avg_confirmed_eur ?? 0)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('affiliatesAdmin.avgOrderValue')}</p>
              </div>
              <div className="rounded-xl border bg-card shadow-sm px-4 py-4">
                {/* Payout side — what we owe the webmaster, so euro. */}
                <p className="text-xl font-bold">{formatEurExact(costPerLead)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('affiliatesAdmin.costPerLead')}</p>
              </div>
              <div className="rounded-xl border bg-card shadow-sm px-4 py-4">
                <p className="text-xl font-bold">{stats?.tests.test_leads ?? 0}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t('affiliatesAdmin.testLeads')}
                  <span className="block text-[10px] opacity-70">{t('affiliatesAdmin.testLeadsHint')}</span>
                </p>
              </div>
              <div className="rounded-xl border bg-card shadow-sm px-4 py-4">
                <p className="text-xl font-bold">{stats?.tests.postback_tests ?? 0}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{t('affiliatesAdmin.postbackTests')}</p>
              </div>
            </div>

            {/* Funnel by outcome */}
            {funnel.length > 0 && (
              <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/30">
                        <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">{t('affiliatesAdmin.funnelHeading')}</th>
                        <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">{t('affiliatesAdmin.colCount')}</th>
                        <th className="text-right px-4 py-2.5 font-medium text-muted-foreground">{t('affiliatesAdmin.colShare')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {funnel.map((row) => (
                        <tr key={row.status} className="border-b last:border-0">
                          <td className="px-4 py-2">{t(`status.${row.status}`)}</td>
                          <td className="px-4 py-2 text-right font-medium tabular-nums">{row.count}</td>
                          <td className="px-4 py-2 text-right text-muted-foreground tabular-nums">
                            {totals.sent > 0 ? Math.round((row.count / totals.sent) * 100) : 0}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Leads with staff extras (real PII per role privacy, ORD id, CRM status) */}
          <AffiliateLeadsTable
            title={t('affiliatesAdmin.leadsHeading')}
            rows={rows}
            isLoading={leadsLoading}
            page={page}
            pages={pages}
            total={total}
            onPageChange={setPage}
            stage={stage}
            onStageChange={(v) => { setStage(v); setPage(1); }}
            fmtMoney={formatEurExact}
            extIdLabel={t('affiliatesAdmin.colExtId')}
            emptyTitle={t('affiliatesAdmin.noLeadsRange')}
            emptyDesc={t('affiliatesAdmin.noLeadsRangeDesc')}
            staffColumns
          />
        </>
      )}
    </div>
  );
}
