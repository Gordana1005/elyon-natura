// ============================================================================
// Settings → Пристап и улоги (owner 03.10.2026) — the pure half of
//   GET /api/settings/access            every active staff login with its access LEVEL + departments
//                                       (super_admin and owner read; everyone else 403 owners_only)
//   PUT /api/settings/access/:userId    { level, departments, note? } → the SQL writer access_set()
//                                       (super_admin only; access_set re-checks and writes the audit row)
// The levels themselves: migration 20260947001600_access_levels.sql (access_level / access_write).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs accessAdmin.test.ts
// against it in Node; index.ts imports it as AAD and puts a zod shape check in front of
// validateAccessPut. Everything here MIRRORS the SQL (access_level's no-row rule, access_write's
// refusals) so the page can say why before it asks — the SQL stays the authority.
// ============================================================================

import { DEPT_KEYS, type DeptKey } from "./accessLevels.ts";

/** The nine levels, in the owner's order (most money first). */
export const ACCESS_LEVELS = [
  "super_admin", "owner", "finance", "administrator", "dept_admin",
  "team_lead", "operator", "warehouse", "partner",
] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/** Levels a staff login may be given here — partner is only for an affiliate-only login (the
 *  partner wall in access_write), and those logins are not listed. */
export const STAFF_LEVELS: readonly AccessLevel[] = ACCESS_LEVELS.filter((l) => l !== "partner");

/** Levels that hold departments: a dept_admin needs at least one, a team_lead may have some. */
export const DEPT_LEVELS: readonly AccessLevel[] = ["dept_admin", "team_lead"];

/** The note is free text about the person's access (user_access.note). */
export const NOTE_MAX = 500;

export const isAccessLevel = (v: unknown): v is AccessLevel => (ACCESS_LEVELS as readonly string[]).includes(String(v));
export const isDeptKey = (v: unknown): v is DeptKey => (DEPT_KEYS as readonly string[]).includes(String(v));

// ── who may read / write ───────────────────────────────────────────────────

/** GET: the super admins and the owner. `marginsActive` = can_see_margins(uid), which is true only
 *  for super_admin / owner / finance WITH an active profile — so a suspended login reads nothing. */
export function canReadAccess(level: string | null, marginsActive: boolean): boolean {
  return marginsActive && (level === "super_admin" || level === "owner");
}

/** PUT: a super admin with an active profile (access_set re-checks the same). */
export function canWriteAccess(level: string | null, marginsActive: boolean): boolean {
  return marginsActive && level === "super_admin";
}

// ── the level of a login with no user_access row ───────────────────────────

/**
 * access_level()'s no-row rule (20260947001600), for the list: business_owners → owner, an ACTIVE
 * admin → administrator, a manager → team_lead, warehouse-only → warehouse, affiliate-only →
 * partner, else operator.
 */
export function fallbackLevel(o: { roles: readonly string[]; isActive: boolean; onOwnersList: boolean }): AccessLevel {
  const roles = o.roles ?? [];
  if (o.onOwnersList) return "owner";
  if (o.isActive && roles.includes("admin")) return "administrator";
  if (roles.includes("manager")) return "team_lead";
  if (roles.includes("warehouse") && roles.every((r) => r === "warehouse")) return "warehouse";
  if (roles.includes("affiliate") && roles.every((r) => r === "affiliate")) return "partner";
  return "operator";
}

/** An external partner: a login whose only role is `affiliate` (the hard wall). */
export const isAffiliateOnly = (roles: readonly string[]): boolean =>
  roles.length > 0 && roles.every((r) => r === "affiliate");

/** Departments trimmed, lower-cased, distinct, in display order; unknown keys reported apart. */
export function normalizeDepts(raw: readonly unknown[] | null | undefined): { depts: DeptKey[]; unknown: string[] } {
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const x of raw ?? []) {
    const k = String(x ?? "").trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (!isDeptKey(k)) unknown.push(k);
  }
  return { depts: DEPT_KEYS.filter((k) => seen.has(k)), unknown };
}

// ── PUT /settings/access/:userId ───────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface AccessPut {
  level: AccessLevel;
  departments: DeptKey[];
  /** undefined = keep the note (access_set p_note NULL); "" = clear it. */
  note: string | undefined;
}

/**
 * The body after the zod shape check, against the target login's roles — the same refusals, in the
 * same order, as access_write():
 *   invalid_level · invalid_department · dept_required (dept_admin with none) ·
 *   depts_not_allowed (departments on a level that holds none) · partner_login (an affiliate-only
 *   login may hold only partner) · partner_only_for_affiliates · note_too_long
 */
export function validateAccessPut(
  body: { level?: unknown; departments?: readonly unknown[] | null; note?: unknown },
  target: { roles: readonly string[] },
): Parsed<AccessPut> {
  const level = String(body.level ?? "").trim().toLowerCase();
  if (!isAccessLevel(level)) return { ok: false, error: "invalid_level" };
  const { depts, unknown } = normalizeDepts(body.departments ?? []);
  if (unknown.length) return { ok: false, error: "invalid_department" };
  if (level === "dept_admin" && depts.length === 0) return { ok: false, error: "dept_required" };
  if (depts.length > 0 && !DEPT_LEVELS.includes(level)) return { ok: false, error: "depts_not_allowed" };
  if (isAffiliateOnly(target.roles ?? [])) {
    if (level !== "partner") return { ok: false, error: "partner_login" };
  } else if (level === "partner") {
    return { ok: false, error: "partner_only_for_affiliates" };
  }
  let note: string | undefined;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string") return { ok: false, error: "invalid_body" };
    note = body.note.trim();
    if (note.length > NOTE_MAX) return { ok: false, error: "note_too_long" };
  } else if (body.note === null) {
    note = "";
  }
  return { ok: true, value: { level, departments: depts, note } };
}

