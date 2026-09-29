// Pure helpers of the TV leaderboard: department tones, rank accents, the team
// label and the time formatting (kept apart from the components so React fast
// refresh can reload them).
import type { TFunction } from 'i18next';
import i18n from '@/i18n';
import type { Department } from '@/lib/leaderboardV2';

/** The board's columns: rank · person · departments · total · worked · time on the CRM. */
export const TV_GRID = 'grid-cols-[4%_25%_35%_13%_9%_14%]';

/** One tone per department — the same order and meaning everywhere on the board. */
export const DEPT_TONE: Record<Department, string> = {
  altercpa: 'bg-sky-400/15 text-sky-100 ring-sky-300/40',
  elyon_crm: 'bg-indigo-400/15 text-indigo-100 ring-indigo-300/40',
  teleshop_out: 'bg-amber-400/15 text-amber-100 ring-amber-300/40',
  teleshop_other: 'bg-teal-400/15 text-teal-100 ring-teal-300/40',
  social: 'bg-pink-400/15 text-pink-100 ring-pink-300/40',
  web: 'bg-emerald-400/15 text-emerald-100 ring-emerald-300/40',
};

/** The department's colour as text (+ border-current) — the dashed collabBox booking chips. */
export const DEPT_TEXT: Record<Department, string> = {
  altercpa: 'text-sky-200',
  elyon_crm: 'text-indigo-200',
  teleshop_out: 'text-amber-200',
  teleshop_other: 'text-teal-200',
  social: 'text-pink-200',
  web: 'text-emerald-200',
};

/** Clock times of the data are Skopje wall-clock, whatever the TV's own zone. */
export const hhmm = (iso: string | null | undefined) => (iso
  ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Skopje' })
  : '');

export function fmtDur(min: number) {
  const m = Math.max(0, Math.round(min || 0));
  if (m < 60) return i18n.t('tvBoard.durM', { m });
  return i18n.t('tvBoard.durHM', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') });
}

export function initials(name: string) {
  return name.split(/[.\s_]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '–';
}

export const RANK_ACCENT: Record<number, string> = {
  1: 'bg-amber-300/15 text-amber-300 ring-amber-300/30',
  2: 'bg-slate-300/15 text-slate-200 ring-slate-300/30',
  3: 'bg-orange-400/15 text-orange-300 ring-orange-400/30',
};

export function teamLabel(t: TFunction, key: string | null, name?: string | null): string {
  if (!key || key === 'none') return t('leaderboard2.team.none');
  return t(`tvBoard.team.${key}`, { defaultValue: name || key });
}
