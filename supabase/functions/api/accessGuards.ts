// ============================================================================
// Route guards + money strips that need no business decision (owner audit
// 02.10.2026 — exports/roles/current-state-2026-10-02.md §4 gaps, §5 money).
//
// Owners = public.is_business_owner() (business_owners OR an active admin).
// Everyone else gets the same payload with the money keys ABSENT — the
// stripOverviewMoney pattern (overview.ts): a whitelist where one exists, so a
// money field added later is dropped for non-owners by default.
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// accessGuards.test.ts against this file in Node, and index.ts imports it.
// ============================================================================

const MONEY_KEY_RE = /(_eur|_mkd)$/;

// ── GET /dashboard-stats (Табла "My performance") ───────────────────────────

/**
 * Every key a non-owner admin / manager may receive from the admin branch of
 * GET /dashboard-stats (computeMetrics + its envelope). Counts, windows and the
 * per-day / per-status / per-product COUNT maps stay; total_value,
 * paid_revenue, payout_earned — and any key added later — are dropped.
 * `personalMetrics` is stripped with the same list.
 */
const DASHBOARD_NON_MONEY_KEYS = new Set<string>([
  "lead_count", "deals_won", "deals_lost", "tasks_completed", "total_orders",
  "daily", "statusCounts", "orders_from_standard", "orders_from_leads",
  "products_sold", "units_sold",
  "packages_sold", "packages_awaiting", "packages_returned", "returns_orders",
  "from", "to", "period", "isDualRole", "personalMetrics",
]);

/** GET /dashboard-stats for a non-owner admin / manager: the counts, no money. `money: false` says so. */
export function stripDashboardMoney(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (!DASHBOARD_NON_MONEY_KEYS.has(k) || MONEY_KEY_RE.test(k)) continue;
    if (k === "personalMetrics") {
      out[k] = v && typeof v === "object" && !Array.isArray(v)
        ? stripDashboardMoney(v as Record<string, unknown>)
        : v ?? null;
      continue;
    }
    out[k] = v;
  }
  out.money = false;
  return out;
}

// ── GET /agent-payouts* ─────────────────────────────────────────────────────

/**
 * The agent a payout READ is scoped to. An owner may ask for anyone (or
 * everyone: null); anyone else reads only their own commission, whatever
 * agent_id they pass.
 */
export function payoutReadAgentId(isOwner: boolean, requested: string | null, selfId: string): string | null {
  if (!isOwner) return selfId;
  return requested && requested.length ? requested : null;
}

/** May this caller read one settlement (GET /agent-payouts/:id[/report])? */
export function canReadPayout(isOwner: boolean, payoutAgentId: string | null | undefined, selfId: string): boolean {
  return isOwner || (!!payoutAgentId && payoutAgentId === selfId);
}

// ── GET /app-settings ───────────────────────────────────────────────────────

/**
 * The app_settings keys the UI reads as a non-admin (every caller of
 * apiGetAppSettings in src/):
 *   personal_list_max_holds  — PersonalListButton, PersonalListPage (the "/N" cap)
 *   unpaid_chase_days(_stop) — MyOrdersSection (the agent's chase hint)
 *   disposition_note_min     — the cancel / trash note minimum (the server's own default)
 *   promo_of_the_day         — Скрипти → Промо (a manager writer)
 *   altercpa_push_enabled    — /orders (the CPA push button's switch)
 */
export const APP_SETTINGS_STAFF_KEYS = [
  "personal_list_max_holds",
  "unpaid_chase_days",
  "unpaid_chase_stop_days",
  "disposition_note_min",
  "promo_of_the_day",
  "altercpa_push_enabled",
] as const;

/**
 * Added for a manager: Поставки → Правила, which a manager sees read-only
 * (RulesSection): the no-parcel rule and the presence idle alert.
 */
export const APP_SETTINGS_MANAGER_KEYS = [
  "no_parcel_rule",
  "presence_idle_alert_minutes",
  "presence_idle_alert_hours",
  "presence_idle_alert_recipients",
  "presence_idle_alert_scope",
] as const;

