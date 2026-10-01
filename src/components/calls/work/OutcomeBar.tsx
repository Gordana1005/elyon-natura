import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Clock, Loader2, PhoneMissed, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CancellationReasonPicker } from '@/components/CancellationReasonPicker';
import { TrashReasonPicker } from '@/components/TrashReasonPicker';
import type { CancellationReason, TrashReason } from '@/lib/api';
import { cancelReasonLabel, isCancelSelectionValid } from '@/lib/cancellationReasons';
import { isTrashSelectionValid, trashReasonLabel } from '@/lib/trashReasons';
import {
  callbackChoices, CALLBACK_MAX_MS, isValidCallback, skopjeClock, toDatetimeLocal, type CallbackChoice,
} from '@/lib/callsWork/callbacks';
import {
  isTypingTarget, outcomeForKey, OUTCOME_ORDER, TOP_CANCEL_REASONS, TOP_TRASH_REASONS, type CallOutcomeKey,
} from '@/lib/callsWork/outcomes';
import { cn } from '@/lib/utils';

type Panel = 'call_again' | 'cancelled' | 'trash';

export interface OutcomeBarProps {
  /** No customer on screen, or an outcome is being saved. */
  disabled?: boolean;
  /** The outcome being saved (its button spins). */
  busy?: CallOutcomeKey | null;
  onNoAnswer: () => void;
  onCallAgain: (at: Date) => void;
  onCancel: (reason: CancellationReason, note: string) => void;
  onTrash: (reason: TrashReason, note: string) => void;
  onConfirm: () => void;
  /** Desktop shortcuts 1–5 (and 1–5 inside an open reason / time row). Default on. */
  keyboard?: boolean;
  /** The clock (tests). */
  now?: () => Date;
  className?: string;
}

const ICON: Record<CallOutcomeKey, ComponentType<{ className?: string }>> = {
  no_answer: PhoneMissed,
  call_again: Clock,
  cancelled: X,
  trash: Trash2,
  confirmed: Check,
};

// Tones follow the status palette: no answer amber, callback sky, cancel rose,
// trash zinc, confirm = the one filled (primary) action.
const TONE: Record<CallOutcomeKey, string> = {
  no_answer: 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20',
  call_again: 'border-sky-300 bg-sky-50 text-sky-900 hover:bg-sky-100 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-200 dark:hover:bg-sky-500/20',
  cancelled: 'border-rose-300 bg-rose-50 text-rose-900 hover:bg-rose-100 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:bg-rose-500/20',
  trash: 'border-zinc-300 bg-zinc-50 text-zinc-900 hover:bg-zinc-100 dark:border-zinc-500/40 dark:bg-zinc-500/10 dark:text-zinc-200 dark:hover:bg-zinc-500/20',
  confirmed: 'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 dark:border-emerald-500 dark:bg-emerald-600 dark:hover:bg-emerald-500',
};

const RING: Record<Panel, string> = {
  call_again: 'ring-2 ring-sky-400 ring-offset-1 ring-offset-background',
  cancelled: 'ring-2 ring-rose-400 ring-offset-1 ring-offset-background',
  trash: 'ring-2 ring-zinc-400 ring-offset-1 ring-offset-background',
};

const chipCls = 'inline-flex min-h-10 md:min-h-8 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

/**
 * The one-tap outcome bar (plan Фаза 11, /calls). Phones: pinned to the bottom of the
 * screen (agents work /calls on their phones). md and up: inline under the customer.
 *   Не одговара — one tap (the page shows a 5 s undo)
 *   Повторно    — a time chip (in 1 h · in 3 h · this evening · tomorrow · other)
 *   Откажа / Корпа — a reason chip (the top 4) or "Друго…" (the full picker + note);
 *                    a reason is ALWAYS required
 *   Потврди     — the order form
 */
