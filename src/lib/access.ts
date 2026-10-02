/**
 * Access levels (migration 20260947001600_access_levels) — the pure part: the person's ONE money
 * level and its scope as get_my_permissions() sends them, read strictly. PermissionsProvider
 * (src/contexts/PermissionsContext.tsx) holds the state; this module has no React. UX only: the
 * api enforces every rule server-side.
 */

/** One money level per person (migration 20260947001600_access_levels). */
export type AccessLevel =
  | 'super_admin' | 'owner' | 'finance' | 'administrator' | 'dept_admin'
  | 'team_lead' | 'operator' | 'warehouse' | 'partner';

const ACCESS_LEVELS: ReadonlySet<string> = new Set<AccessLevel>([
  'super_admin', 'owner', 'finance', 'administrator', 'dept_admin', 'team_lead', 'operator', 'warehouse', 'partner',
]);

/** The money part of get_my_permissions(), parsed STRICTLY: a missing or malformed key is the
 *  restrictive answer (false; deptScope null; mexCashDepartments [] unless the whole tab is
 *  granted). Pure — PermissionsProvider uses it and the tests pin it. UX only: the api enforces. */
export interface MoneyAccess {
  accessLevel: AccessLevel | null;
  deptScope: string[] | null;
  canSeeMargins: boolean;
  canSeeRevenue: boolean;
  canSeeMexCash: boolean;
  mexCashDepartments: string[] | null;
}

export const NO_MONEY_ACCESS: MoneyAccess = {
  accessLevel: null, deptScope: null, canSeeMargins: false, canSeeRevenue: false,
  canSeeMexCash: false, mexCashDepartments: [],
};

function stringList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

export function parseMoneyAccess(payload: Record<string, unknown> | null | undefined): MoneyAccess {
  if (!payload) return NO_MONEY_ACCESS;
  const lvl = payload.accessLevel;
  const accessLevel = typeof lvl === 'string' && ACCESS_LEVELS.has(lvl) ? (lvl as AccessLevel) : null;
  const canSeeMexCash = payload.canSeeMexCash === true;
  const mexList = stringList(payload.mexCashDepartments);
  return {
    accessLevel,
    // Only a dept_admin is scoped; anyone else's `departments` (null = all, [] = none) is read
    // through canSeeRevenue instead, so a stray list can never narrow or widen them.
    deptScope: accessLevel === 'dept_admin' ? (stringList(payload.departments) ?? []) : null,
    canSeeMargins: payload.canSeeMargins === true,
    canSeeRevenue: payload.canSeeRevenue === true,
    canSeeMexCash,
    // null (the whole tab) only with the explicit whole-tab grant; a missing list = none.
    mexCashDepartments: canSeeMexCash ? null : (mexList ?? []),
  };
}

/** The departments a scoped view may offer, in the given display order: null = not scoped
 *  (every key), else the order's keys inside the scope. Pure. */
export function scopedKeys<K extends string>(order: readonly K[], scope: readonly string[] | null | undefined): K[] | null {
  return Array.isArray(scope) ? order.filter((k) => scope.includes(k)) : null;
}
