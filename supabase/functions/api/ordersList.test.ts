import { describe, expect, it } from "vitest";
import {
  activeViewsByPhone, anyStatusDayOr, applyOps, baseOps, COUNTED_VIEWS, dayWindow, filterRecorder, isNarrowed,
  LEAD_STATUSES, MEX_GROUP_KEYS, mexGroupOf, mexGroupsOr, NOT_DISPOSITION, orderSpec, parseOrdersListParams,
  parsePhonesParam, parseSearch, phoneLast8, SALE_STATUSES, saleClockOr, searchOps, viewCounts, viewOps, viewStatuses,
  type Op, type OrdersListParams,
} from "./ordersList.ts";
import { COHORT_SOURCE_TERM } from "./insightsCommon.ts";

// ── a tiny evaluator: PostgREST logic terms + the builder ops we emit ────────
type Row = Record<string, unknown>;
type Pred = (row: Row) => boolean | null;

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
const cmp = (a: unknown, b: string) => {
  if (typeof a === "number") return a - Number(b);
  const x = Date.parse(String(a)), y = Date.parse(b);
  if (!Number.isNaN(x) && !Number.isNaN(y) && /\d{4}-\d{2}-\d{2}T/.test(b)) return x - y;
  return String(a) < b ? -1 : String(a) > b ? 1 : 0;
};
const likeRe = (pat: string, ci = false) =>
  new RegExp(`^${[...pat.replace(/\*/g, "%")].map((c) => (c === "%" ? ".*" : c === "_" ? "." : c.replace(/\W/g, "\\$&"))).join("")}$`, ci ? "is" : "s");
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
  const m = t.match(/^([a-z_]+)\.(not\.)?(eq|neq|gt|gte|lt|lte|is|in|like|ilike)\.(.*)$/s);
  if (!m) throw new Error("cannot parse " + t);
  const [, col, neg, op, val] = m;
  const list = op === "in" ? splitTop(val.replace(/^\(|\)$/g, "")) : [];
  return (row) => {
    const v = row[col];
    let r: boolean | null;
    if (op === "is") r = val === "null" ? v == null : String(v) === val;
    else if (v == null) r = null;
    else if (op === "in") r = list.some((x) => String(v) === x);
    else if (op === "like" || op === "ilike") r = likeRe(val, op === "ilike").test(String(v));
    else {
      const c = cmp(v, val);
      r = op === "eq" ? c === 0 : op === "neq" ? c !== 0 : op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0;
    }
    return neg ? (r === null ? null : !r) : r;
  };
}
const cache = new Map<string, Pred>();
const compiled = (term: string) => {
  let p = cache.get(term);
  if (!p) { p = compile(term); cache.set(term, p); }
  return p;
};
const opTerm = (o: Op) => {
  switch (o.m) {
    case "or": return `or(${o.v})`;
    case "not": return `${o.col}.not.${o.op}.${o.v}`;
    case "in": return `${o.col}.in.(${o.v.join(",")})`;
    default: return `${o.col}.${o.m}.${o.v}`;
  }
};
/** Does a row pass every op (ANDed, SQL three-valued → only TRUE passes)? */
function passes(ops: readonly Op[], row: Row): boolean {
  return ops.every((o) => compiled(opTerm(o))(row) === true);
}

