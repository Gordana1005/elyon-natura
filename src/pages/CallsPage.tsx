import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, PhoneOutgoing, ArrowRight, Layers } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { AppLayout } from '@/layouts/AppLayout';
import { ChooseAnswerButton } from '@/components/calls/ChooseAnswerButton';
import { PromoOfTheDayBanner, PROMO_QUERY_KEY } from '@/components/calls/PromoOfTheDayBanner';
import { ClientProfileCard } from '@/components/calls/ClientProfileCard';
import { useMyQueue, useQueueMutations, PENDINGS_QUEUE_ID, type QueueMember, type QueueListSummary } from '@/components/calls/useMyQueue';
import { getCallSession, setCallSession, type CallSessionSnapshot } from '@/components/calls/callSession';
import { OrderModal, OrderModalData } from '@/components/OrderModal';
import { CreateOrderModal } from '@/components/CreateOrderModal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiGetOrder, apiGetOrders, apiCreateOrder, apiUpdateOrderStatus, apiReleaseActiveView, apiLookupPersonalHold, apiReleasePersonalHold, apiLogCall, apiGetMyPendingsSummary, apiGetOpenLead, apiGetMyCallObligation, apiRegisterCallObligation, type CancellationReason, type TrashReason, type OpenLead } from '@/lib/api';
import { cancelReasonLabel } from '@/lib/cancellationReasons';
import { useTranslation } from 'react-i18next';
import { useVoip, type LinkedContext } from '@/contexts/VoipContext';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { useActiveCallView } from '@/hooks/useActiveCallView';
import { hoverLift } from '@/lib/design-utils';
import { EmptyState } from '@/components/EmptyState';

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
    refetchInterval: 15_000,
  });

  // Counts behind the virtual "Pendings" queue entry (left / talked today).
  const { data: pendingsSummary } = useQuery({
    queryKey: ['my-pendings-summary', user?.id],
    queryFn: apiGetMyPendingsSummary,
    enabled: !!user?.id,
    refetchInterval: 30_000,
  });

  // Queue order, and this is where the paced retry now lives:
  //   1. fresh leads (pending / take) — warm, always first
  //   2. call agains whose retry time has passed — due now
  //   3. call agains still parked — visible, but last, so an agent only reaches
  //      them once the real work is done rather than ringing a customer twice
  //      in an hour. Within each band: parked by soonest due, others newest first.
  const LEAD_ORDER: Record<string, number> = { pending: 0, take: 1, call_again: 2 };
  const isParked = (o: any) => !!o.next_call_after && new Date(o.next_call_after).getTime() > Date.now();
  const pendingOrders = useMemo(() => {
    const raw = (pendingData as any)?.orders || [];
    return [...raw].sort((a, b) => {
      const parked = Number(isParked(a)) - Number(isParked(b));
      if (parked !== 0) return parked;
      const rank = (LEAD_ORDER[a.status] ?? 9) - (LEAD_ORDER[b.status] ?? 9);
      if (rank !== 0) return rank;
      if (isParked(a) && isParked(b)) {
        return new Date(a.next_call_after).getTime() - new Date(b.next_call_after).getTime();
      }
      const aTime = new Date(a.assigned_at || a.created_at || 0).getTime();
      const bTime = new Date(b.assigned_at || b.created_at || 0).getTime();
      return bTime - aTime;
    });
  }, [pendingData]);

  const pickNextPending = useCallback((excludeId?: string | null) => {
    if (!pendingOrders.length) return null;
    return pendingOrders.find((o: any) => o.id !== excludeId) || null;
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
    // Strip the param so a manual refresh doesn't reopen the same customer.
    const next = new URLSearchParams(searchParams);
    next.delete('phone');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

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
    if (state !== 'idle') return;
    if (!(await guardDialObligation(next))) return;
    setSelectedPhone(next);
    queueCurrentPhone.current = null; // detach from queue lock
    setCurrentSource('manual');
    setCurrentPendingOrderId(null);
    setManualPhoneDraft('');
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
      if (outcome === 'cancelled') {
        void handleAnswerCancelled(cancellation_reason || 'other', cancellation_reason_notes || '');
        clearLastFinished();
        return;
      }
      if (outcome === 'trash') {
        // In-call bar has only free text (no structured key); store it as the note.
        void handleAnswerTrashed(undefined, (reason_text || '').replace(/^Reason:\s*/, ''));
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
  const [orderChoice, setOrderChoice] = useState<
    { leads: OpenLead[]; intent: 'confirm' | 'cancel' | 'trash'; resolve: (id: string | null) => void } | null
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

  // Refreshing or re-logging in must not shake off the debt: with nothing on
  // screen yet, the owed client is restored before the queue picks anyone.
  useEffect(() => {
    if (obligationExempt || !obligation) return;
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

  // Most recent REAL product this customer ordered — used as the product on
  // cancel/trash records (never a placeholder / first-in-catalogue default).
  // Skips the '—' rows that cancel/trash records themselves create.
  const lastRealProduct = (orders: any[]): { name: string; productId: string | null } => {
    for (const o of orders || []) {
      const items = o.order_items || [];
      if (items.length > 0) {
        const named = items.filter((i: any) => i.product_name);
        if (named.length > 0) {
          return { name: named.map((i: any) => i.product_name).join(', '), productId: named.length === 1 ? (named[0].product_id ?? null) : null };
        }
      }
      if (o.product_name && o.product_name !== '—') return { name: o.product_name, productId: o.product_id ?? null };
    }
    return { name: '', productId: null };
  };

  // Human labels for the cancellation reasons (used when creating synthetic records
  // so the expanded view on /orders shows nice full text instead of just the key).
  // Shared source of truth — see @/lib/cancellationReasons.

  // ── Choose Answer outcomes ──
  // Shared tail: refresh dossier, mark the queue member, advance to next.
  const finishOutcome = useCallback(async (phone: string, queueOutcome: string, retryMs?: number) => {
    // Extra-reliable release of the active view for this phone before we move on.
    // Complements the hook's release on phone change / unmount.
    try { await apiReleaseActiveView(phone); } catch { /* best effort */ }

    qc.invalidateQueries({ queryKey: ['calls-page-orders', phone] });
    qc.invalidateQueries({ queryKey: ['customer-history', phone] });
    qc.invalidateQueries({ queryKey: ['customer-intelligence', phone] });
    refreshObligation();
    if (currentSource === 'prediction' && activeListId && phone === queueCurrentPhone.current) {
      void markAfterCall(activeListId, phone, queueOutcome, retryMs ? { retryMs } : undefined);
    }
    setPendingAdvance(null);
    advanceQueue(phone);
  }, [qc, currentSource, activeListId, markAfterCall, advanceQueue, refreshObligation]);

  // Confirmed → open the order modal (status forced confirmed there).
  // A customer with an actionable pending order (a lead) gets the SAME modal,
  // but in complete-existing mode: it fills and confirms that order in place.
  // The old direct status flip here produced "empty" confirmed orders — the
  // sparse webhook row went straight to confirmed with no products/address.
  const handleAnswerConfirmed = useCallback(async () => {
    if (!phoneReady) return;
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
  }, [phoneReady, selectedPhone, currentPendingOrderId, activePendingOrder, chooseOpenOrder]);

  // Fetch this customer's recent orders fresh so the recorded name + product
  // always match the customer on screen (not a lagging memo). Returns the
  // best name + their most recent real product.
  const resolveCustomerForRecord = useCallback(async (phone: string) => {
    let recent: any[] = ordersData?.orders || [];
    try {
      const data: any = await apiGetOrders({ search: phone, limit: 5 });
      if (data?.orders?.length) recent = data.orders;
    } catch { /* fall back to cached */ }
    const name = recent[0]?.customer_name || currentCustomerName || undefined;
    const product = lastRealProduct(recent);
    return { name, product };
  }, [ordersData, currentCustomerName]);

  // Cancel → record a cancelled order (reason + note + the customer's past
  // product) so it shows in the customer's dossier, then advance.
  const handleAnswerCancelled = useCallback(async (reason: CancellationReason, notes: string) => {
    const phone = selectedPhone;
    // Server-backed lookup, not just the local queue: a lead handed over by a
    // manager is invisible to this agent's RLS view, and without this the cancel
    // landed on a brand-new synthetic row while the real lead stayed open
    // forever (the orphaned-outcome bug).
    const chosen = await chooseOpenOrder(phone, 'cancel');
    const pendingId = chosen ?? currentPendingOrderId ?? activePendingOrder?.id ?? null;
    if (pendingId) {
      try {
        await apiUpdateOrderStatus(pendingId, 'cancelled', {
          cancellation_reason: reason,
          cancellation_reason_notes: notes || undefined,
        });
        toast({ title: t('callsPage.cancellationRecorded'), description: t('callsPage.savedToOrder') });
        qc.invalidateQueries({ queryKey: ['calls-page-pendings', user?.id] });
      qc.invalidateQueries({ queryKey: ['my-pendings-summary', user?.id] });
        qc.invalidateQueries({ queryKey: ['calls-page-orders', phone] });
        qc.invalidateQueries({ queryKey: ['customer-history', phone] });
        qc.invalidateQueries({ queryKey: ['customer-intelligence', phone] });
        refreshObligation();
        try { await apiReleaseActiveView(phone); } catch { /* best effort */ }
        setPendingAdvance(null);
        advanceQueue(phone);
        return;
      } catch (err: any) {
        toast({ title: t('callsPage.cancellationFailed'), description: err?.message, variant: 'destructive' });
        return;
      }
    }

    try {
      const { name, product } = await resolveCustomerForRecord(phone);
      const priorName = product.name || '';
      const reasonLabel = cancelReasonLabel(reason);
      const fullReasonText = notes ? `${reasonLabel}\n\n${notes}` : reasonLabel;

      await apiCreateOrder({
        product_id: product.productId,
        product_name: priorName || 'No prior product on file',
        customer_name: name,
        customer_phone: phone,
        status: 'cancelled',
        cancellation_reason: reason,
        cancellation_reason_notes: fullReasonText,
        notes: priorName ? `Prior product: ${priorName}` : undefined,
      });
      toast({ title: t('callsPage.cancellationRecorded'), description: t('callsPage.savedToHistory') });
      finishOutcome(phone, 'cancelled');
    } catch (err: any) {
      toast({ title: t('callsPage.cancellationFailed'), description: err?.message, variant: 'destructive' });
    }
  }, [selectedPhone, currentPendingOrderId, activePendingOrder, chooseOpenOrder, resolveCustomerForRecord, toast, finishOutcome, qc, user?.id, advanceQueue]);

  // Trash → record a trashed order with a STRUCTURED reason (orders.trash_reason)
  // + optional free-text note. Works for both a live pending order and the
  // synthetic no-order case. reasonKey is undefined for the in-call bar path
  // (free text only); a manager's deliberate reason still lands in the column.
  const handleAnswerTrashed = useCallback(async (reasonKey?: TrashReason, notes?: string) => {
    const phone = selectedPhone;
    const trashReason = reasonKey;
    const trashNotes = (notes || '').trim() || undefined;
    // Same server-backed lookup as Cancel — trash the lead that exists, never a
    // synthetic row beside it.
    const chosen = await chooseOpenOrder(phone, 'trash');
    const pendingId = chosen ?? currentPendingOrderId ?? activePendingOrder?.id ?? null;
    if (pendingId) {
      try {
        await apiUpdateOrderStatus(pendingId, 'trashed', {
          trash_reason: trashReason,
          trash_reason_notes: trashNotes,
        });
        toast({ title: t('callsPage.markedTrash'), description: t('callsPage.savedToOrder') });
        qc.invalidateQueries({ queryKey: ['calls-page-pendings', user?.id] });
      qc.invalidateQueries({ queryKey: ['my-pendings-summary', user?.id] });
        qc.invalidateQueries({ queryKey: ['calls-page-orders', phone] });
        qc.invalidateQueries({ queryKey: ['customer-history', phone] });
        qc.invalidateQueries({ queryKey: ['customer-intelligence', phone] });
        refreshObligation();
        setPendingAdvance(null);
        advanceQueue(phone);
        return;
      } catch (err: any) {
        toast({ title: t('callsPage.recordFailed'), description: err?.message, variant: 'destructive' });
        return;
      }
    }

    try {
      const { name, product } = await resolveCustomerForRecord(phone);
      const priorName = product.name || '';
      await apiCreateOrder({
        product_id: product.productId,
        product_name: priorName || 'No prior product on file',
        customer_name: name,
        customer_phone: phone,
        status: 'trashed',
        trash_reason: trashReason,
        trash_reason_notes: trashNotes,
        notes: priorName ? `Prior product: ${priorName}` : undefined,
      });
      toast({ title: t('callsPage.markedTrash'), description: t('callsPage.savedToHistory') });
      finishOutcome(phone, 'trash');
    } catch (err: any) {
      toast({ title: t('callsPage.recordFailed'), description: err?.message, variant: 'destructive' });
    }
  }, [selectedPhone, currentPendingOrderId, activePendingOrder, chooseOpenOrder, resolveCustomerForRecord, toast, finishOutcome, qc, user?.id, advanceQueue]);

  // Didn't Answer → log a no-answer call and let the server own the lifecycle:
  // it parks the customer ~1 day (prediction member hold + pending-order
  // cooldown) so they sit in Call Again and resurface tomorrow, and after 5
  // consecutive no-answers it auto-trashes them as "not reachable". We do NOT
  // create stub orders here anymore (that produced duplicate Takes/Call-Agains
  // and polluted conversion insights).
  const handleAnswerDidntAnswer = useCallback(async () => {
    const phone = selectedPhone;
    try {
      await apiLogCall({
        context_type: 'standalone',
        context_id: null,
        outcome: 'no_answer',
        connection_state: 'no_answer',
        customer_phone: phone,
      });
      toast({ title: t('callsPage.movedToCallAgain'), description: t('callsPage.noAnswerResurface') });
      try { await apiReleaseActiveView(phone); } catch { /* best effort */ }
      qc.invalidateQueries({ queryKey: ['calls-page-pendings', user?.id] });
      qc.invalidateQueries({ queryKey: ['my-pendings-summary', user?.id] });
      qc.invalidateQueries({ queryKey: ['calls-page-orders', phone] });
      qc.invalidateQueries({ queryKey: ['customer-history', phone] });
      qc.invalidateQueries({ queryKey: ['customer-intelligence', phone] });
      qc.invalidateQueries({ queryKey: ['my-queue-summary'] });
      qc.invalidateQueries({ queryKey: ['my-queue-members'] });
      refreshObligation();
      setPendingAdvance(null);
      advanceQueue(phone);
    } catch (err: any) {
      toast({ title: t('callsPage.noAnswerFailed'), description: err?.message, variant: 'destructive' });
    }
  }, [selectedPhone, toast, qc, user?.id, advanceQueue, refreshObligation]);

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

    if (activeListId && phone === queueCurrentPhone.current) {
      void markAfterCall(activeListId, phone, queueOutcome);
    }
    // Clear any pending "Next customer" banner from a prior call end and jump.
    setPendingAdvance(null);
    advanceQueue(phone);
  }, [createOrderProps.phone, createOrderProps.isManual, createOrderProps.existingOrderId, selectedPhone, activeListId, markAfterCall, advanceQueue, qc, user?.id, refreshObligation]);

  // Topbar controls (next to the "Calls" title): the manual dial input and the
  // queue picker. The queue shows for ANYONE with assigned lists — agents
  // included — so they know which list they're working.
  const headerControls = (
    <div className="flex items-center gap-1.5">
      {isMobile ? (
        <>
          {/* Mobile: a single phone icon that opens a dial dialog (keeps the topbar uncluttered). */}
          <Button
            size="icon"
            variant="outline"
            className="h-8 w-8 shrink-0"
            onClick={() => setDialOpen(true)}
            aria-label={t('callsPage.dialANumber')}
          >
            <PhoneOutgoing className="h-4 w-4" />
          </Button>
          <Dialog open={dialOpen} onOpenChange={setDialOpen}>
            <DialogContent className="max-w-xs">
              <DialogHeader><DialogTitle>{t('callsPage.dialANumber')}</DialogTitle></DialogHeader>
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
                  disabled={state !== 'idle' || !manualPhoneDraft.trim()}
                  className="w-full gap-1.5"
                >
                  <PhoneOutgoing className="h-4 w-4" /> {t('callsPage.call')}
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
                        <span className="truncate">{q.list_name}</span>
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
            placeholder={t('callsPage.dialNewNumber')}
            className="h-6 text-xs font-mono border-0 shadow-none focus-visible:ring-0 px-1 bg-transparent w-36"
          />
          <Button
            size="sm"
            onClick={() => { void submitManualPhone(); }}
            disabled={state !== 'idle' || !manualPhoneDraft.trim()}
            variant="outline"
            className="h-6 gap-1 text-[10px] px-1.5"
          >
            <PhoneOutgoing className="h-2.5 w-2.5" />
            {t('callsPage.call')}
          </Button>
        </div>
      )}

      {allQueues.length > 0 && !isMobile && (
        <div
          className={`inline-flex items-center gap-1.5 rounded-xl border bg-background px-2 py-0.5 ${hoverLift} ${
            pendingsWaiting > 0 ? 'border-amber-400 ring-1 ring-amber-300/60' : ''
          }`}
          title={pendingsWaiting > 0 ? t('callsPage.pendingsWaiting', { count: pendingsWaiting }) : t('callsPage.queueLabel')}
        >
          <Layers className={`h-3 w-3 shrink-0 ${pendingsWaiting > 0 ? 'text-amber-500' : 'text-muted-foreground'}`} />
          <Select value={activeListId || ''} onValueChange={switchToList}>
            <SelectTrigger className="h-6 text-xs min-w-[140px] border-0 shadow-none focus:ring-0">
              <SelectValue placeholder={t('callsPage.listsCount', { count: allQueues.length })} />
            </SelectTrigger>
            <SelectContent>
              {allQueues.map(q => (
                <SelectItem key={q.list_id} value={q.list_id}>
                  {/* Pendings read "left (N talked)" — leads have no fixed list
                      size, so "talked today" is the meaningful second number. */}
                  {q.is_pendings
                    ? `${q.list_name} — ${t('callsPage.queueCountPendings', { left: q.remaining, talked: q.talked ?? 0 })}`
                    : `${q.list_name} — ${q.remaining} (${q.total})`}
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

  // Green dial button — in the customer strip next to "Add to Personal List".
  // Only while idle; during a call the SidebarCallIndicator shows the live call,
  // and the line resets to idle the instant it ends so this reappears at once.
  const dialButton = phoneReady && state === 'idle' ? (
    <Button
      size="sm"
      onClick={() => { void handleDial(); }}
    >
      <Phone className="h-3.5 w-3.5" /> {t('callsPage.dialBtn', { phone: selectedPhone })}
    </Button>
  ) : null;

  // Calling controls below the customer strip: the active call widget and the
  // Choose Answer button on ONE centered row — the widget sits left and the
  // button shifts right as the widget expands (Answered / Not Answered), never
  // stacking. The queue moved to the topbar; the green dial into the strip.
  const actionBar = (
    <div className="space-y-3">
      {/* Three columns on desktop: an empty spacer, the button dead-centre, and
          the promo strip filling the free space on the right — so the promo
          costs horizontal room, not vertical (the History cards never move
          down). Below lg it collapses to a centred stack. */}
      <div className="flex flex-col items-center gap-3 lg:grid lg:grid-cols-[1fr_auto_1fr] lg:items-center">
        {/* The active-call strip is now a global floating element pinned
            top-left (mounted once in App.tsx) — no longer rendered inline. */}
        {phoneReady && (
          <ChooseAnswerButton
            onConfirmed={handleAnswerConfirmed}
            onCancelled={handleAnswerCancelled}
            onTrashed={handleAnswerTrashed}
            onDidntAnswer={handleAnswerDidntAnswer}
            className="h-9 min-w-[180px] shrink-0 justify-center text-sm mt-1 lg:col-start-2 lg:justify-self-center !bg-transparent border border-orange-500 text-orange-600 hover:!bg-orange-50 hover:border-orange-600 hover:text-orange-700 dark:hover:!bg-orange-500/10 dark:hover:text-orange-300 transition-all duration-200 ease-out hover:-translate-y-[1px] hover:shadow-sm"
          />
        )}
        {/* Product of the Day — a one-line strip in the right column on desktop,
            a full-width card under the button on mobile (the component picks).
            Explicit col-start so it stays right even when the button is absent
            (empty queue). Renders nothing when no promo is running. */}
        <PromoOfTheDayBanner className="lg:col-start-3 lg:mt-1 lg:justify-self-stretch" />
      </div>

      {pendingAdvance && pendingAdvance.phone === selectedPhone && (
        <div className={`rounded-xl border border-[hsl(var(--success))]/30 bg-[hsl(var(--success))]/5 px-4 py-3 flex items-center gap-4 text-sm ${hoverLift}`}>
          <div className="flex-1">
            {t('callsPage.markedAs')} <strong>{t(`outcome.${pendingAdvance.outcome}`, { defaultValue: pendingAdvance.outcome.replace(/_/g, ' ') })}</strong>{t('callsPage.stayHint')}
          </div>
          <Button size="sm" onClick={handleNextCustomer} className="gap-1.5 shrink-0">
            {t('callsPage.nextCustomer')} <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

    </div>
  );

  return (
    <AppLayout title="" headerActions={headerControls}>
      <div className="space-y-5">
        {!phoneReady ? (
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
