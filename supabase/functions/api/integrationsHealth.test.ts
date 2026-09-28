import { describe, expect, it } from "vitest";
import { normalizePreview, parseModeBody, parseRunId } from "./integrationsHealth.ts";

describe("parseModeBody", () => {
  it("accepts report and apply only", () => {
    expect(parseModeBody({ mode: "apply" })).toEqual({ ok: true, mode: "apply" });
    expect(parseModeBody({ mode: "report" })).toEqual({ ok: true, mode: "report" });
    expect(parseModeBody({ mode: "APPLY" })).toEqual({ ok: false, error: "bad_mode" });
    expect(parseModeBody(null)).toEqual({ ok: false, error: "bad_body" });
  });
});

describe("normalizePreview", () => {
  it("reads apply_no_parcel_rule's dry run", () => {
    expect(normalizePreview({
      ok: true, dry_run: true, mode: "report", days: 7, candidates: 569, to_cancel: 522, needs_linking: 47, value_eur: 14295.13,
    })).toEqual({ candidates: 569, to_cancel: 522, needs_linking: 47, value_eur: 14295.13, mode: "report", days: 7 });
  });
  it("is null for a missing or refused payload", () => {
    expect(normalizePreview(null)).toBeNull();
    expect(normalizePreview({ ok: false })).toBeNull();
    expect(normalizePreview([])).toBeNull();
  });
  it("coerces junk numbers to 0", () => {
    expect(normalizePreview({ ok: true, to_cancel: "x" })?.to_cancel).toBe(0);
  });
});

describe("parseRunId", () => {
  it("empty means the latest run; otherwise a uuid", () => {
    expect(parseRunId(null)).toEqual({ ok: true, value: null });
    expect(parseRunId("")).toEqual({ ok: true, value: null });
    expect(parseRunId("799f66f8-521c-4584-ac51-75cc27377982")).toEqual({ ok: true, value: "799f66f8-521c-4584-ac51-75cc27377982" });
    expect(parseRunId("1; drop")).toEqual({ ok: false });
  });
});
