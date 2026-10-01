import { describe, expect, it } from "vitest";
import {
  DEFAULT_GUARANTEE_SETTINGS, addDays, alertDecisions, buildRates, buildToday, cohortState, guaranteeMath,
  maskJournalRow, mirrorLeadColumns, parseDayRange, parseGuaranteeSettings, parseJournalQuery, parseTodayQuery,
  requiredConfirms, riskOrder, skopjeHour, skopjeToday, stripSummaryMoney,
  type OpenLeadRow, type RateRow,
} from "./altercpaGuarantee.ts";

const S = DEFAULT_GUARANTEE_SETTINGS;
const pct1 = (x: number | null) => (x == null ? null : (x * 100).toFixed(1));

const row = (over: Partial<RateRow>): RateRow => ({
  grain: "webmaster", day: "2026-10-01", webmaster: "3221", stream: null, offer_name: null,
  leads: 0, test_excluded: 0, approved: 0, cancel_other: 0, cancelled: 0, trashed: 0, open: 0, counted: 0,
  mex_shipped: 0, crm_sticky: 0, ...over,
});

describe("guaranteeMath — the owner's numbers", () => {
  it("September: 2.044 of 5.754 → 35,5% (raw), ≈36,0% with the 76 test leads out", () => {
    expect(pct1(guaranteeMath({ leads: 5754, counted: 2044, open: 0 }, 30).rate)).toBe("35.5");
    expect(pct1(guaranteeMath({ leads: 5754 - 76, counted: 2044, open: 0 }, 30).rate)).toBe("36.0");
  });

  it("01.10 ~13:00: N 157, C 50, O 30 → required 48, need 0, margin 2, all 30 open may be cancelled", () => {
    const m = guaranteeMath({ leads: 157, counted: 50, open: 30 }, 30);
    expect(m.required).toBe(48);
    expect(m.need).toBe(0);
    expect(m.margin).toBe(2);
    expect(m.cancellable).toBe(30);
    expect(m.reachable).toBe(true);
  });

  it("N 70 → required 21 (the 0.3·70 float trap)", () => {
    expect(requiredConfirms(70, 30)).toBe(21);
    expect(guaranteeMath({ leads: 70, counted: 20, open: 5 }, 30).need).toBe(1);
    expect(guaranteeMath({ leads: 70, counted: 21, open: 5 }, 30).margin).toBe(0);
  });

  it("N 40, C 8, O 3 → need 4, unreachable, shortfall 1, at most 27,5%", () => {
    const m = guaranteeMath({ leads: 40, counted: 8, open: 3 }, 30);
    expect(m.required).toBe(12);
    expect(m.need).toBe(4);
    expect(m.reachable).toBe(false);
    expect(m.shortfall).toBe(1);
    expect(pct1(m.maxRate)).toBe("27.5");
    expect(m.cancellable).toBe(0);
    expect(m.margin).toBeNull();
  });

  it("N 10, C 3 → exactly 30%, met with no margin", () => {
    const m = guaranteeMath({ leads: 10, counted: 3, open: 0 }, 30);
    expect(m.rate).toBe(0.3);
    expect(m.need).toBe(0);
    expect(m.margin).toBe(0);
    expect(cohortState({ leads: 10, counted: 3, open: 0 }, 5, { ...S, minCohort: 5 })).toBe("met");
  });

  it("required is exact for every N up to 10.000 and a fractional target", () => {
    for (let n = 0; n <= 10_000; n++) expect(requiredConfirms(n, 30)).toBe(Math.ceil((3 * n) / 10));
    expect(requiredConfirms(100, 30.5)).toBe(31);
    expect(requiredConfirms(200, 30.5)).toBe(61);
    expect(requiredConfirms(0, 30)).toBe(0);
    expect(guaranteeMath({ leads: 0, counted: 0, open: 0 }, 30).rate).toBeNull();
  });

  it("per 10 new leads ≈ 3 confirmations at 30%", () => {
    expect(guaranteeMath({ leads: 1, counted: 0, open: 1 }, 30).per10).toBe(3);
  });
});

