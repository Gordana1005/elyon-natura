import { describe, expect, it } from "vitest";
import {
  buildShopsResponse, hasNoMoney, parseAt, parseShopsRoute, shopsAccess, shopsRpc, stripShopsMoney,
} from "./shops.ts";
import type {
  ShopDetail, ShopsDay, ShopsDeliveries, ShopsHealth, ShopsPeriod, ShopsStockMatrix,
} from "../../../src/lib/shopsTypes.ts";

// 2026-10-02 10:00 Skopje (CEST, UTC+2)
const NOW = new Date("2026-10-02T08:00:00Z");
const q = (s: string) => new URLSearchParams(s);

const ref = { code: "003", name: "Карпош", city: "Скопје", sigma_object: "17", active: true };
const fresh = { last_sales_at: "2026-10-02T07:50:00Z", last_docs_at: null, last_stock_snapshot_at: "2026-10-01T21:30:00Z", reader_last_run_at: null };
const money = {
  sales_mkd: 10691.97, sales_ex_vat_mkd: 9969.1, cash_mkd: 4202, card_mkd: 6490, avg_receipt_mkd: 1781.99, cost_mkd: 3712.3,
  shop_margin_mkd: 6256.8, group_cost_mkd: null, group_margin_mkd: null, returns_mkd: 0,
};
const row = {
  shop: ref, receipts: 6, units: 16, returns_units: 0, first_receipt_at: "2026-09-30T09:33:00Z", last_receipt_at: "2026-09-30T16:46:00Z",
  vs_avg_pct: 12.5, control_ok: true, ...money,
};
const day: ShopsDay = {
  day: "2026-09-30", live: false, shops: [row], totals: { shops_open: 1, receipts: 6, units: 16, returns_units: 0, ...money },
  hourly: [{ hour: 11, receipts: 1, units: 1, sales_mkd: 780 }], freshness: fresh,
};
const period: ShopsPeriod = {
  from: "2026-09-01", to: "2026-09-30", shops: [row], totals: day.totals,
  daily: [{ day: "2026-09-30", receipts: 6, units: 16, ...money }],
  natura: { units_delivered: 2138, units_returned: 594, invoiced_ex_vat_mkd: 1, natura_cost_mkd: null, natura_margin_mkd: null, ads_reinvoiced_ex_vat_mkd: undefined },
  freshness: fresh,
};
const detail: ShopDetail = {
  shop: ref, from: "2026-09-30", to: "2026-09-30", summary: row,
  sales_by_article: [{ code: "000982", name: "КОЛАГЕН", units: 3, sales_mkd: 1714.2, shop_margin_mkd: 1000, group_margin_mkd: undefined }],
  stock_at: "2026-10-02T08:00:00Z", stock_basis: "snapshot 01.10 23:30 + 14 movements", stock_basis_at: "2026-10-01T21:30:00Z", stock_movements: 14,
  stock: [{ code: "001641", name: "MAGNESIUM GEL", brand: null, qty: 22, reserved: 0, available: 22, sold_30d: 5, days_cover: 132,
            last_sold_at: null, zero_top_seller: false, avg_cost_mkd: 22.03, retail_price_mkd: 250, value_cost_mkd: 484.75, value_retail_mkd: 5500 }],
  stock_totals: { articles: 1, units: 22, value_cost_mkd: 484.75, value_retail_mkd: 5500 },
  goods_in: [{ at: "2026-09-01T12:43:00Z", type: "10014", type_name: "Приемен лист", doc: "003-7500-552/2026", natura_doc: null, units: 10, value_mkd: 1771.19 }],
  goods_out: [], counts: [], freshness: fresh,
};
const matrix: ShopsStockMatrix = {
  at: "2026-10-02T08:00:00Z", shops: [ref], articles: [{ code: "001641", name: "MAGNESIUM GEL", brand: null, total: 22, sold_30d_total: 40, by_shop: { "003": 22 } }],
};
const deliveries: ShopsDeliveries = {
  from: "2026-09-01", to: "2026-09-30",
  rows: [{ day: "2026-09-30", shop: ref, sigma_doc: "04-01108", units: 120, value_ex_vat_mkd: 46143.2, received_doc: "001-1210-833/2026",
           received_at: "2026-09-30T11:04:42Z", in_transit: false, lag_days: 0 }],
  totals: { invoices: 1, units: 120, in_transit: 0, value_ex_vat_mkd: 46143.2 },
};
const health: ShopsHealth = {
  reader: { enabled: false, last_run_at: null, last_status: null, runs_24h: 0, errors_24h: 0 },
  backfill: { sales_from: "2026-01-01", sales_done_until: null, stock_history_months: 0 },
  controls: { days_checked: 0, mismatches: 0 },
  anomalies: [{ kind: "cost_above_sales", shop: ref, day: "2026-09-30", detail: "Набавната вредност е поголема од продажбата",
                params: { cost_mkd: 12269.3, sales_mkd: 9395, receipts: 10 }, value_mkd: 2874.3 }],
  freshness: fresh,
};
const ALL = { day, period, detail, matrix, deliveries, health };

