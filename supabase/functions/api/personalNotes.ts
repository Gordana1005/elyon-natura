// ============================================================================
// Личен дневник — personal notebooks and notes (plan "Фаза 6", owner 01.10.2026):
// the pure half of the personal-notes/* routes in index.ts.
//
//   GET    personal-notes/notebooks?owner=          own by default; another owner needs canRead
//   POST   personal-notes/notebooks                 own, ≤ 50 live notebooks
//   PATCH  personal-notes/notebooks/:id             rename / colour, own
//   PUT    personal-notes/notebooks/order {ids}     own
//   DELETE personal-notes/notebooks/:id            soft; its notes hide with it
//   POST   personal-notes/notebooks/:id/restore     within 30 days
//   GET    personal-notes/notebooks/:id/notes?q=    list with snippets; canRead
//   POST   personal-notes/notebooks/:id/notes       own, ≤ 500 live notes
//   GET    personal-notes/notes/:id                 full body; canRead
//   PATCH  personal-notes/notes/:id                 autosave target, own, base_version → 409
//   DELETE personal-notes/notes/:id                 soft
//   POST   personal-notes/notes/:id/restore         within 30 days
//   GET    personal-notes/search?q=&owner=          title + body, ≤ 50, canRead
//   GET    personal-notes/deleted                   own soft-deleted, 30 days
//   GET    personal-notes/authors                   admins / managers: who keeps notebooks
//
// Rules (owner): the OPERATOR writes; admins read everyone's; a manager reads
// everyone's except an admin's. Tables are deny-all (20260944000400) — the api
// is the only door. Dependency-free on purpose: vitest runs personalNotes.test.ts
// against this file in Node, index.ts imports it.
// ============================================================================

export const LIMITS = {
  notebooksPerOwner: 50,
  notesPerNotebook: 500,
  notebookTitle: 80,
  noteTitle: 120,
  body: 20_000,
  searchResults: 50,
  snippet: 160,
  query: 100,
  restoreDays: 30,
  deletedList: 200,
} as const;

export const NOTEBOOK_COLORS = ["slate", "sky", "emerald", "amber", "rose", "violet"] as const;
export type NotebookColor = (typeof NOTEBOOK_COLORS)[number];

/** Rate-limit bucket for every write (autosave included): 120 / minute / user. */
export const WRITE_RATE = { endpoint: "personal_notes.write", limit: 120 } as const;

export type ErrorCode =
  | "bad_id" | "bad_title" | "bad_color" | "bad_body" | "bad_version" | "bad_ids" | "bad_query"
  | "bad_pinned" | "nothing_to_change" | "notebook_limit" | "note_limit" | "not_found"
  | "forbidden" | "version_conflict" | "notebook_deleted" | "restore_expired" | "rate_limited";

const STATUS: Record<ErrorCode, number> = {
  bad_id: 400, bad_title: 400, bad_color: 400, bad_body: 400, bad_version: 400, bad_ids: 400,
  bad_query: 400, bad_pinned: 400, nothing_to_change: 400,
  notebook_limit: 409, note_limit: 409, version_conflict: 409, notebook_deleted: 409,
  restore_expired: 410, not_found: 404, forbidden: 403, rate_limited: 429,
};

const MESSAGE: Record<ErrorCode, string> = {
  bad_id: "Invalid id",
  bad_title: "Invalid title",
  bad_color: "Invalid colour",
  bad_body: "Note text is too long",
  bad_version: "base_version is required",
  bad_ids: "Invalid notebook order",
  bad_query: "Invalid search",
  bad_pinned: "Invalid pinned flag",
  nothing_to_change: "No updates provided",
  notebook_limit: `At most ${LIMITS.notebooksPerOwner} notebooks`,
  note_limit: `At most ${LIMITS.notesPerNotebook} notes in a notebook`,
  not_found: "Not found",
  forbidden: "Forbidden",
  version_conflict: "The note was changed in another window",
  notebook_deleted: "The notebook is deleted",
  restore_expired: "Deleted more than 30 days ago",
  rate_limited: "Rate limit exceeded",
};

export const statusFor = (code: ErrorCode): number => STATUS[code] ?? 400;

/** The error body every refusal answers with: an English sentence + a stable code the UI translates. */
export const errorBody = (code: ErrorCode, extra: Record<string, unknown> = {}) =>
  ({ error: MESSAGE[code] ?? "Operation failed", code, ...extra });

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: ErrorCode };
export type Result<T> = Ok<T> | Err;
const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
const err = (error: ErrorCode): Err => ({ ok: false, error });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** Code points, as Postgres char_length counts them (an emoji is one, not two). */
export const charLength = (s: string): number => Array.from(s).length;

