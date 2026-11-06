// The inbound path of the softphone engine (queue 700 "Teleshop In", 05.11.2026), with sip.js mocked:
// a ring is 'incoming', a ring that ends unanswered goes back to idle WITHOUT 'wrapping' (so nothing is ever
// logged against the customer), a busy engine answers 486, Прими → in_call, Одбиј / hangup → 486.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sip.js', () => {
  const SessionState = { Initial: 'Initial', Establishing: 'Establishing', Established: 'Established', Terminating: 'Terminating', Terminated: 'Terminated' };
  const TransportState = { Connecting: 'Connecting', Connected: 'Connected', Disconnecting: 'Disconnecting', Disconnected: 'Disconnected' };
  const RegistererState = { Initial: 'Initial', Registered: 'Registered', Unregistered: 'Unregistered', Terminated: 'Terminated' };
  class Emitter<T> {
    private ls: ((v: T) => void)[] = [];
    addListener(l: (v: T) => void) { this.ls.push(l); }
    removeListener(l: (v: T) => void) { this.ls = this.ls.filter((x) => x !== l); }
    emit(v: T) { for (const l of [...this.ls]) l(v); }
  }
  const made: { ua: any } = { ua: null };
  class UserAgent {
    static makeURI(s: string) { return { toString: () => s }; }
    options: any;
    transport = { stateChange: new Emitter<string>() };
    constructor(options: any) { this.options = options; made.ua = this; }
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
  }
  class Registerer {
    stateChange = new Emitter<string>();
    constructor(_ua: any) {}
    register = vi.fn(async () => { setTimeout(() => this.stateChange.emit(RegistererState.Registered), 0); });
    unregister = vi.fn(async () => {});
  }
  class Inviter {
    state = SessionState.Initial;
    stateChange = new Emitter<string>();
    constructor(_ua: any, _uri: any, _opts: any) {}
    invite = vi.fn(async () => {});
    cancel = vi.fn(async () => { this.state = SessionState.Terminated; this.stateChange.emit(SessionState.Terminated); });
    bye = vi.fn(async () => { this.state = SessionState.Terminated; this.stateChange.emit(SessionState.Terminated); });
  }
  class Invitation {
    state = SessionState.Initial;
    stateChange = new Emitter<string>();
    remoteIdentity: any;
    constructor(user: string, displayName: string) { this.remoteIdentity = { uri: { user }, displayName }; }
    accept = vi.fn(async (_opts?: any) => { this.state = SessionState.Established; this.stateChange.emit(SessionState.Established); });
    reject = vi.fn(async (_opts?: any) => { this.state = SessionState.Terminated; this.stateChange.emit(SessionState.Terminated); });
    bye = vi.fn(async () => { this.state = SessionState.Terminated; this.stateChange.emit(SessionState.Terminated); });
    /** the far end hung up / the queue cancelled this leg */
    remoteEnd() { this.state = SessionState.Terminated; this.stateChange.emit(SessionState.Terminated); }
  }
  return { UserAgent, Registerer, Inviter, Invitation, SessionState, TransportState, RegistererState, __made: made };
});

import { RealVoipEngine } from './RealVoipEngine';
import * as sip from 'sip.js';

const made = (sip as any).__made as { ua: any };
const Invitation = (sip as any).Invitation as new (user: string, displayName: string) => any;

async function registered() {
  const engine = new RealVoipEngine();
  engine.configure({ extension: '1017', secret: 's', wsUrl: 'wss://pbx.test/ws', primaryCallerId: '+38925128888', secondaryCallerId: null });
  const states: string[] = [];
  const calls: any[] = [];
  const incoming: any[] = [];
  engine.onStateChange = (s) => states.push(s);
  engine.onCallChange = (c) => calls.push(c);
  engine.onIncoming = (i) => incoming.push(i);
  await engine.ensureRegistered();
  const ring = (user = '+38970123456', name = 'TV8888') => {
    const inv = new Invitation(user, name);
    made.ua.options.delegate.onInvite(inv);
    return inv;
  };
  return { engine, states, calls, incoming, ring };
}