const params = (qs: string): OrdersListParams => {
  const r = parseOrdersListParams(new URLSearchParams(qs));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

// ── fixtures ────────────────────────────────────────────────────────────────
const IN = "2026-09-28T10:00:00Z";        // inside 22.09–28.09 (Skopje)
const OUT = "2026-09-10T10:00:00Z";       // before it
const EDGE_IN = "2026-09-21T22:30:00Z";   // 22.09 00:30 Skopje — IN
const EDGE_OUT = "2026-09-21T21:30:00Z";  // 21.09 23:30 Skopje — OUT (a UTC day would take it)

function* grid(): Generator<Row> {
  let n = 0;
  const statuses = [...SALE_STATUSES, ...LEAD_STATUSES, "cancelled", "trashed"];
  for (const status of statuses)
  for (const created_at of [IN, OUT, EDGE_IN, EDGE_OUT])
  for (const sold_at of [null, IN, OUT])
  for (const confirmed_at of [null, IN, OUT, EDGE_OUT])
  for (const stamp of [null, IN, OUT, EDGE_IN])
  for (const sale_source_detail of [null, "disposition", "bridge"]) {
    yield {
      id: `o${n++}`, status, created_at, sold_at, confirmed_at,
      cancelled_at: status === "cancelled" ? (stamp ?? created_at) : null,
      trashed_at: status === "trashed" ? (stamp ?? created_at) : null,
      sale_source_detail,
    };
  }
}
const ROWS = [...grid()];

describe("parseOrdersListParams", () => {
  it("reads every list parameter and validates it", () => {
    const p = params("view=orders&day_from=2026-09-22&day_to=2026-09-28&dept=altercpa,social&seller=11111111-1111-4111-8111-111111111111"
      + "&mex=courier,no_parcel&source=manual&agent_id=none&search=070%20123%20456&status=confirmed,paid");
    expect(p).toEqual({
      view: "orders", statuses: ["confirmed", "paid"], dayFrom: "2026-09-22", dayTo: "2026-09-28",
      departments: ["altercpa", "social"], sellerId: "11111111-1111-4111-8111-111111111111",
      mexGroups: ["courier", "no_parcel"], sources: ["manual"], agent: { kind: "none" },
      search: { kind: "phone", last8: "70123456" },
    });
    expect(isNarrowed(p)).toBe(true);
    expect(isNarrowed(params(""))).toBe(false);
    expect(isNarrowed(params("view=all&status=all&agent_id=all&dept=all"))).toBe(false);
  });

  it("refuses what would silently widen or break the list", () => {
    for (const bad of [
      "view=sales", "status=shipped,lost", "day_from=2026-09-31", "day_from=28.09.2026", "day_from=2026-09-29&day_to=2026-09-28",
      "dept=collabbox", "seller=anna", "mex=packed", "source=opencart", "source=monadon_legacy", "agent_id=me",
    ]) {
      expect(parseOrdersListParams(new URLSearchParams(bad)).ok, bad).toBe(false);
    }
  });

  it("an agent uuid filters, none = unassigned", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(baseOps(params(`agent_id=${id}`))).toEqual([{ m: "eq", col: "assigned_agent_id", v: id }]);
    expect(baseOps(params("agent_id=none"))).toEqual([{ m: "is", col: "assigned_agent_id", v: null }]);
  });
});

describe("search — a phone matches by its last 8 digits", () => {
  it("detects a phone however it is typed", () => {
    for (const s of ["070 123 456", "070123456", "+389 70 123 456", "+38970123456", "(070) 123-456", "070/123.456", " 70123456 "]) {
      expect(phoneLast8(s), s).toBe("70123456");
    }
    for (const s of ["12345", "361499", "ORD-361499", "Марија 070", "7012345", "1234567890123456", ""]) {
      expect(phoneLast8(s), s).toBeNull();
    }
  });

  it("phone → suffix LIKE; tracking id → exact; the rest → the old substring search", () => {
    expect(parseSearch("070 123 456")).toEqual({ kind: "phone", last8: "70123456" });
    expect(searchOps(parseSearch("070 123 456"))).toEqual([{ m: "like", col: "customer_phone", v: "%70123456" }]);
    expect(parseSearch("002-9103-123456/2026")).toEqual({ kind: "tracking", id: "002-9103-123456/2026" });
    expect(searchOps(parseSearch("002-9103-123456/2026"))).toEqual([{ m: "eq", col: "mex_tracking_id", v: "002-9103-123456/2026" }]);
    expect(parseSearch("ORD-3614")).toEqual({ kind: "text", text: "ORD-3614" });
    expect(parseSearch("  ")).toBeNull();
    expect(parseSearch("%,()")).toBeNull();
    // the substring search keeps its four columns
    const [op] = searchOps(parseSearch("Марија"));
    expect(op).toEqual({ m: "or", v: "display_id.ilike.%Марија%,customer_name.ilike.%Марија%,customer_phone.ilike.%Марија%,product_name.ilike.%Марија%" });
  });

  it("the suffix finds the same customer stored with or without the country code, never a lookalike", () => {
    const ops = searchOps(parseSearch("070 123 456"));
    expect(passes(ops, { customer_phone: "+38970123456" })).toBe(true);
    expect(passes(ops, { customer_phone: "070123456" })).toBe(true);
    expect(passes(ops, { customer_phone: "+38970123457" })).toBe(false);
    expect(passes(ops, { customer_phone: "+389701234560" })).toBe(false); // contains it, does not END with it
  });
});

