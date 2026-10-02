import type { TFunction } from 'i18next';
import type { AppRole } from '@/contexts/AuthContext';
import type { AccessLevel } from '@/lib/access';
import { scopeTeamLabel } from '@/lib/deptScope';
import i18n from '@/i18n';

// The three role variants an agent who makes calls can have. They're kept
// separate in the DB for permission granularity, but to users they're all
// just "Call Agent" — no need to surface the internal taxonomy.
const CALL_AGENT_ROLES: AppRole[] = ['agent', 'pending_agent', 'prediction_agent'];

const FRIENDLY_LABEL_KEYS: Partial<Record<AppRole, string>> = {
  manager: 'roles.manager',
  warehouse: 'roles.warehouse',
  ads_admin: 'roles.adsAdmin',
  affiliate: 'roles.affiliate',
};

/** Every access level (migration 20260947001600) — its name is access.level.<level>. */
export const ACCESS_LEVEL_ORDER: readonly AccessLevel[] = [
  'super_admin', 'owner', 'finance', 'administrator', 'dept_admin', 'team_lead', 'operator', 'warehouse', 'partner',
];

/**
 * The levels the top bar names (owner 03.10.2026): Супер Админ · Сопственик · Финансиски ·
 * Администратор · Администратор на оддел. The rest (team_lead / operator / warehouse / partner)
 * say nothing the role label does not, so those people keep their role label.
 */
export const NAMED_ACCESS_LEVELS: readonly AccessLevel[] = ['super_admin', 'owner', 'finance', 'administrator', 'dept_admin'];

const isLevel = (v: unknown): v is AccessLevel => typeof v === 'string' && (ACCESS_LEVEL_ORDER as readonly string[]).includes(v);

/** A level's name in the reader's language; null for anything that is not a level. */
export function accessLevelName(level: string | null | undefined, t: TFunction = i18n.t): string | null {
  return isLevel(level) ? t(`access.level.${level}`) : null;
}

/**
 * The top bar's label from the access level: the level's name for the five named levels, a
 * department admin's with their team ("Администратор на оддел · Тим Центар" — the departments'
 * names when they are not one team's); null for any other level or none (→ the role label).
 */
export function accessLevelLabel(
  level: string | null | undefined,
  deptScope: readonly string[] | null | undefined,
  t: TFunction = i18n.t,
): string | null {
  if (!isLevel(level) || !NAMED_ACCESS_LEVELS.includes(level)) return null;
  const name = accessLevelName(level, t)!;
  if (level !== 'dept_admin') return name;
  const team = scopeTeamLabel(deptScope, t);
  return team ? `${name} · ${team}` : name;
}

/**
 * Human-friendly label for display in the UI.
 * - With an access level that has a name (see NAMED_ACCESS_LEVELS) → that name (+ the team of a
 *   department admin). An app-role admin is no longer called "Superadmin" by the role alone: the
 *   level decides (an administrator is "Администратор").
 * - Otherwise the roles: admin → "Admin"; agent / pending_agent / prediction_agent → one
 *   "Call Agent"; manager / warehouse / ads_admin / affiliate → their own label. Multiple distinct
 *   labels are joined with " + " (e.g. "Manager + Call Agent").
 * Labels come from i18n — callers must subscribe via useTranslation().
 */
export function friendlyRoleLabel(
  roles: AppRole[] | undefined | null,
  access?: { level?: string | null; deptScope?: readonly string[] | null } | null,
): string {
  const byLevel = access ? accessLevelLabel(access.level, access.deptScope) : null;
  if (byLevel) return byLevel;
  if (!roles || roles.length === 0) return '';
  if (roles.includes('admin')) return i18n.t('userRole.admin');

  const labels: string[] = [];
  if (roles.some(r => CALL_AGENT_ROLES.includes(r))) labels.push(i18n.t('roles.callAgent'));
  for (const r of roles) {
    const key = FRIENDLY_LABEL_KEYS[r];
    if (!key) continue;
    const friendly = i18n.t(key);
    if (!labels.includes(friendly)) labels.push(friendly);
  }
  return labels.join(' + ');
}