describe("cohortState", () => {
  const st = (leads: number, counted: number, open: number, age: number) => cohortState({ leads, counted, open }, age, S);
  it("N 19 → too_few (min 20), whatever else", () => {
    expect(st(19, 0, 19, 0)).toBe("too_few");
    expect(st(19, 0, 5, 9)).toBe("too_few");
  });
  it("open leads older than settle_days → stuck", () => {
    expect(st(40, 20, 1, 3)).toBe("stuck");
    expect(st(40, 2, 1, 5)).toBe("stuck");
  });
  it("met / settling / below", () => {
    expect(st(40, 12, 3, 0)).toBe("met");
    expect(st(40, 8, 10, 0)).toBe("settling");
    expect(st(40, 8, 0, 0)).toBe("below");
    expect(st(40, 8, 0, 6)).toBe("below");
  });
});

describe("riskOrder — unreachable → below → stuck → settling → met (by margin) → too few", () => {
  it("sorts webmasters by risk", () => {
    const mk = (webmaster: string, leads: number, counted: number, open: number, age = 0) => ({
      webmaster, math: guaranteeMath({ leads, counted, open }, 30), state: cohortState({ leads, counted, open }, age, S),
    });
    const list = [
      mk("met-big", 50, 25, 0),        // margin 10
      mk("tiny", 5, 0, 5),             // too few
      mk("met-thin", 50, 16, 2),       // margin 1
      mk("settle-4", 40, 8, 10),       // need 4
      mk("settle-9", 60, 9, 20),       // need 9
      mk("unreach-1", 40, 8, 3),       // shortfall 1
      mk("unreach-5", 50, 5, 5),       // need 10, shortfall 5
    ];
    expect([...list].sort(riskOrder).map((x) => x.webmaster))
      .toEqual(["unreach-5", "unreach-1", "settle-9", "settle-4", "met-thin", "met-big", "tiny"]);
  });
});

describe("days and queries", () => {
  it("skopjeToday / skopjeHour at 00:30 Skopje are the Skopje day, not the UTC one", () => {
    const at = new Date("2026-09-30T22:30:00Z"); // 00:30 on 01.10 in Skopje (CEST)
    expect(skopjeToday(at)).toBe("2026-10-01");
    expect(skopjeHour(at)).toBe(0);
    expect(skopjeToday(new Date("2026-12-31T23:30:00Z"))).toBe("2027-01-01"); // CET, +1
  });

  it("parseDayRange: default 14, swap, clamp to today, cap 92", () => {
    const today = "2026-10-01";
    expect(parseDayRange(null, null, today)).toEqual({ from: "2026-09-18", to: today });
    expect(parseDayRange("2026-09-30", "2026-09-20", today)).toEqual({ from: "2026-09-20", to: "2026-09-30" });
    expect(parseDayRange("2026-09-25", "2026-10-09", today)).toEqual({ from: "2026-09-25", to: today });
    expect(parseDayRange("2026-01-01", "2026-10-01", today)).toEqual({ from: addDays(today, -91), to: today });
    expect(parseDayRange("nope", "2026-02-30", today, { defaultDays: 1 })).toEqual({ from: today, to: today });
  });

  it("parseTodayQuery: day ≤ today, back 0..6 default 2", () => {
    const today = "2026-10-01";
    expect(parseTodayQuery(new URLSearchParams(""), today)).toEqual({ day: today, back: 2 });
    expect(parseTodayQuery(new URLSearchParams("day=2026-09-29&back=0"), today)).toEqual({ day: "2026-09-29", back: 0 });
    expect(parseTodayQuery(new URLSearchParams("day=2026-10-05&back=40"), today)).toEqual({ day: today, back: 6 });
  });

  it("parseJournalQuery: decision whitelist, limit ≤ 100, page offset, test flag, default today", () => {
    const today = "2026-10-01";
    const q = parseJournalQuery(new URLSearchParams("decision=open&limit=500&page=3&test=1&wm=%203221%20&q=%2038970"), today);
    expect(q).toMatchObject({ from: today, to: today, decision: "open", limit: 100, page: 3, offset: 200, includeTest: true, wm: "3221", q: "38970" });
    const bad = parseJournalQuery(new URLSearchParams("decision=pending&limit=0&page=-2"), today);
    expect(bad).toMatchObject({ decision: null, limit: 50, page: 1, offset: 0, includeTest: false, wm: null, stream: null, offer: null, q: null });
    for (const d of ["approved", "cancel_other", "cancelled", "trashed", "open"]) {
      expect(parseJournalQuery(new URLSearchParams(`decision=${d}`), today).decision).toBe(d);
    }
  });

  it("parseGuaranteeSettings: jsonb values, defaults, excluded webmasters", () => {
    expect(parseGuaranteeSettings(null)).toEqual(S);
    expect(parseGuaranteeSettings([
      { key: "altercpa_rate_target_pct", value: 30 }, { key: "altercpa_rate_geo", value: "MK" },
      { key: "altercpa_rate_min_cohort", value: "25" }, { key: "altercpa_rate_settle_days", value: 3 },
      { key: "altercpa_rate_excluded_webmasters", value: ["3226"] }, { key: "altercpa_rate_digest_hour", value: 99 },
    ])).toEqual({ target: 30, minCohort: 25, settleDays: 3, geo: "MK", excludedWebmasters: ["3226"], digestHour: 18 });
  });
});

