import { describe, expect, it } from "vitest";
import {
  confidenceOf, parseLineApply, parseProposalDays, parseTeamFilter, shapeLineProposal, statusForLineCode,
  teamFilterMatches, teamSortOrder,
} from "./teamLines.ts";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const M1 = "33333333-3333-4333-8333-333333333333";

describe("parseTeamFilter — team | team:lane | none", () => {
  it("accepts a key, a key with a lane, and none", () => {
    expect(parseTeamFilter("teleshop")).toEqual({ ok: true, value: { raw: "teleshop", team: "teleshop", lane: null } });
    expect(parseTeamFilter(" affiliate:in ")).toEqual({ ok: true, value: { raw: "affiliate:in", team: "affiliate", lane: "in" } });
    expect(parseTeamFilter("teleshop:social")).toEqual({ ok: true, value: { raw: "teleshop:social", team: "teleshop", lane: "social" } });
    expect(parseTeamFilter("none")).toEqual({ ok: true, value: { raw: "none", team: "none", lane: null } });
    expect(parseTeamFilter("")).toEqual({ ok: true, value: null });
    expect(parseTeamFilter(null)).toEqual({ ok: true, value: null });
  });
  it("keeps the legacy keys (old TV links) as plain keys", () => {
    expect(parseTeamFilter("crm_prediction")).toMatchObject({ ok: true, value: { team: "crm_prediction", lane: null } });
    expect(parseTeamFilter("altercpa_leads")).toMatchObject({ ok: true, value: { team: "altercpa_leads", lane: null } });
  });
  it("refuses malformed values and lanes on non-lines", () => {
    for (const bad of ["Teleshop", "teleshop:", "teleshop:xx", "a:b:c", "tele shop", "1team", "x".repeat(41),
      "none:in", "management:in", "crm_prediction:out", "altercpa_leads:in", "teleshop;drop"]) {
      expect(parseTeamFilter(bad)).toEqual({ ok: false, error: "invalid team" });
    }
  });
});

describe("teamFilterMatches — the twin of sales_team_filter_matches", () => {
  it("a key, a lane, none", () => {
    expect(teamFilterMatches(null, "teleshop", "in")).toBe(true);
    expect(teamFilterMatches("teleshop", "teleshop", "out")).toBe(true);
    expect(teamFilterMatches("teleshop", "affiliate", "out")).toBe(false);
    expect(teamFilterMatches("teleshop:out", "teleshop", "out")).toBe(true);
    expect(teamFilterMatches("teleshop:out", "teleshop", "in")).toBe(false);
    expect(teamFilterMatches("teleshop:out", "affiliate", "out")).toBe(false);
    expect(teamFilterMatches("none", null, null)).toBe(true);
    expect(teamFilterMatches("none", "management", null)).toBe(false);
  });
  it("legacy aliases: the old team before the re-key, the lane it became after", () => {
    expect(teamFilterMatches("altercpa_leads", "altercpa_leads", null)).toBe(true);
    expect(teamFilterMatches("altercpa_leads", "affiliate", "in")).toBe(true);
    expect(teamFilterMatches("altercpa_leads", "affiliate", "out")).toBe(false);
    expect(teamFilterMatches("altercpa_leads", "teleshop", "in")).toBe(false);
    expect(teamFilterMatches("crm_prediction", "crm_prediction", null)).toBe(true);
    expect(teamFilterMatches("crm_prediction", "teleshop", "out")).toBe(true);
    expect(teamFilterMatches("crm_prediction", "affiliate", "out")).toBe(true);
    expect(teamFilterMatches("crm_prediction", "teleshop", "in")).toBe(false);
    expect(teamFilterMatches("crm_prediction", "management", null)).toBe(false);
  });
});

describe("teamSortOrder", () => {
  it("sort_order wins; the seeded order is the fallback; unknown keys after the known teams", () => {
    expect(teamSortOrder("affiliate", 5)).toBe(5);
    const keys = ["none", "management", "crm_prediction", "affiliate", "teleshop_unassigned", "teleshop", "altercpa_leads", "zeta"];
    expect([...keys].sort((a, b) => teamSortOrder(a) - teamSortOrder(b))).toEqual(
      ["teleshop", "affiliate", "altercpa_leads", "crm_prediction", "teleshop_unassigned", "zeta", "management", "none"]);
    expect(teamSortOrder(null)).toBe(99);
  });
});

describe("confidenceOf — the SQL's thresholds", () => {
  it("sure ≥ 80 %, likely 60–80 %, decide below or under 5 sales", () => {
    expect(confidenceOf(0.8, 5)).toBe("sure");
    expect(confidenceOf(0.7999, 500)).toBe("likely");
    expect(confidenceOf(0.6, 500)).toBe("likely");
    expect(confidenceOf(0.5999, 500)).toBe("decide");
    expect(confidenceOf(1, 4)).toBe("decide");
    expect(confidenceOf(null, 100)).toBe("decide");
  });
});

describe("parseProposalDays", () => {
  it("7–365, default 60", () => {
    expect(parseProposalDays(null)).toBe(60);
    expect(parseProposalDays("abc")).toBe(60);
    expect(parseProposalDays("3")).toBe(60);
    expect(parseProposalDays("90")).toBe(90);
    expect(parseProposalDays("9999")).toBe(365);
  });
});

