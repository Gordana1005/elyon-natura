import { describe, expect, it } from "vitest";
import {
  addDaysYmd, attentionFilter, buildOverviewResponse, cashWindowOrFilter, daysInclusive, isSafeText, isUuid, isValidYmd, outcomeOrFilter,
  overviewWindows, parseCsvParam, parseDetailParam, parsePivotBy, SALE_SOURCES,
  skopjeDayEndIso, skopjeMidnightIso, skopjeTodayYmd, soldWindowOrFilter, stripOverviewMoney,
} from "./overview.ts";
import type { OverviewWindow } from "./overview.ts";

// A payload shaped like insights_overview's, with every money field the
// contract names (value_eur, cod_mkd, collected_mkd, to_collect_eur, lost_eur,
// aov_eur, sold_value_eur, delivered_cash_mkd, spark, trend money).
const sample = () => ({
  meta: { from: "2026-09-22", to: "2026-09-22", money: true },
  window: { from: "2026-09-21T22:00:00+00:00", days: 1, granularity: "day" },
  freshness: [{ feed: "altercpa", last_ok_at: "2026-09-27T22:28:02Z", status: "ok", detail: "rolling" }],
  kpis: {
    placed: { count: 502, value_eur: 6880.07 },
    confirmed: { count: 97, value_eur: 4354.71 },
    at_courier: { count: 23, value_eur: 1066.19, cod_mkd: 66020 },
    delivered: { count: 288, cod_mkd: 702785, proven_count: 288, proven_cod_mkd: 702785, unproven_count: 0,
                 unproven_cod_mkd: 0, mex_only_count: 158, mex_only_cod_mkd: 340405 },
    to_collect: { count: 60, value_eur: 2591.11 },
    lost: { count: 0, value_eur: 0 },
    unproven_paid: { count: 0, value_eur: 0, cod_mkd: 0 },
    prev: { placed: { count: 580, value_eur: 5793.97 } },
    spark: { from: "2026-09-09", placed_value: [{ d: "2026-09-22", v: 6880.07 }], delivered_cash_mkd: [{ d: "2026-09-22", v: 702785 }] },
  },
  sources: [{
    key: "elyon_crm",
    placed: { count: 362, value_eur: 1692.71 },
    buckets: { delivered: { count: 18, value_eur: 796.77, cod_mkd: 49000, proven_count: 18 }, mex_only: { count: 3, cod_mkd: 900 } },
    money: { collected_mkd: 49000, to_collect_eur: 895.94, lost_eur: 0 },
    cash: { count: 33, cod_mkd: 96700, proven_count: 33 },
    worked: 362, cohort_sold: 37, conversion: 0.1022, confirmed: 37, confirmed_value_eur: 1692.71, aov_eur: 45.75,
    splits: [{ key: "prediction_list", basis: "placed", count: 37, value_eur: 1692.71, sold_count: 27, sold_value_eur: 1268.31,
               drill: { sale_source: ["elyon_crm"], detail: ["prediction_list"] } }],
    drill: { sale_source: ["elyon_crm"] },
  }],
  trend: { granularity: "day", points: [{ bucket: "2026-09-22", by_source: { elyon_crm: {
    placed_count: 362, placed_value_eur: 1692.71, delivered_count: 33, delivered_cash_mkd: 96700 } } }] },
  teams: [{ team_key: "crm_prediction", name: "Prediction", mode: "prediction", online_now: 3, worked: 359,
            sold_value_eur: 1643.93, delivered_cash_mkd: 127360,
            members: [{ person_id: "p1", name: "Ruzhica", online_state: "online", online_min: 300, worked: 52,
                        confirmed: 5, conversion: 0.0962, sold_value_eur: 235.77, delivered_cash_mkd: 29060,
                        last_decision_at: "2026-09-22T17:41:09Z" }] }],
  attention: [
    { kind: "cod_mismatch", severity: "warning", count: 3, value_eur: 97.5, cod_mkd: 9000, diff_mkd: 3000,
      by_person: [{ person_id: "p1", name: "Nina", count: 3 }],
      sample: [{ display_id: "ORD-1", at: "2026-09-22T10:00:00Z", cod_mkd: 3000, price_mkd: 2000, diff_mkd: 1000, note: "COD <> price" }] },
    { kind: "unlinked_parcels", severity: "warning", count: 2, cod_mkd: 4000, value_eur: 65.04,
      by_account: [{ account: "natura", series: "9102", count: 2, cod_mkd: 4000 }] },
  ],
  a_future_money_field: { total: 123 },
});

