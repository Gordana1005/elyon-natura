import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { ACCESS_LEVEL_ORDER, NAMED_ACCESS_LEVELS, accessLevelLabel, accessLevelName, friendlyRoleLabel } from './roles';

const CENTAR = ['teleshop_out', 'teleshop_other', 'social'];
const MADZARI = ['altercpa', 'elyon_crm'];

describe('the role label in the top bar — the access level first (owner 03.10.2026)', () => {
  beforeEach(async () => { await i18n.changeLanguage('mk'); });
  afterEach(async () => { await i18n.changeLanguage('mk'); });

  it("names the five money levels with the owner's words", () => {
    expect(accessLevelLabel('super_admin', null)).toBe('Супер Админ');
    expect(accessLevelLabel('owner', null)).toBe('Сопственик');
    expect(accessLevelLabel('finance', null)).toBe('Финансиски');
    expect(accessLevelLabel('administrator', null)).toBe('Администратор');
    expect(accessLevelLabel('dept_admin', [])).toBe('Администратор на оддел');
  });

  it('a department admin carries the team: always "Тим Центар" / "Тим Маџари", never bare', () => {
    expect(accessLevelLabel('dept_admin', CENTAR)).toBe('Администратор на оддел · Тим Центар');
    expect(accessLevelLabel('dept_admin', MADZARI)).toBe('Администратор на оддел · Тим Маџари');
    expect(accessLevelLabel('dept_admin', ['teleshop_out'])).toBe('Администратор на оддел · Тим Центар');
    // not one team's departments → their names
    expect(accessLevelLabel('dept_admin', ['altercpa', 'web'])).toBe('Администратор на оддел · Тим Маџари In · Веб-продавница');
  });

  it('the other levels (and none) give no level label', () => {
    for (const lv of ['team_lead', 'operator', 'warehouse', 'partner']) expect(accessLevelLabel(lv, null)).toBeNull();
    expect(accessLevelLabel(null, null)).toBeNull();
    expect(accessLevelLabel('emperor', null)).toBeNull();
  });

  it('an app-role admin who is an administrator is "Администратор", never "Суперадмин"', () => {
    expect(friendlyRoleLabel(['admin'], { level: 'administrator', deptScope: null })).toBe('Администратор');
    expect(friendlyRoleLabel(['admin'], { level: 'super_admin', deptScope: null })).toBe('Супер Админ');
    // no level known (e.g. a board tile): the role, not a level it may not have
    expect(friendlyRoleLabel(['admin'])).toBe('Админ');
  });

  it('a manager who is a department admin shows the level; a team lead keeps the role label', () => {
    expect(friendlyRoleLabel(['manager', 'pending_agent'], { level: 'dept_admin', deptScope: MADZARI })).toBe('Администратор на оддел · Тим Маџари');
    expect(friendlyRoleLabel(['manager', 'pending_agent'], { level: 'team_lead', deptScope: null })).toBe('Агент за повици + Менаџер');
    expect(friendlyRoleLabel(['manager'], { level: 'finance', deptScope: null })).toBe('Финансиски');
    expect(friendlyRoleLabel(['pending_agent', 'prediction_agent'], { level: 'operator', deptScope: null })).toBe('Агент за повици');
    expect(friendlyRoleLabel([], { level: 'operator', deptScope: null })).toBe('');
    expect(friendlyRoleLabel(null)).toBe('');
  });

  it('every level has a name and a "what it sees" line in mk, sq and en', async () => {
    for (const lang of ['mk', 'sq', 'en']) {
      await i18n.changeLanguage(lang);
      for (const lv of ACCESS_LEVEL_ORDER) {
        const name = accessLevelName(lv);
        expect(name, `${lang}:${lv}`).toBeTruthy();
        expect(name).not.toBe(`access.level.${lv}`);
        expect(i18n.exists(`access.levelSees.${lv}`), `${lang}:${lv} levelSees`).toBe(true);
      }
    }
    await i18n.changeLanguage('en');
    expect(NAMED_ACCESS_LEVELS.map((lv) => accessLevelName(lv)))
      .toEqual(['Super Admin', 'Owner', 'Finance', 'Administrator', 'Department admin']);
    expect(accessLevelLabel('dept_admin', CENTAR)).toBe('Department admin · Team Centar');
    await i18n.changeLanguage('sq');
    expect(accessLevelLabel('dept_admin', MADZARI)).toBe('Administrator departamenti · Ekipi Madžari');
  });
});