describe("shapeLineProposal", () => {
  const raw = {
    generated_at: "2026-10-01T00:00:00Z", days: 60, since: "2026-08-02T00:00:00Z",
    thresholds: { sure: 0.8, likely: 0.6, min_sales: 5 },
    rows: [
      { person_id: P2, display_name: "Ruzhica", confidence: "likely", share: "0.6813", basis: "window", span: "window",
        counts: { altercpa: 0, elyon_crm: 125, teleshop_other: 326, teleshop_out: 572, social: 0, other: 0, total: 1023 },
        proposed: { team_key: "teleshop", lane: "out" }, current: { team_key: "crm_prediction", lane: null, legacy: true, memberships: 1 } },
      { person_id: P1, display_name: "Чима", confidence: "sure", share: 1, basis: "window",
        counts: { teleshop_other: 938, total: 938 }, proposed: { team_key: "teleshop", lane: "in" },
        current: { team_key: "crm_prediction", lane: null, legacy: true, memberships: 1 } },
      { person_id: M1, display_name: "Nina", confidence: "sure", basis: "management", proposed: { team_key: "management", lane: null },
        current: { team_key: "management", kind: "management", memberships: 1, lines: 1 }, unchanged: true },
      { person_id: "", display_name: "dropped" },
      { person_id: "44444444-4444-4444-8444-444444444444", display_name: "Aff", confidence: "sure", share: 0.99,
        proposed: { team_key: "affiliate", lane: "in" }, current: { memberships: 0 }, basis: "bogus", confidence_x: 1 },
    ],
  };
  it("types every row, orders sure → likely → decide by line and lane, counts the summary", () => {
    const p = shapeLineProposal(raw);
    expect(p.rows.map((r) => r.display_name)).toEqual(["Чима", "Aff", "Nina", "Ruzhica"]);
    expect(p.rows[3]).toMatchObject({ share: 0.6813, confidence: "likely", proposed: { team_key: "teleshop", lane: "out" } });
    expect(p.rows[0].counts).toEqual({ altercpa: 0, elyon_crm: 0, teleshop_other: 938, teleshop_out: 0, social: 0, other: 0, total: 938 });
    expect(p.rows[1].basis).toBe("none");
    expect(p.summary).toEqual({ people: 4, sure: 3, likely: 1, decide: 0, unchanged: 1, legacy: 2, no_team: 1 });
    expect(p.thresholds).toEqual({ sure: 0.8, likely: 0.6, min_sales: 5 });
  });
  it("an empty / broken payload is an empty proposal", () => {
    expect(shapeLineProposal(null)).toMatchObject({ days: 60, rows: [], summary: { people: 0 } });
  });
});

describe("parseLineApply", () => {
  it("accepts line + lane, management without lane, one membership", () => {
    expect(parseLineApply({ rows: [
      { person_id: P1, team_key: "teleshop", lane: "in" },
      { person_id: P2, team_key: "management", lane: null },
      { person_id: P2.toUpperCase(), team_key: "affiliate", lane: "out", membership_id: M1 },
    ] })).toEqual({ ok: true, rows: [
      { person_id: P1, team_key: "teleshop", lane: "in", membership_id: null },
      { person_id: P2, team_key: "management", lane: null, membership_id: null },
      { person_id: P2, team_key: "affiliate", lane: "out", membership_id: M1 },
    ] });
  });
  it("refuses what the SQL would refuse, with the row index", () => {
    const one = (row: Record<string, unknown>) => parseLineApply({ rows: [row] });
    expect(one({ person_id: "x", team_key: "teleshop", lane: "in" })).toEqual({ ok: false, error: "person_not_found", index: 0 });
    expect(one({ person_id: P1, team_key: "Teleshop", lane: "in" })).toMatchObject({ error: "team_not_found" });
    expect(one({ person_id: P1, team_key: "crm_prediction" })).toMatchObject({ error: "legacy_team" });
    expect(one({ person_id: P1, team_key: "teleshop" })).toMatchObject({ error: "lane_required" });
    expect(one({ person_id: P1, team_key: "affiliate", lane: "social" })).toMatchObject({ error: "lane_not_allowed" });
    expect(one({ person_id: P1, team_key: "management", lane: "in" })).toMatchObject({ error: "lane_not_allowed" });
    expect(one({ person_id: P1, team_key: "teleshop", lane: "up" })).toMatchObject({ error: "bad_lane" });
    expect(one({ person_id: P1, team_key: "teleshop", lane: "in", membership_id: "nope" })).toMatchObject({ error: "membership_not_found" });
    expect(parseLineApply({ rows: [{ person_id: P1, team_key: "teleshop", lane: "in" }, { person_id: P1, team_key: "affiliate", lane: "in" }] }))
      .toEqual({ ok: false, error: "duplicate_row", index: 1 });
    expect(parseLineApply({ rows: [] })).toEqual({ ok: false, error: "bad_rows" });
    expect(parseLineApply({ rows: Array.from({ length: 501 }, () => ({ person_id: P1, team_key: "teleshop", lane: "in" })) }))
      .toEqual({ ok: false, error: "bad_rows" });
    expect(parseLineApply("x")).toEqual({ ok: false, error: "bad_rows" });
  });
  it("an unknown new line key passes to the SQL (it knows the teams)", () => {
    expect(parseLineApply({ rows: [{ person_id: P1, team_key: "webshop", lane: "in" }] })).toMatchObject({ ok: true });
  });
  it("maps refusals to HTTP", () => {
    expect(statusForLineCode("person_not_found")).toBe(404);
    expect(statusForLineCode("invalid_rows")).toBe(422);
    expect(statusForLineCode("multiple_lines")).toBe(422);
    expect(statusForLineCode("bad_rows")).toBe(400);
  });
});