/**
 * GET /app-settings as the caller may see it: an admin everything (as before);
 * a manager the staff keys + the read-only Правила keys; everyone else the
 * staff keys only. Bonus rules, the MEX-cash viewers, the stock / shops / MEX
 * push switches, the VOIP bundle (Settings → Телефонија is admin-only) and
 * every key added later stay with the admins.
 */
export function appSettingsForViewer(
  all: Record<string, unknown>,
  viewer: { admin: boolean; manager: boolean },
): Record<string, unknown> {
  if (viewer.admin) return all;
  const keys: readonly string[] = viewer.manager
    ? [...APP_SETTINGS_STAFF_KEYS, ...APP_SETTINGS_MANAGER_KEYS]
    : APP_SETTINGS_STAFF_KEYS;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (all[k] !== undefined) out[k] = all[k];
  return out;
}

// ── GET /users/agents ───────────────────────────────────────────────────────

const CONTACT_KEYS = ["email", "phone", "phone_number", "mobile"] as const;

/** GET /users/agents for a non-admin: names, ids and roles — no e-mail or phone. */
export function stripAgentContacts<T extends Record<string, unknown>>(rows: readonly T[], isAdmin: boolean): T[] {
  if (isAdmin) return [...rows];
  return rows.map((r) => {
    const x: Record<string, unknown> = { ...r };
    for (const k of CONTACT_KEYS) delete x[k];
    return x as T;
  });
}

// ── GET /warehouse/incoming-orders ──────────────────────────────────────────

const ROW_MONEY_KEYS = new Set<string>(["price", "actual_logistics_cost"]);
const LINE_MONEY_KEYS = ["price_per_unit", "total_price"] as const;

/**
 * One incoming-orders row (an order or an unconverted lead — the list's shape,
 * or the full orders / prediction_leads row PATCH answers with) without its
 * money: price, the line prices, every *_eur / *_mkd column (mex_cod_mkd …).
 */
export function stripIncomingOrderMoney<T extends Record<string, unknown>>(row: T): T {
  const x: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    if (ROW_MONEY_KEYS.has(k) || MONEY_KEY_RE.test(k)) continue;
    x[k] = v;
  }
  if (Array.isArray(row?.order_items)) {
    x.order_items = (row.order_items as Record<string, unknown>[]).map((it) => {
      const y: Record<string, unknown> = { ...it };
      for (const k of LINE_MONEY_KEYS) delete y[k];
      return y;
    });
  }
  return x as T;
}

// ── GET /orders/bookings ────────────────────────────────────────────────────

/** The bookings response for a non-owner: every row without value_mkd (as order_origin drops its *_mkd). */
export function stripBookingsMoney<T extends { rows: readonly Record<string, unknown>[] }>(resp: T): T {
  return {
    ...resp,
    rows: resp.rows.map((r) => {
      const x: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (!MONEY_KEY_RE.test(k)) x[k] = v;
      return x;
    }),
  };
}

// ── PATCH /products/:id ─────────────────────────────────────────────────────

/** The product fields only an admin may change: they feed every order's value and the catalogue. */
export const PRODUCT_ADMIN_FIELDS = ["name", "price", "is_active"] as const;

/**
 * The admin-only fields a product patch would actually CHANGE against the
 * stored row (an unchanged value a form re-sends is not a change). Empty =
 * a non-admin may apply it.
 */
export function productAdminFieldChanges(
  update: Record<string, unknown>,
  current: Record<string, unknown> | null | undefined,
): string[] {
  const out: string[] = [];
  for (const k of PRODUCT_ADMIN_FIELDS) {
    if (!(k in update)) continue;
    const next = update[k];
    const prev = current?.[k];
    const same = k === "price"
      ? prev != null && Number(prev) === Number(next)
      : k === "name"
        ? String(prev ?? "").trim() === String(next ?? "").trim()
        : prev === next;
    if (!same) out.push(k);
  }
  return out;
}
