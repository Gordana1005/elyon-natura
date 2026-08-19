import { Fragment, useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { AppLayout } from '@/layouts/AppLayout';
import { ALL_STATUSES, statusLabel } from '@/types';
import { useAuth } from '@/contexts/AuthContext';
import { apiGetCeoDashboardStats, apiGetDashboardStats, apiGetOrderStats, apiGetAgents, apiGetProducts, apiGetRecentActivity } from '@/lib/api';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DateRangePicker, defaultRange, type DateRange } from '@/components/DateRangePicker';
import {
  CheckCircle2, Truck, Package, Users, TrendingUp, TrendingDown,
  Target, Download, ArrowUpRight, ArrowDownRight,
  Activity,
  X, MessageSquare, Phone, ArrowRightLeft, FileText,
  DollarSign, AlertTriangle, Trophy, Zap, Shield, ChevronRight,
  ChevronLeft, Trash2, Banknote, Clock,
  PhoneForwarded, ListChecks,
} from 'lucide-react';
import { MyOrdersSection } from '@/components/dashboard/MyOrdersSection';
import { formatDate } from '@/i18n/dates';
import { Link } from 'react-router-dom';
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  Area, AreaChart,
} from 'recharts';

interface DashStats {
  lead_count: number; deals_won: number; deals_lost: number;
  total_value: number; tasks_completed: number; total_orders: number;
  daily: Record<string, { leads: number; deals_won: number; deals_lost: number; orders: number; calls: number }>;
  statusCounts: Record<string, number>;
  orders_from_standard?: number;
  orders_from_leads?: number;
  personalMetrics?: DashStats | null;
  isDualRole?: boolean;
  products_sold?: Record<string, number>;
  /** @deprecated alias of packages_sold (paid units only) */
  units_sold?: number;
  /** Paid packages only (COD collected) */
  packages_sold?: number;
  /** Confirmed/shipped/delivered units awaiting payment */
  packages_awaiting?: number;
  /** Units on returned orders */
  packages_returned?: number;
  returns_orders?: number;
  paid_revenue?: number;
  payout_earned?: number;
  /** Per-sales-motion split of the agent's own orders. Keys: pendings |
   *  prediction | other | __total. `other` is the pre-CRM import, which
   *  predates the split — it is in __total but has no column of its own. */
  channels?: Record<string, ChannelStats>;
  /** What the agent actually DID in the window, read off order_history.
   *  Same keys. This — not `statusCounts` — answers "how much did I work
   *  today", because statusCounts windows on when the order was CREATED. */
  activity?: Record<string, ActivityStats>;
  /** Leads parked on a callback right now (not a period figure). */
  call_again_open?: number;
  /** Prediction-list members this agent called in the window, by outcome. */
  prediction_members?: Record<string, number>;
  prediction_members_total?: number;
}

interface ChannelStats {
  orders: number; confirmed: number; shipped: number; returned: number;
  cancelled: number; trashed: number; call_again: number; paid: number;
  revenue_confirmed: number; revenue_paid: number;
  packages_sold: number; packages_awaiting: number; packages_returned: number;
  bonus_raw: number;
}

interface ActivityStats {
  processed: number; confirmed: number; cancelled: number;
  trashed: number; call_again: number;
  /** Of the leads I processed, how many stand confirmed-or-better NOW. The
   *  honest realizacija numerator: a confirm that was cancelled an hour later
   *  counts in `confirmed` but not here. */
  won: number; lost: number;
}

const EMPTY_ACTIVITY: ActivityStats = {
  processed: 0, confirmed: 0, cancelled: 0, trashed: 0, call_again: 0, won: 0, lost: 0,
};

const EMPTY_CHANNEL: ChannelStats = {
  orders: 0, confirmed: 0, shipped: 0, returned: 0, cancelled: 0, trashed: 0,
  call_again: 0, paid: 0, revenue_confirmed: 0, revenue_paid: 0,
  packages_sold: 0, packages_awaiting: 0, packages_returned: 0, bonus_raw: 0,
};

