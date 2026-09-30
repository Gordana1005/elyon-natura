import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDaysYmd, apiGetLeaderboardV2, BOARD_FIRST_DAY, boardDay, bookedChips, conversionPct, daysBetween, deptChips,
  initialFilter, rankRows, splitManagers, toBoardV2, webConfirmed, type BoardRow,
} from './leaderboardV2';

const presence = { state: 'offline' as const, online_min: 0, active_min: 0, idle_min: 0, break_min: 0, first_seen: null, last_seen: null,
  first_active: null, last_active: null, idle_alerts: 0, idle_streak_min: null, first_login: null };
const cell = (over: Partial<BoardRow['departments'][keyof BoardRow['departments']]> = {}) => ({
  sales: 0, value_mkd: 0, booked: 0, booked_value_mkd: 0, booked_twin: 0, booked_twin_value_mkd: 0,
  cancelled_after_sale: 0, cancelled_value_mkd: 0, returned: 0, live_credited: 0, worked: 0, sale_decisions: 0, ...over,
});
const row = (over: Partial<BoardRow>): BoardRow => ({
  person_id: 'p', user_id: null, name: 'X', team_key: null, team_name: null, is_member: false, is_manager: false, rank: null,
  sales: 0, value_mkd: 0, booked: 0, booked_value_mkd: 0, total_count: 0, total_value_mkd: 0, cancelled_after_sale: 0,
  cancelled_value_mkd: 0, returned: 0, live_credited: 0, booked_twin: 0, booked_twin_value_mkd: 0, worked: 0,
  sale_decisions: 0, cancelled: 0, trashed: 0, callbacks: 0, conversion: null, last_decision_at: null, departments: {},
  presence, ...over,
});

describe('deptChips / bookedChips', () => {
  const r = row({
    departments: {
      teleshop_other: cell({ booked: 4, booked_value_mkd: 9600 }),
      elyon_crm: cell({ sales: 3, value_mkd: 9000, booked_twin: 3 }),
      altercpa: cell({ sales: 1, value_mkd: 2400 }),
      social: cell({ worked: 5 }),
    },
  });
  it('one chip per department with a sale, in the owner order; bookings apart', () => {
    expect(deptChips(r)).toEqual([
      { dept: 'altercpa', sales: 1, value_mkd: 2400 },
      { dept: 'elyon_crm', sales: 3, value_mkd: 9000 },
    ]);
    expect(bookedChips(r)).toEqual([{ dept: 'teleshop_other', booked: 4, value_mkd: 9600 }]);
  });
  it('only the filter department when one is chosen', () => {
    expect(deptChips(r, 'elyon_crm')).toEqual([{ dept: 'elyon_crm', sales: 3, value_mkd: 9000 }]);
    expect(bookedChips(r, 'elyon_crm')).toEqual([]);
  });
});

describe('rankRows', () => {
  it('ranks non-managers by денари then count, equal numbers share a place, managers last', () => {
    const out = rankRows([
      row({ person_id: 'm', name: 'Manager', is_manager: true, total_count: 9, total_value_mkd: 99000 }),
      row({ person_id: 'z', name: 'Zero', worked: 4 }),
      row({ person_id: 'a', name: 'Ana', total_count: 2, total_value_mkd: 5000 }),
      row({ person_id: 'b', name: 'Bea', total_count: 2, total_value_mkd: 5000 }),
      row({ person_id: 'c', name: 'Cvet', total_count: 5, total_value_mkd: 12000 }),
      row({ person_id: 'd', name: 'Dana', total_count: 3, total_value_mkd: 5000 }),
    ]);
    expect(out.map((r) => [r.person_id, r.rank])).toEqual([
      ['c', 1], ['d', 2], ['a', 3], ['b', 3], ['z', null], ['m', null],
    ]);
  });
  it('never mutates its input', () => {
    const input = [row({ person_id: 'a', total_count: 1, total_value_mkd: 1 })];
    rankRows(input);
    expect(input[0].rank).toBeNull();
  });
});

describe('splitManagers / conversionPct', () => {
  it('managers go after everyone else', () => {
    const { people, managers } = splitManagers([row({ person_id: 'm', is_manager: true }), row({ person_id: 'a' })]);
    expect(people.map((r) => r.person_id)).toEqual(['a']);
    expect(managers.map((r) => r.person_id)).toEqual(['m']);
  });
  it('conversion 0–1 → one-decimal percent', () => {
    expect(conversionPct({ conversion: 0.3548 })).toBe(35.5);
    expect(conversionPct({ conversion: null })).toBeNull();
  });
});

describe('initialFilter', () => {
  const f = (qs: string) => initialFilter(new URLSearchParams(qs));
  it('pins a department and / or a team', () => {
    expect(f('dept=teleshop_other')).toEqual({ department: 'teleshop_other', team: null });
    expect(f('department=social&team=crm_prediction')).toEqual({ department: 'social', team: 'crm_prediction' });
    expect(f('team=none')).toEqual({ department: null, team: 'none' });
  });
  it('an old ?mode= URL opens its team; unknown values are ignored', () => {
    expect(f('mode=prediction')).toEqual({ department: null, team: 'crm_prediction' });
    expect(f('mode=pending')).toEqual({ department: null, team: 'altercpa_leads' });
    expect(f('mode=pending&dept=web')).toEqual({ department: 'web', team: null });
    expect(f('dept=teleshop&team=Bad Team')).toEqual({ department: null, team: null });
  });
});

