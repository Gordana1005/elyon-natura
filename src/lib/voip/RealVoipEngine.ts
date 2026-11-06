/**
 * Real WebRTC/SIP implementation using sip.js.
 * 
 * This class is designed to implement (or closely match) the behavior expected
 * by VoipContext, so the rest of the CRM UI doesn't need to change.
 * 
 * Current status: Early implementation. Outbound calling is the first priority.
 */

import {
  UserAgent,
  Registerer,
  Inviter,
  Invitation,
  Session,
  TransportState,
  RegistererState,
  SessionState,
} from 'sip.js';
import { PBX_CONFIG } from './pbxConfig';
import { parseInboundIdentity } from './inboundIdentity';

// 'incoming' = an inbound INVITE is ringing this line (queue 700 "Teleshop In", 05.11.2026) — not yet a call.
export type RealCallState = 'idle' | 'dialing' | 'incoming' | 'in_call' | 'wrapping' | 'ending';

/** What the UI gets the moment an inbound call rings (the caller + the TV number dialled). */
export interface IncomingCallInfo {
  phone: string;
  did_label: string | null;
  did_number: string | null;
  did_pretty: string | null;
  received_at: number;
}

/** sip.js Invitation duck-typed (the class is mocked in tests). */
const isInvitation = (s: Session | null | undefined): s is Invitation =>
  !!s && typeof (s as any).accept === 'function' && typeof (s as any).reject === 'function';

/** Per-agent SIP credentials, fetched from /api/voip/credentials at login.
 *  Each agent registers as their OWN extension — no shared/bundled secret. */
export interface VoipEngineCreds {
  extension: string;
  secret: string;
  wsUrl: string;
  primaryCallerId: string;
  secondaryCallerId: string | null;
}

export interface RealActiveCall {
  id: string;
  phone: string;
  agent_id: string;
  started_at: number;
  duration_sec: number;
  notes: string;
  linked_context: any | null;
  dial_started_at: number;
  connected_at: number | null;
  ended_at: number | null;
  /** The caller-ID actually presented for this call (what the customer sees). */
  caller_id: string;
  /** inbound = the Teleshop In queue rang this line and the agent answered; outbound = a dial. */
  direction: 'outbound' | 'inbound';
  /** The TV number's caller-ID name prefix on an inbound call (TV8888 / TV2515), else null. */
  did_label: string | null;
}

export class RealVoipEngine {
  private userAgent: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private currentSession: Session | null = null;

  /** Hidden <audio> element used to play the remote party's audio. */
  private remoteAudio: HTMLAudioElement | null = null;

  /** Injected per-agent SIP credentials (set via configure() before connect()). */
  private creds: VoipEngineCreds | null = null;

  /** When true, ending the call does NOT enter the wrapping/picker state — used
   *  when the caller (e.g. cancelCall while dialing) finalizes the UI itself. */
  private _suppressWrap = false;
  /** Guards handleCallEnded against double-firing (hangup + Terminated event). */
  private _callEnded = false;
  /** Microphone mute state for the current call (reset to false on each call end). */
  private _muted = false;

  private state: RealCallState = 'idle';
  private call: RealActiveCall | null = null;

  private durationTimer: number | null = null;

  // Callbacks that VoipProvider will wire up
  public onStateChange?: (state: RealCallState) => void;
  public onCallChange?: (call: RealActiveCall | null) => void;
  public onRegistrationChange?: (registered: boolean, error?: string) => void;
  public onError?: (error: Error, context: string) => void;
  /** An inbound call started ringing (state is 'incoming'; answerIncoming / rejectIncoming decide). */
  public onIncoming?: (info: IncomingCallInfo) => void;

  /** Set by dispose(): a late INVITE on a torn-down engine is declined, never ringed. */
  private disposed = false;

  private _isRegistered: boolean = false;

  get isRegistered(): boolean {
    return this._isRegistered;
  }

  /**
   * Ensures the engine is connected and registered.
   * Safe to call multiple times. Useful for proactive registration on page load.
   */
  async ensureRegistered(): Promise<void> {
    if (this._isRegistered) return;
    if (!this.creds) throw new Error('VoIP credentials not configured');
    await this.connect();
  }

