/**
 * Resumable sweeps (2026-09-28): chunking, cursor and budget.
 *
 * Until 28.09 the nightly (7 d) and weekly (90 d) sweeps worked their whole
 * window in one invocation at ~88 ms per lead and were killed by the edge wall
 * clock (~150 s) every time. runSweep is driven here against a fake AlterCPA +
 * database with a fake clock: the properties that matter are that every sweep
 * finishes across invocations, that no lead is ever skipped (at a chunk edge,
 * a budget cut or a crash), that the cursor only moves forward, and that no
 * invocation starts work after its budget.
 *
 * sweep.ts is dependency-free, so Node runs it as-is. index.ts and the
 * migration are only read as text.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SWEEP_BUDGET_MS, SWEEP_CHUNK_SEC, SWEEP_DAYS, SWEEP_LEASE_SEC, SWEEP_MIN_CHUNK_MS, SWEEP_PAGE,
  Span, SweepIo, SweepRun, SweepStatus,
  cursorAfter, eachLimit, isSweepRequest, leadTime, nextChunk, orderForCursor, runSweep, sweepWindow,
} from "./sweep.ts";

const DAY = 86_400;
const NOW = 1_758_000_000;                 // 2025-09-16, a fixed "now" in epoch seconds
const iso = (sec: number) => new Date(sec * 1000).toISOString();

interface Lead { id: number | string; time?: number; v?: string }

/** Their book: `perDay` leads a day for `days` days from `from`, ids rising with time. */
function book(from: number, days: number, perDay: number, firstId = 1_000_000): Lead[] {
  const out: Lead[] = [];
  let id = firstId;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) out.push({ id: id++, time: from + d * DAY + Math.floor((i * DAY) / perDay) });
  }
  return out;
}

/**
 * A fake AlterCPA + database. fetch returns their records created in
 * [from, to] — in THEIR order (newest first), never ours; processPage "writes"
 * leads at `cost.lead` ms of fake time and stops at the deadline; advance is
 * altercpa_sweep_advance: forward only, done past window_to, lost once fenced.
 */
class Fake {
  clock = 0;
  cursor: number;
  status: SweepStatus = "open";
  writes = new Map<string, number>();       // lead id → times written
  fetches: Span[] = [];
  advances: number[] = [];
  pages: Lead[][] = [];
  failPage = -1;                            // this processPage call throws halfway (once)
  loseLeaseAfter = Infinity;                // advances accepted before the lease is gone
  pageCalls = 0;
  lateStarts = 0;                           // pages begun at/after the deadline (each costs 3 reads)

  constructor(
    public leads: Lead[],
    public windowFrom: number,
    public windowTo: number,
    public cost: { lead: number; fetch: number; advance?: number },
  ) {
    this.cursor = windowFrom;
  }

  io(): SweepIo<Lead> {
    return {
      now: () => this.clock,
      fetch: async (c) => {
        this.clock += this.cost.fetch;
        this.fetches.push(c);
        return this.leads.filter((l) => l.time != null && l.time >= c.from && l.time <= c.to).reverse();
      },
      processPage: async (page, deadlineMs) => {
        const call = this.pageCalls++;
        if (this.clock >= deadlineMs) this.lateStarts++;
        this.pages.push(page);
        let n = 0;
        for (const l of page) {
          if (this.clock >= deadlineMs) break;
          if (call === this.failPage && n === Math.floor(page.length / 2)) {
            this.failPage = -1;
            throw new Error("sweep ledger read: upstream 502");
          }
          this.clock += this.cost.lead;
          this.writes.set(String(l.id), (this.writes.get(String(l.id)) ?? 0) + 1);
          n++;
        }
        return n;
      },
      advance: async (cursor) => {
        this.clock += this.cost.advance ?? 0;
        if (this.advances.length >= this.loseLeaseAfter || this.status !== "open") return "lost";
        this.advances.push(cursor);
        this.cursor = Math.max(this.cursor, cursor);
        if (this.cursor > this.windowTo) this.status = "done";
        return this.status;
      },
    };
  }

