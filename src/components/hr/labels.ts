import type { TFunction } from 'i18next';
import i18n from '@/i18n';
import { apiErrorText } from '@/i18n/apiErrors';
import type { RequestStatus } from '@/lib/hrApi';

/** Status pills: open = amber, approved = green, rejected / cancelled = muted. */
export const STATUS_TONE: Record<RequestStatus, string> = {
  pending_team: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100',
  pending_manager: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100',
  approved: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100',
  rejected: 'border-red-300 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100',
  cancelled: 'border-border bg-muted text-muted-foreground',
};

/** The absence letter tile (the same violet as the shift grid's absence cells). */
export const ABSENCE_TILE = 'border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-400/50 dark:bg-violet-500/20 dark:text-violet-100';
export const PENDING_TILE = 'border-dashed border-amber-400 bg-amber-50/60 text-amber-800 dark:border-amber-400/60 dark:bg-amber-500/10 dark:text-amber-100';
export const HOLIDAY_TILE = 'bg-sky-50 dark:bg-sky-500/10';

export const typeLabel = (t: TFunction, type: string) => t(`hrPage.types.${type}`);
export const statusLabel = (t: TFunction, s: string) => t(`hrPage.status.${s}`);

/** "19.10 – 23.10.2026" (one day: "19.10.2026"). */
export function rangeText(from: string, to: string): string {
  const d = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;
  if (from === to) return `${d(from)}.${from.slice(0, 4)}`;
  return from.slice(0, 4) === to.slice(0, 4) ? `${d(from)} – ${d(to)}.${to.slice(0, 4)}` : `${d(from)}.${from.slice(0, 4)} – ${d(to)}.${to.slice(0, 4)}`;
}

/** 20 → "20", 2.5 → "2,5" (Macedonian decimal comma). */
export const daysText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));

/**
 * The hr routes answer `{error: "hr.<code>[: detail]"}` (invalid | conflict | forbidden |
 * not_found | no_employee | failed); the code is translated, the detail shown as sent.
 */
export function hrErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const m = msg.match(/^hr\.(invalid|conflict|forbidden|not_found|no_employee|failed)(?::\s*([\s\S]*))?$/);
  if (!m) return apiErrorText(err);
  const detail = (m[2] ?? '').trim();
  const text = i18n.t(`hrPage.errors.${m[1]}`, { detail });
  return detail ? text : text.replace(/[:\s]+$/, '');
}
