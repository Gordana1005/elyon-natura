// ============================================================================
// Customer 360 — the pure half of GET /api/customers/timeline?phone=…
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// customer360.test.ts against this file in Node, and index.ts imports it.
//
// The SQL (public.customer_timeline, migration 20260939000100) already omits
// owner-only money when p_include_money is false. shapeTimeline() strips it a
// SECOND time, by rule rather than by list, so a money key added to the SQL
// later is dropped for non-owners by default:
//   * any key ending in _mkd or _eur, plus `currency` and `price`, is money;
//   * the ONE exception is `amount_eur` on a CRM order event — the order price
//     every staff role already sees on /orders.
// It also applies the two other per-caller walls the rest of the api uses:
//   * CPA provenance (`webmaster`) is admin/manager only — see
//     stripCpaAttribution in index.ts;
//   * customer names are masked for roles without show_customer_name.
// ============================================================================

export const TIMELINE_MIN_DIGITS = 8;

/** Last 8 digits — the CRM's phone-matching canon (elyon-phone-normalization). */
export function parseTimelinePhone(raw: string | null | undefined): { phone8: string } | { error: string } {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (/e[+-]?\d/i.test(String(raw ?? "").replace(/\s/g, ""))) return { error: "phone_corrupted" };
  if (digits.length < TIMELINE_MIN_DIGITS) return { error: "phone_too_short" };
  return { phone8: digits.slice(-TIMELINE_MIN_DIGITS) };
}

export interface TimelineAccess {
  /** Business owner: web totals, MEX COD, AlterCPA price, lifetime cash. */
  money: boolean;
  /** Admin/manager: which affiliate (webmaster) sent the lead. */
  cpaProvenance: boolean;
  /** role_privacy.show_customer_name. */
  showNames: boolean;
  /** The api's own masker (maskNameValue), injected so there is one rule. */
  maskName?: (v: string) => string;
}

const NAME_KEYS = new Set(["customer_name", "receiver_name"]);

function isMoneyKey(key: string): boolean {
  return /_(mkd|eur)$/.test(key) || key === "currency" || key === "price";
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function walk(node: Json, access: TimelineAccess, isOrderEvent: boolean): Json {
  if (Array.isArray(node)) return node.map((x) => walk(x, access, false));
  if (!node || typeof node !== "object") return node;
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(node)) {
    if (!access.money && isMoneyKey(k) && !(isOrderEvent && k === "amount_eur")) continue;
    if (!access.cpaProvenance && k === "webmaster") continue;
    if (!access.showNames && NAME_KEYS.has(k) && typeof v === "string") {
      out[k] = access.maskName ? access.maskName(v) : "";
      continue;
    }
    out[k] = walk(v, access, false);
  }
  return out;
}

/**
 * The response for one caller. `raw` is exactly what customer_timeline()
 * returned; the result is safe to send to that caller.
 */
export function shapeTimeline(raw: unknown, access: TimelineAccess): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "bad_response" };
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) return { ok: false, error: typeof r.error === "string" ? r.error : "failed" };

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === "events") {
      out.events = (Array.isArray(v) ? v : []).map((e) => {
        const isOrder = !!e && typeof e === "object" && (e as Record<string, unknown>).kind === "order";
        return walk(e as Json, access, isOrder);
      });
    } else if (k === "customer" && v && typeof v === "object") {
      const c = { ...(v as Record<string, unknown>) };
      if (!access.showNames && Array.isArray(c.names)) {
        const masked = (c.names as unknown[]).map((n) => (access.maskName ? access.maskName(String(n)) : ""));
        c.names = [...new Set(masked.filter(Boolean))];
      }
      out.customer = walk(c as Json, access, false);
    } else {
      out[k] = walk(v as Json, access, false);
    }
  }
  out.money = access.money;
  return out;
}
