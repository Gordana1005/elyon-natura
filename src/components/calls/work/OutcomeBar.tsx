import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, Clock, Loader2, PhoneMissed, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { DispositionNoteCounter } from '@/components/DispositionNoteField';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { CancellationReasonPicker } from '@/components/CancellationReasonPicker';
import { TrashReasonPicker } from '@/components/TrashReasonPicker';
import type { CancellationReason, TrashReason } from '@/lib/api';
import { cancelReasonLabel, isCancelSelectionValid } from '@/lib/cancellationReasons';
import { isTrashSelectionValid, trashReasonLabel } from '@/lib/trashReasons';
import { DISPOSITION_NOTE_MAX, DISPOSITION_NOTE_MIN, isDispositionNoteValid, normalizeNote } from '@/lib/dispositionNote';
import {
  callbackChoices, CALLBACK_MAX_MS, fromDatetimeLocal, isValidCallback, skopjeClock, toDatetimeLocal, type CallbackChoice,
} from '@/lib/callsWork/callbacks';
import {
  isTypingTarget, outcomeForKey, OUTCOME_ORDER, TOP_CANCEL_REASONS, TOP_TRASH_REASONS, type CallOutcomeKey,
} from '@/lib/callsWork/outcomes';
import { cn } from '@/lib/utils';

type Panel = 'call_again' | 'cancelled' | 'trash';
/** The note step after a reason chip: which outcome, which reason. */
type NoteStep = { kind: 'cancelled'; reason: CancellationReason } | { kind: 'trash'; reason: TrashReason };

