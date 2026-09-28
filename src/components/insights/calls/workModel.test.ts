import { describe, expect, it } from 'vitest';
import type { WorkResponse } from '@/lib/insightsApi/work';
import {
  bucketKeys, heatBin, heatBreaks, heatGrid, hoursText, isActive, kpiView, minToHm, minutesInto, outcomeCounts,
  pickDay, presenceGap, seriesFor, skopjeDayMin,
} from './workModel';

const counts = {
  worked: 0, via_crm: 0, via_altercpa: 0, sale: 0, cancel: 0, trash: 0, callback: 0, no_answer: 0, call_logs: 0,
  timed_calls: 0, handling_sec: 0, credited: 0, worked_tracked: 0, sale_tracked: 0, online_min: null, active_min: null,
  idle_min: null, break_min: null, idle_alerts: null, breaks: 0, break_logged_min: 0,
};
const rates = { conversion: null, reach: null, per_active_hour: null, sales_per_active_hour: null, avg_handling_sec: null, per_active_day: null };

const data = (): WorkResponse => ({
  meta: {
    from: '2026-09-25', to: '2026-09-27', prev_from: null, prev_to: null, prev_to_end: null, partial: false, days: 3,
    generated_at: '2026-09-28T08:00:00Z', gran: 'day', clock: 'decided', voip: false, presence_since: '2026-09-28',
    work_since: null, calls_since: null, self: false, credited: true, prev_credited: false, rate_min_active_min: 30,
  },
  totals: { ...counts, ...rates, worked: 9, sale: 3, people: 2, people_crm: 1, people_altercpa: 1, presence_people: 0, days_active: 2 },
  prev: { ...counts, ...rates, worked: 5, people: 1, presence_people: 0 },
  teams: [
    { team_key: 'altercpa_leads', name: 'Pending', mode: 'pending', totals: { ...counts, ...rates, worked: 4, people: 2, active_people: 1 }, members: [] },
    { team_key: 'crm_prediction', name: 'Prediction', mode: 'prediction', totals: { ...counts, ...rates, worked: 5, people: 1, active_people: 1 }, members: [] },
  ],
  per_day: [
    { d: '2026-09-25', team_key: 'altercpa_leads', worked: 4, sale: 2, cancel: 2, trash: 0, callback: 0, no_answer: 0, call_logs: 0, credited: 1, people: 1, online_min: null, active_min: null },
    { d: '2026-09-27', team_key: 'crm_prediction', worked: 5, sale: 1, cancel: 3, trash: 1, callback: 0, no_answer: 7, call_logs: 7, credited: 0, people: 1, online_min: 60, active_min: 40 },
    { d: '2026-09-27', team_key: '__none__', worked: 1, sale: 0, cancel: 1, trash: 0, callback: 0, no_answer: 0, call_logs: 0, credited: 0, people: 0, online_min: null, active_min: null },
  ],
  by_hour: [],
  callbacks: null,
  quality: null,
});

