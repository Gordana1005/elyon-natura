// The collabBox BOOKING day (owner 01.10.2026): the ahead range of the frequent pass, the booking-time
// estimator (scripts/lib/collabbox-booking-day.mjs — the JS twin of public.collabbox_estimate_booked_at)
// and the backfill's pure plan. The SQL twin is checked against this one on real data by the backfill's
// dry run once the migration is applied; here its CONSTANTS are read from the migration.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_AHEAD_DAYS, aheadRange, buildDocuments, parseRequest } from "./collabbox.ts";
import type { HeaderRow } from "./collabbox.ts";
// @ts-expect-error — a plain .mjs module (scripts/lib), typed loosely here
import * as BD from "../../../scripts/lib/collabbox-booking-day.mjs";
// @ts-expect-error — a plain .mjs script module
import { planLedger, planOrders } from "../../../scripts/backfill-collabbox-booked-at.mjs";

const MIG_A = readFileSync(join(process.cwd(), "supabase/migrations/20260944000500_collabbox_booked_at.sql"), "utf8").replace(/\r/g, "");
const MIG_B = readFileSync(join(process.cwd(), "supabase/migrations/20260944000600_booking_day_readers.sql"), "utf8").replace(/\r/g, "");

/** Skopje wall clock → epoch seconds (the fixtures read like the ledger). */
const sk = (ymdHm: string): number => BD.skopjeInstant(ymdHm.slice(0, 10), Number(ymdHm.slice(11, 13)) * 3600 + Number(ymdHm.slice(14, 16)) * 60);
const fmt = (sec: number): string => {
  const p = BD.skopjeParts(sec);
  return `${p.ymd} ${String(Math.floor(p.clock / 3600)).padStart(2, "0")}:${String(Math.floor((p.clock % 3600) / 60)).padStart(2, "0")}`;
};

describe("the ahead range (collabbox-sync)", () => {
  it("is (to, to + N] only for a window that ends today", () => {
    expect(aheadRange("2026-10-01", "2026-10-01", 14)).toEqual({ from: "2026-10-02", to: "2026-10-15" });
    expect(aheadRange("2026-09-30", "2026-10-01", 14)).toBeNull();     // a past window has no "ahead"
    expect(aheadRange("2026-10-01", "2026-10-01", 0)).toBeNull();
    expect(aheadRange("2026-10-01", "2026-10-01", 40)).toEqual({ from: "2026-10-02", to: "2026-10-15" });
    expect(MAX_AHEAD_DAYS).toBe(14);
  });
  it("parseRequest takes ahead_days only for a manual window ending today", () => {
    const today = "2026-10-01";
    expect(parseRequest({ mode: "manual", trigger: "cron", from: "2026-09-30", to: today, ahead_days: 14 }, today))
      .toMatchObject({ ok: true, req: { ahead: 14, from: "2026-09-30", to: today, trigger: "cron" } });
    expect(parseRequest({ from: "2026-09-29", to: "2026-09-30", ahead_days: 3 }, today).ok).toBe(false);
    expect(parseRequest({ mode: "nightly", ahead_days: 3 }, today).ok).toBe(false);
    expect(parseRequest({ from: today, ahead_days: 15 }, today).ok).toBe(false);
    expect(parseRequest({ from: today, ahead_days: 1.5 }, today).ok).toBe(false);
    expect(parseRequest({ from: today, to: "2026-10-05" }, today).ok).toBe(false);   // `to` still never after today
    expect(parseRequest({ from: today, ahead_days: 0 }, today)).toMatchObject({ ok: true, req: { ahead: 0 } });
  });
  it("a range read in one page: each document keeps its own day", () => {
    const h = (doc: string, at: string): HeaderRow => ({
      docId: null, objectId: null, docNumber: doc, typeId: "10050", typeName: "Нарачка out", customerId: "1", customerName: "X",
      amount: 2000, currency: "МКД", orderRef: null, datetime: at, datetimeRaw: null, author: "A",
    });
    const { docs } = buildDocuments([h("002-9102-1/2026", "2026-10-03T10:30:00"), h("002-9102-2/2026", "2026-10-09T11:00:00")], [], null, null);
    expect(docs.map((d) => d.day)).toEqual(["2026-10-03", "2026-10-09"]);
  });
  it("the cron sends ahead_days 14 (migration 20260944000500)", () => {
    expect(MIG_A).toMatch(/'ahead_days', 14\);/);
    expect(MIG_A).toContain("https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/collabbox-sync");
    expect(MIG_A).not.toContain("sxymaloycddnoxudxaqp");
  });
});

