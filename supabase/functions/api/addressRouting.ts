// Address routing — the pure half of the ONE MEX-zone resolver (Phase 5, plan 30.09).
//
// The zone an order ships to is decided in SQL (migration 20260943000600):
//   mex_zone_for_settlement(id)       the settlement / district the order form PICKED
//   mex_zone_for_name(city, quarter)  free text (AlterCPA, old clients, the repair)
// This module holds what the routes need around those calls — the text-parse rules
// (mirrored 1:1 from the SQL so they can be unit-tested), the choice between the two
// results, the columns written on an order, the address lock once a parcel exists at
// MEX, and the shape of the address/* responses. Dependency-free for vitest.
//
// Why it matters: MEX has NO cancellation endpoint. A parcel routed to the wrong zone
// is lost. Until 30.09 resolveMexCity() matched the text before the comma with LIMIT 1
// and no ORDER BY — 290 of 295 Skopje sales went to "Skopje - Centar".

// ── Text parse (mirror of public.mk_strip_settlement_prefix / mk_clean_quarter /
//    the head of public.mex_zone_for_name) ─────────────────────────────────────────

/**
 * "гр. Битола" / "с. Сушица" / "село Сушица" / "град Скопје" → the bare name. The
 * marker needs a dot or whitespace after it, so the С of Скопје / Струга / Струмица
 * (and the S of Skopje / Struga) is never eaten — the bug of the old picker regex
 * (гр\.? | с\.? | село | град, case-insensitive, optional dot), which turned
 * "Скопје" into "копје".
 */
export const SETTLEMENT_PREFIX_RE =
  /^\s*(?:[Гг]р\.|[Гг]р\s+|[Гг]рад\s+|[Сс]ело\s+|[Сс]\.|[Сс]\s+|[Gg]r\.|[Gg]rad\s+|[Ss]elo\s+|[Ss]\.|[Ss]\s+)\s*/;

/** "нас. Карпош" / "населба Карпош" / "н.м. …" / "кв. …" / "ж.к. …" → the name. */
export const QUARTER_PREFIX_RE =
  /^\s*(?:[Нн]ас\.|[Нн]аселба\s+|[Нн]\.\s?[Мм]\.|[Кк]в\.|[Жж]\.\s?[Кк]\.?|[Кк]вартал\s+|[Nn]as\.|[Nn]aselba\s+)\s*/;

/** The ", општ. X" / ", општина X" / ", opst. X" suffix the settlement picker writes. */
export const MUNICIPALITY_RE = /^(?:[Оо]пшт(?:ина)?|[Oo]p[sš]t(?:ina)?)(?:\.|\s|$)/;
const MUNICIPALITY_STRIP_RE = /^(?:[Оо]пшт(?:ина)?|[Oo]p[sš]t(?:ina)?)\.?\s*/;

export const stripSettlementPrefix = (s: string | null | undefined): string =>
  String(s ?? "").replace(SETTLEMENT_PREFIX_RE, "").trim();

export const cleanQuarter = (s: string | null | undefined): string =>
  String(s ?? "").replace(QUARTER_PREFIX_RE, "").trim();

export interface ParsedCityInput {
  /** The settlement name to look up (prefix stripped). */
  base: string;
  /** The municipality hint from ", општ. X" (raw text), or null. */
  municipality: string | null;
  /** The quarter: the explicit one, else any other text after the comma, or null. */
  quarter: string | null;
}

/**
 * The first half of mex_zone_for_name: split "Кадино, општ. Скопје" into base +
 * municipality hint, and "Скопје, Карпош 4" into base + quarter hint. The SQL then
 * also splits a MEX-style "Skopje - Aerodrom" — but only when nothing in
 * mk_settlements carries the full name, which needs the database (splitZoneStyle).
 */
export function parseCityInput(city: string | null | undefined, quarter?: string | null): ParsedCityInput {
  const raw = String(city ?? "").trim();
  const head = raw.split(",")[0];
  const rest = raw.slice(head.length + 1).trim();
  let municipality: string | null = null;
  let q: string | null = String(quarter ?? "").trim() || null;
  if (MUNICIPALITY_RE.test(rest)) {
    municipality = rest.replace(MUNICIPALITY_STRIP_RE, "").trim() || null;
  } else if (rest && !q) {
    q = rest;
  }
  return { base: stripSettlementPrefix(head), municipality, quarter: q };
}

/** "Skopje - Aerodrom" → { city: "Skopje", quarter: "Aerodrom" }; null without a dash. */
export function splitZoneStyle(base: string): { city: string; quarter: string } | null {
  const i = base.indexOf("-");
  if (i < 0) return null;
  const city = base.slice(0, i).trim();
  const quarter = base.slice(i + 1).trim();
  return city ? { city, quarter } : null;
}

// ── RPC rows → the order's zone columns ─────────────────────────────────────────

export type ZoneBasis = "district" | "settlement" | "city_default" | "name" | "repair" | "manual";
export const ZONE_BASES: readonly ZoneBasis[] = ["district", "settlement", "city_default", "name", "repair", "manual"];

/** A row of mex_zone_for_settlement / mex_zone_for_name. */
export interface ZoneRow {
  city_id: string | null;
  city_name: string | null;
  district_id: string | null;
  district_name: string | null;
  post_code: string | null;
  mex_city_id: number | null;
  mex_city_name: string | null;
  requires_district: boolean | null;
  basis: string | null;
  /** The settlement's kind (city / town / village) and derived nearest town — the form's label. */
  city_kind?: string | null;
  municipality?: string | null;
  match?: string | null;
  candidates?: unknown[] | null;
}

