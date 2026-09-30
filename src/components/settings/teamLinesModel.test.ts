import { describe, expect, it } from 'vitest';
import type { LineProposalRow, SalesPerson, SalesTeam } from '@/lib/api';
import {
  applyRowFor, deptCounts, isCompletePick, laneAfterTeamChange, lanesFor, membershipHasLane, sureApplyRows, targetTeams, visibleRows,
} from './teamLinesModel';
import { needsLineDecision, teamColumns, visibleColumns } from './teamsModel';

const TEAMS: SalesTeam[] = [
  { key: 'management', name: 'Management', leaderboard_mode: null, kind: 'management', sort_order: 90 },
  { key: 'crm_prediction', name: 'Prediction — ElyonCRM', leaderboard_mode: 'prediction', kind: 'legacy', sort_order: 41 },
  { key: 'affiliate', name: 'Affiliate', leaderboard_mode: 'pending', kind: 'line', sort_order: 20 },
  { key: 'teleshop', name: 'Телешоп', leaderboard_mode: 'prediction', kind: 'line', sort_order: 10 },
  { key: 'altercpa_leads', name: 'Pending — AlterCPA leads', leaderboard_mode: 'pending', kind: 'legacy', sort_order: 40 },
];

const row = (o: Partial<LineProposalRow> & Pick<LineProposalRow, 'person_id'>): LineProposalRow => ({
  display_name: o.person_id, has_login: true, is_active: true, is_manager: false, identity_kinds: [],
  current: { team_key: 'crm_prediction', lane: null, kind: 'legacy', memberships: 1, lines: 0, legacy: true },
  basis: 'window', span: 'window',
  counts: { altercpa: 0, elyon_crm: 0, teleshop_other: 0, teleshop_out: 0, social: 0, other: 0, total: 0 },
  window_sales: 0, history_sales: 0, first_sale_at: null, last_sale_at: null,
  line_share: null, lane_share: null, share: null, confidence: 'sure', proposed: { team_key: 'teleshop', lane: 'out' }, unchanged: false,
  ...o,
});

describe('Settings → Teams → Предлог — the pure rules', () => {
  it('offers the lines and management in board order — never a legacy key', () => {
    expect(targetTeams(TEAMS).map((t) => t.key)).toEqual(['teleshop', 'affiliate', 'management']);
    // an older api without kind: the legacy keys are still refused by name
    expect(targetTeams(TEAMS.map(({ kind: _k, ...t }) => t)).map((t) => t.key)).toEqual(['teleshop', 'affiliate', 'management']);
  });
  it('lanes per team; a team change keeps the lane when it can', () => {
    expect(lanesFor('teleshop')).toEqual(['in', 'out', 'social']);
    expect(lanesFor('affiliate')).toEqual(['in', 'out']);
    expect(lanesFor('management')).toEqual([]);
    expect(laneAfterTeamChange('affiliate', 'out')).toBe('out');
    expect(laneAfterTeamChange('affiliate', 'social')).toBe('in');
    expect(laneAfterTeamChange('management', 'in')).toBeNull();
  });
  it('a complete pick: a line with one of its lanes, management without one', () => {
    expect(isCompletePick('teleshop', 'social')).toBe(true);
    expect(isCompletePick('affiliate', 'social')).toBe(false);
    expect(isCompletePick('teleshop', null)).toBe(false);
    expect(isCompletePick('management', null)).toBe(true);
    expect(isCompletePick('management', 'in')).toBe(false);
    expect(isCompletePick('crm_prediction', null)).toBe(false);
    expect(isCompletePick(null, null)).toBe(false);
  });
  it('"accept every sure row" = the sure changes that name a team', () => {
    const rows = [
      row({ person_id: 'a' }),
      row({ person_id: 'b', confidence: 'likely' }),
      row({ person_id: 'c', unchanged: true }),
      row({ person_id: 'd', proposed: { team_key: null, lane: null } }),
      row({ person_id: 'e', proposed: { team_key: 'management', lane: null } }),
    ];
    expect(sureApplyRows(rows)).toEqual([
      { person_id: 'a', team_key: 'teleshop', lane: 'out' },
      { person_id: 'e', team_key: 'management', lane: null },
    ]);
    expect(visibleRows(rows, 'changes').map((r) => r.person_id)).toEqual(['a', 'b', 'd', 'e']);
    expect(visibleRows(rows, 'all')).toHaveLength(5);
  });
  it('one row as picked; incomplete → nothing to send', () => {
    expect(applyRowFor({ person_id: 'a' }, 'affiliate', 'in')).toEqual({ person_id: 'a', team_key: 'affiliate', lane: 'in' });
    expect(applyRowFor({ person_id: 'a' }, 'affiliate', null)).toBeNull();
    expect(applyRowFor({ person_id: 'a' }, 'management', null)).toEqual({ person_id: 'a', team_key: 'management', lane: null });
  });
  it('the evidence: departments with sales, largest first', () => {
    expect(deptCounts({ altercpa: 3, elyon_crm: 0, teleshop_other: 326, teleshop_out: 572, social: 0, other: 1, total: 901 }))
      .toEqual([{ dept: 'teleshop_out', n: 572 }, { dept: 'teleshop_other', n: 326 }, { dept: 'altercpa', n: 3 }]);
  });
  it('only a line membership has a lane selector', () => {
    expect(membershipHasLane({ team_key: 'teleshop' })).toBe(true);
    expect(membershipHasLane({ team_key: 'management' })).toBe(false);
    expect(membershipHasLane({ team_key: 'crm_prediction' })).toBe(false);
  });
});

describe('Settings → Teams — columns and who still waits for a line', () => {
  const m = (team_key: string, lane: 'in' | 'out' | null = null) =>
    ({ id: team_key, team_key, valid_from: '2026-01-01', valid_to: null, role: 'member' as const, is_primary: true, note: null, created_at: '', lane });
  const person = (id: string, memberships: ReturnType<typeof m>[], is_active = true): SalesPerson => ({
    id, display_name: id, user_id: null, login_name: null, login_email: null, login_active: null, login_roles: [],
    is_active, is_manager: false, notes: null, created_at: '', last_activity_at: null, decisions_30d: 0, sales_30d: 0,
    identities: [], memberships,
  });
  it('an emptied legacy team is not a column; one still holding someone is', () => {
    const cols = visibleColumns(teamColumns([person('a', [m('teleshop', 'out')]), person('b', [m('crm_prediction')])], TEAMS, '2026-09-30'));
    expect(cols.map((c) => c.key)).toEqual(['management', 'crm_prediction', 'affiliate', 'teleshop']);
  });
  it('needs a decision: no team, a legacy team, a line without its lane — not management, not inactive', () => {
    expect(needsLineDecision(person('a', []), '2026-09-30')).toBe(true);
    expect(needsLineDecision(person('b', [m('crm_prediction')]), '2026-09-30')).toBe(true);
    expect(needsLineDecision(person('c', [m('teleshop')]), '2026-09-30')).toBe(true);
    expect(needsLineDecision(person('d', [m('teleshop', 'out')]), '2026-09-30')).toBe(false);
    expect(needsLineDecision(person('e', [m('management')]), '2026-09-30')).toBe(false);
    expect(needsLineDecision(person('f', [], false), '2026-09-30')).toBe(false);
  });
});