describe("shopsAccess", () => {
  it("owners everything, managers / non-owner admins counts, everyone else forbidden", () => {
    expect(shopsAccess(true, false)).toBe("owner");
    expect(shopsAccess(true, true)).toBe("owner");
    expect(shopsAccess(false, true)).toBe("counts");
    expect(shopsAccess(false, false)).toBe("forbidden");
  });
});

describe("no money for managers", () => {
  for (const [name, payload] of Object.entries(ALL)) {
    it(`${name}: every *_mkd key absent at any depth, everything else kept`, () => {
      expect(hasNoMoney(payload)).toBe(name === "matrix");   // ShopsStockMatrix carries no money at all
      const out = buildShopsResponse(payload, "counts") as Record<string, unknown>;
      expect(hasNoMoney(out)).toBe(true);
      expect(JSON.stringify(out)).not.toMatch(/_mkd"/);
      // the counts stay
      const keys = (v: unknown, acc: Set<string> = new Set()): Set<string> => {
        if (Array.isArray(v)) v.forEach((x) => keys(x, acc));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.add(k); keys(x, acc); }
        return acc;
      };
      const before = [...keys(payload)].filter((k) => !/_mkd$/.test(k)).sort();
      expect([...keys(out)].sort()).toEqual(before);
    });
    it(`${name}: owners get the payload untouched`, () => {
      expect(buildShopsResponse(payload, "owner")).toBe(payload);
    });
  }
  it("the strip never mutates its input", () => {
    const copy = JSON.parse(JSON.stringify(day));
    stripShopsMoney(day);
    expect(day).toEqual(copy);
  });
  it("keeps nulls, numbers and strings of non-money keys", () => {
    expect(stripShopsMoney({ a: null, b_mkd: 1, c: [{ d_mkd: 2, e: "x" }], vs_avg_pct: 3 })).toEqual({ a: null, c: [{ e: "x" }], vs_avg_pct: 3 });
  });
});

