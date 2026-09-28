import { describe, expect, it } from "vitest";
import {
  bucketKeys, buildClock, buildProfitResponse, buildStrip, commissionAgentNames, costRatioOf, distributionOf,
  gatedBonusEur, mexRate, MKD_PER_EUR, normAgent, plRow, productRows, profitPrevWindow, PROFIT_PREV_MAX_DAYS,
  PROFIT_PRODUCTS_MAX, PROFIT_SOURCES,
} from "./insightsProfit.ts";
import type { AggRow, CommRow, ProductRpcRow, ProfitRpc, ProfitSettings } from "./insightsProfit.ts";
import type { InsightsWindow } from "./insightsCommon.ts";

const agg = (g: string, dim: string, key: string, x: Partial<AggRow>): AggRow => ({
  g, dim, key, n: 0, rev: 0, card: 0, pw: 0, rc: 0, ru: 0, rn: 0, cm: 0, pc: 0, pu: 0, fr: 0, lb: 0, ...x,
});

const SETTINGS: ProfitSettings = {
  vatRate: 0.18,
  deliverEur: 2.439,   // courier_rates 'mex' = 150 ден
  returnEur: 0,
  rateSource: "courier_rates",
  agentNames: new Set(["Ана Петрова", "Марко"]),
};

// A small cohort: AlterCPA fully costed, teleshop uncosted, one web sale.
const COHORT: ProfitRpc = {
  clock: "cohort",
  granularity: "day",
  agg: [
    agg("collected", "s", "altercpa", { n: 10, rev: 30000, pw: 10, rc: 30000, cm: 6000, pc: 30, lb: 30 }),
    agg("collected", "s", "elyon_crm", { n: 4, rev: 10000, pw: 4, rc: 8000, ru: 2000, cm: 1600, pc: 8, pu: 2, fr: 1, lb: 10 }),
    agg("collected", "s", "web", { n: 2, rev: 3000, card: 1000, pw: 2, ru: 3000, pu: 3 }),
    agg("collected", "s", "teleshop_other", { n: 5, rev: 10000, pw: 5, ru: 9900, rn: 100, pu: 12, fr: 2 }),
    agg("returned", "s", "altercpa", { n: 3, rev: 9000, pw: 3 }),
    agg("returned", "s", "teleshop_other", { n: 1, rev: 2000, pw: 1 }),
    agg("open", "s", "altercpa", { n: 2, rev: 6000, pw: 2 }),
    agg("unproven", "s", "elyon_crm", { n: 1, rev: 2500, pw: 1 }),
    // days (collected + returned)
    agg("collected", "d", "2026-09-22", { n: 12, rev: 33000, pw: 12, rc: 25000, ru: 7900, rn: 100, cm: 5000, pc: 25, pu: 8, lb: 25 }),
    agg("collected", "d", "2026-09-24", { n: 9, rev: 20000, pw: 9, rc: 13000, ru: 7000, cm: 2600, pc: 13, pu: 9, fr: 3, lb: 15 }),
    agg("returned", "d", "2026-09-24", { n: 4, rev: 11000, pw: 4 }),
    // AlterCPA webmasters (Σ collected = the AlterCPA row)
    agg("collected", "w", "3221", { n: 7, rev: 21000, pw: 7, rc: 21000, cm: 4200, pc: 21, lb: 21 }),
    agg("collected", "w", "__none__", { n: 3, rev: 9000, pw: 3, rc: 9000, cm: 1800, pc: 9, lb: 9 }),
    agg("returned", "w", "3221", { n: 3, rev: 9000, pw: 3 }),
    agg("open", "w", "3221", { n: 2, rev: 6000, pw: 2 }),
  ],
  comm: [
    // AlterCPA: 30 € ungated, of which 20 € owned by an agent ("Ана Петрова М." folds to her)
    { dim: "s", key: "altercpa", o: "Ана Петрова М.", b: 20, n: 6 },
    { dim: "s", key: "altercpa", o: null, b: 10, n: 4 },
    // ElyonCRM: 10 € ungated, all an admin's → 0 (an admin earns nothing)
    { dim: "s", key: "elyon_crm", o: "Админ", b: 10, n: 4 },
    { dim: "d", key: "2026-09-22", o: "Ана Петрова М.", b: 20, n: 6 },
    { dim: "d", key: "2026-09-22", o: null, b: 5, n: 2 },
    { dim: "d", key: "2026-09-24", o: null, b: 5, n: 2 },
    { dim: "d", key: "2026-09-24", o: "Админ", b: 10, n: 4 },
    { dim: "w", key: "3221", o: "Ана Петрова М.", b: 20, n: 6 },
    { dim: "w", key: "__none__", o: null, b: 10, n: 4 },
  ],
  wm_names: { "3221": "Fomikch" },
  strip: [
    { s: "altercpa", b: "paid", n: 10, v: 30000, c: 30000, no: 10, nw: 0, nm: 0 },
    { s: "altercpa", b: "returned", n: 3, v: 9000, c: 9000, no: 3, nw: 0, nm: 0 },
    { s: "altercpa", b: "courier", n: 2, v: 6000, c: 6000, no: 2, nw: 0, nm: 0 },
    { s: "altercpa", b: "cancelled_after_sale", n: 1, v: 3000, c: 0, no: 1, nw: 0, nm: 0 },
    { s: "teleshop_other", b: "paid", n: 5, v: 10000, c: 10000, no: 2, nw: 0, nm: 3 },
  ],
  products: [
    { s: "altercpa", g: "collected", k: "p:a", name: "Adenofrin", kind: "product", reviewed: false, pkg: true, cost_eur: 2.93, n: 10, qty: 30, pkgs: 30, fr: 0, rev: 30000, cm: 5404.95, sh: 10, lb: 30 },
    { s: "elyon_crm", g: "collected", k: "p:a", name: "Adenofrin", kind: "product", reviewed: false, pkg: true, cost_eur: 2.93, n: 3, qty: 8, pkgs: 8, fr: 1, rev: 8000, cm: 1441.56, sh: 3, lb: 8 },
    { s: "elyon_crm", g: "collected", k: "n:zinc", name: "Zinc", kind: "product", reviewed: false, pkg: true, cost_eur: null, n: 1, qty: 2, pkgs: 2, fr: 0, rev: 2000, cm: 0, sh: 1, lb: 2 },
    { s: "teleshop_other", g: "collected", k: "n:zinc", name: "Zinc", kind: "product", reviewed: false, pkg: true, cost_eur: null, n: 2, qty: 12, pkgs: 12, fr: 2, rev: 5900, cm: 0, sh: 2, lb: 0 },
    { s: "teleshop_other", g: "collected", k: "n:поен-150", name: "ПОЕН-150", kind: "loyalty_point", reviewed: false, pkg: false, cost_eur: null, n: 2, qty: 2, pkgs: 0, fr: 0, rev: 100, cm: 0, sh: 0, lb: 0 },
    { s: "teleshop_other", g: "collected", k: "__mex_only__", name: null, kind: "unknown", reviewed: false, pkg: false, cost_eur: null, n: 3, qty: 0, pkgs: 0, fr: 0, rev: 4000, cm: 0, sh: 3, lb: 0 },
    { s: "web", g: "collected", k: "n:collagen", name: "Collagen", kind: "product", reviewed: false, pkg: true, cost_eur: null, n: 2, qty: 3, pkgs: 3, fr: 0, rev: 3000, cm: 0, sh: 2, lb: 0 },
    { s: "altercpa", g: "returned", k: "p:a", name: "Adenofrin", kind: "product", reviewed: false, pkg: true, cost_eur: 2.93, n: 3, qty: 9, pkgs: 9, fr: 0, rev: 9000, cm: 0, sh: 3, lb: 0 },
  ],
  hist: [
    { s: "altercpa", u: 1000, q: 30, v: 30000 },
    { s: "elyon_crm", u: 1000, q: 7, v: 7000 },
    { s: "elyon_crm", u: 1000, q: 2, v: 2000 },
    { s: "teleshop_other", u: 500, q: 10, v: 5000 },
    { s: "web", u: 1000, q: 3, v: 3000 },
  ],
  no_items: { n: 0, v: 0 },
};

