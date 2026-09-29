import { describe, expect, it } from "vitest";
import {
  buildCohortResponse, COHORT_BUCKETS, COHORT_KEYS, COHORT_NON_MONEY_KEYS, COHORT_OUTSIDE,
  COHORT_UNIVERSE_OR, cohortBucketOrFilter, cohortExcludedPhoneOr, cohortOrderBucket, cohortOrderSaleAt,
  cohortFilterChars, COHORT_FILTER_MAX_CHARS, cohortOrdersFilter, cohortSaleWindowOrFilter, insightsAccess, insightsWindows,
  isCohortExcludedPhone, overlayFreshness, parseCohortBucketParam, parseCohortExceptions, parseSourcesParam, stripInsightsMoney,
  COHORT_SOURCE_TERM, cohortSourceOrFilter, INSIGHTS_SOURCES, parseCohortSourceParam,
} from "./insightsCommon.ts";
import type { CohortExceptions, CohortOrderRow } from "./insightsCommon.ts";
// The week fixture in insights_cohort()'s exact shape (owner view).
import weekCohort from "../../../src/components/insights/shared/__fixtures__/cohort.sample.json";
// The verify script's PostgREST → SQL translation of this very filter.
import { pgrstOrToSql, pgrstTermToSql } from "../../../scripts/verify-insights-ties.mjs";

// ── a tiny PostgREST logic-tree evaluator (or/and/not + the ops we emit) ────
type Row = Record<string, unknown>;

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}
function cmp(a: unknown, b: string): number {
  if (typeof a === "number") return a - Number(b);
  const x = Date.parse(String(a)), y = Date.parse(b);
  if (!Number.isNaN(x) && !Number.isNaN(y) && /\d{4}-\d{2}-\d{2}T/.test(b)) return x - y;
  return String(a) < b ? -1 : String(a) > b ? 1 : 0;
}
/** Compile a PostgREST term once; evaluate with SQL three-valued logic. */
type Pred = (row: Row) => boolean | null;
function compile(term: string): Pred {
  const t = term.trim();
  const logic = t.match(/^(not\.)?(and|or)\((.*)\)$/s);
  if (logic) {
    const parts = splitTop(logic[3]).map(compile);
    const isAnd = logic[2] === "and", neg = !!logic[1];
    return (row) => {
      const vals = parts.map((p) => p(row));
      const r = isAnd
        ? (vals.includes(false) ? false : vals.includes(null) ? null : true)
        : (vals.includes(true) ? true : vals.includes(null) ? null : false);
      return neg ? (r === null ? null : !r) : r;
    };
  }
  const m = t.match(/^([a-z_]+)\.(not\.)?(eq|neq|gt|gte|lt|lte|is|in|like)\.(.*)$/s);
  if (!m) throw new Error("cannot parse " + t);
  const [, col, neg, op, val] = m;
  const list = op === "in" ? splitTop(val.replace(/^\(|\)$/g, "")) : [];
  // PostgREST `like`: * is SQL's % (any run), _ stays SQL LIKE's one-character wildcard
  const like = op === "like"
    ? new RegExp(`^${val.split("*").map((x) => [...x].map((ch) => (ch === "_" ? "." : ch.replace(/\W/g, "\\$&"))).join("")).join(".*")}$`, "s")
    : null;
  return (row) => {
    const v = row[col];
    let r: boolean | null;
    if (op === "is") r = val === "null" ? v == null : String(v) === val;
    else if (v == null) r = null;
    else if (op === "in") r = list.some((x) => String(v) === x);
    else if (like) r = like.test(String(v));
    else {
      const c = cmp(v, val);
      r = op === "eq" ? c === 0 : op === "neq" ? c !== 0 : op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0;
    }
    return neg ? (r === null ? null : !r) : r;
  };
}
const cache = new Map<string, Pred>();
/** supabase-js `.or(expr)` → PostgREST `or=(expr)`. */
const orMatches = (expr: string, row: Row) => {
  let p = cache.get(expr);
  if (!p) { p = compile(`or(${expr})`); cache.set(expr, p); }
  return p(row) === true;
};

// ── fixtures ───────────────────────────────────────────────────────────────
const W1 = "11111111-1111-4111-8111-111111111111";
const L1 = "22222222-2222-4222-8222-222222222222";
/** What migration 20260939000700 seeds into public.report_excluded_phones — test
 *  data here: the api never holds a copy, it gets the list from the exceptions RPC. */
const PH = ["70123456", "23123123"];