const moneyKeys = (v: unknown, path = ""): string[] => {
  if (Array.isArray(v)) return v.flatMap((x, i) => moneyKeys(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
      ((/(_eur|_mkd)$/.test(k) || ["money", "spark", "v", "value", "total"].includes(k)) && `${path}.${k}` !== ".meta.money" ? [`${path}.${k}`] : [])
        .concat(moneyKeys(x, `${path}.${k}`)));
  }
  return [];
};

describe("stripOverviewMoney", () => {
  it("removes every money field at every depth and marks meta.money false", () => {
    const out = stripOverviewMoney(sample());
    expect(moneyKeys(out)).toEqual([]);
    expect((out.meta as any).money).toBe(false);
  });

  it("keeps counts, rates, names, times and drill filters", () => {
    const out = stripOverviewMoney(sample()) as any;
    expect(out.kpis.placed).toEqual({ count: 502 });
    expect(out.kpis.delivered).toEqual({ count: 288, proven_count: 288, unproven_count: 0, mex_only_count: 158 });
    expect(out.kpis.prev.placed).toEqual({ count: 580 });
    expect(out.kpis.spark).toBeUndefined();
    const s = out.sources[0];
    expect(s.money).toBeUndefined();
    expect(s.aov_eur).toBeUndefined();
    expect(s.confirmed).toBe(37);
    expect(s.conversion).toBe(0.1022);
    expect(s.buckets.delivered).toEqual({ count: 18, proven_count: 18 });
    expect(s.buckets.mex_only).toEqual({ count: 3 });
    expect(s.cash).toEqual({ count: 33, proven_count: 33 });
    expect(s.splits[0]).toEqual({ key: "prediction_list", basis: "placed", count: 37, sold_count: 27,
                                  drill: { sale_source: ["elyon_crm"], detail: ["prediction_list"] } });
    expect(out.trend.points[0].by_source.elyon_crm).toEqual({ placed_count: 362, delivered_count: 33 });
    expect(out.teams[0].members[0]).toEqual({ person_id: "p1", name: "Ruzhica", online_state: "online", online_min: 300,
      worked: 52, confirmed: 5, conversion: 0.0962, last_decision_at: "2026-09-22T17:41:09Z" });
    expect(out.attention[0].sample[0]).toEqual({ display_id: "ORD-1", at: "2026-09-22T10:00:00Z", note: "COD <> price" });
    expect(out.attention[1].by_account[0]).toEqual({ account: "natura", series: "9102", count: 2 });
    expect(out.freshness[0]).toEqual({ feed: "altercpa", last_ok_at: "2026-09-27T22:28:02Z", status: "ok", detail: "rolling" });
  });

  it("drops keys it does not know (fail closed for future fields)", () => {
    const out = stripOverviewMoney(sample()) as any;
    expect(out.a_future_money_field).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const p = sample();
    stripOverviewMoney(p);
    expect(p.kpis.placed.value_eur).toBe(6880.07);
  });
});

describe("buildOverviewResponse", () => {
  const win: OverviewWindow = {
    from: "2026-09-22", to: "2026-09-22", days: 1, fromIso: "x", toEndIso: "y", partial: false,
    prev: { from: "2026-09-21", to: "2026-09-21", fromIso: "a", toEndIso: "b" },
  };
  const now = new Date("2026-09-28T08:00:00Z");
  it("owners get the payload whole, meta.money true", () => {
    const r = buildOverviewResponse({ kpis: { placed: { count: 1, value_eur: 2 } } }, win, true, now) as any;
    expect(r.meta).toEqual({ from: "2026-09-22", to: "2026-09-22", prev_from: "2026-09-21", prev_to: "2026-09-21",
      prev_to_end: "b", partial: false, days: 1, generated_at: now.toISOString(), money: true });
    expect(r.kpis.placed.value_eur).toBe(2);
  });
  it("non-owners get it stripped, meta kept, meta.money false", () => {
    const r = buildOverviewResponse({ kpis: { placed: { count: 1, value_eur: 2 } } }, win, false, now) as any;
    expect(r.kpis.placed).toEqual({ count: 1 });
    expect(r.meta.money).toBe(false);
    expect(r.meta.prev_from).toBe("2026-09-21");
  });
});