describe("the booking time — JS twin of collabbox_estimate_booked_at", () => {
  it("keeps its constants in step with the migration", () => {
    expect(MIG_A).toContain(`c_seq_next  CONSTANT integer  := ${BD.SEQ_NEXT};`);
    expect(MIG_A).toContain(`c_seq_rank  CONSTANT integer  := ${BD.SEQ_RANK};`);
    expect(MIG_A).toContain(`c_seq_tol   CONSTANT interval := interval '${BD.SEQ_TOL_S / 60} minutes';`);
    expect(MIG_A).toContain(`c_watch     CONSTANT interval := interval '${BD.WATCH_MAX_S / 3600} hours';`);
    expect(MIG_A).toContain(`c_seen_tol  CONSTANT interval := interval '${BD.SEEN_TOL_S / 60} minutes';`);
    expect(MIG_A).toContain(`c_max_back  CONSTANT interval := interval '${BD.MAX_BACK_DAYS} days';`);
    expect(MIG_A).toContain("'^[0-9]{3}-[0-9]{4}-[0-9]{1,15}/[0-9]{4}$'");
    expect(MIG_A).toContain("r.kind IN ('manual', 'nightly')");
    // the closed-month default: 01.10.2026 00:00 Skopje (CEST)
    expect(MIG_A).toContain("SELECT timestamptz '2026-10-01 00:00:00+02';");
    expect(BD.skopjeInstant("2026-10-01", 0)).toBe(Date.parse("2026-09-30T22:00:00Z") / 1000);
  });
  it("reads DocNumbers", () => {
    expect(BD.seqOf("002-9102-177916/2026")).toEqual({ key: "002-9102/2026", no: 177916 });
    expect(BD.seqOf("M12345")).toBeNull();
    expect(BD.seqOf("002-9102-x/2026")).toBeNull();
  });
  it("projects a clock time below a bound (DST-exact, as Postgres reads it)", () => {
    expect(fmt(BD.projectClockBelow(sk("2026-10-01 10:30"), sk("2026-09-30 11:19")))).toBe("2026-09-30 10:30");
    expect(fmt(BD.projectClockBelow(sk("2026-10-01 23:30"), sk("2026-10-02 07:04")))).toBe("2026-10-01 23:30");
    expect(fmt(BD.projectClockBelow(sk("2026-10-05 10:30"), sk("2026-10-01 10:30")))).toBe("2026-10-01 10:30");
    // 25.10.2026 02:30 happens twice: CET (the later one), as `timestamp AT TIME ZONE` does
    expect(BD.skopjeInstant("2026-10-25", 2 * 3600 + 1800)).toBe(Date.parse("2026-10-25T01:30:00Z") / 1000);
    // 29.03.2026 02:30 does not exist: read as CET → 03:30 CEST
    expect(BD.skopjeInstant("2026-03-29", 2 * 3600 + 1800)).toBe(Date.parse("2026-03-29T01:30:00Z") / 1000);
  });

  it("177916 dated 01.10 10:30 between 177909 (30.09 10:08) and 177920 (30.09 11:19) was booked 30.09 10:30", () => {
    // the ledger on 01.10 (first sightings as they were: 30.09's documents seen live, 177916 at 07:04 on 01.10)
    const docs = [
      { doc_number: "002-9102-177909/2026", doc_at: sk("2026-09-30 10:08"), first_seen_at: sk("2026-09-30 10:18") },
      { doc_number: "002-9102-177911/2026", doc_at: sk("2026-09-30 10:06"), first_seen_at: sk("2026-09-30 10:18") },
      { doc_number: "002-9102-177915/2026", doc_at: sk("2026-09-30 10:28"), first_seen_at: sk("2026-09-30 10:49") },
      { doc_number: "002-9102-177916/2026", doc_at: sk("2026-10-01 10:30"), first_seen_at: sk("2026-10-01 07:04") },
      { doc_number: "002-9102-177917/2026", doc_at: sk("2026-10-01 10:35"), first_seen_at: sk("2026-10-01 07:04") },
      { doc_number: "002-9102-177919/2026", doc_at: sk("2026-09-30 11:00"), first_seen_at: sk("2026-09-30 11:19") },
      { doc_number: "002-9102-177920/2026", doc_at: sk("2026-09-30 11:19"), first_seen_at: sk("2026-09-30 11:34") },
      { doc_number: "002-9102-177922/2026", doc_at: sk("2026-09-30 11:36"), first_seen_at: sk("2026-09-30 11:50") },
      { doc_number: "002-9102-177923/2026", doc_at: sk("2026-09-30 11:40"), first_seen_at: sk("2026-09-30 11:50") },
    ];
    const est = BD.estimateAll(docs, []);
    const e = est.get("002-9102-177916/2026");
    expect(e.basis).toBe("sequence");
    expect(fmt(e.booked_at)).toBe("2026-09-30 10:30");
    expect(fmt(est.get("002-9102-177917/2026").booked_at)).toBe("2026-09-30 10:35");
    // the 2-minute disorder of 177909 / 177911 does not push 177909 a day back (60 min tolerance)
    expect(est.get("002-9102-177909/2026")).toEqual({ booked_at: sk("2026-09-30 10:08"), basis: "doc" });
  });

  it("'seen': a pass that read the day missed it, the next saw it → its clock on the latest day ≤ the sighting", () => {
    const runs = [
      { id: "p", kind: "manual", status: "ok", from: "2026-09-30", to: "2026-10-01", ahead_to: "2026-10-15", started: sk("2026-10-01 10:00"), finished: sk("2026-10-01 10:04") },
      { id: "r", kind: "manual", status: "ok", from: "2026-09-30", to: "2026-10-01", ahead_to: "2026-10-15", started: sk("2026-10-01 10:15"), finished: sk("2026-10-01 10:19") },
    ];
    const ahead = { doc_number: "002-9102-178100/2026", doc_at: sk("2026-10-06 10:11"), first_seen_at: sk("2026-10-01 10:17"), first_run_id: "r" };
    expect(BD.estimateBookedAt(ahead, [], runs)).toEqual({ booked_at: sk("2026-10-01 10:11"), basis: "seen" });
    // booked late in the evening, seen by the first pass the next morning: still the evening's day
    const night = [{ id: "e", kind: "manual", status: "ok", from: "2026-09-30", to: "2026-10-01", ahead_to: "2026-10-15", started: sk("2026-10-01 22:45"), finished: sk("2026-10-01 22:49") }];
    const late = { doc_number: "002-9102-178200/2026", doc_at: sk("2026-10-04 23:10"), first_seen_at: sk("2026-10-02 07:04"), first_run_id: "m" };
    expect(fmt(BD.estimateBookedAt(late, [], night).booked_at)).toBe("2026-10-01 23:10");
    // not watched → the sequence decides (here only its own sighting bounds it): the pass that first saw
    // it never counts as the watching one, a live-mode run never watches, a pass > 23 h before the
    // sighting proves nothing, nor one that did not read the day (beyond its ahead range)
    expect(BD.estimateBookedAt({ ...ahead, first_run_id: "p" }, [], [runs[0]]).basis).toBe("sequence");
    expect(BD.estimateBookedAt(ahead, [], [{ ...runs[0], kind: "live" }]).basis).toBe("sequence");
    expect(BD.estimateBookedAt({ ...ahead, first_seen_at: sk("2026-10-02 11:00") }, [], [runs[0]]).basis).toBe("sequence");
    expect(BD.estimateBookedAt({ ...ahead, doc_at: sk("2026-10-20 10:11") }, [], runs).basis).toBe("sequence");
    // a same-day booking: the document time itself
    const same = { doc_number: "002-9102-178101/2026", doc_at: sk("2026-10-01 10:09"), first_seen_at: sk("2026-10-01 10:17"), first_run_id: "r" };
    expect(BD.estimateBookedAt(same, [], runs)).toEqual({ booked_at: sk("2026-10-01 10:09"), basis: "seen" });
  });

  it("never after doc_at, never more than 31 days before it; robust to a document dated back", () => {
    const back = [sk("2026-09-30 08:36"), sk("2026-09-30 09:48"), sk("2026-10-01 10:05"), sk("2026-10-01 10:06"), sk("2026-10-01 10:07")];
    // two later documents dated a day back (seen on 9110): the 3rd smallest bound ignores them
    const e = BD.estimateBookedAt({ doc_number: "002-9110-177200/2026", doc_at: sk("2026-10-03 10:00"), first_seen_at: null }, back, []);
    expect(fmt(e.booked_at)).toBe("2026-10-01 10:00");
    const far = BD.estimateBookedAt({ doc_number: "002-9102-1/2026", doc_at: sk("2026-12-01 10:00"), first_seen_at: null },
      [sk("2026-09-01 10:00"), sk("2026-09-01 10:01"), sk("2026-09-01 10:02")], []);
    expect(far).toEqual({ booked_at: sk("2026-12-01 10:00"), basis: "doc" });
    const none = BD.estimateBookedAt({ doc_number: "x", doc_at: sk("2026-10-01 10:00"), first_seen_at: null }, [], []);
    expect(none).toEqual({ booked_at: sk("2026-10-01 10:00"), basis: "doc" });
  });

  it("the cutoff rule: a sale moves to its booking day when the booking or the dispatch is from the cutoff on", () => {
    const since = BD.skopjeInstant("2026-10-01", 0);
    expect(BD.saleAt(sk("2026-10-02 10:30"), sk("2026-10-01 10:30"), since)).toBe(sk("2026-10-01 10:30"));
    // the switch-over gap (20260944000610): booked 30.09 for dispatch 01.10 → its booking day
    expect(BD.saleAt(sk("2026-10-01 10:30"), sk("2026-09-30 10:30"), since)).toBe(sk("2026-09-30 10:30"));
    // dispatched before the cutoff: never moves
    expect(BD.saleAt(sk("2026-09-30 10:30"), sk("2026-09-28 10:30"), since)).toBe(sk("2026-09-30 10:30"));
    expect(BD.saleAt(sk("2026-10-01 10:30"), null, since)).toBe(sk("2026-10-01 10:30"));
    expect(BD.saleAt(sk("2026-10-01 10:30"), sk("2026-10-02 10:30"), since)).toBe(sk("2026-10-01 10:30"));
  });
});

