import { normalizeForSearch } from '@/lib/transliterate';

/**
 * The user-list filter, shared by Тим → Корисници (src/pages/UsersPage.tsx) and
 * Settings → Users & roles (the UsersTab in src/pages/SettingsPage.tsx).
 * Client-side only: GET /api/users returns every profile (about 50–100 rows).
 *
 * SEARCH — every word of the query must be found in the full name or the
 * e-mail, in any order, ignoring case and accents. Cyrillic and Latin meet
 * through normalizeForSearch() (src/lib/transliterate.ts). A word may match in
 * any of three spellings, so the usual ways of writing a Macedonian name in
 * Latin all find it:
 *
 *   'ts'    — normalizeForSearch as it is, ц = ts   Ружица → ruzhitsa
 *   'c'     — the Macedonian romanisation, ц = c    Ружица → ruzhica
 *   'plain' — Latin accents dropped                 Ružica → ruzica
 *
 * In 'ts' and 'c' a Latin letter with a caron or an acute counts as its digraph
 * (Ž = zh, Č = ch, Š = sh, Ǵ = gj, Ḱ = kj, Đ = dj), so "Žaklina" finds "Жаклина"
 * and "Кочовска" finds "Kočovska". No letter is ever merged with another:
 * ч ≠ ц, ж ≠ з, ш ≠ с. That merging is normalizeMkGeo()'s job, for place names
 * only — transliterate.ts forbids it for people. So "zaklina" finds "Zaklina",
 * not "Жаклина"; typed without the h those are different people here.
 */

export type UserStatusFilter = 'all' | 'active' | 'suspended';

export interface UserFilterState {
  /** Free text; every whitespace-separated word must match the name or the e-mail. */
  query: string;
  /** Roles to show. Empty = every role; several = a user holding ANY of them. */
  roles: string[];
  status: UserStatusFilter;
  /** Only the people online now (last_seen_at within ONLINE_WINDOW_MS). */
  online: boolean;
}

export const EMPTY_USER_FILTERS: UserFilterState = { query: '', roles: [], status: 'all', online: false };

/** The fields the filter reads. Both screens' rows satisfy it. */
export interface FilterableUser {
  full_name?: string | null;
  email?: string | null;
  roles?: readonly string[] | null;
  is_active?: boolean | null;
  /** profiles.last_seen_at — bumped by the app's heartbeat while it is open. */
  last_seen_at?: string | null;
}

/** "Online" = seen within 2 minutes: the rule of GET /agents/online. */
export const ONLINE_WINDOW_MS = 2 * 60_000;

export function isUserOnline(u: Pick<FilterableUser, 'last_seen_at'>, now: number): boolean {
  const t = u.last_seen_at ? Date.parse(u.last_seen_at) : NaN;
  return Number.isFinite(t) && now - t < ONLINE_WINDOW_MS;
}

type Spelling = 'ts' | 'c' | 'plain';
const SPELLINGS: readonly Spelling[] = ['ts', 'c', 'plain'];
type Keys = Record<Spelling, string>;

/**
 * Latin letters (after lower-casing) that stand for a Macedonian letter the
 * search spells with two: [the digraph spelling, the accent-free spelling].
 * Every other accent is simply dropped (é → e, ç → c, ë → e, ć → c).
 */
const LATIN_MK: Record<string, [string, string]> = {
  'š': ['sh', 's'],
  'č': ['ch', 'c'],
  'ž': ['zh', 'z'],
  'ǵ': ['gj', 'g'],
  'ḱ': ['kj', 'k'],
  'đ': ['dj', 'd'],
};

// Unicode combining marks. Written as escapes: the literal characters are
// invisible in an editor (see transliterate.ts).
const COMBINING_MARKS = /[̀-ͯ]/g;

/** One code point → its search spelling. Never merges two letters. */
function foldChar(ch: string, spelling: Spelling): string {
  if (spelling !== 'ts' && (ch === 'ц' || ch === 'Ц')) return 'c';
  const lower = normalizeForSearch(ch); // Cyrillic → Latin digraphs, lower case
  const mk = LATIN_MK[lower];
  if (mk) return spelling === 'plain' ? mk[1] : mk[0];
  return lower.normalize('NFD').replace(COMBINING_MARKS, '');
}

/**
 * Code points in NFC, so "г" + a combining acute is the one letter "ѓ" and
 * "Z" + a combining caron is "Ž". Folding one code point at a time keeps every
 * key character traceable to its source character (see highlightParts).
 */
function codePoints(s: string): string[] {
  return Array.from(s.normalize('NFC'));
}

function foldAll(s: string): Keys {
  const chars = codePoints(s);
  const fold = (spelling: Spelling) => chars.map((ch) => foldChar(ch, spelling)).join('');
  return { ts: fold('ts'), c: fold('c'), plain: fold('plain') };
}

