import { describe, expect, it } from "vitest";
import { buildSalesResponse, parseSalesPart, prevOf, SALES_NON_MONEY_KEYS } from "./insightsSales.ts";
import { insightsWindows, MONEY_KEY_RE } from "./insightsCommon.ts";
import type { InsightsWindow } from "./insightsCommon.ts";
// 01.09–27.09.2026 in insights_sales()' exact shape (owner view): the core and
// detail parts and the previous period's summary — the same fixtures the tab's
// tests render.
import core from "../../../src/components/insights/sales/__fixtures__/sales.core.sample.json";
import detail from "../../../src/components/insights/sales/__fixtures__/sales.detail.sample.json";
import prevSummary from "../../../src/components/insights/sales/__fixtures__/sales.prev.sample.json";

const NOW = new Date("2026-09-28T08:00:00Z");
const win = (from: string, to: string, compare = true): InsightsWindow => {
  const w = insightsWindows(from, to, compare, NOW);
  if ("error" in w) throw new Error(w.error);
  return w;
};
const clone = <T>(v: T): Record<string, unknown> => structuredClone(v) as unknown as Record<string, unknown>;
/** A loose read view of a JSON payload, for assertions only. */
type J = { [k: string]: J };
const j = (v: unknown) => v as J;

/** Every key path (arrays collapsed), e.g. "products.rows[].by_source[].units". */
function keyPaths(v: unknown, at = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, `${at}[]`));
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [`${at}.${k}`, ...keyPaths(x, `${at}.${k}`)]);
  }
  return [];
}
const moneyPath = (p: string) => p.split(/\.|\[\]/).some((seg) => MONEY_KEY_RE.test(seg));

describe("parseSalesPart", () => {
  it("defaults to core and accepts core | detail only", () => {
    expect(parseSalesPart(null)).toBe("core");
    expect(parseSalesPart("")).toBe("core");
    expect(parseSalesPart(" Detail ")).toBe("detail");
    expect(parseSalesPart("summary")).toBeNull();
    expect(parseSalesPart("products")).toBeNull();
  });
});

describe("prevOf", () => {
  it("keeps only total, buckets and by_source", () => {
    const p = prevOf({ ...clone(prevSummary), meta: { part: "summary" }, extra: 1 })!;
    expect(Object.keys(p).sort()).toEqual(["buckets", "by_source", "total"]);
    expect(j(p).total.count).toBe(j(prevSummary).total.count);
  });
  it("is null for a missing or malformed summary", () => {
    expect(prevOf(null)).toBeNull();
    expect(prevOf({ buckets: [] })).toBeNull();
    expect(prevOf("x")).toBeNull();
  });
});

describe("buildSalesResponse — owner", () => {
  it("core: meta from the window, the previous period attached", () => {
    const w = win("2026-09-01", "2026-09-27");
    const b = j(buildSalesResponse(clone(core), clone(prevSummary), w, true, "core", NOW));
    expect(b.meta).toMatchObject({
      from: "2026-09-01", to: "2026-09-27", prev_from: "2026-08-05", prev_to: "2026-08-31",
      partial: false, days: 27, money: true, clock: "sale", part: "core", granularity: "day",
    });
    expect(b.meta.generated_at).toBe(NOW.toISOString());
    expect(b.prev.total.count).toBe(j(prevSummary).total.count);
    expect(b.total).toEqual(j(core).total);
  });

  it("core without a comparison: prev null, no prev dates", () => {
    const b = j(buildSalesResponse(clone(core), clone(prevSummary), win("2026-09-01", "2026-09-27", false), true, "core", NOW));
    expect(b.prev).toBeNull();
    expect(b.meta.prev_from).toBeNull();
  });

  it("core with a failed previous summary: prev null, the rest intact", () => {
    const b = j(buildSalesResponse(clone(core), null, win("2026-09-01", "2026-09-27"), true, "core", NOW));
    expect(b.prev).toBeNull();
    expect(b.meta.prev_from).toBeNull();
    expect(b.buckets).toHaveLength(8);
  });

  it("detail: no prev key, the tables as sent", () => {
    const b = j(buildSalesResponse(clone(detail), clone(prevSummary), win("2026-09-01", "2026-09-27"), true, "detail", NOW));
    expect("prev" in b).toBe(false);
    expect(b.meta.part).toBe("detail");
    expect(b.products.rows.length).toBe(j(detail).products.rows.length);
  });

  it("a partial day reports the elapsed-time cut of the previous period", () => {
    const b = j(buildSalesResponse(clone(core), clone(prevSummary), win("2026-09-28", "2026-09-28"), true, "core", NOW));
    expect(b.meta.partial).toBe(true);
    expect(b.meta.prev_to_end).toBe("2026-09-27T08:00:00.000Z");
  });
});

describe("buildSalesResponse — non-owner (counts only)", () => {
  const w = win("2026-09-01", "2026-09-27");
  const bodies = {
    core: buildSalesResponse(clone(core), clone(prevSummary), w, false, "core", NOW),
    detail: buildSalesResponse(clone(detail), null, w, false, "detail", NOW),
  };

  it("carries no money key at any depth", () => {
    for (const b of Object.values(bodies)) {
      expect(keyPaths(b).filter(moneyPath)).toEqual([]);
      expect(j(b).meta.money).toBe(false);
    }
  });

  it("keeps every count the owner sees (the whitelist is complete)", () => {
    const sources = { core: clone(core), detail: clone(detail) };
    for (const part of ["core", "detail"] as const) {
      const owner = keyPaths(sources[part]).filter((p) => !moneyPath(p));
      const kept = new Set(keyPaths(bodies[part]));
      const lost = owner.filter((p) => !kept.has(p));
      expect(lost).toEqual([]);
    }
  });

  it("never lists a money key in the whitelist", () => {
    for (const k of SALES_NON_MONEY_KEYS) expect(MONEY_KEY_RE.test(k)).toBe(false);
  });

  it("a money field a later migration adds is dropped by default", () => {
    const c = clone(core);
    (c.total as Record<string, unknown>).margin_share = 0.4;
    const b = j(buildSalesResponse(c, null, w, false, "core", NOW));
    expect(b.total.margin_share).toBeUndefined();
    expect(b.total.count).toBe(j(core).total.count);
  });
});
