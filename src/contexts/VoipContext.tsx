import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { apiErrorText } from '@/i18n/apiErrors';
import i18n from '@/i18n';
import { useAuth } from '@/contexts/AuthContext';
import { apiLogCall, apiGetVoipCredentials, apiPresenceHeartbeat, type CancellationReason, type ConnectionState } from '@/lib/api';
import { setBusCallState } from '@/lib/voip/callStateBus';
import { useToast } from '@/hooks/use-toast';
import type { CallOutcome } from '@/components/OrderModal';
import { PBX_CONFIG } from '@/lib/voip/pbxConfig';
import { RealVoipEngine } from '@/lib/voip/RealVoipEngine';

export interface EndCallExtras {
  /** Free-text reason from the picker (legacy — appended to notes). */
  reason?: string;
  /** Structured cancel reason — required when outcome === 'cancelled'. */
  cancellation_reason?: CancellationReason;
  /** Free-text notes attached to the cancel/return — written to the order. */
  cancellation_reason_notes?: string;
}

// Mock VOIP engine. Behind this façade a real WebRTC/SIP client lands once
// A1 Phase 0 unlocks Path I/II/III. The interface is the swap contract.

// 'wrapping' = audio is hung up but the agent is still picking an outcome.
// The duration tick is stopped, ended_at is snapshotted; only the picker UI
// remains. This is the state the End button puts us into, so the seconds
// don't keep counting while the agent decides Answered/Not Answered/etc.
export type CallState = 'idle' | 'dialing' | 'in_call' | 'wrapping' | 'ending';

export interface LinkedContext {
  type: 'order' | 'prediction_lead';
  id: string;
  display_id?: string;
}

export interface ActiveCall {
  id: string;
  phone: string;
  agent_id: string;
  /** Backwards-compat: epoch ms of the moment used to drive the duration tick.
   *  Set to dial press at first; replaced with connect time when answered. */
  started_at: number;
  duration_sec: number;
  notes: string;
  linked_context: LinkedContext | null;
  /** Telemetry: every dial logs these so call_logs.ring/talk/total durations
   *  are real, not synthesised. NULL connected_at = the call never connected. */
  dial_started_at: number;
  connected_at: number | null;
  /** Snapshotted the instant the agent presses End (= SIP BYE in real WebRTC).
   *  Null while the call is live; frozen once we're in 'wrapping'. The picker
   *  outcome that comes next logs this exact moment as call_logs.ended_at, so
   *  ring/talk/total durations stay accurate regardless of how long the agent
   *  spends choosing an outcome afterwards. */
  ended_at: number | null;
  /** The caller-ID actually presented for this call (what the customer sees). */
  caller_id?: string;
}

/** Set briefly after a call ends so consumers (e.g. the queue auto-progress
 *  on the Calls page) can react. Cleared by the consumer via clearLastFinished. */
export interface LastFinishedCall {
  phone: string;
  outcome: CallOutcome;
  /** True when the call ended via Confirm (auto-outcome 'interested'). */
  via_confirm: boolean;
  finished_at: number;
  /** Carried so the Calls page can create the right status record for a
   *  prediction/personal-list customer who has no order to mutate. */
  cancellation_reason?: CancellationReason;
  cancellation_reason_notes?: string;
  reason_text?: string;
}