const CASH: ProfitRpc = {
  clock: "cash",
  granularity: "day",
  agg: [
    agg("collected", "s", "altercpa", { n: 12, rev: 36000, pw: 12, rc: 36000, cm: 7200, pc: 36, lb: 36 }),
    agg("collected", "s", "web", { n: 3, rev: 4000, card: 1000, pw: 3, ru: 4000, pu: 4 }),
    agg("collected", "d", "2026-09-22", { n: 15, rev: 40000, pw: 15, rc: 36000, ru: 4000, cm: 7200, pc: 36, pu: 4, lb: 36 }),
    agg("collected", "w", "3221", { n: 12, rev: 36000, pw: 12, rc: 36000, cm: 7200, pc: 36, lb: 36 }),
  ],
  comm: [{ dim: "s", key: "altercpa", o: "Марко", b: 36, n: 12 }],
  wm_names: { "3221": "Fomikch" },
  returned_parcels: [{ s: "altercpa", d: "2026-09-22", n: 4 }, { s: "web", d: "2026-09-23", n: 1 }],
};

const WEEK: InsightsWindow = {
  from: "2026-09-22", to: "2026-09-28", days: 7,
  fromIso: "2026-09-21T22:00:00.000Z", toEndIso: "2026-09-28T21:59:59.999Z", partial: true,
  prev: { from: "2026-09-15", to: "2026-09-21", fromIso: "2026-09-14T22:00:00.000Z", toEndIso: "2026-09-21T21:59:59.999Z" },
};

