import type { TFunction } from 'i18next';
import { departmentLabel } from '@/lib/orderSource';

/**
 * A dept_admin's money scope (access levels, migration 20260947001600): the departments
 * (cohort keys) whose revenue / наплата / returns they may see. The api narrows every payload
 * to them (meta.dept_scope); the UI only says WHICH, so a figure is never read as company-wide.
 *
 * Тим Центар = its three departments (In · Out · Социјални мрежи); Тим Маџари = its two
 * (In · Out). Always the full name with "Тим" (owner, 02.10.2026).
 */
export const TEAM_CENTAR_DEPTS: readonly string[] = ['teleshop_out', 'teleshop_other', 'social'];
export const TEAM_MADZARI_DEPTS: readonly string[] = ['altercpa', 'elyon_crm'];

/** Which line team a scope belongs to: every key inside one team's departments → that team;
 *  an empty, mixed or unknown scope → null. Pure. */
export function scopeTeam(keys: readonly string[] | null | undefined): 'teleshop' | 'affiliate' | null {
  if (!keys || keys.length === 0) return null;
  if (keys.every((k) => TEAM_CENTAR_DEPTS.includes(k))) return 'teleshop';
  if (keys.every((k) => TEAM_MADZARI_DEPTS.includes(k))) return 'affiliate';
  return null;
}

/** The scope's label: "Тим Центар" / "Тим Маџари" when the keys sit inside one team, else the
 *  department names joined (" · "), the raw key for one the app does not know. null for no scope. */
export function scopeTeamLabel(keys: readonly string[] | null | undefined, t: TFunction): string | null {
  if (!keys || keys.length === 0) return null;
  const team = scopeTeam(keys);
  if (team) return t(`insights.agents.team.byKey.${team}`);
  return keys.map((k) => departmentLabel(t, k) ?? k).join(' · ');
}
