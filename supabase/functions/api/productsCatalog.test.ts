import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  KIND_RE_BUNDLE_WORD, KIND_RE_HIT_TRIM, KIND_RE_JOINER, KIND_RE_MULTI_PACK, KIND_RE_NUTRIENT_PLUS, KIND_RE_OBJECT, KIND_RE_PROMO,
  classifyKindByName, humanCategory, humanDescription, isMachineCategory, isMachineDescription, parseProductPatch,
  parseSetKindBody, proposeKind, shapeCatalogueRow, shapeKindProposal, shapeSetKindResult, stripKindFields,
} from "./productsCatalog.ts";

// Производи 2.0 (owner 01.10.2026). Product names below are real catalogue spellings; no customer data.
const kind = (name: string) => classifyKindByName(name).kind;

describe("the name classifier", () => {
  it("bundles: n+n, the bundle words, 2x / 3x, a leading count, a + joining items", () => {
    expect(kind("2x Diet Shake + Slim Complex")).toBe("bundle");
    expect(classifyKindByName("2x Diet Shake + Slim Complex")).toMatchObject({ reason: "multi_pack", hit: "2x" });
    expect(classifyKindByName("Brain Protect 30+30 Gratis")).toMatchObject({ kind: "bundle", reason: "promo", hit: "30+30" });
    expect(classifyKindByName("Neurofix 1+1")).toMatchObject({ kind: "bundle", reason: "promo", hit: "1+1" });
    expect(classifyKindByName("АЛОЕ ВЕРА ГЕЛ-АРОНИЈА 1Л-сет2+1").kind).toBe("bundle");
    expect(classifyKindByName("СЕТ ЗА СЛАБЕЕЊЕ")).toMatchObject({ kind: "bundle", reason: "bundle_word" });
    expect(classifyKindByName("WHEY + CREATINE PACK")).toMatchObject({ kind: "bundle", reason: "bundle_word", hit: "pack" });
    expect(classifyKindByName("HULK - Bulking Combo").kind).toBe("bundle");
    expect(classifyKindByName("ELIXY COMBO PAKET").kind).toBe("bundle");
    expect(classifyKindByName("100% WHEY Protein, 1500g + BCAA + CREATINE MONOHYDRATE + Tribulus Terrestris гратис").kind).toBe("bundle");
    expect(classifyKindByName("Snail Repair Serum + Rosehip Oil + Jade Roller ПОДАРОК")).toMatchObject({ kind: "bundle", reason: "bundle_word" });
    expect(classifyKindByName("3x Brain Protect (90cps)")).toMatchObject({ kind: "bundle", reason: "multi_pack" });
    expect(classifyKindByName("3 MAGNESIUM CITRAT + ZINC 120/1 tab")).toMatchObject({ kind: "bundle", reason: "multi_pack", hit: "3" });
    expect(classifyKindByName("URO Protect + D-Mannose")).toMatchObject({ kind: "bundle", reason: "plus_joiner" });
    expect(classifyKindByName("1 DR.SLIM POWDER+2 DR.SLIM CAPS").kind).toBe("bundle");
    expect(classifyKindByName("VITAMIN D3+K2+BOR 180/1 tab + ЦИНК-30 tbl").kind).toBe("bundle");
    expect(classifyKindByName("Ultimate SlimBox, 6 in 1").kind).toBe("bundle");
  });

  it("objects (mk / en / sq / bg) are Друго; a set of objects too", () => {
    expect(classifyKindByName("ТЕЛЕСНА ВАГА")).toMatchObject({ kind: "other", reason: "object_word", hit: "вага" });
    expect(kind("КУЈИНСКА ВАГА")).toBe("other");
    expect(kind("СТАПЧЕСТ БЛЕНДЕР")).toBe("other");
    expect(kind("МАЛ ГРИЛ ТОСТЕР")).toBe("other");
    expect(kind("ШЕЈКЕР")).toBe("other");
    expect(kind("МАТАЛКА ЗА НЕС")).toBe("other");
    expect(kind("Jade Roler")).toBe("other");
    expect(kind("5 in 1 Beauty Care Massager")).toBe("other");   // "5 in 1" is not a pack of five
    expect(kind("РАЧЕН БЛЕНДЕР 4 ВО 1")).toBe("other");
    expect(kind("ФЕН ЗА КОСА")).toBe("other");
    expect(kind("ТАБЛЕТ-СТ95")).toBe("other");
    expect(kind("Електрично ќебе (120х150cm)")).toBe("other");   // 120х150 is a size, not "2x"
    expect(kind("TPE YOGA MAT - BLUE")).toBe("other");
    expect(kind("Body scale")).toBe("other");
    expect(kind("Peshore trupi")).toBe("other");                 // sq
    expect(kind("Електронна везна")).toBe("other");              // bg
    expect(classifyKindByName("СТАПЧЕСТ БЛЕНДЕТ+СЕЦКО")).toMatchObject({ kind: "other", reason: "object_set" });
  });

  it("single products stay products — no false hits inside words or formulas", () => {
    expect(classifyKindByName("Neurofix")).toEqual({ kind: "product", reason: "single", hit: null });
    expect(kind("АШВАГАНДА ЕКСТРАКТ 60/1 cps")).toBe("product");         // "ашВАГАнда" is not a scale
    expect(kind("ТАБЛЕТИ")).toBe("product");                               // tablets, not a tablet computer
    expect(kind("MAGNESIUM+ZINK+B complex 120/1 TAB")).toBe("product");   // one formula
    expect(kind("VITAMIN D3+K2+BOR 180/1 tab")).toBe("product");
    expect(kind("EISEN+B9+B12-250/1 TAB")).toBe("product");
    expect(kind("Zinc + Chromium (пиколинат) 120 таб")).toBe("product");
    expect(kind("MAGNESIUM+ B6 150/1 tab")).toBe("product");
    expect(kind("ELIXY DNEVNA & HYALURONIC +35  50 ml")).toBe("product"); // an age, not a joiner
    expect(kind("ELIXY Hyaluronic&Aloe Vera 45+")).toBe("product");
    expect(kind("BABE Протеогликан Ф+Ф ампули 2*2ml")).toBe("product");
    expect(kind("100 % whey протеин ванила 500gr")).toBe("product");
    expect(kind("СНАИЛ КОМПЛЕКС cps 30")).toBe("product");
    expect(classifyKindByName("   ")).toEqual({ kind: null, reason: "empty_name", hit: null });
  });
});

