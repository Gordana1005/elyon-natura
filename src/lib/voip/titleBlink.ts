/** Blink the browser tab's title while an inbound call rings (05.11.2026), restoring the original on stop. */
let original: string | null = null;
let timer: number | null = null;

export function startTitleBlink(text: string): void {
  if (typeof document === 'undefined') return;
  if (timer != null) stopTitleBlink();
  original = document.title;
  let on = false;
  const tick = () => {
    on = !on;
    document.title = on ? `☎ ${text}` : (original ?? '');
  };
  tick();
  timer = window.setInterval(tick, 1000);
}

export function stopTitleBlink(): void {
  if (typeof document === 'undefined') return;
  if (timer != null) { window.clearInterval(timer); timer = null; }
  if (original != null) { document.title = original; original = null; }
}