describe('bucketKeys', () => {
  it('days, inclusive', () => {
    expect(bucketKeys('2026-09-29', '2026-10-02', 'day')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
  it('weeks start on the Monday of the first day', () => {
    expect(bucketKeys('2026-09-03', '2026-09-20', 'week')).toEqual(['2026-08-31', '2026-09-07', '2026-09-14']);
  });
  it('an empty or reversed window has no buckets', () => {
    expect(bucketKeys('2026-09-05', '2026-09-01', 'day')).toEqual([]);
  });
});

describe('seriesFor', () => {
  it('fills every day and sums everything (incl. decisions no person owns) with no team chosen', () => {
    const s = seriesFor(data(), '');
    expect(s.map((p) => p.d)).toEqual(['2026-09-25', '2026-09-26', '2026-09-27']);
    expect(s.map((p) => p.worked)).toEqual([4, 0, 6]);
    expect(s[1].active_min).toBeNull();
    expect(s[2].active_min).toBe(40);
  });
  it('one team only', () => {
    const s = seriesFor(data(), 'crm_prediction');
    expect(s.map((p) => p.worked)).toEqual([0, 0, 5]);
    expect(s[2].no_answer).toBe(7);
  });
});

describe('kpiView', () => {
  it('the whole business compares with the previous period', () => {
    const v = kpiView(data(), '');
    expect(v.filtered).toBe(false);
    expect(v.cur?.worked).toBe(9);
    expect(v.prev?.worked).toBe(5);
  });
  it('a team reads its own totals, active people, no comparison', () => {
    const v = kpiView(data(), 'altercpa_leads');
    expect(v).toMatchObject({ filtered: true, prev: null });
    expect(v.cur?.worked).toBe(4);
    expect(v.cur?.people).toBe(1);
  });
  it('an unknown team reads nothing', () => {
    expect(kpiView(data(), 'teleshop').cur).toBeNull();
  });
});

describe('outcomes and activity', () => {
  it('outcomeCounts keeps the fixed bar order', () => {
    expect(outcomeCounts({ sale: 1, callback: 2, no_answer: 3, cancel: 4, trash: 5 }).map((x) => x.key))
      .toEqual(['sale', 'callback', 'no_answer', 'cancel', 'trash']);
  });
  it('isActive: any decision, call log, credited sale or online minute', () => {
    expect(isActive({ worked: 0, call_logs: 0, credited: 0, online_min: null })).toBe(false);
    expect(isActive({ worked: 0, call_logs: 0, credited: null, online_min: 5 })).toBe(true);
    expect(isActive({ worked: 0, call_logs: 3, credited: 0, online_min: null })).toBe(true);
  });
});

describe('heat grid', () => {
  const cells = [
    { p: 'a', h: 9, d: 10, c: 5 },
    { p: 'a', h: 22, d: 1, c: 0 },
    { p: 'b', h: 6, d: 0, c: 4 },
    { p: null, h: 10, d: 3, c: 0 },
    { p: 'z', h: 11, d: 9, c: 0 },
  ];
  it('rows for the people shown, only with activity; hours cover all activity, at least 08–20', () => {
    const g = heatGrid(cells, ['a', 'b'], 'decisions');
    expect(g.rows.map((r) => r.id)).toEqual(['a']);
    expect(g.hours[0]).toBe(8);
    expect(g.hours.at(-1)).toBe(22);
    const g2 = heatGrid(cells, ['a', 'b'], 'all');
    expect(g2.rows.map((r) => [r.id, r.total])).toEqual([['a', 16], ['b', 4]]);
    expect(g2.hours[0]).toBe(6);
    expect(g2.all[9]).toBe(15);
  });
  it('breaks rise strictly and bins map values', () => {
    const b = heatBreaks([1, 1, 1, 1]);
    expect(b).toEqual([1, 2, 3, 4, 5]);
    const b2 = heatBreaks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(b2[4]).toBe(10);
    expect(heatBin(0, b2)).toBe(0);
    expect(heatBin(10, b2)).toBe(5);
    expect(heatBin(1, b2)).toBe(1);
    expect(heatBin(99, b2)).toBe(5);
    expect(heatBreaks([])).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('clock text (Skopje)', () => {
  it('minToHm wraps and pads', () => {
    expect(minToHm(485)).toBe('08:05');
    expect(minToHm(1440 + 5)).toBe('00:05');
    expect(minToHm(null)).toBe('');
  });
  it('skopjeDayMin reads summer and winter offsets', () => {
    expect(skopjeDayMin('2026-09-17T06:30:00Z')).toEqual({ day: '2026-09-17', min: 8 * 60 + 30 });
    expect(skopjeDayMin('2026-01-15T23:30:00Z')).toEqual({ day: '2026-01-16', min: 30 });
    expect(skopjeDayMin('nope')).toBeNull();
  });
  it('minutesInto runs past midnight', () => {
    expect(minutesInto('2026-09-17', '2026-09-17T22:30:00Z')).toBe(24 * 60 + 30);
    expect(minutesInto('2026-09-17', '2026-09-16T21:30:00Z')).toBe(-30);
  });
  it('hoursText: one day exact, several days averaged', () => {
    expect(hoursText({ first_at: '2026-09-17T06:05:00Z', last_at: '2026-09-17T14:40:00Z', avg_start_min: null, avg_end_min: null, days_active: 1 }))
      .toEqual({ text: '08:05–16:40', averaged: false });
    expect(hoursText({ first_at: null, last_at: null, avg_start_min: 490, avg_end_min: 990, days_active: 4 }))
      .toEqual({ text: '08:10–16:30', averaged: true });
    expect(hoursText({ first_at: null, last_at: null, avg_start_min: null, avg_end_min: null, days_active: 0 })).toBeNull();
  });
  it('pickDay stays inside the period', () => {
    expect(pickDay('2026-09-20', '2026-09-01', '2026-09-27')).toBe('2026-09-20');
    expect(pickDay('2026-10-01', '2026-09-01', '2026-09-27')).toBe('2026-09-27');
    expect(pickDay(null, '2026-09-01', '2026-09-27')).toBe('2026-09-27');
  });
  it('presenceGap: the period starts before tracking', () => {
    expect(presenceGap('2026-09-22', '2026-09-28')).toBe(true);
    expect(presenceGap('2026-09-28', '2026-09-28')).toBe(false);
    expect(presenceGap('2026-09-28', null)).toBe(true);
  });
});
