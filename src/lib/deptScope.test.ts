import { beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { scopeTeam, scopeTeamLabel } from './deptScope';

// A dept_admin's money scope (access levels, 20260947001600): the badge says whose departments
// the figures are — Тим Центар / Тим Маџари (always with "Тим"), else the departments by name.
beforeAll(async () => { await i18n.changeLanguage('mk'); });
const t = i18n.t.bind(i18n);

describe('scopeTeam', () => {
  it('Тим Центар = any of its three departments, Тим Маџари = any of its two', () => {
    expect(scopeTeam(['teleshop_out', 'teleshop_other', 'social'])).toBe('teleshop');
    expect(scopeTeam(['teleshop_out'])).toBe('teleshop');
    expect(scopeTeam(['social', 'teleshop_other'])).toBe('teleshop');
    expect(scopeTeam(['altercpa', 'elyon_crm'])).toBe('affiliate');
    expect(scopeTeam(['elyon_crm'])).toBe('affiliate');
  });
  it('mixed, unknown, web / Менаџмент or empty = no team', () => {
    expect(scopeTeam(['altercpa', 'teleshop_out'])).toBeNull();
    expect(scopeTeam(['web'])).toBeNull();
    expect(scopeTeam(['management'])).toBeNull();
    expect(scopeTeam(['teleshop_out', 'bogus'])).toBeNull();
    expect(scopeTeam([])).toBeNull();
    expect(scopeTeam(null)).toBeNull();
    expect(scopeTeam(undefined)).toBeNull();
  });
});

describe('scopeTeamLabel', () => {
  it('names the team, always with "Тим"', () => {
    expect(scopeTeamLabel(['teleshop_out', 'teleshop_other', 'social'], t)).toBe('Тим Центар');
    expect(scopeTeamLabel(['altercpa', 'elyon_crm'], t)).toBe('Тим Маџари');
  });
  it('otherwise joins the department names; an unknown key stays as it is', () => {
    expect(scopeTeamLabel(['altercpa', 'teleshop_out'], t))
      .toBe(`${t('insights.common.source.altercpa')} · ${t('insights.common.source.teleshop_out')}`);
    expect(scopeTeamLabel(['web'], t)).toBe(t('insights.common.source.web'));
    expect(scopeTeamLabel(['web', 'bogus'], t)).toBe(`${t('insights.common.source.web')} · bogus`);
  });
  it('no scope = no label', () => {
    expect(scopeTeamLabel([], t)).toBeNull();
    expect(scopeTeamLabel(null, t)).toBeNull();
  });
  it('speaks every shipped language', async () => {
    await i18n.changeLanguage('en');
    expect(scopeTeamLabel(['altercpa'], t)).toBe('Team Madžari');
    await i18n.changeLanguage('sq');
    expect(scopeTeamLabel(['social'], t)).toBe('Ekipi Centar');
    await i18n.changeLanguage('mk');
  });
});
