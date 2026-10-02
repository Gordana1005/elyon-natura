import { describe, expect, it } from "vitest";
import { parseBonusTargetBody, shapeBoardBonus, shapeBonusTargets } from "./bonus.ts";

describe("bonus — the target writer's body", () => {
  it("accepts a department, a real day, a positive target and three non-negative milestones", () => {
    const r = parseBonusTargetBody({ department: "teleshop_out", valid_from: "2026-10-03", target_mkd: "150000.4",
      m1_eur: 20, m2_eur: "30.005", m3_eur: 50, note: "  октомври  " });
    expect(r).toEqual({ ok: true, value: { department: "teleshop_out", valid_from: "2026-10-03", target_mkd: 150000,
      m1_eur: 20, m2_eur: 30.01, m3_eur: 50, note: "октомври" } });
  });
  it("refuses everything else with a code", () => {
    const base = { department: "elyon_crm", valid_from: "2026-10-03", target_mkd: 30000, m1_eur: 1, m2_eur: 2, m3_eur: 3 };
    expect(parseBonusTargetBody(null)).toEqual({ ok: false, error: "invalid_body" });
    expect(parseBonusTargetBody({ ...base, department: "altercpa" })).toEqual({ ok: false, error: "bad_department" });
    expect(parseBonusTargetBody({ ...base, valid_from: "2026-02-31" })).toEqual({ ok: false, error: "bad_valid_from" });
    expect(parseBonusTargetBody({ ...base, target_mkd: 0 })).toEqual({ ok: false, error: "bad_target" });
    expect(parseBonusTargetBody({ ...base, m2_eur: -1 })).toEqual({ ok: false, error: "bad_milestones" });
    expect(parseBonusTargetBody({ ...base, m3_eur: "x" })).toEqual({ ok: false, error: "bad_milestones" });
    expect(parseBonusTargetBody({ ...base, note: "x".repeat(501) })).toEqual({ ok: false, error: "note_too_long" });
  });
});

describe("bonus — the versions", () => {
  const row = (department: string, valid_from: string, target: number) => ({
    id: `${department}-${valid_from}`, department, valid_from, daily_target_mkd: String(target),
    m1_eur: "10", m2_eur: "20", m3_eur: "30", note: null, created_at: "2026-10-02T10:00:00Z",
  });
  it("the one in force today per department, the upcoming ones and the history newest first", () => {
    const s = shapeBonusTargets([row("teleshop_out", "2026-09-01", 100000), row("teleshop_out", "2026-10-01", 150000),
      row("teleshop_out", "2026-11-01", 200000), row("elyon_crm", "2026-10-02", 30000)], "2026-10-02");
    expect(s.current.teleshop_out?.target_mkd).toBe(150000);
    expect(s.current.elyon_crm?.valid_from).toBe("2026-10-02");
    expect(s.upcoming.map((r) => r.valid_from)).toEqual(["2026-11-01"]);
    expect(s.history[0].valid_from).toBe("2026-11-01");
  });
  it("no target yet → null", () => {
    expect(shapeBonusTargets([], "2026-10-02").current).toEqual({ teleshop_out: null, elyon_crm: null });
  });
});

describe("bonus — the board's part", () => {
  it("coerces the numbers; null when no department has a target", () => {
    expect(shapeBoardBonus(null)).toBeNull();
    expect(shapeBoardBonus({ day: "2026-10-02", departments: [] })).toBeNull();
    const b = shapeBoardBonus({ day: "2026-10-02", departments: [{ department: "teleshop_out", valid_from: "2026-10-01",
      target_mkd: "150000", thresholds_mkd: [50000, 100000, 150000], milestones_eur: ["20", 30, 50], value_mkd: 120000,
      reached: 2, pool_eur: "50", paid_value_mkd: 0, paid_reached: 0, paid_pool_eur: 0,
      people: [{ person_id: "p1", value_mkd: 60000, share: "0.5", bonus_eur: "25", paid_value_mkd: 0, paid_bonus_eur: 0 }] }] });
    expect(b?.departments[0]).toMatchObject({ target_mkd: 150000, milestones_eur: [20, 30, 50], reached: 2, pool_eur: 50 });
    expect(b?.departments[0].people[0]).toMatchObject({ person_id: "p1", share: 0.5, bonus_eur: 25 });
  });
});

import { cutFor, parseBonusRulesBody, parseMonthParam } from "./bonus.ts";

describe("bonus — the month rules", () => {
  it("validates the settle days and the tiers, sorted by min %", () => {
    expect(parseBonusRulesBody({ settle_after_days: 3, return_tiers: [{ min_pct: 20, cut_pct: 33 }, { min_pct: "15", cut_pct: 20 }] }))
      .toEqual({ ok: true, value: { settle_after_days: 3, return_tiers: [{ min_pct: 15, cut_pct: 20 }, { min_pct: 20, cut_pct: 33 }] } });
    expect(parseBonusRulesBody({ settle_after_days: 40, return_tiers: [] })).toEqual({ ok: false, error: "bad_settle_days" });
    expect(parseBonusRulesBody({ settle_after_days: 3, return_tiers: [{ min_pct: 15, cut_pct: 120 }] })).toEqual({ ok: false, error: "bad_tiers" });
    expect(parseBonusRulesBody({ settle_after_days: 3, return_tiers: [{ min_pct: 15, cut_pct: 1 }, { min_pct: 15, cut_pct: 2 }] }))
      .toEqual({ ok: false, error: "bad_tiers" });
  });
  it("the owner's example: 15 → 20 %, 18 → 25 %, 20 → 33 %", () => {
    const tiers = [{ min_pct: 15, cut_pct: 20 }, { min_pct: 18, cut_pct: 25 }, { min_pct: 20, cut_pct: 33 }];
    expect(cutFor(14.9, tiers)).toBe(0);
    expect(cutFor(15, tiers)).toBe(20);
    expect(cutFor(18.4, tiers)).toBe(25);
    expect(cutFor(23, tiers)).toBe(33);
    expect(cutFor(null, tiers)).toBe(0);
  });
  it("?month=YYYY-MM", () => {
    expect(parseMonthParam("2026-09")).toBe("2026-09-01");
    expect(parseMonthParam("2026-13")).toBeNull();
    expect(parseMonthParam(null)).toBeNull();
  });
});
