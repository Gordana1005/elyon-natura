import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/layouts/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DateRangePicker, defaultRange, type DateRange } from '@/components/DateRangePicker';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Loader2, TrendingUp, RotateCcw, BarChart3, MapPin, Package, Users, Phone,
  PackageX, Coins, Truck, AlertTriangle, Trash2, ListChecks,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  apiGetManagementInsights, apiGetInsightsCalls,
  type InsightsResponse, type InsightsCallsResponse,
} from '@/lib/api';
import { formatMoney } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/EmptyState';
import { useAuth } from '@/contexts/AuthContext';
import { useInsightsAccess } from '@/contexts/PermissionsContext';
import { cancelReasonLabel } from '@/lib/cancellationReasons';
import { apiErrorText } from '@/i18n/apiErrors';
import { fmtDuration as fmtDur } from '@/lib/design-utils';
import { KpiCard as Kpi } from '@/components/insights/KpiCard';
import AgentsTab from '@/components/insights/AgentsTab';
import PayoutTab from '@/components/insights/PayoutTab';
import CallActivityTimeline from '@/components/insights/CallActivityTimeline';
import PureProfitExportDialog from '@/components/insights/PureProfitExportDialog';
import MarginLabTab from '@/components/insights/MarginLabTab';
import ChannelPLCard from '@/components/insights/ChannelPLCard';
import AffiliateBreakdownCard from '@/components/insights/AffiliateBreakdownCard';
import OverviewTab from '@/components/insights/overview/OverviewTab';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const cap = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

// Tab catalogue. `need` keys into useInsightsAccess(). The money tabs
// (`business`) are OWNERS ONLY — owner ruling 2026-09-27, no admin bypass —
// while Agents / Payout / Call Activity keep their module rules (Agents also
// honours the legacy Performance key, so nobody lost the old standalone page).
const TAB_DEFS = [
  // The connected Overview brings its own data, filter row and money gate
  // (meta.money): owners see money, admins/managers the same page counted.
  { value: 'overview', labelKey: 'insights.tabOverview', need: 'overview' },
  { value: 'sales', labelKey: 'insights.tabSales', need: 'business' },
  { value: 'agents', labelKey: 'insights.tabAgents', need: 'agents' },
  { value: 'payout', labelKey: 'insights.tabPayout', need: 'payout' },
  { value: 'pure-profit', labelKey: 'insights.tabPureProfit', need: 'business' },
  { value: 'margin-lab', labelKey: 'insights.tabMarginLab', need: 'business' },
  { value: 'prediction-lists', labelKey: 'insights.tabPredictionLists', need: 'business' },
  { value: 'stock', labelKey: 'insights.tabStock', need: 'business' },
  { value: 'returns', labelKey: 'insights.tabReturns', need: 'business' },
  { value: 'call-activity', labelKey: 'insights.tabCallActivity', need: 'calls' },
] as const;

// Every tab that renders from the full (owners-only) aggregate.
const MONEY_TABS = new Set<string>(TAB_DEFS.filter(d => d.need === 'business').map(d => d.value));

