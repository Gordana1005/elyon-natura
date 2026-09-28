import { describe, expect, it } from "vitest";
import {
  AGENT_PERF_MONEY_KEYS, buildPeopleResponse, parsePersonParam, peopleAccess, PEOPLE_NON_MONEY_KEYS,
  stripAgentPerformance,
} from "./insightsPeople.ts";
import { insightsWindows } from "./insightsCommon.ts";
// insights_people()'s exact shape (owner view, 22–28.09.2026, names and ids anonymised).
import sample from "../../../src/components/insights/agents/__fixtures__/people.sample.json";

const NOW = new Date("2026-09-28T10:00:00Z");
const win = (() => {
  const w = insightsWindows("2026-09-22", "2026-09-28", true, NOW);
  if ("error" in w) throw new Error(w.error);
  return w;
})();
const rpc = () => structuredClone(sample) as unknown as Record<string, unknown>;

/** Every key at any depth. */
function keysDeep(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  }
  return out;
}

describe("peopleAccess", () => {
  it("owner beats every role; admin/manager count; the module alone = self", () => {
    expect(peopleAccess({ isOwner: true, isAdminOrManager: false, canViewTab: false })).toBe("owner");
    expect(peopleAccess({ isOwner: false, isAdminOrManager: true, canViewTab: true })).toBe("counts");
    expect(peopleAccess({ isOwner: false, isAdminOrManager: false, canViewTab: true })).toBe("self");
    expect(peopleAccess({ isOwner: false, isAdminOrManager: false, canViewTab: false })).toBe("forbidden");
  });
});

describe("parsePersonParam", () => {
  it("accepts a uuid, empty = none, anything else refused", () => {
    expect(parsePersonParam(null)).toEqual({ ok: true, value: null });
    expect(parsePersonParam("  ")).toEqual({ ok: true, value: null });
    expect(parsePersonParam("B90820E1-EE41-4BFC-93F6-898F8B73C2B6")).toEqual({ ok: true, value: "b90820e1-ee41-4bfc-93f6-898f8b73c2b6" });
    expect(parsePersonParam("1; drop table")).toEqual({ ok: false });
  });
});

describe("buildPeopleResponse", () => {
  it("owner: the RPC body with meta from the window and money", () => {
    const r = buildPeopleResponse(rpc(), win, "owner", null, NOW);
    const meta = r.meta as Record<string, unknown>;
    expect(meta).toMatchObject({ from: "2026-09-22", to: "2026-09-28", prev_from: "2026-09-15", prev_to: "2026-09-21", money: true, access: "owner", partial: true });
    expect((r.totals as Record<string, unknown>).value_mkd).toBeTypeOf("number");
    expect((r.people as unknown[]).length).toBe((sample as { people: unknown[] }).people.length);
  });

  it("admin/manager: the same payload with every money key ABSENT (whitelist)", () => {
    const r = buildPeopleResponse(rpc(), win, "counts", null, NOW);
    const keys = keysDeep(r);
    for (const k of keys) expect(k).not.toMatch(/(_mkd|_eur)$/);
    for (const k of keys) expect(PEOPLE_NON_MONEY_KEYS.has(k)).toBe(true);
    expect((r.meta as Record<string, unknown>).money).toBe(false);
    // the counts survive
    const t = r.totals as Record<string, unknown>;
    expect(t.sales).toBe((sample as { totals: { sales: number } }).totals.sales);
    expect(((r.people as Record<string, unknown>[])[0]).buckets).toBeTruthy();
    expect(((r.teams as Record<string, unknown>[])[0]).members).toBeTruthy();
  });

  it("the whitelist keeps every non-money key the SQL sends (a new key is a deliberate addition)", () => {
    const all = keysDeep(rpc());
    const missing = [...all].filter((k) => !/(_mkd|_eur)$/.test(k) && !PEOPLE_NON_MONEY_KEYS.has(k));
    expect(missing).toEqual([]);
  });

  it("self: only their own row and drill, no teams, no totals, no money", () => {
    const people = (sample as { people: { person_id: string }[] }).people;
    const me = people[3].person_id;
    const body = { ...rpc(), detail: { person_id: me, days: [{ d: "2026-09-22", sales: 1, value_mkd: 3000 }] } };
    const r = buildPeopleResponse(body, win, "self", me, NOW);
    expect(Object.keys(r).sort()).toEqual(["detail", "meta", "people"]);
    expect((r.people as { person_id: string }[]).map((p) => p.person_id)).toEqual([me]);
    for (const k of keysDeep(r)) expect(k).not.toMatch(/(_mkd|_eur)$/);
    expect((r.meta as Record<string, unknown>).access).toBe("self");
  });

  it("self without a sales person: an empty, flagged body", () => {
    const r = buildPeopleResponse(null, win, "self", null, NOW);
    expect(r.people).toEqual([]);
    expect((r.meta as Record<string, unknown>).self_unlinked).toBe(true);
  });
});

describe("stripAgentPerformance", () => {
  const rows = [
    { user_id: "a", full_name: "B", total_paid: 3, total_confirmed: 5, paid_revenue: 99, gross_revenue: 120, payout_earned: 12, avg_per_package: 20, packages_sold: 4 },
    { user_id: "b", full_name: "A", total_paid: 7, total_confirmed: 9, paid_revenue: 10, gross_revenue: 12, payout_earned: 30, avg_per_package: 22, packages_sold: 9 },
  ];
  it("admin/manager: no revenue, no payout; sorted by paid count", () => {
    const out = stripAgentPerformance(rows, { keepPayout: false });
    expect(out.map((r) => r.user_id)).toEqual(["b", "a"]);
    for (const r of out) {
      for (const k of AGENT_PERF_MONEY_KEYS) expect(r).not.toHaveProperty(k);
      expect(r).not.toHaveProperty("payout_earned");
      expect(r.packages_sold).toBeTypeOf("number");
    }
  });
  it("an agent keeps their own payout (as today), nothing else of money", () => {
    const out = stripAgentPerformance([rows[0]], { keepPayout: true });
    expect(out[0].payout_earned).toBe(12);
    expect(out[0]).not.toHaveProperty("paid_revenue");
    expect(out[0]).not.toHaveProperty("avg_per_package");
  });
});
