import { Fragment, useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { AppLayout } from '@/layouts/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { apiGetDashboardStats, apiGetRecentActivity, apiGetMyDayWork } from '@/lib/api';
import { InsightsFilterBar } from '@/components/insights/shared/InsightsFilterBar';
import OverviewTab from '@/components/insights/overview/OverviewTab';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type DateRange } from '@/components/DateRangePicker';
import {
  CheckCircle2, Package, Users, TrendingUp, TrendingDown,
  Target, ArrowUpRight, ArrowDownRight,
  Activity,
  X, MessageSquare, Phone, ArrowRightLeft, FileText,
  ChevronRight,
  ChevronLeft, Trash2, Banknote, Clock,
  PhoneForwarded, ListChecks,
} from 'lucide-react';
import { MyOrdersSection } from '@/components/dashboard/MyOrdersSection';
import { MyDayWorkTable } from '@/components/dashboard/MyDayWorkTable';
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
                {Math.abs(trend)}% <span className="text-muted-foreground/70">{i18n.t('dashboard.vsYesterday')}</span>
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

import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/currency';
import { activityText } from '@/lib/activityFeed';
import { EmptyState } from '@/components/EmptyState';

// Macedonia shows denars only. Routed through the shared helper so this page
// can never drift from the rest of the app's money formatting.
const fmtCurrency = (n: number) => formatMoney(n);

/** "2026-09-28" → "28.09" for the chart axes (Macedonian day-first order). */
const ddmm = (ymd: string) => (ymd && ymd.length >= 10 ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}` : ymd);


export default function Dashboard() {
  const { t } = useTranslation(); // subscribes status labels to language switches
  const { user } = useAuth();
  const isAdmin = user?.isAdmin;
  const [agentPeriod, setAgentPeriod] = useState<'today' | 'month' | 'start' | 'custom'>('today');
  // Day browsing (◀ ▶): UTC day string, matching the backend's UTC window math.
  // The agent's "today" is the Skopje calendar day, matching the window the API
  // now resolves. Reading it off the UTC clock made the ◀ ▶ navigator and the
  // server disagree for the first two hours of every Macedonian day.
  const todayUtc = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' }).format(new Date());
  const [agentDate, setAgentDate] = useState(todayUtc);
  // Custom range (period='custom'): defaults to this month so far, fully editable.
  const [agentRange, setAgentRange] = useState<DateRange>({ from: todayUtc.slice(0, 7) + '-01', to: todayUtc });
  // The admin agent filter went with the old CEO view (the Overview has its own filters).
  const agentFilter = 'all' as string;

  const effectiveAgent = agentFilter !== 'all' ? agentFilter : undefined;

  const { data: todayStats } = useQuery<DashStats>({
    queryKey: ['dashboard-stats', 'day', agentDate, effectiveAgent],
    queryFn: () => apiGetDashboardStats({ period: 'today', date: agentDate, agent_id: effectiveAgent }),
    refetchInterval: 30000,
    enabled: !isAdmin,
  });

  const { data: monthStats } = useQuery<DashStats>({
    queryKey: ['dashboard-stats', 'month', effectiveAgent],
    queryFn: () => apiGetDashboardStats({ period: 'month', agent_id: effectiveAgent }),
    refetchInterval: 60000,
    enabled: !isAdmin,
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

  const dayWorkPeriod = agentPeriod === 'start' ? 'custom' as const : agentPeriod === 'custom' ? 'custom' as const : agentPeriod;
  const dayWorkFrom = agentPeriod === 'start' ? '2000-01-01' : agentRange.from;
  const dayWorkTo = agentPeriod === 'start' ? todayUtc : agentRange.to;
  const { data: dayWorkHead } = useQuery({
    queryKey: ['my-day-work', dayWorkPeriod, agentDate, dayWorkFrom, dayWorkTo, 1],
    queryFn: () => apiGetMyDayWork({
      period: dayWorkPeriod,
      date: agentDate,
      from: dayWorkFrom,
      to: dayWorkTo,
      page: 1,
    }),
    enabled: !isAdmin,
    refetchInterval: 30_000,
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


  // ── Call Agent view: a purpose-built "My Performance" page (their numbers
  // only). Admins/managers fall through to the full operational dashboard. ──
  if (!isAdmin) {
    const stats =
      agentPeriod === 'today' ? todayStats
      : agentPeriod === 'month' ? monthStats
      : agentPeriod === 'start' ? startStats
      : customStats;
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
    const sales = actTotal.confirmed || 0;
    const cancels = actTotal.cancelled || 0;
    const trashed = actTotal.trashed || 0;
    const predMembers = stats?.prediction_members_total || 0;
    const callAgainOpen = actTotal.call_again || stats?.call_again_open || 0;
    // channels.__total has always been fetched and typed and never rendered.
    // It carries the order-lifecycle counts and, notably, revenue_confirmed —
    // the one figure on the operator's list that no screen showed anywhere.
    const chTotal: ChannelStats = stats?.channels?.__total || EMPTY_CHANNEL;
    const revenueConfirmed = Number(dayWorkHead?.totals?.confirmed_sum ?? chTotal.revenue_confirmed ?? 0);

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
        date: ddmm(date),
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
            icon={Banknote}
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

        <MyDayWorkTable period={ordersPeriod} date={agentDate} from={ordersFrom} to={ordersTo} />

        {/* Pipeline chase: Confirmed | Shipped | Paid | Returned */}
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
                    <Area type="monotone" dataKey="sales" stroke="hsl(142, 76%, 36%)" strokeWidth={2} fill="url(#agSales)" name={t('dashboard.sales')} />
                    <Area type="monotone" dataKey="calls" stroke="hsl(27, 95%, 48%)" strokeWidth={2} fillOpacity={0} name={t('dashboard.chartCalls')} />
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
                          <p className="text-xs text-muted-foreground truncate">{activityText(item)}</p>
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

  // ── Admins: the Dashboard IS the Overview (owner, 29.09.2026: "Табла, Insights and Operations
  // synchronised — one calculation"). The old CEO tiles counted CRM statuses by created day (a UTC
  // day), called shipped + paid "revenue" and credited the assigned agent; the Overview is the
  // cohort — sale day, the six departments, MEX first — the same numbers as Insights → Преглед,
  // with its own period bar and every number opening exactly its orders.
  return (
    <AppLayout title={t('nav.dashboard')}>
      <div className="space-y-5">
        <InsightsFilterBar />
        <OverviewTab />
      </div>
    </AppLayout>
  );
}