export default function ManagementInsightsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [searchParams, setSearchParams] = useSearchParams();

  // Per-area access — shared with the sidebar, see useInsightsAccess().
  const access = useInsightsAccess();
  const tabs = TAB_DEFS.filter(tab => access[tab.need]);

  // The default is always a tab this user can actually see.
  const requested = searchParams.get('tab');
  const activeTab = tabs.some(tab => tab.value === requested) ? requested! : (tabs[0]?.value ?? 'overview');
  const moneyTab = MONEY_TABS.has(activeTab);
  const onCalls = activeTab === 'call-activity';

  // OWNERS: the full aggregate (money tabs + the Call Activity KPI block) —
  // only on a tab that needs it, never while the operator sits on
  // Agents/Payout, which bring their own (also heavy) requests. The key
  // carries the login, so a cached owner response can never render for the
  // next person who signs in on this browser.
  const queryClient = useQueryClient();
  const fullQ = useQuery<InsightsResponse>({
    queryKey: ['insights', user?.id, range.from, range.to],
    queryFn: ({ signal }) => apiGetManagementInsights({ from: range.from || undefined, to: range.to || undefined }, signal),
    staleTime: 5 * 60_000,
    enabled: access.business && (moneyTab || onCalls),
    // Keep the previous range's numbers on screen while the new ones load, instead
    // of blanking every tab to a spinner. On a wide range that spinner is the whole
    // wait. `retry` is 0 rather than the global 1 because retrying a heavy aggregate
    // silently doubles an already-long wait before the operator sees any error.
    placeholderData: keepPreviousData,
    retry: 0,
  });

  // NON-OWNERS on Call Activity: the calls-only slice (?scope=calls) — the
  // one part of this endpoint the server gives them. Admin/manager only,
  // mirroring the server gate; any other role granted call_activity keeps
  // the timeline alone, exactly as before.
  const canCallsSlice = !access.business && access.calls && !!(user?.isAdmin || user?.isManager);
  const callsQ = useQuery<InsightsCallsResponse>({
    queryKey: ['insights', 'calls', user?.id, range.from, range.to],
    queryFn: ({ signal }) => apiGetInsightsCalls({ from: range.from || undefined, to: range.to || undefined }, signal),
    staleTime: 5 * 60_000,
    enabled: canCallsSlice && onCalls,
    placeholderData: keepPreviousData,
    retry: 0,
  });

  const activeQ = access.business ? fullQ : callsQ;
  const { isFetching, isLoading } = activeQ;
  // Money only ever renders from the owner query, and only for an owner.
  const data = access.business ? fullQ.data : undefined;
  const callsBlock = access.business ? fullQ.data?.calls : callsQ.data?.calls;
  const callsError = access.business ? fullQ.error : callsQ.error;
  const errorText = (err: unknown) =>
    err instanceof Error && err.message === 'owners_only' ? t('insights.ownersOnly') : apiErrorText(err);

  // After ~3s of fetching, upgrade the silent spinner to elapsed-seconds + a
  // Cancel button, so a wide range never looks like a hang.
  const [slowSecs, setSlowSecs] = useState(0);
  useEffect(() => {
    if (!isFetching) { setSlowSecs(0); return; }
    const id = setInterval(() => setSlowSecs(s => s + 1), 1000);
    return () => clearInterval(id);
  }, [isFetching]);

  // The date range drives the aggregate tabs and the Call Activity KPIs;
  // Agents/Payout bring their own filter bars.
  const showRangePicker = access.business ? (moneyTab || onCalls) : (canCallsSlice && onCalls);

  if (tabs.length === 0) {
    return (
      <AppLayout title={t('nav.insights')}>
        <EmptyState icon={<BarChart3 className="h-5 w-5" />} title={t('insights.noAccess')} description={t('insights.noAccessDesc')} />
      </AppLayout>
    );
  }

  return (
    <AppLayout title={t('nav.insights')}>
      <div className="space-y-5">
        {showRangePicker && (
          <div className="flex items-center gap-2">
            <div className="flex flex-col gap-1">
              <DateRangePicker value={range} onChange={setRange} simple />
              <p className="text-[11px] text-muted-foreground">{t('insights.workClockFromAugust')}</p>
            </div>
            {/* keepPreviousData leaves the OLD numbers on screen while a new range
                loads. Without this the operator can't tell they're looking at the
                previous range's figures. Past ~3s the spinner gains elapsed time
                and a Cancel, so a wide range never reads as a hang. */}
            {isFetching && slowSecs >= 3 ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                <span>{t('insights.slowLoading', { s: slowSecs })}</span>
                <Button
                  variant="ghost" size="sm" className="h-6 px-2 text-xs"
                  onClick={() => queryClient.cancelQueries({ queryKey: ['insights'] })}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            ) : isFetching && !isLoading ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : null}
          </div>
        )}

        <Tabs value={activeTab} onValueChange={(v) => setSearchParams({ tab: v })}>
          <TabsList className="h-auto">
            {tabs.map(tab => <TabsTrigger key={tab.value} value={tab.value}>{t(tab.labelKey)}</TabsTrigger>)}
          </TabsList>

          {moneyTab && !data ? (
            // A failed aggregate says so — it never spins forever.
            fullQ.isError ? (
              <div className="mt-4"><LoadError text={errorText(fullQ.error)} onRetry={() => { void fullQ.refetch(); }} /></div>
            ) : (
              <div className="flex items-center justify-center py-24"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
            )
          ) : (
            <>
              {access.overview && (
                <TabsContent value="overview" className="mt-4"><OverviewTab /></TabsContent>
              )}

              {access.business && data && <>
                <TabsContent value="sales" className="mt-4"><Sales data={data} /></TabsContent>
                <TabsContent value="pure-profit" className="mt-4"><PureProfit data={data} range={range} canExport={access.business} /></TabsContent>
                <TabsContent value="margin-lab" className="mt-4"><MarginLabTab data={data} /></TabsContent>
                <TabsContent value="prediction-lists" className="mt-4"><PredictionLists data={data} /></TabsContent>
                <TabsContent value="stock" className="mt-4"><Stock data={data} /></TabsContent>
                <TabsContent value="returns" className="mt-4"><Returns data={data} /></TabsContent>
              </>}

              {access.agents && (
                <TabsContent value="agents" className="mt-4"><AgentsTab /></TabsContent>
              )}

              {access.payout && (
                <TabsContent value="payout" className="mt-4"><PayoutTab /></TabsContent>
              )}

              {access.calls && (
                <TabsContent value="call-activity" className="mt-4">
                  <div className="space-y-5">
                    {callsBlock ? <Calls c={callsBlock} /> : callsError ? (
                      <LoadError text={errorText(callsError)} onRetry={() => { void activeQ.refetch(); }} />
                    ) : null}
                    <CallActivityTimeline />
                  </div>
                </TabsContent>
              )}
            </>
          )}
        </Tabs>
      </div>
    </AppLayout>
  );
}