  /** One invocation, as the edge function runs it: a fresh 100 s budget. */
  async invoke(): Promise<{ run?: SweepRun; error?: string; elapsed: number }> {
    const started = this.clock;
    try {
      const run = await runSweep(this.io(), { cursor: this.cursor, windowTo: this.windowTo }, started + SWEEP_BUDGET_MS);
      return { run, elapsed: this.clock - started };
    } catch (e) {
      return { error: (e as Error).message, elapsed: this.clock - started };
    }
  }

  /** The altercpa-sync-continue cron: invoke until the sweep is no longer open. */
  async untilClosed(max = 500) {
    const out: Array<{ run?: SweepRun; error?: string; elapsed: number }> = [];
    while (this.status === "open" && out.length < max) out.push(await this.invoke());
    return out;
  }
}

/** Every lead of the window written at least once; nothing outside it. */
function expectComplete(f: Fake) {
  const inWindow = f.leads.filter((l) => l.time != null && l.time >= f.windowFrom && l.time <= f.windowTo);
  const missing = inWindow.filter((l) => !f.writes.has(String(l.id))).map((l) => l.id);
  expect(missing).toEqual([]);
  const outside = f.leads.filter((l) => !(l.time != null && l.time >= f.windowFrom && l.time <= f.windowTo));
  expect(outside.filter((l) => f.writes.has(String(l.id)))).toEqual([]);
  expect(f.status).toBe("done");
}

/** The cursor persisted by every advance only ever moves forward. */
function expectForwardOnly(f: Fake) {
  for (let i = 1; i < f.advances.length; i++) expect(f.advances[i]).toBeGreaterThan(f.advances[i - 1]);
}

describe("the plan", () => {
  it("keeps the windows the one-shot sweeps had: nightly 7 days, weekly 90", () => {
    expect(SWEEP_DAYS).toEqual({ nightly: 7, weekly: 90 });
  });

  it("chunks by day, stops new work at 100 s, leases longer than an invocation can live", () => {
    expect(SWEEP_CHUNK_SEC).toBe(DAY);
    expect(SWEEP_BUDGET_MS).toBe(100_000);
    expect(SWEEP_PAGE).toBe(100);
    expect(SWEEP_MIN_CHUNK_MS).toBeLessThan(SWEEP_BUDGET_MS);
    // The edge wall clock kills at ~150 s; the lease must outlive any slice.
    expect(SWEEP_LEASE_SEC * 1000).toBeGreaterThan(150_000);
  });

  it("only nightly/weekly writes and 'continue' take the sweep path", () => {
    for (const k of ["nightly", "weekly", "continue"]) expect(isSweepRequest(k, false)).toBe(true);
    // A dry nightly/weekly stays the one-shot preview; everything else is untouched.
    for (const k of ["nightly", "weekly"]) expect(isSweepRequest(k, true)).toBe(false);
    for (const k of ["rolling", "status", "backfill", "manual", ""]) {
      expect(isSweepRequest(k, false)).toBe(false);
      expect(isSweepRequest(k, true)).toBe(false);
    }
  });
});

describe("sweepWindow — a new sweep's window, as the one-shot sweep computed it", () => {
  it("is [now − 7 d, now] for a nightly and [now − 90 d, now] for a weekly", () => {
    expect(sweepWindow("nightly", NOW)).toEqual({ from: NOW - 7 * DAY, to: NOW });
    expect(sweepWindow("weekly", NOW)).toEqual({ from: NOW - 90 * DAY, to: NOW });
  });

  it("takes an admin's explicit from/to", () => {
    expect(sweepWindow("nightly", NOW, { from: NOW - 3 * DAY, to: NOW - DAY })).toEqual({ from: NOW - 3 * DAY, to: NOW - DAY });
  });

  it("never reaches before the account's sync_from", () => {
    const syncFrom = iso(NOW - 30 * DAY).slice(0, 10);
    const floor = Math.floor(new Date(syncFrom).getTime() / 1000);
    expect(sweepWindow("weekly", NOW, { syncFrom })).toEqual({ from: floor, to: NOW });
    expect(sweepWindow("nightly", NOW, { syncFrom })).toEqual({ from: NOW - 7 * DAY, to: NOW });
  });

  it("refuses an empty window and a kind that is not a sweep", () => {
    expect(() => sweepWindow("nightly", NOW, { syncFrom: iso(NOW + DAY).slice(0, 10) })).toThrow(/empty window/);
    expect(() => sweepWindow("nightly", NOW, { from: NOW, to: NOW })).toThrow(/empty window/);
    for (const k of ["rolling", "status", "backfill", "manual", "continue"]) {
      expect(() => sweepWindow(k, NOW)).toThrow(/not a sweep/);
    }
  });
});

