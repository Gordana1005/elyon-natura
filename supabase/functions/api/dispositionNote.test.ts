import { describe, expect, it } from "vitest";
import {
  checkDispositionNote, decisionMeta, DISPOSITION_NOTE_MAX, DISPOSITION_NOTE_MIN, dispositionNoteGate,
  dispositionNoteRule, effectiveNoteMin, normalizeNote, noteLength, noteRequiredMessage, noteTooShortMessage,
  NOTE_TOO_LONG_MESSAGE, parseNoteMin, parseNoteMinInput,
} from "./dispositionNote.ts";

describe("normalizeNote / noteLength — characters as a person counts them", () => {
  it('collapses whitespace runs and trims: "  a  b  " is 3', () => {
    expect(normalizeNote("  a  b  ")).toBe("a b");
    expect(noteLength(normalizeNote("  a  b  "))).toBe(3);
    expect(normalizeNote("ќе плати\n\n  по 15-ти\t")).toBe("ќе плати по 15-ти");
    expect(normalizeNote(null)).toBe("");
    expect(normalizeNote(undefined)).toBe("");
  });
  it('Cyrillic counts per letter ("нема" = 4) and an emoji is one character', () => {
    expect(noteLength("нема")).toBe(4);
    expect(noteLength("😀")).toBe(1);
    expect(noteLength("ok 😀")).toBe(4);
  });
});

describe("checkDispositionNote", () => {
  it("5 characters is the default minimum", () => {
    expect(DISPOSITION_NOTE_MIN).toBe(5);
    expect(checkDispositionNote("нема")).toEqual({ ok: false, code: "note_too_short", error: noteTooShortMessage(5), min: 5 });
    expect(checkDispositionNote("нема пари")).toEqual({ ok: true, note: "нема пари" });
    expect(checkDispositionNote(" .....  ")).toEqual({ ok: true, note: "....." }); // open question 3: allowed
  });
  it("empty / spaces only is note_required; whitespace never pads the count", () => {
    expect(checkDispositionNote("")).toMatchObject({ ok: false, code: "note_required", error: noteRequiredMessage(5) });
    expect(checkDispositionNote("     ")).toMatchObject({ ok: false, code: "note_required" });
    expect(checkDispositionNote(undefined)).toMatchObject({ ok: false, code: "note_required" });
    expect(checkDispositionNote("a  b  c")).toMatchObject({ ok: true, note: "a b c" });
    expect(checkDispositionNote("a    b")).toMatchObject({ ok: false, code: "note_too_short" });
  });
  it("the maximum always applies; min 0 accepts an empty note (the rollout window)", () => {
    expect(checkDispositionNote("x".repeat(DISPOSITION_NOTE_MAX + 1), 0)).toEqual({ ok: false, code: "note_too_long", error: NOTE_TOO_LONG_MESSAGE, min: 0 });
    expect(checkDispositionNote("x".repeat(DISPOSITION_NOTE_MAX))).toMatchObject({ ok: true });
    expect(checkDispositionNote("", 0)).toEqual({ ok: true, note: "" });
    expect(checkDispositionNote("ok", 0)).toEqual({ ok: true, note: "ok" });
  });
  it("the fixed English messages the client maps", () => {
    expect(noteRequiredMessage(5)).toBe("A note of at least 5 characters is required");
    expect(noteTooShortMessage(5)).toBe("The note must be at least 5 characters long");
    expect(NOTE_TOO_LONG_MESSAGE).toBe("The note must be at most 1000 characters long");
  });
  it("'other' needs a note even while the setting is 0", () => {
    expect(effectiveNoteMin("other", 0)).toBe(1);
    expect(effectiveNoteMin("other", 5)).toBe(5);
    expect(effectiveNoteMin("no_money", 0)).toBe(0);
  });
});

describe("dispositionNoteRule — the matrix", () => {
  const cases: Array<[string | null, string, boolean, string]> = [
    // a move INTO cancelled / trashed (creation included) always needs the note
    ["pending", "cancelled", false, "required"],
    ["call_again", "trashed", true, "required"],
    ["confirmed", "cancelled", false, "required"],
    ["cancelled", "trashed", false, "required"],
    ["trashed", "cancelled", false, "required"],
    [null, "cancelled", false, "required"],
    [null, "trashed", false, "required"],
    // a correction at the same status: only a sent note is checked
    ["cancelled", "cancelled", true, "if_sent"],
    ["trashed", "trashed", true, "if_sent"],
    ["cancelled", "cancelled", false, "none"],
    ["trashed", "trashed", false, "none"],
    // every other status never needs it
    ["pending", "confirmed", false, "none"],
    ["cancelled", "pending", false, "none"],
    ["confirmed", "shipped", true, "none"],
    [null, "pending", false, "none"],
  ];
  it.each(cases)("%s → %s (note sent: %s) = %s", (from, to, noteSent, rule) => {
    expect(dispositionNoteRule({ from, to, noteSent })).toBe(rule);
  });
});

