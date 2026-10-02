import { describe, expect, it } from "vitest";
import {
  APP_SETTINGS_MANAGER_KEYS, APP_SETTINGS_STAFF_KEYS, appSettingsForViewer, canReadPayout,
  payoutReadAgentId, PRODUCT_ADMIN_FIELDS, productAdminFieldChanges, stripAgentContacts,
  stripBookingsMoney, stripDashboardMoney, stripIncomingOrderMoney,
} from "./accessGuards.ts";

// computeMetrics() + the admin branch's envelope, as GET /dashboard-stats answers it.
const metrics = () => ({
  lead_count: 4, deals_won: 12, deals_lost: 3, total_value: 1840.5, tasks_completed: 40, total_orders: 15,
  daily: { "2026-10-02": { leads: 4, deals_won: 12, deals_lost: 3, orders: 15, calls: 40 } },
  statusCounts: { confirmed: 7, paid: 5 }, orders_from_standard: 12, orders_from_leads: 0,
  products_sold: { "Чаги": 6 }, units_sold: 6,
  packages_sold: 6, packages_awaiting: 9, packages_returned: 1, returns_orders: 1,
  paid_revenue: 512.3, payout_earned: 18,
  from: "2026-10-01T22:00:00.000Z", to: "2026-10-02T21:59:59.999Z",
});

describe("stripDashboardMoney", () => {
  it("keeps every count and drops total_value, paid_revenue and payout_earned", () => {
    const out = stripDashboardMoney({ ...metrics(), personalMetrics: null, isDualRole: false, period: "today" });
    for (const k of ["total_value", "paid_revenue", "payout_earned"]) expect(out).not.toHaveProperty(k);
    expect(out).toMatchObject({
      lead_count: 4, deals_won: 12, deals_lost: 3, tasks_completed: 40, total_orders: 15,
      orders_from_standard: 12, orders_from_leads: 0, units_sold: 6,
      packages_sold: 6, packages_awaiting: 9, packages_returned: 1, returns_orders: 1,
      statusCounts: { confirmed: 7, paid: 5 }, products_sold: { "Чаги": 6 },
      personalMetrics: null, isDualRole: false, period: "today", money: false,
    });
    expect(out.daily).toEqual(metrics().daily);
  });

  it("strips personalMetrics with the same list", () => {
    const out = stripDashboardMoney({ ...metrics(), personalMetrics: metrics(), isDualRole: true, period: "month" });
    const pm = out.personalMetrics as Record<string, unknown>;
    expect(pm).not.toHaveProperty("paid_revenue");
    expect(pm).not.toHaveProperty("payout_earned");
    expect(pm).not.toHaveProperty("total_value");
    expect(pm.packages_sold).toBe(6);
  });

  it("drops any key it does not know (a money field added later never leaks)", () => {
    const out = stripDashboardMoney({ ...metrics(), avg_per_package: 85, revenue_confirmed: 900, value_mkd: 1, deals_won: 1 });
    expect(out).not.toHaveProperty("avg_per_package");
    expect(out).not.toHaveProperty("revenue_confirmed");
    expect(out).not.toHaveProperty("value_mkd");
    expect(out.deals_won).toBe(1);
  });
});

describe("payout read scope", () => {
  const SELF = "11111111-1111-1111-1111-111111111111";
  const OTHER = "22222222-2222-2222-2222-222222222222";

  it("an owner reads anyone, or everyone when no agent is asked", () => {
    expect(payoutReadAgentId(true, OTHER, SELF)).toBe(OTHER);
    expect(payoutReadAgentId(true, null, SELF)).toBeNull();
    expect(payoutReadAgentId(true, "", SELF)).toBeNull();
  });

  it("a non-owner (manager or agent) reads only their own, whatever they pass", () => {
    expect(payoutReadAgentId(false, OTHER, SELF)).toBe(SELF);
    expect(payoutReadAgentId(false, null, SELF)).toBe(SELF);
  });

  it("one settlement: the owner, or the agent it belongs to", () => {
    expect(canReadPayout(true, OTHER, SELF)).toBe(true);
    expect(canReadPayout(false, SELF, SELF)).toBe(true);
    expect(canReadPayout(false, OTHER, SELF)).toBe(false);
    expect(canReadPayout(false, null, SELF)).toBe(false);
  });
});

