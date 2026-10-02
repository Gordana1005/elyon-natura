import { describe, expect, it } from "vitest";
import {
  CENTAR_DEPTS, MADZARI_DEPTS, hideOrderValue, isShopsMarginKey, mexAccountsOfScope, moneyViewOf, parseDeptScope,
  scopeMexCash, scopeOperationsKpi, scopeOrderValues, scopePeople, scopeSalesCore, scopeSalesDetail, scopeSources,
  stockV2RevenueView, stripAgentPerformanceMargins, stripDashboardMargins, stripManagementInsightsMargins,
  stripReturnsMargins, stripShopsMargins, stripStockMargins, suggestedPrice, teamsOfScope,
} from "./accessLevels.ts";

const hasKeyDeep = (v: unknown, re: RegExp): boolean => {
  if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, re));
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => re.test(k) || hasKeyDeep(x, re));
  return false;
};

describe("the caller's scope", () => {
  it("parses dept_scope(): null = all, array = known keys in order, junk = none", () => {
    expect(parseDeptScope(null)).toBeNull();
    expect(parseDeptScope(["social", "teleshop_out", "bogus"])).toEqual(["teleshop_out", "social"]);
    expect(parseDeptScope([])).toEqual([]);
    expect(parseDeptScope(undefined)).toEqual([]);
    expect(parseDeptScope("altercpa")).toEqual([]);
  });

  it("moneyViewOf: margins > revenue > dept > none", () => {
    expect(moneyViewOf({ margins: true, revenue: true, level: "finance", scope: null })).toEqual({ kind: "margins" });
    expect(moneyViewOf({ margins: false, revenue: true, level: "administrator", scope: null })).toEqual({ kind: "revenue" });
    expect(moneyViewOf({ margins: false, revenue: false, level: "dept_admin", scope: ["altercpa"] })).toEqual({ kind: "dept", scope: ["altercpa"] });
    expect(moneyViewOf({ margins: false, revenue: false, level: "dept_admin", scope: [] })).toEqual({ kind: "none" });
    expect(moneyViewOf({ margins: false, revenue: false, level: "team_lead", scope: [] })).toEqual({ kind: "none" });
  });

  it("scopeSources: requested ∩ scope, else the whole scope", () => {
    expect(scopeSources(["altercpa", "social"], CENTAR_DEPTS)).toEqual(["social"]);
    expect(scopeSources(["altercpa"], CENTAR_DEPTS)).toEqual(["teleshop_out", "teleshop_other", "social"]);
    expect(scopeSources([], MADZARI_DEPTS)).toEqual(["altercpa", "elyon_crm"]);
  });

  it("maps a scope to its teams and MEX accounts", () => {
    expect(teamsOfScope(CENTAR_DEPTS)).toEqual(["teleshop"]);
    expect(teamsOfScope(MADZARI_DEPTS)).toEqual(["affiliate"]);
    expect(mexAccountsOfScope(CENTAR_DEPTS)).toEqual(["natura"]);
    expect(mexAccountsOfScope(MADZARI_DEPTS)).toEqual(["bio_natural"]);
    expect(mexAccountsOfScope(["management"])).toEqual([]);
  });
});

describe("margin strips", () => {
  it("agent-performance loses profit only", () => {
    const rows = [{ full_name: "A", paid_revenue: 10, total_profit: 3, net_contribution: 2, profit_per_lead: 1 }];
    expect(stripAgentPerformanceMargins(rows)).toEqual([{ full_name: "A", paid_revenue: 10 }]);
    expect(rows[0].total_profit).toBe(3); // never mutates
  });

  it("management-insights loses the margin blocks and cost / bonus keys, keeps revenue", () => {
    const body = {
      meta: { from: "x" }, overview: { revenue: 100, paid_revenue: 80 },
      profit: { total_profit: 5 }, pure_profit: { cogs: 1 }, margin_lab: [], logistics: [], channel_pl: {},
      products_stock: { top_sellers: [{ product: "P", units: 2, cost_price: 3 }] },
      agents: [{ name: "A", revenue: 50, bonus_paid: 4 }],
    };
    const out = stripManagementInsightsMargins(body);
    expect(Object.keys(out).sort()).toEqual(["agents", "meta", "overview", "products_stock"]);
    expect(out.overview).toEqual({ revenue: 100, paid_revenue: 80 });
    expect(hasKeyDeep(out, /^(cost_price|bonus_paid)$/)).toBe(false);
    expect((out.meta as Record<string, unknown>).margins).toBe(false);
  });

  it("returns lose the round trip", () => {
    const out = stripReturnsMargins({ kpis: { returned: { count: 2, value_mkd: 10 }, round_trip: { return_cost_mkd: 5 } } });
    expect(out).toEqual({ kpis: { returned: { count: 2, value_mkd: 10 } } });
  });

  it("stock loses cost, stock value and valuation", () => {
    const out = stripStockMargins({ valuation: { total: 1 }, products: [{ name: "P", cost_mkd: 3, value_mkd: 9, stock_value_mkd: 7, units: 4 }] });
    expect(out).toEqual({ products: [{ name: "P", value_mkd: 9, units: 4 }] });
  });

  it("shops lose every cost and margin key, keep sales", () => {
    for (const k of ["cost_mkd", "group_cost_mkd", "group_margin_mkd", "shop_margin_mkd", "avg_cost_mkd", "value_cost_mkd", "natura_cost_mkd", "natura_margin_mkd", "margin_pct"]) {
      expect(isShopsMarginKey(k)).toBe(true);
    }
    for (const k of ["sales_mkd", "value_mkd", "receipts", "cost_above_sales"]) expect(isShopsMarginKey(k)).toBe(false);
    expect(stripShopsMargins({ shops: [{ code: "001", sales_mkd: 9, shop_margin_mkd: 2 }] })).toEqual({ shops: [{ code: "001", sales_mkd: 9 }] });
  });

  it("stock v2 for a revenue viewer keeps only the COD", () => {
    const out = stockV2RevenueView({ rows: [{ tracking_id: "t", cod_mkd: 2500, cost_mkd: 300, value_mkd: 900, cost_price: 5, x_eur: 1 }] });
    expect(out).toEqual({ rows: [{ tracking_id: "t", cod_mkd: 2500 }] });
  });

  it("dashboard loses the payout, also in personalMetrics", () => {
    expect(stripDashboardMargins({ paid_revenue: 1, payout_earned: 2, personalMetrics: { payout_earned: 3, deals_won: 1 } }))
      .toEqual({ paid_revenue: 1, personalMetrics: { deals_won: 1 } });
  });

  it("suggested price never reveals the cost to a non-margin viewer", () => {
    expect(suggestedPrice(20, 4, false)).toBe(20);
    expect(suggestedPrice(0, 7, true)).toBe(21);
    expect(suggestedPrice(0, 7, false)).toBe(15);
    expect(suggestedPrice(null, 1, true)).toBe(15);
  });
});