describe("the backfill's plan (pure)", () => {
  const since = BD.skopjeInstant("2026-10-01", 0);
  const docs = [
    { doc_number: "D1", type: "10050", dept: "teleshop_out", doc_at: sk("2026-10-03 10:00"), booked_at: null, basis: null, waiting: true, amount_mkd: 2000 },
    { doc_number: "D2", type: "10050", dept: "teleshop_out", doc_at: sk("2026-10-01 10:00"), booked_at: null, basis: null, waiting: false, amount_mkd: 2500 },
    { doc_number: "D3", type: "10050", dept: "teleshop_out", doc_at: sk("2026-10-04 10:00"), booked_at: sk("2026-10-02 10:00"), basis: "seen", waiting: true, amount_mkd: 1800 },
  ];
  const est = new Map([
    ["D1", { booked_at: sk("2026-10-02 10:00"), basis: "sequence" }],
    ["D2", { booked_at: sk("2026-09-30 10:00"), basis: "sequence" }],
    ["D3", { booked_at: sk("2026-10-01 10:00"), basis: "sequence" }],
  ]);
  it("writes only undecided rows (or sequence/doc ones with --redecide) and moves only from the cutoff on (booking or dispatch)", () => {
    const p = planLedger(docs, est, { since });
    expect(p.changes.map((c: { doc: string }) => c.doc)).toEqual(["D1", "D2"]);   // D3 is decided ('seen') — kept
    expect(p.moved).toEqual([
      expect.objectContaining({ doc: "D1", from_day: "2026-10-03", to_day: "2026-10-02", waiting: true }),
      // the switch-over gap (20260944000610): booked 30.09 for dispatch 01.10 → its booking day
      expect.objectContaining({ doc: "D2", from_day: "2026-10-01", to_day: "2026-09-30", waiting: false }),
    ]);
    expect(p.months["2026-10"]).toMatchObject({ docs: 3, day_differs: 3, moves_under_cutoff: 2 });
    expect(planLedger(docs, est, { since, redecide: true }).changes.map((c: { doc: string }) => c.doc)).toEqual(["D1", "D2"]);
  });
  it("re-stamps the document's own order on its day, a credited holder only inside its cohort month", () => {
    const nb = new Map([["D1", sk("2026-10-02 10:00")], ["D2", sk("2026-09-30 10:00")]]);
    const orders = [
      { id: "o1", doc_number: "D1", doc_at: sk("2026-10-03 10:00"), created_by_sync: true, credited: false,
        sold_at: sk("2026-10-03 09:00"), sold_via: "collabbox", confirmed_at: sk("2026-10-03 09:00"), created_at: sk("2026-10-03 09:00"), cohort_at: null },
      { id: "o2", doc_number: "D2", doc_at: sk("2026-10-01 10:00"), created_by_sync: true, credited: false,
        sold_at: sk("2026-10-01 10:00"), sold_via: "collabbox", confirmed_at: sk("2026-10-01 10:00"), created_at: sk("2026-10-01 10:00"), cohort_at: null },
      { id: "o3", doc_number: "D1", doc_at: sk("2026-10-03 10:00"), created_by_sync: false, credited: true,
        sold_at: sk("2026-10-03 10:00"), sold_via: "collabbox", confirmed_at: sk("2026-09-29 10:00"), created_at: sk("2026-09-29 10:00"), cohort_at: sk("2026-09-29 10:00") },
    ];
    const plan = planOrders(orders, nb, { since });
    // o2: dispatched 01.10, booked 30.09 → its booking day (20260944000610); o3: another month
    expect(plan.map((x: { id: string }) => x.id)).toEqual(["o1", "o2"]);
    expect(plan[0].set).toEqual({ sold_at: sk("2026-10-02 10:00"), confirmed_at: sk("2026-10-02 10:00"), created_at: sk("2026-10-02 10:00") });
    expect(plan[1].set).toEqual({ sold_at: sk("2026-09-30 10:00"), confirmed_at: sk("2026-09-30 10:00"), created_at: sk("2026-09-30 10:00") });
  });
});

