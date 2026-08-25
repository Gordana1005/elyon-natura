import { useState, useEffect, useMemo } from 'react';
import { apiErrorText } from '@/i18n/apiErrors';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/layouts/AppLayout';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import {
  apiGetLeadDistributionConfig, apiUpdateLeadDistributionConfig, apiAutoAssignLeads,
  apiGetLeadRoutingRules, apiSetLeadRoutingRule,
  apiGetLeadDistParticipants, apiSetLeadDistParticipant,
  apiAutoAssignCallAgains,
  type LeadDistConfig, type LeadDistResult, type LeadDistProductRule, type LeadDistParticipant,
} from '@/lib/api';
import { formatEurExact } from '@/lib/currency';
import { AgentPickerChips } from '@/components/assigner/AgentPickerChips';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/EmptyState';
import {
  Shuffle, Scale, Star, Loader2, Play, Square, Settings2, Package,
  Users, Zap, CheckCircle2, AlertTriangle, Eye, Inbox, Clock,
} from 'lucide-react';

// Labels/descriptions resolved at render via t().
const STRATEGIES = [
  { value: 'round_robin', labelKey: 'leadDist.roundRobin', icon: Shuffle, descKey: 'leadDist.roundRobinDesc' },
  { value: 'load_balance', labelKey: 'leadDist.loadBalance', icon: Scale, descKey: 'leadDist.loadBalanceDesc' },
  { value: 'priority', labelKey: 'leadDist.priority', icon: Star, descKey: 'leadDist.priorityDesc' },
] as const;

