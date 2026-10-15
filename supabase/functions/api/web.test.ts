import { describe, expect, it } from "vitest";
import { channelGroup, groupChannels, ratio, shapeCustomers, shapeWebPage } from "./web.ts";

const rpc = {
  from: "2026-10-01", to: "2026-10-15", spend_from: "2026-10-01", floor_day: "2026-09-11",
  total: { orders: 367, value_mkd: "795619", paid: 206, paid_mkd: 451903, returned: 13, returned_mkd: 27025, no_order: 0 },
  channels: [
    { channel: "organic_search", source: "google", orders: 139, value_mkd: 290465, paid: 75, paid_mkd: 159269, returned: 2, returned_mkd: 4490 },
    { channel: "paid_social", source: "facebook", orders: 113, value_mkd: 225501, paid: 63, paid_mkd: 127459, returned: 7, returned_mkd: 12655 },
    { channel: "paid_social", source: "instagram", orders: 55, value_mkd: 129833, paid: 29, paid_mkd: 66765, returned: 3, returned_mkd: 5900 },
    { channel: "direct", source: "", orders: 29, value_mkd: 72830, paid: 19, paid_mkd: 50975, returned: 0, returned_mkd: 0 },
  ],
  paid_social: { orders: 170, value_mkd: 358684, paid: 94, paid_mkd: 197574, returned: 10, returned_mkd: 18555, no_campaign: 0 },
  ads: { spend_mkd: "162358.03", spend_other_mkd: 65335.32, impressions: 1792630, link_clicks: 14973, meta_purchases: 310, currency: "USD", synced_at: "2026-10-15T17:33:03Z" },
  campaigns: [
    { id: "1", name: "ABO", status: "ACTIVE", orders: 70, value_mkd: 142344, paid: 40, paid_mkd: 78956, returned: 2, returned_mkd: 3900, spend_mkd: 64260.49, impressions: 1, link_clicks: 1, meta_purchases: 137 },
    { id: "2", name: "Test", status: "PAUSED", orders: 0, value_mkd: 0, paid: 0, paid_mkd: 0, returned: 0, returned_mkd: 0, spend_mkd: 4349.73, meta_purchases: 6 },
  ],
  daily: [{ d: "2026-10-01", orders: 19, value_mkd: 38220, paid_social_mkd: 20000, spend_mkd: 9000 }],
  coupons: [{ code: "WELCOME10", orders: 21, value_mkd: 45104 }],
  cities: [{ city: "Skopje", orders: 105, value_mkd: 227503, returned: 5 }],
  payment: [{ method: "COD", orders: 319, value_mkd: 673158, returned: 13 }],
  products: [{ name: "Magnesium", qty: 488, value_mkd: 334622.5, orders: 191 }],
  lost: { card_unpaid: { orders: 57, value_mkd: 125800 } },
};

describe("shapeWebPage — the money wall", () => {
  it("margin viewers get the spend and the ratios", () => {
    const p = shapeWebPage(rpc, true);
    expect(p.total.value_mkd).toBe(795619);
    expect(p.ads?.spend_mkd).toBeCloseTo(162358.03);
    expect(p.ads?.roas).toBeCloseTo(358684 / 162358.03);
    expect(p.ads?.paid_roas).toBeCloseTo(197574 / 162358.03);
    expect(p.ads?.cost_per_order).toBeCloseTo(162358.03 / 170);
    expect(p.ads?.ctr).toBeCloseTo(14973 / 1792630);
    expect(p.campaigns).toHaveLength(2);
    expect(p.campaigns[0].roas).toBeCloseTo(142344 / 64260.49);
    expect(p.campaigns[1].roas).toBe(0);
    expect(p.daily[0].spend_mkd).toBe(9000);
    expect(p.lost.card_unpaid).toEqual({ orders: 57, value_mkd: 125800 });
    expect(p.lost.cancelled).toEqual({ orders: 0, value_mkd: 0 });
  });
  it("revenue viewers: no ads block, no spend keys, no spend-only campaigns", () => {
    const p = shapeWebPage(rpc, false);
    expect(p.ads).toBeNull();
    expect(p.campaigns).toHaveLength(1);
    expect("spend_mkd" in p.campaigns[0]).toBe(false);
    expect("roas" in p.campaigns[0]).toBe(false);
    expect("spend_mkd" in p.daily[0]).toBe(false);
    expect(p.access.margins).toBe(false);
    expect(JSON.stringify(p)).not.toContain("162358");
  });
  it("garbage in → zeros, never a crash", () => {
    const p = shapeWebPage(null, true);
    expect(p.total.orders).toBe(0);
    expect(p.ads?.roas).toBeNull();
    expect(p.campaigns).toEqual([]);
  });
});

describe("ratios and channel groups", () => {
  it("no spend = no ROAS", () => {
    expect(ratio(100, 0)).toBeNull();
    expect(ratio(100, 50)).toBe(2);
  });
  it("groups the shop's channels", () => {
    expect(channelGroup("paid_social")).toBe("paid");
    expect(channelGroup("organic_search")).toBe("organic");
    expect(channelGroup("organic_social")).toBe("organic");
    expect(channelGroup("weird")).toBe("other");
    const g = groupChannels(shapeWebPage(rpc, false).channels);
    expect(g[0]).toMatchObject({ group: "paid", orders: 168, value_mkd: 355334 });
    expect(g.find((x) => x.group === "organic")?.orders).toBe(139);
    expect(g.reduce((s, x) => s + x.orders, 0)).toBe(139 + 113 + 55 + 29);
  });
});

describe("shapeCustomers", () => {
  it("fills every recency bucket", () => {
    const c = shapeCustomers({ total: 3, with_email: 2, recency: { d21_57: { count: 2, with_email: 2 } }, cities: [{ city: "Skopje", count: 2 }] });
    expect(c.recency.d21_57).toEqual({ count: 2, with_email: 2 });
    expect(c.recency.never).toEqual({ count: 0, with_email: 0 });
    expect(c.cities[0]).toEqual({ city: "Skopje", count: 2 });
    expect(c.synced_at).toBeNull();
  });
});