const moneyTip = (v: number) => formatMoney(v);

function Sales({ data }: { data: InsightsResponse }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Package className="h-4 w-4" /> Top products by revenue</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={data.sales.by_product.slice(0, 12)} layout="vertical" margin={{ left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis dataKey="product" type="category" tick={{ fontSize: 10 }} width={130} />
              <Tooltip formatter={(v: any, n: any) => n === 'revenue' ? moneyTip(Number(v)) : v} />
              <Bar dataKey="revenue" fill="hsl(27,95%,48%)" name="revenue" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
      <ListCard title={i18n.t('insights.revenueByCity')} icon={MapPin} rows={data.sales.by_city} nameKey="city"
        cols={[{ k: 'orders', label: i18n.t('insights.orders') }, { k: 'revenue', label: i18n.t('insights.revenue'), money: true }]} />
      <ListCard title={i18n.t('insights.byDeliveryMethod')} icon={Truck} rows={data.sales.by_delivery} nameKey="delivery"
        cols={[{ k: 'orders', label: i18n.t('insights.orders') }, { k: 'revenue', label: i18n.t('insights.revenue'), money: true }]} transformName={cap} />
      <ListCard title={i18n.t('insights.bySource')} icon={TrendingUp} rows={data.sales.by_source} nameKey="source"
        cols={[{ k: 'orders', label: i18n.t('insights.orders') }, { k: 'revenue', label: i18n.t('insights.revenue'), money: true }]} transformName={cap}
        note="Historical orders are mostly 'manual' imports; source detail grows as webhook/lead orders come in." />
    </div>
  );
}

// Dual EUR/LEV money display (elyon-currency skill): EUR primary, LEV muted.
function Money({ eur, className }: { eur: number; className?: string }) {
  return (
    <span className={className}>
      {formatMoney(eur)}{' '}

    </span>
  );
}

const courierServiceLabel = (k: string): string => ({
  econt_office: i18n.t('insights.econtOffice'), econt_door: i18n.t('insights.econtDoor'),
  speedy_office: i18n.t('insights.speedyOffice'), speedy_door: i18n.t('insights.speedyDoor'),
  mex_office: i18n.t('insights.mexOffice'), mex_door: i18n.t('insights.mexDoor'),
  unknown: i18n.t('insights.courierNotRecorded'),
}[k] || k);

function PureProfit({ data, range, canExport }: { data: InsightsResponse; range: DateRange; canExport: boolean }) {
  const pp = data.pure_profit;
  const hasPureProfit = !!pp;

  // Costs (new actuals fields, with safe fallbacks to the legacy keys).
  const cash = pp?.cash_collected ?? 0;
  const vat = pp?.vat ?? 0;
  const vatPct = Math.round((pp?.vat_rate ?? 0.2) * 100);
  const cogs = pp?.cogs ?? 0;
  const commissions = pp?.agent_commissions ?? pp?.special_agent_commissions ?? 0;
  const delivery = pp?.delivery_cost ?? 0;
  const returnLoss = pp?.return_loss ?? 0;
  const clear = pp?.clear_profit ?? 0;
  const totalCosts = vat + cogs + commissions + delivery + returnLoss;
  const costCoverage = pp?.cost_coverage ?? 1;
  const missingCost = pp?.products_missing_cost ?? [];

  const byProduct = pp?.by_product || [];
  const paidOrders = pp?.paid_orders ?? 0;
  const paidPackages = pp?.paid_packages ?? 0;
  const packagesPerOrder = pp?.packages_per_order ?? 0;

  const logistics = data.logistics || [];
  const logiTotals = logistics.reduce(
    (t, l) => ({
      delivered: t.delivered + l.delivered, returned: t.returned + l.returned,
      deliver_cost: t.deliver_cost + l.deliver_cost, return_cost: t.return_cost + l.return_cost,
      total_cost: t.total_cost + l.total_cost,
    }),
    { delivered: 0, returned: 0, deliver_cost: 0, return_cost: 0, total_cost: 0 },
  );

  // Agents with payout data
  const agentsWithPayout = (data.agents || []).filter((a: any) => (a.payout_earned ?? 0) > 0)
    .sort((a: any, b: any) => (b.payout_earned ?? 0) - (a.payout_earned ?? 0));

  return (
    <div className="space-y-4">
      {/* The export carries the whole money picture — owners only. */}
      {canExport && (
        <div className="flex justify-end">
          <PureProfitExportDialog data={data} range={range} />
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi
          icon={Coins}
          label={i18n.t('insights.kpiCash')}
          value={hasPureProfit ? formatMoney(cash) : '—'}
          tone="bg-emerald-100 text-emerald-700"
        />
        <Kpi
          icon={Coins}
          label={i18n.t('insights.kpiVat', { pct: vatPct })}
          value={hasPureProfit ? `−${formatMoney(vat)}` : '—'}
          tone="bg-rose-100 text-rose-700"
        />
        <Kpi
          icon={Package}
          label={i18n.t('insights.kpiCogs')}
          value={hasPureProfit ? `−${formatMoney(cogs)}` : '—'}
        />
        <Kpi
          icon={Truck}
          label={i18n.t('insights.kpiDelivery')}
          value={hasPureProfit ? `−${formatMoney(delivery + returnLoss)}` : '—'}
          tone="bg-sky-100 text-sky-700"
        />
        <Kpi
          icon={Users}
          label={i18n.t('insights.kpiCommissions')}
          value={hasPureProfit ? `−${formatMoney(commissions)}` : '—'}
          tone="bg-amber-100 text-amber-700"
        />
        <Kpi
          icon={TrendingUp}
          label={i18n.t('insights.kpiClear')}
          value={hasPureProfit ? formatMoney(clear) : '—'}
          tone="bg-primary/10 text-primary"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Coins className="h-4 w-4" /> Pure Profit Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!hasPureProfit ? (
            <div className="text-sm text-muted-foreground">{i18n.t('insights.noPureProfit')}</div>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="font-medium text-emerald-700">{i18n.t('insights.cashCollected')}</span>
                <Money eur={cash} className="font-semibold text-emerald-700" />
              </div>
              <div className="flex justify-between text-rose-600">
                <span>{i18n.t('insights.vatLine', { pct: vatPct })}</span>
                <span className="font-semibold">−<Money eur={vat} /></span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>{i18n.t('insights.cogsLine')}</span>
                <span className="font-semibold">−<Money eur={cogs} /></span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>{i18n.t('insights.deliveryLine')}</span>
                <span className="font-semibold">−<Money eur={delivery} /></span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>{i18n.t('insights.returnLossLine')}</span>
                <span className="font-semibold">−<Money eur={returnLoss} /></span>
              </div>
              <div className="flex justify-between text-amber-600">
                <span>{i18n.t('insights.commissionsLine')}</span>
                <span className="font-semibold">−<Money eur={commissions} /></span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground border-t pt-2">
                <span>{i18n.t('insights.totalCosts')}</span>
                <span>−{formatMoney(totalCosts)}</span>
              </div>
              <div className="border-t pt-2 flex justify-between font-bold text-lg">
                <span>{i18n.t('insights.clearMoney')}</span>
                <Money eur={clear} />
              </div>
              <div className="text-xs text-muted-foreground pt-1">
                {i18n.t('insights.cashBasisNote')}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {hasPureProfit && costCoverage < 1 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 flex gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">{i18n.t('insights.coverageKnown', { pct: (costCoverage * 100).toFixed(1) })}</span>
            {i18n.t('insights.coverageWarning')}<span className="font-medium">{missingCost.join(', ')}</span>
          </div>
        </div>
      )}

      {/* Where the money came from: the same waterfall split by channel, plus
          the per-affiliator (webmaster) breakdown. Lead cost is 0 until
          per-webmaster rates are injected. */}
      {data.channel_pl && (
        <ChannelPLCard data={data.channel_pl} vatPct={vatPct} rangeFrom={range?.from} />
      )}
      {data.channel_pl && <AffiliateBreakdownCard byAffiliate={data.channel_pl.by_affiliate} />}

      {byProduct.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="h-4 w-4" /> Product Breakdown (paid orders)
            </CardTitle>
            <div className="text-xs text-muted-foreground">
              {paidOrders.toLocaleString()} paid orders · {paidPackages.toLocaleString()} packages ·{' '}
              {packagesPerOrder.toFixed(1)} per order
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left py-2">{i18n.t('ordersPage.colProduct')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colPackages')}</th>
                  <th className="text-right py-2">{i18n.t('insights.orders')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colUnitPrice')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colUnitCost')}</th>
                  <th className="text-right py-2">{i18n.t('insights.revenue')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colNetRevenue')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colCost')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colProfit')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colNetProfit')}</th>
                </tr>
              </thead>
              <tbody>
                {byProduct.map((p) => (
                  <tr key={p.product} className="border-b last:border-0">
                    <td className="py-2 font-medium">
                      {p.product}
                      <span className="text-muted-foreground font-normal"> · {p.packages}×{formatMoney(p.unit_price)}</span>
                    </td>
                    <td className="py-2 text-right">{p.packages.toLocaleString()}</td>
                    <td className="py-2 text-right">{p.orders.toLocaleString()}</td>
                    <td className="py-2 text-right">{formatMoney(p.unit_price)}</td>
                    <td className="py-2 text-right text-muted-foreground">{p.unit_cost > 0 ? formatMoney(p.unit_cost) : '—'}</td>
                    <td className="py-2 text-right">{formatMoney(p.revenue)}</td>
                    <td className="py-2 text-right text-muted-foreground">{formatMoney(p.net_revenue ?? p.revenue)}</td>
                    <td className="py-2 text-right text-muted-foreground">{formatMoney(p.cogs)}</td>
                    <td className="py-2 text-right font-semibold text-emerald-600">{formatMoney(p.profit)}</td>
                    <td className="py-2 text-right font-semibold">{formatMoney(p.net_profit ?? p.profit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="py-2">{i18n.t('insights.totalRow')}</td>
                  <td className="py-2 text-right">{paidPackages.toLocaleString()}</td>
                  <td className="py-2 text-right">{paidOrders.toLocaleString()}</td>
                  <td className="py-2 text-right" colSpan={2}></td>
                  <td className="py-2 text-right">{formatMoney(byProduct.reduce((s, p) => s + p.revenue, 0))}</td>
                  <td className="py-2 text-right text-muted-foreground">{formatMoney(byProduct.reduce((s, p) => s + (p.net_revenue ?? p.revenue), 0))}</td>
                  <td className="py-2 text-right text-muted-foreground">{formatMoney(byProduct.reduce((s, p) => s + p.cogs, 0))}</td>
                  <td className="py-2 text-right text-emerald-600">{formatMoney(byProduct.reduce((s, p) => s + p.profit, 0))}</td>
                  <td className="py-2 text-right">{formatMoney(byProduct.reduce((s, p) => s + (p.net_profit ?? p.profit), 0))}</td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}

      {logistics.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Truck className="h-4 w-4" /> Logistics Spend by Courier
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left py-2">{i18n.t('insights.courierService')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colDelivered')}</th>
                  <th className="text-right py-2">{i18n.t('status.returned')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colDeliveryCost')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colReturnLoss')}</th>
                  <th className="text-right py-2">{i18n.t('insights.totalRow')}</th>
                </tr>
              </thead>
              <tbody>
                {logistics.map((l) => {
                  const key = `${l.courier}_${l.service}`;
                  return (
                    <tr key={key} className="border-b last:border-0">
                      <td className="py-2 font-medium">{courierServiceLabel(key)}</td>
                      <td className="py-2 text-right">{l.delivered.toLocaleString()}</td>
                      <td className="py-2 text-right">{l.returned.toLocaleString()}</td>
                      <td className="py-2 text-right">{formatMoney(l.deliver_cost)}</td>
                      <td className="py-2 text-right text-pink-600">{formatMoney(l.return_cost)}</td>
                      <td className="py-2 text-right font-semibold">{formatMoney(l.total_cost)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="py-2">{i18n.t('insights.totalRow')}</td>
                  <td className="py-2 text-right">{logiTotals.delivered.toLocaleString()}</td>
                  <td className="py-2 text-right">{logiTotals.returned.toLocaleString()}</td>
                  <td className="py-2 text-right">{formatMoney(logiTotals.deliver_cost)}</td>
                  <td className="py-2 text-right text-pink-600">{formatMoney(logiTotals.return_cost)}</td>
                  <td className="py-2 text-right"><Money eur={logiTotals.total_cost} /></td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}

      {agentsWithPayout.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4" /> Agent Earnings (Payouts)
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left py-2">{i18n.t('search.colAgent')}</th>
                  <th className="text-right py-2">{i18n.t('insights.payoutEarned')}</th>
                  <th className="text-right py-2">{i18n.t('insights.packagesSold')}</th>
                </tr>
              </thead>
              <tbody>
                {agentsWithPayout.map((a: any) => (
                  <tr key={a.name} className="border-b last:border-0">
                    <td className="py-2 font-medium">{a.name}</td>
                    <td className="py-2 text-right font-semibold text-emerald-600">{formatMoney(a.payout_earned || 0)}</td>
                    <td className="py-2 text-right">{(a.packages_sold ?? a.units ?? 0).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function PredictionLists({ data }: { data: InsightsResponse }) {
  const lists = data.prediction_lists || [];
  const totals = lists.reduce(
    (t, l) => ({
      orders: t.orders + l.orders, paid: t.paid + l.paid, returned: t.returned + l.returned,
      cancelled: t.cancelled + l.cancelled, revenue: t.revenue + l.revenue,
      refund_value: t.refund_value + l.refund_value, net_revenue: t.net_revenue + l.net_revenue,
      bonus_paid: t.bonus_paid + l.bonus_paid,
    }),
    { orders: 0, paid: 0, returned: 0, cancelled: 0, revenue: 0, refund_value: 0, net_revenue: 0, bonus_paid: 0 },
  );

  if (lists.length === 0) {
    return (
      <EmptyState
        icon={<ListChecks className="h-5 w-5" />}
        title={i18n.t('insights.noListSales')}
        description={i18n.t('insights.noListSalesDesc')}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={Coins} label={i18n.t('insights.revenueFromLists')} value={formatMoney(totals.revenue)} tone="bg-emerald-100 text-emerald-700" />
        <Kpi icon={TrendingUp} label={i18n.t('insights.netAfterRefunds')} value={formatMoney(totals.net_revenue)} sub={i18n.t('insights.paidOrdersSub', { count: totals.paid.toLocaleString() })} tone="bg-teal-100 text-teal-700" />
        <Kpi icon={RotateCcw} label={i18n.t('insights.refundsReturned')} value={formatMoney(totals.refund_value)} sub={i18n.t('insights.returnedSub', { count: totals.returned.toLocaleString() })} tone="bg-orange-100 text-orange-700" />
        <Kpi icon={Coins} label={i18n.t('insights.bonusesPaid')} value={formatMoney(totals.bonus_paid)} sub={i18n.t('insights.bonusesSub')} tone="bg-amber-100 text-amber-700" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><ListChecks className="h-4 w-4" /> Money generated per prediction list</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left py-2 px-2">{i18n.t('insights.colList')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.membersTitle')}>{i18n.t('insights.colMembers')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.ordersAttrTitle')}>{i18n.t('insights.orders')}</th>
                <th className="text-right py-2 px-2">{i18n.t('insights.colPaid')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.cancelledTitle')}>{i18n.t('insights.colCancelled')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.refundsTitle')}>{i18n.t('insights.colRefunds')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.revenueTitle')}>{i18n.t('insights.revenue')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.netTitle')}>{i18n.t('insights.colNet')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.bonusTitle')}>{i18n.t('insights.colBonus')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.convTitle')}>{i18n.t('insights.colConv')}</th>
              </tr>
            </thead>
            <tbody>
              {lists.map(l => (
                <tr key={l.list_id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="py-2 px-2 font-medium">
                    <span className="flex items-center gap-2">
                      {l.name}
                      <Badge variant="outline" className="text-[10px]">{l.type === 'uploaded' ? 'campaign' : 'segment'}</Badge>
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">{l.members.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{l.orders.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-emerald-600 font-medium">{l.paid.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-red-600">{l.cancelled.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-orange-600">{l.returned.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right tabular-nums font-semibold">{formatMoney(l.revenue)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{formatMoney(l.net_revenue)}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-amber-600">{formatMoney(l.bonus_paid)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{pct(l.conversion_rate)}</td>
                </tr>
              ))}
              <tr className="border-t-2 font-semibold bg-muted/20">
                <td className="py-2 px-2">{i18n.t('insights.totalRow')}</td>
                <td className="py-2 px-2"></td>
                <td className="py-2 px-2 text-right tabular-nums">{totals.orders.toLocaleString()}</td>
                <td className="py-2 px-2 text-right tabular-nums text-emerald-600">{totals.paid.toLocaleString()}</td>
                <td className="py-2 px-2 text-right tabular-nums text-red-600">{totals.cancelled.toLocaleString()}</td>
                <td className="py-2 px-2 text-right tabular-nums text-orange-600">{totals.returned.toLocaleString()}</td>
                <td className="py-2 px-2 text-right tabular-nums">{formatMoney(totals.revenue)}</td>
                <td className="py-2 px-2 text-right tabular-nums">{formatMoney(totals.net_revenue)}</td>
                <td className="py-2 px-2 text-right tabular-nums text-amber-600">{formatMoney(totals.bonus_paid)}</td>
                <td className="py-2 px-2"></td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{i18n.t('insights.revenueByList')}</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={lists.filter(l => l.revenue > 0).slice(0, 15)}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" height={70} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: any) => moneyTip(Number(v))} />
              <Bar dataKey="revenue" fill="hsl(142,76%,36%)" name="revenue" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground px-1">
        Attribution is captured when an order is created, so list ROI is exact from launch forward.
        Returns count as refunds (money that came back in this COD business). Members shows current list size.
      </p>
    </div>
  );
}

function Stock({ data }: { data: InsightsResponse }) {
  const ps = data.products_stock;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Kpi icon={AlertTriangle} label={i18n.t('insights.lowStock')} value={String(ps.low_stock.length)} tone="bg-amber-100 text-amber-700" />
        <Kpi icon={PackageX} label={i18n.t('insights.outOfStock')} value={String(ps.out_of_stock.length)} tone="bg-red-100 text-red-700" />
        <Kpi icon={Package} label={i18n.t('insights.activeProducts')} value={String(ps.stock.length)} tone="bg-blue-100 text-blue-700" />
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Package className="h-4 w-4" /> Stock report</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left py-2 px-2">{i18n.t('ordersPage.colProduct')}</th>
                <th className="text-right py-2 px-2">{i18n.t('insights.colStock')}</th>
                <th className="text-left py-2 px-2 pl-3">{i18n.t('insights.colState')}</th>
                <th className="text-right py-2 px-2">{i18n.t('insights.soldRange')}</th>
                <th className="text-right py-2 px-2">{i18n.t('insights.daysCover')}</th>
              </tr>
            </thead>
            <tbody>
              {ps.stock.map(s => (
                <tr key={s.name} className={cn('border-b last:border-0', s.state === 'out' && 'bg-red-50', s.state === 'low' && 'bg-amber-50')}>
                  <td className="py-2 px-2 font-medium max-w-[260px] truncate" title={s.name}>{s.name}</td>
                  <td className="py-2 px-2 text-right tabular-nums font-semibold">{s.stock_quantity}</td>
                  <td className="py-2 px-2 pl-3">
                    <Badge className={cn('text-[10px]',
                      s.state === 'out' ? 'bg-red-100 text-red-800' : s.state === 'low' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800')}>
                      {s.state === 'out' ? 'Out' : s.state === 'low' ? 'Low' : 'OK'}
                    </Badge>
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums">{s.units_sold}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">{s.days_of_cover ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <ListCard title={i18n.t('insights.topSellers')} icon={TrendingUp} rows={[...ps.top_sellers].sort((a, b) => b.units - a.units)} nameKey="product"
        cols={[{ k: 'units', label: i18n.t('insights.units') }, { k: 'revenue', label: i18n.t('insights.revenue'), money: true }]} />
    </div>
  );
}

function Returns({ data }: { data: InsightsResponse }) {
  const r = data.returns;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={RotateCcw} label={i18n.t('insights.returnRate')} value={pct(r.rate)} tone="bg-orange-100 text-orange-700" />
        <Kpi icon={Coins} label={i18n.t('insights.valueLost')} value={formatMoney(r.value_lost)} tone="bg-red-100 text-red-700" />
        <Kpi icon={PackageX} label={i18n.t('insights.cancellations')} value={data.cancellations.total.toLocaleString()} tone="bg-zinc-100 text-zinc-700" />
        <Kpi icon={Trash2} label={i18n.t('insights.trashed')} value={data.cancellations.trashed.toLocaleString()} sub={i18n.t('insights.junkSub')} tone="bg-zinc-100 text-zinc-700" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ListCard title={i18n.t('insights.returnsByReason')} icon={RotateCcw} rows={r.by_reason} nameKey="reason" cols={[{ k: 'count', label: i18n.t('insights.count') }]} transformName={cap} />
        <ListCard title={i18n.t('insights.returnsByProduct')} icon={Package} rows={r.by_product} nameKey="product" cols={[{ k: 'count', label: i18n.t('insights.count') }]} />
        <ListCard title={i18n.t('insights.returnsByCity')} icon={MapPin} rows={r.by_city} nameKey="city" cols={[{ k: 'count', label: i18n.t('insights.count') }]} />
        <ListCard title={i18n.t('insights.cancellationsByReason')} icon={PackageX} rows={data.cancellations.by_reason} nameKey="reason" cols={[{ k: 'count', label: i18n.t('insights.count') }]} transformName={cancelReasonName} />
      </div>
    </div>
  );
}

// A reason that has a label (cancelReason.* — including the system-only
// no_parcel_7d) shows it in the reader's language; server markers without one
// (pending_cleanup, "(unspecified)") keep the plain prettified value.
const cancelReasonName = (s: string) => (i18n.exists(`cancelReason.${s}`) ? cancelReasonLabel(s) : cap(s));

// Failed fetch: say so, with a retry — never an endless spinner.
function LoadError({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={<AlertTriangle className="h-5 w-5" />}
      title={t('insights.loadFailed')}
      description={text}
      size="sm"
      action={<Button variant="outline" size="sm" onClick={onRetry}>{t('common.retry')}</Button>}
    />
  );
}

// The Call Activity KPI block. Takes the calls block alone, because a
// non-owner's response (?scope=calls) carries nothing else.
function Calls({ c }: { c: InsightsCallsResponse['calls'] }) {
  if (!c.total) return (
    <Card>
      <CardContent className="p-0">
        <EmptyState
          icon={<Phone className="h-5 w-5" />}
          title={i18n.t('insights.noCalls')}
          description={i18n.t('insights.noCallsDesc')}
          size="sm"
        />
      </CardContent>
    </Card>
  );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={Phone} label={i18n.t('insights.calls')} value={c.total.toLocaleString()} tone="bg-blue-100 text-blue-700" />
        <Kpi icon={Phone} label={i18n.t('insights.answerRate')} value={pct(c.answer_rate)} sub={i18n.t('insights.answeredSub', { count: c.answered.toLocaleString() })} tone="bg-emerald-100 text-emerald-700" />
        <Kpi icon={Phone} label={i18n.t('insights.talkTime')} value={fmtDur(c.talk_seconds)} tone="bg-amber-100 text-amber-700" />
        <Kpi icon={Phone} label={i18n.t('insights.avgPerCall')} value={fmtDur(c.total ? Math.round(c.talk_seconds / c.total) : 0)} tone="bg-indigo-100 text-indigo-700" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ListCard title={i18n.t('insights.byOutcome')} icon={Phone} rows={c.by_outcome} nameKey="outcome" cols={[{ k: 'count', label: i18n.t('insights.count') }]} transformName={cap} />
        <Card>
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Users className="h-4 w-4" /> Calls by agent</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left py-2 px-2">{i18n.t('search.colAgent')}</th><th className="text-right py-2 px-2">{i18n.t('insights.colCalls')}</th>
                <th className="text-right py-2 px-2">{i18n.t('insights.colAnswerPct')}</th><th className="text-right py-2 px-2">{i18n.t('insights.colTalk')}</th>
              </tr></thead>
              <tbody>
                {c.per_agent.map(a => (
                  <tr key={a.name} className="border-b last:border-0">
                    <td className="py-2 px-2 font-medium">{a.name}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{a.calls}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{pct(a.answer_rate)}</td>
                    <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">{fmtDur(a.talk_seconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── Reusable list card (top-N with bars) ──
function ListCard({ title, icon: Icon, rows, nameKey, cols, transformName, note }: {
  title: string; icon: any; rows: any[]; nameKey: string;
  cols: { k: string; label: string; money?: boolean }[];
  transformName?: (s: string) => string; note?: string;
}) {
  const max = useMemo(() => Math.max(1, ...rows.map(r => Number(r[cols[cols.length - 1].k] || 0))), [rows, cols]);
  const valKey = cols[cols.length - 1].k;
  const valMoney = cols[cols.length - 1].money;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><Icon className="h-4 w-4" /> {title}</CardTitle></CardHeader>
      <CardContent>
        {rows.length === 0 ? <EmptyState title={i18n.t('insights.noData')} size="sm" /> : (
          <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
            {rows.slice(0, 20).map((r, i) => {
              const v = Number(r[valKey] || 0);
              const name = transformName ? transformName(String(r[nameKey])) : String(r[nameKey]);
              return (
                <div key={i} className="relative">
                  <div className="absolute inset-y-0 left-0 rounded bg-primary/10" style={{ width: `${(v / max) * 100}%` }} />
                  <div className="relative flex items-center justify-between gap-2 px-2 py-1 text-xs">
                    <span className="truncate" title={name}>{name}</span>
                    <span className="tabular-nums font-medium shrink-0">{valMoney ? formatMoney(v) : v.toLocaleString()}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {note && <p className="text-[10px] text-muted-foreground mt-2 italic">{note}</p>}
      </CardContent>
    </Card>
  );
}


