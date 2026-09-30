import { describe, expect, it } from 'vitest';
import {
  BRAND_LINES, LINE_FILTERS, applyLineChanges, autoAcceptPlan, canAccept, filterProducts, isFewParcels,
  lineCounts, lineOf, matchesProposalFilter, mexProfileForLine, proposalCounts, type ProposalRow,
} from './brandLines';

const P = (id: string, name: string, brand_line: unknown = null, extra: Record<string, unknown> = {}) =>
  ({ id, name, sku: `SKU-${id}`, category: '', brand_line, ...extra });

const CATALOGUE = [
  P('1', 'Neurofix', 'bio_natural'),
  P('2', 'MAGNESIUM CITRAT 325mg', 'natura_therapy'),
  P('3', 'СНАИЛ КОМПЛЕКС cps 30', null),
  P('4', 'Dr.Becker Vitamin', 'dr_becker'),
  P('5', 'Urofix', undefined),
  P('6', 'Ad Astra Serum', 'ad_astra', { category: 'Козметика' }),
  P('7', 'Old thing', 'something_else'),
];

describe('lines', () => {
  it('four lines; the chips add all and not decided', () => {
    expect(BRAND_LINES).toEqual(['natura_therapy', 'bio_natural', 'ad_astra', 'dr_becker']);
    expect(LINE_FILTERS).toEqual(['all', 'natura_therapy', 'bio_natural', 'ad_astra', 'dr_becker', 'none']);
  });
  it('the MEX profile of each line (owner 30.09)', () => {
    expect(BRAND_LINES.map(mexProfileForLine)).toEqual(['natura', 'bio_natural', 'natura', 'bio_natural']);
    expect(mexProfileForLine(null)).toBeNull();
  });
  it('an unknown or missing value is not decided', () => {
    expect(lineOf({ brand_line: 'something_else' })).toBeNull();
    expect(lineOf({})).toBeNull();
    expect(lineOf({ brand_line: 'ad_astra' })).toBe('ad_astra');
  });
});

describe('lineCounts / filterProducts', () => {
  it('counts every product once, undecided under none', () => {
    expect(lineCounts(CATALOGUE)).toEqual({
      all: 7, natura_therapy: 1, bio_natural: 1, ad_astra: 1, dr_becker: 1, none: 3,
    });
  });
  it('a line chip shows that line; none shows the undecided', () => {
    expect(filterProducts(CATALOGUE, { line: 'bio_natural', query: '' }).map((p) => p.id)).toEqual(['1']);
    expect(filterProducts(CATALOGUE, { line: 'none', query: '' }).map((p) => p.id)).toEqual(['3', '5', '7']);
    expect(filterProducts(CATALOGUE, { line: 'all', query: '' })).toHaveLength(7);
  });
  it('search: every word, name / SKU / category, Latin finds Cyrillic', () => {
    expect(filterProducts(CATALOGUE, { line: 'all', query: 'snail' }).map((p) => p.id)).toEqual(['3']);
    expect(filterProducts(CATALOGUE, { line: 'all', query: 'magnesium 325' }).map((p) => p.id)).toEqual(['2']);
    expect(filterProducts(CATALOGUE, { line: 'all', query: 'sku-4' }).map((p) => p.id)).toEqual(['4']);
    expect(filterProducts(CATALOGUE, { line: 'all', query: 'kozmetika' }).map((p) => p.id)).toEqual(['6']);
    expect(filterProducts(CATALOGUE, { line: 'none', query: 'fix' }).map((p) => p.id)).toEqual(['5']);
  });
});

const row = (id: string, o: Partial<ProposalRow>): ProposalRow => ({
  id, name: `P${id}`, sku: null, is_active: true, brand_line: null, brand_line_set_at: null, brand_line_set_by_name: null,
  bio_natural: 0, natura: 0, parcels: 0, majority: null, share: null, bucket: 'none', anchor: null, hint: null,
  suggested: null, suggested_profile: null, confidence: 'none', conflict: false, reason: 'no_parcels', auto: false, ...o,
});

