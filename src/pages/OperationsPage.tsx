import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/layouts/AppLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiGetOperationsCenter, apiGetActiveCallViews } from '@/lib/api';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/currency';
import { EmptyState } from '@/components/EmptyState';
import {
  Activity, Users, ShoppingCart, Truck, RotateCcw, Banknote,
  RefreshCw, Loader2, Circle, CheckCircle2, TrendingUp, Eye, Phone,
} from 'lucide-react';

interface AgentInfo {
  user_id: string;
  full_name: string;
  email: string;
  roles: string[];
  is_online: boolean;
  /** Live browser-reported softphone state (dialing/in_call, staleness-guarded). */
  in_call?: boolean;
  login_time: string | null;
  active_leads: number;
  today_confirmed: number;
  today_total: number;
}

interface OpsData {
  kpi: {
    total_orders_today: number;
    confirmed_today: number;
    shipped_today: number;
    returned_today: number;
    paid_today: number;
    revenue_today: number;
  };
  agents: AgentInfo[];
  agents_online: number;
  agents_total: number;
}

interface ActiveCallView {
  id: string;
  agent_id: string;
  agent_name: string;
  customer_phone: string;
  opened_at: string;
  expires_at: string;
}

export default function OperationsPage() {
  const { t } = useTranslation();
  const [data, setData] = useState<OpsData | null>(null);
  const [activeViews, setActiveViews] = useState<ActiveCallView[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const fetchData = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const result = await apiGetOperationsCenter();
      setData(result);

      // Live agent activity
      const views = await apiGetActiveCallViews();
      setActiveViews(views || []);

      setLastRefresh(new Date());
    } catch {}
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { fetchData(); }, []);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => fetchData(true), 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <AppLayout title={t('titles.operationsCenter')}>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  const kpi = data?.kpi;
  const agents = data?.agents || [];
  const onlineAgents = agents.filter(a => a.is_online);
  const offlineAgents = agents.filter(a => !a.is_online);

  const kpiCards = [
    { label: t('ops.ordersToday'), value: kpi?.total_orders_today || 0, icon: ShoppingCart, color: 'bg-primary/10 text-primary' },
    { label: t('status.confirmed'), value: kpi?.confirmed_today || 0, icon: CheckCircle2, color: 'bg-emerald-500/10 text-emerald-600' },
    { label: t('status.shipped'), value: kpi?.shipped_today || 0, icon: Truck, color: 'bg-blue-500/10 text-blue-600' },
    { label: t('status.paid'), value: kpi?.paid_today || 0, icon: Banknote, color: 'bg-violet-500/10 text-violet-600' },
    { label: t('ops.returns'), value: kpi?.returned_today || 0, icon: RotateCcw, color: (kpi?.returned_today || 0) > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground' },
    { label: t('ops.todaysRevenue'), value: formatMoney(kpi?.revenue_today || 0), icon: TrendingUp, color: 'bg-emerald-500/10 text-emerald-600' },
  ];

  return (
    <AppLayout title={t('titles.operationsCenter')}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="hidden sm:flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 shrink-0">
              <Activity className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base sm:text-xl font-bold truncate">{t('ops.commandCenter')}</h1>
              <p className="text-xs text-muted-foreground truncate">
                {t('ops.liveData', { time: lastRefresh.toLocaleTimeString() })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <Badge variant="outline" className="gap-1.5">
              <Circle className={cn("h-2 w-2 fill-current", (data?.agents_online || 0) > 0 ? "text-emerald-500" : "text-muted-foreground")} />
              {t('ops.onlineCount', { online: data?.agents_online || 0, total: data?.agents_total || 0 })}
            </Badge>
            <Button variant="outline" size="sm" onClick={() => fetchData(true)} disabled={refreshing}>
              <RefreshCw className={cn("h-4 w-4 sm:mr-1", refreshing && "animate-spin")} />
              <span className="hidden sm:inline">{t('ops.refresh')}</span>
            </Button>
          </div>
        </div>

        {/* KPI Grid */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {kpiCards.map(card => (
            <Card key={card.label} className="border-none shadow-sm">
              <CardContent className="flex items-center gap-3 p-4">
                <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl shrink-0", card.color)}>
                  <card.icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground leading-tight">{card.label}</p>
                  <p className="text-xl font-bold">{card.value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Live Agent Activity Widget */}
        <Card className="border-none shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Eye className="h-4 w-4 text-blue-600" />
              {t('ops.liveActivity', { count: activeViews.length })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activeViews.length === 0 ? (
              <EmptyState
                icon={<Users className="h-5 w-5" />}
                title={t('ops.noAgentsOnCustomer')}
                size="sm"
                className="border-0 bg-transparent py-4"
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {activeViews.map((view) => (
                  <div key={view.id} className="flex items-center gap-3 rounded-lg border p-3 bg-blue-50/40">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-500/10 text-blue-600 shrink-0">
                      <Users className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm truncate">{view.agent_name}</p>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Phone className="h-3 w-3" />
                        <span className="font-mono">{view.customer_phone}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">
                        {t('ops.since', { time: new Date(view.opened_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Agent Activity Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Online Agents */}
          <Card className="border-none shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Circle className="h-2.5 w-2.5 fill-emerald-500 text-emerald-500" />
                {t('ops.onlineAgents', { count: onlineAgents.length })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {onlineAgents.length === 0 ? (
                <EmptyState
                  icon={<Circle className="h-5 w-5" />}
                  title={t('ops.noAgentsOnline')}
                  size="sm"
                  className="border-0 bg-transparent py-4"
                />
              ) : (
                onlineAgents.map(agent => (
                  <div key={agent.user_id} className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/30 transition-colors">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-500/10">
                        <Users className="h-4 w-4 text-emerald-600" />
                      </div>
                      <div>
                        <p className="text-sm font-medium flex items-center gap-1.5">
                          {agent.full_name}
                          {agent.in_call && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 border border-rose-500/30 px-1.5 py-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                              <span className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                              {t('assigner.statusInCall')}
                            </span>
                          )}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {agent.login_time ? t('ops.since', { time: new Date(agent.login_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('ops.active')}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs">
                      <div className="text-center">
                        <p className="font-bold text-primary">{agent.active_leads}</p>
                        <p className="text-muted-foreground">{t('ops.active')}</p>
                      </div>
                      <div className="text-center">
                        <p className="font-bold text-emerald-600">{agent.today_confirmed}</p>
                        <p className="text-muted-foreground">{t('status.confirmed')}</p>
                      </div>
                      <div className="text-center">
                        <p className="font-bold">{agent.today_total}</p>
                        <p className="text-muted-foreground">{t('ops.total')}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          {/* Offline Agents */}
          <Card className="border-none shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Circle className="h-2.5 w-2.5 fill-muted-foreground text-muted-foreground" />
                {t('ops.offlineAgents', { count: offlineAgents.length })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {offlineAgents.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">{t('ops.allOnline')}</p>
              ) : (
                offlineAgents.map(agent => (
                  <div key={agent.user_id} className="flex items-center justify-between rounded-lg border border-dashed p-3 opacity-70">
                    <div className="flex items-center gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
                        <Users className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{agent.full_name}</p>
                        <p className="text-[11px] text-muted-foreground">{t('ops.offline')}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs">
                      <div className="text-center">
                        <p className="font-bold">{agent.active_leads}</p>
                        <p className="text-muted-foreground">{t('ops.pending')}</p>
                      </div>
                      <div className="text-center">
                        <p className="font-bold">{agent.today_total}</p>
                        <p className="text-muted-foreground">{t('ops.today')}</p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
