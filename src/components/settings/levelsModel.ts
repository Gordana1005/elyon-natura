// Поставки → Пристап и улоги (owner 03.10.2026) — the pure half of LevelsSection: the department
// groups, the edit draft and its client-side refusals (mirrors supabase/functions/api/accessAdmin.ts
// validateAccessPut / access_write — the api and the SQL stay the authority), the search filter and
// the per-level counts. No React; unit-tested in levelsModel.test.ts.
import type { AccessLevel } from '@/lib/access';
import { ACCESS_LEVEL_ORDER } from '@/lib/roles';
import { TEAM_CENTAR_DEPTS, TEAM_MADZARI_DEPTS } from '@/lib/deptScope';

/** The seven departments (cohort keys), the app's display order. */
export const DEPT_ORDER = ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management'] as const;

/** The department checkboxes, grouped as the owner names them: Тим Центар · Тим Маџари · Веб · Менаџмент. */
export const DEPT_GROUPS: readonly { id: 'centar' | 'madzari' | 'web' | 'management'; keys: readonly string[] }[] = [
  { id: 'centar', keys: TEAM_CENTAR_DEPTS },
  { id: 'madzari', keys: TEAM_MADZARI_DEPTS },
  { id: 'web', keys: ['web'] },
  { id: 'management', keys: ['management'] },
];

/** Levels that see money company-wide (can_see_revenue). */
export const COMPANY_WIDE_LEVELS: readonly AccessLevel[] = ['super_admin', 'owner', 'finance', 'administrator'];
/** Levels that hold departments: a dept_admin needs ≥ 1, a team_lead may have some. */
export const DEPT_LEVELS: readonly AccessLevel[] = ['dept_admin', 'team_lead'];
export const takesDepts = (level: string): boolean => (DEPT_LEVELS as readonly string[]).includes(level);

/** Departments in display order, distinct, known keys only. */
export const sortDepts = (keys: readonly string[]): string[] => DEPT_ORDER.filter((k) => keys.includes(k));

export function toggleDept(list: readonly string[], key: string): string[] {
  return sortDepts(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
}

/** A group's header checkbox: every key on → off; otherwise all on. */
export function toggleGroup(list: readonly string[], keys: readonly string[]): string[] {
  const allOn = keys.every((k) => list.includes(k));
  return sortDepts(allOn ? list.filter((k) => !keys.includes(k)) : [...list, ...keys]);
}

export function groupState(list: readonly string[], keys: readonly string[]): boolean | 'indeterminate' {
  const on = keys.filter((k) => list.includes(k)).length;
  return on === 0 ? false : on === keys.length ? true : 'indeterminate';
}

/** What a person's money covers, for the list: company-wide, their departments, or no money. */
export type MoneyScope = { kind: 'company' } | { kind: 'depts'; keys: string[] } | { kind: 'none'; keys: string[] };
export function moneyScopeOf(level: string, departments: readonly string[]): MoneyScope {
  if ((COMPANY_WIDE_LEVELS as readonly string[]).includes(level)) return { kind: 'company' };
  if (level === 'dept_admin') return { kind: 'depts', keys: sortDepts(departments) };
  // a team_lead's departments mark the team; no money either way
  return { kind: 'none', keys: level === 'team_lead' ? sortDepts(departments) : [] };
}

// ── the edit draft ─────────────────────────────────────────────────────────

export interface AccessDraft { level: AccessLevel; departments: string[]; note: string }
export interface AccessPersonLike {
  user_id: string; level: AccessLevel; explicit?: boolean; departments: readonly string[]; note: string | null;
  roles?: readonly string[]; last_super_admin?: boolean;
}

export const draftOf = (p: AccessPersonLike): AccessDraft => ({
  level: p.level, departments: sortDepts(p.departments), note: p.note ?? '',
});

/** The departments the draft would save: none for a level that holds none. */
export const draftDepts = (d: AccessDraft): string[] => (takesDepts(d.level) ? sortDepts(d.departments) : []);

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Anything to save? A person with no row (explicit = false) saving their shown level DOES write a
 *  row — that is a change (their level stops following the role rule). */
export function draftChanged(p: AccessPersonLike, d: AccessDraft): boolean {
  if (p.explicit === false) return true;
  return d.level !== p.level
    || !sameList(draftDepts(d), takesDepts(p.level) ? sortDepts(p.departments) : [])
    || d.note.trim() !== (p.note ?? '').trim();
}

/**
 * Why the draft cannot be saved (a settingsPage.err.* code), or null — the client's copy of the
 * api's refusals: the last super admin, a dept_admin with no department, the 500-character note.
 */
export function draftError(p: AccessPersonLike, d: AccessDraft): string | null {
  if (p.last_super_admin && d.level !== 'super_admin') return 'last_super_admin';
  if (d.level === 'dept_admin' && draftDepts(d).length === 0) return 'dept_required';
  if (d.note.trim().length > 500) return 'note_too_long';
  return null;
}

/** The PUT body: the note only when it changed ("" clears it). */
export function bodyOf(p: AccessPersonLike, d: AccessDraft): { level: AccessLevel; departments: string[]; note?: string } {
  const note = d.note.trim();
  return {
    level: d.level,
    departments: draftDepts(d),
    ...(note !== (p.note ?? '').trim() ? { note } : {}),
  };
}

// ── the list ───────────────────────────────────────────────────────────────

/** Case-insensitive match on the name or e-mail (every word must match); `level` 'all' = any. */
export function filterPeople<T extends { full_name: string | null; email: string | null; level: string }>(
  people: readonly T[], query: string, level: string,
): T[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return people.filter((p) => {
    if (level !== 'all' && p.level !== level) return false;
    if (!words.length) return true;
    const hay = `${p.full_name ?? ''} ${p.email ?? ''}`.toLocaleLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** How many people hold each level, in the level order; levels nobody holds are left out. */
export function levelCounts(people: readonly { level: string }[]): { level: AccessLevel; count: number }[] {
  return ACCESS_LEVEL_ORDER
    .map((level) => ({ level, count: people.filter((p) => p.level === level).length }))
    .filter((x) => x.count > 0);
}
