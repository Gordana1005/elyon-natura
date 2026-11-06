import { describe, expect, it } from "vitest";
import {
  effectiveMembers, inCallAt, inboundMembersMessage, isEffective, onlineAt, parseMode, parseSelfBody,
  selfToggleAllowed, statusForCode,
} from "./inboundRing.ts";

describe("inboundRing — modes", () => {
  it("parses only the three words", () => {
    expect(parseMode("always")).toBe("always");
    expect(parseMode("manual")).toBe("manual");
    expect(parseMode("off")).toBe("off");
    expect(parseMode("ALWAYS")).toBeNull();
    expect(parseMode("")).toBeNull();
    expect(parseMode(undefined)).toBeNull();
    expect(parseMode(1)).toBeNull();
  });

  it("the self body takes a boolean (or its string form)", () => {
    expect(parseSelfBody({ on: true })).toEqual({ ok: true, on: true });
    expect(parseSelfBody({ on: "false" })).toEqual({ ok: true, on: false });
    expect(parseSelfBody({})).toEqual({ ok: false, error: "bad_body" });
    expect(parseSelfBody(null)).toEqual({ ok: false, error: "bad_body" });
    expect(parseSelfBody({ on: "yes" })).toEqual({ ok: false, error: "bad_body" });
  });

  it("effective = always, or manual with the switch on", () => {
    expect(isEffective({ mode: "always", manual_on: false })).toBe(true);
    expect(isEffective({ mode: "manual", manual_on: true })).toBe(true);
    expect(isEffective({ mode: "manual", manual_on: false })).toBe(false);
    expect(isEffective({ mode: "off", manual_on: false })).toBe(false);
    expect(isEffective(null)).toBe(false);
  });

  it("only a manual person flips their own switch", () => {
    expect(selfToggleAllowed({ mode: "manual" })).toEqual({ ok: true });
    expect(selfToggleAllowed({ mode: "always" })).toEqual({ ok: false, error: "not_manual" });
    expect(selfToggleAllowed({ mode: "off" })).toEqual({ ok: false, error: "not_manual" });
    expect(selfToggleAllowed(null)).toEqual({ ok: false, error: "not_manual" });
  });

  it("maps the writer's codes to HTTP statuses", () => {
    expect(statusForCode("bad_mode")).toBe(400);
    expect(statusForCode("bad_body")).toBe(400);
    expect(statusForCode("no_login")).toBe(404);
    expect(statusForCode("not_manual")).toBe(409);
    expect(statusForCode("something_else")).toBe(400);
    expect(statusForCode(undefined)).toBe(400);
  });
});

describe("inboundRing — the queue's members", () => {
  const exts = [
    { extension: "1017", user_id: "tatjana" },
    { extension: "1018", user_id: "aleksandra" },
    { extension: "1019", user_id: "angela" },
    { extension: "1020", user_id: "dzenet" },
    { extension: "1021", user_id: "mimi" },
    { extension: "1022", user_id: "someone" },
    { extension: "1023", user_id: "left-the-company" },
  ];
  const settings = [
    { user_id: "tatjana", mode: "always" as const, manual_on: false },
    { user_id: "aleksandra", mode: "always" as const, manual_on: false },
    { user_id: "angela", mode: "always" as const, manual_on: false },
    { user_id: "dzenet", mode: "manual" as const, manual_on: true },
    { user_id: "mimi", mode: "manual" as const, manual_on: false },
    { user_id: "left-the-company", mode: "always" as const, manual_on: false },
    { user_id: "no-extension-yet", mode: "always" as const, manual_on: false },
  ];
  const active = new Set(["tatjana", "aleksandra", "angela", "dzenet", "mimi", "someone"]);

  it("always + manual-on, active, with an extension — sorted by extension", () => {
    expect(effectiveMembers(exts, settings, active).map((m) => m.extension)).toEqual(["1017", "1018", "1019", "1020"]);
  });

  it("a manual person who switched off, a person with no setting, an inactive login and a setting with no line never ring", () => {
    const got = effectiveMembers(exts, settings, active).map((m) => m.user_id);
    expect(got).not.toContain("mimi");
    expect(got).not.toContain("someone");
    expect(got).not.toContain("left-the-company");
    expect(got).not.toContain("no-extension-yet");
  });

  it("is deterministic and empty-safe", () => {
    expect(effectiveMembers([], settings, active)).toEqual([]);
    expect(effectiveMembers(exts, [], active)).toEqual([]);
    const shuffled = [...exts].reverse();
    expect(effectiveMembers(shuffled, settings, active)).toEqual(effectiveMembers(exts, settings, active));
  });
});

describe("inboundRing — presence", () => {
  const now = Date.parse("2026-11-06T10:00:00Z");
  it("online within 2 minutes of the last beat", () => {
    expect(onlineAt("2026-11-06T09:59:00Z", now)).toBe(true);
    expect(onlineAt("2026-11-06T09:57:00Z", now)).toBe(false);
    expect(onlineAt(null, now)).toBe(false);
    expect(onlineAt("not a date", now)).toBe(false);
  });
  it("in a call = dialing / in_call / wrapping reported within 3 minutes; a ring is not a call", () => {
    expect(inCallAt("in_call", "2026-11-06T09:58:30Z", now)).toBe(true);
    expect(inCallAt("dialing", "2026-11-06T09:59:50Z", now)).toBe(true);
    expect(inCallAt("in_call", "2026-11-06T09:50:00Z", now)).toBe(false);
    expect(inCallAt("incoming", "2026-11-06T09:59:50Z", now)).toBe(false);
    expect(inCallAt("idle", "2026-11-06T09:59:50Z", now)).toBe(false);
    expect(inCallAt("in_call", null, now)).toBe(false);
  });
  it("the PBX pull signs inbound|<exp>", () => {
    expect(inboundMembersMessage(1762420000)).toBe("inbound|1762420000");
  });
});