describe("dispositionNoteGate — rule + check + whether to write the column", () => {
  it("a move needs the note; the stored note is normalized", () => {
    expect(dispositionNoteGate({ from: "pending", to: "cancelled", raw: "нема", min: 5 }))
      .toMatchObject({ ok: false, rule: "required", code: "note_too_short" });
    expect(dispositionNoteGate({ from: "pending", to: "cancelled", raw: undefined, min: 5 }))
      .toMatchObject({ ok: false, rule: "required", code: "note_required" });
    expect(dispositionNoteGate({ from: "pending", to: "cancelled", raw: "  нема   пари ", min: 5 }))
      .toEqual({ ok: true, rule: "required", note: "нема пари", write: true });
  });
  it("min 0: a move without a note passes and leaves the column alone", () => {
    expect(dispositionNoteGate({ from: "pending", to: "trashed", raw: undefined, min: 0 }))
      .toEqual({ ok: true, rule: "required", note: null, write: false });
    expect(dispositionNoteGate({ from: "pending", to: "trashed", raw: "", min: 0 }))
      .toEqual({ ok: true, rule: "required", note: null, write: true });
    expect(dispositionNoteGate({ from: "pending", to: "cancelled", raw: undefined, min: 0, reason: "other" }))
      .toMatchObject({ ok: false, code: "note_required" });
  });
  it("same status: an empty note never erases, a short one is refused, a good one is written", () => {
    expect(dispositionNoteGate({ from: "trashed", to: "trashed", raw: "", min: 5 }))
      .toEqual({ ok: true, rule: "none", note: null, write: false });
    expect(dispositionNoteGate({ from: "trashed", to: "trashed", raw: "груб", min: 5 }))
      .toMatchObject({ ok: false, rule: "if_sent", code: "note_too_short" });
    expect(dispositionNoteGate({ from: "cancelled", to: "cancelled", raw: "по плата", min: 5 }))
      .toEqual({ ok: true, rule: "if_sent", note: "по плата", write: true });
  });
  it("other statuses are untouched", () => {
    expect(dispositionNoteGate({ from: "pending", to: "confirmed", raw: "x", min: 5 }))
      .toEqual({ ok: true, rule: "none", note: null, write: false });
  });
});

describe("parseNoteMin — app_settings.disposition_note_min", () => {
  it("an integer 0..5 (a numeric string too); missing or invalid → 5", () => {
    expect(parseNoteMin(0)).toBe(0);
    expect(parseNoteMin(5)).toBe(5);
    expect(parseNoteMin("0")).toBe(0);
    expect(parseNoteMin(" 3 ")).toBe(3);
    expect(parseNoteMin(50)).toBe(5); // above the frontend's 5 → invalid → default
    for (const bad of [undefined, null, "", "abc", -1, 6, 51, 5.5, "5.5", true, {}, []]) {
      expect(parseNoteMin(bad)).toBe(5);
    }
  });
  it("parseNoteMinInput refuses instead of defaulting (the admin's PATCH)", () => {
    expect(parseNoteMinInput(5)).toBe(5);
    expect(parseNoteMinInput(7)).toBeNull();
    expect(parseNoteMinInput("0")).toBe(0);
    expect(parseNoteMinInput(51)).toBeNull();
    expect(parseNoteMinInput("x")).toBeNull();
    expect(parseNoteMinInput(null)).toBeNull();
  });
});

describe("decisionMeta — who decided a cancel / trash (the next operator's strip)", () => {
  it("only cancelled / trashed orders carry it", () => {
    expect(decisionMeta({ status: "paid" }, { operator_name: "Ана" })).toBeNull();
    expect(decisionMeta({ status: "pending" }, null)).toBeNull();
  });
  it("a person: the operator's name, not automatic", () => {
    expect(decisionMeta({ status: "cancelled", cancellation_reason: "no_money" }, { operator_name: "Марија", operator_basis: "history", operator_auto: false }))
      .toEqual({ decided_by_name: "Марија", decided_auto: false });
  });
  it("automatic: the RPC's flag, the no-parcel cancel, the 9-no-answers auto-trash", () => {
    expect(decisionMeta({ status: "cancelled", cancellation_reason: "no_money" }, { operator_name: "Нина", operator_basis: "history", operator_auto: true }))
      .toEqual({ decided_by_name: "Нина", decided_auto: true });
    expect(decisionMeta({ status: "cancelled", cancellation_reason: "no_parcel_7d" }, { operator_name: "AlterCPA #3917", operator_basis: "altercpa" }))
      .toMatchObject({ decided_auto: true });
    expect(decisionMeta({ status: "trashed", trash_reason: "not_reachable" }, undefined))
      .toEqual({ decided_by_name: null, decided_auto: true });
    // a person who picked "Недостапен" by hand is a person
    expect(decisionMeta({ status: "trashed", trash_reason: "not_reachable" }, { operator_name: "Ива", operator_basis: "history" }))
      .toEqual({ decided_by_name: "Ива", decided_auto: false });
    expect(decisionMeta({ status: "trashed", trash_reason: "not_reachable" }, { operator_name: "Ива", operator_basis: "assigned" }))
      .toMatchObject({ decided_auto: false });
  });
});