describe("today's commission gate (twins of /management-insights)", () => {
  it("normAgent folds whitespace and a trailing initial; blank is Unknown operator", () => {
    expect(normAgent("  Ана   Петрова М. ")).toBe("Ана Петрова");
    expect(normAgent("Елена Т")).toBe("Елена");
    expect(normAgent(null)).toBe("Unknown operator");
    expect(normAgent("   ")).toBe("Unknown operator");
  });

  it("agent names = agent roles minus anyone who is also admin / manager", () => {
    const names = commissionAgentNames(
      [{ user_id: "a", full_name: "Ана Петрова" }, { user_id: "m", full_name: "Мики" }, { user_id: "x", full_name: "Никој" }],
      [{ user_id: "a", role: "agent" }, { user_id: "m", role: "agent" }, { user_id: "m", role: "admin" }, { user_id: "x", role: "warehouse" }],
    );
    expect([...names]).toEqual(["Ана Петрова"]);
  });

  it("only agent-owned bonus counts", () => {
    expect(gatedBonusEur(COHORT.comm, "s", "altercpa", SETTINGS.agentNames)).toBe(20);
    expect(gatedBonusEur(COHORT.comm, "s", "elyon_crm", SETTINGS.agentNames)).toBe(0);
    expect(gatedBonusEur(COHORT.comm, "s", null, SETTINGS.agentNames)).toBe(20);
  });
});

