import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n from '@/i18n';

// Производи: the brand line on every product (plan 30.09, Фаза 4) — the line
// chips filter, the bulk "Постави линија", the Предлог view (accept one, accept
// all ≥ 90 %, pick a line per row), who may set lines, and that editing still
// works. GET /api/products and the proposal are fixtures; the layout a shell.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
const auth: { user: { id: string; isAdmin: boolean; isManager: boolean } } = {
  user: { id: 'u-admin', isAdmin: true, isManager: false },
};
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const perms = { canSeeBusiness: true };
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => perms }));
vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));
const getProducts = vi.fn();
const getProposal = vi.fn();
const setLine = vi.fn();
const updateProduct = vi.fn();
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetProducts: (...a: unknown[]) => getProducts(...a),
  apiGetSuppliers: async () => [{ id: 's1', name: 'Natura DOO' }],
  apiGetBrandLineProposal: (...a: unknown[]) => getProposal(...a),
  apiSetBrandLine: (...a: unknown[]) => setLine(...a),
  apiUpdateProduct: (...a: unknown[]) => updateProduct(...a),
  apiCreateProduct: vi.fn(),
  apiGetInventoryLogs: async () => [],
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
afterEach(() => {
  vi.clearAllMocks();
  auth.user = { id: 'u-admin', isAdmin: true, isManager: false };
  perms.canSeeBusiness = true;
});

const { default: ProductsPage } = await import('./ProductsPage');

const ID = {
  neuro: '11111111-1111-4111-8111-111111111111',
  mag: '22222222-2222-4222-8222-222222222222',
  snail: '33333333-3333-4333-8333-333333333333',
  uro: '44444444-4444-4444-8444-444444444444',
  alpha: '55555555-5555-4555-8555-555555555555',
};
const product = (id: string, name: string, brand_line: string | null, extra: Record<string, unknown> = {}) => ({
  id, name, description: null, price: 20, cost_price: 5, sku: `SKU-${name.slice(0, 3)}`, stock_quantity: 1000,
  low_stock_threshold: 5, days_of_supply_per_unit: 15, is_active: true, category: '', supplier_id: null, suppliers: null,
  brand_line, ...extra,
});
const PRODUCTS = [
  product(ID.neuro, 'Neurofix', 'bio_natural'),
  product(ID.mag, 'MAGNESIUM CITRAT 325mg', null),
  product(ID.snail, 'СНАИЛ КОМПЛЕКС cps 30', null),
  product(ID.uro, 'Urofix', null),
  product(ID.alpha, 'ALPHA MALE 60 cps', 'natura_therapy'),
];

const prow = (id: string, name: string, o: Record<string, unknown>) => ({
  id, name, sku: null, is_active: true, brand_line: null, brand_line_set_at: null, brand_line_set_by_name: null,
  bio_natural: 0, natura: 0, parcels: 0, majority: null, share: null, bucket: 'none', anchor: null, hint: null,
  suggested: null, suggested_profile: null, confidence: 'none', conflict: false, reason: 'no_parcels', auto: false, ...o,
});
const PROPOSAL = {
  days: 180, generated_at: '2026-09-30T20:00:00Z',
  summary: { products: 5, sure: 3, mixed: 1, none: 0, anchors: 2, conflicts: 1, hints: { ad_astra: 0, dr_becker: 0 }, decided: 0, auto: 3, few_parcels_auto: 0 },
  rows: [
    prow(ID.mag, 'MAGNESIUM CITRAT 325mg', { bio_natural: 97, natura: 13895, parcels: 13992, majority: 'natura', share: 0.993, bucket: 'sure', suggested: 'natura_therapy', suggested_profile: 'natura', confidence: 'high', reason: 'parcels_sure', auto: true }),
    prow(ID.neuro, 'Neurofix', { bio_natural: 2570, natura: 21, parcels: 2591, majority: 'bio_natural', share: 0.99, bucket: 'sure', anchor: 'neurofix', suggested: 'bio_natural', suggested_profile: 'bio_natural', confidence: 'anchor', reason: 'anchor_name', auto: true }),
    prow(ID.snail, 'СНАИЛ КОМПЛЕКС cps 30', { bio_natural: 30, natura: 2846, parcels: 2876, majority: 'natura', share: 0.99, bucket: 'sure', suggested: 'natura_therapy', suggested_profile: 'natura', confidence: 'high', reason: 'parcels_sure', auto: true }),
    prow(ID.uro, 'Urofix', { bio_natural: 1800, natura: 205, parcels: 2005, majority: 'bio_natural', share: 0.898, bucket: 'mixed', suggested: 'bio_natural', suggested_profile: 'bio_natural', confidence: 'low', reason: 'parcels_mixed' }),
    prow(ID.alpha, 'ALPHA MALE 60 cps', { bio_natural: 21, natura: 306, parcels: 327, majority: 'natura', share: 0.936, bucket: 'sure', anchor: 'alphamale', suggested: 'bio_natural', suggested_profile: 'bio_natural', confidence: 'conflict', conflict: true, reason: 'anchor_conflict' }),
  ],
};