describe("nextChunk — one API window per day", () => {
  it("walks the window in contiguous, non-overlapping inclusive days", () => {
    const from = NOW - 7 * DAY, to = NOW;
    const chunks: Span[] = [];
    for (let c = nextChunk(from, to); c; c = nextChunk(c.to + 1, to)) chunks.push(c);
    expect(chunks).toHaveLength(8);                        // 7 whole days + the closing second
    expect(chunks[0]).toEqual({ from, to: from + DAY - 1 });
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].from).toBe(chunks[i - 1].to + 1);
    expect(chunks[chunks.length - 1]).toEqual({ from: to, to });
  });

  it("clips the last chunk and returns null once past the end", () => {
    expect(nextChunk(NOW - 3600, NOW)).toEqual({ from: NOW - 3600, to: NOW });
    expect(nextChunk(NOW, NOW)).toEqual({ from: NOW, to: NOW });
    expect(nextChunk(NOW + 1, NOW)).toBeNull();
    expect(nextChunk(Number.NaN, NOW)).toBeNull();
  });
});

describe("orderForCursor / cursorAfter", () => {
  it("sorts by (time, id), numeric ids numerically, records without a time first — without touching the input", () => {
    const rows: Lead[] = [{ id: 30, time: 5 }, { id: 9, time: 5 }, { id: 100, time: 3 }, { id: 7 }, { id: "x", time: 5 }];
    const copy = JSON.parse(JSON.stringify(rows));
    expect(orderForCursor(rows).map((r) => r.id)).toEqual([7, 100, 9, 30, "x"]);
    expect(rows).toEqual(copy);
  });

  it("keeps one record per id — the last one read", () => {
    const rows: Lead[] = [{ id: 1, time: 5, v: "old" }, { id: 2, time: 6 }, { id: 1, time: 5, v: "new" }];
    const out = orderForCursor(rows);
    expect(out.map((r) => r.id)).toEqual([1, 2]);
    expect(out[0].v).toBe("new");
  });

  it("reads the creation second defensively", () => {
    expect(leadTime({ id: 1, time: 1_758_000_000 })).toBe(1_758_000_000);
    expect(leadTime({ id: 1, time: 1_758_000_000.9 })).toBe(1_758_000_000);
    for (const time of [undefined, 0, -5, Number.NaN]) expect(leadTime({ id: 1, time })).toBeNull();
  });

  const chunk = { from: 100, to: 199 };
  const sorted = orderForCursor<Lead>([{ id: 1, time: 110 }, { id: 2, time: 120 }, { id: 3, time: 120 }, { id: 4, time: 150 }]);

  it("puts the cursor past the chunk when every lead is written", () => {
    expect(cursorAfter(sorted, 4, chunk)).toBe(200);
    expect(cursorAfter([], 0, chunk)).toBe(200);
  });

  it("puts it on the first UNWRITTEN lead's second otherwise — never past it", () => {
    expect(cursorAfter(sorted, 0, chunk)).toBe(110);
    expect(cursorAfter(sorted, 1, chunk)).toBe(120);
    // Lead 2 (second 120) is written, lead 3 (also 120) is not: the cursor stays
    // ON 120, so lead 2 is re-read next time — never lead 3 skipped.
    expect(cursorAfter(sorted, 2, chunk)).toBe(120);
    expect(cursorAfter(sorted, 3, chunk)).toBe(150);
  });

  it("stays inside [chunk.from, chunk.to + 1] whatever the API returned", () => {
    expect(cursorAfter<Lead>([{ id: 1, time: 50 }], 0, chunk)).toBe(100);
    expect(cursorAfter<Lead>([{ id: 1, time: 900 }], 0, chunk)).toBe(200);
    expect(cursorAfter<Lead>([{ id: 1 }], 0, chunk)).toBe(100);
  });
});