// ── who may read / write ─────────────────────────────────────────────────────

export interface Viewer { id: string; isAdmin: boolean; isManager: boolean }
export interface Owner { id: string; isAdmin: boolean }

/** Self, an admin, or a manager reading a non-admin (owner default: a manager never reads an admin's). */
export function canRead(viewer: Viewer, owner: Owner): boolean {
  if (!viewer?.id || !owner?.id) return false;
  if (viewer.id === owner.id) return true;
  if (viewer.isAdmin) return true;
  if (viewer.isManager) return !owner.isAdmin;
  return false;
}

/** Only the operator writes — an admin cannot edit someone else's notes either. */
export const canWrite = (viewer: Pick<Viewer, "id">, ownerId: string | null | undefined): boolean =>
  !!viewer?.id && !!ownerId && viewer.id === ownerId;

/** Authors a viewer may list: admins see everyone, managers everyone but admins; never oneself. */
export function visibleAuthors<T extends { owner_id: string; is_admin: boolean }>(viewer: Viewer, rows: T[]): T[] {
  return rows.filter((r) => r.owner_id !== viewer.id && canRead(viewer, { id: r.owner_id, isAdmin: r.is_admin }));
}

// ── bodies ───────────────────────────────────────────────────────────────────

export interface NotebookInput { title?: string; color?: NotebookColor | null }

function parseNotebookTitle(v: unknown): Result<string> {
  if (typeof v !== "string") return err("bad_title");
  const t = v.trim().replace(/\s+/g, " ");
  const n = charLength(t);
  if (n < 1 || n > LIMITS.notebookTitle) return err("bad_title");
  return ok(t);
}

function parseColor(v: unknown): Result<NotebookColor | null> {
  if (v === null || v === "") return ok(null);
  if (typeof v === "string" && (NOTEBOOK_COLORS as readonly string[]).includes(v)) return ok(v as NotebookColor);
  return err("bad_color");
}

/** POST (title required) / PATCH (title and/or colour) of a notebook. Titles are trimmed. */
export function parseNotebookBody(raw: unknown, mode: "create" | "patch"): Result<NotebookInput> {
  if (!isObj(raw)) return err(mode === "create" ? "bad_title" : "nothing_to_change");
  const out: NotebookInput = {};
  if (mode === "create" || has(raw, "title")) {
    const t = parseNotebookTitle(raw.title);
    if (!t.ok) return t;
    out.title = t.value;
  }
  if (has(raw, "color")) {
    const c = parseColor(raw.color);
    if (!c.ok) return c;
    out.color = c.value;
  }
  if (mode === "patch" && out.title === undefined && !("color" in out)) return err("nothing_to_change");
  return ok(out);
}

export interface NoteInput { title: string; body: string; pinned: boolean }
export interface NotePatch { title?: string; body?: string; pinned?: boolean; notebook_id?: string }

function parseNoteTitle(v: unknown): Result<string> {
  if (v == null) return ok("");
  if (typeof v !== "string") return err("bad_title");
  const t = v.trim();
  return charLength(t) > LIMITS.noteTitle ? err("bad_title") : ok(t);
}

/** The body keeps its whitespace exactly (indentation, blank lines are the operator's). */
function parseBodyText(v: unknown): Result<string> {
  if (v == null) return ok("");
  if (typeof v !== "string") return err("bad_body");
  return charLength(v) > LIMITS.body ? err("bad_body") : ok(v);
}

/** POST a note: every field optional (a blank note is a valid start). */
export function parseNoteBody(raw: unknown): Result<NoteInput> {
  const o = isObj(raw) ? raw : {};
  const title = parseNoteTitle(o.title);
  if (!title.ok) return title;
  const body = parseBodyText(o.body);
  if (!body.ok) return body;
  if (o.pinned != null && typeof o.pinned !== "boolean") return err("bad_pinned");
  return ok({ title: title.value, body: body.value, pinned: o.pinned === true });
}

/** PATCH a note: {title?, body?, pinned?, notebook_id?, base_version} — base_version is required. */
export function parseNotePatch(raw: unknown): Result<{ patch: NotePatch; base_version: number }> {
  if (!isObj(raw)) return err("nothing_to_change");
  const bv = raw.base_version;
  if (typeof bv !== "number" || !Number.isInteger(bv) || bv < 1) return err("bad_version");
  const patch: NotePatch = {};
  if (has(raw, "title")) {
    const t = parseNoteTitle(raw.title);
    if (!t.ok) return t;
    patch.title = t.value;
  }
  if (has(raw, "body")) {
    const b = parseBodyText(raw.body);
    if (!b.ok) return b;
    patch.body = b.value;
  }
  if (has(raw, "pinned")) {
    if (typeof raw.pinned !== "boolean") return err("bad_pinned");
    patch.pinned = raw.pinned;
  }
  if (has(raw, "notebook_id")) {
    if (!isUuid(raw.notebook_id)) return err("bad_id");
    patch.notebook_id = raw.notebook_id;
  }
  if (Object.keys(patch).length === 0) return err("nothing_to_change");
  return ok({ patch, base_version: bv });
}

