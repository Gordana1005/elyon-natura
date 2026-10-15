import { addDaysYmd, skopjeMidnightIso, skopjeYmd } from '@/lib/skopjeTime';
import type { NotificationRow } from './localize';
import { isStackType, matchesFilter, specOf, type NotifFilter } from './registry';

/** One card per stackable type per Skopje day (notifications_overview, 20261015130000). */
export interface NotifStack {
  type: string;
  day: string;
  total: number;
  unread: number;
  amountMkd: number | null;
  /** How many rows carry an amount — the sum is shown only when every row has one. */
  amountRows: number;
  latestAt: string;
  names: string[];
  /** A stack of one carries its row: it is shown as that row. */
  row: NotificationRow | null;
}

export interface NotifOverview {
  /** Everything created at or before this instant counts as read ("Означи ги сите"). */
  readBefore: string | null;
  /** Unread per type over ALL of the person's notifications. */
  unread: Record<string, number>;
  stacks: NotifStack[];
}

export const EMPTY_OVERVIEW: NotifOverview = { readBefore: null, unread: {}, stacks: [] };

/** Read = is_read, or created at / before the person's watermark. */
export function isUnread(n: Pick<NotificationRow, 'is_read' | 'created_at'>, readBefore: string | null): boolean {
  if (n.is_read) return false;
  if (!readBefore) return true;
  return Date.parse(n.created_at) > Date.parse(readBefore);
}

/**
 * What the badge (and a chip) counts: each unread row of a non-stacked type, plus ONE per stack that
 * still has something unread — 400 paid orders today are one thing to look at, not 400.
 */
export function unreadCount(ov: NotifOverview, filter: NotifFilter = 'all'): number {
  let n = 0;
  for (const [type, c] of Object.entries(ov.unread)) {
    if (!isStackType(type) && matchesFilter(type, filter)) n += Number(c) || 0;
  }
  for (const s of ov.stacks) {
    if (s.unread > 0 && matchesFilter(s.type, filter)) n += 1;
  }
  return n;
}

export type FeedItem =
  | { kind: 'row'; at: string; row: NotificationRow }
  | { kind: 'stack'; at: string; stack: NotifStack };

export interface FeedDay { day: string; items: FeedItem[] }

export interface Feed {
  /** Unread important rows, newest first, shown on top ("Важно"). */
  pinned: NotificationRow[];
  /** Unread important rows beyond the pin limit (they stay in their day). */
  pinnedMore: number;
  days: FeedDay[];
}

/**
 * The bell / the page: non-stacked rows + the stacks → "Важно" on top, then the days, newest first.
 * A stack of one is shown as its row. Rows of a stackable type that reach here (should not happen —
 * they are fetched as stacks) are kept as rows rather than dropped.
 */
export function buildFeed({
  rows, stacks, readBefore, filter = 'all', pinLimit = 5,
}: {
  rows: NotificationRow[];
  stacks: NotifStack[];
  readBefore: string | null;
  filter?: NotifFilter;
  pinLimit?: number;
}): Feed {
  const seen = new Set<string>();
  const ownRows = rows.filter((r) => {
    if (seen.has(r.id) || !matchesFilter(r.type, filter)) return false;
    seen.add(r.id);
    return true;
  });

  const pinCandidates = filter === 'all'
    ? ownRows.filter((r) => specOf(r.type).important && isUnread(r, readBefore))
    : [];
  const pinned = pinCandidates.slice(0, pinLimit);
  const pinnedIds = new Set(pinned.map((r) => r.id));

  const items: FeedItem[] = [];
  for (const r of ownRows) {
    if (!pinnedIds.has(r.id)) items.push({ kind: 'row', at: r.created_at, row: r });
  }
  for (const s of stacks) {
    if (!matchesFilter(s.type, filter)) continue;
    if (s.total === 1 && s.row) {
      if (seen.has(s.row.id)) continue;
      seen.add(s.row.id);
      items.push({ kind: 'row', at: s.row.created_at, row: s.row });
    } else {
      items.push({ kind: 'stack', at: s.latestAt, stack: s });
    }
  }
  items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const byDay = new Map<string, FeedItem[]>();
  for (const it of items) {
    const day = it.kind === 'stack' ? it.stack.day : skopjeYmd(it.at);
    const list = byDay.get(day);
    if (list) list.push(it);
    else byDay.set(day, [it]);
  }
  const days: FeedDay[] = [...byDay.entries()]
    .map(([day, list]) => ({ day, items: list }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));

  return { pinned, pinnedMore: Math.max(0, pinCandidates.length - pinned.length), days };
}

/** The first `n` distinct names, in the order given (newest first). */
export function uniqueNames(names: (string | null | undefined)[], n = 3): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const s = (raw ?? '').trim();
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= n) break;
  }
  return out;
}

/** [from, to) of a Skopje day, as UTC instants. */
export function skopjeDayBounds(day: string): { from: string; to: string } {
  return { from: skopjeMidnightIso(day), to: skopjeMidnightIso(addDaysYmd(day, 1)) };
}

/** The stack total in денари, or null when some rows carry no amount (never a partial sum). */
export function stackAmount(s: NotifStack): number | null {
  if (s.amountMkd == null || s.amountRows <= 0 || s.amountRows < s.total) return null;
  return Number(s.amountMkd);
}