export function OutcomeBar({
  disabled, busy, onNoAnswer, onCallAgain, onCancel, onTrash, onConfirm, keyboard = true, now = () => new Date(), className,
}: OutcomeBarProps) {
  const { t } = useTranslation();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [dialog, setDialog] = useState<Panel | null>(null);
  const [cancelReason, setCancelReason] = useState<CancellationReason | null>(null);
  const [cancelNote, setCancelNote] = useState('');
  const [trashReason, setTrashReason] = useState<TrashReason | null>(null);
  const [trashNote, setTrashNote] = useState('');
  const [customAt, setCustomAt] = useState('');

  const locked = !!disabled || !!busy;
  // Re-read the clock whenever the time row opens, so "in 1 h" is from now.
  const choices = useMemo<CallbackChoice[]>(() => callbackChoices(now()), [panel]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeAll = () => { setPanel(null); setDialog(null); };
  const openDialog = (p: Panel) => {
    setDialog(p);
    if (p === 'cancelled') { setCancelReason(null); setCancelNote(''); }
    if (p === 'trash') { setTrashReason(null); setTrashNote(''); }
    if (p === 'call_again') setCustomAt(toDatetimeLocal(new Date(now().getTime() + 2 * 3_600_000)));
  };

  const press = (o: CallOutcomeKey) => {
    if (locked) return;
    if (o === 'no_answer') { closeAll(); onNoAnswer(); return; }
    if (o === 'confirmed') { closeAll(); onConfirm(); return; }
    setPanel((cur) => (cur === o ? null : o));
  };

  const pickCallback = (at: Date) => { closeAll(); onCallAgain(at); };
  const pickCancel = (r: CancellationReason, note = '') => { closeAll(); onCancel(r, note); };
  const pickTrash = (r: TrashReason, note = '') => { closeAll(); onTrash(r, note); };

  // The row's items in shortcut order: 1–4 the chips, 5 "Друго…".
  const panelItems = (p: Panel): Array<{ key: string; label: string; sub?: string; run: () => void }> => {
    if (p === 'call_again') {
      return [
        ...choices.map((c) => ({ key: c.key, label: t(`callsWork.callback.${c.key}`), sub: skopjeClock(c.at), run: () => pickCallback(c.at) })),
        { key: 'other', label: t('callsWork.otherTime'), run: () => openDialog('call_again') },
      ];
    }
    if (p === 'cancelled') {
      return [
        ...TOP_CANCEL_REASONS.map((r) => ({ key: r, label: cancelReasonLabel(r), run: () => pickCancel(r) })),
        { key: 'other', label: t('callsWork.otherReason'), run: () => openDialog('cancelled') },
      ];
    }
    return [
      ...TOP_TRASH_REASONS.map((r) => ({ key: r, label: trashReasonLabel(r), run: () => pickTrash(r) })),
      { key: 'other', label: t('callsWork.otherReason'), run: () => openDialog('trash') },
    ];
  };

  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      if (dialog || isTypingTarget(e.target)) return;
      if (e.key === 'Escape' && panel) { setPanel(null); return; }
      if (locked) return;
      if (panel) {
        const i = Number(e.key) - 1;
        const items = panelItems(panel);
        if (Number.isInteger(i) && i >= 0 && i < items.length) { e.preventDefault(); items[i].run(); }
        return;
      }
      const o = outcomeForKey(e.key);
      if (o) { e.preventDefault(); press(o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const customDate = customAt ? new Date(customAt) : null;
  const customValid = isValidCallback(customDate, now());

  return (
    <div
      className={cn(
        // Phones: pinned to the bottom edge, above the home indicator. md+: inline.
        'fixed inset-x-0 bottom-0 z-30 border-t bg-card/95 px-2 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur',
        'md:static md:z-auto md:rounded-xl md:border md:bg-card md:p-2 md:shadow-sm md:backdrop-blur-none',
        className,
      )}
      data-testid="outcome-bar"
    >
      <div className="mx-auto flex max-w-3xl flex-col-reverse gap-2 md:max-w-none md:flex-col">
        <div role="toolbar" aria-label={t('callsWork.barLabel')} className="grid grid-cols-5 gap-1.5 md:gap-2">
          {OUTCOME_ORDER.map((o, i) => {
            const Icon = ICON[o];
            const spinning = busy === o;
            return (
              <button
                key={o}
                type="button"
                onClick={() => press(o)}
                disabled={locked}
                aria-pressed={o !== 'no_answer' && o !== 'confirmed' ? panel === o : undefined}
                aria-keyshortcuts={String(i + 1)}
                title={t(`callsWork.outcomeHint.${o}`)}
                className={cn(
                  'flex min-h-[3.5rem] min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg border px-1 py-1.5 text-center text-[11px] font-semibold leading-tight transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                  'md:min-h-[2.75rem] md:flex-row md:gap-1.5 md:px-2 md:text-xs xl:gap-2 xl:text-sm',
                  TONE[o],
                  panel === o && RING[o as Panel],
                )}
              >
                {spinning ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Icon className="h-4 w-4 shrink-0" />}
                <span className="min-w-0 break-words">{t(`callsWork.outcome.${o}`)}</span>
                {keyboard && (
                  <kbd aria-hidden className="pointer-events-none hidden shrink-0 rounded border border-current px-1 text-[10px] font-normal leading-tight opacity-50 xl:inline">
                    {i + 1}
                  </kbd>
                )}
              </button>
            );
          })}
        </div>

        {panel && (
          <div className="rounded-lg border bg-background/80 p-2" role="group" aria-label={t(`callsWork.pick.${panel}`)}>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-muted-foreground">{t(`callsWork.pick.${panel}`)}</span>
              <button
                type="button"
                onClick={() => setPanel(null)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('callsWork.close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {panelItems(panel).map((item, i) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={item.run}
                  disabled={locked}
                  className={cn(chipCls, item.key === 'other'
                    ? 'border-dashed border-border bg-card text-muted-foreground hover:text-foreground'
                    : 'border-border bg-card text-foreground hover:bg-muted')}
                >
                  {keyboard && <span aria-hidden className="hidden text-[10px] text-muted-foreground xl:inline">{i + 1}</span>}
                  <span>{item.label}</span>
                  {item.sub && <span className="tabular-nums text-muted-foreground">{item.sub}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* "Друго…" — the full pickers. A reason is always required; 'other' needs the note. */}
      <Dialog open={dialog === 'cancelled'} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{t('callsWork.dialog.cancelled')}</DialogTitle></DialogHeader>
          <CancellationReasonPicker value={cancelReason} notes={cancelNote} onChange={setCancelReason} onNotesChange={setCancelNote} />
          <DialogFooter>
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={!isCancelSelectionValid(cancelReason, cancelNote)}
              onClick={() => cancelReason && pickCancel(cancelReason, cancelNote.trim())}
            >
              {t('callsWork.dialog.saveCancelled')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'trash'} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{t('callsWork.dialog.trash')}</DialogTitle></DialogHeader>
          <TrashReasonPicker idPrefix="calls-work-trash" value={trashReason} notes={trashNote} onChange={setTrashReason} onNotesChange={setTrashNote} />
          <DialogFooter>
            <Button
              variant="secondary"
              className="w-full sm:w-auto"
              disabled={!isTrashSelectionValid(trashReason, trashNote)}
              onClick={() => trashReason && pickTrash(trashReason, trashNote.trim())}
            >
              {t('callsWork.dialog.saveTrash')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'call_again'} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t('callsWork.dialog.call_again')}</DialogTitle></DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="calls-work-callback">{t('callsWork.dialog.callbackLabel')}</Label>
            <Input
              id="calls-work-callback"
              type="datetime-local"
              value={customAt}
              min={toDatetimeLocal(now())}
              max={toDatetimeLocal(new Date(now().getTime() + CALLBACK_MAX_MS))}
              onChange={(e) => setCustomAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('callsWork.dialog.callbackHint')}</p>
          </div>
          <DialogFooter>
            <Button className="w-full sm:w-auto" disabled={!customValid} onClick={() => customDate && pickCallback(customDate)}>
              {t('callsWork.dialog.saveCallback')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
