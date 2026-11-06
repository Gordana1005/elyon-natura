/**
 * The softphone's ringtone for an inbound Teleshop call (05.11.2026) — generated with WebAudio (two tones,
 * 440 + 480 Hz, 1 s on / 3 s off, the classic ring cadence), so there is no audio asset to ship or cache.
 *
 * Chrome's autoplay policy lets an AudioContext make sound only after a user gesture on the page: prime()
 * is bound to the first pointer-down after login (it creates / resumes the context); start() reports false
 * when the context is still suspended, so the UI can say "click anywhere to hear the ringing".
 */
export interface Ringer {
  prime(): void;
  start(): boolean;
  stop(): void;
  readonly ringing: boolean;
}

const ON_MS = 1000;
const PERIOD_MS = 4000;

export function createRinger(): Ringer {
  let ctx: AudioContext | null = null;
  let timer: number | null = null;
  let oscillators: OscillatorNode[] = [];
  let ringing = false;

  const context = (): AudioContext | null => {
    if (ctx) return ctx;
    const Ctor = (typeof window !== 'undefined' && ((window as any).AudioContext || (window as any).webkitAudioContext)) || null;
    if (!Ctor) return null;
    try { ctx = new Ctor(); } catch { ctx = null; }
    return ctx;
  };

  const burst = () => {
    const c = context();
    if (!c || c.state !== 'running') return;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, c.currentTime + 0.02);
    gain.gain.setValueAtTime(0.25, c.currentTime + ON_MS / 1000 - 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + ON_MS / 1000);
    gain.connect(c.destination);
    oscillators = [440, 480].map((hz) => {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz;
      o.connect(gain);
      o.start();
      o.stop(c.currentTime + ON_MS / 1000 + 0.01);
      return o;
    });
  };

  return {
    get ringing() { return ringing; },
    prime() {
      const c = context();
      if (c && c.state === 'suspended') void c.resume().catch(() => {});
    },
    start() {
      if (ringing) return !!ctx && ctx.state === 'running';
      ringing = true;
      const c = context();
      if (c && c.state === 'suspended') void c.resume().catch(() => {});
      burst();
      timer = window.setInterval(burst, PERIOD_MS);
      return !!c && c.state === 'running';
    },
    stop() {
      ringing = false;
      if (timer != null) { window.clearInterval(timer); timer = null; }
      for (const o of oscillators) { try { o.stop(); } catch { /* already stopped */ } }
      oscillators = [];
    },
  };
}
