import { describe, expect, it } from "vitest";
import {
  stripSettlementPrefix, cleanQuarter, parseCityInput, splitZoneStyle, orderZoneColumns, firstRow,
  changedAddressFields, withoutAddressFields, ADDRESS_LOCK_FIELDS, isSettlementId, parseResolveQuery,
  shapeSettlements, shapeDistricts, type ZoneRow, type SettlementSearchRow,
} from "./addressRouting.ts";

// The parse rules are the SQL's (migration 20260943000600: mk_strip_settlement_prefix,
// mk_clean_quarter and the head of mex_zone_for_name). The same cases were run
// through the SQL in a rolled-back live test — keep the two in step.

describe("stripSettlementPrefix — never eats the С of Скопје", () => {
  it.each([
    ["Скопје", "Скопје"],
    ["Струга", "Струга"],
    ["Струмица", "Струмица"],
    ["Skopje", "Skopje"],
    ["Selce", "Selce"],
    ["Селце", "Селце"],
    ["Градско", "Градско"],
    ["Град Скопје", "Скопје"],
    ["град Скопје", "Скопје"],
    ["с. Сушица", "Сушица"],
    ["с.Сушица", "Сушица"],
    ["С. Сушица", "Сушица"],
    ["село Сушица", "Сушица"],
    ["Село Сушица", "Сушица"],
    ["с Сушица", "Сушица"],
    ["гр. Битола", "Битола"],
    ["гр.Битола", "Битола"],
    ["Гр. Битола", "Битола"],
    ["гр Битола", "Битола"],
    ["s. Susica", "Susica"],
    ["gr. Bitola", "Bitola"],
    ["  Скопје  ", "Скопје"],
    ["", ""],
  ])("%s → %s", (input, out) => {
    expect(stripSettlementPrefix(input)).toBe(out);
  });
  it("tolerates null", () => {
    expect(stripSettlementPrefix(null)).toBe("");
    expect(stripSettlementPrefix(undefined)).toBe("");
  });
});

describe("cleanQuarter", () => {
  it.each([
    ["нас. Аеродром", "Аеродром"],
    ["населба Карпош 2", "Карпош 2"],
    ["Населба Лисиче", "Лисиче"],
    ["н.м. Кисела Вода", "Кисела Вода"],
    ["кв. Центар", "Центар"],
    ["ж.к. Тафталиџе", "Тафталиџе"],
    ["Карпош 4", "Карпош 4"],
    ["Кисела Вода", "Кисела Вода"],
  ])("%s → %s", (input, out) => {
    expect(cleanQuarter(input)).toBe(out);
  });
});

describe("parseCityInput", () => {
  it("reads the picker's \", општ. X\" suffix as a municipality hint", () => {
    expect(parseCityInput("Кадино, општ. Скопје")).toEqual({ base: "Кадино", municipality: "Скопје", quarter: null });
    expect(parseCityInput("Крушево, општина Виница")).toEqual({ base: "Крушево", municipality: "Виница", quarter: null });
    expect(parseCityInput("Kadino, opst. Skopje")).toEqual({ base: "Kadino", municipality: "Skopje", quarter: null });
    expect(parseCityInput("с. Сушица, општ. Струмица")).toEqual({ base: "Сушица", municipality: "Струмица", quarter: null });
  });
  it("any other text after the comma is a quarter hint — unless a quarter was given", () => {
    expect(parseCityInput("Скопје, Карпош 4")).toEqual({ base: "Скопје", municipality: null, quarter: "Карпош 4" });
    expect(parseCityInput("Скопје, Карпош 4", "Аеродром")).toEqual({ base: "Скопје", municipality: null, quarter: "Аеродром" });
  });
  it("keeps a plain city and its quarter", () => {
    expect(parseCityInput("Скопје", "Карпош 2")).toEqual({ base: "Скопје", municipality: null, quarter: "Карпош 2" });
    expect(parseCityInput("Струга")).toEqual({ base: "Струга", municipality: null, quarter: null });
    expect(parseCityInput("гр. Битола")).toEqual({ base: "Битола", municipality: null, quarter: null });
    expect(parseCityInput("  ", "  ")).toEqual({ base: "", municipality: null, quarter: null });
  });
  it("a word that merely starts like општ… is not a municipality", () => {
    expect(parseCityInput("Скопје, Општинска 5").municipality).toBeNull();
  });
});

