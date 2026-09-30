import { describe, expect, it } from "vitest";
import {
  BRAND_LINES, BRAND_LINE_COLUMNS, MAX_SET_IDS, brandLineRpcError, isBrandLine, mexProfileForLine,
  parseProposalDays, parseSetBrandLineBody, setBrandLineRpcArgs, shapeProposal, shapeProposalRow,
  shapeSetResult, stripBrandLineFields,
} from "./brandLine.ts";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const ACTOR = "33333333-3333-4333-8333-333333333333";

describe("lines and MEX profiles (owner 30.09)", () => {
  it("four lines in the owner's order", () => {
    expect(BRAND_LINES).toEqual(["natura_therapy", "bio_natural", "ad_astra", "dr_becker"]);
  });
  it("Bio Natural and Dr.Becker ship with BIO NATURAL, Natura Therapy and Ad Astra with NATURA", () => {
    expect(mexProfileForLine("bio_natural")).toBe("bio_natural");
    expect(mexProfileForLine("dr_becker")).toBe("bio_natural");
    expect(mexProfileForLine("natura_therapy")).toBe("natura");
    expect(mexProfileForLine("ad_astra")).toBe("natura");
  });
  it("no line (or a MEX key passed as a line) has no profile", () => {
    for (const v of [null, undefined, "", "natura", "BIO_NATURAL", 3]) expect(mexProfileForLine(v)).toBeNull();
  });
  it("isBrandLine is exact", () => {
    expect(isBrandLine("ad_astra")).toBe(true);
    expect(isBrandLine("Ad Astra")).toBe(false);
    expect(isBrandLine(null)).toBe(false);
  });
});

describe("parseProposalDays", () => {
  it("defaults to 180", () => {
    expect(parseProposalDays(null)).toEqual({ ok: true, days: 180 });
    expect(parseProposalDays(" ")).toEqual({ ok: true, days: 180 });
  });
  it("accepts 1..3650", () => {
    expect(parseProposalDays("90")).toEqual({ ok: true, days: 90 });
    expect(parseProposalDays("3650")).toEqual({ ok: true, days: 3650 });
  });
  it("refuses the rest", () => {
    for (const v of ["0", "3651", "-5", "12.5", "abc"]) expect(parseProposalDays(v).ok).toBe(false);
  });
});

