// ============================================================================
// Shops (Продавници) — the pure half of GET /api/shops/* (docs/SHOPS.md; JSON = src/lib/shopsTypes.ts).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs shops.test.ts against this
// file in Node, and index.ts imports it as SHOPS.
//
//   GET shops/day?day=YYYY-MM-DD                 → ShopsDay          (shops_day)
//   GET shops/period?from&to                     → ShopsPeriod       (shops_period)
//   GET shops/stock-matrix?at&q&brand            → ShopsStockMatrix  (shops_stock_matrix)
//   GET shops/deliveries?from&to&shop            → ShopsDeliveries   (shops_deliveries)
//   GET shops/health                             → ShopsHealth       (shops_health)
//   GET shops/:code?from&to&at                   → ShopDetail        (shop_detail; 404 for an unknown shop)
//
// Access (owner 02.10.2026): business owners (is_business_owner()) get everything; managers (and a
// non-owner admin) get the same payload with EVERY *_mkd key absent — the SQL leaves them out
// (p_money = false) and stripShopsMoney() removes any that remain, at any depth; everyone else 403.
// Dates are Skopje days; `at` is an ISO instant, a Skopje day (its end) or a Skopje wall time.
// ============================================================================

import { addDaysYmd, daysInclusive, isValidYmd, skopjeDayEndIso, skopjeTodayYmd, skopjeWallToUtcMs } from "./skopjeTime.ts";

export type ShopsAccess = "owner" | "counts" | "forbidden";

/** Owners → everything; managers / non-owner admins → counts only; everyone else → forbidden. */
export function shopsAccess(isOwner: boolean, isAdminOrManager: boolean): ShopsAccess {
  if (isOwner) return "owner";
  if (isAdminOrManager) return "counts";
  return "forbidden";
}

export const SHOPS_MONEY_KEY_RE = /_mkd$/;

/** Every key ending in _mkd removed, at any depth (arrays and nested objects included). */
export function stripShopsMoney<T>(payload: T): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (SHOPS_MONEY_KEY_RE.test(k)) continue;
        out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(payload) as T;
}

/** True when the payload holds no *_mkd key at any depth (the managers' guarantee). */
export function hasNoMoney(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.every(hasNoMoney);
  if (payload && typeof payload === "object") {
    return Object.entries(payload as Record<string, unknown>).every(([k, v]) => !SHOPS_MONEY_KEY_RE.test(k) && hasNoMoney(v));
  }
  return true;
}

export type ShopsRoute =
  | { kind: "day"; day: string }
  | { kind: "period"; from: string; to: string }
  | { kind: "detail"; code: string; from: string; to: string; at: string | null }
  | { kind: "matrix"; at: string | null; q: string | null; brand: string | null }
  | { kind: "deliveries"; from: string; to: string; shop: string | null }
  | { kind: "health" };

export type RouteResult = { ok: true; route: ShopsRoute } | { ok: false; status: number; error: string };

export const MAX_SHOPS_WINDOW_DAYS = 731;
const SHOP_CODE_RE = /^\d{3}$/;
const TEXT_PARAM_MAX = 60;

/** A Skopje day param: absent → `fallback`; invalid → error; after today → today. */
function dayParam(raw: string | null, fallback: string, today: string): string | { error: string } {
  const v = raw?.trim();
  if (!v) return fallback;
  if (!isValidYmd(v)) return { error: "dates must be YYYY-MM-DD" };
  return v > today ? today : v;
}

/** A window [from, to]: defaults to `defFrom`..today; to clamped to today; ≤ 731 days. */
function windowParams(p: URLSearchParams, today: string, defFrom: string): { from: string; to: string } | { error: string } {
  const to = dayParam(p.get("to"), today, today);
  if (typeof to !== "string") return to;
  const from = dayParam(p.get("from"), p.get("to")?.trim() ? to : defFrom, today);
  if (typeof from !== "string") return from;
  if (from > to) return { error: "from is after to" };
  if (daysInclusive(from, to) > MAX_SHOPS_WINDOW_DAYS) return { error: `window longer than ${MAX_SHOPS_WINDOW_DAYS} days` };
  return { from, to };
}

/**
 * `at`: an ISO instant (with zone), a Skopje day (= the end of that day), or a Skopje wall time
 * "YYYY-MM-DDTHH:MM[:SS]" → an ISO UTC string; absent → null (= now); a future instant → null (now).
 */