const PROPOSAL: ProposalRow[] = [
  row('a', { bucket: 'sure', bio_natural: 2570, natura: 21, parcels: 2591, majority: 'bio_natural', anchor: 'neurofix', suggested: 'bio_natural', confidence: 'anchor', reason: 'anchor_name', auto: true }),
  row('b', { bucket: 'sure', bio_natural: 97, natura: 13895, parcels: 13992, majority: 'natura', suggested: 'natura_therapy', confidence: 'high', reason: 'parcels_sure', auto: true }),
  row('c', { bucket: 'sure', bio_natural: 1, parcels: 1, majority: 'bio_natural', suggested: 'bio_natural', confidence: 'high', reason: 'parcels_sure', auto: true }),
  row('d', { bucket: 'mixed', bio_natural: 1800, natura: 205, parcels: 2005, majority: 'bio_natural', suggested: 'bio_natural', confidence: 'low', reason: 'parcels_mixed' }),
  row('e', { bucket: 'sure', bio_natural: 21, natura: 306, parcels: 327, majority: 'natura', anchor: 'alphamale', suggested: 'bio_natural', confidence: 'conflict', conflict: true, reason: 'anchor_conflict' }),
  row('f', { hint: 'dr_becker', suggested: 'dr_becker', confidence: 'hint', reason: 'hint_name' }),
  row('g', { brand_line: 'natura_therapy', bucket: 'sure', natura: 50, parcels: 50, majority: 'natura', suggested: 'natura_therapy', confidence: 'high', reason: 'parcels_sure' }),
  row('h', {}),
];

describe('the proposal', () => {
  it('filter chips count their rows', () => {
    expect(proposalCounts(PROPOSAL)).toEqual({ todo: 7, auto: 3, mixed: 1, conflict: 1, none: 2, decided: 1, all: 8 });
    expect(PROPOSAL.filter((r) => matchesProposalFilter(r, 'auto')).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
  it('"accept all" = the auto rows only, one call per line in the owner order', () => {
    expect(autoAcceptPlan(PROPOSAL)).toEqual([
      { line: 'natura_therapy', ids: ['b'] },
      { line: 'bio_natural', ids: ['a', 'c'] },
    ]);
  });
  it('never a conflict, a hint, a mixed row or an already decided product', () => {
    const ids = autoAcceptPlan(PROPOSAL).flatMap((c) => c.ids);
    for (const x of ['d', 'e', 'f', 'g', 'h']) expect(ids).not.toContain(x);
  });
  it('chunks a big line', () => {
    const many = Array.from({ length: 5 }, (_, i) => row(`n${i}`, { suggested: 'natura_therapy', confidence: 'high', auto: true }));
    expect(autoAcceptPlan(many, 2).map((c) => c.ids.length)).toEqual([2, 2, 1]);
  });
  it('accept needs a suggestion that is not already the line', () => {
    expect(canAccept(PROPOSAL[0])).toBe(true);
    expect(canAccept(PROPOSAL[6])).toBe(false);
    expect(canAccept(PROPOSAL[7])).toBe(false);
  });
  it('few parcels = 1..9', () => {
    expect(isFewParcels(PROPOSAL[2])).toBe(true);
    expect(isFewParcels(PROPOSAL[1])).toBe(false);
    expect(isFewParcels(PROPOSAL[7])).toBe(false);
  });
  it('a writer answer moves the rows; clearing an anchor makes it auto again', () => {
    const set = applyLineChanges(PROPOSAL, { changes: [{ id: 'a', name: 'Pa', from: null, to: 'bio_natural' }] });
    expect(set.find((r) => r.id === 'a')).toMatchObject({ brand_line: 'bio_natural', auto: false });
    expect(set.find((r) => r.id === 'b')).toBe(PROPOSAL[1]);
    const cleared = applyLineChanges(set, { changes: [{ id: 'a', name: 'Pa', from: 'bio_natural', to: null }] });
    expect(cleared.find((r) => r.id === 'a')).toMatchObject({ brand_line: null, auto: true });
    const conflictCleared = applyLineChanges(PROPOSAL, { changes: [{ id: 'e', name: 'Pe', from: null, to: null }] });
    expect(conflictCleared.find((r) => r.id === 'e')?.auto).toBe(false);
  });
  it('works on catalogue rows too (no auto key added)', () => {
    const out = applyLineChanges(CATALOGUE, { changes: [{ id: '3', name: 'x', from: null, to: 'natura_therapy' }] });
    expect(out.find((p) => p.id === '3')).toEqual({ ...CATALOGUE[2], brand_line: 'natura_therapy' });
  });
});
