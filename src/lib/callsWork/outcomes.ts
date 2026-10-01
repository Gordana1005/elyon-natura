import type { CancellationReason, TrashReason } from '@/lib/api';

// The one-tap outcome bar on /calls (plan Фаза 11). Keys travel to POST /api/calls/outcome.
export type CallOutcomeKey = 'no_answer' | 'call_again' | 'cancelled' | 'trash' | 'confirmed';

/** Bar order = keyboard shortcut order (desktop: 1–5). */
export const OUTCOME_ORDER: CallOutcomeKey[] = ['no_answer', 'call_again', 'cancelled', 'trash', 'confirmed'];

export function outcomeForKey(key: string): CallOutcomeKey | null {
  const i = Number(key) - 1;
  return Number.isInteger(i) && i >= 0 && i < OUTCOME_ORDER.length ? OUTCOME_ORDER[i] : null;
}

/**
 * The four reasons offered as one-tap chips — the most used by agents in the 60 days to
 * 01.10.2026 (live: cancel not_interested 1.460 · will_call_back 980 · still_using_product 847
 * · no_money 547; trash not_reachable 842 · uncooperative 363 · wrong_number 90 · rude 82).
 * "Друго…" opens the full picker (every reason + the note; 'other' needs the note).
 * Values must stay inside CANCEL_REASON_VALUES / TRASH_REASON_VALUES.
 */
export const TOP_CANCEL_REASONS: CancellationReason[] = ['not_interested', 'will_call_back', 'still_using_product', 'no_money'];
export const TOP_TRASH_REASONS: TrashReason[] = ['not_reachable', 'uncooperative', 'wrong_number', 'rude'];

/** True when a key press belongs to a text field / an open dialog, not to the bar. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable) return true;
  if (el.closest('input, textarea, select, [contenteditable="true"]')) return true;
  return !!el.closest('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]');
}

/**
 * Polling for the /calls queues: nothing while the tab is hidden (TanStack Query also
 * skips background ticks — refetchIntervalInBackground is false — this makes it
 * explicit), a 60 s back-off while the queue is empty, the base rate otherwise. The
 * `assigner` broadcast refreshes the queue the moment a manager hands work over.
 */
export const EMPTY_BACKOFF_MS = 60_000;
export function livePollInterval(baseMs: number, isEmpty: boolean, hidden: boolean): number | false {
  if (hidden) return false;
  return isEmpty ? Math.max(baseMs, EMPTY_BACKOFF_MS) : baseMs;
}