describe("splitZoneStyle", () => {
  it("splits MEX's own zone names", () => {
    expect(splitZoneStyle("Skopje - Aerodrom")).toEqual({ city: "Skopje", quarter: "Aerodrom" });
    expect(splitZoneStyle("SKOPJE-KERAMIDNICA")).toEqual({ city: "SKOPJE", quarter: "KERAMIDNICA" });
    expect(splitZoneStyle("Tetovo - Lesnica dolna")).toEqual({ city: "Tetovo", quarter: "Lesnica dolna" });
  });
  it("returns null without a dash", () => {
    expect(splitZoneStyle("Скопје")).toBeNull();
    expect(splitZoneStyle("- Aerodrom")).toBeNull();
  });
});

const row = (over: Partial<ZoneRow>): ZoneRow => ({
  city_id: "osm:n170792214", city_name: "Скопје", district_id: null, district_name: null, post_code: "1000",
  mex_city_id: 185, mex_city_name: "Skopje - Centar", requires_district: true, basis: "city_default", ...over,
});

describe("orderZoneColumns", () => {
  it("the picked district wins and is what the order remembers", () => {
    const picked = row({ district_id: "osm:n1926166030", district_name: "Карпош 2", mex_city_id: 176, mex_city_name: "Skopje - Karpoš", basis: "district" });
    expect(orderZoneColumns(picked, row({}))).toEqual({
      settlement_id: "osm:n1926166030", mex_city_id: 176, mex_city_name: "Skopje - Karpoš", mex_zone_basis: "district",
      post_code: "1000", requires_district: true, ambiguous: false,
    });
  });
  it("Skopje with no district is the city default", () => {
    expect(orderZoneColumns(row({}), null)).toMatchObject({ settlement_id: "osm:n170792214", mex_city_id: 185, mex_zone_basis: "city_default" });
  });
  it("falls back to the name result when the picked id does not exist", () => {
    const byName = row({ city_id: "osm:n293008707", city_name: "Струга", mex_city_id: 142, mex_city_name: "Struga", basis: "name", requires_district: false, post_code: "6330" });
    expect(orderZoneColumns(row({ city_id: null }), byName)).toMatchObject({ settlement_id: "osm:n293008707", mex_city_id: 142, mex_zone_basis: "name", post_code: "6330" });
    expect(orderZoneColumns(null, byName).mex_zone_basis).toBe("name");
  });
  it("an ambiguous name routes nowhere and says so", () => {
    const amb: ZoneRow = { ...row({ city_id: null, city_name: null, mex_city_id: null, mex_city_name: null, basis: null, requires_district: null, post_code: null }), match: "ambiguous", candidates: [{}, {}] };
    expect(orderZoneColumns(null, amb)).toEqual({
      settlement_id: null, mex_city_id: null, mex_city_name: null, mex_zone_basis: null, post_code: null, requires_district: false, ambiguous: true,
    });
  });
  it("no zone → no basis, even when a settlement matched", () => {
    const unmapped = row({ city_id: "osm:x", city_name: "Планинско", mex_city_id: null, mex_city_name: null, basis: null, requires_district: false });
    expect(orderZoneColumns(unmapped, null)).toMatchObject({ settlement_id: "osm:x", mex_city_id: null, mex_zone_basis: null });
  });
  it("nothing at all", () => {
    expect(orderZoneColumns(null, null).mex_city_id).toBeNull();
  });
  it("firstRow takes the TABLE function's first row", () => {
    expect(firstRow([{ a: 1 }, { a: 2 }])).toEqual({ a: 1 });
    expect(firstRow([])).toBeNull();
    expect(firstRow(null)).toBeNull();
    expect(firstRow({ a: 3 })).toEqual({ a: 3 });
  });
});

