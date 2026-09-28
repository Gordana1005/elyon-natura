import { describe, expect, it } from 'vitest';
import type { PeoplePerson, PeopleResponse } from '@/lib/insightsApi/agents';
import sample from './__fixtures__/people.sample.json';
import {
  BOARD_MIN_CLOSED, BOARD_MIN_WORKED, DEFAULT_SORT, filterPeople, hasActivity, leaderboards, memberIsWhole,
  noSellerBySource, peopleCsv, personHref, ratesOf, reconcile, sortPeople, sortTeams, teamHref,
} from './model';

const data = sample as unknown as PeopleResponse;
const range = { from: '2026-09-22', to: '2026-09-28' };
const BUCKETS = ['paid', 'paid_legacy', 'paid_unproven', 'courier', 'courier_problem', 'label', 'to_pack', 'returned'] as const;
const SOURCES = ['altercpa', 'elyon_crm', 'teleshop_other', 'social', 'web'] as const;

describe('the payload adds up (live-shaped fixture, 22–28.09.2026)', () => {
  it('every person: buckets and sources each sum to their sales', () => {
    for (const p of data.people) {
      expect(BUCKETS.reduce((a, k) => a + p.buckets[k], 0)).toBe(p.sales);
      expect(SOURCES.reduce((a, k) => a + p.by_source[k], 0)).toBe(p.sales);
    }
  });
  it('every team: its members sum to the team; the teams sum to the people', () => {
    for (const t of data.teams!) {
      expect(t.members.reduce((a, m) => a + m.sales, 0)).toBe(t.sales);
      expect(t.members.reduce((a, m) => a + m.worked, 0)).toBe(t.worked);
    }
    const teams = data.teams!.reduce((a, t) => a + t.sales, 0);
    expect(teams).toBe(data.people.reduce((a, p) => a + p.sales, 0));
  });
  it('Σ people + no seller = the cohort total, overall and per source', () => {
    const r = reconcile(data)!;
    expect(r.ok).toBe(true);
    expect(r.people + r.noSeller).toBe(data.totals!.sales);
    expect(r.people).toBe(data.totals!.with_person);
    for (const s of r.bySource) expect(s.people + s.noSeller).toBe(s.total);
  });
  it('a broken payload is reported, never hidden', () => {
    const bad = structuredClone(data);
    bad.people[0].sales += 1;
    expect(reconcile(bad)!.ok).toBe(false);
  });
});

describe('rates', () => {
  const p = (over: Partial<PeoplePerson>): PeoplePerson => ({ ...data.people[0], ...over });
  it('conversion = sale decisions ÷ worked; null without work', () => {
    expect(ratesOf(p({ worked: 40, sale_decisions: 10 })).conversion).toBe(0.25);
    expect(ratesOf(p({ worked: 0, sale_decisions: 0 })).conversion).toBeNull();
  });
  it('return rate is over the finished sales only', () => {
    const b = { paid: 6, paid_legacy: 0, paid_unproven: 0, courier: 20, courier_problem: 0, label: 0, to_pack: 0, returned: 2 };
    const r = ratesOf(p({ buckets: b, sales: 28 }));
    expect(r.returnRate).toBe(0.25);
    expect(r.open).toBe(20);
    expect(r.paidShare).toBeCloseTo(6 / 28);
  });
  it('sales per active hour needs 30 active minutes and uses presence-day decisions', () => {
    const pres = { days: 1, online_min: 200, active_min: 120, idle_min: 80, break_min: 0, idle_alerts: 0, first_active_at: null, last_active_at: null, sale_decisions: 6 };
    expect(ratesOf(p({ presence: pres })).salesPerActiveHour).toBe(3);
    expect(ratesOf(p({ presence: { ...pres, active_min: 20 } })).salesPerActiveHour).toBeNull();
    expect(ratesOf(p({ presence: null })).salesPerActiveHour).toBeNull();
  });
  it('AOV only with money', () => {
    expect(ratesOf(p({ sales: 4, value_mkd: 12000 })).aov).toBe(3000);
    const { value_mkd: _v, ...noMoney } = data.people[0];
    expect(ratesOf({ ...noMoney, sales: 4 } as PeoplePerson).aov).toBeNull();
  });
});

describe('links', () => {
  it('a person link lists exactly their cohort part', () => {
    const h = personHref('00000000-0000-4000-8000-000000000001', ['courier', 'courier_problem'], range, 'Агент А');
    const u = new URL(h, 'http://x');
    expect(u.pathname).toBe('/orders');
    expect(u.searchParams.get('cohort_bucket')).toBe('courier,courier_problem');
    expect(u.searchParams.get('sold_by_person_id')).toBe('00000000-0000-4000-8000-000000000001');
    expect(u.searchParams.get('sold_from')).toBe('2026-09-22');
    expect(u.searchParams.get('sold_to')).toBe('2026-09-28');
    expect(new URL(personHref('p', ['total', 'paid'], range), 'http://x').searchParams.get('cohort_bucket')).toBe('total');
  });
  it('a team links only when /orders?team_key is exact; pseudo-groups never', () => {
    expect(teamHref({ key: 'crm_prediction', kind: 'team', drill_exact: true }, 'total', range)).toContain('team_key=crm_prediction');
    expect(teamHref({ key: 'crm_prediction', kind: 'team', drill_exact: false }, 'total', range)).toBeNull();
    expect(teamHref({ key: 'teleshop', kind: 'teleshop', drill_exact: true }, 'total', range)).toBeNull();
    expect(teamHref({ key: 'social', kind: 'social', drill_exact: true }, 'total', range)).toBeNull();
  });
  it('a member row links to the person only when it is their whole period', () => {
    const t = data.teams!.find((x) => x.members.length > 0)!;
    const m = t.members[0];
    const person = data.people.find((p) => p.person_id === m.person_id)!;
    expect(memberIsWhole(m, person)).toBe(person.groups.length === 1 || person.sales === m.sales);
    expect(memberIsWhole({ ...m, sales: m.sales + 1 }, person)).toBe(false);
  });
});

