// ============================================================================
// /warehouse — the pure half of GET /api/warehouse/queue (public.warehouse_queue,
// migration 20260943001200). Plan Фаза 9, owner 30.09.2026.
//
//   tab send        confirmed orders with no MEX parcel — each row evaluated exactly as
//                   POST /warehouse/mex-push will evaluate it (mexPush.ts evaluateOrder):
//                   validation badges, the account suggestion + why, the double-parcel
//                   evidence, the 10-day no-parcel clock.
//   tab pack        parcels at MEX 8 "Shipment created" = за пакување (both accounts,
//                   collabBox-booked and MEX-only ones too), ≤ 14 days.
//   tab pack_stale  the same, older (labels nobody picked up).
//
// Money (the order value, the parcel COD) is for business owners only: every key
// ending in _eur / _mkd is dropped for anyone else, recursively.
//
// Dependency-free on purpose: vitest runs warehouseQueue.test.ts in Node.
// ============================================================================

import {
  accountOpen, evaluateOrder, noParcelDaysLeft, readMexPushSettings,
  type MexAccount, type MexPushSettings, type PushOrder,
} from "./mexPush.ts";

export const WAREHOUSE_TABS = ["send", "pack", "pack_stale"] as const;
export type WarehouseTab = typeof WAREHOUSE_TABS[number];
/** The cohort departments (cohort_order_source) — Менаџмент 7th since 20260947001000. */
export const WAREHOUSE_DEPARTMENTS = ["altercpa", "elyon_crm", "teleshop_out", "teleshop_other", "social", "web", "management"] as const;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface QueueParams { tab: WarehouseTab; departments: string[] | null; order: "oldest" | "newest"; limit: number; offset: number }

/** ?tab=&departments=a,b&order=&limit=&offset= → the RPC arguments, or an error code. */
export function parseQueueParams(q: { get(name: string): string | null }): { ok: true; params: QueueParams } | { ok: false; error: string } {
  const tab = (q.get("tab") || "send").trim();
  if (!(WAREHOUSE_TABS as readonly string[]).includes(tab)) return { ok: false, error: "invalid_tab" };
  const order = (q.get("order") || "oldest").trim();
  if (order !== "oldest" && order !== "newest") return { ok: false, error: "invalid_order" };
  const rawDeps = (q.get("departments") || "").trim();
  let departments: string[] | null = null;
  if (rawDeps && rawDeps !== "all") {
    departments = [...new Set(rawDeps.split(",").map((s) => s.trim()).filter(Boolean))];
    if (departments.some((d) => !(WAREHOUSE_DEPARTMENTS as readonly string[]).includes(d))) return { ok: false, error: "invalid_department" };
  }
  const limit = q.get("limit") == null ? DEFAULT_LIMIT : Math.trunc(Number(q.get("limit")));
  const offset = q.get("offset") == null ? 0 : Math.trunc(Number(q.get("offset")));
  if (!Number.isFinite(limit) || limit < 1 || limit > MAX_LIMIT) return { ok: false, error: "invalid_limit" };
  if (!Number.isFinite(offset) || offset < 0 || offset > 100_000) return { ok: false, error: "invalid_offset" };
  return { ok: true, params: { tab: tab as WarehouseTab, departments, order, limit, offset } };
}

const MONEY_KEY_RE = /(_eur|_mkd)$/;

/** Drop every money key (…_eur / …_mkd) at any depth — the non-owner view. */
export function stripMoney<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripMoney) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (MONEY_KEY_RE.test(k)) continue;
      out[k] = stripMoney(x);
    }
    return out as T;
  }
  return v;
}

/** One send row + what the push will make of it. `payload` is left out (the dry run shows it). */
export function enrichSendRow(row: PushOrder, settings: MexPushSettings, now: Date = new Date()): Record<string, unknown> {
  const ev = evaluateOrder(row, null, now);
  const suggested: MexAccount | null = ev.decision.account;
  return {
    ...row,
    validation: { ok: ev.missing.length === 0, missing: ev.missing },
    account: {
      suggested,
      basis: ev.decision.basis,
      reasons: ev.decision.reasons,
      needs_pick: ev.decision.needs_pick,
      line_profiles: ev.decision.line_profiles,
      department_profile: ev.decision.department_profile,
      team_profile: ev.decision.team_profile,
      open: suggested ? accountOpen(settings, suggested) : false,
    },
    warnings: ev.warnings,
    blockers: ev.blockers,
    no_parcel_days_left: noParcelDaysLeft(row, now),
    zone: { id: row.mex_city_id ?? null, name: row.mex_city_name ?? null },
  };
}

export interface QueueContext {
  isOwner: boolean;
  settingsValue: unknown;
  keys: Record<MexAccount, boolean>;
  canPush: boolean;
  canToggle: boolean;
  now?: Date;
}

/** The RPC payload → the response: rows enriched (send), money stripped unless owner, the switch state. */
export function buildQueueResponse(rpc: Record<string, unknown> | null, ctx: QueueContext): Record<string, unknown> {
  const now = ctx.now ?? new Date();
  const settings = readMexPushSettings(ctx.settingsValue);
  const body = { ...(rpc ?? {}) } as Record<string, unknown>;
  const rows = Array.isArray(body.rows) ? body.rows as PushOrder[] : [];
  body.rows = body.tab === "send" ? rows.map((r) => enrichSendRow(r, settings, now)) : rows;
  body.push = {
    enabled: settings.enabled,
    accounts: settings.accounts,
    max_per_send: settings.max_per_send,
    auto_send_at: settings.auto_send_at,
    auto_send_scheduled: false,          // built, not scheduled (owner 30.09.2026)
    keys: ctx.keys,
    can_push: ctx.canPush,
    can_toggle: ctx.canToggle,
  };
  body.money = ctx.isOwner;
  return ctx.isOwner ? body : stripMoney(body);
}
