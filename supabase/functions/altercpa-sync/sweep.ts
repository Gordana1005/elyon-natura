/**
 * Resumable nightly / weekly sweeps — the dependency-free half (2026-09-28).
 *
 * The nightly (7-day) and weekly (90-day) sweeps did not finish once from
 * 18.09: at ~88 ms of per-lead DB work plus ~0.5 s fixed, the edge wall clock
 * (~150 s) killed every run before it wrote its end, and the run log filled
 * with "stale: still running after 10 minutes".
 *
 * A sweep is now a row in altercpa_sweeps (20260940000100), worked through in
 * DAY CHUNKS of AlterCPA creation time, across as many invocations as it needs:
 *
 *   window   fixed when the sweep opens — [now − 7 d | 90 d, now], epoch
 *            seconds, both ends inclusive (their comp/list.json from/to are)
 *   cursor   the first creation second NOT yet written: every lead created
 *            before it is in the ledger. Persisted after every page, so a
 *            killed invocation loses one page of work, never the sweep
 *   chunk    [cursor, cursor + 1 day − 1] clipped to the window = one API call
 *   budget   an invocation stops STARTING work 100 s in (the status kind's
 *            110 s rule, with room left for the sightings and the run row);
 *            the altercpa-sync-continue cron picks the sweep up again
 *
 * Inside a chunk leads are written in (time, id) order, so a budget cut can put
 * the cursor on the first unwritten lead's second. Leads sharing that second
 * are written twice — every write on this path is idempotent — and nothing is
 * ever skipped. Progress therefore needs one creation second's leads to fit in
 * one invocation (~1.100 even at the old 88 ms a lead); AlterCPA creates a
 * handful a second at most.
 *
 * index.ts wires runSweep to the API, to the same per-lead code every other
 * kind runs, and to the altercpa_sweep_* RPCs; sweep.test.ts drives it with
 * fakes. No deno.land/esm.sh imports and no Deno globals here: Node (vitest)
 * runs this file as-is.
 */

/** Days of creation time a sweep covers. */
export const SWEEP_DAYS: Record<string, number> = {
  nightly: 7,
  weekly: 90,
};

/** One API call per day of creation time. */
export const SWEEP_CHUNK_SEC = 86_400;
/** Stop starting work this long after the invocation began. */
export const SWEEP_BUDGET_MS = 100_000;
/** Do not start fetching another day with less than this left. */
export const SWEEP_MIN_CHUNK_MS = 10_000;
/** Leads per batched ledger/orders read and per cursor checkpoint. */
export const SWEEP_PAGE = 100;
/** Lease on the sweep row: well past a slice's life (new work stops at 100 s,
 * the wall clock killed runs at ~150 s), so two slices never work one sweep,
 * and a killed one frees it when this runs out. A slice that outlived it
 * anyway is fenced — altercpa_sweep_advance answers 'lost' to its token. */
export const SWEEP_LEASE_SEC = 240;

/**
 * Requests served by the sweep machinery: a nightly/weekly START (their crons,
 * or an admin) and 'continue' (the altercpa-sync-continue cron). A DRY
 * nightly/weekly stays the old one-shot preview — it writes nothing, so it has
 * nothing to resume. rolling, status, backfill and manual never come here.
 */
export function isSweepRequest(kind: string, dry: boolean): boolean {
  return !dry && (kind === "nightly" || kind === "weekly" || kind === "continue");
}

/** Epoch seconds, both ends inclusive. */
export interface Span {
  from: number;
  to: number;
}

const isoOf = (sec: number) => new Date(sec * 1000).toISOString();

/**
 * The window a NEW sweep covers — the one-shot sweep's window, unchanged:
 * [now − days, now], an explicit from/to (admin) winning, never before the
 * account's sync_from, and an empty window is an error.
 */
export function sweepWindow(
  kind: string,
  nowSec: number,
  opts: { from?: number | null; to?: number | null; syncFrom?: string | null } = {},
): Span {
  const days = SWEEP_DAYS[kind];
  if (!days) throw new Error(`kind '${kind}' is not a sweep`);
  let from = opts.from ?? nowSec - days * 86_400;
  const to = opts.to ?? nowSec;
  if (opts.syncFrom) {
    const floor = Math.floor(new Date(opts.syncFrom).getTime() / 1000);
    if (from < floor) from = floor;
  }
  if (to <= from) throw new Error(`empty window: ${isoOf(from)} → ${isoOf(to)}`);
  return { from, to };
}

/** The next API window, or null once the cursor is past the sweep's end. */
export function nextChunk(cursor: number, windowTo: number, chunkSec = SWEEP_CHUNK_SEC): Span | null {
  if (!(cursor <= windowTo)) return null;
  return { from: cursor, to: Math.min(cursor + chunkSec - 1, windowTo) };
}

/** The fields the cursor needs. AlterCpaOrder has both. */
export interface SweepLead {
  id: number | string;
  time?: number;
}