function* grid(): Generator<CohortOrderRow & { id: string; web: boolean }> {
  let n = 0;
  for (const status of ["pending", "take", "call_again", "duplicated", "confirmed", "shipped", "delivered", "paid", "returned", "cancelled", "trashed"])
  for (const price of [null, 0, 24.23])
  for (const sold_at of [null, "2026-09-10T10:00:00Z"])
  for (const paid_basis of [null, "mex", "operator_ruling", "legacy_import"])
  for (const source_type of [null, "import"])
  for (const sale_source_detail of [null, "disposition", "bridge"])
  for (const mex_tracking_id of [null, "002-9110-1/2026"])
  for (const mex_status_id of [null, 1, 2, 3, 7, 8, 13])
  for (const mex_cod_mkd of [null, -5, 0, 1490])
  for (const mex_delivered_at of [null, "2026-09-12T10:00:00Z"])
  for (const web of [false, true]) {
    n++;
    // keep the grid affordable: skip impossible combos (a MEX status without a tracking id)
    if (mex_tracking_id == null && (mex_status_id != null || mex_cod_mkd != null || mex_delivered_at != null)) continue;
    if (n % 3 && sale_source_detail === "bridge") continue;
    const id = web ? W1 : `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    yield { id, web, status, price, sold_at, paid_basis, source_type, sale_source_detail,
            mex_tracking_id, mex_status_id, mex_cod_mkd, mex_delivered_at };
  }
}

describe("cohort bucket twins", () => {
  it("the PostgREST filter selects exactly the rows cohortOrderBucket() puts in each bucket", () => {
    const filters = Object.fromEntries(COHORT_KEYS.map((k) => [k, cohortBucketOrFilter([k], [W1])!]));
    let checked = 0;
    for (const row of grid()) {
      const want = cohortOrderBucket(row, row.web);
      const inUniverse = orMatches(COHORT_UNIVERSE_OR, row);
      for (const k of COHORT_KEYS) {
        const got = inUniverse && orMatches(filters[k], row);
        if (got !== (want === k)) {
          throw new Error(`bucket ${k}: filter=${got} twin=${want} row=${JSON.stringify(row)}`);
        }
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(10000);
  }, 30_000);   // a cartesian sweep of every bucket × row: ~5–6 s alone, longer under a full parallel run

  it("MEX decides whenever a parcel exists — even on a CRM-cancelled order", () => {
    const base: CohortOrderRow = { status: "cancelled", price: 24.23, sold_at: null, paid_basis: null, source_type: "altercpa",
      sale_source_detail: "bridge", mex_tracking_id: "002-9110-1/2026", mex_status_id: 10, mex_cod_mkd: 1490, mex_delivered_at: null };
    expect(cohortOrderBucket(base, false)).toBe("courier");
    expect(cohortOrderBucket({ ...base, mex_status_id: 13 }, false)).toBe("courier_problem");
    expect(cohortOrderBucket({ ...base, mex_status_id: 8 }, false)).toBe("label");
    expect(cohortOrderBucket({ ...base, mex_status_id: 2 }, false)).toBe("paid");
    expect(cohortOrderBucket({ ...base, mex_status_id: 7 }, false)).toBe("returned");
    // a web order claims the parcel → judged on the CRM status: a pre-sale cancel is no sale
    expect(cohortOrderBucket({ ...base, mex_status_id: 2 }, true)).toBeNull();
    // COD <= 0 is a replacement, never a sale; a price-0 row with COD > 0 is a real sale
    expect(cohortOrderBucket({ ...base, mex_status_id: 2, mex_cod_mkd: 0 }, false)).toBe("replacement");
    expect(cohortOrderBucket({ ...base, mex_status_id: 2, price: 0 }, false)).toBe("paid");
  });

  it("no parcel: CRM status, disposition never, legacy labelled apart from unproven", () => {
    const base: CohortOrderRow = { status: "paid", price: 24.23, sold_at: "x", paid_basis: null, source_type: "altercpa",
      sale_source_detail: "bridge", mex_tracking_id: null, mex_status_id: null, mex_cod_mkd: null, mex_delivered_at: null };
    expect(cohortOrderBucket(base, false)).toBe("paid_unproven");
    expect(cohortOrderBucket({ ...base, source_type: "import" }, false)).toBe("paid_legacy");
    expect(cohortOrderBucket({ ...base, paid_basis: "operator_ruling" }, false)).toBe("paid_legacy");
    expect(cohortOrderBucket({ ...base, paid_basis: "manual", source_type: "import" }, false)).toBe("paid_unproven");
    expect(cohortOrderBucket({ ...base, status: "confirmed" }, false)).toBe("to_pack");
    expect(cohortOrderBucket({ ...base, status: "shipped" }, false)).toBe("courier");
    // Откажани (red) and Во корпа (grey) after the sale are apart — neither is in the total
    expect(cohortOrderBucket({ ...base, status: "cancelled" }, false)).toBe("cancelled_after_sale");
    expect(cohortOrderBucket({ ...base, status: "trashed" }, false)).toBe("trashed_after_sale");
    expect(cohortOrderBucket({ ...base, status: "cancelled", sold_at: null }, false)).toBeNull();
    // the BG-era 'delivered' reads as paid
    expect(cohortOrderBucket({ ...base, status: "delivered" }, false)).toBe("paid_unproven");
    expect(cohortOrderBucket({ ...base, status: "delivered", source_type: "import" }, false)).toBe("paid_legacy");
    expect(cohortOrderBucket({ ...base, status: "pending" }, false)).toBeNull();
    expect(cohortOrderBucket({ ...base, status: "confirmed", price: 0 }, false)).toBe("replacement");
    expect(cohortOrderBucket({ ...base, sale_source_detail: "disposition" }, false)).toBeNull();
  });

  it("total = the eight in-total buckets; the outside three are asked for by name", () => {
    expect(parseCohortBucketParam("total")).toEqual({ ok: true, values: [...COHORT_BUCKETS] });
    expect(parseCohortBucketParam("label,paid")).toEqual({ ok: true, values: ["paid", "label"] });
    expect(parseCohortBucketParam("trashed_after_sale").ok).toBe(true);
    expect(COHORT_OUTSIDE).toEqual(["cancelled_after_sale", "trashed_after_sale", "replacement"]);
    expect(parseCohortBucketParam("bogus").ok).toBe(false);
    expect(parseCohortBucketParam(null)).toEqual({ ok: true, values: [] });
    expect(cohortBucketOrFilter([])).toBeNull();
  });

  it("the web-claim id list appears at most twice, never once per clause (the URL stays short)", () => {
    const f = cohortBucketOrFilter(["paid", "to_pack"], [])!;
    expect(f).not.toMatch(/(^|[(,])id\./);
    expect(f.split("and(").length).toBeGreaterThan(2);
    const all = cohortBucketOrFilter([...COHORT_KEYS], [W1, L1])!;
    expect(all.split(W1).length - 1).toBe(2);
    expect(all.startsWith(`and(id.not.in.(${W1},${L1}),or(`)).toBe(true);
    // only MEX-decided buckets asked for: a web-claimed order can be in none of them
    expect(cohortBucketOrFilter(["label"], [W1])).toBe(`and(id.not.in.(${W1}),or(${cohortBucketOrFilter(["label"])}))`);
    // the whole /orders filter of a `total` drill with six web claims stays a few KB
    // (gateways refuse request lines past ~8 KB; supabase-js puts it all in the URL)
    const six = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    const totalDrill = cohortOrdersFilter([...COHORT_BUCKETS], { web_claimed: six, ledger: [], excluded_phone8s: PH, test_orders: [] },
      { fromIso: "2026-09-21T22:00:00.000Z", toEndIso: "2026-09-28T21:59:59.999999Z" });
    expect(totalDrill.or.join("").length).toBeLessThan(4000);
    expect(all.length).toBeLessThan(3600);
  });
});

describe("test phones (owner 2026-09-28)", () => {
  it("the last-8 canon (is_report_excluded_phone): 070 123 456 and 02 312 3123, however written", () => {
    for (const p of ["+38970123456", "070123456", "070 123 456", "+389 2 312 3123", "023123123", "23123123", "0038970123456"]) {
      expect(isCohortExcludedPhone(p, PH), p).toBe(true);
    }
    for (const p of ["+38970123457", "70123456x1", "", null, "1234567"]) expect(isCohortExcludedPhone(p, PH), String(p)).toBe(false);
    expect(isCohortExcludedPhone("+38970123456", [])).toBe(false);
  });
  it("the phone-text filter keeps every other phone and drops the canonical test forms", () => {
    const f = cohortExcludedPhoneOr(PH)!;
    const keep = (phone: string | null) => orMatches(f, { customer_phone: phone });
    expect(keep("+38971000001")).toBe(true);
    expect(keep(null)).toBe(true);
    expect(keep("+38970123456")).toBe(false);
    expect(keep("023123123")).toBe(false);
    // text the LIKE cannot see — the exceptions' test_orders list catches it by id
    expect(keep("070 123 456")).toBe(true);
  });
  it("the list is data from the database: none → no filter; only 8-digit values ever reach the URL", () => {
    expect(cohortExcludedPhoneOr([])).toBeNull();
    expect(cohortExcludedPhoneOr(["7012345", "70123456),id.not.is.null"])).toBeNull();
    expect(cohortExcludedPhoneOr(["12345678"])).toBe("customer_phone.is.null,and(customer_phone.not.like.*12345678)");
  });
});

describe("cohortOrdersFilter — everything GET /orders adds, assembled once", () => {
  const F = "2026-09-21T22:00:00.000Z", T = "2026-09-28T21:59:59.999999Z";
  const T1 = "33333333-3333-4333-8333-333333333333";
  const ex: CohortExceptions = { web_claimed: [W1], ledger: [{ id: L1, sale_at: "2026-09-23T10:00:00Z" }], excluded_phone8s: PH, test_orders: [T1] };
  type R = CohortOrderRow & { id: string; customer_phone: string | null };
  const base: R = {
    id: "a0000000-0000-4000-8000-000000000001", status: "confirmed", price: 24.23, sold_at: "2026-09-23T10:00:00Z",
    confirmed_at: null, created_at: "2026-09-22T10:00:00Z", paid_basis: null, source_type: "altercpa", sale_source_detail: "bridge",
    mex_tracking_id: null, mex_status_id: null, mex_cod_mkd: null, mex_delivered_at: null, customer_phone: "+38971000001",
  };
  const listed = (keys: string[], row: R) => {
    const parsed = parseCohortBucketParam(keys.join(","));
    if (!parsed.ok) throw new Error("bad keys");
    const f = cohortOrdersFilter(parsed.values, ex, { fromIso: F, toEndIso: T });
    return f.or.every((e) => orMatches(e, row as unknown as Row)) && !f.notIds.includes(row.id);
  };
  // What the SQL twin decides for one row: in the cohort window, not disposition, not a test phone / test order.
  const twin = (keys: string[], row: R) => {
    const parsed = parseCohortBucketParam(keys.join(","));
    if (!parsed.ok) throw new Error("bad keys");
    const b = cohortOrderBucket(row, ex.web_claimed.includes(row.id));
    const led = ex.ledger.find((e) => e.id === row.id)?.sale_at ?? null;
    const at = Date.parse(cohortOrderSaleAt(row, row.sold_at ? null : led)!);
    const inWin = at >= Date.parse(F) && at <= Date.parse(T);
    return b != null && parsed.values.includes(b) && inWin && row.sale_source_detail !== "disposition"
      && !isCohortExcludedPhone(row.customer_phone, ex.excluded_phone8s) && !ex.test_orders.includes(row.id);
  };
  const cases: R[] = [
    base,
    { ...base, id: "a0000000-0000-4000-8000-000000000002", customer_phone: "+38970123456" },          // test phone (text)
    { ...base, id: T1, customer_phone: "070 123 456" },                                                   // test phone (by id)
    { ...base, id: "a0000000-0000-4000-8000-000000000003", sale_source_detail: "disposition", price: 0 }, // never
    { ...base, id: "a0000000-0000-4000-8000-000000000004", sold_at: "2026-09-10T10:00:00Z" },          // outside the window
    { ...base, id: W1, status: "paid", mex_tracking_id: "NTMK1", mex_status_id: 2, mex_cod_mkd: 1990 }, // web claims its parcel
    { ...base, id: L1, sold_at: null, created_at: "2026-09-01T10:00:00Z" },                             // dated by the ledger
    { ...base, id: "a0000000-0000-4000-8000-000000000005", status: "trashed" },                          // trashed after the sale
  ];
  it("lists exactly what the cohort counts as orders, part by part", () => {
    for (const keys of [["total"], ["to_pack"], ["paid_unproven"], ["trashed_after_sale"], ["paid", "label"], [...COHORT_KEYS]]) {
      for (const c of cases) expect(listed(keys, c), `${keys} ${c.id} ${c.customer_phone}`).toBe(twin(keys, c));
    }
  });
  it("carries the universe, the test-phone text filter, the buckets and the window; test orders by id", () => {
    const f = cohortOrdersFilter(["paid"], ex, { fromIso: F, toEndIso: T });
    expect(f.or[0]).toBe(COHORT_UNIVERSE_OR);
    expect(f.or[1]).toBe(cohortExcludedPhoneOr(PH));
    expect(f.or).toHaveLength(4);
    expect(f.notIds).toEqual([T1]);
    expect(cohortOrdersFilter(["paid"], ex, null).or).toHaveLength(3);
    // an empty list (nothing excluded) adds no phone filter at all
    expect(cohortOrdersFilter(["paid"], { ...ex, excluded_phone8s: [] }, { fromIso: F, toEndIso: T }).or).toHaveLength(3);
  });
});

describe("cohort sale window twin", () => {
  const F = "2026-09-21T22:00:00.000Z", T = "2026-09-28T21:59:59.999999Z";
  const row = (o: Partial<CohortOrderRow> & { id: string }): CohortOrderRow & { id: string } => ({
    status: "confirmed", price: 10, sold_at: null, confirmed_at: null, created_at: "2026-09-01T10:00:00Z", paid_basis: null,
    source_type: null, sale_source_detail: null, mex_tracking_id: null, mex_status_id: null, mex_cod_mkd: null,
    mex_delivered_at: null, ...o,
  });
  const ledger = [{ id: L1, sale_at: "2026-09-23T10:00:00Z" }];
  const cases = [
    row({ id: "a0000000-0000-4000-8000-000000000001", sold_at: "2026-09-22T10:00:00Z" }),
    row({ id: "a0000000-0000-4000-8000-000000000002", sold_at: "2026-09-20T10:00:00Z", confirmed_at: "2026-09-23T10:00:00Z" }),
    row({ id: "a0000000-0000-4000-8000-000000000003", confirmed_at: "2026-09-24T10:00:00Z" }),
    row({ id: "a0000000-0000-4000-8000-000000000004", created_at: "2026-09-25T10:00:00Z" }),
    row({ id: "a0000000-0000-4000-8000-000000000005", confirmed_at: "2026-09-01T10:00:00Z", created_at: "2026-09-25T10:00:00Z" }),
    row({ id: L1, created_at: "2026-09-01T10:00:00Z" }),                        // dated by the ledger → in
    row({ id: L1, created_at: "2026-09-25T10:00:00Z", confirmed_at: null }),     // same order, ledger wins
  ];
  it("selects exactly the orders whose cohort sale day is in the window", () => {
    const f = cohortSaleWindowOrFilter(F, T, ledger);
    for (const c of cases) {
      const led = ledger.find((e) => e.id === c.id)?.sale_at ?? null;
      const at = cohortOrderSaleAt(c, c.sold_at ? null : led)!;
      const want = Date.parse(at) >= Date.parse(F) && Date.parse(at) <= Date.parse(T);
      expect(orMatches(f, c as unknown as Row)).toBe(want);
    }
  });
  it("a ledger date outside the window excludes the order even when created inside it", () => {
    const f = cohortSaleWindowOrFilter(F, T, [{ id: L1, sale_at: "2026-09-01T10:00:00Z" }]);
    expect(orMatches(f, cases[6] as unknown as Row)).toBe(false);
  });
  it("each ledger id appears once, however many there are (the URL budget)", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `b0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      sale_at: i % 2 ? "2026-09-23T10:00:00Z" : "2026-09-01T10:00:00Z",
    }));
    const f = cohortSaleWindowOrFilter(F, T, many);
    for (const e of many) expect(f.split(e.id).length - 1, e.id).toBe(1);
    const cf = cohortOrdersFilter([...COHORT_BUCKETS], { web_claimed: [W1], ledger: many, excluded_phone8s: PH, test_orders: [] }, { fromIso: F, toEndIso: T });
    expect(cohortFilterChars(cf)).toBeLessThan(COHORT_FILTER_MAX_CHARS);
    // …but a backlog the stamping cron has not dated is refused by the api, never sent as a broken URL
    const backlog = Array.from({ length: 200 }, (_, i) => ({ id: `c0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, sale_at: "2026-09-01T10:00:00Z" }));
    expect(cohortFilterChars(cohortOrdersFilter(["paid"], { web_claimed: [], ledger: backlog, excluded_phone8s: PH, test_orders: [] }, { fromIso: F, toEndIso: T })))
      .toBeGreaterThan(COHORT_FILTER_MAX_CHARS);
  });
});

describe("exceptions payload", () => {
  it("validates ids and phones and caps the lists", () => {
    expect(parseCohortExceptions({ web_claimed: [W1], ledger: [{ id: L1, sale_at: "2026-09-21T14:24:57+00:00" }], excluded_phone8s: PH, test_orders: [L1] }))
      .toEqual({ web_claimed: [W1], ledger: [{ id: L1, sale_at: "2026-09-21T14:24:57+00:00" }], excluded_phone8s: PH, test_orders: [L1] });
    // a body from before the test-phone rule: no phones, no test orders
    expect(parseCohortExceptions({ web_claimed: [], ledger: [] })).toEqual({ web_claimed: [], ledger: [], excluded_phone8s: [], test_orders: [] });
    expect(parseCohortExceptions({ web_claimed: ["x"], ledger: [] })).toBeNull();
    expect(parseCohortExceptions({ web_claimed: [], ledger: [], test_orders: ["x"] })).toBeNull();
    // a phone goes into the filter string: anything but 8 digits refuses the body
    expect(parseCohortExceptions({ web_claimed: [], ledger: [], excluded_phone8s: ["7012345"] })).toBeNull();
    expect(parseCohortExceptions({ web_claimed: [], ledger: [], excluded_phone8s: ["70123456),or(id.not.is.null"] })).toBeNull();
    expect(parseCohortExceptions({ web_claimed: [], ledger: [], excluded_phone8s: "70123456" })).toBeNull();
    expect(parseCohortExceptions({ web_claimed: [], ledger: [{ id: L1, sale_at: "nope" }] })).toBeNull();
    expect(parseCohortExceptions(null)).toBeNull();
    expect(parseCohortExceptions({ web_claimed: Array(301).fill(W1), ledger: [] })).toBeNull();
    expect(parseCohortExceptions({ web_claimed: Array(200).fill(W1), ledger: [], test_orders: Array(101).fill(L1) })).toBeNull();
  });
});

describe("the verify script translates the twin to SQL faithfully", () => {
  it("logic, operators, like and lists", () => {
    expect(pgrstTermToSql("status.eq.confirmed")).toBe("(o.status = 'confirmed')");
    expect(pgrstTermToSql("mex_status_id.not.in.(2,3)")).toBe("(NOT (o.mex_status_id::text IN ('2', '3')))");
    expect(pgrstTermToSql("customer_phone.not.like.*70123456")).toBe("(NOT (o.customer_phone LIKE '%70123456'))");
    expect(pgrstTermToSql("sold_at.is.null")).toBe("(o.sold_at IS NULL)");
    expect(pgrstOrToSql("price.gt.0,and(price.is.null,mex_cod_mkd.gte.1)"))
      .toBe("((o.price > '0') OR ((o.price IS NULL) AND (o.mex_cod_mkd >= '1')))");
  });
  it("translates every filter the api really sends, and refuses a column it does not know", () => {
    const f = cohortOrdersFilter([...COHORT_KEYS], { web_claimed: [W1], ledger: [{ id: L1, sale_at: "2026-09-23T10:00:00Z" }], excluded_phone8s: PH, test_orders: [] },
      { fromIso: "2026-09-21T22:00:00.000Z", toEndIso: "2026-09-28T21:59:59.999999Z" });
    for (const e of f.or) expect(() => pgrstOrToSql(e)).not.toThrow();
    expect(() => pgrstTermToSql("secret.eq.1")).toThrow(/not allowed/);
    expect(pgrstTermToSql("status.eq.it's")).toBe("(o.status = 'it''s')");
  });
});

// ── the six departments on /orders (migrations 20260942000500, 20260942001000) ─
/** cohort_order_source(sale_source, sale_source_detail, mex_tracking_id), verbatim. */
const sqlLike = (tr: string | null, s: string) => tr != null && new RegExp(`^...-${s}-`, "s").test(tr);
const sqlSource = (ss: string | null, d: string | null, tr: string | null = null): string => {
  const crm = (ss === "elyon_crm" && (d === "prediction_list" || d === "direct"))
    || ((ss === "altercpa" || ss === "affiliate") && d === "team_prediction");
  if (crm && ["9102", "9100", "9108", "1300"].some((s) => sqlLike(tr, s))) {
    return sqlLike(tr, "9102") ? "teleshop_out" : sqlLike(tr, "9100") ? "teleshop_other" : "social";
  }
  if (ss === "collabbox" && d === "teleshop_out") return "teleshop_out";
  if (ss === "elyon_crm" && d === "collabbox_out") return "teleshop_out";
  if ((ss === "altercpa" || ss === "affiliate") && d === "team_collabbox_out") return "teleshop_out";
  if ((ss === "altercpa" || ss === "affiliate") && (d === "team_prediction" || d === "team_collabbox_leads_out")) return "elyon_crm";
  if (ss === "altercpa" || ss === "affiliate") return "altercpa";
  if (ss === "elyon_crm") return "elyon_crm";
  if (ss === "web") return "web";
  if (ss === "collabbox" && (d === "social" || d === "1300")) return "social";
  return "teleshop_other";
};
const SALE_SOURCES_ALL = ["altercpa", "affiliate", "elyon_crm", "web", "collabbox", "legacy", null];
const DETAILS_ALL = ["social", "1300", "teleshop", "teleshop_out", "leads", "leads_out", "9225", "unknown", "bridge", "history",
  "partner", "prediction_list", "direct", "disposition", "collabbox_out", "collabbox_leads_out", "collabbox_leads",
  "team_prediction", "team_collabbox_out", "team_collabbox_leads_out", "monadon_legacy", null];
const TRACKINGS_ALL = [null, "002-9102-1/2026", "002-9100-1/2026", "002-9108-1/2026", "002-1300-1/2026", "002-9103-1/2026",
  "002-9110-1/2026", "001-9102-1/2026", "NTMK62463", "M1234567", "3040231", "12-9102-1", "002-91021-1/2026"];
const SOURCE_ROWS: Row[] = SALE_SOURCES_ALL.flatMap((ss) => DETAILS_ALL.flatMap((d) =>
  TRACKINGS_ALL.map((tr) => ({ sale_source: ss, sale_source_detail: d, mex_tracking_id: tr }))));
const srcOf = (r: Row) => sqlSource(r.sale_source as string | null, r.sale_source_detail as string | null, r.mex_tracking_id as string | null);

/** Migration 20260942001000's install check ($check$), row for row. */
const RULE_CASES: [string | null, string | null, string | null, string][] = [
  ["elyon_crm", "prediction_list", "002-9102-1/2026", "teleshop_out"],
  ["elyon_crm", "direct", "002-9102-1/2026", "teleshop_out"],
  ["elyon_crm", "direct", "002-9100-1/2026", "teleshop_other"],
  ["elyon_crm", "prediction_list", "002-9108-1/2026", "social"],
  ["elyon_crm", "prediction_list", "002-1300-1/2026", "social"],
  ["elyon_crm", "prediction_list", "002-9103-1/2026", "elyon_crm"],
  ["elyon_crm", "prediction_list", "002-9110-1/2026", "elyon_crm"],
  ["elyon_crm", "prediction_list", "NTMK62463", "elyon_crm"],
  ["elyon_crm", "prediction_list", null, "elyon_crm"],
  ["elyon_crm", "direct", null, "elyon_crm"],
  ["altercpa", "team_prediction", "002-9102-5/2026", "teleshop_out"],
  ["altercpa", "team_prediction", "002-9100-5/2026", "teleshop_other"],
  ["altercpa", "team_prediction", "002-9103-5/2026", "elyon_crm"],
  ["altercpa", "team_prediction", null, "elyon_crm"],
  ["elyon_crm", "collabbox_leads_out", "002-9102-1/2026", "elyon_crm"],
  ["elyon_crm", "collabbox_leads_out", null, "elyon_crm"],
  ["elyon_crm", "disposition", "002-9100-1/2026", "elyon_crm"],
  ["elyon_crm", null, null, "elyon_crm"],
  ["altercpa", "bridge", "002-9102-1/2026", "altercpa"],
  ["altercpa", "history", "002-9100-1/2026", "altercpa"],
  ["altercpa", "collabbox_leads", null, "altercpa"],
  ["altercpa", null, null, "altercpa"],
  ["affiliate", "partner", null, "altercpa"],
  ["altercpa", "team_collabbox_leads_out", "002-9103-1/2026", "elyon_crm"],
  ["collabbox", "teleshop_out", "002-9102-1/2026", "teleshop_out"],
  ["collabbox", "teleshop_out", null, "teleshop_out"],
  ["elyon_crm", "collabbox_out", "002-9102-1/2026", "teleshop_out"],
  ["elyon_crm", "collabbox_out", null, "teleshop_out"],
  ["altercpa", "team_collabbox_out", null, "teleshop_out"],
  ["collabbox", "teleshop", "002-9100-1/2026", "teleshop_other"],
  ["collabbox", "teleshop", "002-9102-1/2026", "teleshop_other"],
  ["collabbox", "leads", null, "teleshop_other"],
  ["collabbox", "leads_out", null, "teleshop_other"],
  ["collabbox", null, null, "teleshop_other"],
  ["collabbox", "social", "002-9108-1/2026", "social"],
  ["collabbox", "1300", null, "social"],
  ["legacy", "social", null, "teleshop_other"],
  ["legacy", "prediction_list", "002-9102-1/2026", "teleshop_other"],
  ["web", "opencart", null, "web"],
  ["web", "prediction_list", "002-9102-1/2026", "web"],
  [null, null, null, "teleshop_other"],
];

describe("cohort_source — the twin of cohort_order_source(sale_source, detail, mex_tracking_id)", () => {
  it("the agent-team override decides alone when set (20260942001800), whatever the stored source says", () => {
    const rows: Row[] = [
      { sale_source: "elyon_crm", sale_source_detail: "prediction_list", mex_tracking_id: "002-9103-1/2026", dept_override: "teleshop_out" },
      { sale_source: "elyon_crm", sale_source_detail: "direct", mex_tracking_id: null, dept_override: "teleshop_out" },
      { sale_source: "elyon_crm", sale_source_detail: "collabbox_leads_out", mex_tracking_id: "002-9103-1/2026", dept_override: "teleshop_out" },
      { sale_source: "elyon_crm", sale_source_detail: "prediction_list", mex_tracking_id: "002-9100-1/2026", dept_override: "teleshop_out" },
    ];
    for (const r of rows) {
      expect(INSIGHTS_SOURCES.filter((k) => orMatches(COHORT_SOURCE_TERM[k], r)), JSON.stringify(r)).toEqual(["teleshop_out"]);
    }
    // NULL override = THE mapping (an affiliate agent's CRM sale stays Affiliate – Lead out)
    expect(INSIGHTS_SOURCES.filter((k) => orMatches(COHORT_SOURCE_TERM[k],
      { sale_source: "elyon_crm", sale_source_detail: "prediction_list", mex_tracking_id: "002-9103-1/2026", dept_override: null }))).toEqual(["elyon_crm"]);
  });

  it("the migration's install table holds for the TS restatement", () => {
    for (const [ss, d, tr, want] of RULE_CASES) expect(sqlSource(ss, d, tr), `${ss}/${d}/${tr}`).toBe(want);
  });
  it("every (sale_source, detail, parcel) lands in exactly the department SQL gives it, NULLs included", () => {
    expect(SOURCE_ROWS.length).toBeGreaterThan(1500);
    for (const r of SOURCE_ROWS) {
      const hits = INSIGHTS_SOURCES.filter((k) => orMatches(COHORT_SOURCE_TERM[k], r));
      expect(hits, JSON.stringify(r)).toEqual([srcOf(r)]);
    }
  });
  it("a CRM-made sale follows its parcel's NATURA series; nothing else does", () => {
    const out = cohortSourceOrFilter(["teleshop_out"])!;
    const lead = cohortSourceOrFilter(["elyon_crm"])!;
    const row = (ss: string, d: string | null, tr: string | null) => ({ sale_source: ss, sale_source_detail: d, mex_tracking_id: tr });
    expect(orMatches(out, row("elyon_crm", "prediction_list", "002-9102-177628/2026"))).toBe(true);
    expect(orMatches(lead, row("elyon_crm", "prediction_list", "002-9102-177628/2026"))).toBe(false);
    expect(orMatches(lead, row("elyon_crm", "prediction_list", "002-9103-177243/2026"))).toBe(true);
    expect(orMatches(lead, row("elyon_crm", "prediction_list", null))).toBe(true);
    expect(orMatches(cohortSourceOrFilter(["social"])!, row("elyon_crm", "direct", "002-9108-3481/2026"))).toBe(true);
    expect(orMatches(cohortSourceOrFilter(["teleshop_other"])!, row("altercpa", "team_prediction", "002-9100-176395/2026"))).toBe(true);
    // not CRM-made: an AlterCPA lead / a LEADS-OUT document stays put whatever its parcel
    expect(orMatches(cohortSourceOrFilter(["altercpa"])!, row("altercpa", "bridge", "002-9102-1/2026"))).toBe(true);
    expect(orMatches(lead, row("elyon_crm", "collabbox_leads_out", "002-9102-1/2026"))).toBe(true);
    // Нарачка out by its folder, as stored before and after the reclass
    for (const r of [row("collabbox", "teleshop_out", null), row("elyon_crm", "collabbox_out", null), row("altercpa", "team_collabbox_out", null)]) {
      expect(orMatches(out, r), JSON.stringify(r)).toBe(true);
    }
    // only the MEX shape NNN-SSSS-… names a series (what LIKE '___-9102-%' reads; every live id has it)
    expect(orMatches(out, row("elyon_crm", "prediction_list", "12-9102-1"))).toBe(false);
    expect(orMatches(out, row("elyon_crm", "prediction_list", "002-91021-1/2026"))).toBe(false);
  });
  it("collabBox is four departments: Нарачка out, Lead in, Social media — by detail", () => {
    const f = cohortSourceOrFilter(["social"])!;
    expect(orMatches(f, { sale_source: "collabbox", sale_source_detail: "social" })).toBe(true);
    expect(orMatches(f, { sale_source: "collabbox", sale_source_detail: "1300" })).toBe(true);
    expect(orMatches(f, { sale_source: "collabbox", sale_source_detail: "teleshop" })).toBe(false);
    expect(orMatches(f, { sale_source: "legacy", sale_source_detail: "social" })).toBe(false);
    const t = cohortSourceOrFilter(["teleshop_other"])!;
    expect(orMatches(t, { sale_source: "collabbox", sale_source_detail: "teleshop" })).toBe(true);
    expect(orMatches(t, { sale_source: "collabbox", sale_source_detail: null })).toBe(true);
    expect(orMatches(t, { sale_source: "legacy", sale_source_detail: "monadon_legacy" })).toBe(true);
    expect(orMatches(t, { sale_source: null, sale_source_detail: null })).toBe(true);
    expect(orMatches(t, { sale_source: "collabbox", sale_source_detail: "social" })).toBe(false);
    expect(orMatches(t, { sale_source: "collabbox", sale_source_detail: "teleshop_out" })).toBe(false);
    expect(orMatches(t, { sale_source: "elyon_crm", sale_source_detail: "collabbox_out" })).toBe(false);
    expect(orMatches(cohortSourceOrFilter(["elyon_crm"])!, { sale_source: "elyon_crm", sale_source_detail: "collabbox_leads_out" })).toBe(true);
  });
  it("several keys = any of them; none or all six = no filter; unknown keys are refused", () => {
    for (const keys of [["social", "altercpa"], ["elyon_crm", "teleshop_out"], ["teleshop_out", "teleshop_other", "web"]]) {
      const f = cohortSourceOrFilter(keys)!;
      for (const r of SOURCE_ROWS) expect(orMatches(f, r), `${keys} ${JSON.stringify(r)}`).toBe(keys.includes(srcOf(r)));
    }
    expect(cohortSourceOrFilter([])).toBeNull();
    expect(cohortSourceOrFilter([...INSIGHTS_SOURCES])).toBeNull();
    expect(parseCohortSourceParam(null)).toEqual({ ok: true, values: [] });
    expect(parseCohortSourceParam("social,teleshop_other")).toEqual({ ok: true, values: ["social", "teleshop_other"] });
    expect(parseCohortSourceParam("teleshop_out")).toEqual({ ok: true, values: ["teleshop_out"] });
    expect(parseCohortSourceParam("collabbox")).toEqual({ ok: false, bad: "collabbox" });
  });
  it("the verify script translates it (the same SQL PostgREST runs), and the URL stays short", () => {
    for (const k of INSIGHTS_SOURCES) expect(() => pgrstOrToSql(cohortSourceOrFilter([k])!)).not.toThrow();
    expect(pgrstTermToSql("mex_tracking_id.like.___-9102-*")).toBe("(o.mex_tracking_id LIKE '___-9102-%')");
    expect(pgrstTermToSql("mex_tracking_id.not.like.___-9102-*")).toBe("(NOT (o.mex_tracking_id LIKE '___-9102-%'))");
    // the longest cohort_source a link can carry: five of the six departments
    for (const k of INSIGHTS_SOURCES) {
      const five = cohortSourceOrFilter(INSIGHTS_SOURCES.filter((x) => x !== k))!;
      expect(five.length, k).toBeLessThan(1800);
    }
  });
});

describe("access, sources, windows", () => {
  it("owners get money, admin/manager counts, others nothing", () => {
    expect(insightsAccess(true, false)).toBe("owner");
    expect(insightsAccess(true, true)).toBe("owner");
    expect(insightsAccess(false, true)).toBe("counts");
    expect(insightsAccess(false, false)).toBe("forbidden");
  });
  it("sources default to all six and reject unknown keys", () => {
    expect(parseSourcesParam(null)).toEqual({ ok: true, values: ["altercpa", "elyon_crm", "teleshop_out", "teleshop_other", "social", "web"] });
    expect(parseSourcesParam("teleshop_out")).toEqual({ ok: true, values: ["teleshop_out"] });
    expect(parseSourcesParam("social")).toEqual({ ok: true, values: ["social"] });
    expect(parseSourcesParam("web,altercpa")).toEqual({ ok: true, values: ["web", "altercpa"] });
    expect(parseSourcesParam("collabbox").ok).toBe(false);
  });
  it("windows are Skopje days (the Overview's helper)", () => {
    const w = insightsWindows("2026-09-22", "2026-09-28", true, new Date("2026-09-28T10:00:00Z"));
    if ("error" in w) throw new Error(w.error);
    expect(w.fromIso).toBe("2026-09-21T22:00:00.000Z");
    expect(w.toEndIso).toBe("2026-09-28T21:59:59.999999Z");
    expect(w.prev?.from).toBe("2026-09-15");
  });
});

// A payload shaped like insights_cohort's (owner view).
const cohort = () => ({
  meta: { from: "2026-09-22", to: "2026-09-28", prev_from: "2026-09-15", prev_to: "2026-09-21", money: true, clock: "sale",
          sources: ["altercpa"], granularity: "day", generated_at: "x" },
  total: { count: 10, value_mkd: 25000, cod_mkd: 20000, orders: 8, web: 1, mex_only: 1, drill: "/orders?cohort_bucket=total" },
  buckets: [{ key: "paid", count: 6, value_mkd: 15000, cod_mkd: 15000, orders: 5, web: 1, mex_only: 0, drill: "/orders?cohort_bucket=paid" }],
  outside: [{ key: "replacement", count: 1, value_mkd: 0, orders: 0, web: 0, mex_only: 1, drill: null }],
  by_source: [{ key: "altercpa", total: { count: 10, value_mkd: 25000 }, buckets: [], outside: [],
                splits: [{ key: "bridge", kind: "order", count: 8, value_mkd: 20000, drill: "/orders?x" }],
                leads_in: { came_in: 20, became_sales: 10, cancelled: 5, trashed: 2, open: 3, conversion: 0.5, other: 0, disposition: 0 } }],
  leads_in: { came_in: 20, became_sales: 10, cancelled: 5, trashed: 2, open: 3, conversion: 0.5, other: 0, disposition: 0 },
  cash_flow: { cod_mkd: 30000, card_mkd: 500, parcels: 12, card_orders: 1, from_this_period_mkd: 15500, from_earlier_mkd: 15000 },
  prev: { total: { count: 9, value_mkd: 1, cod_mkd: 1 }, buckets: [{ key: "paid", count: 5, value_mkd: 1, cod_mkd: 1 }] },
  spark: [{ d: "2026-09-22", count: 3, value_mkd: 9000 }],
  quality: [{ kind: "unproven_paid", count: 0, value_mkd: 0 }],
  some_future_money: { revenue: 5 },
});

function keysDeep(v: unknown, acc: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, acc));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.push(k); keysDeep(x, acc); }
  return acc;
}

describe("money strip", () => {
  it("the real payload: every non-money key the api sends survives, not one money key does", () => {
    const keysOf = (v: unknown, acc = new Set<string>()): Set<string> => {
      if (Array.isArray(v)) v.forEach((x) => keysOf(x, acc));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.add(k); keysOf(x, acc); }
      return acc;
    };
    const owner = keysOf(weekCohort);
    const stripped = keysOf(stripInsightsMoney(structuredClone(weekCohort) as Record<string, unknown>));
    const wantKept = [...owner].filter((k) => !/(_mkd|_eur)$/.test(k)).sort();
    expect([...stripped].sort()).toEqual(wantKept);
    for (const k of wantKept) expect(COHORT_NON_MONEY_KEYS.has(k), k).toBe(true);
  });
  it("non-owners: every *_mkd / *_eur key is absent (never 0), counts and drills stay", () => {
    const s = stripInsightsMoney(cohort());
    const keys = keysDeep(s);
    expect(keys.some((k) => /(_mkd|_eur)$/.test(k))).toBe(false);
    expect(keys).not.toContain("some_future_money");         // not whitelisted → dropped by default
    expect(s.meta).toMatchObject({ money: false, clock: "sale", from: "2026-09-22" });
    expect(s.total).toEqual({ count: 10, orders: 8, web: 1, mex_only: 1, drill: "/orders?cohort_bucket=total" });
    expect((s.cash_flow as Record<string, unknown>)).toEqual({ parcels: 12, card_orders: 1 });
    expect((s.spark as unknown[])[0]).toEqual({ d: "2026-09-22", count: 3 });
    expect(((s.by_source as Record<string, unknown>[])[0].splits as unknown[])[0]).toEqual({ key: "bridge", kind: "order", count: 8, drill: "/orders?x" });
  });
  it("a non-owner still learns how much of a number is collabBox bookings awaiting their parcel (20260942001900)", () => {
    const withBookings = {
      meta: {}, total: { count: 91, value_mkd: 210000, orders: 13, web: 0, mex_only: 0, booked: 78 },
      buckets: [{ key: "to_pack", count: 91, value_mkd: 210000, orders: 13, web: 0, mex_only: 0, booked: 78, drill: "/orders?cohort_bucket=to_pack" }],
      by_source: [{ key: "teleshop_out", total: { count: 91, booked: 78 },
        splits: [{ key: "booked", kind: "booking", count: 78, value_mkd: 174680, drill: null }] }],
    };
    const s = stripInsightsMoney(withBookings);
    expect(s.total).toEqual({ count: 91, orders: 13, web: 0, mex_only: 0, booked: 78 });
    expect((s.buckets as unknown[])[0]).toEqual({ key: "to_pack", count: 91, orders: 13, web: 0, mex_only: 0, booked: 78, drill: "/orders?cohort_bucket=to_pack" });
    expect(((s.by_source as Record<string, unknown>[])[0].splits as unknown[])[0]).toEqual({ key: "booked", kind: "booking", count: 78, drill: null });
  });
  it("a whitelisted name that looks like money is still dropped", () => {
    const s = stripInsightsMoney({ meta: {}, total: { count: 1, value_mkd: 5 } }, new Set(["total", "count", "value_mkd"]));
    expect(s).toEqual({ meta: { money: false }, total: { count: 1 } });
  });
  it("buildCohortResponse takes meta from the window and strips for non-owners", () => {
    const w = insightsWindows("2026-09-22", "2026-09-28", true, new Date("2026-09-28T10:00:00Z"));
    if ("error" in w) throw new Error(w.error);
    const now = new Date("2026-09-28T10:00:00Z");
    const owner = buildCohortResponse(cohort(), w, true, now);
    expect(owner.meta).toMatchObject({ from: "2026-09-22", to: "2026-09-28", prev_from: "2026-09-15", partial: true, money: true, clock: "sale" });
    expect((owner.total as Record<string, unknown>).value_mkd).toBe(25000);
    const counts = buildCohortResponse(cohort(), w, false, now);
    expect(counts.meta).toMatchObject({ money: false, days: 7 });
    expect(keysDeep(counts).some((k) => /(_mkd|_eur)$/.test(k))).toBe(false);
  });
});

describe("freshness overlay", () => {
  const fr = [{ feed: "altercpa", status: "ok" }, { feed: "collabbox", status: "stale", detail: "old" }];
  it("replaces the feed's entry", () => {
    const out = overlayFreshness(fr, { feed: "collabbox", status: "ok", detail: "new" }) as Record<string, unknown>[];
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ feed: "collabbox", status: "ok", detail: "new" });
    expect(fr[1].status).toBe("stale");                        // input untouched
  });
  it("appends when missing, ignores junk", () => {
    expect((overlayFreshness([fr[0]], { feed: "collabbox", status: "ok" }) as unknown[])).toHaveLength(2);
    expect(overlayFreshness(fr, null)).toBe(fr);
    expect(overlayFreshness(fr, { status: "ok" })).toBe(fr);
    expect(overlayFreshness(null, { feed: "collabbox" })).toBeNull();
  });
});
