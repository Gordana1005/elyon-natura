import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Inbox, Layers, UserX } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { cn } from '@/lib/utils';
import { apiAssignSegmentMembers, apiGetAssignmentSummary, type AssignmentSummary } from '@/lib/api';
import { ASSIGNER_DEPARTMENTS, type AssignerBoardAgent } from '@/lib/assignerApi';
import { agentHolds, agentLoad } from '@/lib/assigner/board';
import { dealRoundRobin } from '@/lib/assigner/plan';
import { OVERVIEW_COLOR_VARS } from '@/components/insights/overview/palette';
import { LoadError } from '@/components/insights/shared/LoadError';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { AssignerHeader } from '@/components/assigner/AssignerHeader';
import { AssignerKpis } from '@/components/assigner/AssignerKpis';
import { AgentBoard } from '@/components/assigner/AgentBoard';
import { ListsTab, visibleLists } from '@/components/assigner/ListsTab';
import { PendingsTab, pendingsInDepartments } from '@/components/assigner/PendingsTab';
import { CallAgainsPanel } from '@/components/assigner/CallAgainsPanel';
import { BulkUnassignPanel } from '@/components/assigner/BulkUnassignPanel';
import { CrossListBasketBar, type BasketItem } from '@/components/assigner/CrossListBasketBar';
import type { BasketApi } from '@/components/assigner/ListCard';
import type { SegmentMember } from '@/components/assigner/SegmentMemberTable';
import {
  ASSIGNER_KEYS, boardQuery, callAgainsQuery, invalidateAssigner, listsQuery, pendingsQuery, type CallAgainsFilters,
} from '@/components/assigner/assignerQueries';
import { useAssignerLive, useNow } from '@/components/assigner/useAssignerLive';

const TABS = ['lists', 'pendings', 'call_agains', 'unassign'] as const;
type TabKey = (typeof TABS)[number];

/** `?dept=altercpa,web` → the departments in the owner's order; anything else is dropped. */
export function parseDepartments(raw: string | null): string[] {
  const set = new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  return ASSIGNER_DEPARTMENTS.filter((d) => set.has(d));
}

/**
 * /assigner — "Распределувач" (plan Part B, 29.09.2026). A thin shell: the
 * department chips + live indicator, the KPI tiles, the live agent board (ALL
 * profiles, online first — the distribution targets) and four tabs, each with
 * the one DistributeBar. Everything live: the board polls every 5 s while the
 * page is visible and the api's `assigner` broadcast refetches within ~1 s.
 */
