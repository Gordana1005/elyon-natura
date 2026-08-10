import { useState, useMemo, useEffect } from 'react';
import { apiErrorText } from '@/i18n/apiErrors';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/layouts/AppLayout';
import {
  apiGetUnassignedPending, apiBulkAssignOrders, apiGetOnlineAgents,
  apiGetSegments, apiAutoAssignSegment, apiBulkUnassignSegment,
  apiGetSegment, apiAssignSegmentMembers,
  apiGetAssignmentSummary, type AssignmentSummary,
  apiGetCallAgains,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import i18n from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Loader2, UserPlus, Users, Inbox, Clock, Layers, Split, ChevronRight, UserX,
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/EmptyState';
import { MobileCard, MobileCardHeader, MobileCardField } from '@/components/ui/mobile-card';
import { SegmentMemberTable, type SegmentMember } from '@/components/assigner/SegmentMemberTable';
import { AgentPickerChips } from '@/components/assigner/AgentPickerChips';
import { CrossListBasketBar, type BasketItem } from '@/components/assigner/CrossListBasketBar';
import { BulkUnassignPanel } from '@/components/assigner/BulkUnassignPanel';
import { CallAgainsPanel } from '@/components/assigner/CallAgainsPanel';

interface UnassignedOrder {
  id: string;
  display_id: string;
  customer_name: string;
  customer_phone: string;
  product_name: string;
  source_type: string;
  created_at: string;
}

interface OnlineAgent {
  user_id: string;
  full_name: string;
  email: string;
  roles: string[];
  active_leads: number;
  /** Open orders (pending/take/call_again) — same number as active_leads. */
  orders_open?: number;
  /** Prediction-list members currently assigned to the agent. */
  members_assigned?: number;
  /** Assigned members not yet done — the agent's real "calls left". */
  members_open?: number;
  /** Open members parked in a call-again cooldown right now. */
  members_parked?: number;
  shift: { start_time: string; end_time: string } | null;
  is_online: boolean;
  /** Live browser-reported softphone state (dialing/in_call, staleness-guarded). */
  in_call?: boolean;
  last_seen_at: string | null;
}

interface SegmentList {
  id: string;
  name: string;
  description: string;
  category: 'value' | 'prestige' | 'cancel' | 'return' | 'other';
  member_count: number;
  assigned_count: number;
  completed_count: number;
  /** Not-done members — the list's real workload. */
  open_count?: number | null;
  /** Not-done AND unassigned — exactly what Distribute (unassigned scope) pulls. */
  distributable_count?: number | null;
  is_active: boolean;
  is_static?: boolean;
  display_order: number;
}

const PAGE_SIZE = 50;

function lastSeenLabel(iso: string | null): string {
  if (!iso) return i18n.t('assigner.neverSeen');
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return i18n.t('dashboard.justNow');
  if (mins < 60) return i18n.t('dashboard.minsAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return i18n.t('dashboard.hoursAgo', { count: hrs });
  return i18n.t('dashboard.daysAgo', { count: Math.floor(hrs / 24) });
}

export default function AssignerPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedOrders, setSelectedOrders] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  // Controlled tabs so agent-card / pendings-chip clicks can jump straight to
  // the Unassign tab and focus that agent's row (the old drawer is gone).
  const [activeTab, setActiveTab] = useState('prediction_lists');
  const [unassignFocus, setUnassignFocus] = useState<{ agentId: string; section?: 'pendings' } | null>(null);

  // Cross-list basket — hand-picked members keyed `${listId}|${phone}`,
  // accumulated across every expanded list.
  const [basket, setBasket] = useState<Map<string, BasketItem>>(new Map());
  const [basketBusy, setBasketBusy] = useState(false);

  const { data: orders = [], isLoading: ordersLoading } = useQuery<UnassignedOrder[]>({
    queryKey: ['unassigned-pending'],
    queryFn: apiGetUnassignedPending,
    refetchInterval: 10000,
  });

  const { data: agents = [], isLoading: agentsLoading } = useQuery<OnlineAgent[]>({
    queryKey: ['online-agents'],
    queryFn: apiGetOnlineAgents,
    refetchInterval: 15000,
  });

  const { data: segments = [], isLoading: segmentsLoading } = useQuery<SegmentList[]>({
    queryKey: ['segments'],
    queryFn: apiGetSegments,
    refetchInterval: 30000,
  });

  // Who holds which list, in one aggregate. Feeds the Unassign tab and the
  // agent-card click routing (an agent with nothing held gets a toast instead
  // of a tab jump).
  const { data: assignmentSummary } = useQuery<AssignmentSummary>({
    queryKey: ['assignment-summary'],
    queryFn: apiGetAssignmentSummary,
    refetchInterval: 30000,
  });

  // Just the count for the tab label — the panel owns its own paged query.
  const { data: callAgainsHead } = useQuery({
    queryKey: ['assigner-call-agains-count'],
    queryFn: () => apiGetCallAgains({ page: 1, limit: 1 }),
    refetchInterval: 60000,
  });
  const callAgainsCount = callAgainsHead?.total;

  const assignMutation = useMutation({
    mutationFn: () => apiBulkAssignOrders(selectedOrders, selectedAgent),
    onSuccess: (data: any) => {
      toast({ title: t('assigner.pendingAssigned', { count: data.assigned }) });
      setSelectedOrders([]);
      setSelectedAgent('');
      queryClient.invalidateQueries({ queryKey: ['unassigned-pending'] });
      queryClient.invalidateQueries({ queryKey: ['online-agents'] });
    },
    onError: (err: any) => toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' }),
  });

  // Source filter for the Pendings tab (affiliate leads, site, webhook, …).
  // Client-side: the endpoint already returns every unassigned pending row.
  const matchesSource = (o: { source_type?: string }, f: string) => {
    if (f === 'all') return true;
    if (f === 'manual') return !o.source_type || o.source_type === 'manual';
    return o.source_type === f;
  };
  const filteredOrders = useMemo(
    () => orders.filter(o => matchesSource(o, sourceFilter)),
    [orders, sourceFilter],
  );
  const allFilteredSelected =
    filteredOrders.length > 0 && filteredOrders.every(o => selectedOrders.includes(o.id));

  const toggleOrder = (id: string) =>
    setSelectedOrders(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleAllOrders = () =>
    setSelectedOrders(allFilteredSelected ? [] : filteredOrders.map(o => o.id));

  const onlineAgents = agents.filter(a => a.is_online);
  const agentsSorted = useMemo(() => [...agents].sort((a, b) => {
    if (a.is_online !== b.is_online) return a.is_online ? -1 : 1;
    const loadA = (a.members_open ?? 0) + (a.orders_open ?? a.active_leads ?? 0);
    const loadB = (b.members_open ?? 0) + (b.orders_open ?? b.active_leads ?? 0);
    return loadA - loadB;
  }), [agents]);
  // Sum of not-done+unassigned members = what can actually be distributed.
  const totalAssignableInLists = segments.reduce((s, x) => s + (x.distributable_count ?? Math.max(0, x.member_count - x.assigned_count)), 0);

  // Agent card / pendings chip → the Unassign tab, focused on that agent.
  // An agent holding nothing has no row there — tell the manager instead.
  const openUnassignFor = (agentId: string, name: string, section?: 'pendings') => {
    const holds = assignmentSummary?.agents.some(
      a => a.agent_id === agentId && (a.assigned_total > 0 || (a.pendings_total ?? 0) > 0),
    );
    if (!holds) {
      toast({ title: t('assigner.nothingAssignedToAgent', { name }) });
      return;
    }
    setUnassignFocus({ agentId, section });
    setActiveTab('unassign');
  };

  // ── Basket helpers ──
  const isInBasket = (listId: string, phone: string) => basket.has(`${listId}|${phone}`);
  const toggleBasketMember = (listId: string, listName: string, m: SegmentMember) => {
    const key = `${listId}|${m.customer_phone}`;
    setBasket(prev => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, { key, listId, listName, phone: m.customer_phone, name: m.customer_name });
      return next;
    });
  };
  const setBasketForMembers = (listId: string, listName: string, members: SegmentMember[], add: boolean) => {
    setBasket(prev => {
      const next = new Map(prev);
      for (const m of members) {
        const key = `${listId}|${m.customer_phone}`;
        if (add) next.set(key, { key, listId, listName, phone: m.customer_phone, name: m.customer_name });
        else next.delete(key);
      }
      return next;
    });
  };

  const invalidateAfterAssign = (touchedListIds: string[]) => {
    queryClient.invalidateQueries({ queryKey: ['segments'] });
    queryClient.invalidateQueries({ queryKey: ['segment'] });
    queryClient.invalidateQueries({ queryKey: ['assignment-summary'] });
    queryClient.invalidateQueries({ queryKey: ['online-agents'] });
    queryClient.invalidateQueries({ queryKey: ['my-queue-summary'] });
  };

  const assignBasket = async (agentIds: string[]) => {
    if (agentIds.length === 0) return;
    setBasketBusy(true);
    try {
      const items = [...basket.values()];
      // Shuffle so a multi-agent split isn't biased by list/insert order.
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      // Round-robin into agents.
      const perAgent: Record<string, BasketItem[]> = {};
      agentIds.forEach(a => { perAgent[a] = []; });
      items.forEach((it, i) => perAgent[agentIds[i % agentIds.length]].push(it));
      // Per (agent, list) assign call.
      for (const [agentId, its] of Object.entries(perAgent)) {
        const byList: Record<string, string[]> = {};
        for (const it of its) (byList[it.listId] ||= []).push(it.phone);
        for (const [listId, phones] of Object.entries(byList)) {
          await apiAssignSegmentMembers(listId, phones, agentId);
        }
      }
      const names = agentIds.map(id => agents.find(a => a.user_id === id)?.full_name || 'Agent').join(', ');
      toast({ title: t('assigner.customersAssigned', { count: items.length }), description: agentIds.length > 1 ? t('assigner.splitAcross', { names }) : t('assigner.toNames', { names }) });
      setBasket(new Map());
      invalidateAfterAssign([...new Set(items.map(i => i.listId))]);
    } catch (err: any) {
      toast({ title: t('assigner.assignmentFailed'), description: err?.message, variant: 'destructive' });
    } finally {
      setBasketBusy(false);
    }
  };

  const unassignBasket = async () => {
    setBasketBusy(true);
    try {
      const items = [...basket.values()];
      const byList: Record<string, string[]> = {};
      for (const it of items) (byList[it.listId] ||= []).push(it.phone);
      for (const [listId, phones] of Object.entries(byList)) {
        await apiAssignSegmentMembers(listId, phones, null);
      }
      toast({ title: t('assigner.customersUnassigned', { count: items.length }) });
      setBasket(new Map());
      invalidateAfterAssign(Object.keys(byList));
    } catch (err: any) {
      toast({ title: t('assigner.unassignFailed'), description: err?.message, variant: 'destructive' });
    } finally {
      setBasketBusy(false);
    }
  };

  return (
    <AppLayout title={t('nav.assigner')}>
      <div className="grid gap-6 lg:grid-cols-[1fr_320px] min-w-0">
        {/* ── Left ── */}
        <div className="space-y-4 min-w-0">
          <div className="grid grid-cols-3 gap-2 sm:gap-4">
            <Card className="border-none shadow-sm">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--warning))]">
                  <Inbox className="h-5 w-5 text-primary-foreground" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('assigner.pendings')}</p>
                  <p className="text-xl font-bold">{orders.length}</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-none shadow-sm">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary">
                  <Layers className="h-5 w-5 text-primary-foreground" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('assigner.assignableInLists')}</p>
                  <p className="text-xl font-bold">{totalAssignableInLists.toLocaleString()}</p>
                </div>
              </CardContent>
            </Card>
            <Card className="border-none shadow-sm">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[hsl(var(--success))]">
                  <Users className="h-5 w-5 text-primary-foreground" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t('assigner.onlineAgents')}</p>
                  <p className="text-xl font-bold">{onlineAgents.length}</p>
                </div>
              </CardContent>
            </Card>
          </div>

          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="mb-3">
              <TabsTrigger value="prediction_lists">Prediction Lists ({segments.length})</TabsTrigger>
              <TabsTrigger value="pendings">Pendings ({orders.length})</TabsTrigger>
              {/* Prediction-list call agains as a redistributable pool. Lead
                  call agains are NOT here — they stay in their own agent's
                  Pendings queue until that agent reaches the customer. */}
              <TabsTrigger value="call_agains" className="gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                {t('assigner.callAgainsTab')} ({(callAgainsCount ?? 0).toLocaleString()})
              </TabsTrigger>
              <TabsTrigger value="unassign" className="gap-1.5">
                <UserX className="h-3.5 w-3.5" />
                {t('assigner.unassignTab')} ({((assignmentSummary?.totals.open_total ?? 0) + (assignmentSummary?.totals.pendings_total ?? 0)).toLocaleString()})
              </TabsTrigger>
            </TabsList>

            {/* ── Tab: Call Agains ── */}
            <TabsContent value="call_agains" className="space-y-4 mt-0">
              <CallAgainsPanel agents={agents} />
            </TabsContent>

            {/* ── Tab: Prediction Lists ── */}
            <TabsContent value="prediction_lists" className="space-y-4 mt-0">
              {segmentsLoading ? (
                <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
              ) : segments.length === 0 ? (
                <EmptyState
                  icon={<Layers className="h-5 w-5" />}
                  title={t('assigner.noListsYet')}
                  description={t('assigner.uploadToCreate')}
                  size="md"
                />
              ) : (
                <div className="space-y-2">
                  {segments
                    .filter(s => s.is_active && s.member_count > 0)
                    .sort((a, b) => a.display_order - b.display_order)
                    .map(list => (
                      <PredictionListRow
                        key={list.id}
                        list={list}
                        agents={agentsSorted}
                        isInBasket={isInBasket}
                        toggleBasketMember={toggleBasketMember}
                        setBasketForMembers={setBasketForMembers}
                        onMutated={() => invalidateAfterAssign([list.id])}
                      />
                    ))}
                </div>
              )}
            </TabsContent>

            {/* ── Tab: Pendings ── */}
            <TabsContent value="pendings" className="space-y-4 mt-0">
              {/* Who already holds pendings — the table below only shows the
                  UNASSIGNED pool, so without this strip an assigned lead
                  simply vanished from the page. Chip → Unassign tab, focused
                  on that agent with the pendings sub-row open. */}
              {(assignmentSummary?.totals.pendings_total ?? 0) > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card/80 backdrop-blur-sm p-3 shadow-sm">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {t('assigner.pendingsUnassignedCount', { count: orders.length })}
                    {' · '}
                    {t('assigner.pendingsAssignedCount', { count: assignmentSummary?.totals.pendings_total ?? 0 })}
                  </span>
                  {(assignmentSummary?.agents ?? [])
                    .filter(a => a.pendings_total > 0)
                    .map(a => (
                      <button
                        key={a.agent_id}
                        type="button"
                        onClick={() => openUnassignFor(a.agent_id, a.full_name, 'pendings')}
                        className="inline-flex items-center gap-1.5 rounded-full border bg-sky-500/10 border-sky-500/30 px-2.5 py-1 text-xs text-sky-700 dark:text-sky-400 hover:bg-sky-500/20"
                      >
                        <span className="font-medium">{a.full_name}</span>
                        <span className="font-bold">{a.pendings_total.toLocaleString()}</span>
                      </button>
                    ))}
                </div>
              )}
              <div className="flex items-center gap-3 rounded-xl border bg-card/80 backdrop-blur-sm p-3 shadow-sm">
                <Select value={selectedAgent} onValueChange={setSelectedAgent}>
                  <SelectTrigger className="w-56 h-9 text-sm rounded-lg"><SelectValue placeholder={t('assigner.selectAgent')} /></SelectTrigger>
                  <SelectContent>
                    {agentsSorted.map(a => (
                      <SelectItem key={a.user_id} value={a.user_id}>
                        <span className="flex items-center gap-2">
                          <span className={cn('h-1.5 w-1.5 rounded-full', a.is_online ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
                          {a.full_name}
                          <Badge variant="outline" className="text-[10px] ml-1">{a.active_leads} active</Badge>
                        </span>
                      </SelectItem>
                    ))}
                    {agentsSorted.length === 0 && <SelectItem value="__none" disabled>{t('assigner.noAgents')}</SelectItem>}
                  </SelectContent>
                </Select>
                <Button
                  size="sm" className="h-9 gap-1.5 rounded-lg"
                  disabled={selectedOrders.length === 0 || !selectedAgent || assignMutation.isPending}
                  onClick={() => assignMutation.mutate()}
                >
                  {assignMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                  {t('assigner.assignCount', { count: selectedOrders.length })}
                </Button>
                <Select value={sourceFilter} onValueChange={(v) => { setSourceFilter(v); setSelectedOrders([]); }}>
                  <SelectTrigger className="w-40 h-9 text-sm rounded-lg ml-auto"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('assigner.allSources')}</SelectItem>
                    <SelectItem value="altercpa">{t('ordersPage.sourceAltercpa')}</SelectItem>
                    <SelectItem value="import">{t('ordersPage.sourceImport')}</SelectItem>
                    <SelectItem value="affiliate">{t('ordersPage.sourceAffiliate')}</SelectItem>
                    <SelectItem value="opencart">{t('ordersPage.sourceSite')}</SelectItem>
                    <SelectItem value="inbound_lead">{t('ordersPage.sourceWebhook')}</SelectItem>
                    <SelectItem value="prediction_lead">{t('ordersPage.sourceLead')}</SelectItem>
                    <SelectItem value="manual">{t('ordersPage.sourceManual')}</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {filteredOrders.length}{sourceFilter !== 'all' ? ` / ${orders.length}` : ''}
                </span>
              </div>

              <div className="hidden md:block rounded-xl border bg-card shadow-sm overflow-hidden">
                {ordersLoading ? (
                  <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/30">
                        <th className="px-4 py-3 w-10">
                          <Checkbox checked={allFilteredSelected} onCheckedChange={toggleAllOrders} aria-label={t('missedCalls.selectAll')} />
                        </th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('search.name')}</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('search.phone')}</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('ordersPage.colProduct')}</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('ordersPage.colSource')}</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">{t('assigner.colReceived')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredOrders.map(order => (
                        <tr key={order.id}
                          className={cn('border-b last:border-0 hover:bg-muted/20 transition-colors cursor-pointer', selectedOrders.includes(order.id) && 'bg-primary/5')}
                          onClick={() => toggleOrder(order.id)}>
                          <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                            <Checkbox checked={selectedOrders.includes(order.id)} onCheckedChange={() => toggleOrder(order.id)} />
                          </td>
                          <td className="px-4 py-3 font-medium">{order.customer_name || '—'}</td>
                          <td className="px-4 py-3 font-mono text-xs">{order.customer_phone}</td>
                          <td className="px-4 py-3">
                            {order.product_name ? <Badge variant="outline" className="text-xs">{order.product_name}</Badge> : <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="secondary" className="text-[10px]">
                              {order.source_type === 'altercpa' ? t('ordersPage.sourceAltercpa')
                                : order.source_type === 'import' ? t('ordersPage.sourceImport')
                                : order.source_type === 'affiliate' ? t('ordersPage.sourceAffiliate')
                                : order.source_type === 'inbound_lead' ? t('ordersPage.sourceWebhook')
                                : order.source_type === 'prediction_lead' ? t('ordersPage.sourceLead')
                                : order.source_type === 'opencart' ? t('ordersPage.sourceSite')
                                : order.source_type === 'opencart_abandoned' ? t('ordersPage.sourceSiteAbandoned')
                                : t('ordersPage.sourceManual')}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground text-xs">{format(new Date(order.created_at), 'MMM d, HH:mm')}</td>
                        </tr>
                      ))}
                      {filteredOrders.length === 0 && (
                        <tr>
                          <td colSpan={6} className="p-0">
                            <EmptyState
                              icon={<Inbox className="h-5 w-5" />}
                              title={t('assigner.noPendingToAssign')}
                              description={t('assigner.allCaughtUp')}
                              size="sm"
                              className="border-0 bg-transparent hover:shadow-none py-8"
                            />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Cards — mobile */}
              <div className="md:hidden space-y-2">
                {ordersLoading ? (
                  <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
                ) : filteredOrders.length === 0 ? (
                  <EmptyState icon={<Inbox className="h-5 w-5" />} title={t('assigner.noPendingToAssign')} description={t('assigner.allCaughtUp')} size="sm" />
                ) : filteredOrders.map(order => (
                  <MobileCard key={order.id} className={cn(selectedOrders.includes(order.id) && 'ring-1 ring-primary')} onClick={() => toggleOrder(order.id)}>
                    <div className="flex items-start gap-2">
                      <Checkbox className="mt-1 shrink-0" checked={selectedOrders.includes(order.id)} onCheckedChange={() => toggleOrder(order.id)} onClick={e => e.stopPropagation()} />
                      <div className="min-w-0 flex-1">
                        <MobileCardHeader
                          title={order.customer_name || '—'}
                          subtitle={order.customer_phone}
                          badge={
                            <Badge variant="secondary" className="text-[10px]">
                              {order.source_type === 'altercpa' ? t('ordersPage.sourceAltercpa')
                                : order.source_type === 'import' ? t('ordersPage.sourceImport')
                                : order.source_type === 'affiliate' ? t('ordersPage.sourceAffiliate')
                                : order.source_type === 'inbound_lead' ? t('ordersPage.sourceWebhook')
                                : order.source_type === 'prediction_lead' ? t('ordersPage.sourceLead')
                                : order.source_type === 'opencart' ? t('ordersPage.sourceSite')
                                : order.source_type === 'opencart_abandoned' ? t('ordersPage.sourceSiteAbandoned')
                                : t('ordersPage.sourceManual')}
                            </Badge>
                          }
                        />
                      </div>
                    </div>
                    <MobileCardField label="Product" value={order.product_name ? <Badge variant="outline" className="text-xs">{order.product_name}</Badge> : '—'} />
                    <MobileCardField label={t('assigner.colReceived')} value={format(new Date(order.created_at), 'MMM d, HH:mm')} />
                  </MobileCard>
                ))}
              </div>
            </TabsContent>

            {/* ── Tab: Unassign (cross-list, per agent or everyone) ── */}
            <TabsContent value="unassign" className="space-y-4 mt-0">
              <BulkUnassignPanel
                onlineIds={onlineAgents.map(a => a.user_id)}
                focus={unassignFocus}
                onFocusHandled={() => setUnassignFocus(null)}
              />
            </TabsContent>
          </Tabs>
        </div>

        {/* ── Right: Agents panel ── */}
        <div className="space-y-4 min-w-0">
          <Card className="border-none shadow-sm sticky top-4">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" /> {t('assigner.agentsTitle')}
                <span className="ml-auto text-xs font-normal text-muted-foreground">{t('assigner.nOnline', { count: onlineAgents.length })}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {agentsLoading ? (
                <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
              ) : agentsSorted.length === 0 ? (
                <EmptyState
                  icon={<Users className="h-4 w-4" />}
                  title={t('assigner.noAgentsFound')}
                  size="sm"
                  className="border-0 bg-transparent py-4"
                />
              ) : agentsSorted.map(agent => {
                const membersOpen = agent.members_open ?? 0;
                const membersAssigned = agent.members_assigned ?? 0;
                const parked = agent.members_parked ?? 0;
                return (
                <button
                  key={agent.user_id}
                  type="button"
                  onClick={() => openUnassignFor(agent.user_id, agent.full_name)}
                  className={cn('w-full text-left rounded-xl p-3 space-y-2 transition-colors hover:bg-muted/50 bg-muted/30', !agent.is_online && 'opacity-60')}
                >
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                        {agent.full_name.charAt(0).toUpperCase()}
                      </div>
                      <div className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card', agent.is_online ? 'bg-[hsl(var(--success))]' : 'bg-muted-foreground/40')} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{agent.full_name}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {agent.is_online
                          ? <span className="text-emerald-600 dark:text-emerald-400 font-medium">{t('assigner.online')}</span>
                          : <span className="truncate">{t('assigner.seen', { time: lastSeenLabel(agent.last_seen_at) })}</span>}
                        {agent.shift && (
                          <>
                            <span>•</span>
                            <span className="flex items-center gap-0.5 shrink-0"><Clock className="h-3 w-3" />{agent.shift.start_time?.slice(0, 5)} - {agent.shift.end_time?.slice(0, 5)}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-xs">
                    <div className="rounded-lg border bg-background/60 px-2 py-1.5 leading-tight">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('assigner.statusTile')}</div>
                      <div className="font-semibold flex items-center gap-1.5">
                        {agent.in_call ? (
                          <>
                            <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse shrink-0" />
                            <span className="text-rose-600 dark:text-rose-400">{t('assigner.statusInCall')}</span>
                          </>
                        ) : agent.is_online ? (
                          <>
                            <span className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                            <span className="text-emerald-600 dark:text-emerald-400">{t('assigner.statusAvailable')}</span>
                          </>
                        ) : (
                          <>
                            <span className="h-2 w-2 rounded-full bg-muted-foreground/40 shrink-0" />
                            <span className="text-muted-foreground">{t('assigner.statusOffline')}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div
                      className="rounded-lg border bg-background/60 px-2 py-1.5 leading-tight"
                      title={parked > 0 ? t('assigner.onHold', { count: parked.toLocaleString() }) : undefined}
                    >
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{t('assigner.tileClients')}</div>
                      <div className="font-semibold tabular-nums">
                        {membersOpen.toLocaleString()}
                        <span className="ml-1 font-normal text-muted-foreground">{t('assigner.ofAssigned', { total: membersAssigned.toLocaleString() })}</span>
                      </div>
                    </div>
                  </div>
                </button>
                );
              })}
            </CardContent>
          </Card>
        </div>
      </div>


      <CrossListBasketBar
        items={[...basket.values()]}
        agents={agentsSorted}
        busy={basketBusy}
        onAssign={assignBasket}
        onUnassign={unassignBasket}
        onClear={() => setBasket(new Map())}
        onRemove={(key) => setBasket(prev => { const n = new Map(prev); n.delete(key); return n; })}
      />
    </AppLayout>
  );
}

interface RowProps {
  list: SegmentList;
  agents: OnlineAgent[];
  isInBasket: (listId: string, phone: string) => boolean;
  toggleBasketMember: (listId: string, listName: string, m: SegmentMember) => void;
  setBasketForMembers: (listId: string, listName: string, members: SegmentMember[], add: boolean) => void;
  onMutated: () => void;
}

/** Expandable list row: a Distribute bar (whole/half/custom × N agents +
 *  unassign-all) plus the inline member table whose checkboxes feed the
 *  cross-list basket. */
function PredictionListRow({ list, agents, isInBasket, toggleBasketMember, setBasketForMembers, onMutated }: RowProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [scope, setScope] = useState<'unassigned' | 'all'>('unassigned');
  const [amount, setAmount] = useState<'whole' | 'half' | 'custom'>('whole');
  const [customN, setCustomN] = useState('20');
  const [busy, setBusy] = useState(false);

  // Inline table state
  const [page, setPage] = useState(1);
  const [assignedFilter, setAssignedFilter] = useState('all');
  const [completedFilter, setCompletedFilter] = useState('no');

  // Truthful numbers: "open" = not done (the list's real workload — the
  // operator's rule: always show how many NOT-done clients a list holds);
  // "assignable" = open AND unassigned = exactly the pool the Distribute
  // (unassigned scope) endpoint pulls. Fallbacks cover cached old payloads.
  const openCount = list.open_count ?? Math.max(0, list.member_count - (list.completed_count ?? 0));
  const assignable = list.distributable_count ?? Math.max(0, list.member_count - list.assigned_count);
  const doneCount = Math.max(0, list.member_count - openCount);
  // Static lists (Due to Reorder, Cancelled Pendings, and any operator-made
  // informational list) are engine-protected and never distributed — hide the
  // distribute bar and make the table read-only.
  // EXCEPTION (operator 2026-07-09): "FULL MONAD LIST" + "Trash List" ARE
  // assignable — managers distribute them to agents for re-marketing / follow-up.
  // They stay is_static=true, so the prediction engine still never touches their
  // membership; only the Assigner treats them as distributable.
  const ASSIGNABLE_STATIC = ['FULL MONAD LIST', 'Trash List'];
  const informational = list.is_static === true && !ASSIGNABLE_STATIC.includes(list.name);

  const { data, isLoading } = useQuery<{ members: SegmentMember[]; total: number }>({
    queryKey: ['segment', list.id, page, assignedFilter, completedFilter],
    queryFn: () => apiGetSegment(list.id, {
      page, limit: PAGE_SIZE,
      assigned: assignedFilter !== 'all' ? assignedFilter : undefined,
      completed: completedFilter !== 'all' ? completedFilter : undefined,
    }),
    enabled: expanded,
  });

  const members = data?.members ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allOnPageInBasket = members.length > 0 && members.every(m => isInBasket(list.id, m.customer_phone));

  const togglePicked = (uid: string) =>
    setPicked(prev => prev.includes(uid) ? prev.filter(x => x !== uid) : [...prev, uid]);

  const distributePreview = useMemo(() => {
    if (picked.length === 0) return null;
    // Auto-assign always skips done members, so the eligible pool is the OPEN
    // one — unassigned-only or all-open on reassign. Keeps preview == toast.
    const eligible = scope === 'unassigned' ? assignable : openCount;
    const cap = amount === 'whole' ? eligible
      : amount === 'half' ? Math.ceil(eligible / 2)
      : Math.min(parseInt(customN) || 0, eligible);
    if (cap <= 0) return t('assigner.nothingToDistribute');
    if (picked.length === 1) return `${cap.toLocaleString()} → 1 agent`;
    return `~${Math.ceil(cap / picked.length)} each to ${picked.length} agents`;
  }, [picked, scope, amount, customN, assignable, openCount, t]);

  const distribute = async () => {
    if (picked.length === 0) return;
    setBusy(true);
    try {
      const opts = amount === 'whole' ? undefined
        : amount === 'half' ? { fraction: 0.5 }
        : { limit: Math.max(0, parseInt(customN) || 0) };
      const res: any = await apiAutoAssignSegment(list.id, picked, scope, opts);
      const breakdown = res.per_agent
        ? Object.entries(res.per_agent).map(([aid, n]) => `${agents.find(a => a.user_id === aid)?.full_name || 'Agent'}: ${n}`).join(' · ')
        : '';
      toast({ title: t('assigner.nDistributed', { count: res.distributed ?? 0 }), description: breakdown || undefined });
      setPicked([]);
      onMutated();
    } catch (err: any) {
      toast({ title: t('assigner.distributionFailed'), description: err?.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const unassignAll = async () => {
    setBusy(true);
    try {
      const res: any = await apiBulkUnassignSegment(list.id, 'all');
      toast({ title: t('assigner.nUnassigned', { count: res.unassigned ?? 0 }) });
      onMutated();
    } catch (err: any) {
      toast({ title: t('assigner.unassignFailed'), description: err?.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border bg-card shadow-sm overflow-hidden">
      <button type="button" onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-4 px-4 py-3 hover:bg-muted/30 transition-colors text-left">
        <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate">{list.name}</div>
          <div className="text-xs text-muted-foreground truncate">{list.description}</div>
        </div>
        <div className="flex items-center gap-2 text-xs shrink-0">
          {informational ? (
            <>
              <Badge variant="outline" className="text-[10px]">{t('assigner.nTotal', { count: list.member_count.toLocaleString() })}</Badge>
              <Badge variant="secondary" className="text-[10px]">{t('assigner.informational')}</Badge>
            </>
          ) : (
            <>
              {assignable > 0
                ? <Badge className="text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/15">{t('assigner.nToCall', { count: assignable.toLocaleString() })}</Badge>
                : openCount > 0
                ? <Badge className="text-[10px] bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/15">{t('assigner.allAssigned')}</Badge>
                : null}
              {doneCount > 0 && <Badge variant="secondary" className="text-[10px]">{t('assigner.nDone', { count: doneCount.toLocaleString() })}</Badge>}
              <Badge variant="outline" className="text-[10px]">{t('assigner.nTotal', { count: list.member_count.toLocaleString() })}</Badge>
            </>
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t bg-muted/20 p-4 space-y-4">
          {/* ── Distribute bar (hidden for informational lists like "Trash List") ── */}
          {informational ? (
            <div className="rounded-lg border border-dashed bg-card/60 p-3 text-xs text-muted-foreground">
              {t('assigner.notDistributable')}
            </div>
          ) : (
          <div className="rounded-lg border bg-card p-3 space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('assigner.distribute')}</div>
            <AgentPickerChips agents={agents} selected={picked} onToggle={togglePicked} />
            <div className="flex flex-wrap items-center gap-4">
              {/* Scope */}
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">{t('assigner.scope')}</span>
                {(['unassigned', 'all'] as const).map(s => (
                  <button key={s} onClick={() => setScope(s)}
                    className={cn('rounded-full px-2.5 py-1 border text-xs', scope === s ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border hover:bg-muted')}>
                    {s === 'unassigned' ? t('assigner.unassignedOnly') : t('assigner.allReassign')}
                  </button>
                ))}
              </div>
              {/* Amount */}
              <div className="flex items-center gap-1.5 text-xs">
                <span className="text-muted-foreground">{t('assigner.amount')}</span>
                {(['whole', 'half', 'custom'] as const).map(a => (
                  <button key={a} onClick={() => setAmount(a)}
                    className={cn('rounded-full px-2.5 py-1 border text-xs capitalize', amount === a ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border hover:bg-muted')}>
                    {a}
                  </button>
                ))}
                {amount === 'custom' && (
                  <Input type="number" min={1} value={customN} onChange={e => setCustomN(e.target.value)} className="h-7 w-20 text-xs" />
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" className="h-9 gap-1.5" disabled={picked.length === 0 || busy} onClick={distribute}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : picked.length > 1 ? <Split className="h-3.5 w-3.5" /> : <UserPlus className="h-3.5 w-3.5" />}
                {t('assigner.distribute')}
              </Button>
              {distributePreview && <span className="text-xs text-muted-foreground">{distributePreview}</span>}
              <Button size="sm" variant="outline" className="h-9 gap-1.5 ml-auto text-rose-700 hover:bg-rose-50"
                disabled={busy || list.assigned_count === 0} onClick={unassignAll}>
                <UserX className="h-3.5 w-3.5" /> {t('assigner.unassignAll', { count: list.assigned_count.toLocaleString() })}
              </Button>
            </div>
          </div>
          )}

          {/* ── Manual table → feeds basket ── */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={assignedFilter} onValueChange={(v) => { setAssignedFilter(v); setPage(1); }}>
                <SelectTrigger className="w-[170px] h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('segmentDetail.allMembers')}</SelectItem>
                  <SelectItem value="none">{t('segmentDetail.unassignedOnly')}</SelectItem>
                  {agents.map(a => <SelectItem key={a.user_id} value={a.user_id}>{t('segmentDetail.assignedTo', { name: a.full_name })}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={completedFilter} onValueChange={(v) => { setCompletedFilter(v); setPage(1); }}>
                <SelectTrigger className="w-[150px] h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('segmentDetail.anyState')}</SelectItem>
                  <SelectItem value="no">{t('segmentDetail.notYetCalled')}</SelectItem>
                  <SelectItem value="yes">{t('segmentDetail.alreadyCalled')}</SelectItem>
                </SelectContent>
              </Select>
              <span className="ml-auto text-xs text-muted-foreground">{total.toLocaleString()} matching{!informational && ' · tick rows to add to basket'}</span>
            </div>
            {/* The default view hides done members — when that empties the page,
                say so instead of a dead-end "no members match". */}
            {!isLoading && total === 0 && doneCount > 0 && completedFilter === 'no' && (assignedFilter === 'all' || assignedFilter === 'none') && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                <span>{t('assigner.hiddenDone', { count: doneCount.toLocaleString() })}</span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setCompletedFilter('all')}>
                  {t('assigner.showAll')}
                </Button>
              </div>
            )}
            <SegmentMemberTable
              members={members}
              isSelected={(phone) => isInBasket(list.id, phone)}
              onToggle={(m) => toggleBasketMember(list.id, list.name, m)}
              onToggleAll={() => setBasketForMembers(list.id, list.name, members, !allOnPageInBasket)}
              allOnPageSelected={allOnPageInBasket}
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              loading={isLoading}
              compact
              selectable={!informational}
            />
          </div>
        </div>
      )}
    </div>
  );
}
