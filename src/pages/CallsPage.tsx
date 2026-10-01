import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, PhoneOutgoing, ArrowRight, Layers } from 'lucide-react';
import { useIsMobile, useMaxWidth } from '@/hooks/use-mobile';
import { AppLayout } from '@/layouts/AppLayout';
import { PromoOfTheDayBanner, PROMO_QUERY_KEY } from '@/components/calls/PromoOfTheDayBanner';
import { ClientProfileCard } from '@/components/calls/ClientProfileCard';
import { useMyQueue, useQueueMutations, PENDINGS_QUEUE_ID, type QueueMember, type QueueListSummary } from '@/components/calls/useMyQueue';
import { getCallSession, setCallSession, type CallSessionSnapshot } from '@/components/calls/callSession';
import { OutcomeBar } from '@/components/calls/work/OutcomeBar';
import { DialPanel } from '@/components/calls/work/DialPanel';
import { UndoBar } from '@/components/calls/work/UndoBar';
import { CallsProgress } from '@/components/calls/work/CallsProgress';
import { CallAgainQueue } from '@/components/calls/work/CallAgainQueue';
import { QueueTabs, type CallsView } from '@/components/calls/work/QueueTabs';
import { useCallsLive, useDeferredOutcome, useDocumentHidden } from '@/components/calls/work/useCallsWork';
import { OrderModal, OrderModalData } from '@/components/OrderModal';
import { CreateOrderModal } from '@/components/CreateOrderModal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiGetOrder, apiGetOrders, apiReleaseActiveView, apiLookupPersonalHold, apiReleasePersonalHold, apiGetMyPendingsSummary, apiGetOpenLead, apiGetMyCallObligation, apiRegisterCallObligation, apiClaimCallback, type CancellationReason, type TrashReason, type OpenLead } from '@/lib/api';
import {
  apiGetCallsProgress, apiGetMyCallbacks, apiRecordCallOutcome, CallOutcomeError, CALLS_QUERY_KEYS,
  type MyCallback, type RecordOutcomeBody, type RecordOutcomeResult,
} from '@/lib/callsWorkApi';
import { livePollInterval, type CallOutcomeKey } from '@/lib/callsWork/outcomes';
import { skopjeClock } from '@/lib/callsWork/callbacks';
import { formatLocalDisplay, toLocalDial } from '@/lib/callsWork/dial';
import { PBX_CONFIG } from '@/lib/voip/pbxConfig';
import { cancelReasonLabel } from '@/lib/cancellationReasons';
import { trashReasonLabel } from '@/lib/trashReasons';
import { useTranslation } from 'react-i18next';
import { useVoip, type LinkedContext } from '@/contexts/VoipContext';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { useActiveCallView } from '@/hooks/useActiveCallView';
import { hoverLift } from '@/lib/design-utils';
import { EmptyState } from '@/components/EmptyState';
import { sortPendingQueue, pickNextPending as pickNextFromSorted } from '@/lib/pendingQueue';
import { predictionListLabel } from '@/lib/predictionListLabel';