describe("buildToday", () => {
  const now = new Date("2026-10-01T11:00:00Z"); // 13:00 Skopje
  const rates: RateRow[] = [
    row({ grain: "day", webmaster: null, leads: 157, approved: 45, cancel_other: 5, cancelled: 58, trashed: 19, open: 30, counted: 50 }),
    row({ webmaster: "3221", leads: 90, approved: 30, counted: 30, cancelled: 30, trashed: 10, open: 20 }),
    row({ webmaster: "2676", leads: 40, approved: 8, counted: 8, cancelled: 22, trashed: 7, open: 3 }),
    row({ webmaster: "3223", leads: 27, approved: 7, cancel_other: 5, counted: 12, cancelled: 6, trashed: 2, open: 7 }),
    row({ grain: "day", day: "2026-09-30", webmaster: null, leads: 200, approved: 60, counted: 60, cancelled: 130, open: 10 }),
    row({ day: "2026-09-30", webmaster: "3221", leads: 200, approved: 60, counted: 60, cancelled: 130, open: 10 }),
  ];
  const lead = (id: string, wm: string, at: string, over: Partial<OpenLeadRow> = {}): OpenLeadRow => ({
    lead_id: id, altercpa_id: `15${id}`, day: "2026-10-01", arrived_at: at, webmaster: wm, stream: "s1", offer_name: "Alpha",
    customer_name: "Ана Петровска", order_id: null, display_id: null, crm_status: null, mex_status_id: null, mex_tracking_id: null, ...over,
  });
  const open = [
    lead("b", "2676", "2026-10-01T09:00:00Z", { order_id: "o1", display_id: "ORD-1", crm_status: "confirmed" }),
    lead("a", "2676", "2026-10-01T06:30:00Z"),
    lead("c", "3221", "2026-10-01T10:00:00Z"),
  ];
  const stuckOpen = [
    lead("s1", "3221", "2026-09-27T08:00:00Z", { day: "2026-09-27" }),
    lead("s2", "3221", "2026-09-25T08:00:00Z", { day: "2026-09-25" }),
  ];
  const out = buildToday({
    day: "2026-10-01", today: "2026-10-01", back: 2, rates, open, stuckOpen, freshness: null, settings: S, now,
    maskName: (v) => `masked:${String(v)}`,
  });

  it("totals are the day grain with the guarantee math", () => {
    expect(out.totals).toMatchObject({ leads: 157, counted: 50, open: 30, state: "met" });
    expect(out.totals.math).toMatchObject({ required: 48, need: 0, margin: 2, cancellable: 30 });
    expect(out.totals.oldest_open_at).toBe("2026-10-01T06:30:00Z");
  });

  it("webmasters in risk order with their open leads oldest first, ages and the CRM flag, names masked", () => {
    expect(out.webmasters.map((w) => w.webmaster)).toEqual(["2676", "3221", "3223"]);
    const kma = out.webmasters[0];
    expect(kma.math).toMatchObject({ need: 4, reachable: false, shortfall: 1 });
    expect(kma.open_leads?.map((o) => o.lead_id)).toEqual(["a", "b"]);
    expect(kma.open_leads?.[0].age_min).toBe(270);
    expect(kma.open_leads?.[1]).toMatchObject({ crm_confirmed: true, display_id: "ORD-1", customer_name: "masked:Ана Петровска" });
  });

  it("yesterday and the day before; stuck = open leads ≥ settle_days old", () => {
    expect(out.previous.map((p) => p.day)).toEqual(["2026-09-30", "2026-09-29"]);
    expect(out.previous[0].totals).toMatchObject({ leads: 200, counted: 60, state: "met" });
    expect(out.previous[1].totals).toMatchObject({ leads: 0, state: "too_few" });
    expect(out.stuck).toMatchObject({ count: 2, oldest_arrived_at: "2026-09-25T08:00:00Z", to: "2026-09-28" });
    expect(out.stuck.by_day).toEqual([{ day: "2026-09-27", open: 1 }, { day: "2026-09-25", open: 1 }]);
    expect(out.meta).toMatchObject({ target: 30, min_cohort: 20, settle_days: 3, per10: 3 });
  });

  it("carries no money", () => {
    expect(JSON.stringify(out)).not.toMatch(/_eur|_mkd|price/);
  });
});