  constructor(private extension: string = '') {}

  /** Inject this agent's own SIP credentials (from /api/voip/credentials).
   *  Must be called before ensureRegistered()/startCall(). */
  configure(creds: VoipEngineCreds) {
    this.creds = creds;
    this.extension = creds.extension;
  }

  /** The caller-IDs available to this agent (for the dialer / topbar). */
  get callerIds(): { primary: string; secondary: string | null } | null {
    return this.creds ? { primary: this.creds.primaryCallerId, secondary: this.creds.secondaryCallerId } : null;
  }

  async connect(): Promise<void> {
    // Already up AND registered — nothing to do.
    if (this.userAgent && this._isRegistered) return;
    // Coalesce concurrent callers (login effect, startCall, transport-drop
    // reconnect) so we never build two UserAgents racing each other.
    if (this._connecting) return this._connecting;
    this._connecting = this._connectOnce().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  private _connecting: Promise<void> | null = null;

  /** One connect + register attempt. Tears down any stale UserAgent first so a
   *  dropped/failed connection can actually recover. */
  private async _connectOnce(): Promise<void> {
    if (!this.creds) throw new Error('VoIP credentials not configured — call configure() first');
    this.disposed = false;

    // A half-dead UserAgent (e.g. after a WebSocket close / code 1006) must be
    // disposed before we rebuild — otherwise registration stays wedged and every
    // call throws "Not registered with PBX yet" until a full page reload. (The old
    // `if (this.userAgent) return` guard short-circuited every recovery path.)
    if (this.userAgent) {
      try { await this.userAgent.stop(); } catch {}
      this.userAgent = null;
      this.registerer = null;
    }

    // Prefer the per-user WebSocket URL from the backend; fall back to UCP/host.
    let wsUrl = this.creds.wsUrl;
    if (!wsUrl) {
      // @ts-ignore - ucpserver is provided by FreePBX UCP on its pages
      const ucp = (typeof window !== 'undefined') ? (window as any).ucpserver : null;
      if (ucp && ucp.host) {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const port = window.location.protocol === 'https:' ? ucp.portS : ucp.port;
        const namespace = ucp.namespace || PBX_CONFIG.wsNamespace || 'ws';
        wsUrl = `${protocol}//${ucp.host}:${port}/${namespace}`;
      } else {
        wsUrl = PBX_CONFIG.wsUrl;
      }
    }

    console.log('[RealVoip] Using WebSocket URL:', wsUrl, 'as extension', this.creds.extension);

    this.userAgent = new UserAgent({
      uri: UserAgent.makeURI(`sip:${this.creds.extension}@${PBX_CONFIG.sipDomain}`),
      transportOptions: {
        server: wsUrl,
        traceSip: true,
        // CRLF keep-alive every ~20 s (sip.js randomises 80–120 %). Without it the WebSocket
        // carries nothing during a call (media is UDP) and the office NAT closed idle
        // connections after 1–3 min — the PBX then ends the call (05.11.2026, MK go-live day).
        keepAliveInterval: 20,
      },
      authorizationUsername: this.creds.extension,
      authorizationPassword: this.creds.secret,
      // Inbound: queue 700 "Teleshop In" rings this line (05.11.2026). Without a delegate sip.js answers every
      // INVITE with 486 Busy — exactly what we still want while the engine is not idle (handleInvite decides).
      delegate: {
        onInvite: (invitation: Invitation) => this.handleInvite(invitation),
      },
    });

    // Listen to transport state changes (correct 0.21 way)
    const transport = this.userAgent.transport;
    if (transport) {
      transport.stateChange.addListener((state: TransportState) => {
        if (state === TransportState.Connected) {
          console.log('[RealVoip] Transport connected to', wsUrl);
        } else if (state === TransportState.Disconnected) {
          console.warn('[RealVoip] Transport disconnected from', wsUrl);
          this._isRegistered = false;
          this.onRegistrationChange?.(false, 'Transport disconnected');

          // Attempt automatic reconnection (simple, non-aggressive)
          setTimeout(() => {
            if (this.userAgent && !this._isRegistered) {
              console.log('[RealVoip] Attempting to reconnect after transport loss...');
              this.connect().catch(() => {});
            }
          }, 3000);
        }
      });
    }

    try {
      await this.userAgent.start();
      console.log('[RealVoip] UserAgent started');

      // Register properly with sip.js 0.21
      this.registerer = new Registerer(this.userAgent);
      this.registerer.stateChange.addListener((state: RegistererState) => {
        if (state === RegistererState.Registered) {
          this._isRegistered = true;
          console.log('[RealVoip] Successfully registered as', this.extension);
          this.onRegistrationChange?.(true);
        } else if (state === RegistererState.Unregistered) {
          this._isRegistered = false;
          console.warn('[RealVoip] Unregistered');
          this.onRegistrationChange?.(false);
        } else if (state === RegistererState.Terminated) {
          this._isRegistered = false;
          const err = new Error('Registration terminated');
          console.error('[RealVoip] Registration terminated');
          this.onRegistrationChange?.(false, err.message);
          this.onError?.(err, 'registration');
        }
      });

      await this.registerer.register();

      // Wait for actual registration to complete (or fail) - robust version
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          try {
            this.registerer?.stateChange.removeListener(listener);
          } catch {}
        };

        const timeout = setTimeout(() => {
          cleanup();
          const err = new Error('Registration timeout after 15s');
          this.onError?.(err, 'registration');
          reject(err);
        }, 15000);

        const listener = (state: RegistererState) => {
          if (settled) return;

          if (state === RegistererState.Registered) {
            cleanup();
            this._isRegistered = true;
            this._registrationRetryCount = 0; // reset on success
            console.log('[RealVoip] Registration confirmed');
            resolve();
          } else if (state === RegistererState.Terminated || state === RegistererState.Unregistered) {
            cleanup();
            this._isRegistered = false;
            const err = new Error(`Registration ${state.toLowerCase()}`);
            this.onError?.(err, 'registration');
            reject(err);
          }
        };

        this.registerer!.stateChange.addListener(listener);
      });

    } catch (err: any) {
      console.error('[RealVoip] Failed to start/register UserAgent:', err);
      this._isRegistered = false;
      this.onRegistrationChange?.(false, err?.message || String(err));
      this.onError?.(err instanceof Error ? err : new Error(String(err)), 'connect');

      // Simple retry for transient failures (network blips, etc.)
      if (this._registrationRetryCount < 2) {
        this._registrationRetryCount++;
        console.log(`[RealVoip] Retrying registration (attempt ${this._registrationRetryCount + 1})...`);
        await new Promise(res => setTimeout(res, 2000 * this._registrationRetryCount));
        return this._connectOnce(); // retry (direct, not via the coalescing connect())
      }

      throw err;
    }
  }

  private _registrationRetryCount = 0;

  async startCall(phone: string, linkedContext?: any, callerId?: string): Promise<void> {
    if (!this.userAgent || !this._isRegistered) {
      await this.connect();
    }

    if (this.state !== 'idle') {
      const err = new Error('Call already in progress');
      this.onError?.(err, 'startCall');
      throw err;
    }

    if (!this._isRegistered) {
      const err = new Error('Not registered with PBX yet');
      this.onError?.(err, 'startCall');
      throw err;
    }

    const targetUri = UserAgent.makeURI(`sip:${phone}@${PBX_CONFIG.sipDomain}`)!;

    // Caller-ID: explicit arg (e.g. topbar secondary number) wins, else this
    // agent's primary (the main line). The PBX whitelists owned DIDs and falls
    // back to the main line for anything else.
    const cid = callerId || this.creds?.primaryCallerId || PBX_CONFIG.defaultCallerId;
    console.log('[RealVoip] Creating Inviter to', targetUri, 'with caller ID', cid);

    const inviter = new Inviter(this.userAgent!, targetUri, {
      // earlyMedia lets us hear the carrier's ringback/announcements (183 with
      // SDP) before the call is answered, instead of silence while "dialing".
      earlyMedia: true,
      sessionDescriptionHandlerOptions: {
        constraints: { audio: true, video: false },
      },
      extraHeaders: [
        `P-Asserted-Identity: <sip:${cid}@${PBX_CONFIG.sipDomain}>`,
      ],
    });

    this.currentSession = inviter;
    this._callEnded = false;
    this._suppressWrap = false;

    // Proper 0.21 state handling
    inviter.stateChange.addListener((state: SessionState) => {
      // Ignore events from a session that's no longer the active one. A late
      // CANCEL/BYE Terminated (the SIP round-trip can outlast the agent picking
      // an outcome) must NOT re-enter wrapping after the call was already
      // finalized/reset — that was re-sticking the "Call ended" strip.
      if (this.currentSession !== inviter) return;
      if (state === SessionState.Established) {
        const connectMs = Date.now();
        if (this.call) {
          this.call.connected_at = connectMs;
          this.call.started_at = connectMs;
        }
        // CRITICAL: attach the remote party's audio to a playable element,
        // otherwise the agent cannot hear the caller (mic still works one-way).
        this.attachRemoteMedia(inviter);
        // Re-apply the current mute state now that the audio senders definitely
        // exist — so a Mute pressed while the call was still ringing sticks.
        this.setMuted(this._muted);
        this.setState('in_call');
        this.startDurationTimer();
        console.log('[RealVoip] Call established');
      } else if (state === SessionState.Terminated) {
        this.handleCallEnded();
      }
    });

    const dialMs = Date.now();
    this.call = {
      id: `real_${Date.now()}`,
      phone,
      agent_id: 'current-user',
      started_at: dialMs,
      duration_sec: 0,
      notes: '',
      linked_context: linkedContext ?? null,
      dial_started_at: dialMs,
      connected_at: null,
      ended_at: null,
      caller_id: cid,
      direction: 'outbound',
      did_label: null,
    };

    this.setState('dialing');
    this.setCall(this.call);

    try {
      await inviter.invite({
        requestDelegate: {
          onReject: (response: any) => {
            const code = response?.message?.statusCode;
            console.warn('[RealVoip] INVITE rejected with SIP', code);
            // 487 Request Terminated is the carrier's normal reply to OUR CANCEL —
            // the agent pressed End/Cancel before the callee answered (or the call
            // rang out and we cancelled it). It is NOT a connection failure: the
            // Terminated event finalizes the call as no_answer exactly like any
            // other ring-out. Surfacing a red "Call failed" toast here is just
            // misleading noise, so swallow it (still logged, just quietly).
            if (code === 487) return;
            // 486 Busy / 480 Unavailable describe the CALLEE's phone (on another
            // call, or switched off / out of coverage) — NOT a shortage of our trunk
            // lines, so they must never be reported as "all lines busy". Only a
            // 503/600 from the carrier means all our lines are actually in use.
            if (code === 486) {
              this.onError?.(new Error('The number you called is busy (on another call).'), 'callee-busy');
            } else if (code === 480) {
              this.onError?.(new Error('The number you called is unavailable (switched off or out of coverage).'), 'callee-unavailable');
            } else if (code === 503 || code === 600) {
              this.onError?.(new Error('All phone lines are busy right now. Please try again in a moment.'), 'congestion');
            } else if (code && code >= 400) {
              this.onError?.(new Error(`Call could not connect (code ${code}).`), 'call-rejected');
            }
          },
        },
      });
      console.log('[RealVoip] INVITE sent');

      // Attach remote audio as soon as media tracks arrive. This fires for
      // early media (183 ringback) before answer AND for the answered stream,
      // so the agent hears ringing while dialing and audio once connected.
      try {
        const sdh: any = (inviter as any).sessionDescriptionHandler;
        const pc: RTCPeerConnection | undefined = sdh?.peerConnection;
        if (pc) {
          pc.addEventListener('track', () => this.attachRemoteMedia(inviter));
        }
      } catch (e) {
        console.warn('[RealVoip] Could not hook early-media track listener', e);
      }
    } catch (err) {
      console.error('[RealVoip] INVITE failed:', err);
      this.handleCallEnded();
      throw err;
    }
  }

  async hangup(opts?: { suppressWrap?: boolean }): Promise<void> {
    if (opts?.suppressWrap) this._suppressWrap = true;
    // A ring we have not answered: decline it (486) and go straight back to idle — never the outcome picker.
    if (this.state === 'incoming') {
      await this.rejectIncoming();
      return;
    }
    const session = this.currentSession;
    if (session) await this.terminateSession(session);

    this.handleCallEnded();
  }

  /**
   * End a SIP session whatever its kind and phase: an answered call gets BYE; an outbound INVITE still ringing
   * gets CANCEL (bye() is invalid there and would leave the call ringing on the carrier); an inbound INVITE we
   * have not answered gets 486 Busy. Errors are logged, never thrown — the UI state machine moves on regardless.
   */
  private async terminateSession(session: Session): Promise<void> {
    try {
      if (session.state === SessionState.Established) {
        await session.bye();
      } else if (session.state === SessionState.Initial || session.state === SessionState.Establishing) {
        if (isInvitation(session)) await session.reject({ statusCode: 486 });
        else await (session as Inviter).cancel();
      }
    } catch (e) {
      console.warn('[RealVoip] Error ending the session', e);
    }
  }

  // ── Inbound (queue 700 "Teleshop In", 05.11.2026) ──────────────────────────

  /**
   * An inbound INVITE from the PBX: the queue rings this line. Only an idle, live engine takes it — anything else
   * answers 486 Busy, so the queue keeps ringing the other free members. The caller and the TV number come from
   * the From header (parseInboundIdentity). Nothing is logged here: a ring that ends without an answer (CANCEL
   * because another operator was first or the caller gave up, or our own decline) goes straight back to idle
   * through handleIncomingGone — never through 'wrapping', so no outcome is ever recorded against the customer.
   */
  private handleInvite(invitation: Invitation): void {
    if (this.disposed || this.state !== 'idle' || !this.userAgent) {
      console.log('[RealVoip] Inbound INVITE declined — engine state', this.disposed ? 'disposed' : this.state);
      invitation.reject({ statusCode: 486 }).catch(() => {});
      return;
    }
    const remote: any = (invitation as any).remoteIdentity;
    const id = parseInboundIdentity(remote?.uri?.user ?? '', remote?.displayName ?? '');
    const now = Date.now();
    console.log('[RealVoip] Inbound call from', id.phone, 'on', id.did_label ?? '?');

    this.currentSession = invitation;
    this._callEnded = false;
    this._suppressWrap = false;
    this.call = {
      id: `in_${now}`,
      phone: id.phone,
      agent_id: 'current-user',
      started_at: now,
      duration_sec: 0,
      notes: '',
      linked_context: null,
      dial_started_at: now,
      connected_at: null,
      ended_at: null,
      caller_id: id.did_number ?? this.creds?.primaryCallerId ?? PBX_CONFIG.defaultCallerId,
      direction: 'inbound',
      did_label: id.did_label,
    };

    invitation.stateChange.addListener((state: SessionState) => {
      if (this.currentSession !== invitation) return;
      if (state === SessionState.Established) {
        const connectMs = Date.now();
        if (this.call) {
          this.call.connected_at = connectMs;
          this.call.started_at = connectMs;
        }
        this.attachRemoteMedia(invitation);
        this.setMuted(this._muted);
        this.setState('in_call');
        // push connected_at to the UI at once — finalize() reads it to tell an answered call from a ring-out
        if (this.call) this.setCall({ ...this.call });
        this.startDurationTimer();
        console.log('[RealVoip] Inbound call established');
      } else if (state === SessionState.Terminated) {
        if (this.state === 'incoming') this.handleIncomingGone();
        else this.handleCallEnded();
      }
    });

    this.setState('incoming');
    this.setCall(this.call);
    this.onIncoming?.({ phone: id.phone, did_label: id.did_label, did_number: id.did_number, did_pretty: id.did_pretty, received_at: now });
  }

  /** The ring ended without an answer (another operator took it, the caller hung up, or we declined): silent idle. */
  private handleIncomingGone(): void {
    this.stopDurationTimer();
    this.detachRemoteMedia();
    this.currentSession = null;
    this.call = null;
    this._callEnded = false;
    this._suppressWrap = false;
    this._muted = false;
    this.setCall(null);
    this.setState('idle');
  }

  /** Answer the ringing inbound call (the agent pressed Прими). Rejects when nothing is ringing. */
  async answerIncoming(): Promise<void> {
    const invitation = this.currentSession;
    if (this.state !== 'incoming' || !isInvitation(invitation)) throw new Error('No incoming call');
    try {
      await invitation.accept({ sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
      // Attach the remote audio as soon as its track arrives (as the outbound path does).
      try {
        const pc: RTCPeerConnection | undefined = (invitation as any).sessionDescriptionHandler?.peerConnection;
        pc?.addEventListener('track', () => this.attachRemoteMedia(invitation));
      } catch { /* ignore */ }
    } catch (err) {
      // Typically the microphone was refused — tell the UI, free the line so the queue moves on.
      console.error('[RealVoip] accept() failed:', err);
      this.onError?.(err instanceof Error ? err : new Error(String(err)), 'answer-failed');
      try { await invitation.reject({ statusCode: 480 }); } catch { /* already gone */ }
      if (this.currentSession === invitation) this.handleIncomingGone();
      throw err;
    }
  }

  /** Decline the ringing inbound call (the agent pressed Одбиј): 486 Busy, the queue rings the others. */
  async rejectIncoming(): Promise<void> {
    const invitation = this.currentSession;
    if (this.state !== 'incoming' || !isInvitation(invitation)) return;
    try {
      await invitation.reject({ statusCode: 486 });
    } catch (e) {
      console.warn('[RealVoip] reject() failed', e);
    }
    if (this.currentSession === invitation) this.handleIncomingGone();
  }

  /** The order / lead the call is about, found after the fact (an inbound call starts standalone). */
  setLinkedContext(ctx: any | null): void {
    if (this.call) {
      this.call.linked_context = ctx;
      this.setCall({ ...this.call });
    }
  }

  /**
   * Routes the remote audio track(s) from the WebRTC peer connection into a
   * hidden <audio> element so the agent can actually hear the caller.
   * Without this, sip.js sets up the media but nothing is ever played.
   */
  private attachRemoteMedia(session: Session) {
    try {
      const sdh: any = session.sessionDescriptionHandler;
      const pc: RTCPeerConnection | undefined = sdh?.peerConnection;
      if (!pc) {
        console.warn('[RealVoip] No peerConnection available for remote media');
        return;
      }

      const remoteStream = new MediaStream();
      pc.getReceivers().forEach((receiver) => {
        if (receiver.track && receiver.track.kind === 'audio') {
          remoteStream.addTrack(receiver.track);
        }
      });

      if (!this.remoteAudio) {
        this.remoteAudio = document.createElement('audio');
        this.remoteAudio.setAttribute('data-elyon-voip', 'remote');
        this.remoteAudio.autoplay = true;
        (this.remoteAudio as any).playsInline = true;
        this.remoteAudio.style.display = 'none';
        document.body.appendChild(this.remoteAudio);
      }

      this.remoteAudio.srcObject = remoteStream;
      const playPromise = this.remoteAudio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((e) => {
          console.warn('[RealVoip] remote audio play() blocked/failed:', e);
          this.onError?.(e instanceof Error ? e : new Error(String(e)), 'remote-audio');
        });
      }
      console.log('[RealVoip] Remote audio attached:', remoteStream.getAudioTracks().length, 'track(s)');
    } catch (e) {
      console.error('[RealVoip] Failed to attach remote media', e);
      this.onError?.(e instanceof Error ? e : new Error(String(e)), 'remote-audio');
    }
  }

  private detachRemoteMedia() {
    if (this.remoteAudio) {
      try {
        this.remoteAudio.srcObject = null;
        this.remoteAudio.remove();
      } catch {}
      this.remoteAudio = null;
    }
  }

  private startDurationTimer() {
    this.stopDurationTimer();
    this.durationTimer = window.setInterval(() => {
      if (this.call) {
        this.call.duration_sec += 1;
        this.setCall({ ...this.call });
      }
    }, 1000);
  }

  private stopDurationTimer() {
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
  }

  private handleCallEnded() {
    // Guard: this can be triggered by both hangup() and the Terminated event.
    if (this._callEnded) return;
    this._callEnded = true;

    this.stopDurationTimer();
    this.detachRemoteMedia();

    if (this.call) {
      this.call.ended_at = Date.now();
      this.setCall({ ...this.call });
    }

    // Normal end → wrapping (outcome picker). When cancelled while dialing, the
    // VoipContext finalizes to 'idle' itself, so we don't force wrapping.
    if (!this._suppressWrap) {
      this.setState('wrapping');
    }

    this.currentSession = null;
    this._muted = false; // next call always starts unmuted
  }

  /** Current microphone mute state. */
  get isMuted(): boolean {
    return this._muted;
  }

  /**
   * Mute/unmute the local microphone by toggling `enabled` on the outbound
   * audio track(s). Uses the same peerConnection access as attachRemoteMedia.
   * No-op (but state is remembered) if there is no active session yet.
   */
  setMuted(muted: boolean): void {
    this._muted = muted;
    const pc: RTCPeerConnection | undefined =
      (this.currentSession as any)?.sessionDescriptionHandler?.peerConnection;
    pc?.getSenders().forEach((sender) => {
      if (sender.track && sender.track.kind === 'audio') {
        sender.track.enabled = !muted;
      }
    });
  }

  private setState(newState: RealCallState) {
    this.state = newState;
    this.onStateChange?.(newState);
  }

  private setCall(newCall: RealActiveCall | null) {
    this.call = newCall;
    this.onCallChange?.(newCall);
  }

  // Placeholder methods to match the interface during early development
  setNotes(notes: string) {
    if (this.call) {
      this.call.notes = notes;
      this.setCall({ ...this.call });
    }
  }

  async finalizeCall(outcome: any) {
    console.log('[RealVoip] finalizeCall called with outcome:', outcome);

    if (this.currentSession) {
      try {
        await this.currentSession.bye();
      } catch (e) {}
    }

    this.setState('idle');
    this.setCall(null);
    this.currentSession = null;
    this.registerer = null;
  }

  /**
   * Reset to idle AFTER the outcome has been logged by VoipContext. The call and
   * SIP session have already ended (hangup()/Terminated); this clears the engine's
   * internal guards so the NEXT startCall isn't blocked by a stale 'in_call' /
   * 'wrapping' / 'dialing' state. That stale state was the root cause of the
   * "Call already in progress" error that previously required a hard refresh —
   * finalize() logs the outcome in React but never told the engine the call was
   * over, and the suppressWrap (cancel / personal-list) path never reset state at
   * all. Registration (registerer / userAgent) is intentionally preserved so the
   * agent stays ready to dial. Purely internal: it does NOT fire onStateChange/
   * onCallChange (React state is already handled by finalize). Idempotent.
   */
  reset(): void {
    this.stopDurationTimer();
    this.detachRemoteMedia();
    // Defensive: tear down any session that somehow survived (normal paths null
    // it in handleCallEnded). Fire-and-forget — never block reset.
    const lingering = this.currentSession;
    this.currentSession = null;
    if (lingering) void this.terminateSession(lingering);
    this.call = null;
    this._callEnded = false;
    this._suppressWrap = false;
    this.state = 'idle';
  }

  /**
   * Public method to fully clean up the engine.
   * Should be called on logout, page unload, or when switching away from real mode.
   */
  async dispose(): Promise<void> {
    console.log('[RealVoip] Disposing engine...');
    this.disposed = true;

    if (this.registerer) {
      try {
        await this.registerer.unregister();
      } catch (e) {
        // Ignore
      }
      this.registerer = null;
    }

    const session = this.currentSession;
    this.currentSession = null;
    if (session) await this.terminateSession(session);

    if (this.userAgent) {
      this.userAgent.stop();
      this.userAgent = null;
    }

    this.stopDurationTimer();
    this.detachRemoteMedia();
    this._isRegistered = false;
    this._registrationRetryCount = 0;
    this.setState('idle');
    this.setCall(null);
  }

  // Backward-compat alias
  async disconnect(): Promise<void> {
    return this.dispose();
  }
}
