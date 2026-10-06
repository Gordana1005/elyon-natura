import { describe, expect, it } from "vitest";
import { loyaltyAccess, loyaltyRpc, parseLoyaltyRoute } from "./loyalty.ts";

const q = (s: string) => new URLSearchParams(s);

describe("loyaltyAccess", () => {
  it("owners, admins and managers see the numbers; everyone else is refused", () => {
    expect(loyaltyAccess(true, false)).toBe("staff");
    expect(loyaltyAccess(true, true)).toBe("staff");
    expect(loyaltyAccess(false, true)).toBe("staff");
    expect(loyaltyAccess(false, false)).toBe("forbidden");
  });
});

describe("parseLoyaltyRoute", () => {
  it("defaults the list to page 1, size 50 and an empty search", () => {
    const r = parseLoyaltyRoute("loyalty", q(""));
    expect(r).toEqual({ ok: true, route: { kind: "page", q: "", page: 1, size: 50 } });
  });

  it("trims, collapses and caps the search at 80", () => {
    const r = parseLoyaltyRoute("loyalty", q("q=" + encodeURIComponent("  марија   стоева  " + "x".repeat(80))));
    expect(r.ok).toBe(true);
    if (!r.ok || r.route.kind !== "page") throw new Error("expected a page");
    expect(r.route.q.startsWith("марија стоева")).toBe(true);
    expect(r.route.q.length).toBe(80);
  });

  it("clamps page and size", () => {
    expect(parseLoyaltyRoute("loyalty", q("page=0&size=500"))).toMatchObject({
      ok: true, route: { page: 1, size: 100 },
    });
    expect(parseLoyaltyRoute("loyalty", q("page=3&size=abc"))).toMatchObject({
      ok: true, route: { page: 3, size: 50 },
    });
    expect(parseLoyaltyRoute("loyalty", q("page=-4&size=0"))).toMatchObject({
      ok: true, route: { page: 1, size: 1 },
    });
  });

  it("accepts an 8-digit phone and refuses anything else", () => {
    expect(parseLoyaltyRoute("loyalty/phone/07123456", q(""))).toEqual({
      ok: true, route: { kind: "phone", phone8: "07123456" },
    });
    expect(parseLoyaltyRoute("loyalty/phone/7123456", q("")).ok).toBe(false);
    expect(parseLoyaltyRoute("loyalty/phone/071234567", q(""))).toMatchObject({ ok: false, status: 404 });
    expect(parseLoyaltyRoute("loyalty/phone/0712345a", q(""))).toMatchObject({ ok: false, status: 404 });
    expect(parseLoyaltyRoute("loyalty/nope", q(""))).toMatchObject({ ok: false, status: 404 });
  });
});

describe("loyaltyRpc", () => {
  it("names the page and phone functions", () => {
    expect(loyaltyRpc({ kind: "page", q: "ана", page: 2, size: 50 })).toEqual({
      fn: "loyalty_page", args: { p_q: "ана", p_page: 2, p_size: 50 },
    });
    expect(loyaltyRpc({ kind: "phone", phone8: "07123456" })).toEqual({
      fn: "loyalty_phone", args: { p_phone8: "07123456" },
    });
  });
});
