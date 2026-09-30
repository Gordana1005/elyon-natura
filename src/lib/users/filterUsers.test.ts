import { describe, expect, it } from 'vitest';
import {
  filterUsers, hasActiveFilters, highlightParts, isUserOnline, nextSort, readUserFilterParams, readUserSortParams,
  roleChips, roleCounts, sortUsers, userMatchesQuery, writeUserFilterParams, writeUserSortParams,
  DEFAULT_USER_SORT, EMPTY_USER_FILTERS,
} from './filterUsers';

const u = (full_name: string, email: string, roles: string[], is_active = true) => ({ full_name, email, roles, is_active });

const USERS = [
  u('Ивана Петровска', 'ivana.p@elyon-mk.local', ['pending_agent']),
  u('Ivana Stojanova', 'ivana.s@elyon-mk.local', ['prediction_agent']),
  u('Ruzhica Parizovska', 'ruzhica@elyon-mk.local', ['pending_agent'], false),
  u('Жаклина Богатинова', 'zhaklina@elyon-mk.local', ['manager', 'prediction_agent']),
  u('Zaklina Denik', 'zaklina.d@elyon-mk.local', ['pending_agent']),
  u('Ѓорѓи Кочовски', 'gjorgji@elyon-mk.local', ['warehouse']),
  u('Mile Stoev', 'mile@elyon.com', ['admin']),
];
const names = (rows: { full_name: string }[]) => rows.map((r) => r.full_name);

describe('filterUsers — search, Cyrillic ⇄ Latin', () => {
  it('Latin finds Cyrillic and Cyrillic finds Latin', () => {
    expect(names(filterUsers(USERS, { query: 'ivana' }))).toEqual(['Ивана Петровска', 'Ivana Stojanova']);
    expect(names(filterUsers(USERS, { query: 'Ивана' }))).toEqual(['Ивана Петровска', 'Ivana Stojanova']);
    expect(names(filterUsers(USERS, { query: 'petrovska' }))).toEqual(['Ивана Петровска']);
    expect(names(filterUsers(USERS, { query: 'Стојанова' }))).toEqual(['Ivana Stojanova']);
  });

  it('ignores case and accents', () => {
    expect(names(filterUsers(USERS, { query: 'IVANA PETROVSKA' }))).toEqual(['Ивана Петровска']);
    // Ž = zh for Cyrillic, and without its accent it is the Latin "Zaklina" too.
    expect(names(filterUsers(USERS, { query: 'Žaklina' }))).toEqual(['Жаклина Богатинова', 'Zaklina Denik']);
    expect(names(filterUsers(USERS, { query: 'Kočovski' }))).toEqual(['Ѓорѓи Кочовски']);
    expect(userMatchesQuery(u('Émilie Kočovska', 'e@x.mk', []), 'emilie kocovska')).toBe(true);
  });

  it('writes ц as ts or as c, and the Macedonian letters as digraphs', () => {
    expect(names(filterUsers(USERS, { query: 'Ружица' }))).toEqual(['Ruzhica Parizovska']);
    expect(userMatchesQuery(u('Љубица Цветковска', 'lj@x.mk', []), 'ljubica cvetkovska')).toBe(true);
    expect(userMatchesQuery(u('Љубица Цветковска', 'lj@x.mk', []), 'ljubitsa tsvetkovska')).toBe(true);
    expect(names(filterUsers(USERS, { query: 'gjorgji' }))).toEqual(['Ѓорѓи Кочовски']);
    // "г" + a combining acute is the letter "ѓ"
    expect(names(filterUsers(USERS, { query: 'ѓорѓи' }))).toEqual(['Ѓорѓи Кочовски']);
  });

  it('never merges two letters: zaklina ≠ Жаклина, ч ≠ ц', () => {
    expect(names(filterUsers(USERS, { query: 'zaklina' }))).toEqual(['Zaklina Denik']);
    expect(names(filterUsers(USERS, { query: 'zhaklina' }))).toEqual(['Жаклина Богатинова']);
    expect(userMatchesQuery(u('Цвета', 'c@x.mk', []), 'chveta')).toBe(false);
  });

  it('multi-word: every word must match, in any order, in the name or the e-mail', () => {
    expect(names(filterUsers(USERS, { query: 'petrovska ivana' }))).toEqual(['Ивана Петровска']);
    expect(names(filterUsers(USERS, { query: '  ivana   stoj ' }))).toEqual(['Ivana Stojanova']);
    expect(names(filterUsers(USERS, { query: 'ivana elyon-mk' }))).toEqual(['Ивана Петровска', 'Ivana Stojanova']);
    expect(names(filterUsers(USERS, { query: 'ivana nobody' }))).toEqual([]);
    expect(names(filterUsers(USERS, { query: 'mile@elyon.com' }))).toEqual(['Mile Stoev']);
  });

  it('a blank query filters nothing and keeps the order', () => {
    expect(filterUsers(USERS, { query: '   ' })).toEqual(USERS);
    expect(filterUsers(USERS)).not.toBe(USERS);
  });

  it('survives missing fields', () => {
    const odd = [{ full_name: null, email: null, roles: null, is_active: null }];
    expect(filterUsers(odd, { query: 'x' })).toEqual([]);
    expect(filterUsers(odd, {})).toEqual(odd);
  });
});