describe("buildRates", () => {
  const rates: RateRow[] = [
    row({ grain: "day", day: "2026-10-01", webmaster: null, leads: 30, counted: 6, open: 10, approved: 6, cancelled: 14 }),
    row({ day: "2026-10-01", webmaster: "3221", leads: 30, counted: 6, open: 10, approved: 6, cancelled: 14 }),
    row({ grain: "day", day: "2026-09-27", webmaster: null, leads: 60, test_excluded: 2, counted: 15, approved: 15, cancelled: 45, crm_sticky: 25, mex_shipped: 12 }),
    row({ day: "2026-09-27", webmaster: "3221", leads: 40, test_excluded: 2, counted: 8, approved: 8, cancelled: 32, crm_sticky: 15 }),
    row({ day: "2026-09-27", webmaster: "2676", leads: 20, counted: 7, approved: 7, cancelled: 13, crm_sticky: 10 }),
    row({ grain: "stream", day: "2026-09-27", webmaster: "3221", stream: "abc", leads: 30, counted: 5 }),
    row({ grain: "stream", day: "2026-09-27", webmaster: "3221", stream: "xyz", leads: 10, counted: 3 }),
    row({ grain: "offer", day: "2026-09-27", webmaster: "3221", offer_name: "Alpha", leads: 40, counted: 8 }),
  ];
  const out = buildRates({ from: "2026-09-27", to: "2026-10-01", today: "2026-10-01", rates, settings: S });

  it("one view per day, newest first, settled by age", () => {
    expect(out.days.map((d) => d.day)).toEqual(["2026-10-01", "2026-09-30", "2026-09-29", "2026-09-28", "2026-09-27"]);
    expect(out.days[0].settled).toBe(false);
    expect(out.days[4].settled).toBe(true);
    expect(out.webmasters).toEqual([{ webmaster: "3221", leads: 72 }, { webmaster: "2676", leads: 20 }]);
  });

  it("per-webmaster streams and offers for the drill", () => {
    const fom = out.days[4].webmasters.find((w) => w.webmaster === "3221")!;
    expect(fom.streams.map((s) => [s.key, s.leads, s.counted])).toEqual([["abc", 30, 5], ["xyz", 10, 3]]);
    expect(fom.offers[0]).toMatchObject({ key: "Alpha", leads: 40, rate: 0.2 });
    expect(fom.math.need).toBe(4);
  });

  it("summary: settled rate, days under target (N ≥ min), test excluded, the old metric", () => {
    expect(out.summary.settled).toEqual({ leads: 60, counted: 15, rate: 0.25 });
    expect(out.summary.cohorts_judged).toBe(2);
    expect(out.summary.days_under).toBe(1);
    expect(out.summary.test_excluded).toBe(2);
    expect(out.summary.crm_sticky.counted).toBe(25);
    expect(out.summary.mex_shipped.count).toBe(12);
    expect(out.summary.all).toMatchObject({ leads: 90, counted: 21, open: 10 });
  });
});

