// ============================================================================
// The written note behind every cancel and trash (owner, 01.10.2026 — plan "Фаза 2").
//
//   "Опис од најмалку 5 знаци при откажување или корпа, секаде каде тоа го прави човек."
//
// The next operator on the customer must be able to read WHY the previous one cancelled
// or trashed: the coded reason alone ("Нема пари") says little; the customer's words do.
// So whenever a PERSON moves an order INTO cancelled or trashed — the /calls outcome
// bar, the order modal, the create-order modal, the Orders bulk dialog, the in-call
// log — a note of at least DISPOSITION_NOTE_MIN characters is required.
//
// System writers are exempt and never come through here: the 10-day no-parcel rule
// (no_parcel_7d), the 9-no-answers auto-trash (not_reachable), altercpa-sync,
// collabbox-sync, mex-reconcile and POST /orders/import. There is deliberately NO
// NOT NULL / CHECK on the notes columns, so those keep working.
//
// Rollout: app_settings.disposition_note_min (migration 20260944000100) starts at 0 so
// a browser still running yesterday's bundle (which sends no note) is not refused the
// evening of the deploy; an admin switches it to 5 (audited) once D1 of
// scripts/verify-disposition-notes.mjs is clean. A missing / garbled setting means 5.
// The frontend (src/lib/dispositionNote.ts) always enforces 5.
//
// Dependency-free on purpose (no Deno globals, no URL imports): vitest runs
// dispositionNote.test.ts against this file in Node, and index.ts / callsOutcome.ts
// import it. The error strings are FIXED English — src/i18n/apiErrors.ts maps them.
// ============================================================================

export const DISPOSITION_NOTE_MIN = 5;
export const DISPOSITION_NOTE_MAX = 1000;
/** The setting's own bounds (Settings / PATCH /app-settings). */
export const NOTE_MIN_SETTING_MAX = 50;
export const DISPOSITION_STATUSES = ["cancelled", "trashed"] as const;

export type NoteErrorCode = "note_required" | "note_too_short" | "note_too_long";

/** The exact server messages (src/i18n/apiErrors.ts matches them — change both together). */
export const noteRequiredMessage = (min: number) => `A note of at least ${min} characters is required`;
export const noteTooShortMessage = (min: number) => `The note must be at least ${min} characters long`;
export const NOTE_TOO_LONG_MESSAGE = `The note must be at most ${DISPOSITION_NOTE_MAX} characters long`;

/** Trim and collapse every whitespace run (spaces, tabs, new lines) to one space. */
export function normalizeNote(raw: unknown): string {
  if (raw == null) return "";
  return String(raw).replace(/\s+/gu, " ").trim();
}

/** Characters as a person counts them: Unicode code points, so "нема" = 4 and one emoji = 1. */
export function noteLength(s: string): number {
  return Array.from(s).length;
}

export type NoteCheck =
  | { ok: true; note: string }
  | { ok: false; code: NoteErrorCode; error: string; min: number };

/**
 * The note for a cancel / trash a person makes. `min` 0 accepts an empty note (the
 * rollout window); the maximum always applies. The returned note is normalized —
 * that is what gets stored.
 */
export function checkDispositionNote(raw: unknown, min: number = DISPOSITION_NOTE_MIN): NoteCheck {
  const note = normalizeNote(raw);
  const len = noteLength(note);
  if (len > DISPOSITION_NOTE_MAX) return { ok: false, code: "note_too_long", error: NOTE_TOO_LONG_MESSAGE, min };
  if (min > 0 && len === 0) return { ok: false, code: "note_required", error: noteRequiredMessage(min), min };
  if (len < min) return { ok: false, code: "note_too_short", error: noteTooShortMessage(min), min };
  return { ok: true, note };
}

/**
 * The reason 'other' is the catch-all: its note carries the real reason, so it needs one
 * even while the setting is 0 (the rule before 01.10.2026).
 */