export function parseAt(raw: string | null, now: Date = new Date()): string | null | { error: string } {
  const v = raw?.trim();
  if (!v) return null;
  let ms: number;
  const isDay = (x: string): boolean => isValidYmd(x);   // not a type guard: v stays a string below
  if (isDay(v)) {
    ms = Date.parse(skopjeDayEndIso(v));
  } else {
    const wall = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (wall) {
      if (!isValidYmd(`${wall[1]}-${wall[2]}-${wall[3]}`) || Number(wall[4]) > 23 || Number(wall[5]) > 59) return { error: "at must be a date or a time" };
      ms = skopjeWallToUtcMs(Number(wall[1]), Number(wall[2]), Number(wall[3]), Number(wall[4]), Number(wall[5]), Number(wall[6] ?? 0));
    } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
      ms = Date.parse(v);
    } else {
      return { error: "at must be YYYY-MM-DD, YYYY-MM-DDTHH:MM (Skopje) or an ISO instant" };
    }
  }
  if (!Number.isFinite(ms)) return { error: "at is not a valid moment" };
  if (ms >= now.getTime()) return null;
  return new Date(ms).toISOString();
}

function textParam(raw: string | null): string | null | { error: string } {
  const v = raw?.replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (v.length > TEXT_PARAM_MAX) return { error: `search text longer than ${TEXT_PARAM_MAX}` };
  return v;
}

/** path = "shops/…" (no /api prefix, no trailing slash). */
export function parseShopsRoute(path: string, p: URLSearchParams, now: Date = new Date()): RouteResult {
  const today = skopjeTodayYmd(now);
  const seg = path.split("/");
  if (seg[0] !== "shops" || seg.length !== 2 || !seg[1]) return { ok: false, status: 404, error: "Not found" };
  const bad = (error: string): RouteResult => ({ ok: false, status: 400, error });
  switch (seg[1]) {
    case "day": {
      const day = dayParam(p.get("day"), today, today);
      return typeof day === "string" ? { ok: true, route: { kind: "day", day } } : bad(day.error);
    }
    case "period": {
      const w = windowParams(p, today, today);
      return "error" in w ? bad(w.error) : { ok: true, route: { kind: "period", ...w } };
    }
    case "stock-matrix": {
      const at = parseAt(p.get("at"), now);
      if (at && typeof at === "object") return bad(at.error);
      const q = textParam(p.get("q"));
      if (q && typeof q === "object") return bad(q.error);
      const brand = textParam(p.get("brand"));
      if (brand && typeof brand === "object") return bad(brand.error);
      return { ok: true, route: { kind: "matrix", at: at as string | null, q: q as string | null, brand: brand as string | null } };
    }
    case "deliveries": {
      const w = windowParams(p, today, addDaysYmd(today, -29));
      if ("error" in w) return bad(w.error);
      const shop = p.get("shop")?.trim() || null;
      if (shop && !SHOP_CODE_RE.test(shop)) return bad("shop must be a shop code (003 …)");
      return { ok: true, route: { kind: "deliveries", ...w, shop } };
    }
    case "health":
      return { ok: true, route: { kind: "health" } };
    default: {
      if (!SHOP_CODE_RE.test(seg[1])) return { ok: false, status: 404, error: "Not found" };
      const w = windowParams(p, today, today);
      if ("error" in w) return bad(w.error);
      const at = parseAt(p.get("at"), now);
      if (at && typeof at === "object") return bad(at.error);
      return { ok: true, route: { kind: "detail", code: seg[1], ...w, at: at as string | null } };
    }
  }
}

/** The SQL report function and its arguments for a route (p_money = owner). */
export function shopsRpc(route: ShopsRoute, money: boolean): { fn: string; args: Record<string, unknown> } {
  switch (route.kind) {
    case "day": return { fn: "shops_day", args: { p_day: route.day, p_money: money } };
    case "period": return { fn: "shops_period", args: { p_from: route.from, p_to: route.to, p_money: money } };
    case "detail": return { fn: "shop_detail", args: { p_code: route.code, p_from: route.from, p_to: route.to, p_at: route.at, p_money: money } };
    case "matrix": return { fn: "shops_stock_matrix", args: { p_at: route.at, p_q: route.q, p_brand: route.brand, p_money: money } };
    case "deliveries": return { fn: "shops_deliveries", args: { p_from: route.from, p_to: route.to, p_shop: route.shop, p_money: money } };
    case "health": return { fn: "shops_health", args: { p_money: money } };
  }
}

/** The response body: the RPC's JSON, every *_mkd key removed unless the caller is an owner. */
export function buildShopsResponse(data: unknown, access: ShopsAccess): unknown {
  if (access === "owner") return data;
  return stripShopsMoney(data);
}