describe("maskJournalRow / mirror money", () => {
  const maskers = { name: (v: unknown) => `N(${v})`, phone: (v: unknown) => `P(${v})` };
  it("masks name and phone by the viewer's flags", () => {
    const r = { lead_id: "1", customer_name: "Ана Петровска", phone_raw: "+38970111222" };
    expect(maskJournalRow(r, { name: false, phone: false }, maskers)).toMatchObject({ customer_name: "N(Ана Петровска)", phone_raw: "P(+38970111222)" });
    expect(maskJournalRow(r, { name: true, phone: true }, maskers)).toEqual(r);
  });

  it("summary for a non-owner keeps counts and drops revenue_eur everywhere", () => {
    const s = {
      totals: { leads: 10, mirrored: 3, ledger_only: 7, geos: 2, offers: 4, webmasters: 3, approved: 5, revenue_eur: 123.4, priced: 9, unpriced: 1 },
      geos: [{ geo: "MK", leads: 8, mirrored: 3, approved: 4, currencies: ["MKD"], revenue_eur: 100 }],
      offers: [{ geo: "MK", offer: "A", leads: 2, approved: 1, mapped: true }],
      webmasters: [{ webmaster: "3221", leads: 5, approved: 2, geos: 1 }],
    };
    const out = stripSummaryMoney(s) as typeof s;
    expect(JSON.stringify(out)).not.toContain("revenue_eur");
    expect(out.totals.leads).toBe(10);
    expect(out.geos[0].currencies).toEqual(["MKD"]);
    expect(out.webmasters[0]).toEqual(s.webmasters[0]);
  });

  it("the mirror's columns: no payload ever, prices only for owners", () => {
    expect(mirrorLeadColumns(false)).not.toMatch(/payload|price|currency/);
    expect(mirrorLeadColumns(true)).toMatch(/price_raw, currency_raw, price_eur/);
    expect(mirrorLeadColumns(true)).not.toMatch(/payload|\*/);
  });
});

describe("alertDecisions — the sweep's twin", () => {
  const today = "2026-10-01";
  const cohorts = [
    { day: today, webmaster: "3221", leads: 92, counted: 22, open: 18 },   // need 6 ≤ 18 → reachable, under
    { day: today, webmaster: "2676", leads: 40, counted: 8, open: 3 },     // unreachable
    { day: today, webmaster: "3223", leads: 27, counted: 12, open: 5 },    // met
    { day: today, webmaster: "3285", leads: 5, counted: 0, open: 0 },      // too few
    { day: "2026-09-28", webmaster: "3221", leads: 150, counted: 40, open: 0 }, // final, under
    { day: "2026-09-28", webmaster: "2676", leads: 60, counted: 30, open: 0 },  // final, met
  ];
  const run = (hour: number) => alertDecisions({ hour, today, cohorts, settings: S });

  it("quiet hours fire nothing", () => {
    expect(run(8)).toEqual([]);
    expect(run(23)).toEqual([]);
  });
  it("12–20 h: unreachable only", () => {
    expect(run(12)).toEqual([{ kind: "unreachable", webmaster: "2676", day: today }]);
    expect(run(20).map((d) => d.kind)).toEqual(["unreachable"]);
  });
  it("18 h: one digest listing the webmasters still under, by need (plus the unreachable)", () => {
    const d = run(18).find((x) => x.kind === "digest")!;
    expect(d.webmaster).toBe("*");
    expect(d.items?.map((i) => [i.webmaster, i.need, i.open])).toEqual([["3221", 6, 18], ["2676", 4, 3]]);
    expect(alertDecisions({ hour: 18, today, cohorts: cohorts.filter((c) => c.webmaster === "3223"), settings: S })).toEqual([]);
  });
  it("21 h: the day's close only for the under-target webmasters; 10 h: the settled cohort's final", () => {
    expect(run(21).map((d) => `${d.kind}:${d.webmaster}`)).toEqual(["verdict_close:3221", "verdict_close:2676"]);
    expect(run(10)).toEqual([{ kind: "verdict_final", webmaster: "3221", day: "2026-09-28" }]);
  });
});
