/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON payloads read in assertions */
import { describe, expect, it } from "vitest";
import { buildMexCashResponse, MEX_CASH_NON_MONEY_KEYS, mexCashAccess } from "./insightsMexCash.ts";
import { insightsWindows, MONEY_KEY_RE } from "./insightsCommon.ts";
import type { InsightsWindow } from "./insightsCommon.ts";
// 16.09–02.10.2026 in the RPC's exact shape; every figure scaled (synthetic, not the books).
import sample from "../../../src/components/insights/mexcash/__fixtures__/mexcash.sample.json";

const NOW = new Date("2026-10-02T16:30:00Z");
const win = (from: string, to: string): InsightsWindow => {
  const w = insightsWindows(from, to, false, NOW);
  if ("error" in w) throw new Error(w.error);
  return w;
};
/** The RPC body: the fixture without the api's own meta fields. */
const rpc = () => {
  const b = structuredClone(sample) as Record<string, any>;
  const { today, accounts, data_through } = b.meta;
  b.meta = { today, accounts, data_through };
  return b;
};

/** Every key path (arrays collapsed), e.g. "days[].natura.cod_mkd". */
function keyPaths(v: unknown, at = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => keyPaths(x, `${at}[]`));
  if (v && typeof v === "object") {
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [`${at}.${k}`, ...keyPaths(x, `${at}.${k}`)]);
  }
  return [];
}
const moneyPath = (p: string) => p.split(/\.|\[\]/).some((seg) => MONEY_KEY_RE.test(seg));

describe("mexCashAccess", () => {
  it("a named viewer who is an owner → the page; any other owner, admin or manager → 403", () => {
    expect(mexCashAccess(true, true)).toBe("owner");
    expect(mexCashAccess(false, true)).toBe("forbidden");   // an owner / admin not on the list
    expect(mexCashAccess(true, false)).toBe("forbidden");   // on the list but no longer an owner
    expect(mexCashAccess(false, false)).toBe("forbidden");
  });
});

describe("buildMexCashResponse", () => {
  const w = win("2026-09-16", "2026-10-02");

  it("owner: the body as the RPC sent it, meta from the ONE Skopje window", () => {
    const out = buildMexCashResponse(rpc(), w, true, NOW) as Record<string, any>;
    expect(out.meta).toMatchObject({
      from: "2026-09-16", to: "2026-10-02", partial: true, days: 17, money: true,
      today: "2026-10-02", accounts: ["natura", "bio_natural"], generated_at: NOW.toISOString(),
    });
    expect(out.days).toHaveLength(17);
    expect(out.halves).toHaveLength(6);
    expect(out.total.natura.cod_mkd).toBe(sample.total.natura.cod_mkd);
  });

  it("the window's days add up to the total, per account", () => {
    for (const acc of ["natura", "bio_natural"] as const) {
      const sum = (k: "parcels" | "cod_mkd" | "returned") => sample.days.reduce((a, d) => a + d[acc][k], 0);
      // the fixture is scaled per figure, so the sums tie within rounding
      expect(Math.abs(sum("parcels") - sample.total[acc].parcels)).toBeLessThanOrEqual(sample.days.length);
      expect(Math.abs(sum("returned") - sample.total[acc].returned)).toBeLessThanOrEqual(sample.days.length);
    }
  });

  it("non-owner: the same page counted — no money key at any depth, counts kept", () => {
    const out = buildMexCashResponse(rpc(), w, false, NOW) as Record<string, any>;
    const paths = keyPaths(out);
    expect(paths.filter(moneyPath)).toEqual([]);
    expect(out.meta.money).toBe(false);
    expect(out.days[0].natura.parcels).toBe(sample.days[0].natura.parcels);
    expect(out.halves[0].complete).toBe(sample.halves[0].complete);
    expect(out.now.bio_natural.courier).toBe(sample.now.bio_natural.courier);
    // every surviving key is on the whitelist
    for (const p of paths) {
      const leaf = p.split(/\.|\[\]/).filter(Boolean).pop()!;
      expect(MEX_CASH_NON_MONEY_KEYS.has(leaf)).toBe(true);
    }
  });

  it("a key a later migration adds is dropped for a non-owner by default", () => {
    const body = rpc();
    body.payouts = [{ at: "2026-10-03", amount_mkd: 1 }];
    body.total.natura.fee_estimate = 5;
    const out = buildMexCashResponse(body, w, false, NOW) as Record<string, any>;
    expect(out.payouts).toBeUndefined();
    expect(out.total.natura.fee_estimate).toBeUndefined();
  });
});
