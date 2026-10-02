import { describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { operatorOf, operatorTitle } from './orderOperator';

const t = ((k: string, o?: Record<string, unknown>) => i18n.t(k, o)) as never;

describe('operatorOf — who produced the current status (owner 01.10.2026)', () => {
  it('takes the api\'s operator for every status — a cancel names the agent who cancelled', () => {
    expect(operatorOf({ status: 'cancelled', operator_name: 'Ruzhica Parizovska', operator_basis: 'history', operator_auto: false, seller_name: null }))
      .toEqual({ name: 'Ruzhica Parizovska', basis: 'history', auto: false });
    expect(operatorOf({ status: 'cancelled', operator_name: 'Snezhana Stojkovska', operator_basis: 'altercpa' }))
      .toEqual({ name: 'Snezhana Stojkovska', basis: 'altercpa', auto: false });
    expect(operatorOf({ status: 'shipped', operator_name: 'Sonja Taseva', operator_basis: 'sale', assigned_agent_name: 'Someone Else' }))
      .toEqual({ name: 'Sonja Taseva', basis: 'sale', auto: false });
  });

  it('an automatic status keeps the name and says so', () => {
    expect(operatorOf({ status: 'cancelled', operator_name: 'Kristina Danevska', operator_basis: 'altercpa', operator_auto: true }))
      .toEqual({ name: 'Kristina Danevska', basis: 'altercpa', auto: true });
  });

  it('nobody on record → no name, no basis, never "auto"', () => {
    expect(operatorOf({ status: 'trashed', operator_name: null, operator_basis: null, operator_auto: true }))
      .toEqual({ name: null, basis: null, auto: false });
    expect(operatorOf({ status: 'pending', operator_name: '  ', operator_basis: 'history' }))
      .toEqual({ name: null, basis: null, auto: false });
  });

  it('an api without operator_* falls back to what the column showed before: seller on a sale, assignee otherwise', () => {
    expect(operatorOf({ status: 'paid', seller_name: 'Iva', assigned_agent_name: 'X' })).toEqual({ name: 'Iva', basis: 'sale', auto: false });
    expect(operatorOf({ status: 'paid', seller_name: null, confirmed_by_name: 'Dragana' })).toEqual({ name: 'Dragana', basis: 'sale', auto: false });
    expect(operatorOf({ status: 'cancelled', seller_name: 'Iva', assigned_agent_name: 'Julijana Andonovska' }))
      .toEqual({ name: 'Julijana Andonovska', basis: 'assigned', auto: false });
    expect(operatorOf({ status: 'cancelled', assigned_agent_name: null })).toEqual({ name: null, basis: null, auto: false });
  });

  it('an unknown basis is dropped, the name stays', () => {
    expect(operatorOf({ status: 'cancelled', operator_name: 'A', operator_basis: 'weird' })).toEqual({ name: 'A', basis: null, auto: false });
  });
});

describe('operatorTitle — how the name was decided', () => {
  it('names the status and the source, and adds the automatic note', () => {
    expect(operatorTitle(t, { name: 'A', basis: 'history', auto: false }, 'Откажана'))
      .toBe(i18n.t('ordersList.operator.basis.history', { status: 'Откажана' }));
    expect(operatorTitle(t, { name: 'A', basis: 'altercpa', auto: true }, 'Откажана'))
      .toBe(`${i18n.t('ordersList.operator.basis.altercpa', { status: 'Откажана' })} · ${i18n.t('ordersList.operator.autoTitle')}`);
    expect(operatorTitle(t, { name: null, basis: null, auto: false }, 'x')).toBeUndefined();
  });

  it('exists in all four languages', () => {
    for (const lng of ['mk', 'en', 'sq']) {
      for (const b of ['sale', 'history', 'assigned', 'altercpa']) {
        expect(i18n.getResource(lng, 'translation', `ordersList.operator.basis.${b}`)).toBeTruthy();
      }
      expect(i18n.getResource(lng, 'translation', 'ordersList.col.operator')).toBeTruthy();
      expect(i18n.getResource(lng, 'translation', 'search.colOperator')).toBeTruthy();
    }
    expect(i18n.getResource('mk', 'translation', 'ordersList.col.operator')).toBe('Оператор');
    expect(i18n.getResource('sq', 'translation', 'ordersList.col.operator')).toBe('Operatori');
  });
});