/**
 * Would this change leave the system with no active super admin? (access_write: the person is a
 * super admin now and no OTHER active login holds an explicit super_admin row.)
 */
export function isLastSuperAdmin(
  people: readonly { user_id: string; level: string; explicit: boolean; is_active?: boolean }[],
  userId: string,
): boolean {
  const me = people.find((p) => p.user_id === userId);
  if (!me || me.level !== "super_admin") return false;
  return !people.some((p) => p.user_id !== userId && p.level === "super_admin" && p.explicit && p.is_active !== false);
}

/** access_set() / access_write() exceptions → a code + HTTP status the page translates. */
export function accessSetErrorCode(message: string | null | undefined): { code: string; status: number } | null {
  const m = String(message ?? "");
  if (/only a super admin sets access levels|p_actor must be the caller/i.test(m)) return { code: "super_admins_only", status: 403 };
  if (/last active super admin/i.test(m)) return { code: "last_super_admin", status: 422 };
  if (/needs at least one department/i.test(m)) return { code: "dept_required", status: 400 };
  if (/departments apply only to/i.test(m)) return { code: "depts_not_allowed", status: 400 };
  if (/affiliate \(partner\) login can only hold/i.test(m)) return { code: "partner_login", status: 422 };
  if (/level partner is only for affiliate/i.test(m)) return { code: "partner_only_for_affiliates", status: 400 };
  if (/unknown level/i.test(m)) return { code: "invalid_level", status: 400 };
  if (/unknown department/i.test(m)) return { code: "invalid_department", status: 400 };
  if (/no profile for user/i.test(m)) return { code: "unknown_user", status: 404 };
  return null;
}

// ── GET /settings/access ───────────────────────────────────────────────────

export interface AccessPerson {
  user_id: string;
  full_name: string | null;
  email: string | null;
  roles: string[];
  /** user_access.level, else the no-row rule (explicit = false). */
  level: AccessLevel;
  explicit: boolean;
  /** The OPEN department grants (valid_to IS NULL), display order. */
  departments: DeptKey[];
  note: string | null;
  updated_at: string | null;
  updated_by_name: string | null;
  /** True for the one person whose level may not move off super_admin. */
  last_super_admin: boolean;
}

export interface AccessListInput {
  profiles: readonly { user_id: string; full_name: string | null; email: string | null; is_active: boolean }[];
  roles: readonly { user_id: string; role: string }[];
  access: readonly { user_id: string; level: string; note: string | null; updated_at: string | null; updated_by: string | null }[];
  departments: readonly { user_id: string; dept: string; valid_to: string | null }[];
  owners: readonly { user_id: string }[];
  /** user_id → display name, for updated_by (may name people outside `profiles`). */
  names: Readonly<Record<string, string | null>>;
}

const LEVEL_RANK = new Map<string, number>(ACCESS_LEVELS.map((l, i) => [l, i]));

/**
 * The list the page shows: every ACTIVE login that is staff (any role but affiliate-only — an
 * external partner never appears on a staff surface; a login with no role yet is listed as
 * operator), its level (explicit row or the no-row rule), open departments and note. Ordered by
 * level (most money first), then name.
 */
export function shapeAccessPeople(input: AccessListInput): AccessPerson[] {
  const rolesBy = new Map<string, string[]>();
  for (const r of input.roles) {
    const list = rolesBy.get(r.user_id) ?? [];
    if (!list.includes(r.role)) list.push(r.role);
    rolesBy.set(r.user_id, list);
  }
  const accessBy = new Map(input.access.map((a) => [a.user_id, a]));
  const deptsBy = new Map<string, string[]>();
  for (const d of input.departments) {
    if (d.valid_to !== null && d.valid_to !== undefined) continue;
    const list = deptsBy.get(d.user_id) ?? [];
    list.push(d.dept);
    deptsBy.set(d.user_id, list);
  }
  const owners = new Set(input.owners.map((o) => o.user_id));

  const people: AccessPerson[] = [];
  for (const p of input.profiles) {
    if (!p.is_active) continue;
    const roles = (rolesBy.get(p.user_id) ?? []).slice().sort();
    if (isAffiliateOnly(roles)) continue;
    const row = accessBy.get(p.user_id);
    const explicit = !!row && isAccessLevel(row.level);
    const level: AccessLevel = explicit
      ? (row!.level as AccessLevel)
      : fallbackLevel({ roles, isActive: p.is_active, onOwnersList: owners.has(p.user_id) });
    people.push({
      user_id: p.user_id,
      full_name: p.full_name ?? null,
      email: p.email ?? null,
      roles,
      level,
      explicit,
      departments: normalizeDepts(deptsBy.get(p.user_id) ?? []).depts,
      note: row?.note ?? null,
      updated_at: row?.updated_at ?? null,
      updated_by_name: row?.updated_by ? (input.names[row.updated_by] ?? null) : null,
      last_super_admin: false,
    });
  }
  // access_write counts explicit super_admin rows of active profiles; everyone listed is active.
  for (const p of people) p.last_super_admin = isLastSuperAdmin(people, p.user_id);
  const nameOf = (p: AccessPerson) => (p.full_name || p.email || "").toLocaleLowerCase();
  return people.sort((a, b) =>
    (LEVEL_RANK.get(a.level)! - LEVEL_RANK.get(b.level)!) || nameOf(a).localeCompare(nameOf(b)) || a.user_id.localeCompare(b.user_id));
}
