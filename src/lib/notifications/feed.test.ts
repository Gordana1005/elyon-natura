import { describe, expect, it } from 'vitest';
import { buildFeed, isUnread, skopjeDayBounds, stackAmount, uniqueNames, unreadCount, type NotifOverview, type NotifStack } from './feed';
import { STACK_TYPES, matchesFilter, specOf } from './registry';
import type { NotificationRow } from './localize';

const row = (over: Partial<NotificationRow>): NotificationRow => ({
  id: 'r1', title: 't', message: '', type: 'altercpa_rate_below', is_read: false, link: null,
  created_at: '2026-10-15T08:00:00Z', meta: null, ...over,
});

const stack = (over: Partial<NotifStack>): NotifStack => ({
  type: 'order_paid', day: '2026-10-15', total: 48, unread: 12, amountMkd: 93600, amountRows: 48,
  latestAt: '2026-10-15T09:00:00Z', names: [], row: null, ...over,
});

describe('registry — what stacks, what is pinned', () => {
  it('stacks only the high-volume kinds; the guarantees, collab and shifts never stack', () => {
    expect([...STACK_TYPES].sort()).toEqual(['assignment', 'inactivity', 'order_paid', 'order_returned', 'shipped_unpaid']);
    for (const t of ['altercpa_rate', 'altercpa_rate_below', 'not_in_collab', 'not_in_collab_warning', 'shifts_runway', 'unpaid_digest']) {
      expect(specOf(t).stack).toBeFalsy();
    }
  });
  it('shifts_runway is known (it had no icon before 15.10) and a stranger falls back to system', () => {
    expect(specOf('shifts_runway').category).toBe('team');
    expect(specOf('something_new').category).toBe('system');
    expect(matchesFilter('altercpa_rate', 'affiliate')).toBe(true);
    expect(matchesFilter('altercpa_rate_below', 'important')).toBe(true);
    expect(matchesFilter('order_paid', 'important')).toBe(false);
  });
});

describe('read = is_read OR before the watermark', () => {
  it('honours the watermark', () => {
    expect(isUnread(row({}), null)).toBe(true);
    expect(isUnread(row({ is_read: true }), null)).toBe(false);
    expect(isUnread(row({ created_at: '2026-10-15T08:00:00Z' }), '2026-10-15T09:00:00Z')).toBe(false);
    expect(isUnread(row({ created_at: '2026-10-15T10:00:00Z' }), '2026-10-15T09:00:00Z')).toBe(true);
  });
});

describe('unreadCount — 400 paid orders are ONE thing to look at', () => {
  const ov: NotifOverview = {
    readBefore: null,
    unread: { order_paid: 412, order_returned: 30, altercpa_rate_below: 2, not_in_collab: 3 },
    stacks: [stack({}), stack({ type: 'order_returned', unread: 0 }), stack({ day: '2026-10-14', unread: 5 })],
  };
  it('counts each non-stacked row and one per unread stack', () => {
    expect(unreadCount(ov)).toBe(2 + 3 + 2);
    expect(unreadCount(ov, 'affiliate')).toBe(2);
    expect(unreadCount(ov, 'orders')).toBe(3 + 2);
    expect(unreadCount(ov, 'important')).toBe(5);
  });
});

describe('buildFeed', () => {
  const guarantee = row({ id: 'g', created_at: '2026-10-15T07:00:00Z' });
  const oldRead = row({ id: 'o', type: 'unpaid_digest', is_read: true, created_at: '2026-10-14T07:00:00Z' });
  const single: NotifStack = stack({
    type: 'order_returned', total: 1, unread: 1, latestAt: '2026-10-14T12:00:00Z', day: '2026-10-14',
    row: row({ id: 'ret', type: 'order_returned', created_at: '2026-10-14T12:00:00Z' }),
  });

  it('pins the unread important rows on top and groups the rest by Skopje day, newest first', () => {
    const f = buildFeed({ rows: [guarantee, oldRead], stacks: [stack({}), single], readBefore: null });
    expect(f.pinned.map((r) => r.id)).toEqual(['g']);
    expect(f.days.map((d) => d.day)).toEqual(['2026-10-15', '2026-10-14']);
    expect(f.days[0].items.map((i) => i.kind)).toEqual(['stack']);
    // a stack of one is shown as its row
    expect(f.days[1].items.map((i) => (i.kind === 'row' ? i.row.id : 'stack'))).toEqual(['ret', 'o']);
  });

  it('a filter keeps its own kinds; nothing is pinned outside "all"', () => {
    const f = buildFeed({ rows: [guarantee, oldRead], stacks: [stack({})], readBefore: null, filter: 'affiliate' });
    expect(f.pinned).toEqual([]);
    expect(f.days.flatMap((d) => d.items).map((i) => (i.kind === 'row' ? i.row.id : i.stack.type))).toEqual(['g']);
  });

  it('caps the pins and reports the rest; a read row is never pinned', () => {
    const many = [1, 2, 3].map((i) => row({ id: `p${i}`, created_at: `2026-10-15T0${i}:00:00Z` }));
    const f = buildFeed({ rows: many, stacks: [], readBefore: null, pinLimit: 2 });
    expect(f.pinned).toHaveLength(2);
    expect(f.pinnedMore).toBe(1);
    const none = buildFeed({ rows: many, stacks: [], readBefore: '2026-10-16T00:00:00Z' });
    expect(none.pinned).toEqual([]);
  });

  it('a row late in the Skopje evening belongs to that Skopje day (not the UTC one)', () => {
    const late = row({ id: 'late', type: 'unpaid_digest', created_at: '2026-10-14T22:30:00Z' }); // 00:30 on the 15th in Skopje
    const f = buildFeed({ rows: [late], stacks: [], readBefore: null });
    expect(f.days[0].day).toBe('2026-10-15');
  });
});

describe('helpers', () => {
  it('uniqueNames keeps the newest distinct names', () => {
    expect(uniqueNames(['Ана', 'Ана', null, 'Иво', 'Бобан', 'Дејан'])).toEqual(['Ана', 'Иво', 'Бобан']);
  });
  it('the stack sum is shown only when every row carries an amount', () => {
    expect(stackAmount(stack({}))).toBe(93600);
    expect(stackAmount(stack({ amountRows: 40 }))).toBeNull();
    expect(stackAmount(stack({ amountMkd: null, amountRows: 0 }))).toBeNull();
  });
  it('a Skopje day is [00:00, next 00:00) in CEST', () => {
    expect(skopjeDayBounds('2026-10-15')).toEqual({ from: '2026-10-14T22:00:00.000Z', to: '2026-10-15T22:00:00.000Z' });
  });
});
