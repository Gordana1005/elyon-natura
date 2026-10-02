// Pure helpers of the TV leaderboard: department tones, rank accents, the team
// label and the time formatting (kept apart from the components so React fast
// refresh can reload them).
import type { TFunction } from 'i18next';
import i18n from '@/i18n';
import type { Department } from '@/lib/leaderboardV2';
import { isLegacyTeam, splitTeamFilter, teamLaneLabel } from '@/lib/teamLines';

/** The board's columns (owner 02.10.2026: "колку е вкупен број на продажби, просек на продажба и време во ЦРМ" — and the
 *  total value with them): rank · person · sales · value · average sale · time on the CRM; without money (non-owners)
 *  neither money column. */
export const tvGrid = (money: boolean) => (money
  ? 'grid-cols-[5%_35%_10%_15%_16%_19%]'
  : 'grid-cols-[5%_57%_15%_23%]');

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

/**
 * A team as the board names it; with a lane, the owner's words for the pair ("Телешоп
 * предикција", "Affiliate лидови", "Социјални мрежи"). A filter value 'team:lane' works too,
 * and so do the legacy aliases of an old TV link (tvBoard.alias.*).
 */
export function teamLabel(t: TFunction, key: string | null, name?: string | null, lane?: string | null): string {
  if (!key || key === 'none') return t('leaderboard2.team.none');
  const { team, lane: fromKey } = splitTeamFilter(key);
  const l = lane ?? fromKey;
  if (!team) return t('leaderboard2.team.none');
  const base = t(`tvBoard.team.${team}`, { defaultValue: name || team });
  return teamLaneLabel(t, team, l, base);
}

/** The label of a filter value on the bar: a legacy alias (an old ?team= / ?mode= link) says what
 *  it shows now — the old team's rows plus the lane it became. */
export function filterTeamLabel(t: TFunction, key: string, name?: string | null): string {
  if (isLegacyTeam(key)) return t(`tvBoard.alias.${key}`, { defaultValue: teamLabel(t, key, name) });
  return teamLabel(t, key, name);
}
