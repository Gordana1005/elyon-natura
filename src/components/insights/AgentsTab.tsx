import { useTranslation } from 'react-i18next';
import { apiErrorText } from '@/i18n/apiErrors';
import { useState, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Loader2, Download, Search, Users, Target, BarChart3, X } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { EmptyState } from '@/components/EmptyState';
import { apiGetAgentFilterOptions, apiGetAgentPerformance, type AgentFilterOption, type AgentPerformanceRow } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';

// ── Agents tab (formerly the standalone "Performance" page) ──
// Lives inside the Insights hub now; brings its own filters/date controls and
// CSV export. The single authoritative per-agent sales & financial table.

type FilterPreset = 'today' | 'week' | 'month' | 'start' | 'custom';

function getDateRange(preset: FilterPreset): { from: string; to: string } | null {
  const now = new Date();
  const toStr = new Date(now.getTime() + 86400000).toISOString().substring(0, 10);
  if (preset === 'today') return { from: now.toISOString().substring(0, 10), to: toStr };
  if (preset === 'week') return { from: new Date(now.getTime() - 7 * 86400000).toISOString().substring(0, 10), to: toStr };
  if (preset === 'month') return { from: new Date(now.getTime() - 30 * 86400000).toISOString().substring(0, 10), to: toStr };
  // Start = open-ended lifetime (backend paid_at merge still applies without from)
  if (preset === 'start') return null;
  return null;
}

const fmt = (n: number | undefined | null) => { const v = n ?? 0; return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(2); };