export interface OrderZone {
  settlement_id: string | null;
  mex_city_id: number | null;
  mex_city_name: string | null;
  mex_zone_basis: ZoneBasis | null;
  /** The settlement's postcode — fills postal_code only when the form sent none. */
  post_code: string | null;
  requires_district: boolean;
  ambiguous: boolean;
}

const asBasis = (b: string | null | undefined): ZoneBasis | null =>
  (ZONE_BASES as readonly string[]).includes(String(b)) ? (b as ZoneBasis) : null;

/** The first row of an RPC that RETURNS TABLE (supabase-js hands back an array). */
export function firstRow<T>(data: unknown): T | null {
  if (Array.isArray(data)) return (data[0] as T) ?? null;
  return (data as T) ?? null;
}

/**
 * The picked settlement wins when it exists; free text is the fallback. The stored
 * settlement_id is the district when there is one, else the settlement — exactly what
 * the order form would re-open on.
 */
export function orderZoneColumns(picked: ZoneRow | null, byName: ZoneRow | null): OrderZone {
  const row = picked?.city_id ? picked : byName;
  if (!row) {
    return { settlement_id: null, mex_city_id: null, mex_city_name: null, mex_zone_basis: null, post_code: null, requires_district: false, ambiguous: false };
  }
  const zone = Number(row.mex_city_id) > 0 ? Number(row.mex_city_id) : null;
  return {
    settlement_id: row.district_id || row.city_id || null,
    mex_city_id: zone,
    mex_city_name: zone ? row.mex_city_name ?? null : null,
    mex_zone_basis: zone ? asBasis(row.basis) : null,
    post_code: (row.post_code || "").trim() || null,
    requires_district: !!row.requires_district,
    ambiguous: row === byName && row.match === "ambiguous",
  };
}

// ── The address lock once MEX has the parcel ────────────────────────────────────

/** Every order column that changes where (or to whom) the parcel goes. */
export const ADDRESS_LOCK_FIELDS = [
  "customer_city", "customer_address", "postal_code", "street", "street_number", "quarter",
  "apartment", "floor", "block", "entry", "settlement_id", "delivery_type",
  "courier_office_code", "courier_office_name", "courier_office_city",
] as const;
export type AddressLockField = typeof ADDRESS_LOCK_FIELDS[number];

const norm = (v: unknown): string => (v === null || v === undefined ? "" : String(v).trim());

/**
 * The address fields a PATCH would really CHANGE (blank ≡ null, surrounding spaces
 * ignored). The order form re-sends every field on save, so an unchanged address on
 * a shipped order must pass; only a real change is refused.
 */
export function changedAddressFields(current: Record<string, unknown>, body: Record<string, unknown>): AddressLockField[] {
  return ADDRESS_LOCK_FIELDS.filter((f) => body[f] !== undefined && norm(body[f]) !== norm(current[f]));
}

/** Drop the address fields from an update (a shipped order's address is a snapshot). */
export function withoutAddressFields<T extends Record<string, unknown>>(updates: T): T {
  const out = { ...updates };
  for (const f of ADDRESS_LOCK_FIELDS) delete (out as Record<string, unknown>)[f];
  return out;
}

export const ADDRESS_LOCKED_ERROR = "The parcel is already at MEX — the address is locked.";

// ── address/* request parsing + response shapes ─────────────────────────────────

/** mk_settlements ids are "osm:<n|w|r><digits>"; accept any short token of that alphabet. */
export const isSettlementId = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9:._-]{1,64}$/.test(id);

export function parseResolveQuery(params: URLSearchParams): { city: string; quarter: string | null } | { error: string } {
  const city = (params.get("city") || "").trim();
  const quarter = (params.get("quarter") || "").trim() || null;
  if (!city) return { error: "city required" };
  if (city.length > 200 || (quarter && quarter.length > 200)) return { error: "too long" };
  return { city, quarter };
}

export interface SettlementSearchRow {
  id: string;
  name: string;
  name_lat: string | null;
  name_sq: string | null;
  post_code: string | null;
  region: string | null;
  municipality: string | null;
  kind: string;
  mex_city_id: number | null;
  parent_id: string | null;
  requires_district?: boolean | null;
  is_hidden?: boolean | null;
}

export interface SettlementResult extends Omit<SettlementSearchRow, "is_hidden"> {
  parent_name: string | null;
  requires_district: boolean;
}

const KIND_RANK: Record<string, number> = { city: 1, town: 2, city_district: 3, village: 4 };

/**
 * Hidden duplicates out, the parent's name in (a district reads "Карпош 2 · Скопје"),
 * cities before towns before districts before villages, then by name.
 */
export function shapeSettlements(rows: SettlementSearchRow[], parentNames: Map<string, string>, limit = 15): SettlementResult[] {
  return rows
    .filter((r) => !r.is_hidden)
    .map((r) => {
      const { is_hidden: _hidden, ...rest } = r;
      return {
        ...rest,
        parent_name: r.parent_id ? parentNames.get(r.parent_id) ?? null : null,
        requires_district: !!r.requires_district,
      };
    })
    .sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9) || a.name.localeCompare(b.name, "mk"))
    .slice(0, limit);
}

export interface DistrictRow {
  id: string;
  name: string;
  name_lat: string | null;
  post_code: string | null;
  mex_city_id: number | null;
  is_hidden?: boolean | null;
}

/** Visible districts of one city, alphabetical (Macedonian collation), with their zone name. */
export function shapeDistricts(rows: DistrictRow[], zoneNames: Map<number, string>) {
  return rows
    .filter((r) => !r.is_hidden)
    .map((r) => ({
      id: r.id, name: r.name, name_lat: r.name_lat, post_code: r.post_code,
      mex_city_id: r.mex_city_id, mex_city_name: r.mex_city_id != null ? zoneNames.get(r.mex_city_id) ?? null : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "mk", { numeric: true }));
}
