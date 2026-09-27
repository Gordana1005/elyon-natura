/**
 * The AlterCPA bridge decides only CONFIRMED or dead (2026-08-11 doctrine).
 * shipped, delivered, paid and returned are MEX's alone (mex-reconcile) —
 * AlterCPA never moves this account past status 6 "Packing", even for parcels
 * MEX delivered.
 *
 * On 2026-09-18 an import_scope='all' backfill created 1.344 orders directly as
 * `paid` through the insert path's old PHASE_TO_STATUS map (phase 3 → paid);
 * ~345 of them never had a parcel. These tests pin the invariant over the WHOLE
 * input space, so it cannot come back through a new path or a "small" map edit.
 *
 * altercpa.ts is dependency-free (no deno.land/esm.sh imports, no Deno
 * globals), so Node runs it as-is. index.ts is only read as text.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AlterCpaOrder, CANCEL_REASON_TO_CRM, INSERT_STATUSES,
  assertInsertStatus, cancelOtherConfirmedNote, crmReasonFor, guardedOutcomeNote,
  insertStatusFor, outcomeColumns, resolveRemoteOutcome,
} from "./altercpa.ts";

const PHYSICAL = ["shipped", "delivered", "paid", "returned"];
const REMOTE_OUTCOMES = new Set(["confirmed", "cancelled", "trashed"]);
const CRM_STATUSES = [
  "pending", "take", "call_again", "confirmed", "shipped",
  "delivered", "paid", "returned", "cancelled", "trashed",
];
const PHASES = [1, 2, 3, 4, 5];
const STATUSES = Array.from({ length: 12 }, (_, i) => i + 1);   // 1-12
const REASONS = Array.from({ length: 20 }, (_, i) => i);        // 0-19

// 2025-09-16 — in the past, so outcomeTimestamps' clock-skew guard accepts it.
const CREATED = 1_758_000_000;
const DONE = CREATED + 3 * 86400;
const PAID = CREATED + 9 * 86400;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

/**
 * Every record shape the bridge can meet: phase × status × reason, each with
 * and without their settlement stamps — a real o.paid stamp must not buy a
 * `paid` either.
 */
function* everyRecord(): Generator<AlterCpaOrder> {
  let id = 1;
  for (const phase of PHASES) {
    for (const status of STATUSES) {
      for (const reason of REASONS) {
        for (const stamped of [false, true]) {
          yield {
            id: id++, phase, status, reason, time: CREATED,
            done: stamped ? DONE : 0, paid: stamped ? PAID : 0,
            comment: "operator comment",
          };
        }
      }
    }
  }
}
const label = (o: AlterCpaOrder) =>
  `phase ${o.phase} status ${o.status} reason ${o.reason}${o.paid ? " +stamps" : ""}`;

const rec = (phase: number, reason = 0, extra: Partial<AlterCpaOrder> = {}): AlterCpaOrder =>
  ({ id: 42, phase, status: 1, reason, time: CREATED, done: DONE, ...extra });

/** Pinned on purpose, not derived from CANCEL_REASON_TO_CRM: the 2026-08-11
 * manager rule must not move because someone edited the reason map. */
const CANCEL_MAPPABLE = [2, 7, 8, 9, 10, 14];
const CANCEL_OTHER = [1, 3, 4, 5, 6, 11, 12, 13, 15, 16, 17, 18, 19];