describe("runSweep — every sweep finishes, nothing is skipped", () => {
  it("the measured load (88 ms a lead, 0.5 s a call) finishes across several bounded invocations", async () => {
    // 8.400 leads in 7 days = ~740 s of work: the one-shot sweep died at the
    // ~150 s wall clock every night. Resumable, it just takes more slices.
    const f = new Fake(book(NOW - 7 * DAY, 7, 1200), NOW - 7 * DAY, NOW, { lead: 88, fetch: 500, advance: 30 });
    const runs = await f.untilClosed();
    expectComplete(f);
    expectForwardOnly(f);
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.length).toBeLessThanOrEqual(10);
    for (const r of runs) {
      expect(r.error).toBeUndefined();
      // Never starts work after the budget: at most one lead + one checkpoint over it.
      expect(r.elapsed).toBeLessThanOrEqual(SWEEP_BUDGET_MS + 88 + 30);
    }
    expect(f.lateStarts).toBe(0);
    expect(runs.slice(0, -1).every((r) => r.run?.status === "open" && r.run.budgetExhausted)).toBe(true);
    expect(runs[runs.length - 1].run?.status).toBe("done");
    expect([...f.writes.values()].every((n) => n === 1)).toBe(true);      // no ties, no crash: once each
  });

  it("with the page-batched reads the same nightly fits one invocation", async () => {
    const f = new Fake(book(NOW - 7 * DAY, 7, 1200), NOW - 7 * DAY, NOW, { lead: 3, fetch: 500, advance: 30 });
    const runs = await f.untilClosed();
    expectComplete(f);
    expect(runs).toHaveLength(1);
    expect(runs[0].run).toMatchObject({ status: "done", chunks: 8, fetched: 8400, written: 8400, budgetExhausted: false });
  });

  it("a 90-day weekly finishes too — even at the unbatched 88 ms a lead", async () => {
    for (const lead of [3, 88]) {
      const f = new Fake(book(NOW - 90 * DAY, 90, 500), NOW - 90 * DAY, NOW, { lead, fetch: 500, advance: 30 });
      const runs = await f.untilClosed();
      expectComplete(f);
      expectForwardOnly(f);
      for (const r of runs) expect(r.elapsed).toBeLessThanOrEqual(SWEEP_BUDGET_MS + lead + 30);
      if (lead === 3) expect(runs.length).toBeLessThanOrEqual(3);
    }
  });

  it("a crashed slice is retried from the last checkpoint: at most one page is written twice", async () => {
    const f = new Fake(book(NOW - 7 * DAY, 7, 1200), NOW - 7 * DAY, NOW, { lead: 3, fetch: 500 });
    f.failPage = 25;                                        // mid-way through day 3
    const runs = await f.untilClosed();
    expect(runs[0].error).toMatch(/upstream 502/);
    expect(runs.slice(1).every((r) => !r.error)).toBe(true);
    expectComplete(f);
    expectForwardOnly(f);
    const twice = [...f.writes.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    expect(twice.length).toBeGreaterThan(0);                // the crashed page's first half
    expect(twice.length).toBeLessThanOrEqual(SWEEP_PAGE);
    expect(twice.every((id) => f.pages[25].some((l) => String(l.id) === id))).toBe(true);
  });

  it("a slice that loses its lease stops at once — no further fetch, write or advance", async () => {
    const f = new Fake(book(NOW - 7 * DAY, 7, 1200), NOW - 7 * DAY, NOW, { lead: 3, fetch: 500 });
    f.loseLeaseAfter = 1;
    const { run } = await f.invoke();
    expect(run?.status).toBe("lost");
    expect(f.fetches).toHaveLength(1);
    expect(f.pageCalls).toBe(2);
    expect(f.advances).toHaveLength(1);
    expect(run?.cursor).toBe(f.advances[0]);               // what was persisted, not what was tried
  });

  it("leads on a chunk's last second and the next chunk's first are each written once", async () => {
    const from = NOW - 2 * DAY;
    const leads: Lead[] = [
      { id: 1, time: from }, { id: 2, time: from + DAY - 1 }, { id: 3, time: from + DAY }, { id: 4, time: NOW },
      { id: 5, time: from - 1 }, { id: 6, time: NOW + 1 },   // outside: never fetched
    ];
    const f = new Fake(leads, from, NOW, { lead: 1, fetch: 1 });
    await f.untilClosed();
    expectComplete(f);
    expect([...f.writes.values()].every((n) => n === 1)).toBe(true);
    expect(f.fetches.map((c) => [c.from - from, c.to - from])).toEqual([[0, DAY - 1], [DAY, 2 * DAY - 1], [2 * DAY, 2 * DAY]]);
  });

  it("a budget cut inside one second's leads re-writes that second's written ones, skips none", async () => {
    // 100 leads a second apart, then 150 on ONE second; 500 ms a lead = 200 per slice.
    const from = NOW - DAY;
    const s = from + 3600;
    const leads: Lead[] = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: i + 1, time: s - 100 + i })),
      ...Array.from({ length: 150 }, (_, i) => ({ id: 1000 + i, time: s })),
    ];
    const f = new Fake(leads, from, NOW, { lead: 500, fetch: 0 });
    const runs = await f.untilClosed();
    expect(runs).toHaveLength(2);
    expectComplete(f);
    expect(f.advances[0]).toBe(s);                          // checkpoint ON the shared second
    const tie = (id: number) => f.writes.get(String(id));
    expect(Array.from({ length: 100 }, (_, i) => tie(1000 + i))).toEqual(Array(100).fill(2));
    expect(Array.from({ length: 50 }, (_, i) => tie(1100 + i))).toEqual(Array(50).fill(1));
    expect(Array.from({ length: 100 }, (_, i) => tie(i + 1))).toEqual(Array(100).fill(1));
  });

  it("empty days still move the cursor, one checkpoint a day", async () => {
    const f = new Fake([], NOW - 7 * DAY, NOW, { lead: 1, fetch: 10 });
    const runs = await f.untilClosed();
    expect(runs).toHaveLength(1);
    expect(f.status).toBe("done");
    expect(f.fetches).toHaveLength(8);
    expect(f.advances).toHaveLength(8);
    expect(f.advances[f.advances.length - 1]).toBe(NOW + 1);
  });

  it("a cursor already past the end only records the sweep done", async () => {
    const f = new Fake(book(NOW - 7 * DAY, 7, 10), NOW - 7 * DAY, NOW, { lead: 1, fetch: 1 });
    f.cursor = NOW + 1;
    const { run } = await f.invoke();
    expect(run).toMatchObject({ status: "done", chunks: 0, fetched: 0, written: 0 });
    expect(f.fetches).toEqual([]);
    expect(f.advances).toEqual([NOW + 1]);
  });

  it("never begins a page at or after the deadline (a page costs three reads before its first lead)", async () => {
    // 1 s a lead × 100 a page = the whole budget: page 1 ends exactly on it.
    const f = new Fake(book(NOW - DAY, 1, 1000), NOW - DAY, NOW, { lead: 1000, fetch: 0 });
    const runs = await f.untilClosed();
    expectComplete(f);
    expect(f.lateStarts).toBe(0);
    expect(runs[0].run).toMatchObject({ status: "open", written: 100, budgetExhausted: true });
    expect(f.pageCalls).toBe(10);
  });

  it("does not start a day with less than the minimum left", async () => {
    const f = new Fake(book(NOW - 7 * DAY, 7, 10), NOW - 7 * DAY, NOW, { lead: 1, fetch: 1 });
    const run = await runSweep(f.io(), { cursor: f.cursor, windowTo: f.windowTo }, f.clock + SWEEP_MIN_CHUNK_MS - 1);
    expect(run).toMatchObject({ status: "open", chunks: 0, budgetExhausted: true });
    expect(f.fetches).toEqual([]);
    expect(f.advances).toEqual([]);
  });

  it("writes each chunk in (time, id) order, once per id, whatever order the API used", async () => {
    const from = NOW - DAY;
    // The fake answers newest-first, so the API reads the "again" copy LAST.
    const leads: Lead[] = [
      { id: 3, time: from + 10, v: "again" },
      { id: 5, time: from + 10 }, { id: 3, time: from + 10 }, { id: 9, time: from + 5 },
    ];
    const f = new Fake(leads, from, NOW, { lead: 1, fetch: 1 });
    await f.untilClosed();
    expect(f.pages.flat().map((l) => l.id)).toEqual([9, 3, 5]);
    expect(f.pages.flat().find((l) => l.id === 3)?.v).toBe("again");
  });
});