describe('sorting and filtering', () => {
  it('default = by sales, descending (never by money)', () => {
    const s = sortPeople(data.people, DEFAULT_SORT);
    for (let i = 1; i < s.length; i++) expect(s[i - 1].sales).toBeGreaterThanOrEqual(s[i].sales);
  });
  it('empty values sort last in both directions', () => {
    for (const dir of ['asc', 'desc'] as const) {
      const s = sortPeople(data.people, { key: 'conversion', dir });
      const firstNull = s.findIndex((p) => p.worked === 0);
      if (firstNull >= 0) expect(s.slice(firstNull).every((p) => p.worked === 0)).toBe(true);
    }
  });
  it('search folds case and diacritics; idle people hide on request', () => {
    const one = data.people[0];
    expect(filterPeople(data.people, { search: one.name.toUpperCase(), teams: [], showIdle: true }).map((p) => p.person_id)).toContain(one.person_id);
    const active = filterPeople(data.people, { search: '', teams: [], showIdle: false });
    expect(active.every(hasActivity)).toBe(true);
  });
  it('a team filter keeps the people whose activity touched that team', () => {
    const rows = filterPeople(data.people, { search: '', teams: ['altercpa_leads'], showIdle: true });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((p) => p.team_key === 'altercpa_leads' || p.groups.includes('altercpa_leads'))).toBe(true);
  });
  it('teams: the two call teams first, "no team" last', () => {
    const keys = sortTeams(data.teams!).map((t) => t.key);
    expect(keys[0]).toBe('altercpa_leads');
    expect(keys[keys.length - 1]).toBe('none');
    // the pseudo-groups: Teleshop (Lead in) before Social media (the source order), both before management
    const g = sortTeams([
      { ...data.teams![0], key: 'management' }, { ...data.teams![0], key: 'teleshop' },
      { ...data.teams![0], key: 'social' }, { ...data.teams![0], key: 'crm_prediction' },
    ]).map((t) => t.key);
    expect(g).toEqual(['crm_prediction', 'teleshop', 'social', 'management']);
  });
});

describe('leaderboards', () => {
  it('rate boards respect their floors; value only with money', () => {
    const b = leaderboards(data.people, true);
    for (const e of b.conversion!) expect(e.person.worked).toBeGreaterThanOrEqual(BOARD_MIN_WORKED);
    for (const e of b.return_rate!) {
      const bb = e.person.buckets;
      expect(bb.paid + bb.paid_legacy + bb.returned).toBeGreaterThanOrEqual(BOARD_MIN_CLOSED);
    }
    for (let i = 1; i < b.sales!.length; i++) expect(b.sales![i - 1].value).toBeGreaterThanOrEqual(b.sales![i].value);
    expect(leaderboards(data.people, false).value).toBeNull();
  });
});

describe('no seller + CSV', () => {
  it('groups by source in the fixed order', () => {
    const g = noSellerBySource(data.no_seller!.reasons);
    expect(g.map((x) => x.source)).toEqual(['altercpa', 'teleshop_other', 'social', 'web']);
    expect(g.reduce((a, x) => a + x.count, 0)).toBe(data.no_seller!.count);
  });
  it('money columns only with money; cells quoted when needed', () => {
    const cols = [
      { header: 'Лице', get: (p: PeoplePerson) => p.name },
      { header: 'Продажби', get: (p: PeoplePerson) => p.sales },
      { header: 'Вредност (ден)', get: (p: PeoplePerson) => p.value_mkd, money: true },
    ];
    const rows = [{ ...data.people[0], name: 'А, "Б"' }];
    const withMoney = peopleCsv(rows, cols, true);
    expect(withMoney.startsWith('﻿Лице,Продажби,Вредност (ден)')).toBe(true);
    expect(withMoney).toContain('"А, ""Б"""');
    expect(peopleCsv(rows, cols, false)).not.toContain('Вредност');
  });
});

describe('Skopje day instants (the bonus block window)', () => {
  it('summer (CEST, +2) and winter (CET, +1), inclusive last day', async () => {
    const { skopjeDayStartIso, skopjeDayEndIso } = await import('./model');
    expect(skopjeDayStartIso('2026-09-22')).toBe('2026-09-21T22:00:00.000Z');
    expect(skopjeDayEndIso('2026-09-28')).toBe('2026-09-28T21:59:59.999Z');
    expect(skopjeDayStartIso('2026-01-10')).toBe('2026-01-09T23:00:00.000Z');
    // the DST switch day (25.10.2026 → CET)
    expect(skopjeDayEndIso('2026-10-25')).toBe('2026-10-25T22:59:59.999Z');
    expect(skopjeDayStartIso('2026-10-25')).toBe('2026-10-24T22:00:00.000Z');
    expect(skopjeDayStartIso('2026-03-29')).toBe('2026-03-28T23:00:00.000Z');
  });
});