export default function LeadDistributionPage() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [config, setConfig] = useState<LeadDistConfig | null>(null);
  const [products, setProducts] = useState<LeadDistProductRule[]>([]);
  const [participants, setParticipants] = useState<LeadDistParticipant[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [lastResult, setLastResult] = useState<LeadDistResult | null>(null);

  // Local form state for the settings that need a Save.
  const [strategy, setStrategy] = useState<LeadDistConfig['strategy']>('round_robin');
  const [maxLeads, setMaxLeads] = useState('50');
  const [priorityThreshold, setPriorityThreshold] = useState('500');
  const [respectOnline, setRespectOnline] = useState(true);
  const [includePredictionLoad, setIncludePredictionLoad] = useState(false);
  const [workingHoursOnly, setWorkingHoursOnly] = useState(false);
  const [orderDirection, setOrderDirection] = useState<'newest' | 'oldest'>('newest');
  const [offlineReleaseMins, setOfflineReleaseMins] = useState('15');
  const [cbSource, setCbSource] = useState<'all' | 'order' | 'prediction'>('all');
  const [cbMinutes, setCbMinutes] = useState('15');
  const [cbAgents, setCbAgents] = useState<string[]>([]);
  const [cbRunning, setCbRunning] = useState(false);

  const hydrate = (cfg: LeadDistConfig) => {
    setConfig(cfg);
    setStrategy(cfg.strategy);
    setMaxLeads(String(cfg.max_leads_per_agent));
    setPriorityThreshold(String(cfg.priority_threshold));
    setRespectOnline(cfg.respect_online);
    setIncludePredictionLoad(cfg.include_prediction_load);
    setWorkingHoursOnly(cfg.working_hours_only);
    setOrderDirection(cfg.order_direction);
    setOfflineReleaseMins(String(cfg.call_again_offline_release_minutes ?? 15));
  };

  const fetchData = async (withSpinner = true) => {
    if (withSpinner) setLoading(true);
    try {
      const [cfg, rules, parts] = await Promise.all([
        apiGetLeadDistributionConfig(),
        apiGetLeadRoutingRules().catch(() => ({ products: [] as LeadDistProductRule[] })),
        apiGetLeadDistParticipants().catch(() => ({ participating_roles: [], participants: [] as LeadDistParticipant[] })),
      ]);
      hydrate(cfg);
      setProducts(rules.products || []);
      setParticipants(parts.participants || []);
    } catch (err: any) {
      toast({ title: t('leadDist.errorLoadingConfig'), description: apiErrorText(err), variant: 'destructive' });
    } finally { if (withSpinner) setLoading(false); }
  };

  useEffect(() => { fetchData(); }, []);

  // While the engine is running the picture changes underneath the operator —
  // the cron assigns every minute and the trigger fires on arrival.
  useEffect(() => {
    if (!config?.is_active) return;
    const id = setInterval(() => { fetchData(false); }, 20000);
    return () => clearInterval(id);
  }, [config?.is_active]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiUpdateLeadDistributionConfig({
        strategy,
        max_leads_per_agent: parseInt(maxLeads) || 50,
        priority_threshold: parseFloat(priorityThreshold) || 0,
        respect_online: respectOnline,
        include_prediction_load: includePredictionLoad,
        working_hours_only: workingHoursOnly,
        order_direction: orderDirection,
        call_again_offline_release_minutes: parseInt(offlineReleaseMins) || 0,
      });
      toast({ title: t('leadDist.configSaved') });
      fetchData(false);
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  // Start/Stop is the whole point of the page: once started the engine keeps
  // assigning new arrivals until it is stopped, with no further action.
  const handleToggleEngine = async () => {
    const next = !config?.is_active;
    setToggling(true);
    try {
      await apiUpdateLeadDistributionConfig({ is_active: next });
      toast({ title: next ? t('leadDist.engineStarted') : t('leadDist.engineStopped') });
      await fetchData(false);
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setToggling(false); }
  };

  const handleAutoAssignCallbacks = async (mode: 'online' | 'selected') => {
    if (mode === 'selected' && cbAgents.length === 0) {
      toast({ title: t('leadDist.autoAssignNoAgents'), variant: 'destructive' });
      return;
    }
    setCbRunning(true);
    try {
      const result = await apiAutoAssignCallAgains({
        source: cbSource,
        online_minutes: parseInt(cbMinutes) || 15,
        agent_ids: mode === 'selected' ? cbAgents : undefined,
      });
      if (!result.agents) {
        toast({ title: t('leadDist.autoAssignNoAgents'), variant: 'destructive' });
        return;
      }
      toast({
        title: t('leadDist.autoAssignSuccess', { count: result.assigned, agents: result.agents }),
      });
      fetchData(false);
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setCbRunning(false); }
  };

  const handleRun = async (dryRun: boolean) => {
    setRunning(true);
    setLastResult(null);
    try {
      const result = await apiAutoAssignLeads({ dryRun });
      setLastResult(result);
      if (!dryRun) {
        toast({
          title: t('leadDist.distributionComplete'),
          description: t('leadDist.distributionCompleteDesc', { count: result.assigned }),
        });
      }
      fetchData(false);
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setRunning(false); }
  };

  const handleProductAgents = async (productId: string, agentIds: string[]) => {
    setProducts(prev => prev.map(p => (p.product_id === productId ? { ...p, agent_ids: agentIds } : p)));
    try {
      await apiSetLeadRoutingRule(productId, agentIds);
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
      fetchData(false);
    }
  };

  const handleParticipant = async (agentId: string, isParticipating: boolean) => {
    setParticipants(prev => prev.map(p => (p.agent_id === agentId ? { ...p, is_participating: isParticipating } : p)));
    try {
      await apiSetLeadDistParticipant(agentId, isParticipating);
      fetchData(false);
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
      fetchData(false);
    }
  };

  // The agent chips used by the product-routing pickers. Only agents the engine
  // would actually consider appear here, so a rule can never point at somebody
  // who could never receive the lead anyway.
  const agentChips = useMemo(
    () => participants.filter(p => p.is_participating).map(p => {
      const c = config?.candidates?.find(x => x.agent_id === p.agent_id);
      return {
        user_id: p.agent_id,
        full_name: p.full_name,
        is_online: c?.is_online ?? false,
        active_leads: c?.open_leads ?? 0,
        members_open: c?.open_members ?? 0,
      };
    }),
    [participants, config?.candidates],
  );

  const isActive = !!config?.is_active;
  const candidates = config?.candidates || [];
  const withCapacity = candidates.filter(c => c.has_capacity).length;
  const onlineCount = candidates.filter(c => c.is_online).length;
  const cap = parseInt(maxLeads) || 50;
  const routedProducts = products.filter(p => p.agent_ids.length > 0).length;

  // Why did the last run do nothing? The page was silent about this for the
  // entire week the engine sat dead.
  const reasonText = (reason: string | null | undefined) => {
    if (!reason) return null;
    const key = `leadDist.reason.${reason}`;
    const translated = t(key);
    return translated === key ? reason : translated;
  };

  if (loading) {
    return (
      <AppLayout title={t('nav.leadDistribution')}>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title={t('titles.leadDistributionEngine')}>
      <div className="space-y-6">
        {/* Header + the Start/Stop control */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className={cn('flex h-10 w-10 items-center justify-center rounded-xl',
              isActive ? 'bg-emerald-500/10' : 'bg-primary/10')}>
              <Zap className={cn('h-5 w-5', isActive ? 'text-emerald-600' : 'text-primary')} />
            </div>
            <div>
              <h1 className="text-xl font-bold">{t('titles.leadDistributionEngine')}</h1>
              <p className="text-xs text-muted-foreground">{t('leadDist.configureRules')}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant={isActive ? 'default' : 'secondary'} className={cn('text-xs', isActive && 'bg-emerald-600')}>
              <span className={cn('mr-1.5 inline-block h-2 w-2 rounded-full',
                isActive ? 'bg-white animate-pulse' : 'bg-muted-foreground')} />
              {isActive ? t('leadDist.engineActive') : t('leadDist.engineDisabled')}
            </Badge>
            <Button
              onClick={handleToggleEngine}
              disabled={toggling}
              variant={isActive ? 'destructive' : 'default'}
              className="gap-2"
            >
              {toggling ? <Loader2 className="h-4 w-4 animate-spin" />
                : isActive ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
              {isActive ? t('leadDist.stop') : t('leadDist.start')}
            </Button>
          </div>
        </div>

        {/* Live status strip */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile icon={<Inbox className="h-4 w-4" />} label={t('leadDist.waitingNow')}
            value={String(config?.waiting_leads ?? 0)} tone={(config?.waiting_leads ?? 0) > 0 && !isActive ? 'warn' : 'default'} />
          <StatTile icon={<Inbox className="h-4 w-4" />} label={t('leadDist.waitingCallAgains')}
            value={String(config?.waiting_call_agains ?? 0)}
            sub={t('leadDist.waitingCallAgainsSub')} />
          <StatTile icon={<CheckCircle2 className="h-4 w-4" />} label={t('leadDist.assignedToday')}
            value={String(config?.assigned_today ?? 0)} />
          <StatTile icon={<Users className="h-4 w-4" />} label={t('leadDist.agentsReady')}
            value={`${withCapacity} / ${candidates.length}`} sub={t('leadDist.onlineNow', { count: onlineCount })} />
          <StatTile icon={<Clock className="h-4 w-4" />} label={t('leadDist.lastRun')}
            value={config?.last_run_at ? new Date(config.last_run_at).toLocaleTimeString() : '—'}
            sub={reasonText(config?.last_meaningful_run?.skipped_reason) || undefined} />
        </div>

        {!isActive && (config?.waiting_leads ?? 0) > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t('leadDist.stoppedWithBacklog', { count: config?.waiting_leads ?? 0 })}</span>
          </div>
        )}

        <Tabs defaultValue="settings" className="space-y-4">
          <TabsList>
            <TabsTrigger value="settings" className="gap-1.5">
              <Settings2 className="h-3.5 w-3.5" /> {t('leadDist.configuration')}
            </TabsTrigger>
            <TabsTrigger value="products" className="gap-1.5">
              <Package className="h-3.5 w-3.5" /> {t('leadDist.productRouting')}
              {routedProducts > 0 && <Badge variant="secondary" className="ml-1 text-[10px]">{routedProducts}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="agents" className="gap-1.5">
              <Users className="h-3.5 w-3.5" /> {t('leadDist.agentWorkload')}
            </TabsTrigger>
          </TabsList>

          {/* ── Settings ───────────────────────────────────────────── */}
          <TabsContent value="settings" className="space-y-6">
            <Card className="border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Settings2 className="h-4 w-4" /> {t('leadDist.strategy')}
                </CardTitle>
                <CardDescription>{t('leadDist.chooseHow')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {STRATEGIES.map(s => (
                    <button
                      key={s.value}
                      onClick={() => setStrategy(s.value)}
                      className={cn(
                        'flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-left transition-all',
                        strategy === s.value
                          ? 'border-primary bg-primary/5 shadow-sm'
                          : 'border-border hover:border-primary/30 hover:bg-muted/30'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <s.icon className={cn('h-4 w-4', strategy === s.value ? 'text-primary' : 'text-muted-foreground')} />
                        <span className="text-sm font-semibold">{t(s.labelKey)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{t(s.descKey)}</p>
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{t('leadDist.strategyLayerNote')}</p>
              </CardContent>
            </Card>

            <Card className="border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-sm">{t('leadDist.configuration')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <Label className="text-xs">{t('leadDist.maxLeads')}</Label>
                    <Input type="number" value={maxLeads} onChange={e => setMaxLeads(e.target.value)} min="1" max="500" className="mt-1" />
                    <p className="text-[10px] text-muted-foreground mt-1">{t('leadDist.maxLeadsDesc')}</p>
                  </div>
                  {strategy === 'priority' && (
                    <div>
                      <Label className="text-xs">{t('leadDist.highValue')}</Label>
                      <Input type="number" value={priorityThreshold} onChange={e => setPriorityThreshold(e.target.value)} min="0" step="1" className="mt-1" />
                      {/* The threshold is compared against orders.price, which is
                          stored in EUR — never denars. See elyon-currency. */}
                      <p className="text-[10px] text-muted-foreground mt-1">
                        {t('leadDist.highValueDesc', { value: formatEurExact(parseFloat(priorityThreshold) || 0) })}
                      </p>
                    </div>
                  )}
                </div>

                <ToggleRow
                  label={t('leadDist.respectOnline')} desc={t('leadDist.respectOnlineDesc')}
                  checked={respectOnline} onChange={setRespectOnline}
                />
                <ToggleRow
                  label={t('leadDist.includePredictionLoad')} desc={t('leadDist.includePredictionLoadDesc')}
                  checked={includePredictionLoad} onChange={setIncludePredictionLoad}
                />
                <ToggleRow
                  label={t('leadDist.workingHoursOnly')} desc={t('leadDist.workingHoursOnlyDesc')}
                  checked={workingHoursOnly} onChange={setWorkingHoursOnly}
                />
                <ToggleRow
                  label={t('leadDist.newestFirst')} desc={t('leadDist.newestFirstDesc')}
                  checked={orderDirection === 'newest'}
                  onChange={v => setOrderDirection(v ? 'newest' : 'oldest')}
                />
                <div>
                  <Label className="text-xs">{t('leadDist.offlineReleaseMinutes')}</Label>
                  <Input type="number" value={offlineReleaseMins} onChange={e => setOfflineReleaseMins(e.target.value)} min="0" max="1440" className="mt-1" />
                  <p className="text-[10px] text-muted-foreground mt-1">{t('leadDist.offlineReleaseMinutesDesc')}</p>
                </div>

                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <Button onClick={handleSave} disabled={saving}>
                    {saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                    {t('leadDist.saveConfig')}
                  </Button>
                  <Button variant="outline" onClick={() => handleRun(true)} disabled={running} className="gap-2">
                    {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                    {t('leadDist.preview')}
                  </Button>
                  <Button variant="secondary" onClick={() => handleRun(false)} disabled={running} className="gap-2">
                    {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {t('leadDist.runOnce')}
                  </Button>
                </div>

                {lastResult && <RunResult result={lastResult} reasonText={reasonText} t={t} />}
              </CardContent>
            </Card>

            <Card className="border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Clock className="h-4 w-4" /> {t('leadDist.autoAssignCallbacks')}
                </CardTitle>
                <CardDescription>{t('leadDist.autoAssignCallbacksDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <Label className="text-xs">{t('leadDist.callbackSource')}</Label>
                    <Select value={cbSource} onValueChange={v => setCbSource(v as typeof cbSource)}>
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">{t('callAgainPage.sourceAll')}</SelectItem>
                        <SelectItem value="order">{t('callAgainPage.sourcePendings')}</SelectItem>
                        <SelectItem value="prediction">{t('callAgainPage.sourcePrediction')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">{t('leadDist.autoAssignMinutes')}</Label>
                    <Select value={cbMinutes} onValueChange={setCbMinutes}>
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="10">10</SelectItem>
                        <SelectItem value="15">15</SelectItem>
                        <SelectItem value="20">20</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">{t('leadDist.pickAgentsOrOnline')}</p>
                <AgentPickerChips
                  agents={agentChips}
                  selected={cbAgents}
                  onToggle={(id) => setCbAgents(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
                  onClear={() => setCbAgents([])}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    disabled={cbRunning}
                    onClick={() => handleAutoAssignCallbacks('online')}
                    className="gap-2"
                  >
                    {cbRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shuffle className="h-4 w-4" />}
                    {t('leadDist.autoAssignCallbacksOnline')}
                  </Button>
                  <Button
                    disabled={cbRunning || cbAgents.length === 0}
                    onClick={() => handleAutoAssignCallbacks('selected')}
                    className="gap-2"
                  >
                    {cbRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
                    {t('leadDist.autoAssignCallbacksToSelected', { count: cbAgents.length })}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Product routing ────────────────────────────────────── */}
          <TabsContent value="products">
            <Card className="border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Package className="h-4 w-4" /> {t('leadDist.productRouting')}
                </CardTitle>
                <CardDescription>{t('leadDist.productRoutingDesc')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {products.length === 0 ? (
                  <EmptyState icon={<Package className="h-4 w-4" />} title={t('leadDist.noProducts')} size="sm" />
                ) : (
                  products.map(p => (
                    <details key={p.product_id} className="rounded-lg border">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          {p.name}
                          {!p.is_active && <Badge variant="outline" className="text-[10px]">{t('leadDist.inactiveProduct')}</Badge>}
                        </span>
                        <Badge variant={p.agent_ids.length ? 'default' : 'secondary'} className="text-[10px]">
                          {p.agent_ids.length
                            ? t('leadDist.nSpecialists', { count: p.agent_ids.length })
                            : t('leadDist.everyone')}
                        </Badge>
                      </summary>
                      <div className="space-y-2 border-t p-3">
                        <p className="text-[11px] text-muted-foreground">{t('leadDist.productRuleHint')}</p>
                        <AgentPickerChips
                          agents={agentChips}
                          selected={p.agent_ids}
                          onToggle={(agentId) => {
                            const next = p.agent_ids.includes(agentId)
                              ? p.agent_ids.filter(a => a !== agentId)
                              : [...p.agent_ids, agentId];
                            handleProductAgents(p.product_id, next);
                          }}
                          onClear={p.agent_ids.length ? () => handleProductAgents(p.product_id, []) : undefined}
                        />
                      </div>
                    </details>
                  ))
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Agents ─────────────────────────────────────────────── */}
          <TabsContent value="agents">
            <Card className="border-none shadow-sm">
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Users className="h-4 w-4" /> {t('leadDist.agentWorkload')}
                </CardTitle>
                <CardDescription>{t('leadDist.agentsParticipating', { count: participants.filter(p => p.is_participating).length })}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {participants.length === 0 ? (
                  <EmptyState icon={<Users className="h-4 w-4" />} title={t('leadDist.noAgents')} size="sm" />
                ) : (
                  participants.map(p => {
                    const c = candidates.find(x => x.agent_id === p.agent_id);
                    const load = c?.effective_load ?? 0;
                    const loadPercent = Math.min((load / cap) * 100, 100);
                    const atCapacity = c ? !c.has_capacity : false;
                    return (
                      <div key={p.agent_id}
                        className={cn('space-y-2 rounded-lg border p-3', !p.is_participating && 'opacity-50')}>
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <div className={cn('h-2 w-2 shrink-0 rounded-full',
                              c?.is_online ? 'bg-emerald-500' : 'bg-muted-foreground')} />
                            <span className="truncate text-xs font-medium">{p.full_name}</span>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Badge variant={atCapacity ? 'destructive' : 'secondary'} className="text-[10px]">
                              {load} / {cap}
                            </Badge>
                            <Switch checked={p.is_participating}
                              onCheckedChange={(v) => handleParticipant(p.agent_id, v)} />
                          </div>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                          <div
                            className={cn('h-full rounded-full transition-all',
                              atCapacity ? 'bg-destructive' : loadPercent > 70 ? 'bg-amber-500' : 'bg-primary')}
                            style={{ width: `${loadPercent}%` }}
                          />
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          {t('leadDist.loadBreakdown', { leads: c?.open_leads ?? 0, members: c?.open_members ?? 0 })}
                        </p>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}

function StatTile({ icon, label, value, sub, tone = 'default' }: {
  icon: React.ReactNode; label: string; value: string; sub?: string; tone?: 'default' | 'warn';
}) {
  return (
    <div className={cn('rounded-xl border p-3', tone === 'warn' && 'border-amber-300 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20')}>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">{icon}{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function ToggleRow({ label, desc, checked, onChange }: {
  label: string; desc: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function RunResult({ result, reasonText, t }: {
  result: LeadDistResult;
  reasonText: (r: string | null | undefined) => string | null;
  t: (k: string, o?: any) => string;
}) {
  const ok = result.assigned > 0;
  return (
    <div className={cn('space-y-2 rounded-lg border p-3 text-sm',
      ok
        ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200'
        : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200')}>
      <div className="flex items-center gap-2 font-medium">
        {ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        {result.dry_run
          ? t('leadDist.previewResult', { count: result.assigned })
          : t('leadDist.runResult', { count: result.assigned })}
      </div>
      {!ok && (
        <div className="text-xs">{reasonText(result.skipped_reason) || t('leadDist.reason.no_leads')}</div>
      )}
      {result.agents.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {result.agents.map(a => (
            <Badge key={a.agent_id} variant="secondary" className="text-[10px]">
              {a.full_name} · {a.count}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