// Link the call only to an order a call outcome can legitimately act on
// (pending → confirm/cancel, etc.). Finished orders — paid, shipped, delivered,
// returned, cancelled, trashed — are NEVER linked: a call to such a customer is
// almost always a prediction-list RE-SALE, where "Confirmed" must create a NEW
// order, not try to mutate a closed one (which throws "cannot move paid →
// confirmed"). When there is no actionable order this returns null and the call
// logs as standalone; the Confirmed → Create Order flow then opens a fresh order.
function pickLinkedContext(orders: any[]): LinkedContext | null {
  if (!orders || orders.length === 0) return null;
  const priority = ['pending', 'take', 'call_again', 'confirmed'];
  const actionable = orders.filter((o) => priority.includes(o.status));
  if (actionable.length === 0) return null;
  const sorted = [...actionable].sort((a, b) => {
    const ai = priority.indexOf(a.status);
    const bi = priority.indexOf(b.status);
    if (ai !== bi) return ai - bi;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
  const top = sorted[0];
  return { type: 'order', id: top.id, display_id: top.display_id };
}

function orderToModalData(order: any): OrderModalData {
  const items = (order.order_items || []).map((i: any) => ({
    id: i.id,
    product_id: i.product_id,
    product_name: i.product_name,
    quantity: i.quantity,
    price_per_unit: Number(i.price_per_unit),
    total_price: Number(i.total_price),
  }));
  return {
    id: order.id,
    name: order.customer_name || '',
    telephone: order.customer_phone || '',
    address: order.customer_address || '',
    city: order.customer_city || '',
    postalCode: order.postal_code || '',
    product: order.product_name || '',
    status: order.status,
    notes: null,
    quantity: order.quantity || 1,
    price: Number(order.price || 0),
    displayId: order.display_id,
    items,
    assigned_agent_id: order.assigned_agent_id,
    ship_after_date: order.ship_after_date,
  };
}

export default function CallsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdminOrManager = !!(user?.isAdmin || user?.isManager);
  const [searchParams, setSearchParams] = useSearchParams();
  const { state, startCall, callerIds, pendingConfirm, clearPendingConfirm, lastFinished, clearLastFinished, endCallForClaim } = useVoip();
  const { markAfterCall } = useQueueMutations();

  // Restore the customer the agent was on before they navigated away (the page
  // unmounts on navigation; see callSession.ts). Read exactly once, and skip the
  // restore when arriving with an explicit ?phone= (Call Again / Personal List
  // "Call now") — that navigation intent must win over the saved session.
  const restoredRef = useRef<CallSessionSnapshot | null | undefined>(undefined);
  if (restoredRef.current === undefined) {
    const hasPhoneParam = new URLSearchParams(window.location.search).has('phone');
    restoredRef.current = hasPhoneParam ? null : getCallSession();
  }
  const restored = restoredRef.current;

  const [selectedPhone, setSelectedPhone] = useState(() => restored?.selectedPhone ?? '');
  const [manualPhoneDraft, setManualPhoneDraft] = useState('');
  const [dialOpen, setDialOpen] = useState(false);
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const [orderModalData, setOrderModalData] = useState<OrderModalData | null>(null);
  const [createOrderProps, setCreateOrderProps] = useState<{
    open: boolean;
    phone?: string;
    name?: string;
    isManual?: boolean;   // true = free-form manual order, do not touch queue
    existingOrderId?: string; // set = complete this pending order in place (lead confirm)
  }>({ open: false });
  const [currentSource, setCurrentSource] = useState<'pending' | 'prediction' | 'manual' | null>(() => restored?.currentSource ?? null);
  // The client the agent opened BY HAND — search bar "Open in Calls", Personal
  // List, Call Again. ONLY these owe a mandatory answer (operator rule
  // 2026-08-13). The queues (prediction lists and Pendings) are exempt in BOTH
  // directions: they never create a debt, and a standing debt never stops the
  // queue serving the next customer. `currentSource === 'manual'` cannot be used
  // for this — the manual dial input sets it too.
  const [handOpenedPhone, setHandOpenedPhone] = useState<string | null>(null);
  const [currentPendingOrderId, setCurrentPendingOrderId] = useState<string | null>(() => restored?.currentPendingOrderId ?? null);
  const isMobile = useIsMobile();
  // Below 2xl the full number input + list select collided with the topbar's search /
  // language / break buttons (drawn on top of each other at 1024 and 1280) — icon buttons there.
  const compactHeader = useMaxWidth(1535);

  // Queue state — invisible to the agent. We pick the first list with members
  // automatically. After a call ends we mark the customer in the data layer
  // but DON'T auto-swap the screen — the agent stays on the customer until
  // they explicitly click "Next customer" so they can still create an order
  // post-call if they didn't during it.
  // 
  // EXCLUSIVE MODEL (Option 1 + 21-day floor, zero dups per phone across lists):
  // The "Queue:" dropdown (visible to admins/agents with >1 list) lets switching
  // between an agent's assigned lists. A *phone* is in at most one list; an *agent*
  // can legitimately have work from several lists (different customers). All
  // list-scoped logic + composite keys elsewhere (e.g. Assigner basket) remain
  // correct and defensive.
  const [activeListId, setActiveListId] = useState<string | null>(() => restored?.activeListId ?? null);
  const [queueMembers, setQueueMembers] = useState<QueueMember[]>([]);
  const queueCurrentPhone = useRef<string | null>(restored?.queueCurrentPhone ?? null);
  // A restored session means a customer is already on screen — suppress the
  // auto-pick effects below so they don't override it with a queue customer.
  const autoPickedRef = useRef(!!restored);
  // True when the user (admin/manager) explicitly picked the active list from
  // the visible Queue dropdown. We must NOT auto-fallback to another list in
  // that case — the user's pick wins, even if the list is empty. Auto-picked
  // empty lists still fall through to the next non-empty one (original
  // behaviour for the silent agent flow).
  const manualPickRef = useRef(restored?.manualPick ?? false);
  // Set when a call's outcome was just recorded; the screen waits for the
  // agent to confirm before swapping to the next member.
  const [pendingAdvance, setPendingAdvance] = useState<{ phone: string; outcome: string } | null>(() => restored?.pendingAdvance ?? null);

  // ── Plan Фаза 11: the one-tap outcomes, the callbacks view, live queues ──
  // ?queue=call-again shows "Повторни повици · Мои" (the old /call-again page).
  const view: CallsView = searchParams.get('queue') === 'call-again' ? 'call-again' : 'queue';
  const [busyOutcome, setBusyOutcome] = useState<CallOutcomeKey | null>(null);
  // When the current attempt started: the customer appearing on screen, then the tel:
  // tap / the copied number. Sent with the outcome so the call row carries real times.
  const attemptAtRef = useRef<{ phone: string; at: number } | null>(null);
  // The customer was opened from the callbacks view → go back there after the outcome.
  const fromCallbacksRef = useRef(false);
  const deferred = useDeferredOutcome();
  // Polls pause while the tab is hidden and back off to 60 s while a queue is empty;
  // the `assigner` broadcast (useCallsLive below) refreshes them the moment work moves.
  const hidden = useDocumentHidden();

  const { data: pendingData } = useQuery({
    queryKey: ['calls-page-pendings', user?.id],
    // The whole lead lifecycle, inbound sources only.
    //
    // `pending` alone dropped a lead out of the queue the moment it was called
    // once (it becomes call_again), so the agent could not find their own
    // call-backs and Confirm forked a second order instead of completing the
    // first. `lead_only` keeps prediction-list work out — that belongs to the
    // prediction queues and the Call Again page.
    //
    // NO `ready_only`: the paced retry is for cold prediction outreach. On a
    // lead the customer is waiting for US, so hiding it until 09:00 tomorrow
    // made agents think their call agains had vanished (one had 4 and could see
    // 1). Parked leads stay visible — just sorted last, see pendingOrders below.
    queryFn: () => apiGetOrders({ status: 'pending,take,call_again', agent_id: user?.id, lead_only: true, limit: 100 }),
    enabled: !!user?.id,
    refetchInterval: (q) => livePollInterval(15_000, !(q.state.data as { orders?: unknown[] } | undefined)?.orders?.length, hidden),
  });

  // Counts behind the virtual "Pendings" queue entry (left / talked today).
  const { data: pendingsSummary } = useQuery({
    queryKey: ['my-pendings-summary', user?.id],
    queryFn: apiGetMyPendingsSummary,
    enabled: !!user?.id,
    refetchInterval: (q) => livePollInterval(30_000, !q.state.data?.open, hidden),
  });

  // "Повторни повици · Мои" — also feeds the tab's due badge.
  const callbacksQuery = useQuery({
    queryKey: CALLS_QUERY_KEYS.callbacks(user?.id),
    queryFn: apiGetMyCallbacks,
    enabled: !!user?.id,
    staleTime: 15_000,
    refetchInterval: (q) => livePollInterval(view === 'call-again' ? 30_000 : 60_000, !q.state.data?.total, hidden),
  });

  // The progress row: my outcomes today + my sales today as the TV board counts them.
  const { data: progress } = useQuery({
    queryKey: CALLS_QUERY_KEYS.progress(user?.id),
    queryFn: apiGetCallsProgress,
    enabled: !!user?.id,
    staleTime: 20_000,
    refetchInterval: hidden ? false : 60_000,
  });

  const refreshQueues = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['calls-page-pendings', user?.id] });
    qc.invalidateQueries({ queryKey: ['my-pendings-summary', user?.id] });
    qc.invalidateQueries({ queryKey: ['my-queue-summary'] });
    qc.invalidateQueries({ queryKey: CALLS_QUERY_KEYS.callbacks(user?.id) });
    qc.invalidateQueries({ queryKey: CALLS_QUERY_KEYS.progress(user?.id) });
  }, [qc, user?.id]);
  // A manager hands work over, a claim, a distribution → the api broadcasts; refresh now.
  useCallsLive(user?.id, refreshQueues);

  // Queue order (see src/lib/pendingQueue.ts):
  //   1. fresh leads (pending / take) — always first
  //   2. call agains last (oldest waiting first)
  // Parked rows (next_call_after in the future) stay last; leads keep
  // next_call_after NULL so they never hide, they just sort behind fresh.
  const pendingOrders = useMemo(
    () => sortPendingQueue((pendingData as any)?.orders || []),
    [pendingData],
  );

  const pickNextPending = useCallback((excludeId?: string | null) => {
    return pickNextFromSorted(pendingOrders, excludeId);
  }, [pendingOrders]);

  // True once the user DELIBERATELY picked a prediction list from the dropdown.
  // Their choice then wins: pendings stop pre-empting, so a lead landing
  // mid-list no longer yanks them off the customer they chose to work. The
  // Pendings row lights up instead (badge below) and they switch back at will.
  const isPredictionPinned =
    manualPickRef.current && !!activeListId && activeListId !== PENDINGS_QUEUE_ID;
  // Leads waiting while the agent is deliberately working a prediction list.
  const pendingsWaiting = isPredictionPinned ? (pendingsSummary?.ready ?? 0) : 0;

  const normalizePhoneKey = useCallback((value: string) => value.replace(/\D/g, '').slice(-8), []);
  const selectedPhoneKey = useMemo(() => normalizePhoneKey(selectedPhone), [normalizePhoneKey, selectedPhone]);
  const activePendingOrder = useMemo(() => {
    if (!selectedPhoneKey) return null;
    return pendingOrders.find((o: any) => normalizePhoneKey(o.customer_phone || '') === selectedPhoneKey) || null;
  }, [pendingOrders, selectedPhoneKey, normalizePhoneKey]);

  // For prediction-sourced customers (current queue list), surface avg_package_price
  // (added in redesign) into the high-visibility ClientProfileCard using currency helpers.
  const currentAvgPackagePrice = useMemo(() => {
    if (currentSource !== 'prediction' || !selectedPhone) return null;
    const m = queueMembers.find(mm => mm.customer_phone === selectedPhone);
    return m?.avg_package_price ?? null;
  }, [queueMembers, selectedPhone, currentSource]);

  const handleMembersLoaded = useCallback((listId: string, members: QueueMember[]) => {
    if (listId !== activeListId) return;
    setQueueMembers(members);
    if (queueCurrentPhone.current) return; // already showing one
    if (members.length === 0) {
      if (manualPickRef.current) {
        // Admin explicitly picked this empty list — respect it, show empty
        // state. Don't fall back to another list.
        setSelectedPhone('');
        setCurrentSource(null);
        return;
      }
      // Auto-picked list is empty — try the next non-empty one.
      autoPickedRef.current = false;
      setActiveListId(null);
      return;
    }
    // Pendings pre-empt a prediction list — unless the agent explicitly chose
    // this list, in which case their pick wins (the Pendings row badges instead).
    if (!isPredictionPinned && pickNextPending(currentPendingOrderId)) return;
    const first = members[0];
    queueCurrentPhone.current = first.customer_phone;
    setSelectedPhone(first.customer_phone);
    setCurrentSource('prediction');
    setCurrentPendingOrderId(null);
  }, [activeListId, pickNextPending, currentPendingOrderId, isPredictionPinned]);

  const { queues } = useMyQueue(activeListId, handleMembersLoaded);

  // Pendings (assigned leads) get a seat in the SAME dropdown as the prediction
  // lists, always first. They aren't segment members and have no list row, so
  // the entry is synthetic — see PENDINGS_QUEUE_ID. Shown whenever the agent has
  // any lead work today, so the row doesn't vanish the moment they finish.
  const pendingsQueueEntry: QueueListSummary | null = useMemo(() => {
    const s = pendingsSummary;
    if (!s || (s.open === 0 && s.talked_today === 0)) return null;
    return {
      list_id: PENDINGS_QUEUE_ID,
      list_name: t('callsPage.pendingsQueue'),
      list_category: 'pending',
      display_order: -1,
      remaining: s.ready,
      total: s.open,
      talked: s.talked_today,
      is_pendings: true,
    };
  }, [pendingsSummary, t]);

  const allQueues = useMemo(
    () => (pendingsQueueEntry ? [pendingsQueueEntry, ...queues] : queues),
    [pendingsQueueEntry, queues],
  );

  // Opening a callback (search, Call Again, Personal List) takes it immediately
  // even if another agent still holds it — so it never sits on an offline account.
  // No-op when the phone is not a call_again lead / prediction member.
  const takeCallback = useCallback((phone: string) => {
    if (!phone) return;
    void apiClaimCallback(phone)
      .then((res) => {
        if (!res?.claimed) return;
        qc.invalidateQueries({ queryKey: ['calls-page-pendings', user?.id] });
        qc.invalidateQueries({ queryKey: ['my-pendings-summary', user?.id] });
        qc.invalidateQueries({ queryKey: ['my-queue-summary'] });
        qc.invalidateQueries({ queryKey: ['call-again-queue'] });
        toast({ title: t('callsPage.callbackClaimed'), description: t('callsPage.callbackClaimedDesc') });
      })
      .catch(() => { /* never block opening a customer */ });
  }, [qc, user?.id, toast, t]);

  // If we navigated here with ?phone= (e.g. from Personal List or Call Again),
  // honour it as the starting customer instead of auto-picking a queue.
  useEffect(() => {
    const fromUrl = searchParams.get('phone');
    if (!fromUrl) return;
    setSelectedPhone(fromUrl);
    queueCurrentPhone.current = null; // detach from any queue
    autoPickedRef.current = true; // suppress auto-pick
    // Opened BY HAND (search bar "Open in Calls", Personal List, Call Again) —
    // this is the only entry point that owes a mandatory answer. The dial input
    // and the queues deliberately do not set this.
    setHandOpenedPhone(fromUrl);
    setCurrentSource('manual');
    setCurrentPendingOrderId(null);
    takeCallback(fromUrl);
    // Strip the param so a manual refresh doesn't reopen the same customer.
    const next = new URLSearchParams(searchParams);
    next.delete('phone');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, takeCallback]);

  // Auto-pick the first non-empty queue on mount / when queues load. Pendings
  // win outright: leads are always the priority, and selecting the queue here
  // (rather than only serving the customer) also closes the old starvation race
  // where a slow pendings fetch let a prediction customer take the screen and
  // the pendings effect below could never re-fire.
  useEffect(() => {
    if (autoPickedRef.current) return;
    if (pendingsSummary && pendingsSummary.ready > 0) {
      autoPickedRef.current = true;
      setActiveListId(PENDINGS_QUEUE_ID);
      return;
    }
    if (!queues || queues.length === 0) return;
    const first = queues.find(q => q.remaining > 0);
    if (first) {
      autoPickedRef.current = true;
      setActiveListId(first.list_id);
    }
  }, [queues, pendingsSummary]);

  // Pending orders take the screen when nothing is on it — unless the agent has
  // deliberately pinned a prediction list.
  useEffect(() => {
    if (selectedPhone) return;
    if (isPredictionPinned) return;
    const nextPending = pickNextPending(currentPendingOrderId);
    if (!nextPending) return;
    setSelectedPhone(nextPending.customer_phone);
    setCurrentPendingOrderId(nextPending.id);
    setCurrentSource('pending');
  }, [selectedPhone, pickNextPending, currentPendingOrderId, isPredictionPinned]);

  // Mirror the current selection into the in-memory session so it survives
  // navigating away from /calls and back (callSession.ts). Cleared when there is
  // no customer on screen so a remount falls back to normal auto-pick.
  useEffect(() => {
    if (!selectedPhone) { setCallSession(null); return; }
    setCallSession({
      selectedPhone,
      currentSource,
      currentPendingOrderId,
      queueCurrentPhone: queueCurrentPhone.current,
      activeListId,
      manualPick: manualPickRef.current,
      pendingAdvance,
    });
  }, [selectedPhone, currentSource, currentPendingOrderId, activeListId, pendingAdvance]);

  // Manual queue pick from the visible switcher. Clear the on-screen customer
  // immediately so the user gets visual feedback the switch took effect;
  // handleMembersLoaded sets the new first customer once the list's members
  // arrive, and for Pendings the pendings effect above picks the first lead.
  //
  // manualPickRef only latches on a PREDICTION pick — choosing Pendings is
  // choosing the default priority, so it must not pin the agent away from leads.
  const switchToList = useCallback((listId: string) => {
    if (listId === activeListId) return;
    queueCurrentPhone.current = null;
    autoPickedRef.current = true;
    manualPickRef.current = listId !== PENDINGS_QUEUE_ID;
    setSelectedPhone('');
    setQueueMembers([]);
    setCurrentSource(null);
    setCurrentPendingOrderId(null);
    setActiveListId(listId);
  }, [activeListId]);

  const phoneDigits = selectedPhone.replace(/\D/g, '');
  const phoneReady = phoneDigits.length >= 6;

  // The attempt starts when the customer appears; a tel: tap / copy restarts it.
  useEffect(() => {
    attemptAtRef.current = selectedPhone ? { phone: selectedPhone, at: Date.now() } : null;
  }, [selectedPhone]);
  const attemptStartIso = useCallback((phone: string): string | undefined => {
    const a = attemptAtRef.current;
    return a && a.phone === phone ? new Date(a.at).toISOString() : undefined;
  }, []);

  // Heartbeat-based TAKE: while a customer is loaded, this hook keeps the
  // server-side active_call_views row alive. First heartbeat flips the
  // customer's pending/call_again orders to status='take' so other agents
  // see the soft lock; the lazy 2-minute sweep reverts on disconnect.
  useActiveCallView(phoneReady ? selectedPhone : undefined);

  const { data: ordersData } = useQuery({
    queryKey: ['calls-page-orders', selectedPhone],
    queryFn: () => apiGetOrders({ search: selectedPhone, limit: 50 }),
    enabled: phoneReady,
  });

  const linkedContext: LinkedContext | null = useMemo(
    () => pickLinkedContext(ordersData?.orders || []),
    [ordersData]
  );

  const handleDial = async () => {
    if (!phoneReady) {
      toast({ title: t('callsPage.enterPhone'), description: t('callsPage.enterPhoneDesc'), variant: 'destructive' });
      return;
    }
    if (!(await guardDialObligation(selectedPhone))) return;
    startCall(selectedPhone, linkedContext);
  };

  // Topbar "dial new number": call the typed number IMMEDIATELY (one step), on
  // the agent's secondary caller-ID (falls back to primary). Works for brand-new
  // numbers not tied to any order — those log as standalone calls. Also loads the
  // number as the active customer so any history shows alongside the call.
  const submitManualPhone = async () => {
    const next = manualPhoneDraft.trim();
    if (!next) return;
    if (next.replace(/\D/g, '').length < 6) {
      toast({ title: t('callsPage.enterPhone'), description: t('callsPage.enterPhoneDesc'), variant: 'destructive' });
      return;
    }
    // VOIP off (plan Фаза 11): the CRM no longer pretends to place the call — the
    // mock engine "answered" every dial after 800 ms. The number just becomes the
    // customer on screen; the agent dials it from their phone (DialPanel).
    if (!PBX_CONFIG.useRealVoip) {
      deferred.commit();
      setSelectedPhone(next);
      queueCurrentPhone.current = null;
      setCurrentSource('manual');
      setCurrentPendingOrderId(null);
      setManualPhoneDraft('');
      takeCallback(next);
      return;
    }
    if (state !== 'idle') return;
    if (!(await guardDialObligation(next))) return;
    setSelectedPhone(next);
    queueCurrentPhone.current = null; // detach from queue lock
    setCurrentSource('manual');
    setCurrentPendingOrderId(null);
    setManualPhoneDraft('');
    takeCallback(next);
    startCall(next, null, callerIds?.secondary || callerIds?.primary || undefined);
  };

  const openOrderById = async (orderId: string) => {
    try {
      const order = await apiGetOrder(orderId);
      setOrderModalData(orderToModalData(order));
    } catch (err: any) {
      toast({ title: t('callsPage.loadOrderFailed'), description: err?.message || t('common.unknownError'), variant: 'destructive' });
    }
  };

  const advancePredictionQueue = useCallback((completedPhone: string | null) => {
    const remaining = completedPhone ? queueMembers.filter(m => m.customer_phone !== completedPhone) : queueMembers;
    setQueueMembers(remaining);
    if (remaining.length === 0) {
      queueCurrentPhone.current = null;
      // Try the next list with members
      const nextList = (queues || []).find(q => q.list_id !== activeListId && q.remaining > 0);
      if (nextList) {
        autoPickedRef.current = false;
        setActiveListId(nextList.list_id);
      } else {
        setActiveListId(null);
      }
      return null;
    }
    const next = remaining[0];
    queueCurrentPhone.current = next.customer_phone;
    return next.customer_phone;
  }, [queueMembers, queues, activeListId]);
  // Note: advance crosses lists only for *different phones*. Under exclusive model
  // (Option 1), the completed phone cannot exist in the nextList's members. Safe.

  const advanceQueue = useCallback((completedPhone: string | null) => {
    // Working the Pendings queue: serve the next lead. When the leads run out,
    // fall through to a prediction list so nobody is stranded on an empty queue
    // with work available. manualPickRef stays false for a Pendings pick, so a
    // newly-arrived lead still pre-empts that prediction work on the next
    // advance — leads keep their priority, prediction is the filler.
    if (activeListId === PENDINGS_QUEUE_ID) {
      const next = pickNextPending(currentPendingOrderId);
      setPendingAdvance(null);
      if (next) {
        setSelectedPhone(next.customer_phone);
        setCurrentPendingOrderId(next.id);
        setCurrentSource('pending');
        return;
      }
      setCurrentPendingOrderId(null);
      const nextList = (queues || []).find(q => q.remaining > 0);
      if (nextList) {
        queueCurrentPhone.current = null;
        autoPickedRef.current = true;
        setSelectedPhone('');
        setQueueMembers([]);
        setCurrentSource(null);
        setActiveListId(nextList.list_id);
      } else {
        setSelectedPhone('');
        setCurrentSource(null);
      }
      return;
    }

    let nextPrediction: string | null = null;
    if (currentSource === 'prediction') {
      nextPrediction = advancePredictionQueue(completedPhone);
    }

    const nextPending = isPredictionPinned ? null : pickNextPending(currentPendingOrderId);
    if (nextPending) {
      setPendingAdvance(null);
      setSelectedPhone(nextPending.customer_phone);
      setCurrentPendingOrderId(nextPending.id);
      setCurrentSource('pending');
      return;
    }

    setCurrentPendingOrderId(null);
    if (currentSource === 'prediction') {
      if (nextPrediction) {
        setSelectedPhone(nextPrediction);
        setCurrentSource('prediction');
      } else {
        setSelectedPhone('');
        setCurrentSource(null);
      }
      return;
    }

    const resumed = advancePredictionQueue(null);
    if (resumed) {
      setSelectedPhone(resumed);
      setCurrentSource('prediction');
    } else {
      setSelectedPhone('');
      setCurrentSource(null);
    }
  }, [advancePredictionQueue, currentSource, currentPendingOrderId, pickNextPending, activeListId, isPredictionPinned, queues]);

  // Auto-release the customer from THIS agent's Personal List when a call
  // resolves (Confirmed/Cancelled/Trash). No-answer / Call-again keep them — we
  // still need to reach them. Best-effort; never blocks the queue flow.
  const releaseMyHoldIfAny = useCallback(async (phone: string) => {
    try {
      const hold = await apiLookupPersonalHold(phone);
      if (hold && hold.agent_id === user?.id) {
        await apiReleasePersonalHold(hold.id);
        qc.invalidateQueries({ queryKey: ['my-personal-holds'] });
        qc.invalidateQueries({ queryKey: ['personal-hold', phone] });
        qc.invalidateQueries({ queryKey: ['personal-hold'] });
      }
    } catch { /* best effort */ }
  }, [user?.id, qc]);

  // After a call ends, mark the queue member at the data layer immediately,
  // but don't swap the screen. Surface a "Next customer" button — the agent
  // decides when to leave (so they can still hit Create Order, edit notes,
  // etc. for a customer who confirmed verbally without clicking Confirm).
  useEffect(() => {
    if (!lastFinished) return;
    const { phone, outcome, cancellation_reason, cancellation_reason_notes, reason_text } = lastFinished;
    // The Pendings sentinel is not a real list_id — markAfterCall must never
    // receive it (it would UPDATE prediction_segment_members with a bad uuid).
    const isPrediction = activeListId
      && activeListId !== PENDINGS_QUEUE_ID
      && phone === queueCurrentPhone.current;

    // Resolved outcome → drop them from the agent's Personal List.
    if (outcome === 'confirmed' || outcome === 'cancelled' || outcome === 'trash') {
      void releaseMyHoldIfAny(phone);
    }

    // No actionable order to act on (prediction list, personal list, manual
    // number — pickLinkedContext returned null): the outcome must CREATE its own
    // status record instead of silently logging a standalone call. Mirrors the
    // orange "Choose Answer" handlers. (Customers WITH an actionable order had it
    // moved by the call outcome already, so they fall through.)
    if (!linkedContext && phone === selectedPhone) {
      if (outcome === 'confirmed') {
        // Agreed → open Create Order; its onClose marks the member + advances.
        setCreateOrderProps({ open: true, phone });
        qc.invalidateQueries({ queryKey: ['customer-history', phone] });
        qc.invalidateQueries({ queryKey: ['calls-page-orders', phone] });
        clearLastFinished();
        return;
      }
      // (VOIP mode only — with VOIP off no softphone call ever finishes.) The outcome
      // endpoint re-tags the softphone's own call row instead of adding a second one.
      if (outcome === 'cancelled') {
        const reason = cancellation_reason || 'other';
        void handleCancel(reason, cancellation_reason_notes || (reason === 'other' ? (reason_text || t('outcome.cancelled')) : ''));
        clearLastFinished();
        return;
      }
      if (outcome === 'trash') {
        // In-call bar has only free text (no structured key): 'other' + the text as the note.
        void handleTrash('other', (reason_text || '').replace(/^Reason:\s*/, '') || t('outcome.trash'));
        clearLastFinished();
        return;
      }
    }

    // no_answer is owned server-side (POST /call-logs sets the 1-day member hold
    // and enforces the 5-strike auto-trash). Calling markAfterCall here would
    // race that — and could resurrect a member the server just trashed — so we
    // only refresh the queue for no_answer and let markAfterCall handle the rest.
    if (isPrediction) {
      if (outcome === 'no_answer') {
        qc.invalidateQueries({ queryKey: ['my-queue-summary'] });
        qc.invalidateQueries({ queryKey: ['my-queue-members'] });
      } else {
        void markAfterCall(activeListId, phone, outcome);
      }
    }
    if (phone === selectedPhone && (isPrediction || currentSource === 'pending')) {
      setPendingAdvance({ phone, outcome });
    }
    // Refresh the customer's order + call history so the new call appears
    // in the Calls tab and any auto-flipped status (cancelled/confirmed/etc)
    // shows in the Orders tab without a manual page reload.
    qc.invalidateQueries({ queryKey: ['customer-history', phone] });
    qc.invalidateQueries({ queryKey: ['calls-page-orders', phone] });
    qc.invalidateQueries({ queryKey: ['customer-intelligence', phone] });
    qc.invalidateQueries({ queryKey: ['calls-page-pendings', user?.id] });
      qc.invalidateQueries({ queryKey: ['my-pendings-summary', user?.id] });
    clearLastFinished();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastFinished]);

  const handleNextCustomer = useCallback(() => {
    if (!pendingAdvance) return;
    const phone = pendingAdvance.phone;
    setPendingAdvance(null);
    advanceQueue(phone);
  }, [pendingAdvance, advanceQueue]);

  // Find this customer's live lead so a disposition COMPLETES it instead of
  // forking a second order. The cached queue is capped and can be seconds stale,
  // so a miss falls back to a direct server lookup before we ever create.
  // (`POST /orders` refuses to fork anyway — this just keeps the UX seamless
  // rather than showing the agent a 409.)
  // Every open order for this phone, newest first. Since duplicates became
  // workable a customer can have a pending lead AND a duplicate at the same time,
  // so the caller must let the agent pick rather than guess — BG confirmed the
  // ORIGINAL because the queue row silently won (2026-08-12).
  //
  // Deliberately server-only: the local `pendingOrders` shortcut this replaced
  // returned the queue row without ever learning about a second open order, which
  // is exactly how the wrong order got confirmed.
  const resolveOpenLeads = useCallback(async (phone: string): Promise<OpenLead[]> => {
    if (!phone) return [];
    try {
      const { leads, lead } = await apiGetOpenLead(phone);
      if (leads?.length) return leads;
      return lead ? [lead] : [];
    } catch {
      return [];
    }
  }, []);

  // ── Which open order does this outcome act on? ──
  // 0 open orders → null (caller creates a record). Exactly 1 → that one.
  // More than 1 → park the action and ask; the dialog resumes it with the
  // agent's pick. `intent` is only used to word the dialog.
  // The same dialog answers POST /calls/outcome's 409 choose_order (the server's leads).
  const [orderChoice, setOrderChoice] = useState<
    { leads: OpenLead[]; intent: 'confirm' | 'cancel' | 'trash' | 'call_again'; resolve: (id: string | null) => void } | null
  >(null);
  const chooseOpenOrder = useCallback(async (
    phone: string,
    intent: 'confirm' | 'cancel' | 'trash',
  ): Promise<string | null> => {
    const leads = await resolveOpenLeads(phone);
    if (leads.length === 0) return null;
    if (leads.length === 1) return leads[0].id;
    return new Promise<string | null>((resolve) => setOrderChoice({ leads, intent, resolve }));
  }, [resolveOpenLeads]);

  // ── Mandatory answer per HAND-OPENED client (operator rule 2026-08-13) ──
  // A client the agent opens themselves — search bar "Open in Calls", Personal
  // List, Call Again — is registered server-side, and the agent owes an answer
  // for it. The server keeps the FIRST unanswered one; trying to open ANOTHER
  // hand-picked client snaps the screen back with "handle this one first".
  // Survives refresh and re-login. Admins/managers browse freely.
  //
  // SCOPE IS THE WHOLE POINT (operator, 2026-08-13): the queues — prediction
  // lists and Pendings — are exempt in BOTH directions. A queue customer never
  // creates a debt, and an outstanding debt never blocks the queue from serving
  // the next customer. Registering every client that merely lands on the screen
  // is what would have stopped agents opening anyone from the search bar at all.
  const obligationExempt = isAdminOrManager;
  const { data: obligationData } = useQuery({
    queryKey: ['call-obligation', user?.id],
    queryFn: apiGetMyCallObligation,
    enabled: !!user && !obligationExempt,
    staleTime: 15_000,
  });
  const obligation = obligationData?.obligation ?? null;
  const refreshObligation = useCallback(
    () => qc.invalidateQueries({ queryKey: ['call-obligation'] }),
    [qc],
  );

  // Gate + register at the moment the agent presses CALL — never on display.
  // Returns false when the call must not start because an answer is owed for a
  // DIFFERENT hand-picked client.
  //
  // Deliberately keyed on the dial, not on the screen: registering whatever was
  // being displayed locked agents out of the search bar as soon as the queue
  // auto-served the next customer ("finish this client first", with no way to
  // call anybody). Browsing is free; committing to a call is the promise.
  const guardDialObligation = useCallback(async (phone: string): Promise<boolean> => {
    if (!user || obligationExempt) return true;
    const key = normalizePhoneKey(phone || '');
    if (!key || key.length < 8) return true;
    // Queue customers (prediction lists + Pendings) never create a debt and are
    // never blocked by one — operator rule 2026-08-13.
    if (normalizePhoneKey(handOpenedPhone || '') !== key) return true;
    try {
      const { obligation: standing } = await apiRegisterCallObligation(phone, 'hand_opened');
      qc.setQueryData(['call-obligation', user.id], { obligation: standing ?? null });
      if (standing && normalizePhoneKey(standing.customer_phone) !== key) {
        toast({
          title: t('callsPage.finishCurrentFirst'),
          description: t('callsPage.finishCurrentFirstDesc'),
          variant: 'destructive',
        });
        return false;
      }
    } catch { /* never block a call on a network hiccup */ }
    return true;
  }, [user, obligationExempt, handOpenedPhone, normalizePhoneKey, qc, toast, t]);

  // The handset dial (tel: tap / number copied) — the same promise as pressing Call,
  // decided synchronously because a tel: link cannot wait for the network: block only
  // when a DIFFERENT hand-opened client is still owed, register the debt in the
  // background. A no-answer still in its undo window is sent first — it may be the
  // very answer that debt is waiting for.
  const beforeAttempt = useCallback((): boolean => {
    const phone = selectedPhone;
    const key = normalizePhoneKey(phone || '');
    const pendingKey = deferred.pending ? normalizePhoneKey(deferred.pending.body.phone) : null;
    deferred.commit();
    if (user && !obligationExempt && key.length >= 8 && normalizePhoneKey(handOpenedPhone || '') === key) {
      const owed = obligation ? normalizePhoneKey(obligation.customer_phone) : null;
      if (owed && owed !== key && owed !== pendingKey) {
        toast({ title: t('callsPage.finishCurrentFirst'), description: t('callsPage.finishCurrentFirstDesc'), variant: 'destructive' });
        return false;
      }
      void apiRegisterCallObligation(phone, 'hand_opened')
        .then(({ obligation: standing }) => qc.setQueryData(['call-obligation', user.id], { obligation: standing ?? null }))
        .catch(() => { /* never block a call on a network hiccup */ });
    }
    attemptAtRef.current = { phone, at: Date.now() };
    return true;
  }, [selectedPhone, normalizePhoneKey, deferred, user, obligationExempt, handOpenedPhone, obligation, toast, t, qc]);

  // Refreshing or re-logging in must not shake off the debt: with nothing on
  // screen yet, the owed client is restored before the queue picks anyone.
  // (Not while that client's "no answer" is still in its undo window — the answer
  // is on its way; restoring them would serve the same customer twice.)
  useEffect(() => {
    if (obligationExempt || !obligation) return;
    if (deferred.pending && normalizePhoneKey(deferred.pending.body.phone) === normalizePhoneKey(obligation.customer_phone)) return;
    if (!selectedPhone) {
      autoPickedRef.current = true;   // the debt outranks the queue's auto-pick
      queueCurrentPhone.current = null;
      setCurrentSource('manual');
      setHandOpenedPhone(obligation.customer_phone);
      setSelectedPhone(obligation.customer_phone);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [obligation, obligationExempt, selectedPhone]);

  // Confirm-from-call → CreateOrderModal pre-filled with the call's phone.
  // If that phone IS a live lead, complete the existing order instead of
  // creating a second one (which would orphan the lead + its AlterCPA sidecar).
  useEffect(() => {
    if (!pendingConfirm) return;
    const phone = pendingConfirm.phone;
    clearPendingConfirm();
    void (async () => {
      // Same which-order rule as the Choose Answer buttons: with several open
      // orders (pending lead + duplicate) the agent picks, never the code.
      const existingOrderId = await chooseOpenOrder(phone || '', 'confirm');
      setCreateOrderProps({
        open: true,
        phone,
        ...(existingOrderId ? { existingOrderId } : {}),
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingConfirm]);

  // Claiming a customer into the Personal List ends the conversation for the
  // queue's purposes. Close out any live/wrapping call first (logs it + clears
  // the call strip so the dial bar returns — otherwise the strip stays stuck on
  // the previous customer and blocks the next call), then mark the queue member
  // done and pull up the next customer.
  const handleClaimedToPersonalList = useCallback((phone: string) => {
    void endCallForClaim();
    if (activeListId && phone === queueCurrentPhone.current) {
      void markAfterCall(activeListId, phone, 'interested');
    }
    setPendingAdvance(null);
    advanceQueue(phone);
  }, [endCallForClaim, activeListId, markAfterCall, advanceQueue]);

  // The agent fixed the customer's name/phone on the card. The server already
  // rewrote every order + the queue sources; here we just re-point the active
  // customer (and the queue lock) at the corrected number so Dial and after-call
  // marking follow it. Name-only edits keep the same phone — nothing to re-point.
  const handleCustomerUpdated = useCallback((newPhone: string) => {
    if (!newPhone || newPhone === selectedPhone) return;
    if (queueCurrentPhone.current === selectedPhone) queueCurrentPhone.current = newPhone;
    setSelectedPhone(newPhone);
    qc.invalidateQueries({ queryKey: ['calls-page-orders', newPhone] });
    qc.invalidateQueries({ queryKey: ['calls-page-pendings', user?.id] });
      qc.invalidateQueries({ queryKey: ['my-pendings-summary', user?.id] });
  }, [selectedPhone, qc, user?.id]);

  // Best-known name for the current customer (for cancel/trash order records).
  const currentCustomerName = useMemo(
    () => (ordersData?.orders || [])[0]?.customer_name || '',
    [ordersData]
  );

  // ── One-tap outcomes (plan Фаза 11) — the outcome IS the call log ──
  // POST /api/calls/outcome does, in ONE server call, what this page used to do in
  // 2–4: find the open order (409 choose_order → the "Which order?" dialog below),
  // move it or write the cancel / trash record (with the last purchase as the
  // product), write the call row, clear the obligation, mark the list member.

  // The list the customer was served from — markAfterCall's own condition.
  const outcomeListId = useCallback((phone: string): string | undefined => (
    currentSource === 'prediction' && activeListId && activeListId !== PENDINGS_QUEUE_ID && phone === queueCurrentPhone.current
      ? activeListId
      : undefined
  ), [currentSource, activeListId]);

  const outcomeBody = useCallback((outcome: CallOutcomeKey, phone: string): RecordOutcomeBody => {
    const listId = outcomeListId(phone);
    const startedAt = attemptStartIso(phone);
    return {
      phone,
      outcome,
      ...(listId ? { list_id: listId } : {}),
      ...(startedAt ? { started_at: startedAt } : {}),
    };
  }, [outcomeListId, attemptStartIso]);

  // Send it; when the customer has several open orders the agent picks one and it is
  // sent again with that order — the code never guesses (BG, 2026-08-12).
  const sendOutcome = useCallback(async (
    body: RecordOutcomeBody,
    intent: 'cancel' | 'trash' | 'call_again',
  ): Promise<RecordOutcomeResult | null> => {
    try {
      return await apiRecordCallOutcome(body);
    } catch (err) {
      if (err instanceof CallOutcomeError && err.code === 'choose_order' && err.leads.length > 0 && !body.order_id) {
        const chosen = await new Promise<string | null>((resolve) => setOrderChoice({ leads: err.leads, intent, resolve }));
        if (!chosen) return null;
        return apiRecordCallOutcome({ ...body, order_id: chosen });
      }
      throw err;
    }
  }, []);

  const outcomeErrorText = useCallback((err: unknown): string => {
    if (err instanceof CallOutcomeError) {
      if (err.status === 404) return t('callsWork.toast.routeMissing');
      if (err.code === 'order_moved' || err.code === 'order_not_open') return t('callsWork.toast.orderMoved');
      return err.message;
    }
    return (err as Error)?.message || t('common.unknownError');
  }, [t]);

  const invalidateCustomer = useCallback((phone: string) => {
    qc.invalidateQueries({ queryKey: ['calls-page-orders', phone] });
    qc.invalidateQueries({ queryKey: ['customer-history', phone] });
    qc.invalidateQueries({ queryKey: ['customer-intelligence', phone] });
  }, [qc]);

  // Shared tail of every outcome: refresh what moved, then the next customer — or
  // back to "Повторни повици" when the customer was opened from there.
  const afterOutcome = useCallback((phone: string) => {
    void apiReleaseActiveView(phone).catch(() => { /* best effort */ });
    invalidateCustomer(phone);
    refreshQueues();
    qc.invalidateQueries({ queryKey: ['my-queue-members'] });
    refreshObligation();
    setPendingAdvance(null);
    advanceQueue(phone);
    if (fromCallbacksRef.current) {
      fromCallbacksRef.current = false;
      setSearchParams({ queue: 'call-again' });
    }
  }, [invalidateCustomer, refreshQueues, qc, refreshObligation, advanceQueue, setSearchParams]);

  // Confirmed → open the order modal (status forced confirmed there).
  // A customer with an actionable pending order (a lead) gets the SAME modal,
  // but in complete-existing mode: it fills and confirms that order in place.
  // The old direct status flip here produced "empty" confirmed orders — the
  // sparse webhook row went straight to confirmed with no products/address.
  const handleAnswerConfirmed = useCallback(async () => {
    if (!phoneReady) return;
    deferred.commit();
    // Ask the server first: the queue row is NOT authoritative once a customer can
    // have several open orders (pending lead + duplicate). Only fall back to the
    // remembered/queue id when there is exactly one — chooseOpenOrder returns null
    // for none and prompts for more than one.
    const chosen = await chooseOpenOrder(selectedPhone, 'confirm');
    const pendingId = chosen ?? currentPendingOrderId ?? activePendingOrder?.id ?? null;
    if (pendingId && !currentPendingOrderId) {
      // Phone-matched lead: remember it so advanceQueue's pickNextPending
      // exclusion works after the modal confirms it.
      setCurrentPendingOrderId(pendingId);
    }
    setCreateOrderProps({
      open: true,
      phone: selectedPhone,
      ...(pendingId ? { existingOrderId: pendingId } : {}),
    });
  }, [phoneReady, deferred, selectedPhone, currentPendingOrderId, activePendingOrder, chooseOpenOrder]);

  // Откажа — a reason is required (the bar never sends one without it). An open lead
  // is cancelled in place; no open order → a cancel record carrying the last purchase.
  const handleCancel = useCallback(async (reason: CancellationReason, note: string) => {
    const phone = selectedPhone;
    if (!phone) return;
    deferred.commit();
    setBusyOutcome('cancelled');
    try {
      const res = await sendOutcome({ ...outcomeBody('cancelled', phone), reason, ...(note ? { note } : {}) }, 'cancel');
      if (!res) return;
      toast({
        title: t('callsWork.toast.cancelled'),
        description: [cancelReasonLabel(reason), res.order_action === 'created' ? res.product_name : null].filter(Boolean).join(' · '),
      });
      afterOutcome(phone);
    } catch (err) {
      toast({ title: t('callsPage.cancellationFailed'), description: outcomeErrorText(err), variant: 'destructive' });
    } finally {
      setBusyOutcome(null);
    }
  }, [selectedPhone, deferred, sendOutcome, outcomeBody, toast, t, afterOutcome, outcomeErrorText]);

  // Корпа — the structured reason decides the sticky trash (engine v3.7-mk).
  const handleTrash = useCallback(async (reason: TrashReason, note: string) => {
    const phone = selectedPhone;
    if (!phone) return;
    deferred.commit();
    setBusyOutcome('trash');
    try {
      const res = await sendOutcome({ ...outcomeBody('trash', phone), reason, ...(note ? { note } : {}) }, 'trash');
      if (!res) return;
      toast({ title: t('callsWork.toast.trash'), description: trashReasonLabel(reason) });
      afterOutcome(phone);
    } catch (err) {
      toast({ title: t('callsPage.recordFailed'), description: outcomeErrorText(err), variant: 'destructive' });
    } finally {
      setBusyOutcome(null);
    }
  }, [selectedPhone, deferred, sendOutcome, outcomeBody, toast, t, afterOutcome, outcomeErrorText]);

  // Повторно — the customer answered and asked for a call at a time: a lead goes to
  // call_again parked until then, a list member is held until then. Shows in "Мои".
  const handleCallAgain = useCallback(async (at: Date) => {
    const phone = selectedPhone;
    if (!phone) return;
    deferred.commit();
    setBusyOutcome('call_again');
    try {
      const res = await sendOutcome({ ...outcomeBody('call_again', phone), callback_at: at.toISOString() }, 'call_again');
      if (!res) return;
      toast({ title: t('callsWork.toast.callAgain', { time: skopjeClock(at) }) });
      afterOutcome(phone);
    } catch (err) {
      toast({ title: t('callsWork.toast.failed'), description: outcomeErrorText(err), variant: 'destructive' });
    } finally {
      setBusyOutcome(null);
    }
  }, [selectedPhone, deferred, sendOutcome, outcomeBody, toast, t, afterOutcome, outcomeErrorText]);

  // Не одговара — one tap. The next customer comes up at once; the outcome is sent
  // when the 5 s undo closes (useDeferredOutcome). The server owns the lifecycle:
  // the 2-a-day pacing and the 9-strike Unreachable rule for list customers, a lead
  // to call_again (never auto-trashed) — no stub orders.
  const handleNoAnswer = useCallback(() => {
    const phone = selectedPhone;
    if (!phone) return;
    const body = outcomeBody('no_answer', phone);
    const disposedId = currentPendingOrderId ?? activePendingOrder?.id ?? null;
    const snap = {
      selectedPhone, currentSource, currentPendingOrderId, activeListId, handOpenedPhone,
      queuePhone: queueCurrentPhone.current,
      member: queueMembers.find((m) => m.customer_phone === phone) ?? null,
      fromCallbacks: fromCallbacksRef.current,
    };
    const label = currentCustomerName || (activePendingOrder as { customer_name?: string | null } | null)?.customer_name || snap.member?.customer_name
      || formatLocalDisplay(toLocalDial(phone)) || phone;
    // Flip locally before the advance so the sort already treats this lead as
    // call_again (behind the fresh ones). The server catches up in 5 s.
    if (disposedId) {
      qc.setQueryData(['calls-page-pendings', user?.id], (old: any) => {
        if (!old?.orders) return old;
        return {
          ...old,
          orders: old.orders.map((o: any) => (o.id === disposedId
            ? { ...o, status: 'call_again', call_again_since: o.call_again_since || new Date().toISOString() }
            : o)),
        };
      });
    }
    deferred.schedule({
      body,
      label,
      onCommitted: () => {
        invalidateCustomer(phone);
        refreshQueues();
        qc.invalidateQueries({ queryKey: ['my-queue-members'] });
        refreshObligation();
      },
      onFailed: (err) => {
        toast({ title: t('callsPage.noAnswerFailed'), description: outcomeErrorText(err), variant: 'destructive' });
        refreshQueues();
      },
      onUndo: () => {
        // Nothing was sent — put the customer back exactly where they were.
        queueCurrentPhone.current = snap.queuePhone;
        if (snap.member) {
          const m = snap.member;
          setQueueMembers((prev) => (prev.some((x) => x.customer_phone === m.customer_phone) ? prev : [m, ...prev]));
        }
        setActiveListId(snap.activeListId); // a no-op unless the advance moved to another list
        setSelectedPhone(snap.selectedPhone);
        setCurrentSource(snap.currentSource);
        setCurrentPendingOrderId(snap.currentPendingOrderId);
        setHandOpenedPhone(snap.handOpenedPhone);
        fromCallbacksRef.current = snap.fromCallbacks;
        if (snap.fromCallbacks) setSearchParams({}, { replace: true });
        qc.invalidateQueries({ queryKey: ['calls-page-pendings', user?.id] }); // undo the local flip
      },
    });
    void apiReleaseActiveView(phone).catch(() => { /* best effort */ });
    setPendingAdvance(null);
    advanceQueue(phone);
    if (fromCallbacksRef.current) {
      fromCallbacksRef.current = false;
      setSearchParams({ queue: 'call-again' });
    }
  }, [
    selectedPhone, outcomeBody, currentPendingOrderId, activePendingOrder, currentSource, activeListId, handOpenedPhone,
    queueMembers, currentCustomerName, qc, user?.id, deferred, invalidateCustomer, refreshQueues, refreshObligation,
    toast, t, outcomeErrorText, advanceQueue, setSearchParams,
  ]);

  // Opening a callback from "Повторни повици": a hand-opened client (claims the
  // callback, owes an answer) — the ?phone= path the old /call-again page used.
  const openCallback = useCallback((item: MyCallback) => {
    deferred.commit();
    fromCallbacksRef.current = true;
    setSearchParams({ phone: item.customer_phone });
  }, [deferred, setSearchParams]);

  const setView = useCallback((v: CallsView) => {
    if (v === view) return;
    setSearchParams(v === 'call-again' ? { queue: 'call-again' } : {});
  }, [view, setSearchParams]);

  // When an order is created from the modal, immediately mark the current
  // queue member done (mapping the chosen status → queue outcome) and advance
  // to the next customer — no separate "Next customer" click needed. Works
  // even if no call was placed.
  const handleCreateOrderClosed = useCallback((created?: boolean, outcome?: string, wasManualFromModal?: boolean) => {
    const phone = createOrderProps.phone || selectedPhone;
    const wasManual = wasManualFromModal || !!createOrderProps.isManual;
    const wasConfirmOfPending = !!createOrderProps.existingOrderId;
    setCreateOrderProps({ open: false });

    if (!created) return;

    qc.invalidateQueries({ queryKey: PROMO_QUERY_KEY }); // a new order may be a promo up-sell

    // A pending lead was just completed+confirmed in place — refresh the
    // agent's pending queue and release the active-view claim, exactly what
    // the old direct-flip path did.
    if (wasConfirmOfPending && !wasManual) {
      qc.invalidateQueries({ queryKey: ['calls-page-pendings', user?.id] });
      qc.invalidateQueries({ queryKey: ['my-pendings-summary', user?.id] });
      void apiReleaseActiveView(phone).catch(() => { /* best effort */ });
    }

    // The VoIP call is fully decoupled from order recording: it already ended
    // (and reset to idle) the moment the agent hung up, so there is nothing to
    // finalize here — recording the order never touches the call.

    // If the agent explicitly chose "Manual Order" inside the modal, do not
    // consume or advance the current queue item.
    if (wasManual) {
      qc.invalidateQueries({ queryKey: ['calls-page-orders', phone] });
      qc.invalidateQueries({ queryKey: ['customer-history', phone] });
      qc.invalidateQueries({ queryKey: ['customer-intelligence', phone] });
      return;
    }

    // status → queue outcome. call_again retries in 2 days; everything else
    // completes the member for this list.
    const outcomeMap: Record<string, string> = {
      confirmed: 'confirmed',
      cancelled: 'cancelled',
      trashed: 'trash',
      call_again: 'call_again',
      pending: 'interested',
    };
    const queueOutcome = outcomeMap[outcome || 'confirmed'] || 'confirmed';

    qc.invalidateQueries({ queryKey: ['calls-page-orders', phone] });
    qc.invalidateQueries({ queryKey: ['customer-history', phone] });
    qc.invalidateQueries({ queryKey: ['customer-intelligence', phone] });
    refreshObligation();

    const isListMember = !!activeListId && phone === queueCurrentPhone.current;
    if (queueOutcome === 'confirmed') {
      // The confirm is a call outcome too (plan Фаза 11): one call row against the
      // order the form confirmed, the member completed server-side. An api without
      // the route (404) falls back to the old browser write.
      const body = outcomeBody('confirmed', phone);
      void apiRecordCallOutcome({ ...body, ...(createOrderProps.existingOrderId ? { order_id: createOrderProps.existingOrderId } : {}) })
        .then(() => { refreshQueues(); qc.invalidateQueries({ queryKey: ['my-queue-members'] }); })
        .catch(() => { if (isListMember && activeListId) void markAfterCall(activeListId, phone, 'confirmed'); });
    } else if (isListMember && activeListId) {
      void markAfterCall(activeListId, phone, queueOutcome);
    }
    // Clear any pending "Next customer" banner from a prior call end and jump.
    setPendingAdvance(null);
    advanceQueue(phone);
    if (fromCallbacksRef.current) {
      fromCallbacksRef.current = false;
      setSearchParams({ queue: 'call-again' });
    }
  }, [createOrderProps.phone, createOrderProps.isManual, createOrderProps.existingOrderId, selectedPhone, activeListId, markAfterCall, advanceQueue, qc, user?.id, refreshObligation, outcomeBody, refreshQueues, setSearchParams]);

  // VOIP off: the topbar number input OPENS the number as the customer (the agent
  // dials it from their phone); with the softphone it still places the call.
  const voipOn = PBX_CONFIG.useRealVoip;
  const dialLabels = voipOn
    ? { title: t('callsPage.dialANumber'), button: t('callsPage.call'), placeholder: t('callsPage.dialNewNumber') }
    : { title: t('callsWork.dial.openNumber'), button: t('callsWork.dial.open'), placeholder: t('callsWork.dial.openPlaceholder') };

  // Topbar controls (next to the "Calls" title): the manual dial input and the
  // queue picker. The queue shows for ANYONE with assigned lists — agents
  // included — so they know which list they're working.
  const headerControls = (
    <div className="flex items-center gap-1.5">
      {compactHeader ? (
        <>
          {/* Mobile: a single phone icon that opens a dial dialog (keeps the topbar uncluttered). */}
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8 shrink-0"
            onClick={() => setDialOpen(true)}
            aria-label={dialLabels.title}
          >
            <PhoneOutgoing className="h-4 w-4" />
          </Button>
          <Dialog open={dialOpen} onOpenChange={setDialOpen}>
            <DialogContent className="max-w-xs">
              <DialogHeader><DialogTitle>{dialLabels.title}</DialogTitle></DialogHeader>
              <Input
                autoFocus
                type="tel"
                inputMode="tel"
                value={manualPhoneDraft}
                onChange={(e) => setManualPhoneDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { void submitManualPhone(); setDialOpen(false); } }}
                placeholder={t('callsPage.phoneNumber')}
                className="font-mono"
              />
              <DialogFooter>
                <Button
                  onClick={() => { void submitManualPhone(); setDialOpen(false); }}
                  disabled={(voipOn && state !== 'idle') || !manualPhoneDraft.trim()}
                  className="w-full gap-1.5"
                >
                  <PhoneOutgoing className="h-4 w-4" /> {dialLabels.button}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Mobile: a Layers icon to pick which list (queue) to work — the
              desktop dropdown is hidden on small screens, so this is the only
              way agents can switch lists on a phone. Shows a small count badge. */}
          {allQueues.length > 0 && (
            <>
              <Button
                size="icon"
                variant="outline"
                className="relative h-8 w-8 shrink-0"
                onClick={() => setListPickerOpen(true)}
                aria-label={t('callsPage.queueLabel')}
                title={pendingsWaiting > 0 ? t('callsPage.pendingsWaiting', { count: pendingsWaiting }) : undefined}
              >
                <Layers className="h-4 w-4" />
                {/* Amber + the lead count when pendings are waiting behind a
                    prediction list the agent deliberately pinned; otherwise the
                    plain queue count. */}
                <span className={`absolute -right-1 -top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none ${
                  pendingsWaiting > 0
                    ? 'bg-amber-500 text-white animate-pulse'
                    : 'bg-primary text-primary-foreground'
                }`}>
                  {pendingsWaiting > 0 ? pendingsWaiting : allQueues.length}
                </span>
              </Button>
              <Dialog open={listPickerOpen} onOpenChange={setListPickerOpen}>
                <DialogContent className="max-w-xs">
                  <DialogHeader><DialogTitle>{t('callsPage.chooseList')}</DialogTitle></DialogHeader>
                  <div className="flex flex-col gap-1.5">
                    {allQueues.map(q => (
                      <Button
                        key={q.list_id}
                        variant={q.list_id === activeListId ? 'default' : 'outline'}
                        className={`h-auto w-full justify-between gap-2 py-2 text-left ${
                          q.is_pendings && q.list_id !== activeListId ? 'border-amber-400 text-amber-700 dark:text-amber-300' : ''
                        }`}
                        onClick={() => { switchToList(q.list_id); setListPickerOpen(false); }}
                      >
                        <span className="truncate" title={q.list_name}>{predictionListLabel(q.list_name)}</span>
                        <span className="shrink-0 text-xs opacity-80">
                          {q.is_pendings
                            ? t('callsPage.queueCountPendings', { left: q.remaining, talked: q.talked ?? 0 })
                            : `${q.remaining} (${q.total})`}
                        </span>
                      </Button>
                    ))}
                  </div>
                </DialogContent>
              </Dialog>
            </>
          )}
        </>
      ) : (
        <div className={`inline-flex items-center gap-1 rounded-lg border bg-background px-1.5 py-0.5 ${hoverLift}`}>
          <Phone className="h-3 w-3 text-muted-foreground" />
          <Input
            value={manualPhoneDraft}
            onChange={(e) => setManualPhoneDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitManualPhone(); }}
            placeholder={dialLabels.placeholder}
            aria-label={dialLabels.title}
            className="h-6 text-xs font-mono border-0 shadow-none focus-visible:ring-0 px-1 bg-transparent w-36"
          />
          <Button
            size="sm"
            onClick={() => { void submitManualPhone(); }}
            disabled={(voipOn && state !== 'idle') || !manualPhoneDraft.trim()}
            variant="outline"
            className="h-6 gap-1 text-[10px] px-1.5"
          >
            <PhoneOutgoing className="h-2.5 w-2.5" />
            {dialLabels.button}
          </Button>
        </div>
      )}

      {allQueues.length > 0 && !compactHeader && (
        <div
          className={`inline-flex items-center gap-1.5 rounded-xl border bg-background px-2 py-0.5 ${hoverLift} ${
            pendingsWaiting > 0 ? 'border-amber-400 ring-1 ring-amber-300/60' : ''
          }`}
          title={pendingsWaiting > 0 ? t('callsPage.pendingsWaiting', { count: pendingsWaiting }) : t('callsPage.queueLabel')}
        >
          <Layers className={`h-3 w-3 shrink-0 ${pendingsWaiting > 0 ? 'text-amber-500' : 'text-muted-foreground'}`} />
          <Select value={activeListId || ''} onValueChange={switchToList}>
            <SelectTrigger className="h-6 text-xs min-w-[140px] max-w-[16rem] border-0 shadow-none focus:ring-0">
              <SelectValue placeholder={t('callsPage.listsCount', { count: allQueues.length })} />
            </SelectTrigger>
            <SelectContent>
              {allQueues.map(q => (
                <SelectItem key={q.list_id} value={q.list_id}>
                  {/* Pendings read "left (N talked)" — leads have no fixed list
                      size, so "talked today" is the meaningful second number. */}
                  {q.is_pendings
                    ? `${predictionListLabel(q.list_name)} — ${t('callsPage.queueCountPendings', { left: q.remaining, talked: q.talked ?? 0 })}`
                    : `${predictionListLabel(q.list_name)} — ${q.remaining} (${q.total})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Amber pill when leads are waiting behind a pinned prediction list. */}
          {pendingsWaiting > 0 && (
            <span className="shrink-0 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold leading-4 text-white">
              {pendingsWaiting}
            </span>
          )}
        </div>
      )}
    </div>
  );

  // The Call button (plan Фаза 11). VOIP off: a tel: link on a phone, the number +
  // copy on a computer — the agent dials from their own handset and the outcome tap
  // logs the call (no Call / End). VOIP on: the softphone's green button, as before.
  const dialButton = phoneReady ? (
    <DialPanel
      phone={selectedPhone}
      isMobile={isMobile}
      voip={voipOn}
      voipIdle={state === 'idle'}
      onVoipDial={() => { void handleDial(); }}
      onAttempt={beforeAttempt}
      className={isMobile ? 'basis-full' : undefined}
    />
  ) : null;

  // Under the customer strip: the one-tap outcome bar (pinned to the bottom edge on
  // phones), then the softphone's "Next customer" pause (VOIP mode) and the promo.
  const actionBar = (
    <div className="space-y-3">
      {phoneReady && (
        <OutcomeBar
          busy={busyOutcome}
          onNoAnswer={handleNoAnswer}
          onCallAgain={(at) => { void handleCallAgain(at); }}
          onCancel={(r, n) => { void handleCancel(r, n); }}
          onTrash={(r, n) => { void handleTrash(r, n); }}
          onConfirm={() => { void handleAnswerConfirmed(); }}
          keyboard={!isMobile}
        />
      )}

      {pendingAdvance && pendingAdvance.phone === selectedPhone && (
        <div className={`rounded-xl border border-[hsl(var(--success))]/30 bg-[hsl(var(--success))]/5 px-4 py-3 flex flex-wrap items-center gap-3 text-sm ${hoverLift}`}>
          <div className="min-w-0 flex-1">
            {t('callsPage.markedAs')} <strong>{t(`outcome.${pendingAdvance.outcome}`, { defaultValue: pendingAdvance.outcome.replace(/_/g, ' ') })}</strong>{t('callsPage.stayHint')}
          </div>
          <Button size="sm" onClick={handleNextCustomer} className="gap-1.5 shrink-0">
            {t('callsPage.nextCustomer')} <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Product of the Day — renders nothing when no promo is running. */}
      <PromoOfTheDayBanner />
    </div>
  );

  // The progress row: what is left in the queue on screen · my outcomes today · my sales today.
  const activeQueue = allQueues.find((q) => q.list_id === activeListId) ?? null;
  const progressLeft = activeQueue
    ? activeQueue.remaining
    : allQueues.length > 0 ? allQueues.reduce((s, q) => s + q.remaining, 0) : (pendingsSummary ? pendingsSummary.ready : null);
  const progressLeftSub = activeQueue
    ? (activeQueue.is_pendings ? t('callsWork.queue.leads') : predictionListLabel(activeQueue.list_name))
    : null;
  const callbacksDue = callbacksQuery.data?.due ?? 0;
  const barShown = view === 'queue' && phoneReady;

  return (
    <AppLayout title="" headerActions={headerControls}>
      {/* Bottom padding on phones = room for the pinned outcome bar. */}
      <div className={`space-y-3 md:space-y-4 ${barShown ? 'pb-28 md:pb-0' : ''}`}>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <QueueTabs view={view} onChange={setView} dueCount={callbacksDue} />
          <div className="lg:w-[30rem]">
            <CallsProgress
              left={progressLeft}
              leftSub={progressLeftSub}
              callsToday={progress?.calls_today ?? null}
              salesToday={progress?.sales_today ?? null}
            />
          </div>
        </div>

        {view === 'call-again' ? (
          <CallAgainQueue
            data={callbacksQuery.data}
            isLoading={callbacksQuery.isLoading}
            isError={callbacksQuery.isError}
            onRetry={() => { void callbacksQuery.refetch(); }}
            onOpen={openCallback}
          />
        ) : !phoneReady ? (
          <div className="space-y-4">
            <EmptyState
              icon={<Phone className="h-6 w-6" />}
              title={t('callsPage.nothingToCall')}
              description={activeListId === PENDINGS_QUEUE_ID
                ? t('callsPage.pendingsEmptyDesc')
                : isAdminOrManager && activeListId && queueMembers.length === 0
                  ? t('callsPage.emptyListDesc')
                  : allQueues.length > 0
                    ? t('callsPage.haveListsDesc', { count: allQueues.length })
                    : t('callsPage.noAssignedDesc')}
              size="lg"
            />
            {callbacksDue > 0 && (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={() => setView('call-again')} className="gap-1.5">
                  {t('callsWork.callbacks.dueCta', { count: callbacksDue })} <ArrowRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}
            {state !== 'idle' && (
              <p className="text-xs text-[hsl(var(--success))] font-medium text-center pt-2">
                {t('callsPage.activeCallInProgress')}
              </p>
            )}
            {actionBar}
          </div>
        ) : (
          // Scripts & Helpers are a coaching aid — shown to EVERYONE on Calls
          // (prediction agents, pending/inbound agents, managers, admins), so
          // showScripts is always on here.
          <div className="space-y-2">
            {/* Shown only while the client ON SCREEN is the one owed — on a queue
                customer there is no debt to announce, and saying so there would be
                a lie. Opened by hand = must be settled (no answer / cancel /
                confirm / …). Server-backed, so a refresh brings them back. */}
            {!obligationExempt && obligation
              && normalizePhoneKey(obligation.customer_phone) === normalizePhoneKey(selectedPhone || '') && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                {t('callsPage.mustAnswerBanner')}
              </div>
            )}
            <ClientProfileCard
              phone={selectedPhone}
              onOpenOrder={openOrderById}
              onClaimedToPersonalList={handleClaimedToPersonalList}
              onCustomerUpdated={handleCustomerUpdated}
              callAction={dialButton}
              toolbar={actionBar}
              avgPackagePrice={currentAvgPackagePrice}
              showScripts
            />
          </div>
        )}
      </div>

      <UndoBar pending={deferred.pending} onUndo={deferred.undo} />

      <OrderModal
        open={!!orderModalData}
        onClose={(saved?: boolean) => {
          setOrderModalData(null);
          // OrderModal has no queryClient of its own — it only reports `saved`.
          // Dropping that flag here left the dossier, the queue and the badge
          // showing pre-edit data after resolving an order from this page, which
          // is exactly how an agent concludes "it didn't save" and does it
          // again. Same pattern as Orders.tsx.
          if (!saved) return;
          qc.invalidateQueries({ queryKey: ['calls-page-orders', selectedPhone] });
          qc.invalidateQueries({ queryKey: ['customer-history', selectedPhone] });
          qc.invalidateQueries({ queryKey: ['customer-intelligence', selectedPhone] });
          qc.invalidateQueries({ queryKey: ['calls-page-pendings', user?.id] });
          qc.invalidateQueries({ queryKey: ['my-pendings-summary', user?.id] });
          refreshObligation();
        }}
        data={orderModalData}
        contextType="order"
      />

      <CreateOrderModal
        open={createOrderProps.open}
        onClose={handleCreateOrderClosed}
        prefillPhone={createOrderProps.phone}
        prefillName={createOrderProps.name}
        defaultStatus="confirmed"
        hideStatusPicker
        existingOrderId={createOrderProps.existingOrderId}
        title={createOrderProps.existingOrderId
          ? t('callsPage.completeOrderTitle', { phone: createOrderProps.phone || '' })
          : t('callsPage.confirmOrderTitle', { phone: createOrderProps.phone || '' })}
      />

      {/* Which order? Only ever shown when the customer really has more than one
          open order (a pending lead AND a duplicate). Before this the flow silently
          took the queue row, so an agent editing "the duplicate" confirmed the
          ORIGINAL without ever seeing it (BG, 2026-08-12). */}
      <Dialog
        open={!!orderChoice}
        onOpenChange={(o) => { if (!o) { orderChoice?.resolve(null); setOrderChoice(null); } }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('callsPage.whichOrderTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{t('callsPage.whichOrderDesc')}</p>
          <div className="flex flex-col gap-2 py-2">
            {(orderChoice?.leads || []).map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => { orderChoice?.resolve(l.id); setOrderChoice(null); }}
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left hover:bg-accent"
              >
                <span className="min-w-0">
                  <span className="font-mono text-sm font-semibold">{l.display_id}</span>
                  {l.duplicated_from_display && (
                    <span className="ml-2 rounded border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300">
                      {t('ordersPage.duplicateOf', { id: l.duplicated_from_display })}
                    </span>
                  )}
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {t(`status.${l.status}`)}
                    {l.assigned_agent_name ? ` · ${l.assigned_agent_name}` : ''}
                  </span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => { orderChoice?.resolve(null); setOrderChoice(null); }}
            >
              {t('common.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