describe("the P&L row", () => {
  it("revenue − VAT − COGS (known + estimated) − courier − returns − commission − lead = net", () => {
    const m = { n: 10, rev: 30000, card: 0, pw: 10, rc: 20000, ru: 10000, rn: 0, cm: 4000, pc: 20, pu: 10, fr: 0, lb: 30 };
    const r = plRow({ key: "x", m, commissionEur: 20, returnedParcels: 3, returnedSales: 3, returnedValue: 9000, costRatio: 0.2 }, SETTINGS);
    const vat = 30000 * 0.18 / 1.18;
    expect(r.vat_mkd).toBe(Math.round(vat));
    expect(r.courier_mkd).toBe(10 * 150);
    expect(r.returns_mkd).toBe(0);
    expect(r.commission_mkd).toBe(Math.round(20 * MKD_PER_EUR));
    expect(r.cogs_est_mkd).toBe(2000);
    expect(r.lead_cost_mkd).toBe(0);
    const net = 30000 - vat - 4000 - 2000 - 1500 - 20 * 61.5;
    expect(r.net_mkd).toBe(Math.round(net));
    expect(r.net_upper_mkd).toBe(Math.round(net + 2000));
    expect(r.margin).toBeCloseTo(net / 30000, 10);
    expect(r.coverage_packages).toBeCloseTo(20 / 30, 10);
    expect(r.return_rate).toBeCloseTo(3 / 13, 10);
    expect(r.aov_mkd).toBe(3000);
    expect(r.profit_per_sale_mkd).toBe(Math.round(net / 10));
    // the costed packages alone: their revenue, their cost, the rest by revenue share
    const sigma = 20000 / 30000;
    const costed = 20000 - 20000 * 0.18 / 1.18 - 4000 - sigma * (1500 + 20 * 61.5);
    expect(r.costed.net_mkd).toBe(Math.round(costed));
  });

  it("with nothing costed the estimate is null (never a made-up cost)", () => {
    const m = { n: 1, rev: 1000, card: 0, pw: 1, rc: 0, ru: 1000, rn: 0, cm: 0, pc: 0, pu: 2, fr: 0, lb: 0 };
    const r = plRow({ key: "x", m, commissionEur: 0, returnedParcels: 0, returnedSales: 0, returnedValue: 0, costRatio: null }, SETTINGS);
    expect(r.cogs_est_mkd).toBeNull();
    expect(r.net_mkd).toBe(r.net_upper_mkd);
    expect(r.coverage_packages).toBe(0);
  });

  it("the estimate uses the cost share of the costed packages", () => {
    expect(costRatioOf(COHORT.agg)).toBeCloseTo((6000 + 1600) / (30000 + 8000), 12);
  });
});

describe("a clock", () => {
  const c = buildClock(COHORT, null, SETTINGS, bucketKeys("2026-09-22", "2026-09-24", "day"));

  it("Σ sources = the total, line by line", () => {
    for (const k of ["sales", "revenue_mkd", "vat_mkd", "cogs_known_mkd", "courier_mkd", "commission_mkd"] as const) {
      const sum = c.by_source.reduce((t, r) => t + (r[k] as number), 0);
      expect(Math.abs(sum - (c.total[k] as number))).toBeLessThanOrEqual(PROFIT_SOURCES.length);
    }
    const net = c.by_source.reduce((t, r) => t + r.net_mkd, 0);
    expect(Math.abs(net - c.total.net_mkd)).toBeLessThanOrEqual(PROFIT_SOURCES.length);
    expect(c.by_source.map((r) => r.key)).toEqual([...PROFIT_SOURCES]);
  });

  it("revenue is what MEX collected; open and unproven stay apart", () => {
    expect(c.total.revenue_mkd).toBe(53000);
    expect(c.open).toEqual({ count: 2, value_mkd: 6000 });
    expect(c.unproven).toEqual({ count: 1, value_mkd: 2500 });
    expect(c.total.returned).toBe(4);
    expect(c.total.returned_mkd).toBe(11000);
  });

  it("the trend fills the empty days", () => {
    expect(c.trend.map((p) => p.d)).toEqual(["2026-09-22", "2026-09-23", "2026-09-24"]);
    expect(c.trend[1]).toMatchObject({ sales: 0, revenue_mkd: 0, net_mkd: 0 });
  });

  it("webmasters add up to the AlterCPA row and carry their open / returned sales", () => {
    const alter = c.by_source.find((r) => r.key === "altercpa")!;
    expect(c.affiliates.reduce((t, a) => t + a.pl.revenue_mkd, 0)).toBe(alter.revenue_mkd);
    expect(c.affiliates.reduce((t, a) => t + a.pl.commission_mkd, 0)).toBe(alter.commission_mkd);
    const fom = c.affiliates.find((a) => a.key === "3221")!;
    expect(fom.name).toBe("Fomikch");
    expect(fom.sales_total).toBe(12);
    expect(fom.open).toBe(2);
    expect(fom.pl.return_rate).toBeCloseTo(3 / 10, 10);
    expect(c.affiliates.find((a) => a.key === "__none__")!.name).toBeNull();
  });

  it("cash: returns are MEX return-day parcels; per webmaster they are unknown (null)", () => {
    const k = buildClock(CASH, null, SETTINGS);
    expect(k.clock).toBe("delivered");
    expect(k.total.parcels_returned).toBe(5);
    expect(k.by_source.find((r) => r.key === "web")!.card_mkd).toBe(1000);
    expect(k.affiliates[0].pl.return_rate).toBeNull();
    expect(k.open).toBeNull();
    expect(k.total.commission_mkd).toBe(Math.round(36 * 61.5));
  });
});

