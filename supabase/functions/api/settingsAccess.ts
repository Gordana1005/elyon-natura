// Settings → Пристап по улога / Правила (Phase 10, 2026-10-01): the pure half of
//   PUT /api/settings/modules           { module_key, is_enabled }
//   PUT /api/settings/role-permissions  { role, module_key, can_view?, can_edit? }
//   PUT /api/settings/privacy           { role, flag, value }
//   GET /api/settings/meta              → who changed each setting last, and when
// plus the owners-list removal guard of DELETE /api/business-owners/:id.
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// settingsAccess.test.ts against this file in Node, and index.ts imports it.
//
// Before this module the browser wrote module_settings / role_permissions /
// role_privacy straight through PostgREST: one click, no confirm, no audit_log
// row. Now every change goes through the api (admins only) and leaves one
// audit_log row with the before and after (migration 20260943001500 drops the
// browser write policies). Refusals come back as CODES; the UI has the words.

/** Never switched off from Settings: without them nobody could switch them back on. */
export const PROTECTED_MODULES = ["dashboard", "users", "settings"] as const;

/**
 * Modules whose page is gone (the route only redirects): ads → /webhooks,
 * assigned / prediction_leads → /calls, prediction_lists → /segments,
 * search_prediction → /. Their rows stay (git and the DB keep the history),
 * Settings no longer offers them and the api refuses to change them.
 */
export const DEAD_MODULES = ["ads", "prediction_leads", "assigned", "prediction_lists", "search_prediction"] as const;

/**
 * The roles Settings edits. `admin` always has everything (the api's
 * canViewModule / privCan are admin-first), `affiliate` is an external partner
 * behind its own hard wall, and `agent` / `inbound_agent` are Bulgarian roles
 * nobody here is given (Корисници offers neither).
 */
export const EDITABLE_ROLES = ["manager", "pending_agent", "prediction_agent", "warehouse", "ads_admin"] as const;
export type EditableRole = (typeof EDITABLE_ROLES)[number];

/** The only two permission columns anything reads (api canViewModule / canEditModule, client canAction). */
export const PERMISSION_FLAGS = ["can_view", "can_edit"] as const;
export type PermissionFlag = (typeof PERMISSION_FLAGS)[number];

/**
 * role_privacy columns Settings edits. The two recording columns do nothing
 * while VOIP is off (telephony is deferred), so they are not offered.
 */