function exportCSV(data: DashStats, period: string, label?: string) {
  const rows = [
    ['Metric', 'Value'],
    ['Period', period],
    ...(label ? [['Section', label]] : []),
    ['Leads Created', String(data.lead_count)],
    ['Deals Won', String(data.deals_won)],
    ['Deals Lost', String(data.deals_lost)],
    ['Total Value', String(data.total_value)],
    ['Calls Completed', String(data.tasks_completed)],
    ['Total Orders', String(data.total_orders)],
    ['', ''],
    ['Status', 'Count'],
    ...Object.entries(data.statusCounts).map(([s, c]) => [s, String(c)]),
    ['', ''],
    ['Date', 'Leads', 'Deals Won', 'Deals Lost', 'Orders', 'Calls'],
    ...Object.entries(data.daily).sort(([a], [b]) => a.localeCompare(b)).map(([d, v]) =>
      [d, String(v.leads), String(v.deals_won), String(v.deals_lost), String(v.orders), String(v.calls)]
    ),
  ];
  const csv = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `dashboard-${label || 'stats'}-${period}-${new Date().toISOString().substring(0, 10)}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// Premium Metric Card — Phase 2 elevated treatment
// ── "My work, split" ────────────────────────────────────────────────────────
// The operator's ask, verbatim: "број на обработени лидови и клиенти од
// предикциски листи, и тоа да е поделено". One column per sales motion, one
// row per outcome, and a Total column — because the pre-CRM import belongs to
// the total but predates the split and has no column of its own.
function WorkSplitCard({ pendings, prediction, total, t }: {
  pendings: ActivityStats; prediction: ActivityStats; total: ActivityStats;
  t: (k: string, o?: any) => string;
}) {
  const rate = (a: ActivityStats) => (a.processed > 0 ? Math.round((a.won / a.processed) * 100) : 0);
  const rows: Array<{ key: string; label: string; get: (a: ActivityStats) => number; tone?: string }> = [
    { key: 'processed', label: t('dashboard.split.processed'), get: a => a.processed },
    { key: 'confirmed', label: t('dashboard.split.confirmed'), get: a => a.confirmed, tone: 'text-[hsl(var(--success))]' },
    { key: 'cancelled', label: t('dashboard.split.cancelled'), get: a => a.cancelled, tone: 'text-destructive' },
    { key: 'callAgain', label: t('dashboard.split.callAgain'), get: a => a.call_again, tone: 'text-[hsl(var(--warning))]' },
    { key: 'trashed', label: t('dashboard.split.trashed'), get: a => a.trashed, tone: 'text-destructive/80' },
  ];
  const cols: Array<{ key: string; label: string; data: ActivityStats; accent?: boolean }> = [
    { key: 'pendings', label: t('dashboard.split.colPendings'), data: pendings },
    { key: 'prediction', label: t('dashboard.split.colPrediction'), data: prediction },
    { key: 'total', label: t('dashboard.split.colTotal'), data: total, accent: true },
  ];

  return (
    <Card className="border-none shadow-sm mb-6">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-primary" /> {t('dashboard.split.title')}
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">{t('dashboard.split.subtitle')}</p>
      </CardHeader>
      <CardContent className="px-3 sm:px-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[320px]">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left py-2 font-medium" />
                {cols.map(c => (
                  <th key={c.key} className={`text-right py-2 font-medium ${c.accent ? 'text-card-foreground' : ''}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.key} className="border-b last:border-0">
                  <td className="py-2 pr-2 text-[12px] text-muted-foreground whitespace-nowrap">{r.label}</td>
                  {cols.map(c => (
                    <td
                      key={c.key}
                      className={`py-2 text-right tabular-nums font-mono ${r.tone || ''} ${c.accent ? 'font-semibold' : ''}`}
                    >
                      {r.get(c.data)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t-2">
                <td className="py-2 pr-2 text-[12px] font-medium whitespace-nowrap">
                  {t('dashboard.split.realization')}
                </td>
                {cols.map(c => (
                  <td key={c.key} className={`py-2 text-right tabular-nums font-mono font-semibold ${c.accent ? 'text-primary' : ''}`}>
                    {rate(c.data)}%
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        <p className="pt-3 text-[10px] text-muted-foreground/80 leading-tight">
          {t('dashboard.split.footnote')}
        </p>
      </CardContent>
    </Card>
  );
}

// ── The agent's own funnel ──────────────────────────────────────────────────
// The same Worked → Confirmed → Shipped → Paid → Returned shape management sees,
// scoped to one agent. Every figure already travelled in `channels.__total`; it
// was fetched, typed and thrown away, so agents could see their cancels but
// never what happened to the orders they won.
//
// The rates use the same definitions as /agent-performance so a tile here and a
// column in Insights can never tell the agent two different stories: shipment is
// of confirmed, collection and return are of shipped. Paid lags by days — it
// arrives only when MEX reconciles the delivery — so a fresh day legitimately
// reads 0 there while Confirmed is healthy.
function AgentFunnelCard({ worked, ch, t }: {
  worked: number; ch: ChannelStats; t: (k: string, o?: any) => string;
}) {
  const pct = (n: number, base: number) => (base > 0 ? Math.round((n / base) * 1000) / 10 : null);
  const steps = [
    { key: 'worked', label: t('dashboard.funnel.worked'), value: worked, rate: null as number | null, tone: 'bg-primary' },
    { key: 'confirmed', label: t('status.confirmed'), value: ch.confirmed, rate: pct(ch.confirmed, worked), tone: 'bg-[hsl(var(--success))]' },
    { key: 'shipped', label: t('status.shipped'), value: ch.shipped, rate: pct(ch.shipped, ch.confirmed), tone: 'bg-[hsl(var(--info))]' },
    { key: 'paid', label: t('status.paid'), value: ch.paid, rate: pct(ch.paid, ch.shipped), tone: 'bg-emerald-600' },
    { key: 'returned', label: t('status.returned'), value: ch.returned, rate: pct(ch.returned, ch.shipped), tone: 'bg-destructive' },
  ];
  return (
    <Card className="border-none shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Target className="h-4 w-4 text-primary" /> {t('dashboard.funnel.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-2">
        <div className="flex items-start gap-1 overflow-x-auto pb-1">
          {steps.map((s, i) => (
            <Fragment key={s.key}>
              {i > 0 && <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 mt-4" />}
              <div className="min-w-[76px] flex-1 text-center">
                <div className={cn('mx-auto flex h-11 w-11 items-center justify-center rounded-full text-base font-bold text-white tabular-nums', s.tone)}>
                  {s.value}
                </div>
                <div className="mt-1.5 text-[11px] font-medium leading-tight">{s.label}</div>
                {s.rate !== null && (
                  <div className="text-[10px] text-muted-foreground tabular-nums">{s.rate}%</div>
                )}
              </div>
            </Fragment>
          ))}
        </div>
        <p className="pt-3 text-[10px] leading-tight text-muted-foreground/80">
          {t('dashboard.funnel.footnote')}
        </p>
      </CardContent>
    </Card>
  );
}

function MetricCard({ title, value, icon: Icon, trend, trendLabel, color, subtitle }: {
  title: string; value: string | number; icon: any; trend?: number; trendLabel?: string; color: string; subtitle?: string;
}) {
  const isPositive = trend !== undefined && trend >= 0;

  return (
    <Card className="group relative overflow-hidden border border-border/60 bg-card shadow-sm hover:shadow-md hover:border-border/80 transition-all duration-200 hover:-translate-y-[1px]">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.5px]">{title}</p>

            <div className="flex items-baseline gap-1.5">
              <p className="text-3xl font-semibold tabular-nums tracking-tighter text-card-foreground">{value}</p>
            </div>

            {trend !== undefined && (
              <div className={`inline-flex items-center gap-1 text-xs font-medium mt-1 ${isPositive ? 'text-[hsl(var(--success))]' : 'text-destructive'}`}>
                {isPositive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                {Math.abs(trend)}% <span className="text-muted-foreground/70">vs yesterday</span>
              </div>
            )}

            {subtitle && (
              <p className="text-[10px] text-muted-foreground/80 leading-tight pt-0.5">{subtitle}</p>
            )}
          </div>

          <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${color} ring-1 ring-inset ring-white/10 shadow-inner transition-transform group-hover:scale-[1.02]`}>
            <Icon className="h-5 w-5 text-primary-foreground drop-shadow-sm" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function getTimeAgo(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return i18n.t('dashboard.justNow');
  if (mins < 60) return i18n.t('dashboard.minsAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return i18n.t('dashboard.hoursAgo', { count: hrs });
  const days = Math.floor(hrs / 24);
  return i18n.t('dashboard.daysAgo', { count: days });
}

const chartTooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '10px',
  fontSize: '12px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
};

import { formatMoney } from '@/lib/currency';
import { CHART_COLORS, hoverLift } from '@/lib/design-utils';
import { EmptyState } from '@/components/EmptyState';

// Macedonia shows denars only. Routed through the shared helper so this page
// can never drift from the rest of the app's money formatting.
const fmtCurrency = (n: number) => formatMoney(n);

export default function Dashboard() {
  const { t } = useTranslation(); // subscribes status labels to language switches
  const { user } = useAuth();
  const isAdmin = user?.isAdmin;
  const isDualRole = user?.isAdmin && user?.isAgent;
  const [agentPeriod, setAgentPeriod] = useState<'today' | 'month' | 'start' | 'custom'>('today');
  // Day browsing (◀ ▶): UTC day string, matching the backend's UTC window math.
  // The agent's "today" is the Skopje calendar day, matching the window the API
  // now resolves. Reading it off the UTC clock made the ◀ ▶ navigator and the
  // server disagree for the first two hours of every Macedonian day.
  const todayUtc = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' }).format(new Date());
  const [agentDate, setAgentDate] = useState(todayUtc);
  // Custom range (period='custom'): defaults to this month so far, fully editable.
  const [agentRange, setAgentRange] = useState<DateRange>({ from: todayUtc.slice(0, 7) + '-01', to: todayUtc });
  const [agentFilter, setAgentFilter] = useState('all');
  const [chartView, setChartView] = useState<'revenue' | 'orders' | 'leads'>('revenue');
  // Dashboard defaults to today; the range picker drives everything.
  const [range, setRange] = useState<DateRange>(defaultRange);

  const effectiveAgent = agentFilter !== 'all' ? agentFilter : undefined;

  // CEO stats
  const { data: ceoStats } = useQuery<any>({
    queryKey: ['ceo-dashboard-stats', effectiveAgent, range.from, range.to],
    queryFn: () => apiGetCeoDashboardStats({
      // A bounded range → 'custom' (filters by status-change date); empty → 'all'.
      period: (range.from && range.to) ? 'custom' : 'all',
      agent_id: effectiveAgent,
      from: range.from || undefined,
      to: range.to || undefined,
    }),
    refetchInterval: 60000,
    enabled: !!isAdmin,
  });

  const { data: todayStats } = useQuery<DashStats>({
    queryKey: ['dashboard-stats', 'day', agentDate, effectiveAgent],
    queryFn: () => apiGetDashboardStats({ period: 'today', date: agentDate, agent_id: effectiveAgent }),
    refetchInterval: 30000,
  });

  const { data: monthStats } = useQuery<DashStats>({
    queryKey: ['dashboard-stats', 'month', effectiveAgent],
    queryFn: () => apiGetDashboardStats({ period: 'month', agent_id: effectiveAgent }),
    refetchInterval: 60000,
  });

  const { data: customStats } = useQuery<DashStats>({
    queryKey: ['dashboard-stats', 'custom', agentRange.from, agentRange.to, effectiveAgent],
    queryFn: () => apiGetDashboardStats({ period: 'custom', from: agentRange.from, to: agentRange.to, agent_id: effectiveAgent }),
    enabled: !isAdmin && agentPeriod === 'custom' && !!agentRange.from && !!agentRange.to,
    refetchInterval: 60000,
  });

  const { data: startStats } = useQuery<DashStats>({
    queryKey: ['dashboard-stats', 'start', effectiveAgent],
    queryFn: () => apiGetDashboardStats({ period: 'start', agent_id: effectiveAgent }),
    enabled: !isAdmin && agentPeriod === 'start',
    refetchInterval: 60000,
  });

  const { data: orderStats } = useQuery({
    queryKey: ['order-stats'],
    queryFn: () => apiGetOrderStats(),
  });

  const { data: agents = [] } = useQuery<{ user_id: string; full_name: string }[]>({
    queryKey: ['agents'],
    queryFn: apiGetAgents,
    enabled: !!isAdmin,
  });

  const { data: products = [] } = useQuery<any[]>({
    queryKey: ['products'],
    queryFn: apiGetProducts,
    enabled: !!isAdmin,
  });

  const { data: recentActivity = [] } = useQuery<any[]>({
    queryKey: ['recent-activity'],
    queryFn: () => apiGetRecentActivity(25),
    refetchInterval: 30000,
  });

  // ── Live tiles ────────────────────────────────────────────────────────────
  // The agent's numbers move the moment they settle a lead, instead of waiting
  // out the 30s poll. This is the SAME broadcast channel the office TV board
  // listens on (see TvLeaderboardPage) — the server fires `confirmed` on a
  // fresh confirm and `refresh` on a cancel / trash / call-again, so no new
  // infrastructure and no second subscription per agent.
  //
  // Debounced: a bulk action fires one broadcast per order, and each of those
  // must not become its own refetch. The polling above stays as the fallback,
  // so a dropped socket degrades to "up to 30s stale", never to stale forever.
  const queryClient = useQueryClient();
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isAdmin) return;
    const bump = () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
        queryClient.invalidateQueries({ queryKey: ['my-orders'] });
      }, 1000);
    };
    const ch = supabase
      .channel('tv-leaderboard')
      .on('broadcast', { event: 'confirmed' }, bump)
      .on('broadcast', { event: 'refresh' }, bump)
      .subscribe();
    return () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      supabase.removeChannel(ch);
    };
  }, [isAdmin, queryClient]);

  const statusCounts = orderStats?.statusCounts || {};

  const lowStock = products.filter((p: any) => p.stock_quantity <= p.low_stock_threshold).length;
  const medStock = products.filter((p: any) => p.stock_quantity > p.low_stock_threshold && p.stock_quantity <= p.low_stock_threshold * 3).length;
  const highStock = products.filter((p: any) => p.stock_quantity > p.low_stock_threshold * 3).length;

  const personalToday = todayStats?.personalMetrics;

  // Revenue trend chart data from CEO stats
  const revenueTrendData = useMemo(() => {
    if (!ceoStats?.dailyRevenue) return [];
    return Object.entries(ceoStats.dailyRevenue)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]: [string, any]) => ({
        date: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        revenue: v.revenue,
        orders: v.orders,
        leads: v.leads,
      }));
  }, [ceoStats?.dailyRevenue]);

  const hasActiveFilters = agentFilter !== 'all';

  const funnel = ceoStats?.funnel;
  const topAgent = ceoStats?.topAgent;
  const alerts = ceoStats?.alerts || [];
  const snap = ceoStats?.todaySnapshot;
  const agentRankings = ceoStats?.agentRankings || [];

  // ── Call Agent view: a purpose-built "My Performance" page (their numbers
  // only). Admins/managers fall through to the full operational dashboard. ──
  if (!isAdmin) {
    const stats =
      agentPeriod === 'today' ? todayStats
      : agentPeriod === 'month' ? monthStats
      : agentPeriod === 'start' ? startStats
      : customStats;
    const sales = stats?.deals_won || 0;
    const cancels = stats?.statusCounts?.cancelled || 0;
    const trashed = stats?.statusCounts?.trashed || 0;
    const returnsOrders = stats?.returns_orders ?? stats?.statusCounts?.returned ?? 0;
    const packagesReturned = stats?.packages_returned ?? 0;
    // Day navigator: past days only — ▶ is disabled once we're back at today.
    const yesterdayUtc = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const dayLabel = agentDate === todayUtc
      ? t('dashboard.today')
      : agentDate === yesterdayUtc
        ? t('dashboard.yesterday')
        : formatDate(agentDate, 'EEE, MMM d');
    const shiftDay = (delta: number) => {
      const d = new Date(agentDate + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + delta);
      const next = d.toISOString().slice(0, 10);
      setAgentDate(next > todayUtc ? todayUtc : next);
    };
    // ── The split the operator asked for (2026-08-19) ────────────────────────
    // Пендинзи (inbound leads) vs Предикциски листи, from what the agent
    // actually DID in the window — order_history, not order.created_at.
    const act = stats?.activity || {};
    const actPend = act.pendings || EMPTY_ACTIVITY;
    const actPred = act.prediction || EMPTY_ACTIVITY;
    const actTotal = act.__total || EMPTY_ACTIVITY;
    const predMembers = stats?.prediction_members_total || 0;
    const callAgainOpen = stats?.call_again_open || 0;
    // channels.__total has always been fetched and typed and never rendered.
    // It carries the order-lifecycle counts and, notably, revenue_confirmed —
    // the one figure on the operator's list that no screen showed anywhere.
    const chTotal: ChannelStats = stats?.channels?.__total || EMPTY_CHANNEL;
    const revenueConfirmed = chTotal.revenue_confirmed || 0;

    // Realizacija = of the leads I worked, how many stand confirmed-or-better
    // NOW. The old formula divided sales by call_logs rows — a table holding
    // 523 rows for the whole company, because telephony is off and the Call
    // button is optional. It produced numbers in the thousands of percent.
    // Lifetime falls back to orders, because order_history only starts
    // 2026-08-01 and would under-report every earlier period as 0 processed.
    const pct = (won: number, base: number) => (base > 0 ? Math.round((won / base) * 100) : 0);
    const conversion = actTotal.processed > 0
      ? pct(actTotal.won, actTotal.processed)
      : pct(sales, stats?.total_orders || 0);
    const paidRevenue = stats?.paid_revenue ?? 0;
    const payoutEarned = stats?.payout_earned ?? 0;
    const packagesSold = stats?.packages_sold ?? stats?.units_sold ?? 0;
    const packagesAwaiting = stats?.packages_awaiting ?? 0;
    const productRows = Object.entries(stats?.products_sold || {}).sort((a, b) => b[1] - a[1]);
    const trend = Object.entries(stats?.daily || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        sales: v.deals_won, calls: v.calls,
      }));
    const periodLabel =
      agentPeriod === 'today'
        ? (agentDate === todayUtc ? t('dashboard.todaysPerformance') : t('dashboard.dayPerformance', { date: dayLabel }))
        : agentPeriod === 'month'
          ? t('dashboard.monthsPerformance')
          : agentPeriod === 'start'
            ? t('dashboard.startPerformance')
            : t('dashboard.dayPerformance', { date: `${formatDate(agentRange.from, 'MMM d')} – ${formatDate(agentRange.to, 'MMM d')}` });

    // My Orders only supports today|month|custom — map start → custom all-time window
    const ordersPeriod = agentPeriod === 'start' ? 'custom' as const : agentPeriod;
    const ordersFrom = agentPeriod === 'start' ? '2000-01-01' : agentRange.from;
    const ordersTo = agentPeriod === 'start' ? todayUtc : agentRange.to;

    return (
      <AppLayout title={t('titles.myPerformance')}>
        {/* Period toggle + day navigator + custom range */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">{periodLabel}</p>
          <div className="flex flex-wrap items-center gap-2">
            {agentPeriod === 'today' && (
              <div className="flex items-center gap-1">
                <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => shiftDay(-1)} aria-label={t('dashboard.prevDay')}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-xs font-medium min-w-[88px] text-center whitespace-nowrap">{dayLabel}</span>
                <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => shiftDay(1)} disabled={agentDate === todayUtc} aria-label={t('dashboard.nextDay')}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            )}
            {agentPeriod === 'custom' && (
              <div className="flex items-center gap-1">
                <Input
                  type="date" value={agentRange.from} max={agentRange.to || todayUtc}
                  onChange={e => setAgentRange(r => ({ from: e.target.value, to: r.to || e.target.value }))}
                  className="h-7 w-[140px] text-xs" aria-label={t('dashboard.rangeFrom')}
                />
                <span className="text-muted-foreground text-xs">–</span>
                <Input
                  type="date" value={agentRange.to} min={agentRange.from || undefined} max={todayUtc}
                  onChange={e => setAgentRange(r => ({ from: r.from || e.target.value, to: e.target.value }))}
                  className="h-7 w-[140px] text-xs" aria-label={t('dashboard.rangeTo')}
                />
              </div>
            )}
            <Tabs value={agentPeriod} onValueChange={v => setAgentPeriod(v as any)}>
              <TabsList className="h-8">
                <TabsTrigger value="today" className="text-xs px-3 h-7">{t('dashboard.today')}</TabsTrigger>
                <TabsTrigger value="month" className="text-xs px-3 h-7">{t('dashboard.thisMonth')}</TabsTrigger>
                <TabsTrigger value="start" className="text-xs px-3 h-7">{t('dashboard.start')}</TabsTrigger>
                <TabsTrigger value="custom" className="text-xs px-3 h-7">{t('dashboard.custom')}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>

        {/* ── The work comes first ─────────────────────────────────────────────
            Operator ruling 2026-08-19: an agent's screen opens on what they did
            on the phone — who they worked and how it ended — not on commission.
            Earnings moved below the fold of this block. */}
        <div className="mb-4">
          <AgentFunnelCard worked={actTotal.processed || stats?.total_orders || 0} ch={chTotal} t={t} />
        </div>

        {/* Пендинзи vs Предикциски листи — what I actually worked this period */}
        <WorkSplitCard pendings={actPend} prediction={actPred} total={actTotal} t={t} />

        {/* Outcomes of that work */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5 mb-6">
          <MetricCard title={t('dashboard.sales')} value={sales} icon={CheckCircle2} color="bg-[hsl(var(--success))]" subtitle={t('dashboard.salesSub')} />
          <MetricCard title={t('dashboard.cancels')} value={cancels} icon={X} color="bg-destructive" subtitle={t('dashboard.cancelsSub')} />
          <MetricCard title={t('dashboard.trashed')} value={trashed} icon={Trash2} color="bg-destructive/80" subtitle={t('dashboard.trashedSub')} />
          <MetricCard
            title={t('dashboard.callAgainOpen')}
            value={callAgainOpen}
            icon={PhoneForwarded}
            color="bg-[hsl(var(--warning))]"
            subtitle={t('dashboard.callAgainOpenSub')}
          />
          <MetricCard
            title={t('dashboard.returns')}
            value={returnsOrders}
            icon={TrendingDown}
            color="bg-destructive"
            subtitle={t('dashboard.returnsPackagesSub', { packages: packagesReturned })}
          />
        </div>

        {/* Realisation + the revenue the agent actually created */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-6">
          <MetricCard
            title={t('dashboard.conversion')}
            value={`${conversion}%`}
            icon={Target}
            color="bg-primary"
            subtitle={actTotal.processed > 0
              ? t('dashboard.conversionSubProcessed', { won: actTotal.won, processed: actTotal.processed })
              : t('dashboard.conversionSubOrders')}
          />
          <MetricCard
            title={t('dashboard.revenueConfirmed')}
            value={formatMoney(revenueConfirmed)}
            icon={FileText}
            color="bg-[hsl(var(--success))]"
            subtitle={t('dashboard.revenueConfirmedSub')}
          />
          <MetricCard
            title={t('dashboard.predictionMembers')}
            value={predMembers}
            icon={Users}
            color="bg-[hsl(var(--info))]"
            subtitle={t('dashboard.predictionMembersSub')}
          />
          <MetricCard title={t('dashboard.tabOrders')} value={stats?.total_orders || 0} icon={FileText} color="bg-muted-foreground" subtitle={t('dashboard.ordersSub')} />
        </div>

        {/* Earnings — what the work paid, after the work itself */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-4">
          <MetricCard
            title={t('dashboard.payoutEarned')}
            value={formatMoney(payoutEarned)}
            icon={Banknote}
            color="bg-emerald-600"
            subtitle={t('dashboard.payoutEarnedSub')}
          />
          <MetricCard
            title={t('dashboard.packagesSold')}
            value={packagesSold}
            icon={Package}
            color="bg-primary"
            subtitle={packagesSold > 0 && paidRevenue > 0
              ? t('dashboard.perPackage', { price: fmtCurrency(paidRevenue / packagesSold) })
              : t('dashboard.packagesSoldSub')}
          />
          <MetricCard
            title={t('dashboard.paidRevenue')}
            value={formatMoney(paidRevenue)}
            icon={DollarSign}
            color="bg-[hsl(var(--info))]"
            subtitle={t('dashboard.paidRevenueSub')}
          />
          <MetricCard
            title={t('dashboard.packagesAwaiting')}
            value={packagesAwaiting}
            icon={Clock}
            color="bg-[hsl(var(--warning))]"
            subtitle={t('dashboard.packagesAwaitingSub')}
          />
        </div>

        <div className="mb-6">
          <Card className="border border-border/60 bg-card shadow-sm">
            <CardContent className="p-5 flex items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.5px]">{t('dashboard.myPayoutDetails')}</p>
                <p className="text-sm text-muted-foreground mt-1">{t('dashboard.myPayoutDetailsDesc')}</p>
              </div>
              <Button asChild size="sm" variant="outline" className="shrink-0">
                <Link to="/insights?tab=agents">{t('dashboard.openAgentsTab')}</Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* My Orders drill-down: Confirmed | Shipped | Paid | Returned */}
        <MyOrdersSection period={ordersPeriod} date={agentDate} from={ordersFrom} to={ordersTo} />

        <div className="grid gap-6 lg:grid-cols-3 mb-6">
          {/* Sales & Calls trend */}
          <Card className="lg:col-span-2 border-none shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-primary" /> {t('dashboard.salesCallsOverTime')}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-2">
              {trend.length === 0 ? (
                <EmptyState
                  icon={<Activity className="h-5 w-5" />}
                  title={t('dashboard.noActivityPeriod')}
                  size="sm"
                  className="border-0 bg-transparent py-8"
                />
              ) : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={trend}>
                    <defs>
                      <linearGradient id="agSales" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={chartTooltipStyle} />
                    <Area type="monotone" dataKey="sales" stroke="hsl(142, 76%, 36%)" strokeWidth={2} fill="url(#agSales)" name="Sales" />
                    <Area type="monotone" dataKey="calls" stroke="hsl(27, 95%, 48%)" strokeWidth={2} fillOpacity={0} name="Calls" />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          {/* Products sold */}
          <Card className="border-none shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                <Package className="h-4 w-4 text-primary" /> {t('dashboard.productsSold')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {productRows.length === 0 ? (
                <EmptyState
                  icon={<Package className="h-4 w-4" />}
                  title={t('dashboard.noProductsSold')}
                  size="sm"
                  className="border-0 bg-transparent py-4"
                />
              ) : (
                <ScrollArea className="h-[260px] pr-3">
                  <table className="w-full text-sm">
                    <tbody>
                      {productRows.map(([name, qty]) => (
                        <tr key={name} className="border-b last:border-0">
                          <td className="py-2 pr-2 truncate max-w-[180px]">{name}</td>
                          <td className="py-2 text-right font-bold tabular-nums">{qty}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </div>

        {/* My recent activity (already scoped server-side to this agent) */}
        <Card className="border-none shadow-sm mb-6">
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" /> {t('dashboard.myRecentActivity')}
            </CardTitle>
            <span className="text-xs text-muted-foreground">{t('dashboard.nEvents', { count: recentActivity.length })}</span>
          </CardHeader>
          <CardContent>
            {recentActivity.length === 0 ? (
              <EmptyState
                title={t('dashboard.noRecentActivity')}
                description={t('dashboard.noRecentActivityDesc')}
                size="sm"
              />
            ) : (
              <ScrollArea className="h-[300px] pr-3">
                <div className="space-y-1">
                  {recentActivity.map((item: any) => {
                    const isCall = item.type === 'call';
                    const isNote = item.type === 'note';
                    const IconComp = isCall ? Phone : isNote ? MessageSquare : ArrowRightLeft;
                    const iconBg = isCall ? 'bg-[hsl(var(--info))]/15 text-[hsl(var(--info))]'
                      : isNote ? 'bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))]'
                      : 'bg-primary/10 text-primary';
                    return (
                      <div key={item.id} className="flex gap-3 py-2.5 relative">
                        <div className={`flex h-[30px] w-[30px] items-center justify-center rounded-full shrink-0 ${iconBg}`}>
                          <IconComp className="h-3.5 w-3.5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-muted-foreground truncate">{item.description}</p>
                        </div>
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0 mt-0.5">{getTimeAgo(item.timestamp)}</span>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </AppLayout>
    );
  }

  return (
    <AppLayout title={t('nav.dashboard')}>
      {/* Filter bar — Phase 2 elevated */}
      {isAdmin && (
        <div className="mb-6 flex items-center gap-2 overflow-x-auto scrollbar-thin snap-x pb-1 rounded-2xl border bg-card/80 backdrop-blur-md p-3 shadow-sm md:flex-wrap md:overflow-visible md:pb-0 md:gap-3">
          <div className="flex items-center gap-2 shrink-0">
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="w-44 h-9 text-sm rounded-xl border-border/70">
                <Users className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                <SelectValue placeholder={t('dashboard.allAgents')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('dashboard.allAgents')}</SelectItem>
                {agents.map(a => <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <DateRangePicker value={range} onChange={setRange} />

          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 rounded-xl text-xs text-muted-foreground hover:text-foreground shrink-0"
              onClick={() => { setAgentFilter('all'); setRange(defaultRange()); }}
            >
              <X className="h-3.5 w-3.5 mr-1" /> {t('dashboard.clearFilters')}
            </Button>
          )}

          <div className="shrink-0 md:ml-auto">
            <Button
              variant="outline"
              size="sm"
              className="h-9 rounded-xl text-sm gap-1.5 border-border/70 hover:bg-muted/50"
              onClick={() => monthStats && exportCSV(monthStats, 'month', 'dashboard')}
            >
              <Download className="h-3.5 w-3.5" /> {t('dashboard.exportCsv')}
            </Button>
          </div>
        </div>
      )}

      {/* === 1. TOP SECTION — Approved Phase 2 Layout Refactor (Option A) === */}
      {/* Compact 2x2 Operational Status Quadrant + Elevated Funnel (addresses horizontal card stuffing) */}
      {isAdmin && ceoStats && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* Left: Compact Operational Status Quadrant (2x2) */}
          <Card className={`border border-border/60 bg-card ${hoverLift}`}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                {t('dashboard.operationalPulse')}
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-1">
              <div className="grid grid-cols-2 gap-3">
                {/* Confirmed */}
                <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/30 p-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(var(--warning))]">
                    <CheckCircle2 className="h-4.5 w-4.5 text-primary-foreground" />
                  </div>
                  <div>
                    <div className="text-2xl font-semibold tabular-nums">{ceoStats.confirmedCount || 0}</div>
                    <div className="text-[11px] font-medium text-muted-foreground">{t('status.confirmed')}</div>
                  </div>
                </div>

                {/* Shipped */}
                <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/30 p-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(var(--info))]">
                    <Truck className="h-4.5 w-4.5 text-primary-foreground" />
                  </div>
                  <div>
                    <div className="text-2xl font-semibold tabular-nums">{ceoStats.shippedCount || 0}</div>
                    <div className="text-[11px] font-medium text-muted-foreground">{t('status.shipped')}</div>
                  </div>
                </div>

                {/* Paid */}
                <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/30 p-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[hsl(var(--success))]">
                    <DollarSign className="h-4.5 w-4.5 text-primary-foreground" />
                  </div>
                  <div>
                    <div className="text-2xl font-semibold tabular-nums">{ceoStats.paidCount || 0}</div>
                    <div className="text-[11px] font-medium text-muted-foreground">{t('status.paid')}</div>
                  </div>
                </div>

                {/* Returned */}
                <div className="flex items-center gap-3 rounded-xl border border-border/50 bg-muted/30 p-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-destructive">
                    <TrendingDown className="h-4.5 w-4.5 text-primary-foreground" />
                  </div>
                  <div>
                    <div className="text-2xl font-semibold tabular-nums">{ceoStats.returnedCount || 0}</div>
                    <div className="text-[11px] font-medium text-muted-foreground">{t('status.returned')}</div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Right: Funnel Performance (now elevated — much higher visual priority) */}
          {funnel && (
            <Card className="border border-border/60 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                  <Target className="h-4 w-4 text-primary" />
                  {t('dashboard.funnelPerformance')}
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex items-center justify-between gap-3 overflow-x-auto pb-2">
                  {[
                    { label: t('dashboard.funnelTaken'), count: funnel.allTaken, pct: null, color: 'bg-[hsl(var(--info))]' },
                    { label: t('status.confirmed'), count: funnel.confirmed, pct: funnel.confirmationRate, color: 'bg-[hsl(var(--warning))]' },
                    { label: t('status.paid'), count: funnel.paid, pct: funnel.conversionRate, color: 'bg-[hsl(var(--success))]' },
                    { label: t('status.shipped'), count: funnel.shipped, pct: null, color: 'bg-primary' },
                    { label: t('status.returned'), count: funnel.returned, pct: funnel.returnRate, color: 'bg-destructive' },
                  ].map((stage, idx, arr) => (
                    <div key={stage.label} className="flex items-center gap-3 flex-1 min-w-[92px]">
                      <div className="flex-1 text-center">
                        <div className={`mx-auto mb-2 h-11 w-11 rounded-2xl flex items-center justify-center text-primary-foreground font-semibold text-xl shadow-sm ${stage.color}`}>
                          {stage.count}
                        </div>
                        <p className="text-xs font-medium tracking-tight text-card-foreground">{stage.label}</p>
                        {stage.pct !== null && (
                          <p className="text-[10px] font-medium text-muted-foreground mt-0.5">{stage.pct}%</p>
                        )}
                      </div>
                      {idx < arr.length - 1 && <ChevronRight className="h-4 w-4 text-muted-foreground/60 shrink-0 mt-3" />}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-1 mt-4 pt-4 border-t text-xs text-muted-foreground">
                  <span>{t('dashboard.conversionShort')} <span className={`font-semibold tabular-nums ${funnel.conversionRate < 10 ? 'text-destructive' : 'text-[hsl(var(--success))]'}`}>{funnel.conversionRate}%</span></span>
                  <span>{t('dashboard.confirmationShort')} <span className="font-semibold text-card-foreground tabular-nums">{funnel.confirmationRate}%</span></span>
                  <span>{t('dashboard.returnShort')} <span className={`font-semibold tabular-nums ${funnel.returnRate > 20 ? 'text-destructive' : 'text-card-foreground'}`}>{funnel.returnRate}%</span></span>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Financial Overview — Consolidated (approved plan 5.1.1) */}
      {isAdmin && ceoStats && (
        <Card className={`mb-6 border border-border/60 bg-card ${hoverLift}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-primary" />
              {t('dashboard.financialOverview')}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {/* Gross Revenue - most important */}
              <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">{t('dashboard.grossRevenue')}</div>
                <div className="text-3xl font-semibold tabular-nums tracking-tighter text-card-foreground">
                  {fmtCurrency(ceoStats.revenue || 0)}
                </div>
                <div className="text-[10px] text-muted-foreground mt-2">{t('dashboard.shippedPlusPaid')}</div>
              </div>

              {/* Outstanding */}
              <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">{t('dashboard.outstanding')}</div>
                <div className="text-3xl font-semibold tabular-nums tracking-tighter text-card-foreground">
                  {fmtCurrency(ceoStats.outstanding || 0)}
                </div>
                <div className="text-[10px] text-muted-foreground mt-2">{t('dashboard.shippedOnly')}</div>
              </div>

              {/* Profit (highlighted) */}
              <div className="rounded-xl border border-border/50 bg-primary/5 p-4">
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-1">
                  Profit <TrendingUp className="h-3 w-3" />
                </div>
                <div className="text-3xl font-semibold tabular-nums tracking-tighter text-[hsl(var(--success))]">
                  {fmtCurrency(ceoStats.profit || 0)}
                </div>
                <div className="text-[10px] text-muted-foreground mt-2">{t('dashboard.clearProfit')}</div>
              </div>
            </div>

            {/* Secondary breakdown - compact */}
            <div className="mt-4 pt-4 border-t flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
              <span>
                <span className="font-medium text-card-foreground">{t('dashboard.paidRevenueLabel')}</span> {fmtCurrency(ceoStats.paidAmount || 0)}
              </span>
              <span>
                <span className="font-medium text-destructive">{t('dashboard.returnedAmountLabel')}</span> {fmtCurrency(ceoStats.returnedAmount || 0)}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* === 6. DAILY SNAPSHOT STRIP — Phase 2 calmer premium treatment */}
      {isAdmin && snap && (
        <Card className="mb-6 border border-border/60 shadow-sm bg-gradient-to-r from-primary/5 via-primary/3 to-transparent">
          <CardContent className="flex flex-wrap items-center gap-6 py-4 px-5">
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                <Zap className="h-4 w-4 text-primary" />
              </div>
              <div>
                <div className="text-sm font-semibold text-card-foreground">{t('dashboard.todaysSnapshot')}</div>
                <div className="text-[10px] text-muted-foreground -mt-0.5">{t('dashboard.livePulse')}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm pl-1">
              <span><strong className="font-semibold text-card-foreground tabular-nums">{snap.taken}</strong> <span className="text-muted-foreground">{t('dashboard.snapTaken')}</span></span>
              <span><strong className="font-semibold text-[hsl(var(--success))] tabular-nums">{snap.confirmed}</strong> <span className="text-muted-foreground">{t('dashboard.snapConfirmed')}</span></span>
              <span><strong className="font-semibold text-primary tabular-nums">{snap.paid}</strong> <span className="text-muted-foreground">{t('dashboard.snapPaid')}</span></span>
              <span><strong className="font-semibold text-[hsl(var(--success))] tabular-nums">{fmtCurrency(snap.revenue)}</strong> <span className="text-muted-foreground">{t('dashboard.snapRevenue')}</span></span>
              <span><strong className="font-semibold text-destructive tabular-nums">{snap.returns}</strong> <span className="text-muted-foreground">{t('dashboard.snapReturns')}</span></span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Dual role personal stats strip */}
      {isDualRole && agentFilter === 'all' && personalToday && (
        <Card className="mb-6 border-none shadow-sm bg-gradient-to-r from-[hsl(var(--info))]/5 to-transparent">
          <CardContent className="flex items-center gap-6 py-3 px-5">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[hsl(var(--info))]" />
              <span className="text-sm font-semibold text-card-foreground">{t('dashboard.myStatsToday')}</span>
            </div>
            <div className="flex gap-6 text-sm">
              <span><strong className="text-card-foreground">{personalToday.total_orders}</strong> <span className="text-muted-foreground">{t('dashboard.statOrders')}</span></span>
              <span><strong className="text-[hsl(var(--success))]">{personalToday.deals_won}</strong> <span className="text-muted-foreground">{t('dashboard.statWon')}</span></span>
              <span><strong className="text-destructive">{personalToday.deals_lost}</strong> <span className="text-muted-foreground">lost</span></span>
              <span><strong className="text-[hsl(var(--info))]">{personalToday.tasks_completed}</strong> <span className="text-muted-foreground">calls</span></span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* === 2. REVENUE TREND + TOP AGENT + RISK ALERTS (now flows directly after the new top layout) === */}
      <div className="grid gap-6 lg:grid-cols-3 mb-6">
        {/* Revenue Trend Chart — Phase 2/3 elevated */}
        <Card className={`lg:col-span-2 border border-border/60 shadow-sm ${hoverLift}`}>
          <CardHeader className="pb-2 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              {t('dashboard.salesRevenueOverTime')}
            </CardTitle>
            <Tabs value={chartView} onValueChange={v => setChartView(v as any)} className="w-full sm:w-auto">
              <TabsList className="h-8 w-full sm:w-auto">
                <TabsTrigger value="revenue" className="text-xs px-3 h-7 flex-1 sm:flex-none">{t('dashboard.tabRevenue')}</TabsTrigger>
                <TabsTrigger value="orders" className="text-xs px-3 h-7 flex-1 sm:flex-none">{t('dashboard.tabOrders')}</TabsTrigger>
                <TabsTrigger value="leads" className="text-xs px-3 h-7 flex-1 sm:flex-none">{t('dashboard.tabLeads')}</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="pt-2">
            {revenueTrendData.length === 0 ? (
              <EmptyState
                title={t('dashboard.noDataPeriod')}
                description={t('dashboard.noDataPeriodDesc')}
                size="sm"
              />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={revenueTrendData}>
                  <defs>
                    <linearGradient id="gradRevenue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.28} />
                      <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradOrders" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_COLORS.secondary} stopOpacity={0.28} />
                      <stop offset="95%" stopColor={CHART_COLORS.secondary} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradLeads" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_COLORS.info} stopOpacity={0.28} />
                      <stop offset="95%" stopColor={CHART_COLORS.info} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ ...chartTooltipStyle, borderRadius: '8px' }} />
                  {chartView === 'revenue' && (
                    <Area type="monotone" dataKey="revenue" stroke={CHART_COLORS.primary} strokeWidth={2} fill="url(#gradRevenue)" name="Revenue (Paid)" />
                  )}
                  {chartView === 'orders' && (
                    <Area type="monotone" dataKey="orders" stroke={CHART_COLORS.secondary} strokeWidth={2} fill="url(#gradOrders)" />
                  )}
                  {chartView === 'leads' && (
                    <Area type="monotone" dataKey="leads" stroke={CHART_COLORS.info} strokeWidth={2} fill="url(#gradLeads)" />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Right column: Top Agent + Alerts — polished */}
        <div className="space-y-6">
          {/* Top Agent Widget */}
          {isAdmin && topAgent && (
            <Card className={`border border-border/60 bg-card ${hoverLift}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-[hsl(var(--warning))]" />
                  {t('dashboard.topAgentPeriod')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground font-bold text-lg">
                    {topAgent.name.charAt(0)}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-card-foreground">{topAgent.name}</p>
                    <p className="text-xs text-muted-foreground">#{1} by paid revenue</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-2">
                  <div className="rounded-lg bg-muted/50 p-2 text-center">
                    <p className="text-lg font-bold text-[hsl(var(--success))]">{fmtCurrency(topAgent.paidRevenue)}</p>
                    <p className="text-[10px] text-muted-foreground">{t('dashboard.paidRevenue')}</p>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-2 text-center">
                    <p className="text-lg font-bold text-primary">{topAgent.paidCount}</p>
                    <p className="text-[10px] text-muted-foreground">{t('dashboard.paidOrders')}</p>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-2 text-center">
                    <p className="text-lg font-bold text-card-foreground">{topAgent.conversionPct}%</p>
                    <p className="text-[10px] text-muted-foreground">{t('dashboard.conversion')}</p>
                  </div>
                  <div className="rounded-lg bg-muted/50 p-2 text-center">
                    <p className={`text-lg font-bold ${topAgent.returnPct > 20 ? 'text-destructive' : 'text-card-foreground'}`}>{topAgent.returnPct}%</p>
                    <p className="text-[10px] text-muted-foreground">{t('dashboard.returnRate')}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Risk & Alert Panel */}
          {isAdmin && (
            <Card className={`border border-border/60 bg-card ${hoverLift}`}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                  <Shield className="h-4 w-4 text-destructive" />
                  {t('dashboard.riskAlerts')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {alerts.length === 0 ? (
                  <div className="flex items-center gap-2 text-xs text-[hsl(var(--success))]">
                    <CheckCircle2 className="h-4 w-4" />
                    {t('dashboard.allHealthy')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {alerts.map((a: any, i: number) => (
                      <div key={i} className={`flex items-start gap-2 rounded-lg p-2.5 text-xs min-w-0 ${
                        a.level === 'red' ? 'bg-destructive/10 text-destructive' : 'bg-[hsl(var(--warning))]/10 text-[hsl(var(--warning))]'
                      }`}>
                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span className="min-w-0 break-words">{a.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* === 7. TOP AGENTS TEASER + ORDER STATUSES (full detail lives in Insights) === */}
      <div className="grid gap-6 lg:grid-cols-3 mb-6">
        {/* Top Agents — compact teaser; the full filterable table is Insights → Agents */}
        {isAdmin && (
          <Card className={`lg:col-span-2 border border-border/60 bg-card ${hoverLift}`}>
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                <Trophy className="h-4 w-4 text-[hsl(var(--warning))]" />
                {t('dashboard.topAgents')}
              </CardTitle>
              <Link to="/insights?tab=agents" className="flex items-center gap-0.5 text-xs font-medium text-primary hover:underline">
                {t('dashboard.viewAllAgents')} <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </CardHeader>
            <CardContent>
              {agentRankings.length === 0 ? (
                <EmptyState
                  title={t('dashboard.noAgentData')}
                  description={t('dashboard.noAgentDataDesc')}
                  size="sm"
                />
              ) : (
                <div className="space-y-2">
                  {agentRankings.slice(0, 3).map((a: any, idx: number) => (
                    <div
                      key={a.name}
                      className={`flex items-center justify-between rounded-lg border border-border/50 p-3 ${idx === 0 ? 'bg-primary/5' : 'bg-muted/30'}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary shrink-0">
                          {a.name.charAt(0)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-card-foreground truncate flex items-center gap-1.5">
                            {a.name}
                            {idx === 0 && <Trophy className="h-3.5 w-3.5 text-[hsl(var(--warning))] shrink-0" />}
                          </p>
                          <p className="text-[11px] text-muted-foreground">#{idx + 1} by paid revenue</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4 text-right shrink-0">
                        <div>
                          <p className="text-sm font-bold text-[hsl(var(--success))] tabular-nums">{fmtCurrency(a.paidRevenue)}</p>
                          <p className="text-[10px] text-muted-foreground">revenue</p>
                        </div>
                        <div className="hidden sm:block">
                          <p className="text-sm font-bold tabular-nums">{a.paidCount}</p>
                          <p className="text-[10px] text-muted-foreground">paid</p>
                        </div>
                        <div className="hidden sm:block">
                          <p className="text-sm font-bold tabular-nums">{a.conversionPct}%</p>
                          <p className="text-[10px] text-muted-foreground">conv.</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Order Statuses — compact counts; full breakdown is Insights → Overview */}
        <Card className={`border border-border/60 bg-card ${hoverLift}`}>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              {t('dashboard.orderStatuses')}
            </CardTitle>
            <Link to="/insights" className="flex items-center gap-0.5 text-xs font-medium text-primary hover:underline">
              {t('dashboard.fullBreakdown')} <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              {ALL_STATUSES.map(status => {
                const count = Number(statusCounts[status] || 0);
                return (
                  <div key={status} className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2">
                    <span className="text-xs font-medium text-muted-foreground truncate">{statusLabel(status)}</span>
                    <span className="text-sm font-bold text-card-foreground tabular-nums">{count}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Stock Levels + Recent Activity — polished */}
      <div className="grid gap-6 lg:grid-cols-3 mb-6 overflow-hidden">
        {/* Stock Levels */}
        {isAdmin && (
          <Card className={`border border-border/60 bg-card ${hoverLift}`}>
            <CardHeader className="pb-2 flex flex-row items-center justify-between">
              <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
                <Package className="h-4 w-4 text-primary" />
                {t('dashboard.warehouseStock')}
              </CardTitle>
              <Link to="/insights?tab=stock" className="flex items-center gap-0.5 text-xs font-medium text-primary hover:underline">
                {t('dashboard.fullReport')} <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                {[
                  { label: t('dashboard.lowStock'), count: lowStock, color: 'bg-destructive', textColor: 'text-destructive' },
                  { label: t('dashboard.mediumStock'), count: medStock, color: 'bg-[hsl(var(--warning))]', textColor: 'text-[hsl(var(--warning))]' },
                  { label: t('dashboard.highStock'), count: highStock, color: 'bg-[hsl(var(--success))]', textColor: 'text-[hsl(var(--success))]' },
                ].map(level => (
                  <div key={level.label} className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
                    <div className="flex items-center gap-2.5">
                      <span className={`h-2.5 w-2.5 rounded-full ${level.color}`} />
                      <span className="text-sm font-medium">{level.label}</span>
                    </div>
                    <span className={`text-lg font-bold ${level.textColor}`}>{level.count}</span>
                  </div>
                ))}
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-muted-foreground">{t('dashboard.totalProducts')}</span>
                  <span className="text-sm font-bold">{products.length}</span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted overflow-hidden flex">
                  {products.length > 0 && (
                    <>
                      <div className="h-full bg-destructive transition-all" style={{ width: `${(lowStock / products.length) * 100}%` }} />
                      <div className="h-full bg-[hsl(var(--warning))] transition-all" style={{ width: `${(medStock / products.length) * 100}%` }} />
                      <div className="h-full bg-[hsl(var(--success))] transition-all" style={{ width: `${(highStock / products.length) * 100}%` }} />
                    </>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recent Activity */}
        <Card className={`lg:col-span-2 border border-border/60 bg-card ${hoverLift} overflow-hidden`}>
          <CardHeader className="pb-2 flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              {t('dashboard.recentActivity')}
            </CardTitle>
            <span className="text-xs text-muted-foreground">{t('dashboard.nEvents', { count: recentActivity.length })}</span>
          </CardHeader>
          <CardContent>
            {recentActivity.length === 0 ? (
              <EmptyState
                title={t('dashboard.noRecentActivity')}
                description={t('dashboard.noRecentActivityDesc')}
                size="sm"
              />
            ) : (
              <ScrollArea className="h-[320px] pr-3">
                <div className="relative max-w-full overflow-hidden">
                  <div className="absolute left-[15px] top-2 bottom-2 w-px bg-border" />
                  <div className="space-y-1">
                    {recentActivity.map((item: any) => {
                      const isCall = item.type === 'call';
                      const isNote = item.type === 'note';
                      const icon = isCall ? Phone : isNote ? MessageSquare : ArrowRightLeft;
                      const IconComp = icon;
                      const iconBg = isCall
                        ? 'bg-[hsl(var(--info))]/15 text-[hsl(var(--info))]'
                        : isNote
                        ? 'bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))]'
                        : 'bg-primary/10 text-primary';
                      const timeAgo = getTimeAgo(item.timestamp);

                      return (
                        <div key={item.id} className="flex gap-3 py-2.5 pl-0 relative group">
                          <div className={`flex h-[30px] w-[30px] items-center justify-center rounded-full shrink-0 z-10 ${iconBg}`}>
                            <IconComp className="h-3.5 w-3.5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-0.5">
                              <span className="text-xs font-semibold text-card-foreground">{item.actor}</span>
                              {item.type === 'status_change' && item.metadata?.to && (
                                <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                                  item.metadata.to === 'confirmed' ? 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]' :
                                  item.metadata.to === 'shipped' ? 'bg-[hsl(var(--info))]/15 text-[hsl(var(--info))]' :
                                  item.metadata.to === 'cancelled' || item.metadata.to === 'trashed' ? 'bg-destructive/15 text-destructive' :
                                  'bg-muted text-muted-foreground'
                                }`}>
                                  {statusLabel(item.metadata.to)}
                                </span>
                              )}
                              {isCall && item.metadata?.outcome && (
                                <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                                  item.metadata.outcome === 'confirmed' ? 'bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]' :
                                  item.metadata.outcome === 'no_answer' ? 'bg-[hsl(var(--warning))]/15 text-[hsl(var(--warning))]' :
                                  'bg-muted text-muted-foreground'
                                }`}>
                                  {item.metadata.outcome}
                                </span>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground truncate">{item.description}</p>
                          </div>
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0 mt-0.5">{timeAgo}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>

    </AppLayout>
  );
}
