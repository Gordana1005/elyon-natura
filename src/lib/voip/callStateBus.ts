// Tiny module-level bridge between VoipContext (writes the softphone state)
// and AuthContext's presence heartbeat (reads it, so long calls keep the
// server-side voip_state fresh). Deliberately dependency-free — importing
// VoipContext here would create a cycle.
// 'incoming' = the browser is ringing on an inbound Teleshop call (05.11.2026) — not yet a call.
export type BusCallState = 'idle' | 'dialing' | 'incoming' | 'in_call' | 'wrapping' | 'ending';

let current: BusCallState = 'idle';

export const setBusCallState = (s: BusCallState) => { current = s; };
export const getBusCallState = (): BusCallState => current;