/** The query's words, each in the three spellings. Blank words are dropped, repeats merged. */
export function queryWords(query: string | null | undefined): Keys[] {
  const seen = new Set<string>();
  const out: Keys[] = [];
  for (const word of (query ?? '').split(/\s+/)) {
    if (!word) continue;
    const keys = foldAll(word);
    if (!keys.ts) continue;
    const id = `${keys.ts}\u0000${keys.c}\u0000${keys.plain}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(keys);
  }
  return out;
}

// The folded "name \n e-mail" of each row, per row object. The page keeps the
// same objects until the next fetch, so typing never re-folds the whole list.
// A newline can never be inside a query word, so no word matches across the
// two fields.
const haystacks = new WeakMap<object, Keys>();

function haystack(u: FilterableUser): Keys {
  const hit = haystacks.get(u);
  if (hit) return hit;
  const keys = foldAll(`${u.full_name ?? ''}\n${u.email ?? ''}`);
  haystacks.set(u, keys);
  return keys;
}

function matchesWords(u: FilterableUser, words: readonly Keys[]): boolean {
  if (words.length === 0) return true;
  const hay = haystack(u);
  return words.every((w) => SPELLINGS.some((s) => hay[s].includes(w[s])));
}

/** True when `query` matches the user's name or e-mail (every word, any spelling). */
export function userMatchesQuery(u: FilterableUser, query: string): boolean {
  return matchesWords(u, queryWords(query));
}

/**
 * The rows that pass the search, the role chips, the status and "online only",
 * in their original order. Always a new array (safe to sort in place).
 * `now` decides who is online (default: this moment).
 */
export function filterUsers<T extends FilterableUser>(
  users: readonly T[],
  filters: Partial<UserFilterState> = {},
  now: number = Date.now(),
): T[] {
  const words = queryWords(filters.query);
  const roles = filters.roles ?? [];
  const status = filters.status ?? 'all';
  return users.filter((u) => {
    if (status !== 'all' && (status === 'active') !== !!u.is_active) return false;
    if (roles.length > 0 && !roles.some((r) => u.roles?.includes(r))) return false;
    if (filters.online && !isUserOnline(u, now)) return false;
    return matchesWords(u, words);
  });
}

// ── Sorting ──────────────────────────────────────────────────────────────────

export type UserSortKey = 'name' | 'last' | 'orders' | 'created';
export type SortDir = 'asc' | 'desc';
export interface UserSort { key: UserSortKey; dir: SortDir }

export const USER_SORT_KEYS: readonly UserSortKey[] = ['name', 'last', 'orders', 'created'];
export const DEFAULT_USER_SORT: UserSort = { key: 'name', dir: 'asc' };
/** A key's first direction: names A→Z, everything else biggest / newest first. */
export const defaultDir = (key: UserSortKey): SortDir => (key === 'name' ? 'asc' : 'desc');

export interface SortableUser extends FilterableUser {
  orders_processed?: number | null;
  created_at?: string | null;
}

const time = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

/**
 * A sorted COPY. Names compare the Macedonian way, case- and accent-blind.
 * Someone never seen (no last_seen_at) is last in either direction; ties go by name.
 */
export function sortUsers<T extends SortableUser>(rows: readonly T[], sort: UserSort = DEFAULT_USER_SORT): T[] {
  const byName = (a: T, b: T) =>
    (a.full_name ?? '').localeCompare(b.full_name ?? '', 'mk', { sensitivity: 'base' })
    || (a.email ?? '').localeCompare(b.email ?? '');
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'last': {
        const ta = time(a.last_seen_at), tb = time(b.last_seen_at);
        if (ta == null || tb == null) return ta == null && tb == null ? byName(a, b) : ta == null ? 1 : -1;
        return sign * (ta - tb) || byName(a, b);
      }
      case 'orders':
        return sign * ((a.orders_processed ?? 0) - (b.orders_processed ?? 0)) || byName(a, b);
      case 'created':
        return sign * ((time(a.created_at) ?? 0) - (time(b.created_at) ?? 0)) || byName(a, b);
      default:
        return sign * byName(a, b);
    }
  });
}

/** The next sort after a click on `key`: the same key flips, a new key starts in its own direction. */
export function nextSort(current: UserSort, key: UserSortKey): UserSort {
  return current.key === key ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultDir(key) };
}

/** How many users hold each role (a user counts once per role). Roles nobody holds are absent. */
export function roleCounts(users: readonly FilterableUser[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of users) {
    for (const r of new Set(u.roles ?? [])) out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

export function hasActiveFilters(f: UserFilterState): boolean {
  return f.query.trim() !== '' || f.roles.length > 0 || f.status !== 'all' || f.online;
}

/** The order the role chips are shown in; a role not listed here follows, A→Z. */
export const ROLE_ORDER: readonly string[] = [
  'admin', 'manager', 'pending_agent', 'prediction_agent', 'agent', 'inbound_agent', 'warehouse', 'ads_admin', 'affiliate',
];

/** The role chips to show: every role someone holds, plus any chip already selected (so it can be switched off). */
export function roleChips(counts: Record<string, number>, selected: readonly string[] = []): string[] {
  const present = new Set([...Object.keys(counts).filter((r) => counts[r] > 0), ...selected]);
  const known = ROLE_ORDER.filter((r) => present.has(r));
  const other = [...present].filter((r) => !ROLE_ORDER.includes(r)).sort();
  return [...known, ...other];
}

// ── URL: ?q=…&role=…&role=…&status=…&online=1&sort=…&dir=… ─────────────────

const ROLE_PARAM = /^[a-z][a-z_]*$/;

/** Reads the filters from the URL. Unknown values fall back to "no filter". */
export function readUserFilterParams(sp: URLSearchParams): UserFilterState {
  const roles = sp.getAll('role')
    .flatMap((v) => v.split(','))
    .map((r) => r.trim())
    .filter((r) => ROLE_PARAM.test(r));
  const s = sp.get('status');
  const status: UserStatusFilter = s === 'active' ? 'active' : s === 'suspended' || s === 'inactive' ? 'suspended' : 'all';
  return { query: sp.get('q') ?? '', roles: [...new Set(roles)], status, online: sp.get('online') === '1' };
}

/** Reads the sort from the URL (a key without a direction takes its own default). */
export function readUserSortParams(sp: URLSearchParams): UserSort {
  const key = sp.get('sort') as UserSortKey | null;
  if (!key || !USER_SORT_KEYS.includes(key)) return DEFAULT_USER_SORT;
  const dir = sp.get('dir');
  return { key, dir: dir === 'asc' || dir === 'desc' ? dir : defaultDir(key) };
}

/** Writes the sort into a COPY of `prev`; the default sort leaves the URL clean. */
export function writeUserSortParams(prev: URLSearchParams, sort: UserSort): URLSearchParams {
  const sp = new URLSearchParams(prev);
  if (sort.key === DEFAULT_USER_SORT.key && sort.dir === DEFAULT_USER_SORT.dir) {
    sp.delete('sort');
    sp.delete('dir');
  } else {
    sp.set('sort', sort.key);
    sp.set('dir', sort.dir);
  }
  return sp;
}

/** Writes the given filters into a COPY of `prev`; a filter left out keeps its value, an empty one is removed. */
export function writeUserFilterParams(prev: URLSearchParams, next: Partial<UserFilterState>): URLSearchParams {
  const sp = new URLSearchParams(prev);
  if (next.query !== undefined) {
    if (next.query.trim()) sp.set('q', next.query);
    else sp.delete('q');
  }
  if (next.roles !== undefined) {
    sp.delete('role');
    for (const r of next.roles) sp.append('role', r);
  }
  if (next.status !== undefined) {
    if (next.status === 'all') sp.delete('status');
    else sp.set('status', next.status);
  }
  if (next.online !== undefined) {
    if (next.online) sp.set('online', '1');
    else sp.delete('online');
  }
  return sp;
}

// ── Highlighting ─────────────────────────────────────────────────────────────

export interface HighlightPart {
  text: string;
  hit: boolean;
}

/**
 * Splits `text` into runs, marking every character a query word matched in
 * any spelling ("ivana" marks "Ивана" in "Ивана Петровска"). The text comes
 * back in NFC, which looks the same.
 */
export function highlightParts(text: string | null | undefined, query: string): HighlightPart[] {
  const chars = codePoints(text ?? '');
  if (chars.length === 0) return [];
  const words = queryWords(query);
  if (words.length === 0) return [{ text: chars.join(''), hit: false }];

  const hit = new Array<boolean>(chars.length).fill(false);
  const empty = new Array<boolean>(chars.length).fill(false);
  for (const spelling of SPELLINGS) {
    // key = the folded text; owner[k] = the source character of key[k].
    let key = '';
    const owner: number[] = [];
    chars.forEach((ch, i) => {
      const f = foldChar(ch, spelling);
      if (!f) empty[i] = true;
      key += f;
      for (let k = 0; k < f.length; k++) owner.push(i);
    });
    for (const w of words) {
      const needle = w[spelling];
      if (!needle) continue;
      for (let at = key.indexOf(needle); at !== -1; at = key.indexOf(needle, at + 1)) {
        for (let k = at; k < at + needle.length; k++) hit[owner[k]] = true;
      }
    }
  }

  const parts: HighlightPart[] = [];
  chars.forEach((ch, i) => {
    // A character that folds to nothing (a stray combining mark) follows its neighbour.
    const h = empty[i] && i > 0 ? hit[i - 1] : hit[i];
    hit[i] = h;
    const last = parts[parts.length - 1];
    if (last && last.hit === h) last.text += ch;
    else parts.push({ text: ch, hit: h });
  });
  return parts;
}
