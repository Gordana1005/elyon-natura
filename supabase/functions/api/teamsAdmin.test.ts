import { describe, expect, it } from "vitest";
import {
  codeFromRaise, isNearName, isYmd, parseCreate, parseDays, parseIdentity, parseMove, parsePatch,
  statusForCode, suggestPerson, withSuggestions,
} from "./teamsAdmin.ts";

// A stand-in for the api's agentIdentityKey: lower-case, Cyrillic → Latin for
// the letters used below, ќ/ћ/ч → c, non-letters → one space.
const MAP: Record<string, string> = {
  а: "a", д: "d", е: "e", л: "l", н: "n", у: "u", м: "m", о: "o", в: "v", и: "i", ч: "c", ќ: "c", к: "k", ј: "j",
  с: "s", ш: "s", т: "t", р: "r", ц: "c", з: "z", г: "g", б: "b", п: "p",
};
const fold = (s: string) =>
  s.toLowerCase().split("").map((c) => MAP[c] ?? c).join("")
    .replace(/kj/g, "c").replace(/ch/g, "c").replace(/[^a-z]+/g, " ").trim();

describe("isYmd", () => {
  it("accepts real days only", () => {
    expect(isYmd("2026-09-28")).toBe(true);
    expect(isYmd("2026-02-30")).toBe(false);
    expect(isYmd("28.09.2026")).toBe(false);
    expect(isYmd(null)).toBe(false);
  });
});

describe("statusForCode", () => {
  it("maps refusal codes to HTTP statuses", () => {
    expect(statusForCode("person_not_found")).toBe(404);
    expect(statusForCode("identity_taken")).toBe(409);
    expect(statusForCode("later_membership_exists")).toBe(409);
    expect(statusForCode("login_not_staff")).toBe(422);
    expect(statusForCode("bad_date")).toBe(400);
    expect(statusForCode(undefined)).toBe(400);
  });
  it("pulls the code out of sales_person_create's raise", () => {
    expect(codeFromRaise("sales_person_create:identity_taken")).toBe("identity_taken");
    expect(codeFromRaise("something else")).toBeNull();
  });
});

describe("parseIdentity", () => {
  it("keeps inner spacing of names — they match EXACTLY", () => {
    const p = parseIdentity({ kind: "collabbox_author", value: "Милјана  Тодоровска н." });
    expect(p).toEqual({ ok: true, value: { kind: "collabbox_author", account_id: null, value: "Милјана  Тодоровска н.", note: null } });
  });
  it("strips a leading # from an AlterCPA id and refuses non-digits", () => {
    const p = parseIdentity({ kind: "altercpa_user", value: "#4531" });
    expect(p.ok && p.value.value).toBe("4531");
    expect(parseIdentity({ kind: "altercpa_user", value: "45a1" })).toEqual({ ok: false, error: "bad_altercpa_id" });
  });
  it("refuses unknown kinds, empty values and bad accounts", () => {
    expect(parseIdentity({ kind: "email", value: "x" })).toEqual({ ok: false, error: "bad_kind" });
    expect(parseIdentity({ kind: "order_name", value: "  " })).toEqual({ ok: false, error: "bad_value" });
    expect(parseIdentity({ kind: "altercpa_user", value: "1", account_id: "nope" })).toEqual({ ok: false, error: "account_not_found" });
    expect(parseIdentity(null)).toEqual({ ok: false, error: "bad_identity" });
  });
});

describe("parseCreate", () => {
  it("needs a name; a team needs a date", () => {
    expect(parseCreate({})).toEqual({ ok: false, error: "bad_name" });
    expect(parseCreate({ display_name: "Ana", team_key: "crm_prediction" })).toEqual({ ok: false, error: "bad_date" });
    expect(parseCreate({ display_name: "Ana", team_key: "crm_prediction", team_from: "2026-10-01", team_role: "boss" }))
      .toEqual({ ok: false, error: "bad_role" });
  });
  it("normalises a full body", () => {
    const p = parseCreate({
      display_name: "  Ana Petrova ", team_key: "teleshop", team_from: "2026-10-01", team_lane: "out",
      identities: [{ kind: "order_name", value: "Ana Petrova" }],
    });
    expect(p).toEqual({
      ok: true,
      value: {
        display_name: "Ana Petrova", user_id: null, is_manager: false, notes: null,
        team_key: "teleshop", team_from: "2026-10-01", team_role: "member", team_lane: "out",
        identities: [{ kind: "order_name", account_id: null, value: "Ana Petrova", note: null }],
      },
    });
  });
  it("a business line needs its lane; a legacy team is no longer a target (20260943000900)", () => {
    const base = { display_name: "Ana", team_from: "2026-10-01" };
    expect(parseCreate({ ...base, team_key: "teleshop" })).toEqual({ ok: false, error: "lane_required" });
    expect(parseCreate({ ...base, team_key: "affiliate", team_lane: "social" })).toEqual({ ok: false, error: "lane_not_allowed" });
    expect(parseCreate({ ...base, team_key: "crm_prediction" })).toEqual({ ok: false, error: "legacy_team" });
    expect(parseCreate({ ...base, team_key: "management", team_lane: "in" })).toEqual({ ok: false, error: "lane_not_allowed" });
    expect(parseCreate({ ...base, team_key: "management" })).toMatchObject({ ok: true, value: { team_lane: null } });
    expect(parseCreate({ display_name: "Ana", team_lane: "in" })).toEqual({ ok: false, error: "lane_not_allowed" });
  });
  it("passes a bad identity's error through", () => {
    expect(parseCreate({ display_name: "A", identities: [{ kind: "altercpa_user", value: "x" }] }))
      .toEqual({ ok: false, error: "bad_altercpa_id" });
  });
});