function exportCSV(data: AgentPerformanceRow[]) {
  const header = 'Agent,Leads,Confirmed,Shipped,Paid,PackagesSold,PackagesAwaiting,Avg/Pkg,Payout,ReturnedOrders,ReturnedPackages,Cancelled,Trashed,Conv%,Ship%,Collect%,Ret%,Gross Rev,Paid Rev,Outstanding,Returned Val,Profit,AOV,Rev/Lead,Profit/Lead';
  const rows = data.map(a =>
    `"${a.full_name}",${a.leads_assigned},${a.total_confirmed},${a.total_shipped},${a.total_paid},${a.packages_sold ?? 0},${a.packages_awaiting ?? 0},${(a.avg_per_package ?? 0).toFixed(2)},${a.payout_earned ?? 0},${a.total_returned},${a.packages_returned ?? 0},${a.total_cancelled},${a.total_trashed},${a.conversion_rate},${a.shipment_rate},${a.collection_rate},${a.return_rate},${(a.gross_revenue ?? 0).toFixed(2)},${(a.paid_revenue ?? 0).toFixed(2)},${(a.outstanding_revenue ?? 0).toFixed(2)},${(a.returned_value ?? 0).toFixed(2)},${(a.total_profit ?? 0).toFixed(2)},${(a.avg_order_value ?? 0).toFixed(2)},${(a.revenue_per_lead ?? 0).toFixed(2)},${(a.profit_per_lead ?? 0).toFixed(2)}`
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `agent-performance-${new Date().toISOString().substring(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function AgentsTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const canSeeFinance = user?.isAdmin || user?.isManager;
  const isAgentSelfView = !canSeeFinance; // regular agent (incl. pending/prediction) viewing their own stats

  const [data, setData] = useState<AgentPerformanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Default to "this month" for everyone. Agents can change the range if they want historical view.
  const [filter, setFilter] = useState<FilterPreset>('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [agentFilter, setAgentFilter] = useState('all');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [showZero, setShowZero] = useState(false);

  // This filter must offer EVERY owner the table below can show — including the
  // historic name-only operators from the imported AlterCPA history, who have no
  // profiles row. Using the plain agents list here left 64 of 70 owners in the
  // table unselectable (Saska Simonovska, 5.279 orders, was one of them).
  // Separate query key from ['agents'] on purpose: that cache is the assignable
  // roster and must never grow accounts that cannot be assigned to.
  const { data: agents = [] } = useQuery<AgentFilterOption[]>({
    queryKey: ['agent-filter-options'],
    queryFn: apiGetAgentFilterOptions,
  });

  const [staffAgents, historicAgents] = useMemo(() => [
    agents.filter(a => !a.is_virtual),
    agents.filter(a => a.is_virtual),
  ], [agents]);

  const buildParams = (preset: FilterPreset, cFrom?: string, cTo?: string) => {
    let range = getDateRange(preset);
    if (preset === 'custom' && cFrom && cTo) range = { from: cFrom, to: cTo };
    return {
      from: range?.from,
      to: range?.to,
      search: search || undefined,
      source: sourceFilter !== 'all' ? sourceFilter : undefined,
      status: statusFilter !== 'all' ? statusFilter : undefined,
      agent_id: isAgentSelfView ? (user?.id || undefined) : (agentFilter !== 'all' ? agentFilter : undefined),
      include_cancelled: includeCancelled,
      show_zero: showZero,
    };
  };

  const loadData = (preset?: FilterPreset, cFrom?: string, cTo?: string) => {
    setLoading(true);
    const p = preset ?? filter;
    apiGetAgentPerformance(buildParams(p, cFrom, cTo))
      .then(setData)
      .catch((err: any) => toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' }))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // On first load, automatically scope to self for regular agents
    if (isAgentSelfView) {
      setAgentFilter(user?.id || 'all');
    }
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFilterChange = (preset: FilterPreset) => {
    setFilter(preset);
    if (preset !== 'custom') loadData(preset);
  };

  const applyFilters = () => loadData(filter, customFrom, customTo);

  const clearFilters = () => {
    setSourceFilter('all');
    setStatusFilter('all');
    setAgentFilter('all');
    setIncludeCancelled(false);
    setShowZero(false);
    setSearch('');
    setTimeout(() => loadData(filter), 0);
  };

  const hasActiveFilters = sourceFilter !== 'all' || statusFilter !== 'all' || agentFilter !== 'all' || includeCancelled || showZero || search;

  const totals = useMemo(() => {
    const s = (key: keyof AgentPerformanceRow) => data.reduce((sum, a) => sum + (Number(a[key]) || 0), 0);
    const leads = s('leads_assigned');
    const confirmed = s('total_confirmed');
    const shipped = s('total_shipped');
    const paid = s('total_paid');
    const returned = s('total_returned');
    const cancelled = s('total_cancelled');
    const trashed = s('total_trashed');
    const grossRevenue = s('gross_revenue');
    const paidRevenue = s('paid_revenue');
    const outstanding = s('outstanding_revenue');
    const returnedValue = s('returned_value');
    const profit = s('total_profit');
    const netContribution = s('net_contribution');
    const convRate = leads > 0 ? Math.round((confirmed / leads) * 10000) / 100 : 0;
    const shipRate = confirmed > 0 ? Math.round((shipped / confirmed) * 10000) / 100 : 0;
    const collectRate = shipped > 0 ? Math.round((paid / shipped) * 10000) / 100 : 0;
    const retRate = shipped > 0 ? Math.round((returned / shipped) * 10000) / 100 : 0;
    const aov = paid > 0 ? Math.round((paidRevenue / paid) * 100) / 100 : 0;
    return { leads, confirmed, shipped, paid, returned, cancelled, trashed, grossRevenue, paidRevenue, outstanding, returnedValue, profit, netContribution, convRate, shipRate, collectRate, retRate, aov };
  }, [data]);

  return (
    <div className="space-y-4">
      {/* === FILTERS === */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card/60 backdrop-blur-sm p-3">
        {/* Date presets */}
        <div className="flex items-center gap-1">
          {(['today', 'week', 'month', 'start', 'custom'] as FilterPreset[]).map(p => (
            <Button key={p} variant={filter === p ? 'default' : 'outline'} size="sm" className="h-8 text-xs" onClick={() => handleFilterChange(p)}>
              {p === 'today' ? t('agentsTab.today')
                : p === 'week' ? t('agentsTab.week')
                : p === 'month' ? t('agentsTab.month')
                : p === 'start' ? t('agentsTab.start')
                : t('agentsTab.custom')}
            </Button>
          ))}
        </div>

        {filter === 'custom' && (
          <div className="flex items-center gap-2">
            <Input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className="h-8 w-auto text-xs" />
            <span className="text-muted-foreground text-xs">to</span>
            <Input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className="h-8 w-auto text-xs" />
          </div>
        )}

        {/* Agent filter - hidden for regular agents (they only see themselves) */}
        {!isAgentSelfView && (
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger className="w-48 h-8 text-xs">
              <SelectValue placeholder={t('agentsTab.allAgents')} />
            </SelectTrigger>
            <SelectContent className="max-h-80">
              <SelectItem value="all">{t('agentsTab.allAgents')}</SelectItem>
              {staffAgents.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t('agentsTab.groupStaff')}
                  </SelectLabel>
                  {staffAgents.map(a => (
                    <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>
                  ))}
                </SelectGroup>
              )}
              {/* Operators who exist only as a name on the imported history — no
                  login, no account. They own the bulk of the orders in the table
                  below, so the filter has to offer them; the group label is what
                  keeps them from reading as current staff. */}
              {historicAgents.length > 0 && (
                <SelectGroup>
                  <SelectLabel className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    {t('agentsTab.groupHistoric')}
                  </SelectLabel>
                  {historicAgents.map(a => (
                    <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        )}

        {/* Source */}
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-36 h-8 text-xs">
            <SelectValue placeholder={t('agentsTab.allSources')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('agentsTab.allSources')}</SelectItem>
            <SelectItem value="prediction">{t('agentsTab.prediction')}</SelectItem>
            <SelectItem value="inbound_lead">{t('agentsTab.webhook')}</SelectItem>
            <SelectItem value="manual">{t('agentsTab.manual')}</SelectItem>
          </SelectContent>
        </Select>

        {/* Status */}
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-32 h-8 text-xs">
            <SelectValue placeholder={t('agentsTab.allStatuses')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('agentsTab.allStatuses')}</SelectItem>
            <SelectItem value="confirmed">{t('status.confirmed')}</SelectItem>
            <SelectItem value="shipped">{t('status.shipped')}</SelectItem>
            <SelectItem value="paid">{t('status.paid')}</SelectItem>
            <SelectItem value="returned">{t('status.returned')}</SelectItem>
          </SelectContent>
        </Select>

        {/* Toggles */}
        <div className="flex items-center gap-2">
          <Switch id="incCanc" checked={includeCancelled} onCheckedChange={setIncludeCancelled} className="scale-75" />
          <Label htmlFor="incCanc" className="text-xs text-muted-foreground cursor-pointer">{t('status.cancelled')}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="showZero" checked={showZero} onCheckedChange={setShowZero} className="scale-75" />
          <Label htmlFor="showZero" className="text-xs text-muted-foreground cursor-pointer">{t('agentsTab.showZero')}</Label>
        </div>

        {/* Apply / Clear */}
        <Button size="sm" className="h-8 text-xs" onClick={applyFilters}>{t('agentsTab.apply')}</Button>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={clearFilters}>
            <X className="h-3 w-3 mr-1" /> Clear
          </Button>
        )}

        {/* Search + Export */}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input placeholder={t('agentsTab.searchAgent')} value={search} onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyFilters()} className="h-8 pl-7 w-40 text-xs" />
          </div>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => exportCSV(data)} disabled={data.length === 0}>
            <Download className="h-3.5 w-3.5 mr-1" /> CSV
          </Button>
        </div>
      </div>

      {/* === SUMMARY SECTIONS === */}
      {/* Activity */}
      <Card className="border-none shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" /> Sales Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <SummaryCard label={t('agentsTab.leadsAssigned')} value={String(totals.leads)} desc={t('agentsTab.allOrdersAssigned')} />
            <SummaryCard label={t('status.confirmed')} value={String(totals.confirmed)} desc={t('agentsTab.confirmedPlus')} />
            <SummaryCard label={t('status.shipped')} value={String(totals.shipped)} desc={t('agentsTab.shippedPlus')} />
            <SummaryCard label={t('status.paid')} value={String(totals.paid)} accent desc={t('agentsTab.statusPaid')} />
            <SummaryCard label={t('status.returned')} value={String(totals.returned)} negative desc={t('agentsTab.statusReturned')} />
            <SummaryCard label={t('status.cancelled')} value={String(totals.cancelled)} negative desc={t('agentsTab.statusCancelled')} />
            <SummaryCard label={t('status.trashed')} value={String(totals.trashed)} negative desc={t('agentsTab.junkWrong')} />
          </div>
        </CardContent>
      </Card>

      {/* Quality */}
      <Card className="border-none shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
            <Target className="h-4 w-4 text-primary" /> Sales Quality
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <SummaryCard label={t('agentsTab.conversionRate')} value={`${totals.convRate}%`} desc={t('agentsTab.convDesc')} />
            <SummaryCard label={t('agentsTab.shipmentRate')} value={`${totals.shipRate}%`} desc={t('agentsTab.shipDesc')} />
            <SummaryCard label={t('agentsTab.collectionRate')} value={`${totals.collectRate}%`} desc={t('agentsTab.collectDesc')} accent />
            <SummaryCard label={t('agentsTab.returnRate')} value={`${totals.retRate}%`} negative={totals.retRate > 10} desc={t('agentsTab.retDesc')} />
          </div>
        </CardContent>
      </Card>

      {/* Financial */}
      <Card className="border-none shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-primary" /> Financial Impact
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className={`grid grid-cols-2 sm:grid-cols-3 ${canSeeFinance ? 'lg:grid-cols-9' : 'lg:grid-cols-4'} gap-3`}>
            {canSeeFinance && <SummaryCard label={t('agentsTab.grossRevenue')} value={fmt(totals.grossRevenue)} accent desc={t('agentsTab.shippedPaid')} />}
            <SummaryCard label={t('agentsTab.paidRevenue')} value={fmt(totals.paidRevenue)} accent desc={t('agentsTab.paidOnly')} />
            {canSeeFinance && <SummaryCard label={t('agentsTab.outstanding')} value={fmt(totals.outstanding)} desc={t('agentsTab.shippedOnly')} />}
            {canSeeFinance && <SummaryCard label={t('agentsTab.returnedVal')} value={fmt(totals.returnedValue)} negative desc={t('agentsTab.returnedOnly')} />}
            {canSeeFinance && <SummaryCard label={t('agentsTab.profit')} value={fmt(totals.profit)} accent desc={t('agentsTab.paidMinusCost')} />}
            {canSeeFinance && <SummaryCard label={t('agentsTab.netContrib')} value={fmt(totals.netContribution)} accent={totals.netContribution > 0} negative={totals.netContribution < 0} desc={t('agentsTab.netContribDesc')} />}
            <SummaryCard label={t('agentsTab.avgOrder')} value={fmt(totals.aov)} desc={t('agentsTab.aovDesc')} />
            {canSeeFinance && <SummaryCard label={t('agentsTab.revPerLead')} value={totals.leads > 0 ? fmt(totals.paidRevenue / totals.leads) : '0'} desc={t('agentsTab.revLeadDesc')} />}
            {canSeeFinance && <SummaryCard label={t('agentsTab.profitPerLead')} value={totals.leads > 0 ? fmt(totals.profit / totals.leads) : '0'} desc={t('agentsTab.profitLeadDesc')} />}
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : data.length === 0 ? (
        <EmptyState
          icon={<BarChart3 className="h-5 w-5" />}
          title={t('agentsTab.noData')}
          description={t('agentsTab.noDataDesc')}
          size="md"
        />
      ) : (
        <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="text-left px-3 py-3 font-medium text-muted-foreground">#</th>
                  <th className="text-left px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colAgent')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colLeads')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colConf')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colShip')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('status.paid')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground" title={t('agentsTab.packagesSoldTitle')}>{t('agentsTab.colPackages')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground" title={t('agentsTab.packagesAwaitingTitle')}>{t('agentsTab.colAwaiting')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground" title={t('agentsTab.avgPkgTitle')}>{t('agentsTab.colAvgPkg')}</th>
                  {(canSeeFinance || isAgentSelfView) && (
                    <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colPayout')}</th>
                  )}
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground" title={t('agentsTab.returnsTitle')}>{t('agentsTab.colRet')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colCanc')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground" title={t('agentsTab.trashTitle')}>{t('agentsTab.colTrash')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colConvPct')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colCollPct')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colRetPct')}</th>
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colPaidRev')}</th>
                  {canSeeFinance && <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colOutstand')}</th>}
                  {canSeeFinance && <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colProfit')}</th>}
                  {canSeeFinance && <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colNetC')}</th>}
                  <th className="text-right px-3 py-3 font-medium text-muted-foreground">{t('agentsTab.colAov')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((a, i) => (
                  <tr key={a.user_id} className="border-b last:border-0 hover:bg-muted/10 transition-colors">
                    <td className="px-3 py-3 text-muted-foreground">{i + 1}</td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary shrink-0">
                          {a.full_name.charAt(0)}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-card-foreground truncate">{a.full_name}</p>
                          {/* A virtual row is an operator from the imported history
                              with no CRM account — say so, instead of leaving a
                              blank line that reads like a staff member missing an
                              email address. */}
                          {a.is_virtual ? (
                            <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {t('agentsTab.historicOperator')}
                            </span>
                          ) : (
                            <p className="text-xs text-muted-foreground truncate">{a.email}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right">{a.leads_assigned}</td>
                    <td className="px-3 py-3 text-right">{a.total_confirmed}</td>
                    <td className="px-3 py-3 text-right">{a.total_shipped}</td>
                    <td className="px-3 py-3 text-right font-semibold">{a.total_paid}</td>
                    <td className="px-3 py-3 text-right font-semibold">{a.packages_sold ?? '—'}</td>
                    <td className="px-3 py-3 text-right text-muted-foreground">{a.packages_awaiting ?? '—'}</td>
                    <td className="px-3 py-3 text-right">{a.avg_per_package ? fmt(a.avg_per_package) : '—'}</td>
                    {(canSeeFinance || isAgentSelfView) && (
                      <td className="px-3 py-3 text-right font-semibold text-emerald-600">
                        {a.payout_earned ? fmt(a.payout_earned) : '—'}
                      </td>
                    )}
                    <td className="px-3 py-3 text-right text-destructive">
                      {a.total_returned}
                      {(a.packages_returned ?? 0) > 0 && (
                        <span className="text-xs text-muted-foreground ml-1">({a.packages_returned} pkg)</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right text-muted-foreground">{a.total_cancelled}</td>
                    <td className="px-3 py-3 text-right text-muted-foreground">{a.total_trashed ?? 0}</td>
                    <td className="px-3 py-3 text-right">
                      <RateBadge value={a.conversion_rate ?? 0} thresholds={[25, 50]} />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <RateBadge value={a.collection_rate ?? 0} thresholds={[40, 70]} />
                    </td>
                    <td className="px-3 py-3 text-right">
                      <RateBadge value={a.return_rate ?? 0} thresholds={[15, 5]} invert />
                    </td>
                    <td className="px-3 py-3 text-right font-semibold text-primary">{fmt(a.paid_revenue)}</td>
                    {canSeeFinance && <td className="px-3 py-3 text-right">{fmt(a.outstanding_revenue)}</td>}
                    {canSeeFinance && <td className="px-3 py-3 text-right font-semibold">{fmt(a.total_profit)}</td>}
                    {canSeeFinance && <td className={`px-3 py-3 text-right font-semibold ${(a.net_contribution ?? 0) < 0 ? 'text-destructive' : 'text-primary'}`}>{fmt(a.net_contribution)}</td>}
                    <td className="px-3 py-3 text-right">{fmt(a.avg_order_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function RateBadge({ value, thresholds, invert }: { value: number; thresholds: [number, number]; invert?: boolean }) {
  let color: string;
  if (invert) {
    color = value <= thresholds[1] ? 'bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]' : value <= thresholds[0] ? 'bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]' : 'bg-destructive/10 text-destructive';
  } else {
    color = value >= thresholds[1] ? 'bg-[hsl(var(--success))]/10 text-[hsl(var(--success))]' : value >= thresholds[0] ? 'bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]' : 'bg-destructive/10 text-destructive';
  }
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}>{value}%</span>;
}

function SummaryCard({ label, value, accent, negative, desc }: { label: string; value: string; accent?: boolean; negative?: boolean; desc?: string }) {
  return (
    <div className={`rounded-xl border bg-card p-3 shadow-sm ${accent ? 'ring-1 ring-primary/20' : ''}`}>
      <p className="text-xs text-muted-foreground truncate">{label}</p>
      <p className={`text-lg font-bold truncate ${accent ? 'text-primary' : negative ? 'text-destructive' : 'text-card-foreground'}`}>{value}</p>
      {desc && <p className="text-[10px] text-muted-foreground mt-0.5">{desc}</p>}
    </div>
  );
}