describe('RealVoipEngine — inbound ringing', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('registers with an onInvite delegate', async () => {
    const { engine } = await registered();
    expect(engine.isRegistered).toBe(true);
    expect(typeof made.ua.options.delegate?.onInvite).toBe('function');
  });

  it('an INVITE while idle → incoming, with the caller and the TV number', async () => {
    const { engine, states, incoming, ring } = await registered();
    ring('070123456', 'TV8888 070123456');
    expect(states.at(-1)).toBe('incoming');
    expect(incoming).toHaveLength(1);
    expect(incoming[0]).toMatchObject({ phone: '+38970123456', did_label: 'TV8888', did_number: '+38925128888', did_pretty: '02 512 8888' });
    await engine.rejectIncoming();
  });

  it('a second INVITE while already ringing is declined with 486 and changes nothing', async () => {
    const { engine, states, ring } = await registered();
    const first = ring();
    const second = ring('+38971111111', 'TV2515');
    expect(second.reject).toHaveBeenCalledWith({ statusCode: 486 });
    expect(first.reject).not.toHaveBeenCalled();
    expect(states.filter((s) => s === 'incoming')).toHaveLength(1);
    await engine.rejectIncoming();
    expect(first.reject).toHaveBeenCalledWith({ statusCode: 486 });
  });

  it('the ring ends unanswered (another operator answered / the caller gave up) → idle, never wrapping, no call', async () => {
    const { states, calls, ring } = await registered();
    const inv = ring();
    inv.remoteEnd();
    expect(states.at(-1)).toBe('idle');
    expect(states).not.toContain('wrapping');
    expect(calls.at(-1)).toBeNull();
  });

  it('Прими → accept() → in_call with connected_at; hangup → bye → wrapping', async () => {
    const { engine, states, calls, ring } = await registered();
    const inv = ring();
    await engine.answerIncoming();
    expect(inv.accept).toHaveBeenCalledWith({ sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
    expect(states.at(-1)).toBe('in_call');
    const live = calls.filter(Boolean).at(-1);
    expect(live.direction).toBe('inbound');
    expect(live.did_label).toBe('TV8888');
    expect(live.connected_at).toBeTypeOf('number');
    await engine.hangup();
    expect(inv.bye).toHaveBeenCalled();
    expect(states.at(-1)).toBe('wrapping');
    engine.reset();
  });

  it('Одбиј → reject(486) → idle; hangup() while ringing does the same (never cancel)', async () => {
    const { engine, states, ring } = await registered();
    const a = ring();
    await engine.rejectIncoming();
    expect(a.reject).toHaveBeenCalledWith({ statusCode: 486 });
    expect(states.at(-1)).toBe('idle');
    const b = ring();
    await engine.hangup();
    expect(b.reject).toHaveBeenCalledWith({ statusCode: 486 });
    expect(states.at(-1)).toBe('idle');
    expect(states).not.toContain('wrapping');
  });

  it('answerIncoming without a ring throws; a mic refusal frees the line', async () => {
    const { engine, states, ring } = await registered();
    await expect(engine.answerIncoming()).rejects.toThrow('No incoming call');
    const inv = ring();
    inv.accept.mockImplementationOnce(async () => { throw new Error('NotAllowedError'); });
    const errors: string[] = [];
    engine.onError = (_e, ctx) => errors.push(ctx);
    await expect(engine.answerIncoming()).rejects.toThrow('NotAllowedError');
    expect(errors).toContain('answer-failed');
    expect(inv.reject).toHaveBeenCalledWith({ statusCode: 480 });
    expect(states.at(-1)).toBe('idle');
  });

  it('after dispose() an INVITE is declined with 486', async () => {
    const { engine, ring } = await registered();
    await engine.dispose();
    const inv = ring();
    expect(inv.reject).toHaveBeenCalledWith({ statusCode: 486 });
  });

  it('a dial after a declined ring still works (the ring left nothing behind)', async () => {
    const { engine, states, ring } = await registered();
    ring();
    await engine.rejectIncoming();
    await engine.startCall('+38970999999');
    expect(states.at(-1)).toBe('dialing');
    await engine.hangup({ suppressWrap: true });
    engine.reset();
  });
});