describe('filterUsers — roles and status', () => {
  it('one role chip shows its holders; several show a holder of ANY of them', () => {
    expect(names(filterUsers(USERS, { roles: ['manager'] }))).toEqual(['Жаклина Богатинова']);
    expect(names(filterUsers(USERS, { roles: ['admin', 'warehouse'] }))).toEqual(['Ѓорѓи Кочовски', 'Mile Stoev']);
    expect(filterUsers(USERS, { roles: [] })).toHaveLength(USERS.length);
  });

  it('status: active / suspended / all', () => {
    expect(names(filterUsers(USERS, { status: 'suspended' }))).toEqual(['Ruzhica Parizovska']);
    expect(filterUsers(USERS, { status: 'active' })).toHaveLength(USERS.length - 1);
    expect(filterUsers(USERS, { status: 'all' })).toHaveLength(USERS.length);
  });

  it('combines search, roles and status', () => {
    expect(names(filterUsers(USERS, { query: 'ivana', roles: ['pending_agent'] }))).toEqual(['Ивана Петровска']);
    expect(names(filterUsers(USERS, { query: 'ruzhica', status: 'active' }))).toEqual([]);
    expect(names(filterUsers(USERS, { roles: ['pending_agent'], status: 'suspended' }))).toEqual(['Ruzhica Parizovska']);
  });

  it('online = seen within 2 minutes of `now`', () => {
    const now = Date.parse('2026-09-30T12:00:00Z');
    const seen = (iso: string | null) => ({ ...u(`at ${iso}`, 'x@x.mk', ['admin']), last_seen_at: iso });
    const rows = [seen('2026-09-30T11:59:30Z'), seen('2026-09-30T11:57:59Z'), seen(null), seen('garbage')];
    expect(rows.map((r) => isUserOnline(r, now))).toEqual([true, false, false, false]);
    expect(names(filterUsers(rows, { online: true }, now))).toEqual(['at 2026-09-30T11:59:30Z']);
    expect(filterUsers(rows, { online: false }, now)).toHaveLength(4);
  });
});