describe("products", () => {
  const ratio = costRatioOf(COHORT.agg);
  const { rows, others } = productRows(COHORT, SETTINGS, ratio);

  it("fold across sources; Σ revenue and commission tie to the P&L", () => {
    const c = buildClock(COHORT, null, SETTINGS);
    expect(others).toBeNull();
    expect(rows.reduce((t, p) => t + p.revenue_mkd, 0)).toBe(c.total.revenue_mkd);
    expect(Math.abs(rows.reduce((t, p) => t + p.commission_mkd, 0) - c.total.commission_mkd)).toBeLessThanOrEqual(1);
    const aden = rows.find((p) => p.key === "p:a")!;
    expect(aden.sources).toEqual(["altercpa", "elyon_crm"]);
    expect(aden.packages).toBe(38);
    expect(aden.cost_known).toBe(true);
    expect(aden.unit_cost_mkd).toBe(Math.round(2.93 * 61.5));
    expect(aden.returned_packages).toBe(9);
    expect(aden.return_rate).toBeCloseTo(9 / 47, 10);
  });

  it("an uncosted product reads 'no cost' with an estimate, never a clean margin", () => {
    const zinc = rows.find((p) => p.key === "n:zinc")!;
    expect(zinc.cost_known).toBe(false);
    expect(zinc.unit_cost_mkd).toBeNull();
    expect(zinc.cogs_est_mkd).toBe(Math.round(7900 * ratio!));
    const pts = rows.find((p) => p.kind === "loyalty_point")!;
    expect(pts.package).toBe(false);
    expect(pts.cogs_est_mkd).toBeNull();
    const mex = rows.find((p) => p.key === "__mex_only__")!;
    expect(mex.cogs_est_mkd).toBe(Math.round(4000 * ratio!));
  });

  it("past the cap the tail folds into one row, totals intact", () => {
    const many: ProductRpcRow[] = Array.from({ length: PROFIT_PRODUCTS_MAX + 5 }, (_, i) => ({
      s: "teleshop_other", g: "collected", k: `n:p${i}`, name: `P${i}`, kind: "product", reviewed: false, pkg: true,
      cost_eur: null, n: 1, qty: 1, pkgs: 1, fr: 0, rev: 1000 + i, cm: 0, sh: 1, lb: 0,
    }));
    const r = productRows({ ...COHORT, products: many }, SETTINGS, 0.2);
    expect(r.rows).toHaveLength(PROFIT_PRODUCTS_MAX);
    expect(r.total).toBe(PROFIT_PRODUCTS_MAX + 5);
    expect(r.others!.revenue_mkd).toBe(1000 + 1001 + 1002 + 1003 + 1004);
    expect(r.others!.cogs_est_mkd).toBe(Math.round(r.others!.revenue_mkd * 0.2));
  });
});

describe("the realized price distribution", () => {
  it("weighted order statistics over denar bins", () => {
    const d = distributionOf([
      { s: "a", u: 100, q: 1, v: 100 }, { s: "a", u: 200, q: 2, v: 400 }, { s: "b", u: 300, q: 1, v: 300 },
    ], null);
    expect(d).toEqual({ packages: 4, avg_mkd: 200, min_mkd: 100, p25_mkd: 100, median_mkd: 200, p75_mkd: 200, max_mkd: 300 });
    expect(distributionOf([], null).packages).toBe(0);
    expect(distributionOf(COHORT.hist, "teleshop_other").median_mkd).toBe(500);
  });
});

