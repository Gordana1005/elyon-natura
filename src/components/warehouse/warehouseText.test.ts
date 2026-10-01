import { beforeAll, describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import i18n from '@/i18n';
import { KNOWN_CODES, accountName, codeText, daysBetween, groupByDay, movementNote, skopjeDate, skopjeDateTime, skopjeYmd } from './warehouseText';
import type { PackRow } from '@/lib/warehouseApi';

beforeAll(async () => { await i18n.changeLanguage('mk'); });
const t = i18n.t.bind(i18n) as unknown as TFunction;

describe('Skopje dates, dd.MM.yyyy', () => {
  it('uses the Skopje calendar, not UTC', () => {
    expect(skopjeDate('2026-09-30T22:30:00Z')).toBe('01.10.2026');      // 00:30 in Skopje
    expect(skopjeDateTime('2026-09-30T22:30:00Z')).toBe('01.10.2026 00:30');
    expect(skopjeYmd('2026-09-30T21:59:00Z')).toBe('2026-09-30');
    expect(skopjeDate(null)).toBe('—');
    expect(daysBetween('2026-09-28T10:00:00Z', new Date('2026-10-01T09:00:00Z'))).toBe(3);
  });
});

describe('the known machine notes are translated, a person\'s note is not', () => {
  it('maps each server text', () => {
    expect(movementNote(t, 'complete-catalogue run 1a2b-3c: залиха-placeholder 1000 (до пописот на сопственикот)'))
      .toBe(t('warehousePage.movements.note.placeholder', { n: '1000' }));
    expect(movementNote(t, 'Bulk stock set to 1000 packages — 2026-08-06')).toBe(t('warehousePage.movements.note.bulkSet', { n: '1000', date: '06.08.2026' }));
    expect(movementNote(t, 'Bulk shipped — Neurofix')).toBe(t('warehousePage.movements.note.bulkShipped', { product: 'Neurofix' }));
    expect(movementNote(t, 'Order ORD-12345 shipped (warehouse) — Alpha Male')).toBe(t('warehousePage.movements.note.orderShippedProduct', { id: 'ORD-12345', product: 'Alpha Male' }));
    expect(movementNote(t, 'Order ORD-12345 shipped (warehouse)')).toBe(t('warehousePage.movements.note.orderShipped', { id: 'ORD-12345' }));
    expect(movementNote(t, 'донесено од Битола')).toBe('донесено од Битола');
    expect(movementNote(t, null)).toBe('—');
  });
});

describe('small helpers', () => {
  it('groups MEX-8 parcels by their Skopje day, keeping the order', () => {
    const p = (id: string, at: string) => ({ tracking_id: id, created_at: at } as PackRow);
    const g = groupByDay([p('a', '2026-09-29T08:00:00Z'), p('b', '2026-09-29T20:00:00Z'), p('c', '2026-09-29T22:30:00Z')]);
    expect(g.map((x) => [x.day, x.rows.map((r) => r.tracking_id)])).toEqual([['2026-09-29', ['a', 'b']], ['2026-09-30', ['c']]]);
  });
  it('codes and accounts in words', () => {
    expect(codeText(t, 'mex_refused: Invalid city')).toBe(t('warehousePage.code.mex_refused'));
    expect(codeText(t, 'something_new')).toBe('something_new');
    for (const lng of ['mk', 'en', 'sq', 'bg']) for (const c of KNOWN_CODES) expect(i18n.exists(`warehousePage.code.${c}`, { lng })).toBe(true);
    expect(accountName('bio_natural')).toBe('BIO NATURAL');
    expect(accountName('natura')).toBe('NATURA');
  });
});