interface VoipContextValue {
  state: CallState;
  call: ActiveCall | null;
  /** This agent's caller-IDs: primary = main Call button (.100); secondary =
   *  topbar "dial new number". Null until creds load / in mock mode. */
  callerIds: { primary: string; secondary: string | null } | null;
  startCall: (phone: string, linkedContext?: LinkedContext | null, callerId?: string) => void;
  /** Hangs up immediately (stops the duration tick, snapshots ended_at) and
   *  transitions to 'wrapping'. The agent then picks an outcome via the
   *  picker, which calls endCall/endCallWithReason to actually log the call. */
  hangup: () => void;
  endCall: (outcome: CallOutcome) => Promise<void>;
  endCallWithReason: (outcome: CallOutcome, extras?: EndCallExtras | string) => Promise<void>;
  confirmCall: () => void;
  cancelCall: () => void;
  /** Close out the active/wrapping call when the agent reserves the customer to
   *  their Personal List (logs it as 'interested' + resets to idle). */
  endCallForClaim: () => Promise<void>;
  /** Close out a call that was confirmed via the in-call Confirm button (which
   *  opens the order modal WITHOUT ending the call). Called after the order is
   *  submitted so the strip clears and the next customer is dial-able. Logs the
   *  call as 'interested' (audit + recording, no order-status side-effect — the
   *  modal already created the confirmed order). No-op if already idle. */
  endConfirmedCall: () => Promise<void>;
  setNotes: (notes: string) => void;
  /** Microphone mute state for the current call + a toggle. Resets to false
   *  whenever a call ends. In mock mode it only flips the flag (no audio). */
  isMuted: boolean;
  toggleMute: () => void;
  pendingConfirm: { phone: string; linkedContext: LinkedContext | null } | null;
  clearPendingConfirm: () => void;
  lastFinished: LastFinishedCall | null;
  clearLastFinished: () => void;
}

const VoipContext = createContext<VoipContextValue | undefined>(undefined);

const MOCK_ANSWER_DELAY_MS = 800;