describe("Skopje day bounds", () => {
  it("summer day: 00:00 CEST = 22:00Z the day before; end has microseconds", () => {
    expect(skopjeMidnightIso("2026-09-22")).toBe("2026-09-21T22:00:00.000Z");
    expect(skopjeDayEndIso("2026-09-22")).toBe("2026-09-22T21:59:59.999999Z");
  });
  it("winter day: 00:00 CET = 23:00Z the day before", () => {
    expect(skopjeMidnightIso("2026-01-15")).toBe("2026-01-14T23:00:00.000Z");
    expect(skopjeDayEndIso("2026-01-15")).toBe("2026-01-15T22:59:59.999999Z");
  });
  it("DST changeover days get the right midnight (a noon probe is an hour off)", () => {
    // 2026-03-29: clocks jump 02:00 → 03:00; midnight is still CET.
    expect(skopjeMidnightIso("2026-03-29")).toBe("2026-03-28T23:00:00.000Z");
    expect(skopjeDayEndIso("2026-03-29")).toBe("2026-03-29T21:59:59.999999Z");   // a 23-hour day
    // 2026-10-25: clocks fall back 03:00 → 02:00; midnight is still CEST.
    expect(skopjeMidnightIso("2026-10-25")).toBe("2026-10-24T22:00:00.000Z");
    expect(skopjeDayEndIso("2026-10-25")).toBe("2026-10-25T22:59:59.999999Z");   // a 25-hour day
  });
  it("today in Skopje, near midnight", () => {
    expect(skopjeTodayYmd(new Date("2026-09-27T22:06:19Z"))).toBe("2026-09-28");
    expect(skopjeTodayYmd(new Date("2026-09-27T21:59:59Z"))).toBe("2026-09-27");
  });
  it("calendar helpers", () => {
    expect(isValidYmd("2026-02-29")).toBe(false);
    expect(isValidYmd("2028-02-29")).toBe(true);
    expect(isValidYmd("2026-9-1")).toBe(false);
    expect(addDaysYmd("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysInclusive("2026-09-01", "2026-09-30")).toBe(30);
    expect(daysInclusive("2026-03-28", "2026-03-30")).toBe(3);
  });
});

describe("overviewWindows", () => {
  const now = new Date("2026-09-28T08:00:00Z");   // 10:00 Skopje, 28.09

  it("a past single day compares with the day before, whole", () => {
    const w = overviewWindows("2026-09-22", "2026-09-22", true, now) as OverviewWindow;
    expect(w).toMatchObject({ from: "2026-09-22", to: "2026-09-22", days: 1, partial: false,
      fromIso: "2026-09-21T22:00:00.000Z", toEndIso: "2026-09-22T21:59:59.999999Z" });
    expect(w.prev).toEqual({ from: "2026-09-21", to: "2026-09-21",
      fromIso: "2026-09-20T22:00:00.000Z", toEndIso: "2026-09-21T21:59:59.999999Z" });
  });

  it("a 30-day range compares with the 30 days before it", () => {
    const w = overviewWindows("2026-08-29", "2026-09-27", true, now) as OverviewWindow;
    expect(w.days).toBe(30);
    expect(w.prev).toMatchObject({ from: "2026-07-30", to: "2026-08-28" });
  });

  it("today so far compares with yesterday by the same time", () => {
    const w = overviewWindows("2026-09-28", "2026-09-28", true, now) as OverviewWindow;
    expect(w.partial).toBe(true);
    expect(w.prev).toEqual({ from: "2026-09-27", to: "2026-09-27",
      fromIso: "2026-09-26T22:00:00.000Z", toEndIso: "2026-09-27T08:00:00.000Z" });
  });

  it("no compare → prev null; missing dates → today", () => {
    const w = overviewWindows(null, null, false, now) as OverviewWindow;
    expect(w).toMatchObject({ from: "2026-09-28", to: "2026-09-28", prev: null, partial: true });
  });

  it("a range into the future is clamped to today", () => {
    const w = overviewWindows("2026-09-01", "2026-12-31", false, now) as OverviewWindow;
    expect(w.to).toBe("2026-09-28");
  });

  it("rejects bad input", () => {
    expect(overviewWindows("2026-09-30", "2026-09-01", false, now)).toEqual({ error: "from is after to" });
    expect(overviewWindows("22.09.2026", null, false, now)).toHaveProperty("error");
    expect(overviewWindows("2023-01-01", "2026-09-01", false, now)).toHaveProperty("error");
  });
});

describe("drill-down filters", () => {
  it("each bucket maps to exactly one clause; compound outcomes expand", () => {
    expect(outcomeOrFilter(["preparing"])).toBe("and(status.eq.confirmed,packed_at.is.null)");
    expect(outcomeOrFilter(["packed"])).toBe("and(status.eq.confirmed,packed_at.not.is.null)");
    expect(outcomeOrFilter(["awaiting"])).toBe("status.in.(pending,take,call_again,duplicated)");
    expect(outcomeOrFilter(["delivered", "courier"])).toBe("status.in.(paid,delivered),status.eq.shipped");
    expect(outcomeOrFilter(["lost"])).toBe("status.eq.returned,and(status.in.(cancelled,trashed),sold_at.not.is.null)");
    expect(outcomeOrFilter(["returned", "lost"])).toBe("status.eq.returned,and(status.in.(cancelled,trashed),sold_at.not.is.null)");
    expect(outcomeOrFilter([])).toBeNull();
  });

  it("the sold window has the three branches of sale_at and never a disposition row", () => {
    const f = soldWindowOrFilter("2026-09-21T22:00:00.000Z", "2026-09-22T21:59:59.999999Z");
    expect(f.split("and(or(sale_source_detail.is.null,sale_source_detail.neq.disposition)").length - 1).toBe(3);
    expect(f).toContain("sold_at.gte.2026-09-21T22:00:00.000Z,sold_at.lte.2026-09-22T21:59:59.999999Z");
    expect(f).toContain("sold_at.is.null,status.in.(confirmed,shipped,delivered,paid,returned),confirmed_at.gte.");
    expect(f).toContain("confirmed_at.is.null,created_at.gte.2026-09-21T22:00:00.000Z,created_at.lte.");
  });

  it("csv params are validated", () => {
    expect(parseCsvParam("altercpa,elyon_crm", SALE_SOURCES)).toEqual({ ok: true, values: ["altercpa", "elyon_crm"] });
    expect(parseCsvParam("altercpa,nope", SALE_SOURCES)).toEqual({ ok: false, bad: "nope" });
    expect(parseCsvParam(null, SALE_SOURCES)).toEqual({ ok: true, values: [] });
    expect(parseCsvParam("all", SALE_SOURCES)).toEqual({ ok: true, values: [] });
    expect(parseDetailParam("prediction_list,9225")).toEqual({ ok: true, values: ["prediction_list", "9225"] });
    expect(parseDetailParam("a),or(b")).toEqual({ ok: false, bad: "a)" });
    expect(isUuid("63fba491-c489-48e1-aeca-8efcb35bb3ae")).toBe(true);
    expect(isUuid("63fba491")).toBe(false);
  });

  it("the cash clock has the three branches of cash_at", () => {
    const f = cashWindowOrFilter("A", "B");
    expect(f).toBe("and(status.in.(paid,delivered),mex_delivered_at.gte.A,mex_delivered_at.lte.B),"
      + "and(status.in.(paid,delivered),mex_delivered_at.is.null,paid_at.gte.A,paid_at.lte.B),"
      + "and(status.in.(paid,delivered),mex_delivered_at.is.null,paid_at.is.null,created_at.gte.A,created_at.lte.B)");
  });

  it("attention filters: only the two kinds that are an orders filter", () => {
    const now = new Date("2026-09-28T08:00:00Z");
    const a = attentionFilter("approved_no_parcel_7d", now)!;
    expect(a.eq).toEqual({ status: "confirmed" });
    expect(a.in).toEqual({ sale_source: ["altercpa", "affiliate"] });
    expect(a.isNull).toEqual(["mex_tracking_id"]);
    expect(a.or[0]).toContain("sold_at.lt.2026-09-21T08:00:00.000Z");
    expect(a.or[1]).toBe("ship_after_date.is.null,ship_after_date.lte.2026-09-28");
    expect(attentionFilter("mex_problem", now)).toEqual({ eq: {}, in: { mex_status_id: [3, 9, 13] }, isNull: [], or: [] });
    expect(attentionFilter("night_approvals", now)).toBeNull();
    expect(isSafeText("Alpha Male cps 30")).toBe(true);
    expect(isSafeText("x\u0000y")).toBe(false);
  });

  it("pivot dimensions: 1 to 4 known ones", () => {
    expect(parsePivotBy("source,team,person")).toEqual({ ok: true, values: ["source", "team", "person"] });
    expect(parsePivotBy("")).toEqual({ ok: false, bad: "(empty)" });
    expect(parsePivotBy("source,detail,team,person,city")).toEqual({ ok: false, bad: "(more than 4 dimensions)" });
    expect(parsePivotBy("source,salary")).toEqual({ ok: false, bad: "salary" });
  });
});