describe("the proposal", () => {
  it("a single product mostly given free beside a paid one is a gift (sure from 90 % of 30 lines)", () => {
    expect(proposeKind("ГЛУКОЗАМИН СУЛФАТ 30 cps", { lines: 27780, free: 25015 })).toMatchObject({ kind: "gift", reason: "free_in_orders", confidence: "high" });
    expect(proposeKind("САУ ПАЛМЕТТО (Saw Palmetto) 30 cps", { lines: 10566, free: 8778 })).toMatchObject({ kind: "gift", confidence: "low" });
    expect(proposeKind("B6 180/1 tab BIONATURAL", { lines: 25, free: 25 })).toMatchObject({ kind: "gift", confidence: "low" });   // < 30 lines
    expect(proposeKind("Aloe Vera 500ml", { lines: 11, free: 11 })).toMatchObject({ kind: "product", confidence: "high" });      // < 20 lines
    expect(proposeKind("СЛИМ КОМПЛЕКС 30cps", { lines: 2556, free: 1277 })).toMatchObject({ kind: "product" });                // 50 %
  });
  it("an object stays Друго even when it is given away (owner: shakers are Друго)", () => {
    expect(proposeKind("МАТАЛКА ЗА НЕС", { lines: 2198, free: 2189 })).toMatchObject({ kind: "other", reason: "object_word" });
  });
  it("a bundle name wins over the free share", () => {
    expect(proposeKind("СПИРУЛИНА 150+150 tbl", { lines: 100, free: 100 })).toMatchObject({ kind: "bundle", reason: "promo" });
  });
});