/** Creation second of a record, or null when it carries none. */
export function leadTime(o: SweepLead): number | null {
  const n = Number(o.time);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function compareIds(a: number | string, b: number | string): number {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na < nb ? -1 : 1;
  const sa = String(a), sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * A chunk's records in the order the cursor can cut: (time, id) ascending,
 * records without a time first (they are written before any cut can pass
 * them). A repeated id is one record — the last one read, the state the old
 * per-record loop ended on.
 */
export function orderForCursor<L extends SweepLead>(rows: L[]): L[] {
  const byId = new Map<string, L>();
  for (const o of rows) byId.set(String(o.id), o);
  return [...byId.values()].sort((a, b) => {
    const ta = leadTime(a) ?? -Infinity;
    const tb = leadTime(b) ?? -Infinity;
    if (ta !== tb) return ta < tb ? -1 : 1;
    return compareIds(a.id, b.id);
  });
}

/**
 * Where the sweep stands once the first `written` leads of a sorted chunk are
 * in the ledger: past the chunk when all are, else the first unwritten lead's
 * second (its already-written neighbours on that second are re-read and
 * re-written next time — idempotent). Always inside [chunk.from, chunk.to + 1].
 */
export function cursorAfter<L extends SweepLead>(sorted: L[], written: number, chunk: Span): number {
  if (written >= sorted.length) return chunk.to + 1;
  const t = leadTime(sorted[Math.max(0, written)]) ?? chunk.from;
  return Math.min(Math.max(t, chunk.from), chunk.to + 1);
}

/**
 * open  the sweep goes on (out of budget — the continuation cron resumes it)
 * done  the cursor passed window_to; the RPC closed the sweep
 * lost  the lease is gone (re-claimed after it ran out, or the sweep was
 *       closed meanwhile) — stop without writing anything else
 */
export type SweepStatus = "open" | "done" | "lost";

export interface SweepIo<L extends SweepLead> {
  now(): number;
  /** Their records created in [chunk.from, chunk.to]. */
  fetch(chunk: Span): Promise<L[]>;
  /** Write `page` in order until `deadlineMs`; resolve to how many leads (a
   * prefix of the page) are fully written, ledger row included. */
  processPage(page: L[], deadlineMs: number): Promise<number>;
  /** Persist the cursor — the lease holder only, forward only. */
  advance(cursor: number): Promise<SweepStatus>;
}

export interface SweepRun {
  status: SweepStatus;
  /** Where the sweep stands after this invocation. */
  cursor: number;
  /** API windows fetched. */
  chunks: number;
  /** Records those windows returned. */
  fetched: number;
  /** Leads fully written (a lead re-written after a cut counts again). */
  written: number;
  /** Stopped for the budget with the sweep still open. */
  budgetExhausted: boolean;
}

/**
 * Work a sweep from `start.cursor` until it is done, the budget is spent, or
 * the lease is lost. A throw (API or DB) propagates: everything up to the last
 * checkpoint stays written and the next claim retries from the cursor.
 */
export async function runSweep<L extends SweepLead>(
  io: SweepIo<L>,
  start: { cursor: number; windowTo: number },
  deadlineMs: number,
  opts: { chunkSec?: number; pageSize?: number; minChunkMs?: number } = {},
): Promise<SweepRun> {
  const chunkSec = opts.chunkSec ?? SWEEP_CHUNK_SEC;
  const pageSize = Math.max(1, opts.pageSize ?? SWEEP_PAGE);
  const minChunkMs = opts.minChunkMs ?? SWEEP_MIN_CHUNK_MS;
  const run: SweepRun = {
    status: "open", cursor: start.cursor, chunks: 0, fetched: 0, written: 0, budgetExhausted: false,
  };

  // Persist a cursor that moved; false = stop (done or lost).
  const moveTo = async (next: number): Promise<boolean> => {
    if (next <= run.cursor) return true;
    run.status = await io.advance(next);
    if (run.status !== "lost") run.cursor = next;
    return run.status === "open";
  };

  for (;;) {
    const chunk = nextChunk(run.cursor, start.windowTo, chunkSec);
    if (!chunk) {
      // Already past the end (an earlier invocation wrote the last chunk and
      // died before it could say so): the RPC records the sweep done.
      run.status = await io.advance(run.cursor);
      return run;
    }
    if (deadlineMs - io.now() < minChunkMs) {
      run.budgetExhausted = true;
      return run;
    }

    const rows = orderForCursor(await io.fetch(chunk));
    run.chunks++;
    run.fetched += rows.length;

    let written = 0;
    while (written < rows.length && io.now() < deadlineMs) {
      const page = rows.slice(written, written + pageSize);
      const n = Math.min(Math.max(0, Math.floor(await io.processPage(page, deadlineMs))), page.length);
      written += n;
      run.written += n;
      // Checkpoint every page: a killed invocation loses one page, not a day.
      if (!(await moveTo(cursorAfter(rows, written, chunk)))) return run;
      if (n < page.length) break;                 // the deadline cut the page
    }
    if (written < rows.length) {
      run.budgetExhausted = true;
      return run;
    }
    // An empty day moves here; a written one already did on its last page.
    if (!(await moveTo(chunk.to + 1))) return run;
  }
}

/** Run `fn` over `items`, at most `limit` at a time. */
export async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
}
