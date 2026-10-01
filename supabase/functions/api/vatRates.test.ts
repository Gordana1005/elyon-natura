import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyVatVisibility, asVatRate, DEFAULT_VAT_RATE, MAX_SET_IDS, parseSetVatBody, productVatOf, setVatRpcArgs,
  shapeSetVatResult, stripVatFields, VAT_COLUMNS, VAT_RATES, vatOfNamedRevenue, vatRateByName, vatRpcError, vatShare,
} from "./vatRates.ts";
import { CATALOGUE_SELECT, CATALOGUE_SELECT_NO_VAT, isMissingVatColumn, shapeCatalogueRow } from "./productsCatalog.ts";

const ID1 = "763d7435-0bc7-4ef9-b4a3-f543186b0874";
const ID2 = "b65a9329-0f45-402f-a9bf-b7357c1ab3db";

describe("the rates (owner 01.10.2026: per product, from Sigma)", () => {
  it("four Macedonian rates; the default for a line with none is the core range's 5 %", () => {
    expect([...VAT_RATES]).toEqual([0, 0.05, 0.1, 0.18]);
    expect(DEFAULT_VAT_RATE).toBe(0.05);
    expect(vatShare(0.05)).toBeCloseTo(5 / 105, 12);
    expect(vatShare(0.18)).toBeCloseTo(18 / 118, 12);
  });

  it("numeric(4,3) arrives as text — read back as one of the four, anything else null", () => {
    expect(asVatRate("0.050")).toBe(0.05);
    expect(asVatRate("0.180")).toBe(0.18);
    expect(asVatRate(0.1)).toBe(0.1);
    expect(asVatRate("0.000")).toBe(0);
    expect(asVatRate(0.2)).toBeNull();
    expect(asVatRate(null)).toBeNull();
    expect(asVatRate("")).toBeNull();
    expect(asVatRate("abc")).toBeNull();
  });

  it("the MEX invoice of July 2026: 500,00 gross at 5 % = 476,19 net + 23,81 VAT", () => {
    expect(Math.round(500 * vatShare(0.05) * 100) / 100).toBe(23.81);
  });
});