describe("appSettingsForViewer", () => {
  const all = {
    personal_list_max_holds: 50, unpaid_chase_days: 3, unpaid_chase_stop_days: 30, disposition_note_min: 5,
    promo_of_the_day: { enabled: false }, altercpa_push_enabled: false,
    no_parcel_rule: { days: 10, mode: "apply" }, presence_idle_alert_minutes: 30,
    presence_idle_alert_hours: { from: 8, to: 20 }, presence_idle_alert_recipients: ["owners"], presence_idle_alert_scope: "agents",
    voip_minutes_bundle: { included_minutes: 0 },
    mex_cash: { viewers: ["mile", "hedi"] }, out_bonus: { tiers: [1, 2, 3] }, stock_v2: { enabled: false },
    mex_push: { enabled: false }, shops_reader: { enabled: true },
  };

  it("an admin gets every key, untouched", () => {
    expect(appSettingsForViewer(all, { admin: true, manager: true })).toBe(all);
  });

  it("an agent gets only the keys the agent UI reads", () => {
    const out = appSettingsForViewer(all, { admin: false, manager: false });
    expect(Object.keys(out).sort()).toEqual([...APP_SETTINGS_STAFF_KEYS].sort());
    expect(out.personal_list_max_holds).toBe(50);
    expect(out.unpaid_chase_days).toBe(3);
  });

  it("a manager also gets the read-only Правила keys — never the owner switches", () => {
    const out = appSettingsForViewer(all, { admin: false, manager: true });
    expect(Object.keys(out).sort()).toEqual([...APP_SETTINGS_STAFF_KEYS, ...APP_SETTINGS_MANAGER_KEYS].sort());
    for (const k of ["mex_cash", "out_bonus", "stock_v2", "mex_push", "shops_reader", "voip_minutes_bundle"]) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it("a key the settings do not hold is simply absent", () => {
    expect(appSettingsForViewer({ personal_list_max_holds: 7 }, { admin: false, manager: true })).toEqual({ personal_list_max_holds: 7 });
  });
});

describe("stripAgentContacts", () => {
  const rows = [
    { user_id: "a", full_name: "Нина", email: "nina@elyon-mk.local", roles: ["admin"] },
    { user_id: "name:x", full_name: "Стара", email: "", roles: [], is_virtual: true, order_count: 4 },
  ];

  it("an admin keeps the e-mail", () => {
    expect(stripAgentContacts(rows, true)).toEqual(rows);
  });

  it("anyone else gets names, ids and roles — no e-mail or phone", () => {
    const out = stripAgentContacts([{ ...rows[0], phone: "+38970123456" }, rows[1]], false);
    expect(out[0]).toEqual({ user_id: "a", full_name: "Нина", roles: ["admin"] });
    expect(out[1]).toEqual({ user_id: "name:x", full_name: "Стара", roles: [], is_virtual: true, order_count: 4 });
    expect(rows[0]).toHaveProperty("email"); // the input is not mutated
  });
});

describe("stripIncomingOrderMoney", () => {
  it("drops the row price and every line price, keeps the rest", () => {
    const row = {
      id: "o1", display_id: "A-1", customer_name: "Марија", price: 39.9, quantity: 2, status: "confirmed",
      order_items: [{ id: "i1", product_name: "Чаги", quantity: 2, price_per_unit: 19.95, total_price: 39.9 }],
    };
    const out = stripIncomingOrderMoney(row);
    expect(out).toEqual({
      id: "o1", display_id: "A-1", customer_name: "Марија", quantity: 2, status: "confirmed",
      order_items: [{ id: "i1", product_name: "Чаги", quantity: 2 }],
    });
    expect(row.price).toBe(39.9);
    expect(row.order_items[0].price_per_unit).toBe(19.95);
  });

  it("a full orders row (the PATCH answer) loses its COD and money columns too", () => {
    const out = stripIncomingOrderMoney({ id: "o1", price: 10, mex_cod_mkd: 765, price_eur: 10, actual_logistics_cost: 2.4, city: "Скопје" });
    expect(out).toEqual({ id: "o1", city: "Скопје" });
  });

  it("a row without order_items stays without them", () => {
    expect(stripIncomingOrderMoney({ id: "l1", price: 5 })).toEqual({ id: "l1" });
  });
});

describe("stripBookingsMoney", () => {
  it("drops value_mkd from every row, keeps counts and the envelope", () => {
    const resp = {
      rows: [{ doc_number: "9102000123", department: "teleshop_out", value_mkd: 2460, seller_name: "Ана" }],
      total: 1, by_department: { teleshop_out: 1 }, clamped: false,
      window: { from: "2026-10-01", to: "2026-10-02" }, lookback_days: 29,
    };
    const out = stripBookingsMoney(resp);
    expect(out.rows).toEqual([{ doc_number: "9102000123", department: "teleshop_out", seller_name: "Ана" }]);
    expect(out).toMatchObject({ total: 1, by_department: { teleshop_out: 1 }, clamped: false, lookback_days: 29 });
    expect(resp.rows[0].value_mkd).toBe(2460);
  });
});

describe("productAdminFieldChanges", () => {
  const current = { name: "Чаги Детокс", price: 19.9, is_active: true };

  it("covers exactly the name, the price and the active switch", () => {
    expect([...PRODUCT_ADMIN_FIELDS]).toEqual(["name", "price", "is_active"]);
  });

  it("a patch of other fields changes nothing admin-only", () => {
    expect(productAdminFieldChanges({ description: "x", sku: "C-1" }, current)).toEqual([]);
  });

  it("an unchanged value the form re-sends is not a change", () => {
    expect(productAdminFieldChanges({ name: "Чаги Детокс", price: 19.9, is_active: true }, current)).toEqual([]);
    expect(productAdminFieldChanges({ price: 19.9 }, { ...current, price: "19.90" })).toEqual([]);
  });

  it("names every admin-only field that would change", () => {
    expect(productAdminFieldChanges({ price: 24.9 }, current)).toEqual(["price"]);
    expect(productAdminFieldChanges({ is_active: false, name: "Чаги" }, current)).toEqual(["name", "is_active"]);
  });

  it("a price over a missing stored price is a change", () => {
    expect(productAdminFieldChanges({ price: 0 }, { name: "x", price: null, is_active: true })).toEqual(["price"]);
    expect(productAdminFieldChanges({ price: 5 }, null)).toEqual(["price"]);
  });
});
