import { describe, expect, it } from "vitest";
import {
  buildReturnsResponse, buildStockResponse, COMPARE_MAX_DAYS, parseReturnsClock, prevArgs,
  RETURNS_NON_MONEY_KEYS, returnsAccess, STOCK_NON_MONEY_KEYS, stockAccess,
} from "./insightsReturnsStock.ts";
import { insightsWindows, MONEY_KEY_RE } from "./insightsCommon.ts";
import type { InsightsWindow } from "./insightsCommon.ts";
// 01.09–27.09.2026 payloads in the RPCs' exact shape (owner view; buyers and
// sellers anonymised) — the same fixtures the tabs' tests render.
import returnsSample from "../../../src/components/insights/returns/__fixtures__/returns.sample.json";
import returnsMexSample from "../../../src/components/insights/returns/__fixtures__/returns.mex.sample.json";
import stockSample from "../../../src/components/insights/stock/__fixtures__/stock.sample.json";

const NOW = new Date("2026-09-28T08:00:00Z");
const win = (from: string, to: string, compare = true): InsightsWindow => {
  const w = insightsWindows(from, to, compare, NOW);
  if ("error" in w) throw new Error(w.error);
  return w;
};
/** The RPC body: the fixture without the api's own meta fields. */
const rpc = (s: unknown) => {
  const b = structuredClone(s) as Record<string, any>;
  const { clock, granularity, sources, has_prev, today } = b.meta;
  b.meta = { clock, granularity, sources, has_prev, ...(today ? { today } : {}), money: true };
  return b;
};

/** Every key path (arrays collapsed), e.g. "by_source[].splits[].rate". */
function keyPaths(v: unknown, at = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, `${at}[]`));
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [`${at}.${k}`, ...keyPaths(x, `${at}.${k}`)]);
  }
  return [];
}
const moneyPath = (p: string) => p.split(/\.|\[\]/).some((seg) => MONEY_KEY_RE.test(seg));

describe("access", () => {
  it("returns: owner → money, admin/manager → counts, others → 403", () => {
    expect(returnsAccess(true, false)).toBe("owner");
    expect(returnsAccess(false, true)).toBe("counts");
    expect(returnsAccess(false, false)).toBe("forbidden");
  });
  it("stock: the warehouse role gets counts, never money", () => {
    expect(stockAccess(true, false, false)).toBe("owner");
    expect(stockAccess(false, true, false)).toBe("counts");
    expect(stockAccess(false, false, true)).toBe("counts");
    expect(stockAccess(false, false, false)).toBe("forbidden");
  });
});

describe("parseReturnsClock", () => {
  it("defaults to the cohort (sale) and accepts the MEX return day", () => {
    expect(parseReturnsClock(null)).toBe("sale");
    expect(parseReturnsClock("")).toBe("sale");
    expect(parseReturnsClock("returned")).toBe("returned");
    expect(parseReturnsClock(" SALE ")).toBe("sale");
    expect(parseReturnsClock("created")).toBeNull();
  });
});

describe("prevArgs", () => {
  it("sends the previous window only when compare is on and the window is short", () => {
    expect(prevArgs(win("2026-09-01", "2026-09-27"))).toEqual({
      p_prev_from: "2026-08-04T22:00:00.000Z", p_prev_to_end: "2026-08-31T21:59:59.999999Z",
    });
    expect(prevArgs(win("2026-09-01", "2026-09-27", false))).toEqual({ p_prev_from: null, p_prev_to_end: null });
    const year = win("2025-09-28", "2026-09-27");
    expect(year.days).toBeGreaterThan(COMPARE_MAX_DAYS);
    expect(prevArgs(year)).toEqual({ p_prev_from: null, p_prev_to_end: null });
  });
});

