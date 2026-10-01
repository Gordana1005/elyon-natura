import { describe, expect, it } from 'vitest';
import {
  applyKindChanges, autoKindPlan, byName, facetCounts, filterCatalogue, indexRows, kindProposalCounts,
  type CatalogueFilters, type CatalogueRow, type KindProposalRow,
} from './kinds';

// Производи 2.0 — the list filters. Real catalogue names; no customer data.
let n = 0;
const P = (name: string, o: Partial<CatalogueRow> = {}): CatalogueRow => ({
  id: `p${++n}`, name, sku: null, barcode: null, price: 20, suggested_price: 20, stock_quantity: 1000, low_stock_threshold: 5,
  days_of_supply_per_unit: 15, is_active: true, category: '', description: '', supplier_id: null, supplier_name: null,
  brand_line: null, kind: null, created_at: null, ...o,
});
const ROWS = [
  P('СНАИЛ КОМПЛЕКС cps 30', { kind: 'product', brand_line: 'natura_therapy', sku: '000060' }),
  P('Neurofix', { kind: 'product', brand_line: 'bio_natural' }),
  P('2x Diet Shake + Slim Complex', { kind: 'bundle', brand_line: 'ad_astra', is_active: false }),
  P('ГЛУКОЗАМИН СУЛФАТ 30 cps', { kind: 'gift', brand_line: 'natura_therapy' }),
  P('ТЕЛЕСНА ВАГА', { kind: 'other', is_active: false }),
  P('Arthriva'),
];
const idx = indexRows(ROWS);
const F = (o: Partial<CatalogueFilters> = {}): CatalogueFilters => ({ kind: 'product', line: 'all', status: 'all', query: '', ...o });
const names = (rows: CatalogueRow[]) => rows.map((r) => r.name);

describe('the catalogue filters', () => {
  it('the default view is the ordinary products', () => {
    expect(names(filterCatalogue(idx, F()))).toEqual(['СНАИЛ КОМПЛЕКС cps 30', 'Neurofix']);
  });
  it('each kind chip, Неодредено and Сите', () => {
    expect(names(filterCatalogue(idx, F({ kind: 'bundle' })))).toEqual(['2x Diet Shake + Slim Complex']);
    expect(names(filterCatalogue(idx, F({ kind: 'gift' })))).toEqual(['ГЛУКОЗАМИН СУЛФАТ 30 cps']);
    expect(names(filterCatalogue(idx, F({ kind: 'other' })))).toEqual(['ТЕЛЕСНА ВАГА']);
    expect(names(filterCatalogue(idx, F({ kind: 'none' })))).toEqual(['Arthriva']);
    expect(filterCatalogue(idx, F({ kind: 'all' }))).toHaveLength(6);
  });
  it('line, status and a Latin search over Cyrillic names combine', () => {
    expect(names(filterCatalogue(idx, F({ kind: 'all', line: 'natura_therapy' })))).toEqual(['СНАИЛ КОМПЛЕКС cps 30', 'ГЛУКОЗАМИН СУЛФАТ 30 cps']);
    expect(names(filterCatalogue(idx, F({ kind: 'all', status: 'inactive' })))).toEqual(['2x Diet Shake + Slim Complex', 'ТЕЛЕСНА ВАГА']);
    expect(names(filterCatalogue(idx, F({ kind: 'all', query: 'snail' })))).toEqual(['СНАИЛ КОМПЛЕКС cps 30']);
    expect(names(filterCatalogue(idx, F({ query: '000060' })))).toEqual(['СНАИЛ КОМПЛЕКС cps 30']);   // SKU
  });
  it('faceted counts: each group counts what a click on it would show', () => {
    const f = facetCounts(idx, F({ query: 'cps' }));
    expect(f.kind).toMatchObject({ product: 1, gift: 1, bundle: 0, all: 2 });
    expect(f.line).toMatchObject({ all: 1, natura_therapy: 1 });           // kind = product applied
    expect(f.status).toMatchObject({ all: 1, active: 1, inactive: 0 });
  });
  it('sorts names the Macedonian way', () => {
    expect([P('Б'), P('А'), P('10 x'), P('2 x')].sort(byName).map((p) => p.name)).toEqual(['2 x', '10 x', 'А', 'Б']);
  });
});

const R = (id: string, o: Partial<KindProposalRow>): KindProposalRow => ({
  id, name: id, sku: null, is_active: true, kind: null, kind_set_at: null, kind_set_by_name: null, suggested: 'product',
  confidence: 'high', reason: 'single', hit: null, lines: 0, free_lines: 0, free_share: null, auto: true, ...o,
});

describe('the kind proposal', () => {
  const rows = [
    R('a', {}), R('b', { suggested: 'bundle', reason: 'promo' }), R('c', { suggested: 'gift', confidence: 'low', auto: false }),
    R('d', { kind: 'product', suggested: 'gift', auto: false }), R('e', { suggested: 'other' }),
  ];
  it('counts the chips', () => {
    expect(kindProposalCounts(rows)).toEqual({ todo: 4, auto: 3, low: 1, differs: 1, decided: 1, all: 5 });
  });
  it('"accept all sure" takes only the auto rows, one call per kind in the owner\'s order', () => {
    expect(autoKindPlan(rows)).toEqual([{ kind: 'product', ids: ['a'] }, { kind: 'bundle', ids: ['b'] }, { kind: 'other', ids: ['e'] }]);
  });
  it('applies a writer answer; a kind cleared back to Неодредено is offered again', () => {
    const after = applyKindChanges(rows, { changes: [{ id: 'a', name: 'a', from: null, to: 'product' }, { id: 'd', name: 'd', from: 'product', to: null }] });
    expect(after.find((r) => r.id === 'a')).toMatchObject({ kind: 'product', auto: false });
    expect(after.find((r) => r.id === 'd')).toMatchObject({ kind: null, auto: true });
  });
});