describe("the readers (migration 20260944000600)", () => {
  it("count a booking on its booking day and close the morning gap", () => {
    expect(MIG_B).toContain("public.collabbox_sale_at(b.doc_at, b.booked_at) AS sale_at");
    expect(MIG_B).toMatch(/FROM bk\n {2}WHERE bk\.sale_at BETWEEN \$1 AND \$2/);
    expect(MIG_B).toContain("WHERE p.tracking_id = b.doc_number AND p.order_id IS NOT NULL");
    expect(MIG_B).toContain("AND NOT EXISTS (SELECT 1 FROM bk WHERE bk.doc_number = p.tracking_id)");
    const sr = MIG_B.slice(MIG_B.indexOf("CREATE OR REPLACE FUNCTION public.insights_sale_rows"));
    expect(sr.indexOf("bk AS MATERIALIZED (")).toBeLessThan(sr.indexOf("mo AS MATERIALIZED ("));
  });
  it("the board: its bookings filter = collabbox_booked_today's, the department's decisions", () => {
    const lb = MIG_B.slice(MIG_B.indexOf("CREATE OR REPLACE FUNCTION public.leaderboard_day_v2"));
    expect(lb).toContain("AND public.collabbox_sale_at(b.doc_at, b.booked_at) BETWEEN $1::timestamptz AND $2::timestamptz");
    expect(MIG_A).toContain("AND public.collabbox_sale_at(b.doc_at, b.booked_at) >= (d.day::timestamp AT TIME ZONE 'Europe/Skopje')");
    expect(lb).toContain("CASE WHEN $4::text IS NULL THEN coalesce(wk.worked, 0)     ELSE coalesce(pa.worked, 0)     END AS worked");
    expect(lb).toContain("sum(pd.worked) AS worked, sum(pd.sale_d) AS sale_d");
  });
  it("every replaced body is drift-guarded", () => {
    for (const sql of [MIG_A, MIG_B]) {
      expect(sql).toMatch(/DO \$drift\$/);
      expect(sql).not.toMatch(/@@/);
      for (const m of sql.matchAll(/'([0-9a-f]{32})', '([0-9a-f]{32})'\)/g)) expect(m[1]).not.toBe(m[2]);
    }
  });
});