export interface OutcomeBarProps {
  /** No customer on screen, or an outcome is being saved. */
  disabled?: boolean;
  /** The outcome being saved (its button spins). */
  busy?: CallOutcomeKey | null;
  onNoAnswer: () => void;
  onCallAgain: (at: Date) => void;
  /** May return a promise: `false` keeps the note step (and the typed note) open, e.g. when the server refused. */
  onCancel: (reason: CancellationReason, note: string) => void | Promise<boolean | void>;
  onTrash: (reason: TrashReason, note: string) => void | Promise<boolean | void>;
  onConfirm: () => void;
  /** Desktop shortcuts 1–5 (and 1–5 inside an open reason / time row). Default on. */
  keyboard?: boolean;
  /** The clock (tests). */
  now?: () => Date;
  /** The customer on screen — a new one drops a half-written note and closes the rows. */
  resetKey?: string;
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
 *                    a reason is ALWAYS required, and so is a written note of at least
 *                    5 characters (owner 01.10.2026): a chip opens a small NOTE STEP —
 *                    the field is focused, Enter saves, Esc goes back to the chips.
 *                    Keyboard: 3 → 1 → type → Enter.
 *   Потврди     — the order form
 */
export function OutcomeBar({
  disabled, busy, onNoAnswer, onCallAgain, onCancel, onTrash, onConfirm, keyboard = true, now = () => new Date(), resetKey, className,
}: OutcomeBarProps) {
  const { t } = useTranslation();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [dialog, setDialog] = useState<Panel | null>(null);
  const [cancelReason, setCancelReason] = useState<CancellationReason | null>(null);
  const [cancelNote, setCancelNote] = useState('');
  const [trashReason, setTrashReason] = useState<TrashReason | null>(null);
  const [trashNote, setTrashNote] = useState('');
  const [customAt, setCustomAt] = useState('');
  const [step, setStep] = useState<NoteStep | null>(null);
  const [draft, setDraft] = useState('');
  const [showHint, setShowHint] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const locked = !!disabled || !!busy;

  // Another customer: never carry a half-written note (or an open row) over to them.
  useEffect(() => {
    setStep(null); setDraft(''); setShowHint(false); setPanel(null); setDialog(null);
  }, [resetKey]);
  // Re-read the clock whenever the time row opens, so "in 1 h" is from now.
  const choices = useMemo<CallbackChoice[]>(() => callbackChoices(now()), [panel]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeAll = () => { setPanel(null); setDialog(null); setStep(null); setShowHint(false); };
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
    setStep(null); setShowHint(false);
    setPanel((cur) => (cur === o ? null : o));
  };

  const pickCallback = (at: Date) => { closeAll(); onCallAgain(at); };
  // A reason chip never sends: it opens the note step (the note travels with the outcome).
  const openStep = (next: NoteStep) => { setPanel(null); setStep(next); setShowHint(false); };
  // The typed note is dropped only once the outcome went through: an async handler that
  // resolves `false` (refused, network error, the order chooser closed) keeps the step open.
  const finish = () => { closeAll(); setDraft(''); };
  const settle = (res: void | Promise<boolean | void>) => {
    if (res && typeof (res as Promise<unknown>).then === 'function') {
      void (res as Promise<boolean | void>).then((ok) => { if (ok !== false) finish(); }, () => {});
    } else finish();
  };
  const sendCancel = (r: CancellationReason, note: string) => settle(onCancel(r, normalizeNote(note)));
  const sendTrash = (r: TrashReason, note: string) => settle(onTrash(r, normalizeNote(note)));

  const draftValid = isDispositionNoteValid(draft);
  const stepBack = () => { if (step) { setPanel(step.kind); setStep(null); setShowHint(false); } };
  const stepClose = () => { closeAll(); setDraft(''); };
  const stepSend = () => {
    if (!step || locked) return;
    if (!draftValid) { setShowHint(true); noteRef.current?.focus(); return; }
    if (step.kind === 'cancelled') sendCancel(step.reason, draft);
    else sendTrash(step.reason, draft);
  };
  // On the field itself (the bar's global keys skip text fields): Enter saves when the note
  // is long enough (else the inline hint), Shift+Enter is a new line, Esc back to the chips.
  const onNoteKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      stepSend();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      stepBack();
    }
  };

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
        ...TOP_CANCEL_REASONS.map((r) => ({ key: r, label: cancelReasonLabel(r), run: () => openStep({ kind: 'cancelled', reason: r }) })),
        { key: 'other', label: t('callsWork.otherReason'), run: () => openDialog('cancelled') },
      ];
    }
    return [
      ...TOP_TRASH_REASONS.map((r) => ({ key: r, label: trashReasonLabel(r), run: () => openStep({ kind: 'trash', reason: r }) })),
      { key: 'other', label: t('callsWork.otherReason'), run: () => openDialog('trash') },
    ];
  };

  useEffect(() => {
    if (!keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
      if (dialog || isTypingTarget(e.target)) return;
      if (e.key === 'Escape' && step) { stepBack(); return; }
      // The note step owns the keys while it is open (a digit is never an outcome here).
      if (step) return;
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

  const customDate = fromDatetimeLocal(customAt);   // Skopje wall time, not the browser's clock
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
                aria-pressed={o !== 'no_answer' && o !== 'confirmed' ? (panel === o || step?.kind === o) : undefined}
                aria-keyshortcuts={String(i + 1)}
                title={t(`callsWork.outcomeHint.${o}`)}
                className={cn(
                  'flex min-h-[3.5rem] min-w-0 flex-col items-center justify-center gap-0.5 rounded-lg border px-1 py-1.5 text-center text-[11px] font-semibold leading-tight transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                  'md:min-h-[2.75rem] md:flex-row md:gap-1.5 md:px-2 md:text-xs xl:gap-2 xl:text-sm',
                  TONE[o],
                  (panel === o || step?.kind === o) && RING[o as Panel],
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

        {step && (
          <div
            className="rounded-lg border bg-background/80 p-2"
            role="group"
            aria-label={t('callsWork.noteStep.title', {
              outcome: t(`callsWork.outcome.${step.kind}`),
              reason: step.kind === 'cancelled' ? cancelReasonLabel(step.reason) : trashReasonLabel(step.reason),
            })}
            data-testid="note-step"
          >
            <div className="mb-1.5 flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={stepBack}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('callsWork.noteStep.back')}
                title={t('callsWork.noteStep.back')}
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <span className={cn(
                'mr-1 h-2 w-2 shrink-0 rounded-full',
                step.kind === 'cancelled' ? 'bg-rose-500' : 'bg-zinc-400 dark:bg-zinc-500',
              )} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                {t('callsWork.noteStep.title', {
                  outcome: t(`callsWork.outcome.${step.kind}`),
                  reason: step.kind === 'cancelled' ? cancelReasonLabel(step.reason) : trashReasonLabel(step.reason),
                })}
              </span>
              <button
                type="button"
                onClick={stepClose}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t('callsWork.close')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <Textarea
              ref={noteRef}
              autoFocus
              rows={2}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); if (showHint) setShowHint(false); }}
              onKeyDown={onNoteKeyDown}
              enterKeyHint="send"
              maxLength={DISPOSITION_NOTE_MAX}
              placeholder={t('dispositionNote.placeholder', { min: DISPOSITION_NOTE_MIN })}
              aria-label={t('dispositionNote.label')}
              aria-describedby="calls-note-step-counter"
              aria-invalid={showHint && !draftValid ? true : undefined}
              // text-base below md: iOS zooms into a field under 16 px.
              className="min-h-[3.25rem] resize-none text-base md:text-sm"
            />
            <div className="mt-1.5 flex min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 text-[11px] leading-tight">
                {showHint && !draftValid
                  ? <span role="alert" className="text-rose-600 dark:text-rose-400">{t('dispositionNote.tooShort', { min: DISPOSITION_NOTE_MIN })}</span>
                  : keyboard && <span className="hidden text-muted-foreground md:inline">{t('callsWork.noteStep.hint')}</span>}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <DispositionNoteCounter id="calls-note-step-counter" value={draft} />
                <Button
                  size="sm"
                  variant={step.kind === 'cancelled' ? 'destructive' : 'secondary'}
                  className="min-h-10 md:min-h-8"
                  disabled={!draftValid || locked}
                  onClick={stepSend}
                >
                  {t('callsWork.noteStep.send')}
                </Button>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* "Друго…" — the full pickers. A reason and the note (5+ characters) are always required. */}
      <Dialog open={dialog === 'cancelled'} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{t('callsWork.dialog.cancelled')}</DialogTitle></DialogHeader>
          <CancellationReasonPicker idPrefix="calls-work-cancel" value={cancelReason} notes={cancelNote} onChange={setCancelReason} onNotesChange={setCancelNote} />
          <DialogFooter>
            <Button
              variant="destructive"
              className="w-full sm:w-auto"
              disabled={!isCancelSelectionValid(cancelReason, cancelNote)}
              onClick={() => cancelReason && sendCancel(cancelReason, cancelNote)}
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
              onClick={() => trashReason && sendTrash(trashReason, trashNote)}
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
