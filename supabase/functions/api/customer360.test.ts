import { describe, expect, it } from "vitest";
import { parseTimelinePhone, shapeTimeline } from "./customer360.ts";
import type { TimelineAccess } from "./customer360.ts";

// Shaped like customer_timeline(…, true): every money key the SQL can emit.
const sample = () => ({
  ok: true,
  phone8: "76451040",
  money: true,
  customer: { names: ["Goran Todorovski", "Горан"], cities: ["Skopje"], first_seen: "2024-06-11T19:28:50Z" },
  summary: { orders: 1, parcels: 3, lifetime_delivered_mkd: 7450, paid_orders_eur: 0, lists: ["Never-Converted Recent"] },
  events: [
    {
      kind: "order", key: "o:1", at: "2026-09-04T02:29:02Z", status: "cancelled", amount_eur: 32.36,
      customer_name: "Goran Todorovski",
      lead: { altercpa_id: "1472013", webmaster: "2676", price_eur: 32.36, customer_name: "Goran Todorovski" },
      parcels: [{ tracking_id: "002-9102-1/2026", cod_mkd: 2250, receiver_name: "Горан" }],
      refs: { order_id: "1", display_id: "ORD-97278" },
    },
    {
      kind: "web_order", key: "w:1", at: "2024-06-26T14:05:31Z", status: "delivered",
      amount_mkd: 1980, shipping_mkd: 130, currency: "MKD",
      parcels: [{ tracking_id: "NTMK40556", cod_mkd: 1980 }],
    },
    { kind: "altercpa_lead", key: "a:1", lead: { webmaster: "3221", price_eur: 24.23, offer: "GlucoCare" } },
    { kind: "parcel", key: "p:1", parcel: { tracking_id: "002-9100-1/2026", cod_mkd: 1000, receiver_name: "Теодора" } },
    // a money key the SQL might grow later must still be dropped by rule
    { kind: "parcel", key: "p:2", parcel: { tracking_id: "x", refund_mkd: 5 }, amount_eur: 9 },
  ],
});

const OWNER: TimelineAccess = { money: true, cpaProvenance: true, showNames: true };
const AGENT: TimelineAccess = { money: false, cpaProvenance: false, showNames: true };
const mask = (v: string) => `masked(${v})`;

function keysDeep(o: unknown, acc: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((x) => keysDeep(x, acc));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { acc.push(k); keysDeep(v, acc); }
  return acc;
}

describe("parseTimelinePhone", () => {
  it("normalises every spelling of one number to its last 8 digits", () => {
    for (const p of ["078211876", "+38978211876", "38978211876", "078 211 876", "+389 (78) 211-876"]) {
      expect(parseTimelinePhone(p)).toEqual({ phone8: "78211876" });
    }
  });
  it("refuses fewer than 8 digits", () => {
    expect(parseTimelinePhone("1234567")).toEqual({ error: "phone_too_short" });
    expect(parseTimelinePhone("")).toEqual({ error: "phone_too_short" });
    expect(parseTimelinePhone(null)).toEqual({ error: "phone_too_short" });
    // a masked phone (role without show_customer_phone) never has 8 digits
    expect(parseTimelinePhone("••••••876")).toEqual({ error: "phone_too_short" });
  });
  it("refuses scientific-notation pollution", () => {
    expect(parseTimelinePhone("3.89782e+11")).toEqual({ error: "phone_corrupted" });
  });
});

describe("shapeTimeline", () => {
  it("passes an owner's payload through unchanged", () => {
    const out = shapeTimeline(sample(), OWNER);
    expect(out).toEqual(sample());
  });

  it("strips every owner-only money key for a non-owner, keeping the CRM order price", () => {
    const out = shapeTimeline(sample(), AGENT) as any;
    const keys = keysDeep(out);
    for (const k of ["cod_mkd", "amount_mkd", "shipping_mkd", "currency", "price_eur", "lifetime_delivered_mkd", "paid_orders_eur", "refund_mkd"]) {
      expect(keys).not.toContain(k);
    }
    expect(out.money).toBe(false);
    expect(out.events[0].amount_eur).toBe(32.36);   // order price stays
    expect(out.events[4].amount_eur).toBeUndefined(); // …but only on order events
    expect(out.summary.orders).toBe(1);
    expect(out.events[0].parcels[0].tracking_id).toBe("002-9102-1/2026");
  });

  it("hides the webmaster from non-admin/manager callers only", () => {
    expect(keysDeep(shapeTimeline(sample(), AGENT))).not.toContain("webmaster");
    const mgr = shapeTimeline(sample(), { ...AGENT, cpaProvenance: true }) as any;
    expect(mgr.events[0].lead.webmaster).toBe("2676");
  });

  it("masks customer and receiver names when the role cannot see names", () => {
    const out = shapeTimeline(sample(), { ...AGENT, showNames: false, maskName: mask }) as any;
    expect(out.customer.names).toEqual(["masked(Goran Todorovski)", "masked(Горан)"]);
    expect(out.events[0].customer_name).toBe("masked(Goran Todorovski)");
    expect(out.events[0].lead.customer_name).toBe("masked(Goran Todorovski)");
    expect(out.events[0].parcels[0].receiver_name).toBe("masked(Горан)");
    expect(out.events[3].parcel.receiver_name).toBe("masked(Теодора)");
  });

  it("passes the SQL's refusal through and rejects garbage", () => {
    expect(shapeTimeline({ ok: false, error: "phone_too_short" }, OWNER)).toEqual({ ok: false, error: "phone_too_short" });
    expect(shapeTimeline(null, OWNER)).toEqual({ ok: false, error: "bad_response" });
    expect(shapeTimeline([1, 2], OWNER)).toEqual({ ok: false, error: "bad_response" });
  });

  it("does not mutate its input", () => {
    const s = sample();
    shapeTimeline(s, { ...AGENT, showNames: false, maskName: mask });
    expect(s).toEqual(sample());
  });
});