export default function AssignerPage() {
  const f = useInsightsFormat();
  const { t } = f;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const departments = useMemo(() => parseDepartments(params.get('dept')), [params]);
  const tabParam = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(tabParam ?? '') ? (tabParam as TabKey) : 'lists';

  const setParam = useCallback((key: string, value: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  }, [setParams]);
  const setDepartments = (d: string[]) => setParam('dept', d.length ? d.join(',') : null);
  const setTab = (v: string) => setParam('tab', v === 'lists' ? null : v);

  const [targets, setTargets] = useState<string[]>([]);
  const [unassignFocus, setUnassignFocus] = useState<{ agentId: string; section?: 'pendings' } | null>(null);
  const [pendingsOrder, setPendingsOrder] = useState<'newest' | 'oldest'>('newest');
  const [caFilters, setCaFilters] = useState<CallAgainsFilters>({ source: 'all', agent: 'unassigned', order: 'oldest' });

  useAssignerLive();
  const now = useNow(1_000);

  const board = useQuery(boardQuery());
  const lists = useQuery(listsQuery(departments));
  const pendings = useQuery(pendingsQuery(pendingsOrder, departments));
  const callAgainsHead = useQuery(callAgainsQuery(caFilters, departments, 1));
  const summary = useQuery<AssignmentSummary>({ queryKey: ASSIGNER_KEYS.summary, queryFn: apiGetAssignmentSummary, refetchInterval: 30_000 });

  const agents: AssignerBoardAgent[] = useMemo(() => board.data?.agents ?? [], [board.data]);
  const onlineIds = useMemo(() => agents.filter((a) => a.online || a.in_call).map((a) => a.user_id), [agents]);

  // ── counts on the tabs = what each tab shows ──
  const listsCount = lists.data ? visibleLists(lists.data.lists).length : null;
  const pendingsCount = pendings.data ? pendingsInDepartments(pendings.data, departments).length : null;
  const callAgainsCount = callAgainsHead.data ? callAgainsHead.data.total : null;
  const unassignCount = summary.data ? summary.data.totals.assigned_total + summary.data.totals.pendings_total : null;

  // ── targets ──
  const toggleTarget = (id: string) => setTargets((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const openUnassignFor = (a: AssignerBoardAgent) => {
    if (!agentHolds(a)) {
      toast({ title: t('assigner.nothingAssignedToAgent', { name: a.full_name }) });
      return;
    }
    const onlyPendings = a.list_assigned === 0 && a.list_open === 0 && a.pendings > 0;
    setUnassignFocus({ agentId: a.user_id, section: onlyPendings ? 'pendings' : undefined });
    setTab('unassign');
  };

  // ── the cross-list basket (hand-picked list clients, kept across tabs) ──
  const [basket, setBasket] = useState<Map<string, BasketItem>>(new Map());
  const [basketBusy, setBasketBusy] = useState(false);
  const basketApi: BasketApi = useMemo(() => ({
    isIn: (listId, phone) => basket.has(`${listId}|${phone}`),
    toggle: (listId, listName, m: SegmentMember) => setBasket((prev) => {
      const k = `${listId}|${m.customer_phone}`;
      const next = new Map(prev);
      if (next.has(k)) next.delete(k); else next.set(k, { key: k, listId, listName, phone: m.customer_phone, name: m.customer_name });
      return next;
    }),
    setMany: (listId, listName, members, add) => setBasket((prev) => {
      const next = new Map(prev);
      for (const m of members) {
        const k = `${listId}|${m.customer_phone}`;
        if (add) next.set(k, { key: k, listId, listName, phone: m.customer_phone, name: m.customer_name });
        else next.delete(k);
      }
      return next;
    }),
  }), [basket]);

  const assignBasket = async (agentIds: string[]) => {
    if (!agentIds.length) return;
    setBasketBusy(true);
    try {
      const items = [...basket.values()];
      // Shuffle so a multi-agent split is not biased by list / tick order.
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      for (const [agentId, its] of dealRoundRobin(items, agentIds)) {
        const byList = new Map<string, string[]>();
        for (const it of its) byList.set(it.listId, [...(byList.get(it.listId) ?? []), it.phone]);
        for (const [listId, phones] of byList) await apiAssignSegmentMembers(listId, phones, agentId);
      }
      const names = agentIds.map((id) => agents.find((a) => a.user_id === id)?.full_name || t('assigner.unknownAgent')).join(', ');
      toast({
        title: t('assigner.customersAssigned', { count: items.length }),
        description: agentIds.length > 1 ? t('assigner.splitAcross', { names }) : t('assigner.toNames', { names }),
      });
      setBasket(new Map());
      invalidateAssigner(qc);
    } catch (err) {
      toast({ title: t('assigner.assignmentFailed'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setBasketBusy(false);
    }
  };

  const unassignBasket = async () => {
    setBasketBusy(true);
    try {
      const items = [...basket.values()];
      const byList = new Map<string, string[]>();
      for (const it of items) byList.set(it.listId, [...(byList.get(it.listId) ?? []), it.phone]);
      for (const [listId, phones] of byList) await apiAssignSegmentMembers(listId, phones, null);
      toast({ title: t('assigner.customersUnassigned', { count: items.length }) });
      setBasket(new Map());
      invalidateAssigner(qc);
    } catch (err) {
      toast({ title: t('assigner.unassignFailed'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setBasketBusy(false);
    }
  };

  const basketAgents = useMemo(() => agents.map((a) => ({
    user_id: a.user_id, full_name: a.full_name, is_online: a.online || a.in_call, members_open: agentLoad(a),
  })), [agents]);

  const tabCount = (n: number | null) => (
    <span className="ml-1.5 rounded-full bg-muted-foreground/10 px-1.5 py-px text-[11px] font-semibold tabular-nums">
      {n == null ? '…' : f.int(n)}
    </span>
  );

  return (
    <AppLayout title={t('nav.assigner')}>
      <div className={cn('mx-auto min-w-0 max-w-[1680px] space-y-4', OVERVIEW_COLOR_VARS, basket.size > 0 && 'pb-40 sm:pb-28')}>
        <AssignerHeader
          departments={departments}
          onDepartmentsChange={setDepartments}
          updatedAt={board.dataUpdatedAt}
          now={now}
          fetching={board.isFetching}
          failed={board.isError}
        />

        <AssignerKpis board={board.data} lists={lists.data} departments={departments} now={now} f={f} />

        {board.isError && !board.data ? (
          <LoadError text={apiErrorText(board.error)} onRetry={() => void board.refetch()} />
        ) : (
          <AgentBoard
            agents={board.data?.agents}
            loading={board.isLoading}
            selected={targets}
            onToggle={toggleTarget}
            onSelectMany={(ids) => setTargets((p) => [...new Set([...p, ...ids])])}
            onClear={() => setTargets([])}
            onUnassign={openUnassignFor}
            f={f}
          />
        )}

        <Tabs value={tab} onValueChange={setTab}>
          {/* Wraps instead of scrolling sideways on a phone. */}
          <TabsList className="grid h-auto grid-cols-2 gap-1 overflow-visible sm:flex sm:flex-wrap sm:justify-start">
            <TabsTrigger value="lists" className="min-h-9 justify-start gap-1.5 whitespace-normal text-left sm:justify-center" aria-label={`${t('assigner.tabs.lists')} (${listsCount ?? '…'})`}>
              <Layers className="h-3.5 w-3.5" aria-hidden />{t('assigner.tabs.lists')}{tabCount(listsCount)}
            </TabsTrigger>
            <TabsTrigger value="pendings" className="min-h-9 justify-start gap-1.5 whitespace-normal text-left sm:justify-center" aria-label={`${t('assigner.tabs.pendings')} (${pendingsCount ?? '…'})`}>
              <Inbox className="h-3.5 w-3.5" aria-hidden />{t('assigner.tabs.pendings')}{tabCount(pendingsCount)}
            </TabsTrigger>
            <TabsTrigger value="call_agains" className="min-h-9 justify-start gap-1.5 whitespace-normal text-left sm:justify-center" aria-label={`${t('assigner.callAgainsTab')} (${callAgainsCount ?? '…'})`}>
              <Clock className="h-3.5 w-3.5" aria-hidden />{t('assigner.callAgainsTab')}{tabCount(callAgainsCount)}
            </TabsTrigger>
            <TabsTrigger value="unassign" className="min-h-9 justify-start gap-1.5 whitespace-normal text-left sm:justify-center" aria-label={`${t('assigner.unassignTab')} (${unassignCount ?? '…'})`}>
              <UserX className="h-3.5 w-3.5" aria-hidden />{t('assigner.unassignTab')}{tabCount(unassignCount)}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="lists" className="mt-4">
            <ListsTab
              data={lists.data}
              loading={lists.isLoading}
              error={lists.error}
              onRetry={() => void lists.refetch()}
              departments={departments}
              agents={agents}
              targets={targets}
              onTargetsChange={setTargets}
              basket={basketApi}
              f={f}
            />
          </TabsContent>

          <TabsContent value="pendings" className="mt-4">
            <PendingsTab
              rows={pendings.data}
              loading={pendings.isLoading}
              error={pendings.error}
              onRetry={() => void pendings.refetch()}
              order={pendingsOrder}
              onOrderChange={setPendingsOrder}
              departments={departments}
              agents={agents}
              targets={targets}
              onTargetsChange={setTargets}
              assignedTotal={agents.reduce((s, a) => s + a.pendings, 0)}
              f={f}
            />
          </TabsContent>

          <TabsContent value="call_agains" className="mt-4">
            <CallAgainsPanel
              filters={caFilters}
              onFiltersChange={setCaFilters}
              departments={departments}
              board={board.data}
              targets={targets}
              onTargetsChange={setTargets}
              f={f}
            />
          </TabsContent>

          <TabsContent value="unassign" className="mt-4">
            <BulkUnassignPanel
              onlineIds={onlineIds}
              focus={unassignFocus}
              onFocusHandled={() => setUnassignFocus(null)}
            />
          </TabsContent>
        </Tabs>
      </div>

      <CrossListBasketBar
        items={[...basket.values()]}
        agents={basketAgents}
        busy={basketBusy}
        onAssign={(ids) => void assignBasket(ids)}
        onUnassign={() => void unassignBasket()}
        onClear={() => setBasket(new Map())}
        onRemove={(k) => setBasket((prev) => { const n = new Map(prev); n.delete(k); return n; })}
        pickedAgents={targets}
        onPickedAgentsChange={setTargets}
      />
    </AppLayout>
  );
}