/** The writer's answer for (ids, line) against the current fixtures. */
const answer = (ids: string[], line: string | null) => ({
  line, mex_profile: null, requested: ids.length, updated: ids.length, unchanged: 0, missing: [],
  changes: ids.map((id) => ({ id, name: id, from: null, to: line })),
});

let location = '';
function LocationProbe() {
  location = useLocation().search;
  return null;
}
function renderAt(url = '/products') {
  getProducts.mockResolvedValue(structuredClone(PRODUCTS));
  getProposal.mockResolvedValue(structuredClone(PROPOSAL));
  setLine.mockImplementation(async (ids: string[], line: string | null) => answer(ids, line));
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ProductsPage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string;
const catalogue = () => screen.getByRole('table', { name: t('nav.products') });
const shownNames = () => within(catalogue()).getAllByRole('rowheader').map((h) => PRODUCTS.find((p) => h.textContent?.includes(p.name))?.name);
const rowOf = (name: string) => within(catalogue()).getByRole('rowheader', { name: new RegExp(name) }).closest('tr')!;
const lineChips = () => within(screen.getByRole('search')).getByRole('group', { name: t('products.colLine') });

describe('Производи — the line on every product', { timeout: 30_000 }, () => {
  it('every product carries its line; the chips filter and count (URL ?line=)', async () => {
    renderAt();
    await screen.findByRole('table', { name: t('nav.products') }, { timeout: 10_000 });
    expect(shownNames()).toHaveLength(5);
    expect(within(rowOf('Neurofix')).getByRole('button', { name: t('products.line.setFor', { name: 'Neurofix' }) }).textContent).toContain('Bio Natural');
    expect(within(rowOf('Urofix')).getByRole('button', { name: t('products.line.setFor', { name: 'Urofix' }) }).textContent).toContain(t('products.line.none'));

    const chip = (label: string) => within(lineChips()).getByRole('button', { name: new RegExp(`^${label}`) });
    expect(chip('Bio Natural').textContent).toContain('1');
    expect(chip(t('products.line.none')).textContent).toContain('3');
    fireEvent.click(chip('Bio Natural'));
    expect(shownNames()).toEqual(['Neurofix']);
    await waitFor(() => expect(new URLSearchParams(location).get('line')).toBe('bio_natural'));
    fireEvent.click(chip(t('products.line.none')));
    expect(shownNames()).toEqual(['MAGNESIUM CITRAT 325mg', 'СНАИЛ КОМПЛЕКС cps 30', 'Urofix']);
    fireEvent.click(chip('Ad Astra'));
    expect(screen.getByText(t('products.nothingMatches'))).toBeTruthy();
    fireEvent.click(chip(t('products.line.all')));
    expect(shownNames()).toHaveLength(5);
  });

  it('search finds Cyrillic from Latin and keeps the line filter', async () => {
    renderAt('/products?line=none');
    await screen.findByRole('table', { name: t('nav.products') }, { timeout: 10_000 });
    fireEvent.change(within(screen.getByRole('search')).getByRole('searchbox'), { target: { value: 'snail' } });
    expect(shownNames()).toEqual(['СНАИЛ КОМПЛЕКС cps 30']);
  });

  it('one product: the chip picks a line and saves it (audited api)', async () => {
    renderAt();
    await screen.findByRole('table', { name: t('nav.products') }, { timeout: 10_000 });
    fireEvent.click(within(rowOf('Urofix')).getByRole('button', { name: t('products.line.setFor', { name: 'Urofix' }) }));
    const picker = await screen.findByRole('dialog');
    fireEvent.click(within(picker).getByRole('button', { name: /^Bio Natural/ }));
    await waitFor(() => expect(setLine).toHaveBeenCalledWith([ID.uro], 'bio_natural'));
    await waitFor(() =>
      expect(within(rowOf('Urofix')).getByRole('button', { name: t('products.line.setFor', { name: 'Urofix' }) }).textContent).toContain('Bio Natural'));
  });

  it('bulk: select rows → "Постави линија" → one call with every id', async () => {
    renderAt();
    await screen.findByRole('table', { name: t('nav.products') }, { timeout: 10_000 });
    fireEvent.click(within(rowOf('MAGNESIUM')).getByRole('checkbox', { name: t('products.bulk.selectRow', { name: 'MAGNESIUM CITRAT 325mg' }) }));
    fireEvent.click(within(rowOf('СНАИЛ')).getByRole('checkbox', { name: t('products.bulk.selectRow', { name: 'СНАИЛ КОМПЛЕКС cps 30' }) }));
    const bar = screen.getByRole('region', { name: t('products.bulk.setLine') });
    expect(within(bar).getByTestId('products-selected').textContent).toBe(t('products.bulk.selected', { n: '2' }));
    fireEvent.click(within(bar).getByRole('button', { name: t('products.bulk.setLine') }));
    const picker = await screen.findByRole('dialog');
    fireEvent.click(within(picker).getByRole('button', { name: /^Natura Therapy/ }));
    await waitFor(() => expect(setLine).toHaveBeenCalledWith([ID.mag, ID.snail], 'natura_therapy'));
    await waitFor(() => expect(screen.queryByRole('region', { name: t('products.bulk.setLine') })).toBeNull());
    const chip = (name: string) => within(rowOf(name)).getByRole('button', { name: t('products.line.setFor', { name }) });
    expect(chip('MAGNESIUM CITRAT 325mg').textContent).toContain('Natura Therapy');
    expect(chip('СНАИЛ КОМПЛЕКС cps 30').textContent).toContain('Natura Therapy');
  });

  it('"select all" in the header takes every shown row (the filter applies)', async () => {
    renderAt('/products?line=none');
    await screen.findByRole('table', { name: t('nav.products') }, { timeout: 10_000 });
    fireEvent.click(within(catalogue()).getByRole('checkbox', { name: t('products.bulk.selectAll') }));
    expect(screen.getByTestId('products-selected').textContent).toBe(t('products.bulk.selected', { n: '3' }));
  });

  it('an agent sees the line but cannot set it, select rows or open the proposal', async () => {
    auth.user = { id: 'u-agent', isAdmin: false, isManager: false };
    perms.canSeeBusiness = false;
    renderAt('/products?view=proposal');
    await screen.findByRole('table', { name: t('nav.products') }, { timeout: 10_000 });
    expect(within(rowOf('Neurofix')).getByText('Bio Natural')).toBeTruthy();
    expect(within(catalogue()).queryByRole('button', { name: t('products.line.setFor', { name: 'Neurofix' }) })).toBeNull();
    expect(within(catalogue()).queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('tab', { name: t('products.tabs.proposal') })).toBeNull();
    expect(getProposal).not.toHaveBeenCalled();
    // … nor add / edit (admins and managers)
    expect(screen.queryByRole('button', { name: t('products.addProduct') })).toBeNull();
  });

  it('a manager (not an owner) edits products but does not set lines', async () => {
    auth.user = { id: 'u-man', isAdmin: false, isManager: true };
    perms.canSeeBusiness = false;
    renderAt();
    await screen.findByRole('table', { name: t('nav.products') }, { timeout: 10_000 });
    expect(within(catalogue()).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(rowOf('Urofix')).getByRole('button', { name: t('products.editOf', { name: 'Urofix' }) })).toBeTruthy();
    // cost is admins only
    expect(within(catalogue()).queryByRole('columnheader', { name: t('products.colCostPrice') })).toBeNull();
  });

  it('editing still works: the dialog opens filled, and disable still saves', async () => {
    updateProduct.mockResolvedValue({});
    renderAt();
    await screen.findByRole('table', { name: t('nav.products') }, { timeout: 10_000 });
    fireEvent.click(within(rowOf('Urofix')).getByRole('button', { name: t('products.editOf', { name: 'Urofix' }) }));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByRole('textbox', { name: t('products.productNameReq') }) as HTMLInputElement).value).toBe('Urofix');
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));
    await waitFor(() => expect(updateProduct).toHaveBeenCalled());
    const [id, body] = updateProduct.mock.calls[0];
    expect(id).toBe(ID.uro);
    // the form holds денари and sends EUR (the round trip rounds to whole денари, as before)
    expect(body).toMatchObject({ name: 'Urofix', is_active: true, stock_quantity: 1000, low_stock_threshold: 5 });
    expect(body.price).toBeCloseTo(20, 1);
    expect(body.cost_price).toBeCloseTo(5, 1);
    expect(body).not.toHaveProperty('brand_line');

    updateProduct.mockClear();
    fireEvent.click(within(rowOf('Neurofix')).getByRole('button', { name: t('products.disable') }));
    await waitFor(() => expect(updateProduct).toHaveBeenCalledWith(ID.neuro, { is_active: false }));
  });
});