describe("parseShopsRoute", () => {
  it("day: default today (Skopje), a future day is today, a bad date is 400", () => {
    expect(parseShopsRoute("shops/day", q(""), NOW)).toEqual({ ok: true, route: { kind: "day", day: "2026-10-02" } });
    expect(parseShopsRoute("shops/day", q("day=2026-09-30"), NOW)).toEqual({ ok: true, route: { kind: "day", day: "2026-09-30" } });
    expect(parseShopsRoute("shops/day", q("day=2026-12-01"), NOW)).toEqual({ ok: true, route: { kind: "day", day: "2026-10-02" } });
    expect(parseShopsRoute("shops/day", q("day=2026-02-30"), NOW)).toMatchObject({ ok: false, status: 400 });
  });
  it("period: from / to, defaults and limits", () => {
    expect(parseShopsRoute("shops/period", q("from=2026-09-01&to=2026-09-30"), NOW))
      .toEqual({ ok: true, route: { kind: "period", from: "2026-09-01", to: "2026-09-30" } });
    expect(parseShopsRoute("shops/period", q(""), NOW)).toEqual({ ok: true, route: { kind: "period", from: "2026-10-02", to: "2026-10-02" } });
    expect(parseShopsRoute("shops/period", q("to=2026-09-15"), NOW)).toEqual({ ok: true, route: { kind: "period", from: "2026-09-15", to: "2026-09-15" } });
    expect(parseShopsRoute("shops/period", q("from=2026-09-30&to=2026-09-01"), NOW)).toMatchObject({ ok: false, status: 400 });
    expect(parseShopsRoute("shops/period", q("from=2024-01-01&to=2026-09-30"), NOW)).toMatchObject({ ok: false, status: 400 });
  });
  it("detail: a three-digit code, the window and at", () => {
    expect(parseShopsRoute("shops/003", q("from=2026-09-01&to=2026-09-30&at=2026-09-30"), NOW)).toEqual({
      ok: true, route: { kind: "detail", code: "003", from: "2026-09-01", to: "2026-09-30", at: "2026-09-30T21:59:59.999Z" },
    });
    expect(parseShopsRoute("shops/3", q(""), NOW)).toMatchObject({ ok: false, status: 404 });
    expect(parseShopsRoute("shops/003", q("at=yesterday"), NOW)).toMatchObject({ ok: false, status: 400 });
  });
  it("stock-matrix, deliveries, health", () => {
    expect(parseShopsRoute("shops/stock-matrix", q("q=%20колаген%20&brand=ELIXY"), NOW))
      .toEqual({ ok: true, route: { kind: "matrix", at: null, q: "колаген", brand: "ELIXY" } });
    expect(parseShopsRoute("shops/stock-matrix", q(`q=${"x".repeat(61)}`), NOW)).toMatchObject({ ok: false, status: 400 });
    expect(parseShopsRoute("shops/deliveries", q(""), NOW))
      .toEqual({ ok: true, route: { kind: "deliveries", from: "2026-09-03", to: "2026-10-02", shop: null } });
    expect(parseShopsRoute("shops/deliveries", q("shop=029"), NOW)).toMatchObject({ ok: true, route: { shop: "029" } });
    expect(parseShopsRoute("shops/deliveries", q("shop=29"), NOW)).toMatchObject({ ok: false, status: 400 });
    expect(parseShopsRoute("shops/health", q(""), NOW)).toEqual({ ok: true, route: { kind: "health" } });
  });
  it("anything else is 404", () => {
    for (const p of ["shops", "shops/", "shops/day/x", "shops/unknown", "orders"]) {
      expect(parseShopsRoute(p, q(""), NOW)).toMatchObject({ ok: false, status: 404 });
    }
  });
});

describe("parseAt", () => {
  it("a day = its Skopje end, a wall time = Skopje, an ISO instant as is, the future = now (null)", () => {
    expect(parseAt("2026-01-15", NOW)).toBe("2026-01-15T22:59:59.999Z");          // CET
    expect(parseAt("2026-09-30T23:30", NOW)).toBe("2026-09-30T21:30:00.000Z");    // CEST
    expect(parseAt("2026-09-30T21:30:00Z", NOW)).toBe("2026-09-30T21:30:00.000Z");
    expect(parseAt("2026-10-02T11:00", NOW)).toBeNull();
    expect(parseAt(null, NOW)).toBeNull();
    expect(parseAt("2026-09-30T25:00", NOW)).toEqual({ error: expect.any(String) });
  });
});

describe("shopsRpc", () => {
  it("names the report and passes p_money", () => {
    expect(shopsRpc({ kind: "day", day: "2026-09-30" }, false)).toEqual({ fn: "shops_day", args: { p_day: "2026-09-30", p_money: false } });
    expect(shopsRpc({ kind: "period", from: "a", to: "b" }, true).fn).toBe("shops_period");
    expect(shopsRpc({ kind: "detail", code: "003", from: "a", to: "b", at: null }, true))
      .toEqual({ fn: "shop_detail", args: { p_code: "003", p_from: "a", p_to: "b", p_at: null, p_money: true } });
    expect(shopsRpc({ kind: "matrix", at: null, q: "x", brand: null }, false).fn).toBe("shops_stock_matrix");
    expect(shopsRpc({ kind: "deliveries", from: "a", to: "b", shop: "003" }, false).args).toMatchObject({ p_shop: "003", p_money: false });
    expect(shopsRpc({ kind: "health" }, true)).toEqual({ fn: "shops_health", args: { p_money: true } });
  });
});