describe("the address lock once MEX has the parcel", () => {
  const current = { customer_city: "Скопје", street: "Партизанска", street_number: "12", quarter: "Карпош 2", postal_code: "1000", settlement_id: "osm:n1926166030", apartment: null };
  it("an unchanged re-send passes (blank ≡ null, spaces ignored)", () => {
    expect(changedAddressFields(current, { customer_city: "Скопје ", street: "Партизанска", apartment: "", customer_name: "X" })).toEqual([]);
  });
  it("a real change is reported", () => {
    expect(changedAddressFields(current, { street: "Илинденска", quarter: "Карпош 2", settlement_id: "osm:n365294441" })).toEqual(["street", "settlement_id"]);
  });
  it("absent fields are not changes", () => {
    expect(changedAddressFields(current, {})).toEqual([]);
  });
  it("withoutAddressFields keeps the rest", () => {
    const all = Object.fromEntries(ADDRESS_LOCK_FIELDS.map((f) => [f, "x"]));
    expect(withoutAddressFields({ ...all, customer_name: "Ана", delivery_instructions: "ѕвони" })).toEqual({ customer_name: "Ана", delivery_instructions: "ѕвони" });
  });
});

describe("request parsing", () => {
  it("settlement ids", () => {
    expect(isSettlementId("osm:n1926166030")).toBe(true);
    expect(isSettlementId("osm:w12")).toBe(true);
    expect(isSettlementId("")).toBe(false);
    expect(isSettlementId("x'; drop table")).toBe(false);
    expect(isSettlementId(12)).toBe(false);
  });
  it("resolve query", () => {
    expect(parseResolveQuery(new URLSearchParams("city=Скопје&quarter=Карпош%202"))).toEqual({ city: "Скопје", quarter: "Карпош 2" });
    expect(parseResolveQuery(new URLSearchParams("city=Струга"))).toEqual({ city: "Струга", quarter: null });
    expect(parseResolveQuery(new URLSearchParams("quarter=x"))).toEqual({ error: "city required" });
  });
});

const s = (over: Partial<SettlementSearchRow>): SettlementSearchRow => ({
  id: "x", name: "X", name_lat: null, name_sq: null, post_code: null, region: null, municipality: null,
  kind: "village", mex_city_id: 1, parent_id: null, requires_district: false, is_hidden: false, ...over,
});

describe("shapeSettlements", () => {
  it("hides duplicates, names the parent and orders city → town → district → village", () => {
    const out = shapeSettlements([
      s({ id: "v", name: "Карпош", kind: "village" }),
      s({ id: "d2", name: "Карпош 2", kind: "city_district", parent_id: "sk" }),
      s({ id: "d1", name: "Карпош 1", kind: "city_district", parent_id: "sk" }),
      s({ id: "h", name: "Карпош 1", kind: "city_district", parent_id: "sk", is_hidden: true }),
      s({ id: "sk", name: "Скопје", kind: "city", requires_district: true }),
    ], new Map([["sk", "Скопје"]]));
    expect(out.map((r) => [r.id, r.parent_name])).toEqual([["sk", null], ["d1", "Скопје"], ["d2", "Скопје"], ["v", null]]);
    expect(out[0].requires_district).toBe(true);
    expect("is_hidden" in out[0]).toBe(false);
  });
  it("limits", () => {
    const many = Array.from({ length: 30 }, (_, i) => s({ id: `v${i}`, name: `Село ${i}` }));
    expect(shapeSettlements(many, new Map()).length).toBe(15);
  });
});

describe("shapeDistricts", () => {
  it("visible only, numeric-aware order, zone names attached", () => {
    const out = shapeDistricts([
      { id: "a", name: "Карпош 10", name_lat: null, post_code: "1000", mex_city_id: 176 },
      { id: "b", name: "Карпош 2", name_lat: null, post_code: "1000", mex_city_id: 176 },
      { id: "c", name: "Аеродром", name_lat: null, post_code: "1000", mex_city_id: 178 },
      { id: "d", name: "Гази Баба", name_lat: null, post_code: "1000", mex_city_id: 180, is_hidden: true },
    ], new Map([[176, "Skopje - Karpoš"], [178, "Skopje - Aerodrom"]]));
    expect(out.map((d) => d.name)).toEqual(["Аеродром", "Карпош 2", "Карпош 10"]);
    expect(out[0].mex_city_name).toBe("Skopje - Aerodrom");
  });
});