/** The versioned write: the row is updated only `.eq('version', base)`, and becomes base + 1. */
export const versionedPatch = (patch: NotePatch, base: number) => ({ ...patch, version: base + 1 });

// ── search ───────────────────────────────────────────────────────────────────

/** A search box value: trimmed, whitespace folded, ≤ 100 characters; empty = no search. */
export function parseQuery(v: unknown): Result<string | null> {
  if (v == null) return ok(null);
  if (typeof v !== "string") return err("bad_query");
  const q = v.trim().replace(/\s+/g, " ");
  if (!q) return ok(null);
  if (charLength(q) > LIMITS.query) return err("bad_query");
  return ok(q);
}

/** LIKE-escape: \ % _ match themselves (backslash is Postgres's default LIKE escape). */
export const escapeIlike = (q: string): string => q.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A PostgREST `.or()` value in double quotes, so commas, dots and parentheses stay literal. */
export const pgrstQuote = (s: string): string => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** The `.or()` filter: title or body contains q (case-insensitive). */
export function orIlike(columns: string[], q: string): string {
  const pattern = pgrstQuote(`%${escapeIlike(q)}%`);
  return columns.map((c) => `${c}.ilike.${pattern}`).join(",");
}

/**
 * A one-line excerpt of `body` of at most `max` characters (an ellipsis included). With a
 * query found in the body, the window is centred on the first match; otherwise it is the
 * start. Whitespace collapses to single spaces — a preview, never the text itself.
 */
export function snippet(body: string, q: string | null | undefined, max: number = LIMITS.snippet): string {
  const flat = String(body ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const needle = (q ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  let at = -1;
  if (needle) {
    const lower = chars.map((c) => c.toLowerCase());
    const nChars = Array.from(needle);
    outer: for (let i = 0; i + nChars.length <= lower.length; i++) {
      for (let j = 0; j < nChars.length; j++) if (lower[i + j] !== nChars[j]) continue outer;
      at = i;
      break;
    }
  }
  if (at < 0) return chars.slice(0, max - 1).join("").trimEnd() + "…";
  const room = max - 2; // both ellipses
  const start = Math.max(0, at - Math.floor((room - Array.from(needle).length) / 2));
  if (start <= 0) return chars.slice(0, max - 1).join("").trimEnd() + "…";
  const end = start + room;
  if (end >= chars.length) return "…" + chars.slice(chars.length - (max - 1)).join("").trimStart();
  return "…" + chars.slice(start, end).join("").trim() + "…";
}

// ── order ────────────────────────────────────────────────────────────────────

/**
 * PUT notebooks/order {ids}: the new order of the owner's live notebooks. `ids` must be
 * unique and all the owner's; a live notebook missing from `ids` (made in another tab)
 * keeps its relative place after them. Returns only the positions that change.
 */
export function reorder(
  ids: unknown,
  existing: Array<{ id: string; position: number }>,
): Result<{ order: string[]; updates: Array<{ id: string; position: number }> }> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > LIMITS.notebooksPerOwner) return err("bad_ids");
  if (!ids.every(isUuid)) return err("bad_ids");
  if (new Set(ids).size !== ids.length) return err("bad_ids");
  const known = new Map(existing.map((e) => [e.id, e.position]));
  if (!ids.every((id) => known.has(id))) return err("bad_ids");
  const rest = [...existing]
    .filter((e) => !ids.includes(e.id))
    .sort((a, b) => a.position - b.position)
    .map((e) => e.id);
  const order = [...(ids as string[]), ...rest];
  const updates = order
    .map((id, position) => ({ id, position }))
    .filter((u) => known.get(u.id) !== u.position);
  return ok({ order, updates });
}

// ── deleted / restore ───────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** A soft-deleted row can come back for 30 days (the purge runs nightly after that). */
export function isRestorable(deletedAt: string | null | undefined, nowMs: number): boolean {
  if (!deletedAt) return false;
  const t = Date.parse(deletedAt);
  return Number.isFinite(t) && nowMs - t <= LIMITS.restoreDays * DAY_MS;
}

/** The ISO cut-off of the Deleted list: rows deleted after it are still restorable. */
export const restoreCutoffIso = (nowMs: number): string => new Date(nowMs - LIMITS.restoreDays * DAY_MS).toISOString();