describe("buildReturnsResponse", () => {
  it("owner: meta from the window, the clock echoed, the money kept", () => {
    const b = buildReturnsResponse(rpc(returnsSample), win("2026-09-01", "2026-09-27"), true, "sale", NOW) as any;
    expect(b.meta).toMatchObject({
      from: "2026-09-01", to: "2026-09-27", prev_from: "2026-08-05", prev_to: "2026-08-31",
      days: 27, partial: false, money: true, clock: "sale", has_prev: true, granularity: "day",
    });
    expect(b.meta.generated_at).toBe(NOW.toISOString());
    expect(b.kpis.returned.value_mkd).toBe((returnsSample as any).kpis.returned.value_mkd);
    expect(b.kpis.prev).not.toBeNull();
  });

  it("drops the comparison the RPC did not compute", () => {
    const body = rpc(returnsSample);
    body.meta.has_prev = false;
    const b = buildReturnsResponse(body, win("2026-09-01", "2026-09-27"), true, "sale", NOW) as any;
    expect(b.meta).toMatchObject({ has_prev: false, prev_from: null, prev_to: null });
    expect(b.kpis.prev).toBeNull();
  });

  for (const [name, sample, clock] of [
    ["sale clock", returnsSample, "sale"], ["MEX clock", returnsMexSample, "returned"],
  ] as const) {
    it(`non-owner (${name}): not one money key, every count kept`, () => {
      const owner = buildReturnsResponse(rpc(sample), win("2026-09-01", "2026-09-27"), true, clock, NOW);
      const b = buildReturnsResponse(rpc(sample), win("2026-09-01", "2026-09-27"), false, clock, NOW) as any;
      expect(b.meta.money).toBe(false);
      const paths = keyPaths(b);
      expect(paths.filter(moneyPath)).toEqual([]);
      // what the owner has, minus money = what the non-owner has (nothing else lost)
      const expected = [...new Set(keyPaths(owner).filter((p) => !moneyPath(p)))].sort();
      expect([...new Set(paths)].sort()).toEqual(expected);
      expect(b.kpis.returned.count).toBe((sample as any).kpis.returned.count);
      expect(b.by_source[0].splits.length).toBeGreaterThan(0);
    });
  }

  it("the whitelist never lets a money key through", () => {
    for (const k of RETURNS_NON_MONEY_KEYS) expect(MONEY_KEY_RE.test(k)).toBe(false);
  });

  it("the sale clock's parts add up: Σ sources = the KPI base and returned", () => {
    const s = returnsSample as any;
    const sum = (k: string) => s.by_source.reduce((a: number, r: any) => a + r[k], 0);
    expect(sum("base")).toBe(s.kpis.base.count);
    expect(sum("returned")).toBe(s.kpis.returned.count);
    expect(sum("value_mkd")).toBe(s.kpis.returned.value_mkd);
    for (const r of s.by_source) {
      expect(r.splits.reduce((a: number, x: any) => a + x.base, 0)).toBe(r.base);
      expect(r.orders + r.web + r.mex_only).toBe(r.returned);
    }
    expect(s.days_to_return.bins.reduce((a: number, b: any) => a + b.count, 0)).toBe(s.days_to_return.count);
    expect(s.by_weekday.reduce((a: number, d: any) => a + d.base, 0)).toBe(s.kpis.base.count);
  });
});

describe("buildStockResponse", () => {
  it("owner: meta from the window, products and the (null while untrusted) valuation kept", () => {
    const b = buildStockResponse(rpc(stockSample), win("2026-09-01", "2026-09-27"), true, NOW) as any;
    expect(b.meta).toMatchObject({ from: "2026-09-01", to: "2026-09-27", money: true, clock: "sale", has_prev: true, today: "2026-09-28" });
    expect(b.trust.trusted).toBe(false);
    expect(b).toHaveProperty("valuation", null);
    expect(b.products.some((p: any) => p.cost_mkd != null)).toBe(true);
  });

  it("non-owner / warehouse: no cost, price, value or valuation — counts and stock kept", () => {
    const owner = buildStockResponse(rpc(stockSample), win("2026-09-01", "2026-09-27"), true, NOW);
    const b = buildStockResponse(rpc(stockSample), win("2026-09-01", "2026-09-27"), false, NOW) as any;
    expect(b.meta.money).toBe(false);
    expect(b).not.toHaveProperty("valuation");
    expect(keyPaths(b).filter(moneyPath)).toEqual([]);
    const expected = [...new Set(keyPaths(owner).filter((p) => !moneyPath(p) && !p.startsWith(".valuation")))].sort();
    expect([...new Set(keyPaths(b))].sort()).toEqual(expected);
    expect(b.products[0]).toHaveProperty("units");
    expect(b.products.find((p: any) => p.tracked)).toHaveProperty("on_hand");
    expect(b.queue[0].ages).toHaveLength(5);
  });

  it("the whitelist never lets a money key (or the valuation) through", () => {
    for (const k of STOCK_NON_MONEY_KEYS) expect(MONEY_KEY_RE.test(k)).toBe(false);
    expect(STOCK_NON_MONEY_KEYS.has("valuation")).toBe(false);
  });

  it("the queue's ages add up to its stage and its sources", () => {
    for (const q of (stockSample as any).queue) {
      expect(q.ages.reduce((a: number, x: any) => a + x.count, 0)).toBe(q.count);
      expect(q.by_source.reduce((a: number, x: any) => a + x.count, 0)).toBe(q.count);
      expect(q.orders + q.web + q.mex_only).toBe(q.count);
    }
  });
});