describe("the strip (CohortBar)", () => {
  it("buckets add up to the total; outside stays outside", () => {
    const s = buildStrip(COHORT.strip);
    expect(s.total).toEqual({ count: 20, value_mkd: 55000, cod_mkd: 55000, orders: 17, web: 0, mex_only: 3 });
    expect(s.buckets.reduce((t, b) => t + b.count, 0)).toBe(s.total.count);
    expect(s.outside.find((o) => o.key === "cancelled_after_sale")!.count).toBe(1);
    expect(s.by_source.map((r) => r.key)).toEqual([...PROFIT_SOURCES]);
    expect(s.by_source.find((r) => r.key === "altercpa")!.total.count).toBe(15);
  });
});

describe("windows and settings", () => {
  it("bucket keys by day and by month", () => {
    expect(bucketKeys("2026-09-29", "2026-10-02", "day")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]);
    expect(bucketKeys("2025-11-15", "2026-02-01", "month")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(bucketKeys("2026-02-01", "2026-01-01", "day")).toEqual([]);
  });

  it("the previous period only up to the cap", () => {
    expect(profitPrevWindow(WEEK)).toEqual({ fromIso: WEEK.prev!.fromIso, toEndIso: WEEK.prev!.toEndIso });
    expect(profitPrevWindow({ ...WEEK, days: PROFIT_PREV_MAX_DAYS + 1 })).toBeNull();
    expect(profitPrevWindow({ ...WEEK, prev: null })).toBeNull();
  });

  it("the MEX rate card row, else the fallback — labelled", () => {
    expect(mexRate({ mex_door: { deliver: 2.439, return_: 0 } }, { deliver: 3.5, return_: 6 }))
      .toEqual({ deliverEur: 2.439, returnEur: 0, rateSource: "courier_rates" });
    expect(mexRate({}, { deliver: 2.439, return_: 0 })).toEqual({ deliverEur: 2.439, returnEur: 0, rateSource: "fallback" });
  });
});

describe("the response", () => {
  const r = buildProfitResponse({ cohort: COHORT, cash: CASH, prevCohort: COHORT, prevCash: CASH }, WEEK, SETTINGS,
    new Date("2026-09-28T08:00:00Z")) as Record<string, any>;

  it("meta says what every figure rests on", () => {
    expect(r.meta).toMatchObject({
      from: "2026-09-22", to: "2026-09-28", money: true, granularity: "day", prev_from: "2026-09-15", prev_skipped: false,
      vat: { rate: 0.18, confirmed: false }, courier: { deliver_mkd: 150, return_mkd: 0, source: "courier_rates" },
      lead_cost: { configured: false },
    });
  });

  it("carries both clocks, products, realized prices and the quality rail", () => {
    expect(r.cohort.clock).toBe("sale");
    expect(r.cash.clock).toBe("delivered");
    expect(r.cohort.prev.revenue_mkd).toBe(r.cohort.total.revenue_mkd);
    expect(r.cohort.trend).toHaveLength(7);
    expect(r.realized.all.packages).toBe(52);
    expect(Object.keys(r.realized)).toEqual(["all", ...PROFIT_SOURCES]);
    const kinds = r.quality.map((q: { kind: string }) => q.kind);
    expect(kinds).toEqual(expect.arrayContaining(["uncosted_packages", "unproven_paid", "vat_unconfirmed", "lead_cost_missing", "return_fee_unconfirmed"]));
    const unc = r.quality.find((q: { kind: string }) => q.kind === "uncosted_packages");
    expect(unc.count).toBe(17);
    expect(unc.top[0].key).toBe("n:zinc");
  });

  it("no money key is ever ×61,5 twice: every *_mkd is a whole denar", () => {
    const walk = (v: unknown, path: string) => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
        if (/_mkd$/.test(k) && typeof x === "number") expect(Number.isInteger(x), `${path}.${k}`).toBe(true);
        walk(x, `${path}.${k}`);
      }
    };
    walk(r, "r");
  });
});