describe('toBoardV2', () => {
  it('passes a v2 payload through', () => {
    const v2 = { version: 2, day: '2026-09-28', today: '2026-09-28', rows: [row({ person_id: 'a' })], teams: [], summary: { people: 1 } };
    const b = toBoardV2(v2, { department: null, team: null });
    expect(b.legacy).toBeUndefined();
    expect(b.rows[0].person_id).toBe('a');
  });

  it('adapts the old per-mode board (api not deployed yet) — EUR → денари, one department', () => {
    const legacy = {
      generated_at: '2026-09-28T10:00:00Z', mode: 'pending', day: '2026-09-28', today: '2026-09-28', is_today: true,
      summary: { online_now: 2, unattributed_sales: 1, unattributed_value_eur: 20 },
      agents: [
        { key: 'p1', user_id: 'u1', full_name: 'Sanela', is_super: false, confirmed_count: 9, sales: 10, sold_value_eur: 400, revenue: 380,
          worked: 30, sale_decisions: 10, conversion_pct: 33.3, lost: 1, presence: { state: 'online', online_min: 60 } },
        { key: 'p2', user_id: 'u2', full_name: 'Nina', is_super: true, confirmed_count: 2, sales: 2, sold_value_eur: 80 },
        { key: 'p3', user_id: null, full_name: 'AlterCPA #4531 (unnamed)', confirmed_count: 0, sales: 0, worked: 8 },
      ],
    };
    const b = toBoardV2(legacy, { department: null, team: null });
    expect(b.legacy).toBe(true);
    expect(b.filter.department).toBe('altercpa');
    expect(b.rows.map((r) => [r.name, r.rank])).toEqual([['Sanela', 1], ['AlterCPA #4531 (unnamed)', null], ['Nina', null]]);
    expect(b.rows[0].value_mkd).toBe(24600);                 // 400 € × 61,5
    expect(b.rows[0].departments.altercpa?.sales).toBe(10);
    expect(b.rows[0].conversion).toBeCloseTo(0.333);
    expect(b.rows[0].presence.state).toBe('online');
    expect(b.rows[1].presence.state).toBe('n/a');            // no login
    expect(b.summary.no_seller).toBe(1);
    expect(b.summary.no_seller_value_mkd).toBe(1230);
  });
});

describe('apiGetLeaderboardV2', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('asks for ?v=2 with the filter and the day', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ version: 2, rows: [], teams: [], summary: {} }) }));
    vi.stubGlobal('fetch', fetchMock);
    await apiGetLeaderboardV2('k', { day: '2026-09-27', department: 'social', team: 'none' });
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.pathname.endsWith('/functions/v1/api/leaderboard')).toBe(true);
    expect(Object.fromEntries(url.searchParams)).toEqual({ key: 'k', v: '2', day: '2026-09-27', department: 'social', team: 'none' });
  });
  it('turns an api error into an Error with its message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'Unauthorized' }) })));
    await expect(apiGetLeaderboardV2('bad', { department: null, team: null })).rejects.toThrow('Unauthorized');
  });
});

describe('the day on screen (arrows + date picker)', () => {
  it('addDaysYmd / daysBetween work on calendar days, across months and the DST change', () => {
    expect(addDaysYmd('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDaysYmd('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-10-24', '2026-10-26')).toBe(2);         // Skopje DST ends 25.10
    expect(daysBetween('2026-09-30', '2026-09-29')).toBe(-1);
  });
  it('today or later is the live board (null); earlier days open as they are, never before 01.01.2026', () => {
    expect(boardDay('2026-09-30', '2026-09-30')).toBeNull();
    expect(boardDay('2026-10-02', '2026-09-30')).toBeNull();
    expect(boardDay('2026-08-19', '2026-09-30')).toBe('2026-08-19');
    expect(boardDay('2025-12-31', '2026-09-30')).toBe(BOARD_FIRST_DAY);
    expect(boardDay(BOARD_FIRST_DAY, '2026-09-30')).toBe('2026-01-01');
  });
  it('anything that is not a real day is the live board', () => {
    for (const bad of ['', null, undefined, '2026-02-31', '19.08.2026', '2026-8-19']) expect(boardDay(bad, '2026-09-30')).toBeNull();
  });
  it('webConfirmed = counted orders less the ones still waiting for the shop', () => {
    expect(webConfirmed({ orders: 22, awaiting: 14 })).toBe(8);
    expect(webConfirmed({ orders: 11 })).toBe(11);                    // an older api without `awaiting`
    expect(webConfirmed({ orders: 1, awaiting: 3 })).toBe(0);
  });
});
