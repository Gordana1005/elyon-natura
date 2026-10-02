import { describe, expect, it } from 'vitest';
import {
  groupedSections, MONEY_SECTIONS, sectionAccess, sectionFromLegacy, SECTIONS, visibleSections, type SettingsViewer,
} from './sections';

const admin: SettingsViewer = { isAdmin: true, isManager: true, isOwner: true, canSeeMargins: true, canUsers: true, voipOn: false };
const manager: SettingsViewer = { isAdmin: false, isManager: true, isOwner: false, canSeeMargins: false, canUsers: true, voipOn: false };
const managerNoUsers: SettingsViewer = { ...manager, canUsers: false };
const ownerManager: SettingsViewer = { ...manager, isOwner: true, canSeeMargins: true };
// Access levels (20260947001600): an administrator sees revenue company-wide, never margins.
const administrator: SettingsViewer = { ...admin, canSeeMargins: false };
const ids = (v: SettingsViewer) => visibleSections(v).map((s) => s.id);

describe('Settings sections — who sees what', () => {
  it('an admin (= owner) sees everything except telephony while VOIP is off', () => {
    expect(ids(admin)).toEqual([
      'users', 'teams', 'access', 'money', 'rules', 'integrations', 'tv', 'courier', 'partners', 'warehouse', 'engine', 'personal',
    ]);
    expect(ids({ ...admin, voipOn: true })).toContain('telephony');
  });

  it('a manager sees only Корисници, the rules (read-only) and Лично — never a money section', () => {
    expect(ids(manager)).toEqual(['users', 'rules', 'personal']);
    expect(ids(managerNoUsers)).toEqual(['rules', 'personal']);
    for (const m of MONEY_SECTIONS) expect(sectionAccess(m, manager)).toBe('hidden');
    const rules = SECTIONS.find((s) => s.id === 'rules')!;
    expect(rules.readOnly?.(manager)).toBe(true);
    expect(rules.readOnly?.(admin)).toBe(false);
  });

  it('a manager on the owners list also sees the money sections, but not the admin-only ones', () => {
    const v = ids(ownerManager);
    for (const m of MONEY_SECTIONS) expect(v).toContain(m);
    for (const a of ['access', 'tv', 'engine', 'warehouse'] as const) expect(v).not.toContain(a);
  });

  it('an administrator (revenue, no margins) sees everything but the courier rate card', () => {
    expect(ids(administrator)).toEqual([
      'users', 'teams', 'access', 'money', 'rules', 'integrations', 'tv', 'partners', 'warehouse', 'engine', 'personal',
    ]);
    expect(sectionAccess('courier', administrator)).toBe('hidden');
  });

  it('groups come in the fixed order and empty groups are dropped', () => {
    expect(groupedSections(admin).map((g) => g.group)).toEqual(['people', 'rules', 'system', 'advanced', 'personal']);
    expect(groupedSections(manager).map((g) => g.group)).toEqual(['people', 'rules', 'personal']);
  });

  it('sectionAccess tells hidden from unknown', () => {
    expect(sectionAccess('teams', admin)).toBe('ok');
    expect(sectionAccess('teams', manager)).toBe('hidden');
    expect(sectionAccess('nope', admin)).toBe('unknown');
    expect(sectionAccess(undefined, admin)).toBe('unknown');
  });
});

describe('old deep links', () => {
  it('map the old tab values to the new sections', () => {
    expect(sectionFromLegacy('teams')).toBe('teams');
    expect(sectionFromLegacy('#leaderboard')).toBe('tv');
    expect(sectionFromLegacy('owners')).toBe('money');
    expect(sectionFromLegacy('financial')).toBe('access');
    expect(sectionFromLegacy('modules')).toBe('access');
    expect(sectionFromLegacy('logistics')).toBe('courier');
    expect(sectionFromLegacy('predengine')).toBe('engine');
    expect(sectionFromLegacy('appearance')).toBe('personal');
    expect(sectionFromLegacy('system')).toBe('rules');
    expect(sectionFromLegacy('warehouse')).toBe('warehouse');
    expect(sectionFromLegacy('')).toBeNull();
    expect(sectionFromLegacy('bogus')).toBeNull();
  });
});
