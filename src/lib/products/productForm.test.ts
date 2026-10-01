import { describe, expect, it } from 'vitest';
import { firstError, followUps, formFromRow, toCreateBody, toPatch, validateForm } from './productForm';
import type { CatalogueRow } from './kinds';

// The product form (Производи 2.0): денари in, EUR out, only what changed.
const ROW: CatalogueRow = {
  id: 'p1', name: 'ELIXY Snail Repair Serum + Snail Repair Dnevna Krema + Snail Repair Nokna Krema + подарок по избор',
  sku: 'SKU-1', barcode: null, price: 24.3902, cost_price: 5, suggested_price: 24.3902, stock_quantity: 1000, low_stock_threshold: 5,
  days_of_supply_per_unit: 15, is_active: true, category: '', description: '', supplier_id: null, supplier_name: null,
  brand_line: 'natura_therapy', kind: 'bundle', created_at: null,
};

describe('the product form', () => {
  it('opens in денари with every field', () => {
    const v = formFromRow(ROW);
    expect(v).toMatchObject({ name: ROW.name, priceDen: '1500', costDen: '308', kind: 'bundle', line: 'natura_therapy', isActive: true, stock: '1000', supply: '15' });
    expect(formFromRow(null)).toMatchObject({ name: '', priceDen: '', kind: null, line: null, isActive: true, threshold: '5', supply: '15' });
  });

  it('an untouched edit changes nothing — the stored EUR price never drifts, a stale stock count is never written', () => {
    const v = formFromRow(ROW);
    expect(toPatch(v, { ...v }, { showCost: true })).toEqual({});
    expect(toPatch(v, { ...v, priceDen: '1500.0' }, { showCost: true })).toEqual({});
  });

  it('sends only what changed, converted to EUR; cost only for those who see it', () => {
    const v = formFromRow(ROW);
    expect(toPatch(v, { ...v, priceDen: '1230', barcode: ' 5310 ' }, { showCost: true })).toEqual({ price: 20, barcode: '5310' });
    expect(toPatch(v, { ...v, costDen: '615' }, { showCost: false })).toEqual({});
    expect(toPatch(v, { ...v, costDen: '615' }, { showCost: true })).toEqual({ cost_price: 10 });
    expect(toPatch(v, { ...v, kind: 'gift', line: 'ad_astra' }, { showCost: true })).toEqual({});   // their own routes
  });

  it('a new product sends every field (and no cost for a manager)', () => {
    const v = { ...formFromRow(null), name: '  Zinc 30  ', priceDen: '615', costDen: '100', stock: '0', barcode: '' };
    expect(toCreateBody(v, { showCost: false })).toEqual({
      name: 'Zinc 30', is_active: true, price: 10, sku: null, barcode: null, stock_quantity: 0, low_stock_threshold: 5,
      days_of_supply_per_unit: 15, description: '', category: '', supplier_id: null,
    });
    expect(toCreateBody(v, { showCost: true })).toMatchObject({ cost_price: 1.63 });
  });

  it('validates and points at the first problem', () => {
    const v = { ...formFromRow(null), name: ' ', priceDen: 'abc', stock: '1.5', supply: '0' };
    const e = validateForm(v, { showCost: true });
    expect(e).toMatchObject({ name: 'required', priceDen: 'number', stock: 'wholeNumber', supply: 'days' });
    expect(firstError(e)).toBe('name');
    expect(validateForm(formFromRow(ROW), { showCost: true })).toEqual({});
  });

  it('kind and line follow-ups only when changed and allowed', () => {
    const v = formFromRow(ROW);
    expect(followUps(v, { ...v, kind: 'gift' }, { canSetKind: true, canSetLine: true, creating: false })).toEqual({ kind: { kind: 'gift' }, line: null });
    expect(followUps(v, { ...v, kind: 'gift' }, { canSetKind: false, canSetLine: true, creating: false })).toEqual({ kind: null, line: null });
    const blank = formFromRow(null);
    expect(followUps(blank, { ...blank, line: 'bio_natural' }, { canSetKind: true, canSetLine: true, creating: true })).toEqual({ kind: null, line: { line: 'bio_natural' } });
  });
});