function generateLocalId(): string {
  return `local_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function VoipProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [state, setState] = useState<CallState>('idle');
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<VoipContextValue['pendingConfirm']>(null);
  const [lastFinished, setLastFinished] = useState<LastFinishedCall | null>(null);
  const [callerIds, setCallerIds] = useState<{ primary: string; secondary: string | null } | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const answerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guards the auto-no_answer effect so a never-connected call is finalized once.
  const autoNoAnswerRef = useRef(false);

  // Report softphone state to the server (profiles.voip_state) so managers see
  // a live "In call" status on the Assigner/Ops-Center agent cards. The bus is
  // read by AuthContext's 45s presence beat to keep long calls fresh. The
  // initial-mount skip is load-bearing: a SECOND CRM tab opened during a live
  // call must not report 'idle' and clobber the calling tab's state — 'idle'
  // is only ever written by the tab that actually ends a call.
  const voipStateReportedRef = useRef(false);
  useEffect(() => {
    setBusCallState(state);
    if (!voipStateReportedRef.current) {
      voipStateReportedRef.current = true;
      return;
    }
    void apiPresenceHeartbeat({ voip_state: state }).catch(() => {});
  }, [state]);

  // === Real WebRTC Engine (A1 Phase 0) ===
  // When PBX_CONFIG.useRealVoip is true, we use the real SIP.js engine.
  // The interface stays the same so the entire UI (CallsPage, ActiveCallWidget, etc.) is unaffected.
  const realEngineRef = useRef<RealVoipEngine | null>(null);

  // Create the engine once (moved into useEffect below for proper lifecycle)
  if (PBX_CONFIG.useRealVoip && !realEngineRef.current) {
    realEngineRef.current = new RealVoipEngine();
  }

  // Wire callbacks (safe to do on every render until the engine exists)
  if (realEngineRef.current) {
    realEngineRef.current.onStateChange = (newState) => setState(newState as CallState);
    realEngineRef.current.onCallChange = (newCall) => setCall(newCall as ActiveCall | null);

    // New callbacks for better visibility (registration + errors)
    realEngineRef.current.onRegistrationChange = (registered, error) => {
      console.log('[VoipContext] Registration change:', { registered, error });
      if (!registered && error) {
        // Light toast for registration problems (non-blocking)
        // toast({ title: 'PBX Connection', description: error, variant: 'destructive' });
      }
    };

    realEngineRef.current.onError = (error, context) => {
      console.error(`[VoipContext] RealVoipEngine error (${context}):`, error);
      // Map call-result SIP rejections to accurate, translated toasts. 486/480 are
      // the CALLEE's phone (busy / switched off) — NOT a shortage of our lines, so
      // they get a calm info toast, never "all lines busy". 503/600 = real congestion.
      const toasts: Record<string, { title: string; description: string; variant?: 'default' | 'destructive' }> = {
        'congestion':         { title: i18n.t('voip.allLinesBusy'),      description: i18n.t('voip.allLinesBusyDesc'),      variant: 'destructive' },
        'callee-busy':        { title: i18n.t('voip.numberBusy'),        description: i18n.t('voip.numberBusyDesc') },
        'callee-unavailable': { title: i18n.t('voip.numberUnavailable'), description: i18n.t('voip.numberUnavailableDesc') },
        'call-rejected':      { title: i18n.t('voip.callFailed'),        description: apiErrorText(error), variant: 'destructive' },
      };
      const t = toasts[context];
      if (t) toast({ title: t.title, description: t.description, variant: t.variant });
    };
  }

  const clearTimers = () => {
    if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
    if (answerTimeoutRef.current) {
      clearTimeout(answerTimeoutRef.current);
      answerTimeoutRef.current = null;
    }
  };

  useEffect(() => () => {
    clearTimers();
    // Clean up the real engine on unmount / logout
    if (PBX_CONFIG.useRealVoip && realEngineRef.current) {
      realEngineRef.current.dispose?.().catch(() => {});
    }
  }, []);

  // Proactive registration for real mode: fetch THIS agent's own SIP credentials
  // (extension + secret) from the backend, inject them, then register. No shared
  // secret is bundled; each logged-in agent registers as their own extension.
  useEffect(() => {
    // External affiliates have no extension and would 403 on the hard wall —
    // skip the credential fetch so their console stays clean.
    if (!PBX_CONFIG.useRealVoip || !realEngineRef.current || !user || user.isExternalAffiliate) return;
    let cancelled = false;
    (async () => {
      try {
        const c = await apiGetVoipCredentials();
        if (cancelled || !realEngineRef.current) return;
        realEngineRef.current.configure({
          extension: c.extension,
          secret: c.secret,
          wsUrl: c.ws_url,
          primaryCallerId: c.primary_caller_id,
          secondaryCallerId: c.secondary_caller_id,
        });
        setCallerIds({ primary: c.primary_caller_id, secondary: c.secondary_caller_id });
        await realEngineRef.current.ensureRegistered();
        console.log('[VoipContext] Registered as extension', c.extension);
      } catch (err) {
        console.error('[VoipContext] VoIP credentials/registration failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [user]); // re-run on login change

  const startCall = useCallback((phone: string, linkedContext: LinkedContext | null = null, callerId?: string) => {
    if (!user || state !== 'idle') return;

    // === Real WebRTC path (A1) ===
    if (PBX_CONFIG.useRealVoip && realEngineRef.current) {
      realEngineRef.current.startCall(phone, linkedContext, callerId).catch((err) => {
        console.error('[VoipContext] Real call failed to start:', err);
        toast({ title: i18n.t('voip.callFailedToStart'), description: String(err), variant: 'destructive' });
      });
      return;
    }

    // === Mock path (default during development) ===
    clearTimers();

    const dialMs = Date.now();
    const newCall: ActiveCall = {
      id: generateLocalId(),
      phone,
      agent_id: user.id,
      started_at: dialMs,
      duration_sec: 0,
      notes: '',
      linked_context: linkedContext,
      dial_started_at: dialMs,
      connected_at: null,
      ended_at: null,
      caller_id: callerId || callerIds?.primary || '+35924234100',
    };
    setCall(newCall);
    setState('dialing');

    // Mock answer after a short delay, then start ticking duration.
    answerTimeoutRef.current = setTimeout(() => {
      const connectMs = Date.now();
      setState('in_call');
      setCall(prev => prev ? {
        ...prev,
        started_at: connectMs,
        connected_at: connectMs,
      } : prev);
      tickIntervalRef.current = setInterval(() => {
        setCall(prev => prev ? { ...prev, duration_sec: prev.duration_sec + 1 } : prev);
      }, 1000);
    }, MOCK_ANSWER_DELAY_MS);
  }, [user, state, toast]);

  /**
   * End the audio leg immediately and freeze the duration counter. The agent
   * stays in the picker (state='wrapping') to choose Answered/Not Answered/
   * Confirmed/Cancelled etc. — finalize() runs only when they pick. Logged
   * call duration uses ended_at (this snapshot), not the moment the agent
   * eventually clicked an outcome, so post-call paperwork time doesn't
   * inflate call_logs.duration_seconds.
   */
  const hangup = useCallback(() => {
    // === Real WebRTC path ===
    if (PBX_CONFIG.useRealVoip && realEngineRef.current) {
      realEngineRef.current.hangup();
      return;
    }

    // === Mock path ===
    if (state !== 'in_call' && state !== 'dialing') return;
    clearTimers();
    setCall(prev => prev ? { ...prev, ended_at: Date.now() } : prev);
    setState('wrapping');
  }, [state]);

  const finalize = useCallback(async (
    outcome: CallOutcome,
    opts?: {
      silent?: boolean;
      viaConfirm?: boolean;
      cancellation_reason?: CancellationReason;
      cancellation_reason_notes?: string;
      extraNote?: string;
      /** Skip the lastFinished queue signal — used by the Personal-List claim
       *  path, which drives its own queue advance and must not also trigger the
       *  normal "Next customer" pendingAdvance. */
      skipQueueSignal?: boolean;
    },
  ) => {
    clearTimers();
    setState('ending');
    const ending = call;
    if (ending) {
      // Prefer the snapshotted ended_at (set by hangup() the moment the agent
      // pressed End). Falls back to "now" only for paths that finalize without
      // a prior hangup (cancelCall during dialing).
      const endedMs = ending.ended_at ?? Date.now();
      // Real WebRTC sets connected_at on SIP session establishment, so there it is
      // genuine proof the customer picked up.
      //
      // The MOCK path (MK until the A1 trunk lands) stamps connected_at 800ms after
      // the dial NO MATTER WHAT — nothing actually rang. Trusting it would mark
      // every single call 'answered', so the answered-rate would read 100% forever
      // and a real no-answer would be recorded as a conversation. While VOIP is off
      // the agent's own outcome pick is the only honest signal, so it decides.
      //
      // We also don't pretend to know ring time: connected_at collapses to the dial
      // instant, making ring_seconds 0 and talk_seconds == total_seconds. Those three
      // columns are GENERATED ALWAYS in Postgres, so this is the only place to get
      // it right. Interim numbers therefore mean "the agent was on this client for
      // N seconds and says it was answered" — agent-reported handling time, not
      // carrier-verified talk time.
      const answeredForReal = PBX_CONFIG.useRealVoip
        ? !!ending.connected_at
        : outcome !== 'no_answer';
      const connectedMs = PBX_CONFIG.useRealVoip
        ? ending.connected_at
        : (answeredForReal ? ending.dial_started_at : null);
      const connection_state: ConnectionState =
        answeredForReal ? 'answered' : (outcome === 'no_answer' ? 'no_answer' : 'failed');
      const composedNotes = [ending.notes.trim(), opts?.extraNote?.trim()]
        .filter(Boolean).join('\n');
      const linked = ending.linked_context;
      try {
        const res: any = await apiLogCall({
          // Linked calls drive order/lead status server-side; standalone calls
          // (e.g. a brand-new number dialed from the topbar) are still logged
          // so every call has an audit trail + a recording.
          context_type: linked ? linked.type : 'standalone',
          context_id: linked ? linked.id : null,
          outcome,
          notes: composedNotes || undefined,
          started_at: new Date(ending.dial_started_at).toISOString(),
          connected_at: connectedMs ? new Date(connectedMs).toISOString() : null,
          ended_at: new Date(endedMs).toISOString(),
          customer_phone: ending.phone,
          connection_state,
          cancellation_reason: opts?.cancellation_reason,
          cancellation_reason_notes: opts?.cancellation_reason_notes,
        });
        if (!opts?.silent) {
          // The call is always logged now; if the order couldn't be moved
          // (e.g. cancelling an already-shipped order) we still tell the agent.
          if (res?.order_warning) {
            toast({ title: i18n.t('voip.callLoggedOrderNotUpdated'), description: res.order_warning, variant: 'destructive' });
          } else {
            toast({ title: i18n.t('voip.callLogged'), description: i18n.t('voip.outcomeDesc', { outcome: i18n.t(`outcome.${outcome}`, { defaultValue: outcome.replace(/_/g, ' ') }) }) });
          }
        }
      } catch (err: any) {
        toast({ title: i18n.t('voip.failedToLog'), description: apiErrorText(err), variant: 'destructive' });
      }
    }
    if (ending && !opts?.skipQueueSignal) {
      setLastFinished({
        phone: ending.phone,
        outcome,
        via_confirm: !!opts?.viaConfirm,
        finished_at: Date.now(),
        cancellation_reason: opts?.cancellation_reason,
        cancellation_reason_notes: opts?.cancellation_reason_notes,
        reason_text: opts?.extraNote,
      });
    }
    setCall(null);
    setState('idle');
    // Reset the real engine's internal state machine so the NEXT call isn't
    // blocked by a stale 'wrapping'/'in_call'/'dialing' state. Without this the
    // engine throws "Call already in progress" on the next dial until a hard
    // refresh — finalize only updates React state, not the engine's own guard.
    if (PBX_CONFIG.useRealVoip && realEngineRef.current) {
      realEngineRef.current.reset();
    }
  }, [call, toast]);

  const endCall = useCallback(async (outcome: CallOutcome) => {
    await finalize(outcome);
  }, [finalize]);

  // A call ends the instant the talk ends — we never linger in 'wrapping'
  // waiting for an outcome. As soon as a call reaches 'wrapping' (agent End,
  // customer hangup, or ring-out), auto-finalize and drop straight back to idle
  // so the line is free and the agent can re-dial immediately (no hard refresh).
  //   • never-connected (no pickup) → log 'no_answer' (drives the 1-day hold +
  //     5-strike streak server-side + the queue refresh) — unchanged.
  //   • answered → log 'answered' silently and skip the queue signal: it does
  //     NOT touch any order ('answered' → null status) and does NOT
  //     complete/advance the queue member. The real result (Confirmed/Cancelled/
  //     Trash) is derived from the order itself; when the agent resolves the
  //     order this very call row gets re-tagged server-side (POST /call-logs
  //     merge), so Call History shows what the call turned into — never a bare
  //     "Interested".
  useEffect(() => {
    if (state === 'wrapping' && call && !autoNoAnswerRef.current) {
      autoNoAnswerRef.current = true;
      if (call.connected_at == null) void finalize('no_answer');
      else void finalize('answered', { silent: true, skipQueueSignal: true });
    } else if (state === 'idle') {
      autoNoAnswerRef.current = false;
    }
  }, [state, call, finalize]);

  const cancelCall = useCallback(() => {
    // User aborts before/during the answer. Treated as no_answer.
    // Real engine: cancel the outbound INVITE so the carrier stops ringing
    // (suppressWrap = the engine doesn't enter the picker; we finalize to idle).
    if (PBX_CONFIG.useRealVoip && realEngineRef.current) {
      realEngineRef.current.hangup({ suppressWrap: true });
    }
    void finalize('no_answer', { silent: true });
    toast({ title: i18n.t('voip.callCancelled') });
  }, [finalize, toast]);

  /**
   * The agent reserved the current customer to their Personal List instead of
   * picking a normal outcome (e.g. "she'll think about it, call me back in an
   * hour"). Close out the live/wrapping call: log it as 'answered' (picked up,
   * wants a call-back — does not flip an order's status) and reset to idle so
   * the call strip clears and the dial bar / next queue customer take over.
   * suppressWrap stops the engine re-entering the picker; skipQueueSignal lets
   * the Calls page own the queue advance for this path.
   */
  const endCallForClaim = useCallback(async () => {
    if (state === 'idle' || !call) return;
    if (PBX_CONFIG.useRealVoip && realEngineRef.current && (state === 'in_call' || state === 'dialing')) {
      realEngineRef.current.hangup({ suppressWrap: true });
    }
    await finalize('answered', { silent: true, skipQueueSignal: true, extraNote: i18n.t('voip.reservedNote') });
  }, [state, call, finalize]);

  /**
   * The agent pressed the in-call "Confirm" button (which opened the order modal
   * but left the call running so they could read back address/pricing) and has
   * now submitted the order. Close out the live/wrapping call so the strip
   * clears and the next queue customer becomes dial-able. Logged as 'answered'
   * — picked up, no order-status flip (unknown outcome → null status) — because
   * the modal already created the real confirmed order. The server-side merge in
   * POST /call-logs then re-tags THIS call row to the order's result, so Call
   * History shows one row ("Confirmed") with the recording, not a duplicate.
   * skipQueueSignal: the Calls page owns the queue advance for this path.
   * No-op when already idle (the "end the call first, then create order" flow,
   * where the call was finalized before the modal opened).
   */
  const endConfirmedCall = useCallback(async () => {
    if (state === 'idle' || !call) return;
    if (PBX_CONFIG.useRealVoip && realEngineRef.current && (state === 'in_call' || state === 'dialing')) {
      realEngineRef.current.hangup({ suppressWrap: true });
    }
    await finalize('answered', { silent: true, skipQueueSignal: true, extraNote: i18n.t('voip.confirmedDuringCall') });
  }, [state, call, finalize]);

  /**
   * "Confirm Order" during a call — opens the CreateOrderModal but does NOT
   * end the call. The agent stays on the line so they can read back address,
   * pricing, gift, etc. while filling the form. Only the explicit End button
   * (which goes through the outcome picker) terminates the call.
   */
  const confirmCall = useCallback(() => {
    if (!call) return;
    const ctx = call.linked_context;
    const phone = call.phone;
    setPendingConfirm({ phone, linkedContext: ctx });
  }, [call]);

  /**
   * Variant of endCall used by the outcome picker — accepts either a free-text
   * `reason` string (legacy callers) or a structured `EndCallExtras` object
   * which carries the structured cancellation_reason enum + notes that need
   * to land on the order itself (so applyOutcomeToOrder can record them and
   * the prediction-segments trigger moves the customer to the right Cancel
   * mirror list automatically).
   */
  const endCallWithReason = useCallback(async (
    outcome: CallOutcome,
    extras?: EndCallExtras | string,
  ) => {
    const e: EndCallExtras = typeof extras === 'string' ? { reason: extras } : (extras || {});
    // Legacy free-text reason gets appended to the call notes.
    const extraNote = e.reason ? `Reason: ${e.reason}` : undefined;
    await finalize(outcome, {
      cancellation_reason: e.cancellation_reason,
      cancellation_reason_notes: e.cancellation_reason_notes,
      extraNote,
    });
  }, [finalize]);

  const setNotes = useCallback((notes: string) => {
    if (PBX_CONFIG.useRealVoip && realEngineRef.current) {
      realEngineRef.current.setNotes(notes);
      return;
    }
    setCall(prev => prev ? { ...prev, notes } : prev);
  }, []);

  const clearPendingConfirm = useCallback(() => setPendingConfirm(null), []);
  const clearLastFinished = useCallback(() => setLastFinished(null), []);

  const toggleMute = useCallback(() => {
    setIsMuted(prev => {
      const next = !prev;
      if (PBX_CONFIG.useRealVoip && realEngineRef.current) {
        realEngineRef.current.setMuted(next);
      }
      return next;
    });
  }, []);

  // A call always starts unmuted: clear mute whenever we return to idle.
  useEffect(() => {
    if (state === 'idle' && isMuted) setIsMuted(false);
  }, [state, isMuted]);

  return (
    <VoipContext.Provider value={{
      state,
      call,
      callerIds,
      startCall,
      hangup,
      endCall,
      endCallWithReason,
      confirmCall,
      cancelCall,
      endCallForClaim,
      endConfirmedCall,
      setNotes,
      isMuted,
      toggleMute,
      pendingConfirm,
      clearPendingConfirm,
      lastFinished,
      clearLastFinished,
    }}>
      {children}
    </VoipContext.Provider>
  );
}

export function useVoip() {
  const ctx = useContext(VoipContext);
  if (!ctx) throw new Error('useVoip must be used within VoipProvider');
  return ctx;
}

export function formatDuration(seconds: number): string {
  const mm = Math.floor(seconds / 60).toString().padStart(2, '0');
  const ss = (seconds % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}