describe("POST /products/vat-rate", () => {
  it("validates ids, rate (null = unclassified) and the note", () => {
    const ok = parseSetVatBody({ ids: [ID1.toUpperCase(), ID1, ID2], rate: 0.18, note: "  Sigma 005031  " });
    expect(ok).toEqual({ ok: true, args: { ids: [ID1, ID2], rate: 0.18, note: "Sigma 005031" } });
    expect(parseSetVatBody({ ids: [ID1], rate: null })).toEqual({ ok: true, args: { ids: [ID1], rate: null, note: null } });
    expect(parseSetVatBody({ ids: [ID1], rate: "0.05" })).toMatchObject({ ok: true, args: { rate: 0.05 } });
    expect(parseSetVatBody({ ids: [ID1] })).toMatchObject({ ok: false });                  // rate missing
    expect(parseSetVatBody({ ids: [ID1], rate: 0.2 })).toMatchObject({ ok: false });       // not a Macedonian rate
    expect(parseSetVatBody({ ids: [ID1], rate: true })).toMatchObject({ ok: false });
    expect(parseSetVatBody({ ids: [], rate: 0.05 })).toMatchObject({ ok: false });
    expect(parseSetVatBody({ ids: ["x"], rate: 0.05 })).toMatchObject({ ok: false });
    expect(parseSetVatBody({ ids: [ID1], rate: 0.05, note: 5 })).toMatchObject({ ok: false });
    expect(parseSetVatBody({ ids: [ID1], rate: 0.05, note: "x".repeat(501) })).toMatchObject({ ok: false });
    const many = Array.from({ length: MAX_SET_IDS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(parseSetVatBody({ ids: many, rate: 0.05 })).toMatchObject({ ok: false });
    expect(parseSetVatBody(null)).toMatchObject({ ok: false });
  });

  it("the RPC args, the result shape and the SQL refusals", () => {
    expect(setVatRpcArgs({ ids: [ID1], rate: 0.18, note: null }, "u1"))
      .toEqual({ p_ids: [ID1], p_rate: 0.18, p_actor: "u1", p_note: null });
    expect(shapeSetVatResult({
      rate: "0.180", requested: 2, updated: 1, unchanged: 1, missing: [], extra: "dropped",
      changes: [{ id: ID1, name: "R&R Melem", from: "0.050", to: "0.180", from_source: "rule:supplement-5" }],
    })).toEqual({
      rate: 0.18, requested: 2, updated: 1, unchanged: 1, missing: [],
      changes: [{ id: ID1, name: "R&R Melem", from: 0.05, to: 0.18, from_source: "rule:supplement-5" }],
    });
    expect(shapeSetVatResult(null)).toMatchObject({ rate: null, updated: 0, changes: [] });
    expect(vatRpcError({ code: "22023", message: "invalid VAT rate" })).toEqual({ error: "invalid VAT rate" });
    expect(vatRpcError({ code: "42501", message: "x" })).toBeNull();
  });
});

describe("the product columns: owners only, written only by the audited route", () => {
  const raw = {
    id: ID1, name: "1 DR.SLIM POWDER+2 DR.SLIM CAPS", vat_rate: "0.050", vat_source: "sigma:crosswalk-HIGH",
    vat_sigma_code: "001225", vat_sigma_name: "ДР.СЛИМ 90 цпс", vat_evidence: "2025@5.00: 88; mex@5.00: 10",
    vat_set_by: "u-secret", vat_set_at: "2026-10-01T20:00:00Z", price: 30, cost_price: 3, is_active: true,
  };

  it("an owner sees the rate, its Sigma item and evidence (never who set it); anyone else sees none", () => {
    const owner = applyVatVisibility({ ...raw }, raw, true);
    expect(owner).toMatchObject({ vat_rate: 0.05, vat_sigma_code: "001225", vat_sigma_name: "ДР.СЛИМ 90 цпс" });
    expect(owner).not.toHaveProperty("vat_set_by");
    const agent = applyVatVisibility({ ...raw }, raw, false);
    for (const k of VAT_COLUMNS) expect(agent).not.toHaveProperty(k);
    expect(productVatOf({}).vat_rate).toBeNull();      // a new product = unclassified
  });

  it("the lean catalogue carries them only with showVat", () => {
    expect(CATALOGUE_SELECT).toContain("vat_rate");
    expect(CATALOGUE_SELECT_NO_VAT).not.toContain("vat_");
    expect(shapeCatalogueRow(raw, { showCost: true, showVat: true })).toMatchObject({ vat_rate: 0.05, vat_source: "sigma:crosswalk-HIGH" });
    expect(shapeCatalogueRow(raw, { showCost: true })).not.toHaveProperty("vat_rate");
    expect(isMissingVatColumn({ code: "42703", message: "column products.vat_rate does not exist" })).toBe(true);
    expect(isMissingVatColumn({ code: "42703", message: "column products.kind does not exist" })).toBe(false);
    expect(isMissingVatColumn(null)).toBe(false);
  });

  it("a PATCH body loses the VAT columns", () => {
    const body: Record<string, unknown> = { name: "x", vat_rate: 0.18, vat_source: "owner" };
    expect(stripVatFields(body)).toEqual(["vat_rate", "vat_source"]);
    expect(body).toEqual({ name: "x" });
  });
});

describe("/management-insights: VAT per product name", () => {
  it("the rate per name: rated first, then costed, then active, then the smaller id", () => {
    const m = vatRateByName([
      { id: "b", name: "Veno Gel", vat_rate: null, cost_price: 5, is_active: true },
      { id: "c", name: "Veno Gel", vat_rate: "0.180", cost_price: 0, is_active: false },
      { id: "a", name: "Zinc", vat_rate: "0.050" },
      { id: "d", name: "New product", vat_rate: null },
      { id: "e", name: null, vat_rate: "0.180" },
    ]);
    expect(m.get("Veno Gel")).toBe(0.18);
    expect(m.get("Zinc")).toBe(0.05);
    expect(m.has("New product")).toBe(false);
  });

  it("Σ per name at its rate; unknown names and the unexplained rest at 5 %, reported unclassified", () => {
    const rates = new Map([["Veno Gel", 0.18 as const], ["Zinc", 0.05 as const]]);
    const v = vatOfNamedRevenue([{ name: "Veno Gel", revenue: 1180 }, { name: "Zinc", revenue: 2100 }, { name: "?", revenue: 105 }], rates, 3490);
    // 1180 × 18/118 + 2100 × 5/105 + 105 × 5/105 + (3490 − 3385) × 5/105
    expect(v.vat).toBeCloseTo(180 + 100 + 5 + 5, 9);
    expect(v.by_rate["0.18"]).toEqual({ revenue: 1180, vat: expect.closeTo(180, 9) });
    expect(v.by_rate["0.05"].revenue).toBeCloseTo(2310, 9);
    expect(v.unclassified.revenue).toBeCloseTo(210, 9);
    expect(v.share).toBeCloseTo(290 / 3490, 12);
    // nothing collected: the share is the default's (a channel row stays 0 anyway)
    expect(vatOfNamedRevenue([], rates, 0).share).toBeCloseTo(vatShare(0.05), 12);
  });
});

// ── the migration: the backfill is exactly the authoritative table ────────────

const ROOT = join(__dirname, "..", "..", "..");
const MIGRATION = readFileSync(join(ROOT, "supabase", "migrations", "20260944000900_product_vat_rate.sql"), "utf8");
const TABLE = JSON.parse(readFileSync(join(ROOT, "docs", "vat", "crm_products_vat.json"), "utf8")) as {
  id: string; vat_rate: number; vat_source: string; sigma_code: string | null;
}[];

// 20260944000910: five rows corrected after the backfill (wrong crosswalk links + one of Sigma's own errors)
const FIXES = readFileSync(join(ROOT, "supabase", "migrations", "20260944000910_product_vat_rate_fixes.sql"), "utf8");
const fixTuples = [...FIXES.matchAll(/^\s*\('([0-9a-f-]{36})', (\d\.\d{2,3}), '([^']+)', (NULL|'[^']*')/gm)]
  .map((m) => ({ id: m[1], rate: Number(m[2]), source: m[3], code: m[4] === "NULL" ? null : m[4].slice(1, -1) }));

describe("migration 20260944000900", () => {
  const tuples = [...MIGRATION.matchAll(/^\s*\('([0-9a-f-]{36})'::uuid, (\d\.\d{3}), '([^']+)', (NULL|'[^']*')/gm)]
    .map((m) => ({ id: m[1], rate: Number(m[2]), source: m[3], code: m[4] === "NULL" ? null : m[4].slice(1, -1) }));

  it("backfills all 706 products; with 000910's fixes = the table's rate, source and Sigma code — nothing re-derived", () => {
    expect(TABLE).toHaveLength(706);
    expect(tuples).toHaveLength(706);
    const byId = new Map(tuples.map((t) => [t.id, t]));
    const fixById = new Map(fixTuples.map((t) => [t.id, t]));
    for (const r of TABLE) {
      const t = fixById.get(r.id) ?? byId.get(r.id);
      expect(t, r.id).toBeDefined();
      expect(t!.rate).toBe(r.vat_rate);
      expect(t!.source).toBe(r.vat_source);
      expect(t!.code).toBe(r.sigma_code || null);
    }
    const effective = tuples.map((t) => fixById.get(t.id) ?? t);
    expect(effective.filter((t) => t.rate === 0.05)).toHaveLength(TABLE.filter((r) => r.vat_rate === 0.05).length);
  });

  it("000910 moves exactly five backfilled rows to 18 %, each a real change", () => {
    expect(fixTuples).toHaveLength(5);
    const byId = new Map(tuples.map((t) => [t.id, t]));
    for (const f of fixTuples) {
      expect(f.rate).toBe(0.18);
      expect(byId.get(f.id)?.rate, f.id).toBe(0.05);
    }
    expect(FIXES).toContain("p.vat_source IS DISTINCT FROM 'owner'");   // never overwrites an owner's rate
  });

  it("the CHECK, the guard over every VAT column, the writer, the cache version and the per-line VAT", () => {
    expect(MIGRATION).toMatch(/CHECK \(vat_rate IS NULL OR vat_rate IN \(0, 0\.05, 0\.10, 0\.18\)\)/);
    expect(MIGRATION).toContain(`BEFORE INSERT OR UPDATE OF ${VAT_COLUMNS.join(", ")}`);
    expect(MIGRATION).toContain("CREATE OR REPLACE FUNCTION public.products_set_vat_rate(p_ids uuid[], p_rate numeric, p_actor uuid, p_note text DEFAULT NULL)");
    expect(MIGRATION).toContain("'products.set_vat_rate'");
    expect(MIGRATION).toContain("AS $function$ SELECT 5 $function$");
    expect(MIGRATION).toContain("coalesce(p.vat_rate::text, '')");      // the cache sig sees every rate
    expect(MIGRATION).toContain("ln.rv * coalesce(ln.vat_n, 0.05)::float8 / (1 + coalesce(ln.vat_n, 0.05)::float8) AS vt");
    expect(MIGRATION.match(/'vat_mode', 'per_line'/g)).toHaveLength(2);
  });
});
