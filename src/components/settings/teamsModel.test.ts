import { describe, expect, it } from 'vitest';
import type { SalesMembership, SalesPerson, SalesTeam } from '@/lib/api';
import {
  addDaysYmd, altercpaIds, currentPrimary, dmy, identityKindForVia, movePreview, nextPrimary, NO_TEAM,
  personMatches, skopjeTodayYmd, teamColumns,
} from './teamsModel';

const m = (team_key: string, valid_from: string, valid_to: string | null, extra: Partial<SalesMembership> = {}): SalesMembership => ({
  id: `${team_key}-${valid_from}`, team_key, valid_from, valid_to, role: 'member', is_primary: true, note: null, created_at: '', ...extra,
});
const person = (id: string, display_name: string, memberships: SalesMembership[], extra: Partial<SalesPerson> = {}): SalesPerson => ({
  id, display_name, user_id: null, login_name: null, login_email: null, login_active: null, login_roles: [],
  is_active: true, is_manager: false, notes: null, created_at: '', last_activity_at: null, decisions_30d: 0, sales_30d: 0,
  identities: [], memberships, ...extra,
});
const TEAMS: SalesTeam[] = [
  { key: 'altercpa_leads', name: 'Pending — AlterCPA leads', leaderboard_mode: 'pending' },
  { key: 'crm_prediction', name: 'Prediction — ElyonCRM', leaderboard_mode: 'prediction' },
  { key: 'management', name: 'Management', leaderboard_mode: null },
];

describe('dates', () => {
  it('Skopje today crosses midnight an hour or two before UTC', () => {
    expect(skopjeTodayYmd(new Date('2026-09-27T23:30:00Z'))).toBe('2026-09-28'); // 01:30 CEST
    expect(skopjeTodayYmd(new Date('2026-12-31T22:30:00Z'))).toBe('2026-12-31'); // 23:30 CET
  });
  it('shifts calendar days and formats dd.MM.yyyy', () => {
    expect(addDaysYmd('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    expect(dmy('2026-09-05')).toBe('05.09.2026');
    expect(dmy(null)).toBe('');
  });
});

describe('memberships', () => {
  const ms = [m('altercpa_leads', '2026-08-05', '2026-09-30'), m('crm_prediction', '2026-10-01', null), m('management', '2026-09-01', null, { is_primary: false })];
  it('valid_to is inclusive', () => {
    expect(currentPrimary(ms, '2026-09-30')?.team_key).toBe('altercpa_leads');
    expect(currentPrimary(ms, '2026-10-01')?.team_key).toBe('crm_prediction');
    expect(currentPrimary(ms, '2026-08-04')).toBeNull();
  });
  it('finds the planned next team', () => {
    expect(nextPrimary(ms, '2026-09-28')?.team_key).toBe('crm_prediction');
    expect(nextPrimary(ms, '2026-10-01')).toBeNull();
  });
});

describe('teamColumns', () => {
  const people = [
    person('a', 'Zora', [m('crm_prediction', '2026-09-01', null)]),
    person('b', 'Ana', [m('crm_prediction', '2026-09-01', null)]),
    person('c', 'Kalina', [m('management', '2026-08-05', null), m('altercpa_leads', '2026-08-05', null, { is_primary: false })]),
    person('d', 'Old', [m('altercpa_leads', '2026-06-27', '2026-07-07')]),
  ];
  it('puts each person in their primary team on the day, secondaries after', () => {
    const cols = teamColumns(people, TEAMS, '2026-09-28');
    expect(cols.map((c) => c.key)).toEqual(['altercpa_leads', 'crm_prediction', 'management', NO_TEAM]);
    expect(cols[1].entries.map((e) => e.person.display_name)).toEqual(['Ana', 'Zora']);
    expect(cols[0].entries.map((e) => [e.person.display_name, e.secondary])).toEqual([['Kalina', true]]);
    expect(cols[3].entries.map((e) => e.person.display_name)).toEqual(['Old']);
  });
  it('omits the no-team column when everyone has a team', () => {
    expect(teamColumns(people.slice(0, 2), TEAMS, '2026-09-28').map((c) => c.key)).not.toContain(NO_TEAM);
  });
});

describe('search and handles', () => {
  const p = person('x', 'Iva', [], {
    login_email: 'iva@naturatherapy.mk',
    identities: [{ id: '1', kind: 'altercpa_user', account_id: 'acc', value: '4134', note: null, created_at: '' },
                 { id: '2', kind: 'collabbox_author', account_id: null, value: 'Ива Куноска', note: null, created_at: '' }],
  });
  it('matches name, email, AlterCPA id (with or without #) and spellings', () => {
    expect(personMatches(p, 'iva@')).toBe(true);
    expect(personMatches(p, '#4134')).toBe(true);
    expect(personMatches(p, 'куноска')).toBe(true);
    expect(personMatches(p, 'dragana')).toBe(false);
    expect(altercpaIds(p)).toEqual(['#4134']);
  });
  it('maps the sale path to the identity kind that names its decider', () => {
    expect(identityKindForVia('altercpa')).toBe('altercpa_user');
    expect(identityKindForVia('collabbox')).toBe('collabbox_author');
    expect(identityKindForVia('import')).toBe('order_name');
    expect(identityKindForVia(null)).toBeNull();
  });
});

describe('movePreview', () => {
  const ms = [m('altercpa_leads', '2026-08-05', null)];
  it('closes the current membership the day before', () => {
    expect(movePreview(ms, '2026-10-01', 'crm_prediction', 'member')).toMatchObject({ kind: 'close', closeOn: '2026-09-30' });
  });
  it('replaces a membership that starts on the same day, refuses a no-op', () => {
    expect(movePreview([m('altercpa_leads', '2026-10-01', null)], '2026-10-01', 'management', 'member').kind).toBe('replace');
    expect(movePreview(ms, '2026-10-01', 'altercpa_leads', 'member').kind).toBe('same');
    expect(movePreview(ms, '2026-10-01', 'altercpa_leads', 'lead').kind).toBe('close');
  });
  it('is blocked by a later primary membership; nothing to close before the first', () => {
    expect(movePreview([m('management', '2026-11-01', null)], '2026-10-01', 'crm_prediction', 'member').kind).toBe('blocked');
    expect(movePreview([], '2026-10-01', 'crm_prediction', 'member').kind).toBe('none');
  });
});
