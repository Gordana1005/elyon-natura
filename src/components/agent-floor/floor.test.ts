import { describe, it, expect } from 'vitest';
import type { AgentFloorRow } from '@/lib/api';
import { filterAgents, isLate, minutesSince, presenceSplit, sortAgents, teamTotals } from './floor';

const sales = (over: Partial<AgentFloorRow['sales']> = {}): AgentFloorRow['sales'] => ({
  sales: 0, worked: 0, booked: 0, cancelled: 0, trashed: 0, returned: 0, callbacks: 0, conversion: null, rank: null, departments: {},
  ...over,
});

function row(over: Partial<AgentFloorRow> & { user_id: string }): AgentFloorRow {
  return {
    full_name: over.user_id,
    shift_windows: [],
    breaks: [],
    calls: [],
    totals: { calls: 0, answered: 0, answer_rate: 0, talk_seconds: 0, ring_seconds: 0, first_call: null, last_call: null },
    is_manager: false,
    team: null,
    first_seen: null,
    last_seen: null,
    late_minutes: null,
    presence: null,
    login: null,
    live: null,
    sales: sales(),
    ...over,
  };
}

const live = (status: NonNullable<AgentFloorRow['live']>['status']) => ({ status, since: null });

describe('sortAgents', () => {
  it('puts agents in a call first and offline last', () => {
    const rows = [
      row({ user_id: 'off', live: live('offline') }),
      row({ user_id: 'brk', live: live('break') }),
      row({ user_id: 'call', live: live('in_call') }),
      row({ user_id: 'on', live: live('online') }),
    ];
    expect(sortAgents(rows).map((r) => r.user_id)).toEqual(['call', 'on', 'brk', 'off']);
  });

  it('breaks ties by sales, then calls', () => {
    const rows = [
      row({ user_id: 'a', sales: sales({ sales: 1 }) }),
      row({ user_id: 'b', sales: sales({ sales: 5 }) }),
      row({ user_id: 'c', sales: sales({ sales: 1 }), totals: { ...row({ user_id: 'x' }).totals, calls: 9 } }),
    ];
    expect(sortAgents(rows).map((r) => r.user_id)).toEqual(['b', 'c', 'a']);
  });
});

describe('filterAgents', () => {
  it('keeps only the chosen live status', () => {
    const rows = [row({ user_id: 'a', live: live('break') }), row({ user_id: 'b', live: live('online') })];
    expect(filterAgents(rows, 'break').map((r) => r.user_id)).toEqual(['a']);
    expect(filterAgents(rows, 'all')).toHaveLength(2);
  });
});

describe('teamTotals', () => {
  it('adds up calls, presence and sales, and counts online as not-offline', () => {
    const rows = [
      row({
        user_id: 'a', live: live('in_call'), shift_windows: [{ start: '09:00', end: '17:00' }],
        totals: { calls: 10, answered: 4, answer_rate: 0.4, talk_seconds: 400, ring_seconds: 0, first_call: null, last_call: null },
        presence: { online_minutes: 60, active_minutes: 50, idle_minutes: 5, break_minutes: 5, first_seen_at: null, last_seen_at: null, last_state: 'active', idle_streak_min: null, idle_alerts: 0 },
        sales: sales({ sales: 3, worked: 20, returned: 1, value_mkd: 4500 }),
      }),
      row({
        user_id: 'b', live: live('offline'),
        sales: sales({ sales: 1, worked: 5, value_mkd: 1500.4 }),
      }),
    ];
    const t = teamTotals(rows);
    expect(t.agents).toBe(2);
    expect(t.onShift).toBe(1);
    expect(t.online).toBe(1);
    expect(t.byStatus.in_call).toBe(1);
    expect(t.calls).toBe(10);
    expect(t.answerRate).toBeCloseTo(0.4);
    expect(t.avgTalkSeconds).toBe(100);
    expect(t.onlineMinutes).toBe(60);
    expect(t.sales).toBe(4);
    expect(t.worked).toBe(25);
    expect(t.returned).toBe(1);
    expect(t.valueMkd).toBe(6000);
  });

  it('has no value when the viewer has no money keys', () => {
    const t = teamTotals([row({ user_id: 'a', sales: sales({ sales: 2 }) })]);
    expect(t.valueMkd).toBeNull();
    expect(t.sales).toBe(2);
  });
});

describe('presenceSplit', () => {
  it('returns shares that sum to 100', () => {
    const s = presenceSplit({ online_minutes: 100, active_minutes: 70, idle_minutes: 20, break_minutes: 10, first_seen_at: null, last_seen_at: null, last_state: null, idle_streak_min: null, idle_alerts: 0 });
    expect(s).toEqual({ active: 70, idle: 20, brk: 10 });
  });
  it('is all zero with no presence', () => {
    expect(presenceSplit(null)).toEqual({ active: 0, idle: 0, brk: 0 });
  });
});

describe('minutesSince / isLate', () => {
  it('floors whole minutes and never goes negative', () => {
    const now = Date.parse('2026-11-05T10:00:00Z');
    expect(minutesSince('2026-11-05T09:57:30Z', now)).toBe(2);
    expect(minutesSince('2026-11-05T10:05:00Z', now)).toBe(0);
    expect(minutesSince(null, now)).toBe(0);
  });
  it('gives a few minutes of grace before "late"', () => {
    expect(isLate({ late_minutes: 4 })).toBe(false);
    expect(isLate({ late_minutes: 5 })).toBe(true);
    expect(isLate({ late_minutes: null })).toBe(false);
  });
});