describe('sortUsers', () => {
  const rows = [
    { full_name: 'Зоран', email: 'z@x.mk', orders_processed: 5, created_at: '2026-01-02T00:00:00Z', last_seen_at: null },
    { full_name: 'ана', email: 'a@x.mk', orders_processed: 50, created_at: '2026-03-01T00:00:00Z', last_seen_at: '2026-09-30T10:00:00Z' },
    { full_name: 'Бојан', email: 'b@x.mk', orders_processed: 5, created_at: '2025-12-01T00:00:00Z', last_seen_at: '2026-09-30T11:00:00Z' },
  ];
  const order = (s: Parameters<typeof sortUsers>[1]) => sortUsers(rows, s).map((r) => r.full_name);

  it('names A→Z by default, case-blind; the input is not touched', () => {
    expect(order(DEFAULT_USER_SORT)).toEqual(['ана', 'Бојан', 'Зоран']);
    expect(rows[0].full_name).toBe('Зоран');
  });
  it('last activity: newest first, never-seen last in both directions', () => {
    expect(order({ key: 'last', dir: 'desc' })).toEqual(['Бојан', 'ана', 'Зоран']);
    expect(order({ key: 'last', dir: 'asc' })).toEqual(['ана', 'Бојан', 'Зоран']);
  });
  it('orders (ties by name) and created', () => {
    expect(order({ key: 'orders', dir: 'desc' })).toEqual(['ана', 'Бојан', 'Зоран']);
    expect(order({ key: 'created', dir: 'desc' })).toEqual(['ана', 'Зоран', 'Бојан']);
  });
  it('a click flips the same key, a new key starts in its own direction', () => {
    expect(nextSort(DEFAULT_USER_SORT, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort(DEFAULT_USER_SORT, 'orders')).toEqual({ key: 'orders', dir: 'desc' });
  });
});

describe('roleCounts / roleChips', () => {
  it('counts every holder once per role', () => {
    const counts = roleCounts([...USERS, u('Dup', 'd@x.mk', ['admin', 'admin'])]);
    expect(counts).toEqual({ pending_agent: 3, prediction_agent: 2, manager: 1, warehouse: 1, admin: 2 });
  });

  it('shows held roles in the house order, plus a selected one nobody holds', () => {
    expect(roleChips(roleCounts(USERS))).toEqual(['admin', 'manager', 'pending_agent', 'prediction_agent', 'warehouse']);
    expect(roleChips({ admin: 1, zeta: 2 }, ['ads_admin'])).toEqual(['admin', 'ads_admin', 'zeta']);
  });
});

describe('URL state', () => {
  it('reads q / role / status / online, tolerating junk', () => {
    const sp = new URLSearchParams('q=ivana&role=manager&role=admin,pending_agent&role=DROP;TABLE&status=suspended&online=1');
    expect(readUserFilterParams(sp)).toEqual({ query: 'ivana', roles: ['manager', 'admin', 'pending_agent'], status: 'suspended', online: true });
    expect(readUserFilterParams(new URLSearchParams('status=weird&online=yes'))).toEqual(EMPTY_USER_FILTERS);
  });

  it('writes a copy, drops empty values and round-trips', () => {
    const prev = new URLSearchParams('tab=x&q=old');
    const next = writeUserFilterParams(prev, { query: 'Ивана П', roles: ['admin', 'manager'], status: 'active', online: true });
    expect(prev.toString()).toBe('tab=x&q=old');
    expect(readUserFilterParams(next)).toEqual({ query: 'Ивана П', roles: ['admin', 'manager'], status: 'active', online: true });
    expect(next.get('tab')).toBe('x');
    const cleared = writeUserFilterParams(next, EMPTY_USER_FILTERS);
    expect(cleared.toString()).toBe('tab=x');
    expect(writeUserFilterParams(prev, { query: '   ' }).has('q')).toBe(false);
  });

  it('hasActiveFilters', () => {
    expect(hasActiveFilters(EMPTY_USER_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_USER_FILTERS, query: '  ' })).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_USER_FILTERS, roles: ['admin'] })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_USER_FILTERS, status: 'suspended' })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_USER_FILTERS, online: true })).toBe(true);
  });

  it('sort: reads junk as the default, writes nothing for the default', () => {
    expect(readUserSortParams(new URLSearchParams('sort=orders'))).toEqual({ key: 'orders', dir: 'desc' });
    expect(readUserSortParams(new URLSearchParams('sort=last&dir=asc'))).toEqual({ key: 'last', dir: 'asc' });
    expect(readUserSortParams(new URLSearchParams('sort=salary&dir=up'))).toEqual(DEFAULT_USER_SORT);
    expect(writeUserSortParams(new URLSearchParams('q=a&sort=orders&dir=desc'), DEFAULT_USER_SORT).toString()).toBe('q=a');
    expect(writeUserSortParams(new URLSearchParams(), { key: 'created', dir: 'asc' }).toString()).toBe('sort=created&dir=asc');
  });
});

describe('highlightParts', () => {
  const marked = (text: string, q: string) => highlightParts(text, q).filter((p) => p.hit).map((p) => p.text);

  it('marks the Cyrillic letters a Latin query matched, and the reverse', () => {
    expect(marked('Ивана Петровска', 'ivana')).toEqual(['Ивана']);
    expect(marked('Ivana Stojanova', 'Ивана')).toEqual(['Ivana']);
    expect(marked('Жаклина Богатинова', 'zhak bog')).toEqual(['Жак', 'Бог']);
    expect(marked('Ruzhica Parizovska', 'ружица')).toEqual(['Ruzhica']);
  });

  it('gives the whole text back unmarked without a query, and nothing for nothing', () => {
    expect(highlightParts('Mile Stoev', '')).toEqual([{ text: 'Mile Stoev', hit: false }]);
    expect(highlightParts(null, 'x')).toEqual([]);
    expect(highlightParts('Mile Stoev', 'mile').map((p) => p.text).join('')).toBe('Mile Stoev');
  });
});