/** Whole days left before the purge (0 on the last day). */
export function daysLeft(deletedAt: string, nowMs: number): number {
  const t = Date.parse(deletedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((t + LIMITS.restoreDays * DAY_MS - nowMs) / DAY_MS));
}

// ── shapes ───────────────────────────────────────────────────────────────────

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? "" : String(v));

export interface NotebookOut {
  id: string; title: string; color: NotebookColor | null; position: number;
  note_count: number; created_at: string; updated_at: string; last_updated: string;
}

export function shapeNotebook(r: Record<string, unknown>): NotebookOut {
  const color = (NOTEBOOK_COLORS as readonly string[]).includes(str(r.color)) ? (r.color as NotebookColor) : null;
  return {
    id: str(r.id),
    title: str(r.title),
    color,
    position: num(r.position),
    note_count: num(r.note_count),
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
    last_updated: str(r.last_updated || r.updated_at),
  };
}

export interface NoteListItem {
  id: string; notebook_id: string; title: string; snippet: string; pinned: boolean;
  updated_at: string; version: number; chars: number;
}

export function shapeNoteListItem(r: Record<string, unknown>, q: string | null): NoteListItem {
  const body = str(r.body);
  return {
    id: str(r.id),
    notebook_id: str(r.notebook_id),
    title: str(r.title),
    snippet: snippet(body, q),
    pinned: r.pinned === true,
    updated_at: str(r.updated_at),
    version: num(r.version) || 1,
    chars: charLength(body),
  };
}

/** Pinned first, then the most recently changed. */
export function sortNotes<T extends { pinned: boolean; updated_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
}

export interface NoteOut {
  id: string; notebook_id: string; owner_id: string; title: string; body: string; pinned: boolean;
  version: number; created_at: string; updated_at: string;
}

export function shapeNote(r: Record<string, unknown>): NoteOut {
  return {
    id: str(r.id),
    notebook_id: str(r.notebook_id),
    owner_id: str(r.owner_id),
    title: str(r.title),
    body: str(r.body),
    pinned: r.pinned === true,
    version: num(r.version) || 1,
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
  };
}

/** What an autosave answers with: the new version and stamp — not the body the browser already has. */
export function shapeSaved(r: Record<string, unknown>) {
  return {
    id: str(r.id),
    notebook_id: str(r.notebook_id),
    title: str(r.title),
    pinned: r.pinned === true,
    version: num(r.version) || 1,
    updated_at: str(r.updated_at),
  };
}

export interface AuthorOut {
  owner_id: string; name: string; is_active: boolean; is_admin: boolean;
  notebook_count: number; note_count: number; last_updated: string | null;
}

/** GET authors: the aggregate rows + profiles + admin flags → the visible authors, newest first. */
export function shapeAuthors(
  viewer: Viewer,
  agg: Array<Record<string, unknown>>,
  profiles: Map<string, { full_name?: string | null; email?: string | null; is_active?: boolean | null }>,
  adminIds: Set<string>,
): AuthorOut[] {
  const rows: AuthorOut[] = agg.map((a) => {
    const id = str(a.owner_id);
    const p = profiles.get(id);
    return {
      owner_id: id,
      name: (p?.full_name || p?.email || "").trim() || id.slice(0, 8),
      is_active: p?.is_active !== false,
      is_admin: adminIds.has(id),
      notebook_count: num(a.notebook_count),
      note_count: num(a.note_count),
      last_updated: a.last_updated ? str(a.last_updated) : null,
    };
  });
  return visibleAuthors(viewer, rows).sort((a, b) =>
    (Date.parse(b.last_updated ?? "") || 0) - (Date.parse(a.last_updated ?? "") || 0) || a.name.localeCompare(b.name));
}

// ── audit payloads (never the body) ──────────────────────────────────────────

export function auditNotebookPayload(nb: { id: string; title: string }, extra: Record<string, unknown> = {}) {
  return { notebook_id: nb.id, title: nb.title, ...extra };
}

export function auditNotePayload(n: { id: string; notebook_id: string; title: string; body?: string | null }) {
  return { note_id: n.id, notebook_id: n.notebook_id, title: n.title, chars: charLength(String(n.body ?? "")) };
}

export function auditViewedOther(
  viewerId: string,
  ownerId: string,
  what: { kind: "notebooks" | "notes" | "note" | "search"; notebook_id?: string | null; note_id?: string | null; q?: string | null },
) {
  return {
    viewer: viewerId,
    owner_id: ownerId,
    kind: what.kind,
    notebook_id: what.notebook_id ?? null,
    ...(what.note_id ? { note_id: what.note_id } : {}),
    ...(what.q ? { q: what.q } : {}),
  };
}