export const PRIVACY_FLAGS = [
  "show_customer_phone", "show_customer_name", "show_customer_address", "show_order_history", "show_segment_members",
] as const;
export type PrivacyFlag = (typeof PRIVACY_FLAGS)[number];

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MODULE_RE = /^[a-z0-9_]{1,64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const isEditableRole = (r: unknown): r is EditableRole => (EDITABLE_ROLES as readonly string[]).includes(String(r));
export const isDeadModule = (m: string): boolean => (DEAD_MODULES as readonly string[]).includes(m);

/** HTTP status for a refusal code. Unknown codes are 400. */
export function statusForSettingsCode(code: string): number {
  switch (code) {
    case "admins_only":
    case "owners_only":
      return 403;
    case "unknown_module":
    case "unknown_role":
      return 404;
    case "protected_module":
    case "dead_module":
    case "role_not_editable":
    case "last_owner":
      return 422;
    default:
      return 400;
  }
}

// ── PUT /settings/modules ────────────────────────────────────────────────────
export function parseModulePut(body: unknown): Parsed<{ module_key: string; is_enabled: boolean }> {
  if (!isObj(body)) return { ok: false, error: "invalid_body" };
  const key = typeof body.module_key === "string" ? body.module_key.trim() : "";
  if (!MODULE_RE.test(key)) return { ok: false, error: "invalid_module" };
  if (typeof body.is_enabled !== "boolean") return { ok: false, error: "invalid_value" };
  if (isDeadModule(key)) return { ok: false, error: "dead_module" };
  return { ok: true, value: { module_key: key, is_enabled: body.is_enabled } };
}

/** Why the module row may not be changed (null = go ahead). `row` is the current module_settings row. */
export function moduleRefusal(row: { module_key: string; is_protected?: boolean | null } | null): string | null {
  if (!row) return "unknown_module";
  if (row.is_protected === true || (PROTECTED_MODULES as readonly string[]).includes(row.module_key)) return "protected_module";
  return null;
}

// ── PUT /settings/role-permissions ───────────────────────────────────────────
export interface PermissionPatch { role: EditableRole; module_key: string; can_view?: boolean; can_edit?: boolean }

export function parsePermissionPut(body: unknown): Parsed<PermissionPatch> {
  if (!isObj(body)) return { ok: false, error: "invalid_body" };
  const role = typeof body.role === "string" ? body.role.trim() : "";
  if (!isEditableRole(role)) return { ok: false, error: "role_not_editable" };
  const key = typeof body.module_key === "string" ? body.module_key.trim() : "";
  if (!MODULE_RE.test(key)) return { ok: false, error: "invalid_module" };
  if (isDeadModule(key)) return { ok: false, error: "dead_module" };
  // Only view / edit exist here; create / delete / export are read by nothing.
  for (const k of Object.keys(body)) {
    if (k !== "role" && k !== "module_key" && !(PERMISSION_FLAGS as readonly string[]).includes(k)) {
      return { ok: false, error: "invalid_flag" };
    }
  }
  const out: PermissionPatch = { role, module_key: key };
  for (const f of PERMISSION_FLAGS) {
    if (body[f] === undefined) continue;
    if (typeof body[f] !== "boolean") return { ok: false, error: "invalid_value" };
    out[f] = body[f] as boolean;
  }
  if (out.can_view === undefined && out.can_edit === undefined) return { ok: false, error: "invalid_value" };
  return { ok: true, value: out };
}

/**
 * The row after the patch. Edit without view means nothing, so switching edit
 * on switches view on, and switching view off switches edit off.
 */
export function nextPermission(
  cur: { can_view?: boolean | null; can_edit?: boolean | null } | null,
  patch: { can_view?: boolean; can_edit?: boolean },
): { can_view: boolean; can_edit: boolean } {
  let view = patch.can_view ?? (cur?.can_view === true);
  let edit = patch.can_edit ?? (cur?.can_edit === true);
  if (patch.can_edit === true) view = true;
  if (patch.can_view === false) edit = false;
  if (!view) edit = false;
  return { can_view: view, can_edit: edit };
}

// ── PUT /settings/privacy ────────────────────────────────────────────────────
export function parsePrivacyPut(body: unknown): Parsed<{ role: EditableRole; flag: PrivacyFlag; value: boolean }> {
  if (!isObj(body)) return { ok: false, error: "invalid_body" };
  const role = typeof body.role === "string" ? body.role.trim() : "";
  if (!isEditableRole(role)) return { ok: false, error: "role_not_editable" };
  const flag = typeof body.flag === "string" ? body.flag.trim() : "";
  if (!(PRIVACY_FLAGS as readonly string[]).includes(flag)) return { ok: false, error: "invalid_flag" };
  if (typeof body.value !== "boolean") return { ok: false, error: "invalid_value" };
  return { ok: true, value: { role, flag: flag as PrivacyFlag, value: body.value } };
}

// ── GET /settings/meta ───────────────────────────────────────────────────────
/** audit_log actions whose newest row the Settings page shows as "last changed". */
export const META_ACTIONS = [
  "settings.module_toggle", "settings.role_permission", "settings.privacy", "settings.app_settings",
  "settings.altercpa_push_toggle", "settings.no_parcel_rule_mode", "settings.no_parcel_rule_days",
  "settings.courier_rates", "leaderboard.token", "business_owner.add", "business_owner.remove",
] as const;

export interface MetaEntry { at: string | null; by: string | null; by_name: string | null }
export interface SettingsMeta {
  /** app_settings key → its row's updated_at / updated_by, or the newer audit row for that key. */
  app_settings: Record<string, MetaEntry>;
  /** audit action → its newest row. */
  audit: Record<string, MetaEntry & { target: string | null }>;
}

const newer = (a: string | null | undefined, b: string | null | undefined) =>
  !a ? false : !b ? true : new Date(a).getTime() > new Date(b).getTime();

/**
 * Who changed each setting last. app_settings.updated_by is null for seeded
 * rows and for writes made in SQL, so the audit row for the same key (action
 * settings.app_settings / settings.altercpa_push_toggle / …, target_id = key)
 * wins when it is newer or when it names a person the row does not.
 */
export function buildSettingsMeta(
  appRows: { key: string; updated_at: string | null; updated_by: string | null }[],
  auditRows: { action: string; actor_id: string | null; target_id: string | null; created_at: string }[],
  names: Record<string, string | null | undefined>,
): SettingsMeta {
  const nameOf = (id: string | null) => (id ? (names[id] ?? null) : null);
  const app: Record<string, MetaEntry> = {};
  for (const r of appRows ?? []) {
    app[r.key] = { at: r.updated_at ?? null, by: r.updated_by ?? null, by_name: nameOf(r.updated_by ?? null) };
  }
  const audit: SettingsMeta["audit"] = {};
  for (const r of auditRows ?? []) {
    const cur = audit[r.action];
    if (!cur || newer(r.created_at, cur.at)) {
      audit[r.action] = { at: r.created_at, by: r.actor_id, by_name: nameOf(r.actor_id), target: r.target_id ?? null };
    }
    // An audit row about one app_settings key: it names the person.
    if (r.target_id && r.target_id in app) {
      const a = app[r.target_id];
      if (newer(r.created_at, a.at) || (!a.by && a.at && Math.abs(new Date(a.at).getTime() - new Date(r.created_at).getTime()) < 120_000)) {
        app[r.target_id] = { at: newer(r.created_at, a.at) ? r.created_at : a.at, by: r.actor_id, by_name: nameOf(r.actor_id) };
      }
    }
  }
  return { app_settings: app, audit };
}

// ── DELETE /business-owners/:id ──────────────────────────────────────────────
/**
 * Since 28.09 every active admin sees the money whatever the list says
 * (is_business_owner(), 20260939000500), so removing a name from the list only
 * has to be refused when NOBODY would be left: no other list row and no active
 * admin. (Before that the last list row could never go.)
 */
export function ownerRemovalBlocked(p: { listCountBefore: number; activeAdmins: number }): boolean {
  return Math.max(0, p.listCountBefore - 1) + Math.max(0, p.activeAdmins) === 0;
}

// ── PATCH /courier-rates ─────────────────────────────────────────────────────
/** MEX is the carrier; Econt / Speedy stay editable for the Bulgarian history the reports still price. */
export const COURIERS = ["mex", "econt", "speedy"] as const;
export const COURIER_SERVICES = ["door", "office"] as const;

export function parseCourierRates(body: unknown): Parsed<{ courier: string; service: string; deliver_cost: number; return_cost: number }[]> {
  const rows = isObj(body) && Array.isArray(body.rates) ? body.rates : Array.isArray(body) ? body : null;
  if (!rows || rows.length === 0) return { ok: false, error: "invalid_body" };
  if (rows.length > 12) return { ok: false, error: "invalid_body" };
  const out: { courier: string; service: string; deliver_cost: number; return_cost: number }[] = [];
  for (const r of rows) {
    if (!isObj(r)) return { ok: false, error: "invalid_body" };
    if (!(COURIERS as readonly string[]).includes(String(r.courier)) || !(COURIER_SERVICES as readonly string[]).includes(String(r.service))) {
      return { ok: false, error: "invalid_courier" };
    }
    const d = Number(r.deliver_cost);
    const ret = Number(r.return_cost);
    // EUR, stored with 4 decimals (MEX 150 ден = 2,4390 €). 0–100 € per parcel.
    if (!Number.isFinite(d) || d < 0 || d > 100 || !Number.isFinite(ret) || ret < 0 || ret > 100) {
      return { ok: false, error: "invalid_value" };
    }
    out.push({
      courier: String(r.courier), service: String(r.service),
      deliver_cost: Math.round(d * 10_000) / 10_000, return_cost: Math.round(ret * 10_000) / 10_000,
    });
  }
  return { ok: true, value: out };
}