describe("eachLimit", () => {
  it("runs everything, never more than `limit` at once", async () => {
    let inFlight = 0, peak = 0;
    const seen: number[] = [];
    await eachLimit(Array.from({ length: 23 }, (_, i) => i), 4, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, (i * 7) % 5));
      seen.push(i);
      inFlight--;
    });
    expect(peak).toBe(4);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 23 }, (_, i) => i));
  });

  it("copes with no items and a limit above the item count", async () => {
    await eachLimit([], 8, async () => { throw new Error("never"); });
    const seen: number[] = [];
    await eachLimit([1, 2], 8, async (i) => { seen.push(i); });
    expect(seen.sort()).toEqual([1, 2]);
  });
});

describe("wiring (index.ts and the migration, read as text)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const code = strip(readFileSync(join(here, "index.ts"), "utf8"));
  const sql = readFileSync(join(here, "../../migrations/20260940000100_altercpa_sweep_resume.sql"), "utf8")
    .replace(/--.*$/gm, "");

  it("routes only sweep requests to the sweep path", () => {
    expect(code).toMatch(/const sweep = isSweepRequest\(kind, dry\);/);
    expect(code).toMatch(/kind === "status"\s*\?\s*await syncStatusAccount\([^)]*\)\s*:\s*sweep\s*\?\s*await syncSweepAccount\(/);
  });

  it("rolling/backfill/manual still write each lead on its own — no page", () => {
    expect(code).toMatch(/const written = await upsertLead\(admin, account, ledgerRow, o, mapping, stats\);/);
  });

  it("a sweep page runs the very same per-lead code", () => {
    expect(code).toMatch(/buildLead\(leadRun, o\);\s*await upsertLead\(admin, leadRun\.account, ledgerRow, o, mapping, leadRun\.stats, page\);/);
  });

  it("the prefetched status may only skip the order read; the B′ decision is made on a fresh one", () => {
    expect(code).toMatch(
      /if \(opts\.knownStatus !== undefined && forwardOutcome\(o, opts\.knownStatus\) == null\) return;\s*const \{ data: order \} = await admin\.from\("orders"\)/,
    );
    expect(code).toMatch(/const cur = String\(order\.status\);\s*const target = forwardOutcome\(o, cur\);/);
  });

  it("import_scope still defaults to pending_only and is never written here", () => {
    expect(code).toMatch(/importScope: String\(account\.import_scope \|\| "pending_only"\)/);
    expect(code).not.toMatch(/import_scope\s*[:=]/);
  });

  it("a finished sweep moves the rolling high-water mark forward only", () => {
    expect(code).toMatch(/\.is\("last_synced_at", null\)/);
    expect(code).toMatch(/\.lt\("last_synced_at", sweep\.window_to\)/);
  });

  it("the migration adds exactly one cron job and reschedules none of the existing ones", () => {
    const scheduled = [...sql.matchAll(/cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
    expect(scheduled).toEqual([["altercpa-sync-continue", "1-59/2 * * * *"]]);
    expect(sql).not.toMatch(/cron\.unschedule\('altercpa-sync-(rolling|nightly|weekly|status)'\)/);
    // Same invocation mechanism as every altercpa-sync job.
    expect(sql).toMatch(/PERFORM public\.invoke_altercpa_sync\('continue'\);/);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/);
  });
});