describe("dept_admin scoping", () => {
  it("sales core: the cohort's parts, trend per department, channels / timing counts only", () => {
    const counts = { meta: { money: false, part: "core" }, total: { count: 10 }, channels: [{ account: "natura", count: 5 }], timing: { cells: [{ dow: 1, hour: 9, count: 2 }] }, trend: { granularity: "day", points: [] } };
    const raw = {
      channels: [{ account: "natura", count: 5, cod_mkd: 9 }],
      trend: { points: [{ d: "2026-10-01", count: 9, value_mkd: 99, by_source: [{ key: "altercpa", count: 4, value_mkd: 40 }, { key: "social", count: 5, value_mkd: 59 }] }] },
    };
    const cohort = {
      total: { count: 4, value_mkd: 40 }, buckets: [{ key: "paid", count: 4, value_mkd: 40 }], outside: [],
      by_source: [{ key: "altercpa", total: { count: 4, value_mkd: 40 } }], quality: [],
      prev: { total: { count: 3, value_mkd: 30 }, buckets: [] },
    };
    const out = scopeSalesCore(counts, raw, cohort, MADZARI_DEPTS, true);
    expect(out.total).toEqual({ count: 4, value_mkd: 40 });
    expect((out.trend as any).points).toEqual([{ d: "2026-10-01", count: 4, value_mkd: 40, by_source: [{ key: "altercpa", count: 4, value_mkd: 40 }] }]);
    expect((out.trend as any).granularity).toBe("day");
    expect(hasKeyDeep(out.channels, /_mkd$/)).toBe(false);
    expect(out.prev).toEqual({ total: { count: 3, value_mkd: 30 }, buckets: [], by_source: [] });
    expect(out.meta).toEqual({ money: true, part: "core", dept_scope: ["altercpa", "elyon_crm"] });
    expect(scopeSalesCore(counts, raw, cohort, MADZARI_DEPTS, false).prev).toBeNull();
  });

  it("sales detail: company-wide counts, labelled", () => {
    const out = scopeSalesDetail({ meta: { money: false }, products: { rows: [{ name: "P", sales: 2, value_mkd: 5 }] } }, CENTAR_DEPTS);
    expect(hasKeyDeep(out, /_mkd$/)).toBe(false);
    expect(out.meta).toEqual({ money: false, dept_scope: ["teleshop_out", "teleshop_other", "social"], company_wide: true });
  });

  it("agents: only their team, totals from their departments, no cod / paid / prev", () => {
    const raw = {
      meta: { access: "owner", money: true },
      people: [{ person_id: "p1", team_key: "affiliate", value_mkd: 10 }, { person_id: "p2", team_key: "teleshop", value_mkd: 20 }],
      teams: [
        { key: "affiliate", sales: 3, worked: 9, sale_decisions: 3, spark: [{ d: "2026-10-01", sales: 3, worked: 9, sale_decisions: 3 }] },
        { key: "teleshop", sales: 7, worked: 1, spark: [{ d: "2026-10-01", sales: 7, worked: 1 }] },
      ],
      totals: {
        sales: 10, value_mkd: 30, cod_mkd: 25, paid_mkd: 12, prev: { sales: 1 }, conversion: 0.5,
        by_source: [{ key: "altercpa", sales: 2, value_mkd: 8, with_person: 2, with_person_mkd: 8 }, { key: "elyon_crm", sales: 1, value_mkd: 2, with_person: 0, with_person_mkd: 0 }, { key: "social", sales: 7, value_mkd: 20, with_person: 7, with_person_mkd: 20 }],
      },
      spark: [{ d: "2026-10-01", sales: 10, value_mkd: 30 }],
      no_seller: { count: 3, handles: ["x"], reasons: [{ source: "altercpa", count: 1, value_mkd: 2 }, { source: "web", count: 2, value_mkd: 5 }] },
      detail: { person_id: "p2", days: [] },
    };
    const out = scopePeople(raw, MADZARI_DEPTS, "p2");
    expect((out.people as any[]).map((p) => p.person_id)).toEqual(["p1"]);
    expect((out.teams as any[]).map((t) => t.key)).toEqual(["affiliate"]);
    const t = out.totals as Record<string, unknown>;
    expect(t.sales).toBe(3);
    expect(t.value_mkd).toBe(10);
    expect(t.without_person).toBe(1);
    expect(t.without_person_mkd).toBe(2);
    expect(t.worked).toBe(9);
    for (const k of ["cod_mkd", "paid_mkd", "prev", "conversion"]) expect(k in t).toBe(false);
    expect(out.spark).toEqual([{ d: "2026-10-01", sales: 3, worked: 9, sale_decisions: 3 }]);
    expect(out.no_seller).toEqual({ count: 1, handles: [], reasons: [{ source: "altercpa", count: 1, value_mkd: 2 }] });
    expect(out.detail).toBeNull();
    expect(out.meta).toEqual({ access: "dept", money: true, dept_scope: ["altercpa", "elyon_crm"] });
    expect(scopePeople(raw, MADZARI_DEPTS, "p1").detail).toEqual(raw.detail);
  });

  it("MEX cash: only the account of their departments", () => {
    const acc = (n: number) => ({ parcels: n, cod_mkd: n * 10 });
    const body = {
      meta: { accounts: ["natura", "bio_natural"], money: true },
      days: [{ d: "2026-10-01", natura: acc(1), bio_natural: acc(2) }],
      total: { natura: acc(1), bio_natural: acc(2) },
      halves: [{ from: "2026-10-01", to: "2026-10-15", complete: false, natura: acc(1), bio_natural: acc(2) }],
      now: { natura: { courier: 1 }, bio_natural: { courier: 2 } },
    };
    const m = scopeMexCash(body, MADZARI_DEPTS);
    expect(m.days).toEqual([{ d: "2026-10-01", bio_natural: acc(2) }]);
    expect(m.total).toEqual({ bio_natural: acc(2) });
    expect(m.now).toEqual({ bio_natural: { courier: 2 } });
    expect((m.halves as any[])[0]).toEqual({ from: "2026-10-01", to: "2026-10-15", complete: false, bio_natural: acc(2) });
    expect(m.meta).toEqual({ accounts: ["bio_natural"], money: true, dept_scope: ["altercpa", "elyon_crm"] });
    const c = scopeMexCash(body, CENTAR_DEPTS);
    expect(c.total).toEqual({ natura: acc(1) });
    expect((c.meta as any).account_note).toBe("natura_includes_web");
  });

  it("orders: values only for their departments (unknown department = hidden)", () => {
    const rows = [
      { id: "1", department: "social", price: 30, order_items: [{ product_name: "P", quantity: 1, price_per_unit: 30, total_price: 30 }] },
      { id: "2", department: "altercpa", price: 40, mex_cod_mkd: 2400, order_items: [{ product_name: "Q", quantity: 1, price_per_unit: 40, total_price: 40 }] },
      { id: "3", department: null, price: 5 },
    ];
    const out = scopeOrderValues(rows, CENTAR_DEPTS);
    expect(out[0]).toBe(rows[0]);
    expect(out[1]).toEqual({ id: "2", department: "altercpa", order_items: [{ product_name: "Q", quantity: 1 }], value_hidden: true });
    expect(out[2]).toEqual({ id: "3", department: null, value_hidden: true });
    expect(hideOrderValue({ price: 1 } as Record<string, unknown>)).toEqual({ value_hidden: true });
  });

  it("operations: their departments' value today beside the company's counts", () => {
    const kpi = { sales_today: 50, sales_value_today_mkd: 999, collected_value_today_mkd: 888, by_department: [] };
    expect(scopeOperationsKpi(kpi, { total: { count: 12, value_mkd: 3400 } }, CENTAR_DEPTS)).toEqual({
      sales_today: 50, by_department: [], dept_scope: ["teleshop_out", "teleshop_other", "social"], dept_sales_today: 12, sales_value_today_mkd: 3400,
    });
    expect(scopeOperationsKpi(kpi, null, CENTAR_DEPTS)).toEqual({
      sales_today: 50, by_department: [], dept_scope: ["teleshop_out", "teleshop_other", "social"], dept_sales_today: null,
    });
  });
});
