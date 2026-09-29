// ============================================================================
// Insights → Агенти (Agents) — the pure half of GET /api/insights/agents
// (WP2, 2026-09-28; SQL: migration 20260941000200_insights_people).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// insightsPeople.test.ts against this file in Node, index.ts imports it, and
// scripts/verify-tab-agents.mjs ties the SQL behind it to the cohort.
//
//   peopleAccess()          owner → everything with money · admin / manager →
//                           everyone, counts only · any other holder of the
//                           Insights / Performance module (an agent) → their
//                           OWN person only, counts only · else 403
//   parsePersonParam()      ?person=<sales_people uuid> — the person drill
//   buildPeopleResponse()   insights_people → the tab's payload: meta from the
//                           window, money stripped by a WHITELIST for anyone
//                           but an owner, an agent cut down to themselves
//   stripAgentPerformance() GET /agent-performance for a non-owner: the rows
//                           WITHOUT revenue / profit / AOV (and, for an admin /
//                           manager, without the payout), sorted by paid
//                           count — the bonus math itself is untouched
// ============================================================================

import { MONEY_KEY_RE, stripInsightsMoney } from "./insightsCommon.ts";
import type { InsightsWindow } from "./insightsCommon.ts";

// ── access ──────────────────────────────────────────────────────────────────

export type PeopleAccess = "owner" | "counts" | "self" | "forbidden";

/**
 * Money is owners-only (public.is_business_owner — the owners list or any
 * active admin). A non-owner admin / manager sees every person, counts only.
 * The tab has always been open to agents (the legacy Performance module):
 * they keep it, for THEIR OWN person only and without money.
 */
export function peopleAccess(o: { isOwner: boolean; isAdminOrManager: boolean; canViewTab: boolean }): PeopleAccess {
  if (o.isOwner) return "owner";
  if (o.isAdminOrManager) return "counts";
  if (o.canViewTab) return "self";
  return "forbidden";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ?person=<uuid> (a sales_people id) — absent/empty = no drill. */
export function parsePersonParam(raw: string | null): { ok: true; value: string | null } | { ok: false } {
  const v = raw?.trim() ?? "";
  if (!v) return { ok: true, value: null };
  return UUID_RE.test(v) ? { ok: true, value: v.toLowerCase() } : { ok: false };
}

// ── the money strip (non-owners) ────────────────────────────────────────────

/**
 * Every key a non-owner may receive from GET /api/insights/agents, at any
 * depth. Anything else — every *_mkd figure and any key a later migration
 * adds — is dropped by default; *_mkd / *_eur never pass even when listed.
 */
export const PEOPLE_NON_MONEY_KEYS: ReadonlySet<string> = new Set([
  // envelope
  "meta", "from", "to", "prev_from", "prev_to", "prev_to_end", "partial", "days", "generated_at", "money",
  "clock", "granularity", "presence_since", "stamped_at", "person", "access", "self_unlinked",
  "totals", "teams", "people", "no_seller", "unmapped_work", "spark", "detail",
  // totals
  "sales", "with_person", "without_person", "by_source", "key", "worked", "sale_decisions",
  "cancel_decisions", "trash_decisions", "callback_decisions", "unmapped_decisions", "conversion", "prev",
  // measures (people, members, teams)
  "packages", "buckets", "outside", "via_crm", "via_altercpa", "first_decision_at", "last_decision_at",
  "presence", "online_min", "active_min", "idle_min", "break_min", "idle_alerts", "first_active_at",
  "last_active_at",
  "paid", "paid_legacy", "paid_unproven", "courier", "courier_problem", "label", "to_pack", "returned",
  "cancelled_after_sale", "trashed_after_sale", "replacement",
  "altercpa", "elyon_crm", "social", "teleshop_out", "teleshop_other", "web",
  // teams
  "name", "mode", "kind", "online_now", "break_now", "drill_exact", "members",
  // people
  "person_id", "has_login", "is_manager", "is_active", "identity_kinds", "team_key", "team_role",
  "online_state", "groups",
  // no seller
  "count", "reasons", "reason", "source", "detail", "handles", "via", "handle", "cancelled_by", "altercpa_user",
  "actors", "actor",
  // spark / detail
  "d", "products", "identities", "value", "memberships", "role", "primary",
]);

/** The body an agent receives: themselves (meta, their row, their drill). */
function selfOnly(body: Record<string, unknown>, personId: string | null): Record<string, unknown> {
  const people = Array.isArray(body.people) ? body.people : [];
  return {
    meta: body.meta,
    people: personId
      ? people.filter((p) => p && typeof p === "object" && (p as Record<string, unknown>).person_id === personId)
      : [],
    detail: body.detail ?? null,
  };
}

/**
 * GET /api/insights/agents: the RPC body with `meta` taken from the window (a
 * partial-day comparison reports its real cut), for an owner as is; for a
 * non-owner through the whitelist (money ABSENT, never 0); for an agent only
 * their own person. `rpc` null = an agent with no sales_people row.
 */
export function buildPeopleResponse(
  rpc: Record<string, unknown> | null,
  win: InsightsWindow,
  access: Exclude<PeopleAccess, "forbidden">,
  selfPersonId: string | null = null,
  now: Date = new Date(),
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...(rpc ?? { people: [], detail: null }) };
  const rpcMeta = body.meta && typeof body.meta === "object" ? (body.meta as Record<string, unknown>) : {};
  body.meta = {
    ...rpcMeta,
    from: win.from,
    to: win.to,
    prev_from: win.prev?.from ?? null,
    prev_to: win.prev?.to ?? null,
    prev_to_end: win.prev?.toEndIso ?? null,
    partial: win.partial,
    days: win.days,
    generated_at: now.toISOString(),
    money: access === "owner",
    clock: "sale",
    access,
    ...(access === "self" && !selfPersonId ? { self_unlinked: true } : {}),
  };
  if (access === "owner") return body;
  const scoped = access === "self" ? selfOnly(body, selfPersonId) : body;
  return stripInsightsMoney(scoped, PEOPLE_NON_MONEY_KEYS);
}

// ── GET /agent-performance for a non-owner ──────────────────────────────────

/** Money on an /agent-performance row (stored EUR). The payout is separate:
 *  an agent keeps seeing their OWN payout, as before. */
export const AGENT_PERF_MONEY_KEYS = [
  "gross_revenue", "paid_revenue", "outstanding_revenue", "returned_value", "total_profit",
  "net_contribution", "avg_order_value", "revenue_per_lead", "profit_per_lead", "avg_per_package",
] as const;

/**
 * The /agent-performance rows a non-owner may see: revenue, profit, AOV and
 * the revenue-derived average per package removed; the payout kept only for an
 * agent's own view (their commission, as today) and removed for a non-owner
 * admin / manager. Sorted by paid count, then confirmed, then name — sorting
 * by revenue would leak the money ranking. Owners never pass through here.
 * The bonus math is not touched: this only drops keys from finished rows.
 */
export function stripAgentPerformance<T extends Record<string, unknown>>(
  rows: T[],
  opts: { keepPayout: boolean },
): Record<string, unknown>[] {
  const out = rows.map((r) => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if ((AGENT_PERF_MONEY_KEYS as readonly string[]).includes(k)) continue;
      if (k === "payout_earned" && !opts.keepPayout) continue;
      if (MONEY_KEY_RE.test(k)) continue;
      o[k] = v;
    }
    return o;
  });
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return out.sort((a, b) =>
    n(b.total_paid) - n(a.total_paid) || n(b.total_confirmed) - n(a.total_confirmed) ||
    String(a.full_name ?? "").localeCompare(String(b.full_name ?? "")));
}