describe("the SQL twin (migration 20260943001400) uses the very same regexes", () => {
  const sql = readFileSync(resolve(__dirname, "../../migrations/20260943001400_product_kind.sql"), "utf8");
  for (const [name, src] of Object.entries({
    KIND_RE_PROMO, KIND_RE_BUNDLE_WORD, KIND_RE_MULTI_PACK, KIND_RE_NUTRIENT_PLUS, KIND_RE_JOINER, KIND_RE_OBJECT, KIND_RE_HIT_TRIM,
  })) {
    it(`${name} appears verbatim`, () => {
      expect(src).not.toContain("'");
      expect(sql).toContain(`'${src}'`);
    });
  }
  it("the gift thresholds match", () => {
    expect(sql).toContain("s.lines >= 20 AND s.share >= 0.6");
    expect(sql).toContain("j.share >= 0.9 AND j.lines >= 30");
  });
});

describe("POST /products/kind", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  it("parses ids and kind (null = Неодредено)", () => {
    expect(parseSetKindBody({ ids: [id, id.toUpperCase()], kind: "bundle" })).toEqual({ ok: true, args: { ids: [id], kind: "bundle" } });
    expect(parseSetKindBody({ ids: [id], kind: null })).toEqual({ ok: true, args: { ids: [id], kind: null } });
    expect(parseSetKindBody({ ids: [id] })).toMatchObject({ ok: false });
    expect(parseSetKindBody({ ids: [id], kind: "toaster" })).toMatchObject({ ok: false });
    expect(parseSetKindBody({ ids: ["x"], kind: "gift" })).toMatchObject({ ok: false });
    expect(parseSetKindBody({ ids: [], kind: "gift" })).toMatchObject({ ok: false });
  });
  it("shapes the writer's answer", () => {
    expect(shapeSetKindResult({ kind: "gift", requested: 2, updated: "1", unchanged: 1, missing: [], changes: [{ id, name: "x", from: null, to: "gift", extra: 1 }] }))
      .toEqual({ kind: "gift", requested: 2, updated: 1, unchanged: 1, missing: [], changes: [{ id, name: "x", from: null, to: "gift" }] });
  });
  it("PATCH drops the kind columns", () => {
    const body: Record<string, unknown> = { name: "x", kind: "gift", kind_set_by: "u", kind_set_at: "t" };
    expect(stripKindFields(body)).toEqual(["kind", "kind_set_by", "kind_set_at"]);
    expect(body).toEqual({ name: "x" });
  });
});

describe("GET /products/kind-proposal shape", () => {
  it("whitelists keys and coerces numbers", () => {
    const p = shapeKindProposal({
      generated_at: "2026-10-01T00:00:00Z",
      summary: { products: 2, suggested: { product: 1, gift: 1 }, decided: 0, auto: 1, low: 1, differs: 0, secret: 1 },
      rows: [{ id: "a", name: "Zinc", suggested: "gift", confidence: "low", reason: "free_in_orders", lines: "40", free_lines: 30, free_share: "0.75", auto: false, extra: "x" }],
    });
    expect(p.summary).toEqual({ products: 2, suggested: { product: 1, bundle: 0, gift: 1, other: 0, none: 0 }, decided: 0, auto: 1, low: 1, differs: 0 });
    expect(p.rows[0]).toMatchObject({ id: "a", suggested: "gift", confidence: "low", lines: 40, free_share: 0.75, kind: null });
    expect(p.rows[0]).not.toHaveProperty("extra");
  });
});