describe("the bridge never writes anything physical", () => {
  it("neither B′ nor the insert status yields shipped/delivered/paid/returned — every phase × status × reason × CRM status", () => {
    const bad: string[] = [];
    let combos = 0;
    for (const o of everyRecord()) {
      // An insert has no current status — it is B′ against a fresh pending.
      const ins = insertStatusFor(o);
      if (PHYSICAL.includes(ins) || !INSERT_STATUSES.has(ins)) bad.push(`insert ${label(o)} → ${ins}`);
      for (const cur of CRM_STATUSES) {
        combos++;
        const out = resolveRemoteOutcome(o, cur);
        if (out !== null && (PHYSICAL.includes(out) || !REMOTE_OUTCOMES.has(out))) {
          bad.push(`B′ ${label(o)} @ ${cur} → ${out}`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(combos).toBe(5 * 12 * 20 * 2 * 10);
  });

  it("an insert is exactly what B′ would do to a fresh pending", () => {
    const bad: string[] = [];
    for (const o of everyRecord()) {
      const want = resolveRemoteOutcome(o, "pending") ?? "pending";
      if (insertStatusFor(o) !== want) bad.push(`${label(o)}: ${insertStatusFor(o)} ≠ ${want}`);
    }
    expect(bad).toEqual([]);
  });

  it("the columns written with an insert never stamp a physical outcome", () => {
    const allowed = new Set([
      "cancelled_at", "trashed_at",
      "cancellation_reason", "cancellation_reason_notes", "trash_reason", "trash_reason_notes",
    ]);
    const bad: string[] = [];
    for (const o of everyRecord()) {
      for (const k of Object.keys(outcomeColumns(o, insertStatusFor(o)))) {
        if (!allowed.has(k)) bad.push(`${label(o)} writes ${k}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("unknown or missing phases insert as pending and resolve to nothing", () => {
    for (const phase of [undefined, 0, 6, 99, -1]) {
      const o: AlterCpaOrder = { id: 7, phase, status: 10, reason: 0, paid: PAID, done: DONE, time: CREATED };
      expect(insertStatusFor(o)).toBe("pending");
      for (const cur of CRM_STATUSES) expect(resolveRemoteOutcome(o, cur)).toBeNull();
    }
  });
});

describe("insertStatusFor — the B′ table", () => {
  it.each<[number, number, string]>([
    [1, 0, "pending"],
    [2, 0, "pending"],
    [3, 0, "confirmed"],        // approved = a sale; MEX walks it to paid/returned
    [4, 0, "cancelled"],        // reason 0 = none recorded → stays a cancel
    [5, 0, "trashed"],
    [5, 1, "trashed"],
  ])("phase %i reason %i → %s", (phase, reason, want) => {
    expect(insertStatusFor(rec(phase, reason))).toBe(want);
  });

  it("phase 3 is confirmed through every fulfilment status — Packing … Completed, even with an o.paid stamp", () => {
    for (const status of STATUSES) {
      const o = rec(3, 0, { status, paid: PAID });
      expect(insertStatusFor(o)).toBe("confirmed");
      expect(resolveRemoteOutcome(o, "pending")).toBe("confirmed");
      // Once the courier holds the parcel, it is MEX's to settle.
      expect(resolveRemoteOutcome(o, "shipped")).toBeNull();
      expect(resolveRemoteOutcome(o, "delivered")).toBeNull();
    }
  });

  it("the 2026-08-11 manager rule is unchanged: a phase-4 cancel whose reason flattens into 'other' is confirmed", () => {
    // The pinned lists partition 1-19 exactly as the reason map does today.
    expect(Object.keys(CANCEL_REASON_TO_CRM).map(Number).sort((a, b) => a - b)).toEqual(CANCEL_MAPPABLE);
    expect([...CANCEL_MAPPABLE, ...CANCEL_OTHER].sort((a, b) => a - b)).toEqual(REASONS.slice(1));

    for (const r of CANCEL_OTHER) {
      expect(insertStatusFor(rec(4, r))).toBe("confirmed");
      for (const cur of CRM_STATUSES) expect(resolveRemoteOutcome(rec(4, r), cur)).toBe("confirmed");
    }
    for (const r of [0, ...CANCEL_MAPPABLE]) {
      expect(insertStatusFor(rec(4, r))).toBe("cancelled");
      expect(resolveRemoteOutcome(rec(4, r), "pending")).toBe("cancelled");
      expect(resolveRemoteOutcome(rec(4, r), "confirmed")).toBe("cancelled");
      expect(resolveRemoteOutcome(rec(4, r), "shipped")).toBeNull();     // at the courier: MEX decides
      expect(resolveRemoteOutcome(rec(4, r), "delivered")).toBeNull();
    }
  });
});

describe("assertInsertStatus — the tripwire", () => {
  it("allows exactly pending, confirmed, cancelled and trashed", () => {
    expect([...INSERT_STATUSES].sort()).toEqual(["cancelled", "confirmed", "pending", "trashed"]);
    for (const st of INSERT_STATUSES) expect(assertInsertStatus(st)).toBe(st);
  });

  it.each([...PHYSICAL, "take", "call_again", "duplicated", ""])("refuses to insert %j", (st) => {
    expect(() => assertInsertStatus(st, rec(3))).toThrow(/AlterCPA #42 .*may be inserted/);
  });
});

describe("outcomeColumns — what travels with the status", () => {
  it("cancelled: their-clock cancelled_at + the reason pair from crmReasonFor", () => {
    expect(outcomeColumns(rec(4, 2, { comment: "  ќе   размисли  " }), "cancelled")).toEqual({
      cancelled_at: iso(DONE),
      cancellation_reason: "changed_mind",
      cancellation_reason_notes: "ќе размисли",
    });
  });

  it("trashed: their-clock trashed_at + the trash reason pair", () => {
    expect(outcomeColumns(rec(5, 11, { comment: "не се јавува" }), "trashed")).toEqual({
      trashed_at: iso(DONE),
      trash_reason: "not_reachable",
      trash_reason_notes: "не се јавува",
    });
    // A reason with no trash equivalent flattens to 'other' and keeps their
    // label ahead of the operator's words.
    expect(outcomeColumns(rec(5, 2, { comment: "сака совет" }), "trashed")).toEqual({
      trashed_at: iso(DONE),
      trash_reason: "other",
      trash_reason_notes: "changed mind — сака совет",
    });
  });

  it("the reason pair is crmReasonFor's, byte for byte", () => {
    for (const r of REASONS.slice(1)) {
      const c = crmReasonFor("cancel", r, "x");
      const t = crmReasonFor("trash", r, "x");
      expect(outcomeColumns(rec(4, r, { comment: "x" }), "cancelled")).toMatchObject({
        cancellation_reason: c.value, cancellation_reason_notes: c.notes,
      });
      expect(outcomeColumns(rec(5, r, { comment: "x" }), "trashed")).toMatchObject({
        trash_reason: t.value, trash_reason_notes: t.notes,
      });
    }
  });

  it("reason 0 writes no reason, and no `done` stamp writes no timestamp (the NULL-only trigger dates it)", () => {
    expect(outcomeColumns(rec(5, 0), "trashed")).toEqual({ trashed_at: iso(DONE) });
    expect(outcomeColumns(rec(4, 0, { done: 0 }), "cancelled")).toEqual({});
  });

  it("confirmed and pending write nothing — no confirmed_at, same as a B′ update", () => {
    expect(outcomeColumns(rec(3, 0, { paid: PAID }), "confirmed")).toEqual({});
    expect(outcomeColumns(rec(4, 16), "confirmed")).toEqual({});
    expect(outcomeColumns(rec(1), "pending")).toEqual({});
  });
});

describe("order notes", () => {
  it("the cancel-other note fires exactly when a phase-4 cancel resolved to confirmed", () => {
    const bad: string[] = [];
    for (const o of everyRecord()) {
      const st = insertStatusFor(o);
      const fired = cancelOtherConfirmedNote(o, st) !== null;
      if (fired !== (o.phase === 4 && st === "confirmed")) bad.push(`${label(o)} → ${st}, note ${fired}`);
    }
    expect(bad).toEqual([]);
  });

  it("keeps their disposition wording and comment (text unchanged by the refactor)", () => {
    expect(cancelOtherConfirmedNote(rec(4, 16, { comment: "  сака само совет  " }), "confirmed")).toBe(
      "AlterCPA cancelled (само консултација) — confirmed disposition per the 2026-08-11 manager rule; "
        + "status set to confirmed. MEX tracking will move it to shipped/paid/returned. Their comment: сака само совет",
    );
    expect(cancelOtherConfirmedNote(rec(4, 16, { comment: undefined }), "confirmed")).toBe(
      "AlterCPA cancelled (само консултација) — confirmed disposition per the 2026-08-11 manager rule; "
        + "status set to confirmed. MEX tracking will move it to shipped/paid/returned.",
    );
  });

  it("the guarded note reads their phase and reason (text unchanged by the refactor)", () => {
    expect(guardedOutcomeNote(rec(4, 2))).toBe(
      'AlterCPA moved this to "cancelled" (changed mind) — not applied, this order is already being worked here.',
    );
    expect(guardedOutcomeNote(rec(3))).toBe(
      'AlterCPA moved this to "approved" — not applied, this order is already being worked here.',
    );
  });
});

describe("index.ts (read as text)", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "index.ts"), "utf8");
  // Comments may tell the history; only CODE is checked. `://` survives so a
  // URL string is not mistaken for a comment.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("never touches the history-only phase map", () => {
    expect(code).not.toMatch(/PHASE_TO_STATUS/);
  });

  it("never writes a physical status literal", () => {
    expect(code).not.toMatch(/status:\s*["'`](paid|shipped|delivered|returned)["'`]/);
  });

  it("creates orders through insertStatusFor", () => {
    expect(code).toMatch(/const insertStatus = insertStatusFor\(o\);/);
    expect(code).toMatch(/status: insertStatus,/);
  });
});
