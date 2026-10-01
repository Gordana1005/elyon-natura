// Личен дневник — the pure half of the screen (plan Фаза 7, 01.10.2026): the URL state
// (`tab`, `nb`, `note`, `owner` — the phone's back button walks notebooks → notes → editor),
// the save-status machine of the autosave, the note order, the snippet (a twin of the
// server's personalNotes.ts snippet, so a just-saved note's preview matches a reload) and
// the counters. Unit-tested in model.test.ts.

// ── the URL ──────────────────────────────────────────────────────────────────

export interface NotesUrlState {
  /** The open notebook. */
  nb: string | null;
  /** The open note (only inside `nb`). */
  note: string | null;
  /** Whose notebooks (admins / managers reading an operator's); null = mine. */
  owner: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: string | null): string | null => (v && UUID_RE.test(v) ? v : null);

export function readNotesUrl(params: URLSearchParams): NotesUrlState {
  const nb = id(params.get('nb'));
  return { nb, note: nb ? id(params.get('note')) : null, owner: id(params.get('owner')) };
}

/**
 * The next search params: `patch` applied, null removes a key. Opening another notebook
 * closes the note; leaving the owner closes both. Every other key (`tab`, …) is kept.
 */
export function writeNotesUrl(params: URLSearchParams, patch: Partial<NotesUrlState>): URLSearchParams {
  const next = new URLSearchParams(params);
  const cur = readNotesUrl(params);
  const want: NotesUrlState = { ...cur, ...patch };
  if ('owner' in patch && patch.owner !== cur.owner) {
    if (!('nb' in patch)) want.nb = null;
    if (!('note' in patch)) want.note = null;
  }
  if ('nb' in patch && patch.nb !== cur.nb && !('note' in patch)) want.note = null;
  if (!want.nb) want.note = null;
  for (const k of ['owner', 'nb', 'note'] as const) {
    if (want[k]) next.set(k, want[k] as string); else next.delete(k);
  }
  return next;
}

export type MobileStep = 'notebooks' | 'notes' | 'editor';

/** Below lg the workspace shows one pane at a time: what the URL opened last. */
export const mobileStep = (s: NotesUrlState): MobileStep => (s.note ? 'editor' : s.nb ? 'notes' : 'notebooks');

/** One step up (the ← button): editor → notes → notebooks. */
export function parentState(s: NotesUrlState): Partial<NotesUrlState> {
  if (s.note) return { note: null };
  if (s.nb) return { nb: null, note: null };
  return {};
}

// ── the /personal-list tabs ──────────────────────────────────────────────────

export const PERSONAL_LIST_TABS = ['mine', 'notes', 'expiring', 'agents', 'agent-notes'] as const;
export type PersonalListTab = (typeof PERSONAL_LIST_TABS)[number];
const STAFF_TABS: ReadonlySet<string> = new Set(['expiring', 'agents', 'agent-notes']);

/**
 * `?tab=` (mine · notes · expiring · agents · agent-notes); the old `?expiring=1` link still
 * opens Истекуваат. The admin / manager tabs fall back to "mine" for everyone else.
 */
export function personalListTab(params: URLSearchParams, staff: boolean): PersonalListTab {
  const asked = params.get('tab');
  if (asked && (PERSONAL_LIST_TABS as readonly string[]).includes(asked) && (staff || !STAFF_TABS.has(asked))) {
    return asked as PersonalListTab;
  }
  if (staff && params.get('expiring') === '1') return 'expiring';
  return 'mine';
}

// ── the autosave's status ───────────────────────────────────────────────────

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export type SaveEvent =
  | { type: 'edit' }
  | { type: 'send' }
  | { type: 'ok'; pendingAfter: boolean }
  | { type: 'fail' }
  | { type: 'conflict' }
  | { type: 'take_theirs' }
  | { type: 'keep_mine' };

/**
 * The save line's state. A conflict holds until the person chooses ("Земи ја новата" =
 * saved with the server's text, "Задржи ја мојата" = dirty, sent again on the new version);
 * an error holds until the next edit, blur or "обиди се повторно".
 */
export function nextSaveStatus(s: SaveStatus, e: SaveEvent): SaveStatus {
  if (s === 'conflict' && e.type !== 'take_theirs' && e.type !== 'keep_mine') return 'conflict';
  switch (e.type) {
    case 'edit': return 'dirty';
    case 'send': return 'saving';
    case 'ok': return e.pendingAfter ? 'dirty' : 'saved';
    case 'fail': return 'error';
    case 'conflict': return 'conflict';
    case 'take_theirs': return 'saved';
    case 'keep_mine': return 'dirty';
  }
}

/** The i18n key of the save line (personalNotes.save.*), or null when there is nothing to say. */
export function saveStatusKey(s: SaveStatus): string | null {
  switch (s) {
    case 'dirty': return 'personalNotes.save.unsaved';
    case 'saving': return 'personalNotes.save.saving';
    case 'saved': return 'personalNotes.save.saved';
    case 'error': return 'personalNotes.save.failed';
    case 'conflict': return 'personalNotes.save.conflict';
    default: return null;
  }
}

/** "14:32" in the reader's clock (the note was saved on this machine). */
export function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── lists ────────────────────────────────────────────────────────────────────

/** Pinned first, then the most recently changed — the server's order, kept after local edits. */
export function sortNotes<T extends { pinned: boolean; updated_at: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0));
}

/** ids with one moved up (-1) or down (+1); unchanged at the ends. */
export function moveId(ids: string[], idToMove: string, dir: -1 | 1): string[] {
  const i = ids.indexOf(idToMove);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return ids;
  const next = [...ids];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** Code points, as the server and Postgres count them (an emoji is one). */
export const charCount = (s: string): number => Array.from(s ?? '').length;

/** 1234 → "1.234" (the Macedonian grouping, the same in every language — like the /orders counts). */
export const groupThousands = (n: number): string => new Intl.NumberFormat('de-DE').format(n);

/** The editor's counter: "1.234 / 20.000". */
export const counterText = (n: number, max: number): string => `${groupThousands(n)} / ${groupThousands(max)}`;

/**
 * A one-line excerpt of at most `max` characters — the twin of snippet() in
 * supabase/functions/api/personalNotes.ts (kept identical; model.test.ts pins the cases).
 */
export function snippet(body: string, q: string | null | undefined, max = 160): string {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  const needle = (q ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
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
  if (at < 0) return chars.slice(0, max - 1).join('').trimEnd() + '…';
  const room = max - 2;
  const start = Math.max(0, at - Math.floor((room - Array.from(needle).length) / 2));
  if (start <= 0) return chars.slice(0, max - 1).join('').trimEnd() + '…';
  const end = start + room;
  if (end >= chars.length) return '…' + chars.slice(chars.length - (max - 1)).join('').trimStart();
  return '…' + chars.slice(start, end).join('').trim() + '…';
}
