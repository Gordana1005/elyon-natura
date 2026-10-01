import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UNDO_MS, type DeferredOutcome } from './useCallsWork';

/**
 * "Не одговара — Марија · Врати (4)". Sits above the outcome bar on phones and in the
 * bottom-right corner from md. The outcome is sent when the countdown ends.
 */
export function UndoBar({ pending, onUndo }: { pending: DeferredOutcome | null; onUndo: () => void }) {
  const { t } = useTranslation();
  const [left, setLeft] = useState(UNDO_MS);
  useEffect(() => {
    if (!pending) return;
    const tick = () => setLeft(Math.max(0, UNDO_MS - (Date.now() - pending.startedAt)));
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, [pending]);
  if (!pending) return null;
  const secs = Math.max(1, Math.ceil(left / 1000));
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+5.25rem)] z-40 mx-auto flex max-w-md items-center gap-3 overflow-hidden rounded-xl border bg-card px-3 py-2 text-sm shadow-lg md:inset-x-auto md:bottom-6 md:right-6"
      data-testid="undo-bar"
    >
      <span className="line-clamp-2 min-w-0 flex-1 break-words leading-snug">
        {t('callsWork.undo.noAnswer', { name: pending.label })}
      </span>
      <Button size="sm" variant="secondary" onClick={onUndo} className="shrink-0 gap-1.5">
        <RotateCcw className="h-3.5 w-3.5" /> {t('callsWork.undo.button')}
        <span className="tabular-nums text-muted-foreground">{secs}</span>
      </Button>
      <span
        className="absolute inset-x-0 bottom-0 h-0.5 bg-amber-500 transition-[width] duration-200 ease-linear"
        style={{ width: `${(left / UNDO_MS) * 100}%` }}
        aria-hidden
      />
    </div>
  );
}