describe('Производи → Предлог', { timeout: 30_000 }, () => {
  const proposalTable = () => screen.getByRole('table', { name: t('products.proposal.title') });
  const prowOf = (name: string) => within(proposalTable()).getByRole('rowheader', { name: new RegExp(name) }).closest('tr')!;

  it('shows the tiles, the reasons and the undecided rows first', async () => {
    renderAt('/products?view=proposal');
    await screen.findByRole('table', { name: t('products.proposal.title') }, { timeout: 10_000 });
    expect(getProposal).toHaveBeenCalled();
    // default filter = undecided (Neurofix / ALPHA MALE are undecided in the proposal fixture too)
    expect(within(proposalTable()).getAllByRole('rowheader')).toHaveLength(5);
    expect(within(prowOf('ALPHA MALE')).getByText(t('products.proposal.confidence.conflict'))).toBeTruthy();
    expect(within(prowOf('Neurofix')).getByText(t('products.proposal.reason.anchor_name'))).toBeTruthy();
    // a mixed row offers "Прифати" too (the owner decides), a conflict row as well
    expect(within(prowOf('Urofix')).getByRole('button', { name: t('products.proposal.acceptFor', { line: 'Bio Natural', name: 'Urofix' }) })).toBeTruthy();
  });

  it('accept one: sets the suggested line of that product only', async () => {
    renderAt('/products?view=proposal');
    await screen.findByRole('table', { name: t('products.proposal.title') }, { timeout: 10_000 });
    fireEvent.click(within(prowOf('Neurofix')).getByRole('button', { name: t('products.proposal.acceptFor', { line: 'Bio Natural', name: 'Neurofix' }) }));
    await waitFor(() => expect(setLine).toHaveBeenCalledWith([ID.neuro], 'bio_natural'));
    // done → it leaves the "not decided" queue and shows under "decided"
    await waitFor(() => expect(within(proposalTable()).queryByRole('rowheader', { name: /Neurofix/ })).toBeNull());
    const chips = screen.getByRole('group', { name: t('products.proposal.filterLabel') });
    fireEvent.click(within(chips).getByRole('button', { name: new RegExp(`^${t('products.proposal.filter.decided')}`) }));
    expect(within(prowOf('Neurofix')).getByText(t('products.proposal.accepted'))).toBeTruthy();
    expect(within(proposalTable()).getAllByRole('rowheader')).toHaveLength(1);
  });

  it('accept all ≥ 90 %: confirms, then one call per line with the auto rows only', async () => {
    renderAt('/products?view=proposal');
    await screen.findByRole('table', { name: t('products.proposal.title') }, { timeout: 10_000 });
    fireEvent.click(screen.getByRole('button', { name: t('products.proposal.acceptAll', { n: '3' }) }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByTestId('accept-all-plan').textContent).toContain('Natura Therapy');
    fireEvent.click(within(confirm).getByRole('button', { name: t('products.proposal.acceptAllConfirm') }));
    await waitFor(() => expect(setLine).toHaveBeenCalledTimes(2));
    expect(setLine).toHaveBeenNthCalledWith(1, [ID.mag, ID.snail], 'natura_therapy');
    expect(setLine).toHaveBeenNthCalledWith(2, [ID.neuro], 'bio_natural');
    // the mixed Urofix and the conflicting ALPHA MALE are never in it
    for (const [ids] of setLine.mock.calls) {
      expect(ids).not.toContain(ID.uro);
      expect(ids).not.toContain(ID.alpha);
    }
    // the button now has nothing left to accept
    await waitFor(() => expect(screen.getByRole('button', { name: t('products.proposal.acceptAll', { n: '0' }) })).toBeDisabled());
  });

  it('pick a line per row: any line, even against the suggestion', async () => {
    renderAt('/products?view=proposal');
    await screen.findByRole('table', { name: t('products.proposal.title') }, { timeout: 10_000 });
    fireEvent.click(within(prowOf('ALPHA MALE')).getByRole('button', { name: t('products.line.setFor', { name: 'ALPHA MALE 60 cps' }) }));
    const picker = await screen.findByRole('dialog');
    fireEvent.click(within(picker).getByRole('button', { name: /^Natura Therapy/ }));
    await waitFor(() => expect(setLine).toHaveBeenCalledWith([ID.alpha], 'natura_therapy'));
  });

  it('the proposal chips filter (mixed → Urofix only)', async () => {
    renderAt('/products?view=proposal');
    await screen.findByRole('table', { name: t('products.proposal.title') }, { timeout: 10_000 });
    const chips = screen.getByRole('group', { name: t('products.proposal.filterLabel') });
    fireEvent.click(within(chips).getByRole('button', { name: new RegExp(`^${t('products.proposal.filter.mixed')}`) }));
    const names = within(proposalTable()).getAllByRole('rowheader').map((h) => h.textContent);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('Urofix');
  });
});