describe("parsePatch", () => {
  it("sends only the keys present; user_id null unlinks", () => {
    expect(parsePatch({ is_active: false })).toEqual({ ok: true, value: { is_active: false } });
    expect(parsePatch({ user_id: null, notes: "  " })).toEqual({ ok: true, value: { user_id: null, notes: null } });
  });
  it("refuses empty or mistyped patches", () => {
    expect(parsePatch({})).toEqual({ ok: false, error: "bad_patch" });
    expect(parsePatch({ is_manager: "yes" })).toEqual({ ok: false, error: "bad_patch" });
    expect(parsePatch({ display_name: "" })).toEqual({ ok: false, error: "bad_name" });
    expect(parsePatch({ user_id: "abc" })).toEqual({ ok: false, error: "login_not_found" });
  });
});

describe("parseMove", () => {
  it("accepts a team or null (no team from X) and a real date", () => {
    expect(parseMove({ team_key: "management", from: "2026-10-01" }))
      .toEqual({ ok: true, value: { team_key: "management", from: "2026-10-01", role: "member", note: null, lane: null } });
    expect(parseMove({ team_key: null, from: "2026-10-01", role: "lead" }))
      .toEqual({ ok: true, value: { team_key: null, from: "2026-10-01", role: "lead", note: null, lane: null } });
    expect(parseMove({ team_key: "x", from: "2026-13-01" })).toEqual({ ok: false, error: "bad_date" });
    expect(parseMove({ team_key: "Bad Key", from: "2026-10-01" })).toEqual({ ok: false, error: "team_not_found" });
  });
  it("a line takes its lane with the move", () => {
    expect(parseMove({ team_key: "teleshop", from: "2026-10-01", lane: "social" }))
      .toMatchObject({ ok: true, value: { team_key: "teleshop", lane: "social" } });
    expect(parseMove({ team_key: "affiliate", from: "2026-10-01" })).toEqual({ ok: false, error: "lane_required" });
    expect(parseMove({ team_key: "altercpa_leads", from: "2026-10-01" })).toEqual({ ok: false, error: "legacy_team" });
    expect(parseMove({ team_key: "teleshop", from: "2026-10-01", lane: "up" })).toEqual({ ok: false, error: "bad_lane" });
  });
});

describe("parseDays", () => {
  it("clamps to 1–400, default 90", () => {
    expect(parseDays(null)).toBe(90);
    expect(parseDays("abc")).toBe(90);
    expect(parseDays("365")).toBe(365);
    expect(parseDays("9999")).toBe(400);
  });
});

describe("isNearName (on folded names)", () => {
  it("matches the seed's proposed-link near-misses", () => {
    expect(isNearName("adela numanovic", "adela numanovik")).toBe(true);    // -ич vs -ikj
    expect(isNearName("sona t taseva", "sona taseva")).toBe(true);          // a middle initial
    expect(isNearName("marija temelkova", "marija temelkovska")).toBe(true); // -ова vs -ovska
  });
  it("keeps different people apart", () => {
    expect(isNearName("teodora kostovska", "teodora krstevska")).toBe(false); // MUST_STAY_APART
    expect(isNearName("angela filipovska", "marina filipovska")).toBe(false);
    expect(isNearName("valentina bogdanovska", "valentina docevska")).toBe(false);
    expect(isNearName("iva", "iva")).toBe(false);                           // one token: never loose
  });
});

describe("suggestPerson", () => {
  const people = [
    { id: "p1", display_name: "Adela Numanovikj", identities: [{ kind: "order_name", value: "Adela Numanovikj" }] },
    { id: "p2", display_name: "Marija Temelkovska" },
    { id: "p3", display_name: "Iva", identities: [{ kind: "collabbox_author", value: "Ива Куноска" }, { kind: "altercpa_user", value: "4134" }] },
    { id: "p5", display_name: "Marija Trajkovska" },
  ];
  it("suggests the one person whose fold matches (same)", () => {
    expect(suggestPerson("Ива Куноска", people, fold)).toEqual({ person_id: "p3", display_name: "Iva", match: "same" });
    expect(suggestPerson("Адела Нуманович", people, fold)).toEqual({ person_id: "p1", display_name: "Adela Numanovikj", match: "same" });
  });
  it("offers a unique near-miss as a possible match", () => {
    expect(suggestPerson("Марија Темелкова", people, fold)).toEqual({ person_id: "p2", display_name: "Marija Temelkovska", match: "near" });
  });
  it("never suggests on an empty key or an ambiguous match", () => {
    expect(suggestPerson(null, people, fold)).toBeNull();
    expect(suggestPerson("Iva", [...people, { id: "p4", display_name: "Iva" }], fold)).toBeNull();
    expect(suggestPerson("Марија Темелкова", [...people, { id: "p6", display_name: "Marija Temelkov" }], fold)).toBeNull();
  });
  it("decorates every group", () => {
    const out = withSuggestions([{ ext: "Ива Куноска", n: 3 }, { ext: null, n: 1 }], people, fold);
    expect(out.map((g) => g.suggestion?.person_id ?? null)).toEqual(["p3", null]);
  });
});
