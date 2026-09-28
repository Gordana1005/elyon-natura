import { describe, expect, it } from "vitest";
import { buildListsResponse, LISTS_NON_MONEY_KEYS, LISTS_STALE_DAYS } from "./insightsLists.ts";
import { insightsWindows, MONEY_KEY_RE } from "./insightsCommon.ts";
import type { InsightsWindow } from "./insightsCommon.ts";
// The 01.09–27.09.2026 payload in insights_lists()' exact shape (owner view,
// people anonymised) — the same fixture the tab's tests render.
import sample from "../../../src/components/insights/lists/__fixtures__/lists.sample.json";

const NOW = new Date("2026-09-28T08:00:00Z");
const win = (from: string, to: string, compare = true): InsightsWindow => {
  const w = insightsWindows(from, to, compare, NOW);
  if ("error" in w) throw new Error(w.error);
  return w;
};
const rpc = () => {
  const { cash_flow: _c, ...body } = structuredClone(sample) as Record<string, unknown>;
  return body;
};
const CASH = { parcels: 450, from_earlier: 2, cod_mkd: 1255939, from_this_period_mkd: 1249939, from_earlier_mkd: 6000 };

/** Every key path (arrays collapsed), e.g. "lists[].agents[].sales". */
function keyPaths(v: unknown, at = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, `${at}[]`));
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [`${at}.${k}`, ...keyPaths(x, `${at}.${k}`)]);
  }
  return [];
}
const moneyPath = (p: string) => p.split(/\.|\[\]/).some((seg) => MONEY_KEY_RE.test(seg));

describe("buildListsResponse — owner", () => {
  it("takes meta from the window and keeps the RPC's own meta fields", () => {
    const w = win("2026-09-01", "2026-09-27");
    const b = buildListsResponse(rpc(), CASH, w, true, NOW) as any;
    expect(b.meta).toMatchObject({
      from: "2026-09-01", to: "2026-09-27", prev_from: "2026-08-05", prev_to: "2026-08-31",
      partial: false, days: 27, money: true, clock: "sale", has_prev: true,
      first_attr_day: "2026-08-14", granularity: "day", stale_days: 7,
    });
    expect(b.meta.generated_at).toBe(NOW.toISOString());
    expect(b.cash_flow).toEqual(CASH);
    expect(b.total.value_mkd).toBe(1929281);
  });

  it("drops the comparison when the RPC did (scan cap) or none was asked", () => {
    const noPrevRpc = { ...rpc(), meta: { ...(rpc().meta as object), has_prev: false } };
    const b = buildListsResponse(noPrevRpc, CASH, win("2026-09-01", "2026-09-27"), true, NOW) as any;
    expect(b.meta.has_prev).toBe(false);
    expect(b.meta.prev_from).toBeNull();
    expect(b.prev).toBeNull();
    const c = buildListsResponse(rpc(), CASH, win("2026-09-01", "2026-09-27", false), true, NOW) as any;
    expect(c.meta.prev_from).toBeNull();
    expect(c.prev).toBeNull();
  });

  it("a failed cash-flow line is null, never a made-up zero", () => {
    const b = buildListsResponse(rpc(), null, win("2026-09-01", "2026-09-27"), true, NOW) as any;
    expect(b.cash_flow).toBeNull();
    expect(buildListsResponse(rpc(), [] as any, win("2026-09-01", "2026-09-27"), true, NOW).cash_flow).toBeNull();
  });
});

describe("buildListsResponse — admin / manager (counts only)", () => {
  const w = win("2026-09-01", "2026-09-27");
  const owner = buildListsResponse(rpc(), CASH, w, true, NOW);
  const counts = buildListsResponse(rpc(), CASH, w, false, NOW) as any;

  it("carries no money key at any depth", () => {
    expect(keyPaths(counts).filter(moneyPath)).toEqual([]);
    expect(counts.meta.money).toBe(false);
  });

  it("keeps every non-money key the owner gets (the whitelist is complete)", () => {
    const ownerPaths = new Set(keyPaths(owner).filter((p) => !moneyPath(p)));
    const countPaths = new Set(keyPaths(counts));
    const missing = [...ownerPaths].filter((p) => !countPaths.has(p));
    expect(missing).toEqual([]);
  });

  it("keeps the counts that make the page", () => {
    expect(counts.total.count).toBe(686);
    expect(counts.total.worked).toBe(7000);
    expect(counts.lists.length).toBe((sample as any).lists.length);
    expect(counts.cash_flow).toEqual({ parcels: 450, from_earlier: 2 });
    expect(counts.agents[0]).toHaveProperty("sales");
    expect(counts.agents[0]).not.toHaveProperty("value_mkd");
  });

  it("drops a key a later migration adds until it is listed", () => {
    const withNew = { ...rpc(), secret_margin: 42, total: { ...(rpc().total as object), new_thing: 1 } };
    const b = buildListsResponse(withNew, CASH, w, false, NOW) as any;
    expect(b).not.toHaveProperty("secret_margin");
    expect(b.total).not.toHaveProperty("new_thing");
    expect(LISTS_NON_MONEY_KEYS.has("value_mkd")).toBe(false);
  });
});

describe("the fixture ties (the RPC's invariants)", () => {
  const s = sample as any;
  const sum = (a: any[], k: string) => a.reduce((n, x) => n + (x[k] ?? 0), 0);

  it("Σ lists + list not recorded = the total (count, value, cash)", () => {
    expect(sum(s.lists, "count") + s.not_recorded.count).toBe(s.total.count);
    expect(sum(s.lists, "value_mkd") + s.not_recorded.value_mkd).toBe(s.total.value_mkd);
    expect(sum(s.lists, "cash_mkd") + s.not_recorded.cash_mkd).toBe(s.total.cash_mkd);
    expect(sum(s.lists, "worked") + s.not_recorded.worked).toBe(s.total.worked);
  });

  it("Σ buckets = the total, and the slice = the ElyonCRM prediction_list split", () => {
    expect(sum(s.buckets, "count")).toBe(s.total.count);
    expect(sum(s.buckets, "value_mkd")).toBe(s.total.value_mkd);
    const split = s.elyon_crm.splits.find((x: any) => x.key === "prediction_list");
    expect(split.count).toBe(s.total.count);
    expect(split.value_mkd).toBe(s.total.value_mkd);
    expect(sum(s.elyon_crm.splits, "count")).toBe(s.elyon_crm.count);
  });

  it("every list's parts add up to its sales; worked = sale + no + trash", () => {
    for (const l of s.lists) {
      const inTotal = l.buckets.reduce((n: number, b: any) => n + b.count, 0);
      expect(inTotal).toBe(l.count);
      expect(l.worked_sale + l.worked_no + l.worked_trash).toBe(l.worked);
    }
  });

  it("stale means older than LISTS_STALE_DAYS Skopje days", () => {
    expect(LISTS_STALE_DAYS).toBe(7);
    expect(s.meta.stale_days).toBe(LISTS_STALE_DAYS);
  });
});