describe("machine text (owner 01.10: never shown)", () => {
  it("recognises the 28.09 scripts' notes, keeps a human note", () => {
    const auto = "Креиран автоматски (complete-catalogue, run 324615d4-cd88-4994-aa0b-8ad49c3d3310): производ со продажби …";
    expect(isMachineDescription(auto)).toBe(true);
    expect(isMachineDescription("Created for the AlterCPA history import (2026-08-05).")).toBe(true);
    expect(isMachineDescription("AlterCPA offer Neurofix 1+1 — a bundle of 2 × Neurofix; pack TWO boxes")).toBe(false);
    expect(humanDescription(auto)).toBe("");
    expect(humanDescription("Се зема наутро")).toBe("Се зема наутро");
    expect(isMachineCategory("Од продажби — collabBox/web (28.09.2026)")).toBe(true);
    expect(isMachineCategory("Без каталог — трета страна (веб)")).toBe(true);
    expect(humanCategory("AlterCPA — нови понуди (28.09.2026)")).toBe("");
    expect(humanCategory("Козметика")).toBe("Козметика");
  });
});

describe("GET /products/catalogue rows", () => {
  const raw = {
    id: "p1", name: "Zinc", sku: "001", barcode: null, price: "10", cost_price: "2", stock_quantity: 1000, low_stock_threshold: 5,
    days_of_supply_per_unit: 15, is_active: true, category: "Од продажби — collabBox/web (28.09.2026)",
    description: "Креиран автоматски (import-catalogue-products, run x): …", supplier_id: null, suppliers: { name: "Natura DOO" },
    brand_line: "natura_therapy", kind: "gift", created_at: "2026-09-28T00:00:00Z", photo_url: "x", brand_line_set_by: "u",
  };
  it("blanks machine text, flattens the supplier, keeps cost only for those who see it", () => {
    const admin = shapeCatalogueRow(raw, { showCost: true });
    expect(admin).toMatchObject({ price: 10, cost_price: 2, suggested_price: 10, category: "", description: "", supplier_name: "Natura DOO", kind: "gift" });
    expect(admin).not.toHaveProperty("photo_url");
    expect(admin).not.toHaveProperty("brand_line_set_by");
    expect(shapeCatalogueRow(raw, { showCost: false })).not.toHaveProperty("cost_price");
    expect(shapeCatalogueRow({ ...raw, price: 0, cost_price: 2 }, { showCost: false }).suggested_price).toBe(15);
  });
});

describe("PATCH /products/:id whitelist", () => {
  it("keeps the form's fields, drops the rest, guards cost", () => {
    const r = parseProductPatch({ name: "  Zinc  ", price: 12.5, barcode: " 389 ", sku: "", stock_quantity: 3, kind: "gift", id: "x", cost_price: 1 }, { canCost: false });
    expect(r).toEqual({ ok: true, update: { name: "Zinc", price: 12.5, barcode: "389", sku: null, stock_quantity: 3 }, dropped: ["kind", "id", "cost_price"] });
    expect(parseProductPatch({ cost_price: 1 }, { canCost: true })).toMatchObject({ ok: true, update: { cost_price: 1 } });
  });
  it("refuses bad values", () => {
    expect(parseProductPatch({ name: "  " }, { canCost: true })).toMatchObject({ ok: false });
    expect(parseProductPatch({ price: -1 }, { canCost: true })).toMatchObject({ ok: false });
    expect(parseProductPatch({ stock_quantity: 1.5 }, { canCost: true })).toMatchObject({ ok: false });
    expect(parseProductPatch({ days_of_supply_per_unit: 0 }, { canCost: true })).toMatchObject({ ok: false });
    expect(parseProductPatch({ is_active: "yes" }, { canCost: true })).toMatchObject({ ok: false });
    expect(parseProductPatch({ supplier_id: "nope" }, { canCost: true })).toMatchObject({ ok: false });
    expect(parseProductPatch({ low_stock_threshold: 7 }, { canCost: false })).toEqual({ ok: true, update: { low_stock_threshold: 7 }, dropped: [] });
  });
});
