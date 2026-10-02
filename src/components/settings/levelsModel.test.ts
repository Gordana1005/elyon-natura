import { describe, expect, it } from 'vitest';
import {
  DEPT_GROUPS, bodyOf, draftChanged, draftDepts, draftError, draftOf, filterPeople, groupState, levelCounts,
  moneyScopeOf, sortDepts, takesDepts, toggleDept, toggleGroup, type AccessPersonLike,
} from './levelsModel';

const teo: AccessPersonLike = {
  user_id: 't', level: 'dept_admin', explicit: true, departments: ['social', 'teleshop_out', 'teleshop_other'], note: 'Тим Центар',
};
const mile: AccessPersonLike = { user_id: 'm', level: 'super_admin', explicit: true, departments: [], note: null, last_super_admin: true };
const unmanaged: AccessPersonLike = { user_id: 'u', level: 'team_lead', explicit: false, departments: [], note: null };

describe('departments', () => {
  it('groups: Тим Центар · Тим Маџари · Веб · Менаџмент, every department once', () => {
    expect(DEPT_GROUPS.map((g) => g.id)).toEqual(['centar', 'madzari', 'web', 'management']);
    expect(DEPT_GROUPS.flatMap((g) => g.keys).sort())
      .toEqual(['altercpa', 'elyon_crm', 'management', 'social', 'teleshop_other', 'teleshop_out', 'web']);
  });

  it('toggles keep the display order, a group header toggles the whole group', () => {
    expect(sortDepts(['web', 'social', 'altercpa', 'bogus'])).toEqual(['altercpa', 'social', 'web']);
    expect(toggleDept(['social'], 'teleshop_out')).toEqual(['teleshop_out', 'social']);
    expect(toggleDept(['teleshop_out', 'social'], 'social')).toEqual(['teleshop_out']);
    const centar = DEPT_GROUPS[0].keys;
    expect(toggleGroup(['altercpa'], centar)).toEqual(['altercpa', 'teleshop_out', 'teleshop_other', 'social']);
    expect(toggleGroup(['teleshop_out', 'teleshop_other', 'social', 'web'], centar)).toEqual(['web']);
    expect(toggleGroup(['social'], centar)).toEqual(['teleshop_out', 'teleshop_other', 'social']);
    expect(groupState([], centar)).toBe(false);
    expect(groupState(['social'], centar)).toBe('indeterminate');
    expect(groupState([...centar], centar)).toBe(true);
  });

  it('only dept_admin and team_lead hold departments', () => {
    expect(takesDepts('dept_admin')).toBe(true);
    expect(takesDepts('team_lead')).toBe(true);
    for (const lv of ['super_admin', 'owner', 'finance', 'administrator', 'operator', 'warehouse']) expect(takesDepts(lv)).toBe(false);
  });

  it('money scope: company-wide · their departments · no money', () => {
    expect(moneyScopeOf('administrator', ['web'])).toEqual({ kind: 'company' });
    expect(moneyScopeOf('dept_admin', ['elyon_crm', 'altercpa'])).toEqual({ kind: 'depts', keys: ['altercpa', 'elyon_crm'] });
    expect(moneyScopeOf('team_lead', ['social'])).toEqual({ kind: 'none', keys: ['social'] });
    expect(moneyScopeOf('operator', ['social'])).toEqual({ kind: 'none', keys: [] });
  });
});

describe('the edit draft', () => {
  it('starts from the person; unchanged means nothing to save', () => {
    const d = draftOf(teo);
    expect(d).toEqual({ level: 'dept_admin', departments: ['teleshop_out', 'teleshop_other', 'social'], note: 'Тим Центар' });
    expect(draftChanged(teo, d)).toBe(false);
    expect(draftChanged(teo, { ...d, note: ' Тим Центар ' })).toBe(false);
    expect(draftChanged(teo, { ...d, departments: ['teleshop_out'] })).toBe(true);
    expect(draftChanged(teo, { ...d, level: 'administrator' })).toBe(true);
  });

  it('a person with no row: saving the shown level writes the row (a change)', () => {
    expect(draftChanged(unmanaged, draftOf(unmanaged))).toBe(true);
  });

  it('a level without departments saves none (the old ones are kept in the draft only)', () => {
    const d = { ...draftOf(teo), level: 'administrator' as const };
    expect(draftDepts(d)).toEqual([]);
    expect(bodyOf(teo, d)).toEqual({ level: 'administrator', departments: [] });
  });

  it('refuses what the api refuses: the last super admin, a dept_admin with none, a long note', () => {
    expect(draftError(mile, { ...draftOf(mile), level: 'owner' })).toBe('last_super_admin');
    expect(draftError(mile, { ...draftOf(mile), note: 'ok' })).toBeNull();
    expect(draftError(teo, { ...draftOf(teo), departments: [] })).toBe('dept_required');
    expect(draftError(teo, { ...draftOf(teo), note: 'x'.repeat(501) })).toBe('note_too_long');
    expect(draftError(teo, draftOf(teo))).toBeNull();
  });

  it('the PUT body sends the note only when it changed ("" clears it)', () => {
    expect(bodyOf(teo, draftOf(teo))).toEqual({ level: 'dept_admin', departments: ['teleshop_out', 'teleshop_other', 'social'] });
    expect(bodyOf(teo, { ...draftOf(teo), note: '' })).toMatchObject({ note: '' });
    expect(bodyOf(teo, { ...draftOf(teo), note: '  нова  ' })).toMatchObject({ note: 'нова' });
  });
});

describe('the list', () => {
  const people = [
    { full_name: 'Mile Stoev', email: 'mile@elyon.com', level: 'super_admin' },
    { full_name: 'Нина', email: 'nina@x.mk', level: 'administrator' },
    { full_name: 'Teodora Krstevska', email: null, level: 'dept_admin' },
    { full_name: null, email: 'ema@naturatherapy.mk', level: 'finance' },
    { full_name: 'Lazar Delev', email: 'lazar@x', level: 'super_admin' },
  ];

  it('search: every word, name or e-mail, any case; plus the level filter', () => {
    expect(filterPeople(people, '', 'all')).toHaveLength(5);
    expect(filterPeople(people, 'MILE', 'all').map((p) => p.full_name)).toEqual(['Mile Stoev']);
    expect(filterPeople(people, 'нина', 'all').map((p) => p.email)).toEqual(['nina@x.mk']);
    expect(filterPeople(people, 'naturatherapy', 'all').map((p) => p.level)).toEqual(['finance']);
    expect(filterPeople(people, 'teodora krst', 'all')).toHaveLength(1);
    expect(filterPeople(people, '', 'super_admin').map((p) => p.full_name)).toEqual(['Mile Stoev', 'Lazar Delev']);
    expect(filterPeople(people, 'lazar', 'administrator')).toEqual([]);
  });

  it('counts per level, in the level order, without empty levels', () => {
    expect(levelCounts(people)).toEqual([
      { level: 'super_admin', count: 2 }, { level: 'finance', count: 1 },
      { level: 'administrator', count: 1 }, { level: 'dept_admin', count: 1 },
    ]);
  });
});
