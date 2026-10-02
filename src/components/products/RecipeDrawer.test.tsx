import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/i18n';
import type { ProductRecipe } from '@/lib/stockV2Types';
import { RecipeDrawer } from './RecipeDrawer';
import { RecipeCost } from './RecipeCost';

// The recipe drawer (owners, Stock v2 — owner 01.10.2026): which Sigma articles a product is made of,
// each line's CalcBuyPrice, the product's cost = Σ qty × unit cost; save as a proposal, save and
// approve, or approve a waiting proposal. The routes are mocked.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
const getRecipe = vi.fn();
const setRecipe = vi.fn();
const approve = vi.fn();
const search = vi.fn();
vi.mock('./recipeApi', () => ({
  apiProductRecipe: (...a: unknown[]) => getRecipe(...a),
  apiProductRecipeSet: (...a: unknown[]) => setRecipe(...a),
  apiProductRecipeApprove: (...a: unknown[]) => approve(...a),
  apiStockArticlesSearch: (...a: unknown[]) => search(...a),
}));

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string;
const P = { id: 'p-1', name: '2+1 ZINC + MAGNESIUM GEL' };
const RECIPE: ProductRecipe = {
  product_id: 'p-1', product_name: P.name, exempt: false, complete: true, cost_mkd: 191.5,
  lines: [
    { code: '001654', name: 'ZINC 120/1 tab', qty: 3, role: 'main', status: 'proposed', confidence: 'high', cost_mkd: 40.5 },
    { code: '001641', name: 'MAGNESIUM GEL 50ml', qty: 1, role: 'gift', status: 'proposed', confidence: 'medium', cost_mkd: 70 },
  ],
};

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
afterEach(() => vi.clearAllMocks());

describe('the recipe drawer', { timeout: 20_000 }, () => {
  it('shows the lines, their costs and the product cost; a waiting proposal can be approved as it is', async () => {
    getRecipe.mockResolvedValue(RECIPE);
    approve.mockResolvedValue({ ok: true });
    const onChanged = vi.fn();
    render(<RecipeDrawer product={P} open onOpenChange={() => {}} onChanged={onChanged} />);
    const drawer = await screen.findByTestId('recipe-drawer');
    await waitFor(() => expect(within(drawer).getAllByText(/ZINC 120\/1 tab|MAGNESIUM GEL 50ml/)).toHaveLength(2));
    expect(within(drawer).getByText(t('productsRecipe.status.proposed'))).toBeTruthy();
    // 3 × 40,50 + 1 × 70 = 191,50 ден (the gift is a real cost)
    expect(within(drawer).getByTestId('recipe-total').textContent).toBe('192 ден');   // whole денари from 100 up
    fireEvent.click(within(drawer).getByRole('button', { name: t('productsRecipe.drawer.approve') }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(['p-1']));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('edits a quantity and saves + approves; an article without a cost makes the product incomplete', async () => {
    getRecipe.mockResolvedValue({ ...RECIPE, lines: RECIPE.lines.map((l) => ({ ...l, status: 'approved' as const })) });
    search.mockResolvedValue([{ code: '000999', name: 'ФЛАЕР', unit: 'КОМ', brand: null, active: true, on_hand: null, cost_mkd: null }]);
    setRecipe.mockResolvedValue({ ok: true });
    render(<RecipeDrawer product={P} open onOpenChange={() => {}} />);
    const drawer = await screen.findByTestId('recipe-drawer');
    await waitFor(() => expect(within(drawer).getAllByRole('textbox', { name: t('productsRecipe.drawer.qty') })).toHaveLength(2));
    fireEvent.change(within(drawer).getAllByRole('textbox', { name: t('productsRecipe.drawer.qty') })[0], { target: { value: '2' } });
    fireEvent.change(within(drawer).getByPlaceholderText(t('productsRecipe.drawer.search')), { target: { value: 'флаер' } });
    fireEvent.click(await within(drawer).findByRole('button', { name: /ФЛАЕР/ }, { timeout: 2000 }));
    expect(within(drawer).getByText(t('productsRecipe.drawer.incomplete'))).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: t('productsRecipe.drawer.saveApprove') }));
    await waitFor(() => expect(setRecipe).toHaveBeenCalledWith({
      product_id: 'p-1', approve: true,
      lines: [{ code: '001654', qty: 2, role: 'main' }, { code: '001641', qty: 1, role: 'gift' }, { code: '000999', qty: 1, role: 'component' }],
    }));
    // the recipe is read back after the save (the route answers with the writer's result)
    await waitFor(() => expect(getRecipe).toHaveBeenCalledTimes(2));
  });

  it('a route that is not deployed yet says so', async () => {
    getRecipe.mockRejectedValue(new Error('HTTP 404'));
    render(<RecipeDrawer product={P} open onOpenChange={() => {}} />);
    expect(await screen.findByText(t('productsRecipe.drawer.notDeployed'))).toBeTruthy();
  });
});

describe('the "Набавна (Сигма)" cell', () => {
  it('shows the Sigma cost in денари and the recipe status; no cost is "—", never 0', () => {
    const open = vi.fn();
    const { rerender } = render(<RecipeCost r={{ name: 'Zinc', cost_mkd: 40.5, recipe_status: 'approved' }} onOpen={open} />);
    expect(screen.getByTestId('recipe-cost').textContent).toContain('41 ден');
    expect(screen.getByTestId('recipe-cost').textContent).toContain(t('productsRecipe.status.approved'));
    fireEvent.click(screen.getByTestId('recipe-cost'));
    expect(open).toHaveBeenCalled();
    rerender(<RecipeCost r={{ name: 'Zinc', cost_mkd: null, recipe_status: 'none' }} onOpen={open} />);
    expect(screen.getByTestId('recipe-cost').textContent).toContain('—');
    expect(screen.getByTestId('recipe-cost').textContent).toContain(t('productsRecipe.status.none'));
  });
});