describe("views — the status chips", () => {
  it("Нарачки = real orders only, never a disposition record", () => {
    const ops = viewOps(params("view=orders"), "orders");
    expect(ops).toEqual([{ m: "in", col: "status", v: [...SALE_STATUSES] }, { m: "or", v: NOT_DISPOSITION }]);
    expect(passes(ops, { status: "paid", sale_source_detail: null })).toBe(true);
    expect(passes(ops, { status: "paid", sale_source_detail: "disposition" })).toBe(false);
    expect(passes(ops, { status: "cancelled", sale_source_detail: null })).toBe(false);
    expect(passes(ops, { status: "pending", sale_source_detail: null })).toBe(false);
  });

  it("open leads · cancelled · trashed · all", () => {
    expect(viewStatuses({ statuses: null }, "leads")).toEqual(["pending", "take", "call_again", "duplicated"]);
    expect(viewOps(params(""), "cancelled")).toEqual([{ m: "eq", col: "status", v: "cancelled" }]);
    expect(viewOps(params(""), "trashed")).toEqual([{ m: "eq", col: "status", v: "trashed" }]);
    expect(viewOps(params(""), "all")).toEqual([]);
    expect(viewOps(params(""), null)).toEqual([]);
  });

  it("a legacy ?status= still works alone, and narrows a view", () => {
    expect(viewOps(params("status=pending,take,call_again"), null)).toEqual([{ m: "in", col: "status", v: ["pending", "take", "call_again"] }]);
    expect(viewStatuses({ statuses: ["paid", "pending"] }, "orders")).toEqual(["paid"]);
    expect(viewStatuses({ statuses: ["pending"] }, "orders")).toEqual([]);
  });

  it("the four views partition every row; 'all' is their sum — with and without a window", () => {
    for (const qs of ["", "day_from=2026-09-22&day_to=2026-09-28", "day_from=2026-09-22", "day_to=2026-09-21"]) {
      const p = params(qs);
      const ops = Object.fromEntries([...COUNTED_VIEWS, "all" as const].map((v) => [v, viewOps(p, v)])) as Record<string, Op[]>;
      const counts = { orders: 0, leads: 0, cancelled: 0, trashed: 0 };
      let all = 0, dispositionSales = 0;
      for (const r of ROWS) {
        // every row is in at most one view …
        const hits = COUNTED_VIEWS.filter((v) => passes(ops[v], r));
        expect(hits.length, `${qs} ${JSON.stringify(r)}`).toBeLessThanOrEqual(1);
        for (const v of hits) counts[v]++;
        if (passes(ops.all, r)) {
          all++;
          // … and in exactly one when "all" takes it, unless it is a 0 ден disposition sale
          if (!hits.length) {
            expect(r.sale_source_detail, JSON.stringify(r)).toBe("disposition");
            dispositionSales++;
          }
        }
      }
      expect(viewCounts(counts).all, qs).toBe(all - dispositionSales);
      expect(counts.orders + counts.leads + counts.cancelled + counts.trashed, qs).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe("the day window is Skopje days, each row by its own clock", () => {
  const p = params("view=orders&day_from=2026-09-22&day_to=2026-09-28");

  it("uses Skopje midnight, not UTC midnight", () => {
    expect(dayWindow(p)).toEqual({ fromIso: "2026-09-21T22:00:00.000Z", toIso: "2026-09-28T21:59:59.999999Z" });
    // winter time: one hour
    expect(dayWindow({ dayFrom: "2026-12-01", dayTo: "2026-12-01" })).toEqual({ fromIso: "2026-11-30T23:00:00.000Z", toIso: "2026-12-01T22:59:59.999999Z" });
  });

  it("a sale is dated by sold_at → confirmed_at → created_at", () => {
    const ops = viewOps(p, "orders");
    const sale = (x: Row) => passes(ops, { status: "paid", sale_source_detail: null, ...x });
    expect(sale({ sold_at: IN, confirmed_at: OUT, created_at: OUT })).toBe(true);
    expect(sale({ sold_at: OUT, confirmed_at: IN, created_at: IN })).toBe(false);   // sold before the window
    expect(sale({ sold_at: null, confirmed_at: IN, created_at: OUT })).toBe(true);
    expect(sale({ sold_at: null, confirmed_at: null, created_at: EDGE_IN })).toBe(true);
    expect(sale({ sold_at: null, confirmed_at: null, created_at: EDGE_OUT })).toBe(false); // 23:30 Skopje the day before
    expect(saleClockOr("A", null)).toBe("and(sold_at.gte.A),and(sold_at.is.null,confirmed_at.gte.A),and(sold_at.is.null,confirmed_at.is.null,created_at.gte.A)");
  });

  it("a cancel by cancelled_at, a trash by trashed_at, a lead by created_at", () => {
    const q = params("day_from=2026-09-22&day_to=2026-09-28");
    expect(passes(viewOps(q, "cancelled"), { status: "cancelled", cancelled_at: IN, created_at: OUT })).toBe(true);
    expect(passes(viewOps(q, "cancelled"), { status: "cancelled", cancelled_at: OUT, created_at: IN })).toBe(false);
    expect(passes(viewOps(q, "trashed"), { status: "trashed", trashed_at: IN, created_at: OUT })).toBe(true);
    expect(passes(viewOps(q, "leads"), { status: "call_again", created_at: IN })).toBe(true);
    expect(passes(viewOps(q, "leads"), { status: "call_again", created_at: OUT })).toBe(false);
    // single-column windows are plain range filters (index-friendly), not an `or`
    expect(viewOps(q, "cancelled")).toEqual([
      { m: "eq", col: "status", v: "cancelled" },
      { m: "gte", col: "cancelled_at", v: "2026-09-21T22:00:00.000Z" },
      { m: "lte", col: "cancelled_at", v: "2026-09-28T21:59:59.999999Z" },
    ]);
    expect(anyStatusDayOr("A", "B").split("and(status.").length - 1).toBe(4);
  });

  it("sorts by the date it shows when a window is set", () => {
    expect(orderSpec(p, "orders")[0]).toEqual({ col: "sold_at", ascending: false, nullsFirst: false });
    expect(orderSpec(params("day_from=2026-09-22"), "cancelled")[0].col).toBe("cancelled_at");
    expect(orderSpec(params("day_from=2026-09-22"), "trashed")[0].col).toBe("trashed_at");
    expect(orderSpec(params(""), "orders")).toEqual([{ col: "created_at", ascending: false }]);
    expect(orderSpec(p, "all")).toEqual([{ col: "created_at", ascending: false }]);
  });
});

describe("department · seller · MEX · source", () => {
  it("department = the Insights twin of cohort_order_source", () => {
    const [op] = baseOps(params("dept=social"));
    expect(op).toEqual({ m: "or", v: expect.stringContaining("dept_override.in.(social)") });
    expect(passes([op], { dept_override: "social" })).toBe(true);
    expect(passes([op], { dept_override: null, sale_source: "collabbox", sale_source_detail: "social" })).toBe(true);
    expect(passes([op], { dept_override: null, sale_source: "altercpa", sale_source_detail: "bridge" })).toBe(false);
    expect(COHORT_SOURCE_TERM.social).toBeTruthy();
    expect(baseOps(params("dept=altercpa,elyon_crm,teleshop_out,teleshop_other,social,web,management"))).toEqual([]); // all seven = no filter
    // the six WITHOUT Менаџмент filter: a Менаџмент sale is left out (owner 02.10.2026, 20260947001000)
    const [six] = baseOps(params("dept=altercpa,elyon_crm,teleshop_out,teleshop_other,social,web"));
    expect(passes([six], { dept_override: "management", sale_source: "elyon_crm", sale_source_detail: "prediction_list" })).toBe(false);
    expect(passes([six], { dept_override: null, sale_source: "elyon_crm", sale_source_detail: "prediction_list" })).toBe(true);
  });
  it("dept=management = exactly dept_override 'management' (no folder maps there)", () => {
    expect(params("dept=management").departments).toEqual(["management"]);
    const ops = baseOps(params("dept=management"));
    expect(ops).toEqual([{ m: "or", v: "dept_override.in.(management)" }]);
    expect(passes(ops, { dept_override: "management", sale_source: "collabbox", sale_source_detail: "teleshop_out" })).toBe(true);
    expect(passes(ops, { dept_override: null, sale_source: "elyon_crm", sale_source_detail: "prediction_list" })).toBe(false);
    expect(passes(ops, { dept_override: "teleshop_out", sale_source: "elyon_crm", sale_source_detail: "prediction_list" })).toBe(false);
  });

  it("seller → sold_by_person_id; source → source_type", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    expect(baseOps(params(`seller=${id}`))).toEqual([{ m: "eq", col: "sold_by_person_id", v: id }]);
    expect(baseOps(params("source=altercpa"))).toEqual([{ m: "eq", col: "source_type", v: "altercpa" }]);
    expect(baseOps(params("source=import,manual"))).toEqual([{ m: "in", col: "source_type", v: ["import", "manual"] }]);
  });

  it("MEX groups", () => {
    expect(mexGroupsOr(["at_mex"])).toBe("mex_status_id.in.(8)");
    expect(mexGroupsOr(["courier", "rejected"])).toBe("mex_status_id.in.(1,3,4,9,10,13)");
    expect(mexGroupsOr(["delivered", "no_parcel"])).toBe("mex_status_id.in.(2),mex_tracking_id.is.null");
    expect(mexGroupsOr([...MEX_GROUP_KEYS])).toBeNull();
    expect(mexGroupsOr([])).toBeNull();
    const ops = baseOps(params("mex=courier"));
    expect(passes(ops, { mex_status_id: 10, mex_tracking_id: "002-9103-1/2026" })).toBe(true);
    expect(passes(ops, { mex_status_id: 2, mex_tracking_id: "002-9103-1/2026" })).toBe(false);
    expect(passes(ops, { mex_status_id: null, mex_tracking_id: null })).toBe(false);
    expect(mexGroupOf(8, "x")).toBe("at_mex");
    expect(mexGroupOf(3, "x")).toBe("courier");
    expect(mexGroupOf(13, "x")).toBe("rejected");
    expect(mexGroupOf(null, null)).toBe("no_parcel");
    expect(mexGroupOf(99, "x")).toBeNull();
  });
});

describe("the recorder replays exactly what it saw", () => {
  it("records builder calls and replays them in order", () => {
    const r = filterRecorder();
    r.in("status", ["paid"]).eq("assigned_agent_id", "a").or("x.eq.1").not("id", "in", "(1,2)").is("mex_status_id", null).gte("created_at", "A").lte("created_at", "B").like("customer_phone", "%1").ilike("product_name", "%x%");
    const calls: string[] = [];
    const fake: Record<string, (...a: unknown[]) => unknown> = {};
    for (const m of ["in", "eq", "or", "not", "is", "gte", "lte", "like", "ilike"]) fake[m] = (...a: unknown[]) => { calls.push(`${m}:${JSON.stringify(a)}`); return fake; };
    expect(applyOps(fake, r.ops)).toBe(fake);
    expect(calls).toEqual([
      'in:["status",["paid"]]', 'eq:["assigned_agent_id","a"]', 'or:["x.eq.1"]', 'not:["id","in","(1,2)"]',
      'is:["mex_status_id",null]', 'gte:["created_at","A"]', 'lte:["created_at","B"]', 'like:["customer_phone","%1"]', 'ilike:["product_name","%x%"]',
    ]);
  });
});

describe("who is viewing — one batched read, no write", () => {
  const now = new Date("2026-10-01T10:00:00Z");
  const row = (phone: string, agent: string, opened: string, expires: string) =>
    ({ agent_id: agent, agent_name: agent.toUpperCase(), customer_phone: phone, opened_at: opened, expires_at: expires });

  it("parses the phones to distinct last-8s, capped", () => {
    expect(parsePhonesParam("+38970123456,070123456,+38975111222, ,12")).toEqual(["70123456", "75111222"]);
    expect(parsePhonesParam(null)).toEqual([]);
    const many = Array.from({ length: 300 }, (_, i) => `+3897${String(i).padStart(7, "0")}`).join(",");
    expect(parsePhonesParam(many)).toHaveLength(200);
  });

  it("keeps live views only, newest per phone, matched by the last 8 digits", () => {
    const rows = [
      row("+38970123456", "a", "2026-10-01T09:58:00Z", "2026-10-01T10:01:00Z"),
      row("070123456", "b", "2026-10-01T09:59:00Z", "2026-10-01T10:01:30Z"),
      row("+38975111222", "c", "2026-10-01T09:50:00Z", "2026-10-01T09:59:00Z"), // expired
      row("+38971999888", "d", "2026-10-01T09:59:00Z", "2026-10-01T10:02:00Z"), // not asked for
    ];
    const got = activeViewsByPhone(rows, ["70123456", "75111222"], now);
    expect(Object.keys(got)).toEqual(["70123456"]);
    expect(got["70123456"].agent_id).toBe("b");
  });
});
