import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Coffee, Play, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiStartBreak, apiEndBreak, apiGetActiveBreak } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

function fmt(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

/**
 * Break / End Break toggle for the Calls toolbar. While on break a live
 * counter ticks up. The break is persisted (shift_breaks) and resumed after a
 * page refresh via apiGetActiveBreak — so the timer survives reloads and the
 * total lands on the My Shifts page.
 */
export function BreakButton() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [onBreak, setOnBreak] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [busy, setBusy] = useState(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Resume an in-progress break after a refresh.
  useEffect(() => {
    let mounted = true;
    apiGetActiveBreak()
      .then((res: any) => {
        if (!mounted || !res?.active) return;
        const start = new Date(res.active.break_start).getTime();
        setOnBreak(true);
        setStartedAt(start);
        setElapsed(Math.max(0, Math.round((Date.now() - start) / 1000)));
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Tick the counter while on break.
  useEffect(() => {
    if (onBreak && startedAt) {
      tickRef.current = setInterval(() => {
        setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
      }, 1000);
    }
    return () => { if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; } };
  }, [onBreak, startedAt]);

  const start = useCallback(async () => {
    setBusy(true);
    try {
      const b: any = await apiStartBreak();
      const start = b?.break_start ? new Date(b.break_start).getTime() : Date.now();
      setStartedAt(start);
      setElapsed(0);
      setOnBreak(true);
      toast({ title: t('breakButton.onBreakTitle'), description: t('breakButton.onBreakDesc') });
    } catch (err: any) {
      toast({ title: t('breakButton.startFailed'), description: err?.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }, [toast, t]);

  const end = useCallback(async () => {
    setBusy(true);
    try {
      await apiEndBreak();
      setOnBreak(false);
      setStartedAt(null);
      toast({ title: t('breakButton.breakEndedTitle'), description: t('breakButton.breakEndedDesc', { duration: fmt(elapsed) }) });
      qc.invalidateQueries({ queryKey: ['my-shifts'] });
    } catch (err: any) {
      toast({ title: t('breakButton.endFailed'), description: err?.message, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }, [toast, elapsed, qc, t]);

  if (onBreak) {
    return (
      <Button
        size="sm"
        onClick={end}
        disabled={busy}
        className="h-8 gap-1.5 text-xs bg-amber-600 hover:bg-amber-700 text-white"
        title={t('breakButton.endBreak')}
        aria-label={t('breakButton.endBreak')}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        {/* the words only on wide screens — the top bar is crowded below xl */}
        <span className="hidden xl:inline">{t('breakButton.endBreak')}</span>
        <span className="font-mono tabular-nums">{fmt(elapsed)}</span>
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={start}
      disabled={busy}
      className={cn('h-8 gap-1.5 text-xs')}
      title={t('breakButton.takeBreak')}
      aria-label={t('breakButton.takeBreak')}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Coffee className="h-3.5 w-3.5" />}
      <span className="hidden xl:inline">{t('breakButton.takeBreak')}</span>
    </Button>
  );
}