export function effectiveNoteMin(reason: string | null | undefined, min: number): number {
  return reason === "other" ? Math.max(min, 1) : min;
}

export type NoteRule = "required" | "if_sent" | "none";

const isDisposition = (s: unknown): s is "cancelled" | "trashed" =>
  s === "cancelled" || s === "trashed";

/**
 * When does a status write need the note?
 *   required — a move INTO cancelled / trashed (creating an order in it included: from null)
 *   if_sent  — a correction at the same status: a note that IS sent must be long enough,
 *              an empty one changes nothing (it never erases the stored note)
 *   none     — any other status
 */
export function dispositionNoteRule(a: { from: string | null | undefined; to: string; noteSent: boolean }): NoteRule {
  if (!isDisposition(a.to)) return "none";
  if ((a.from ?? null) !== a.to) return "required";
  return a.noteSent ? "if_sent" : "none";
}

export type NoteGate =
  | { ok: true; rule: NoteRule; note: string | null; write: boolean }
  | { ok: false; rule: NoteRule; code: NoteErrorCode; error: string; min: number };

/**
 * dispositionNoteRule + checkDispositionNote for one status write. `raw` undefined = the
 * request sent no note field. `write` says whether the notes column should be written:
 * on a move when a note was sent (an empty one clears the old note, as before), on a
 * same-status correction only with a non-empty note.
 */
export function dispositionNoteGate(a: {
  from: string | null | undefined;
  to: string;
  raw: unknown;
  min: number;
  reason?: string | null;
}): NoteGate {
  const sent = normalizeNote(a.raw);
  const rule = dispositionNoteRule({ from: a.from, to: a.to, noteSent: sent.length > 0 });
  if (rule === "none") return { ok: true, rule, note: null, write: false };
  const check = checkDispositionNote(a.raw, effectiveNoteMin(a.reason, a.min));
  if (!check.ok) return { ok: false, rule, code: check.code, error: check.error, min: check.min };
  return { ok: true, rule, note: check.note || null, write: rule === "if_sent" || a.raw !== undefined };
}

/** app_settings.disposition_note_min → the minimum in force. Missing / invalid → 5. */
export function parseNoteMin(v: unknown): number {
  const n = parseNoteMinInput(v);
  return n == null ? DISPOSITION_NOTE_MIN : n;
}

/** A value an admin sends for the setting: an integer 0..50 (a numeric string too), else null. */
export function parseNoteMinInput(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) n = Number(v.trim());
  else return null;
  if (!Number.isInteger(n) || n < 0 || n > NOTE_MIN_SETTING_MAX) return null;
  return n;
}

// ── GET /customers/:phone/history — who decided a cancel / trash ─────────────

export interface OperatorRow {
  operator_name?: string | null;
  operator_basis?: string | null;
  operator_auto?: boolean | null;
}

/**
 * Who stands behind a cancelled / trashed order's current status, for the next operator
 * (public.order_operators, 20260943002000). `decided_auto` = an automatic rule decided it:
 * the RPC's own flag (a System actor moved it), the no-parcel cancel, or the 9-no-answers
 * auto-trash (not_reachable with no person in the history and no assignee — the auto-trash
 * clears the assignee and writes no history row). null for any other status.
 */
export function decisionMeta(
  order: { status?: string | null; cancellation_reason?: string | null; trash_reason?: string | null },
  op: OperatorRow | null | undefined,
): { decided_by_name: string | null; decided_auto: boolean } | null {
  if (!isDisposition(order.status)) return null;
  const basis = op?.operator_basis ?? null;
  const auto = op?.operator_auto === true
    || (order.status === "cancelled" && order.cancellation_reason === "no_parcel_7d")
    || (order.status === "trashed" && order.trash_reason === "not_reachable" && basis !== "history" && basis !== "assigned");
  return { decided_by_name: op?.operator_name ?? null, decided_auto: auto };
}
