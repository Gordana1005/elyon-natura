// ============================================================================
// Loyalty (Лојалност) — the pure half of GET /api/loyalty (migration 20261006120000).
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// loyalty.test.ts against this file in Node, and index.ts imports it as LOYALTY.
//
//   GET loyalty?q=&page=&size=          → loyalty_page
//   GET loyalty/phone/:phone8           → loyalty_phone   (404 unless 8 digits)
//
// Access: business owners, admins and managers. Managers SEE the point numbers
// (this is not the shops money strip). Everyone else, including an external
// affiliate, is 403. No redemption.
// ============================================================================

export type LoyaltyAccess = "staff" | "forbidden";

/** Owners, admins and managers. Everyone else is refused. */
export function loyaltyAccess(isOwner: boolean, isAdminOrManager: boolean): LoyaltyAccess {
  if (isOwner || isAdminOrManager) return "staff";
  return "forbidden";
}

export type LoyaltyRoute =
  | { kind: "page"; q: string; page: number; size: number }
  | { kind: "phone"; phone8: string };

export type RouteResult = { ok: true; route: LoyaltyRoute } | { ok: false; status: number; error: string };

const PHONE8 = /^[0-9]{8}$/;

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * `path` is the api path with the /api/ prefix already removed
 * ("loyalty" or "loyalty/phone/07123456").
 * Search text is trimmed, collapsed and capped at 80. Page is at least 1.
 * Size is 1..100, default 50. A phone that is not 8 digits is 404.
 */
export function parseLoyaltyRoute(path: string, params: URLSearchParams): RouteResult {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "loyalty") return { ok: false, status: 404, error: "Not found" };
  if (parts.length === 1) {
    const q = (params.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    return {
      ok: true,
      route: {
        kind: "page",
        q,
        page: clampInt(params.get("page"), 1, 1, 100000),
        size: clampInt(params.get("size"), 50, 1, 100),
      },
    };
  }
  if (parts.length === 3 && parts[1] === "phone" && PHONE8.test(parts[2])) {
    return { ok: true, route: { kind: "phone", phone8: parts[2] } };
  }
  return { ok: false, status: 404, error: "Not found" };
}

export function loyaltyRpc(route: LoyaltyRoute): { fn: string; args: Record<string, unknown> } {
  if (route.kind === "page") {
    return { fn: "loyalty_page", args: { p_q: route.q, p_page: route.page, p_size: route.size } };
  }
  return { fn: "loyalty_phone", args: { p_phone8: route.phone8 } };
}