describe("parseSetBrandLineBody", () => {
  it("lower-cases and de-duplicates the ids, keeps the line", () => {
    const r = parseSetBrandLineBody({ ids: [P1.toUpperCase(), P2, P1], line: "bio_natural" });
    expect(r).toEqual({ ok: true, args: { ids: [P1, P2], line: "bio_natural" } });
  });
  it("null clears the line on purpose", () => {
    const r = parseSetBrandLineBody({ ids: [P1], line: null });
    expect(r).toEqual({ ok: true, args: { ids: [P1], line: null } });
  });
  it("a missing line key is a mistake, not a clear", () => {
    expect(parseSetBrandLineBody({ ids: [P1] })).toEqual({ ok: false, error: "line is required (null = not yet decided)" });
  });
  it("refuses an unknown line (a MEX account is not a line)", () => {
    for (const line of ["natura", "Bio Natural", "", 1]) {
      expect(parseSetBrandLineBody({ ids: [P1], line }).ok).toBe(false);
    }
  });
  it("refuses bad ids, an empty list and too many", () => {
    expect(parseSetBrandLineBody({ ids: ["x"], line: "ad_astra" }).ok).toBe(false);
    expect(parseSetBrandLineBody({ ids: [], line: "ad_astra" })).toEqual({ ok: false, error: "ids is empty" });
    expect(parseSetBrandLineBody({ ids: P1, line: "ad_astra" }).ok).toBe(false);
    expect(parseSetBrandLineBody(null).ok).toBe(false);
    const many = Array.from({ length: MAX_SET_IDS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(parseSetBrandLineBody({ ids: many, line: "ad_astra" })).toEqual({ ok: false, error: "at most 1000 products per call" });
  });
  it("builds the RPC arguments with the caller as the actor", () => {
    expect(setBrandLineRpcArgs({ ids: [P1], line: "dr_becker" }, ACTOR)).toEqual({ p_ids: [P1], p_line: "dr_becker", p_actor: ACTOR });
  });
});

describe("shapeProposal", () => {
  const row = {
    id: P1, name: "Neurofix", sku: "SKU-000073", is_active: true, brand_line: null, brand_line_set_at: null,
    brand_line_set_by_name: null, bio_natural: "2570", natura: 21, parcels: 2591, majority: "bio_natural",
    share: "0.9919", bucket: "sure", anchor: "neurofix", hint: null, suggested: "bio_natural",
    suggested_profile: "bio_natural", confidence: "anchor", conflict: false, reason: "anchor_name", auto: true,
    secret_future_key: "never leaks",
  };
  it("whitelists the keys and coerces numbers", () => {
    const r = shapeProposalRow(row)!;
    expect(r).not.toHaveProperty("secret_future_key");
    expect(r.bio_natural).toBe(2570);
    expect(r.share).toBeCloseTo(0.9919);
    expect(r.auto).toBe(true);
  });
  it("unknown enum values fall back safely", () => {
    const r = shapeProposalRow({ ...row, bucket: "weird", confidence: "maybe", reason: "?", brand_line: "natura", hint: "x" })!;
    expect(r.bucket).toBe("none");
    expect(r.confidence).toBe("none");
    expect(r.reason).toBe("no_parcels");
    expect(r.brand_line).toBeNull();
    expect(r.hint).toBeNull();
  });
  it("drops rows without an id and fills the summary", () => {
    const out = shapeProposal({
      days: 180, generated_at: "2026-09-30T20:00:00Z",
      summary: { products: 287, sure: 194, mixed: 19, none: 74, anchors: 23, conflicts: 2, hints: { ad_astra: 0, dr_becker: "1" }, decided: 0, auto: 199, few_parcels_auto: 40 },
      rows: [row, { name: "no id" }, null],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.summary).toEqual({ products: 287, sure: 194, mixed: 19, none: 74, anchors: 23, conflicts: 2, hints: { ad_astra: 0, dr_becker: 1 }, decided: 0, auto: 199, few_parcels_auto: 40 });
  });
  it("an empty payload is an empty proposal", () => {
    const out = shapeProposal(null);
    expect(out.rows).toEqual([]);
    expect(out.days).toBe(180);
    expect(out.summary.products).toBe(0);
  });
});

describe("shapeSetResult / errors / PATCH guard", () => {
  it("shapes the writer's answer", () => {
    const r = shapeSetResult({
      line: "bio_natural", mex_profile: "bio_natural", requested: 3, updated: "2", unchanged: 0,
      missing: ["00000000-0000-4000-8000-000000000000"],
      changes: [{ id: P1, name: "Neurofix", from: null, to: "bio_natural", extra: 1 }],
    });
    expect(r).toEqual({
      line: "bio_natural", mex_profile: "bio_natural", requested: 3, updated: 2, unchanged: 0,
      missing: ["00000000-0000-4000-8000-000000000000"],
      changes: [{ id: P1, name: "Neurofix", from: null, to: "bio_natural" }],
    });
  });
  it("22023 is the caller's 400 with the SQL message; anything else is not ours", () => {
    expect(brandLineRpcError({ code: "22023", message: "invalid brand line: natura" })).toEqual({ error: "invalid brand line: natura" });
    expect(brandLineRpcError({ code: "42501", message: "x" })).toBeNull();
    expect(brandLineRpcError(null)).toBeNull();
  });
  it("PATCH drops the line columns and keeps the rest", () => {
    const body: Record<string, unknown> = { name: "X", brand_line: "ad_astra", brand_line_set_by: ACTOR, brand_line_set_at: "t", price: 1 };
    expect(stripBrandLineFields(body)).toEqual([...BRAND_LINE_COLUMNS]);
    expect(body).toEqual({ name: "X", price: 1 });
    expect(stripBrandLineFields({ name: "Y" })).toEqual([]);
    expect(stripBrandLineFields(null)).toEqual([]);
  });
});
