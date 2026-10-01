import { describe, expect, it } from 'vitest';
import {
  applyVatChanges, asVatRate, matchesVat, parseVatEvidence, ratePct, shownVatFilters, vatFilterOf, vatOf, vatShare, vatSourceOf,
  VAT_FILTERS, type VatFilter,
} from './vat';
import { facetCounts, filterCatalogue, indexRows, type CatalogueRow } from './kinds';

// VAT per product from Sigma (owner 01.10.2026). Real catalogue names; no customer data.
let n = 0;
const P = (name: string, vat_rate: number | null, o: Partial<CatalogueRow> = {}): CatalogueRow => ({
  id: `p${++n}`, name, sku: null, barcode: null, price: 20, suggested_price: 20, stock_quantity: 1000, low_stock_threshold: 5,
  days_of_supply_per_unit: 15, is_active: true, category: '', description: '', supplier_id: null, supplier_name: null,
  brand_line: 'natura_therapy', kind: 'product', created_at: null, vat_rate: vat_rate as CatalogueRow['vat_rate'], ...o,
});

describe('rates', () => {
  it('reads the four rates (numeric text too), else unclassified', () => {
    expect(asVatRate('0.050')).toBe(0.05);
    expect(asVatRate(0.18)).toBe(0.18);
    expect(asVatRate(0.2)).toBeNull();
    expect(vatOf({})).toBeNull();
    expect(ratePct(0.18)).toBe('18%');
    expect(vatShare(0.05) * 500).toBeCloseTo(23.81, 2);    // the MEX invoice: 476,19 + 23,81 = 500,00
  });

  it('the source: Sigma crosswalk (with confidence), by name, a rule, or an owner', () => {
    expect(vatSourceOf('sigma:crosswalk-VERIFIED')).toEqual({ kind: 'crosswalk', detail: 'VERIFIED' });
    expect(vatSourceOf('sigma:by-name+mixed')).toEqual({ kind: 'byNameMixed', detail: null });
    expect(vatSourceOf('sigma:by-name')).toEqual({ kind: 'byName', detail: null });
    expect(vatSourceOf('sigma:manual')).toEqual({ kind: 'manual', detail: null });
    expect(vatSourceOf('rule:cosmetic-18')).toEqual({ kind: 'rule', detail: 'cosmetic-18' });
    expect(vatSourceOf('owner')).toEqual({ kind: 'owner', detail: null });
    expect(vatSourceOf(null)).toBeNull();
  });

  it('reads the invoice evidence; an owner note stays raw', () => {
    expect(parseVatEvidence('2025@5.00: 88; 2026@0.00: 1; mex@18.00: 10')).toEqual([
      { kind: 'year', year: '2025', rate: 0.05, lines: 88 },
      { kind: 'year', year: '2026', rate: 0, lines: 1 },
      { kind: 'mex', year: null, rate: 0.18, lines: 10 },
    ]);
    expect(parseVatEvidence('Сметководител: 18 % за гелови')).toBeNull();
    expect(parseVatEvidence('')).toBeNull();
  });
});

describe('the /products VAT filter (owners)', () => {
  const rows = [P('ВЕНО ГЕЛ', 0.18), P('МАГНЕЗИУМ', 0.05), P('Нов производ', null), P('Цинк', 0.05, { is_active: false })];
  const idx = indexRows(rows);
  const F = (vat: VatFilter) => ({ kind: 'all' as const, line: 'all' as const, status: 'all' as const, query: '', vat });

  it('filters by rate and by unclassified', () => {
    expect(filterCatalogue(idx, F('r18')).map((r) => r.name)).toEqual(['ВЕНО ГЕЛ']);
    expect(filterCatalogue(idx, F('none')).map((r) => r.name)).toEqual(['Нов производ']);
    expect(filterCatalogue(idx, F('all'))).toHaveLength(4);
    expect(matchesVat({ vat_rate: 0.05 }, undefined)).toBe(true);
    expect(vatFilterOf({ vat_rate: null })).toBe('none');
  });

  it('counts what a click would show; zero rates are hidden unless chosen', () => {
    const f = facetCounts(idx, { ...F('all'), status: 'active' });
    expect(f.vat).toMatchObject({ all: 3, r5: 1, r18: 1, none: 1, r10: 0, r0: 0 });
    expect(shownVatFilters(f.vat, 'all')).toEqual(['all', 'r5', 'r18', 'none']);
    expect(shownVatFilters(f.vat, 'r10')).toEqual(['all', 'r5', 'r18', 'r10', 'none']);
    expect(VAT_FILTERS).toContain('none');
  });

  it("applies the writer's answer locally (rate, source owner, set now)", () => {
    const now = new Date('2026-10-01T18:00:00Z');
    const out = applyVatChanges(rows, { changes: [{ id: rows[2].id, name: 'Нов производ', from: null, to: 0.18, from_source: null }] }, now);
    expect(out[2]).toMatchObject({ vat_rate: 0.18, vat_source: 'owner', vat_set_at: now.toISOString() });
    expect(out[0]).toBe(rows[0]);
    const cleared = applyVatChanges(rows, { changes: [{ id: rows[0].id, name: 'x', from: 0.18, to: null, from_source: 'owner' }] }, now);
    expect(cleared[0]).toMatchObject({ vat_rate: null, vat_source: null });
  });
});
