import { beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import {
  TEAM_FILTER_RE, isLegacyTeam, isLineKey, laneLabel, splitTeamFilter, teamFilterValue, teamLaneLabel, teamSortOrder,
} from './teamLines';

beforeAll(async () => { await i18n.changeLanguage('mk'); });

describe('teams = business lines — the client helpers', () => {
  it('splits and builds the team:lane filter value', () => {
    expect(splitTeamFilter('teleshop:out')).toEqual({ team: 'teleshop', lane: 'out' });
    expect(splitTeamFilter('affiliate')).toEqual({ team: 'affiliate', lane: null });
    expect(splitTeamFilter('teleshop:bogus')).toEqual({ team: 'teleshop', lane: null });
    expect(splitTeamFilter(null)).toEqual({ team: null, lane: null });
    expect(teamFilterValue('affiliate', 'in')).toBe('affiliate:in');
    expect(teamFilterValue('management')).toBe('management');
  });
  it('the URL grammar: a key, key:lane, none — nothing else', () => {
    for (const ok of ['teleshop', 'teleshop:social', 'affiliate:in', 'none', 'crm_prediction']) expect(TEAM_FILTER_RE.test(ok)).toBe(true);
    for (const bad of ['Teleshop', 'teleshop:', 'teleshop:up', 'a:b:c', '', 'x'.repeat(41)]) expect(TEAM_FILTER_RE.test(bad)).toBe(false);
  });
  it('orders by sort_order, else the seeded order', () => {
    expect(['management', 'none', 'affiliate', 'crm_prediction', 'teleshop'].sort((a, b) => teamSortOrder(a) - teamSortOrder(b)))
      .toEqual(['teleshop', 'affiliate', 'crm_prediction', 'management', 'none']);
    expect(teamSortOrder('affiliate', 1)).toBe(1);
  });
  it('knows the lines and the legacy keys', () => {
    expect(isLineKey('teleshop')).toBe(true);
    expect(isLineKey('management')).toBe(false);
    expect(isLegacyTeam('crm_prediction')).toBe(true);
    expect(isLegacyTeam('affiliate')).toBe(false);
  });
  it("names team + lane in the owner's words (mk) — never 'На чекање' / 'Прогнози'", () => {
    const t = i18n.t.bind(i18n);
    expect(teamLaneLabel(t, 'teleshop', 'out', 'Телешоп')).toBe('Телешоп предикција');
    expect(teamLaneLabel(t, 'teleshop', 'in', 'Телешоп')).toBe('Телешоп лидови');
    expect(teamLaneLabel(t, 'teleshop', 'social', 'Телешоп')).toBe('Социјални мрежи');
    expect(teamLaneLabel(t, 'affiliate', 'in', 'Affiliate')).toBe('Affiliate лидови');
    expect(teamLaneLabel(t, 'affiliate', 'out', 'Affiliate')).toBe('Affiliate предикција');
    expect(teamLaneLabel(t, 'management', null, 'Менаџмент')).toBe('Менаџмент');
    expect(teamLaneLabel(t, 'webshop', 'in', 'Webshop')).toBe('Webshop · лидови');   // a line with no translation yet
    expect(laneLabel(t, 'out')).toBe('предикција');
    for (const k of ['teleshop', 'affiliate', 'management', 'altercpa_leads', 'crm_prediction', 'teleshop_unassigned', 'social_unassigned']) {
      const label = i18n.t(`insights.agents.team.byKey.${k}`);
      expect(label).not.toMatch(/На чекање|Прогноз|Lead in|Lead out/);
      expect(i18n.t(`tvBoard.team.${k}`, { defaultValue: label })).not.toMatch(/На чекање|Прогноз|Lead in|Lead out/);
    }
  });
});
