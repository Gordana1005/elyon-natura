import { describe, expect, it } from 'vitest';
import type { ProductRecipe } from '@/lib/stockV2Types';
import {
  draftBody, draftChanged, draftCost, draftFrom, hasProposal, isRecipeFilter, matchesRecipe, parseQty, recipeCounts,
  recipeKnown, recipeStatusOf, sigmaCostMkd, validateDraft, type DraftLine,
} from './recipe';

const recipe = (lines: ProductRecipe['lines']): ProductRecipe => ({
  product_id: 'p1', product_name: '2+1 Zinc', exempt: false, lines, cost_mkd: null, complete: false,
});

describe('the catalogue: recipe status and the Sigma cost', () => {
  it('reads the status the api sends; unknown values are "none", absent is undefined', () => {
    expect(recipeStatusOf({ recipe_status: 'approved' })).toBe('approved');
    expect(recipeStatusOf({ recipe_status: 'weird' })).toBe('none');
    expect(recipeStatusOf({ recipe_status: null })).toBe('none');
    expect(recipeStatusOf({})).toBeUndefined();
    expect(recipeKnown([{}, { recipe_status: 'none' }])).toBe(true);
    expect(recipeKnown([{}, {}])).toBe(false);
    expect(isRecipeFilter('none')).toBe(true);
    expect(isRecipeFilter('nope')).toBe(false);
  });

  it('filters and counts; an exempt product (no goods) is never "без рецепт"', () => {
    const rows = [{ recipe_status: 'approved' }, { recipe_status: 'proposed' }, { recipe_status: 'none' }, { recipe_status: 'exempt' }];
    expect(rows.filter((r) => matchesRecipe(r, 'none'))).toHaveLength(1);
    expect(rows.filter((r) => matchesRecipe(r, 'approved'))).toHaveLength(2);
    expect(rows.filter((r) => matchesRecipe(r, 'all'))).toHaveLength(4);
    expect(recipeCounts(rows)).toEqual({ all: 4, approved: 2, proposed: 1, none: 1 });
    // an api without statuses filters nothing away
    expect(matchesRecipe({}, 'none')).toBe(true);
  });

  it('"Набавна (Сигма)" = cost_mkd when sent, else the EUR mirror × 61,5; 0 / null = none', () => {
    expect(sigmaCostMkd({ cost_mkd: 55.9981, cost_price: 9 })).toBe(55.9981);
    expect(sigmaCostMkd({ cost_mkd: null, cost_price: 9 })).toBeNull();
    expect(sigmaCostMkd({ cost_price: 100 / 61.5 })).toBe(100);
    expect(sigmaCostMkd({ cost_price: 0 })).toBeNull();
  });
});

describe('the recipe drawer draft', () => {
  const L = (code: string, status: 'approved' | 'proposed' | 'rejected', x: Partial<ProductRecipe['lines'][number]> = {}) =>
    ({ code, name: `A${code}`, qty: 1, role: 'main' as const, status, confidence: 'high', cost_mkd: 50, ...x });

  it('edits the approved recipe, else the proposal — never rejected lines', () => {
    expect(draftFrom(recipe([L('000001', 'approved'), L('000002', 'proposed')])).map((l) => l.code)).toEqual(['000001']);
    expect(draftFrom(recipe([L('000002', 'proposed'), L('000003', 'rejected')])).map((l) => l.code)).toEqual(['000002']);
    expect(draftFrom(null)).toEqual([]);
    expect(hasProposal(recipe([L('000002', 'proposed')]))).toBe(true);
    expect(hasProposal(recipe([L('000001', 'approved')]))).toBe(false);
  });

  it('costs a bundle as the sum of its lines; a line without a cost makes it incomplete', () => {
    const lines: DraftLine[] = [
      { code: '001654', name: 'ZINC', qty: 3, role: 'main', cost_mkd: 40.5 },
      { code: '001641', name: 'MAGNESIUM GEL', qty: 1, role: 'gift', cost_mkd: 70 },
    ];
    expect(draftCost(lines)).toEqual({ total: 191.5, complete: true });
    expect(draftCost([...lines, { code: '000999', name: 'X', qty: 1, role: 'component', cost_mkd: null }])).toEqual({ total: 191.5, complete: false });
    expect(draftCost([])).toEqual({ total: null, complete: false });
  });

  it('validates and builds the body; a reorder is not a change', () => {
    const a: DraftLine[] = [
      { code: '000001', name: 'A', qty: 2, role: 'main', cost_mkd: 1 },
      { code: '000002', name: 'B', qty: 1, role: 'gift', cost_mkd: null },
    ];
    expect(validateDraft(a)).toBeNull();
    expect(validateDraft([])).toBe('empty');
    expect(validateDraft([{ ...a[0], qty: 0 }])).toBe('qty');
    expect(validateDraft([{ ...a[0], qty: 101 }])).toBe('qty');
    expect(validateDraft([a[0], a[0]])).toBe('duplicate');
    expect(draftBody('p1', a, true)).toEqual({
      product_id: 'p1', approve: true, lines: [{ code: '000001', qty: 2, role: 'main' }, { code: '000002', qty: 1, role: 'gift' }],
    });
    expect(draftChanged(a, [a[1], a[0]])).toBe(false);
    expect(draftChanged(a, [{ ...a[0], qty: 3 }, a[1]])).toBe(true);
    expect(parseQty('0,5')).toBe(0.5);
    expect(parseQty('2')).toBe(2);
    expect(Number.isNaN(parseQty('x'))).toBe(true);
  });
});
