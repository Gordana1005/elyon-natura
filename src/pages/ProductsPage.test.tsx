import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import i18n from '@/i18n';

// Производи 2.0 (owner 01.10.2026): the page opens on the ordinary PRODUCTS; kind chips (Пакети и
// промоции · Подароци · Друго · Неодредено · Сите) and line chips filter; 50 rows a page; the new
// product form (sections, only what changed, kind + line through their audited routes); a manager
// edits but never sees cost; the Предлог tab carries both proposals. The api is mocked; the layout a shell.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
const auth: { user: { id: string; isAdmin: boolean; isManager: boolean } } = { user: { id: 'u-admin', isAdmin: true, isManager: false } };
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
const perms = { canSeeBusiness: true };
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => perms }));
vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));
const getCatalogue = vi.fn();
const getKindProposal = vi.fn();
const setKind = vi.fn();
const getLineProposal = vi.fn();
const setLine = vi.fn();
const updateProduct = vi.fn();
const createProduct = vi.fn();
const setVat = vi.fn();
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetProductCatalogue: (...a: unknown[]) => getCatalogue(...a),
  apiGetSuppliers: async () => [{ id: 's1', name: 'Natura DOO' }],
  apiGetKindProposal: (...a: unknown[]) => getKindProposal(...a),
  apiSetProductKind: (...a: unknown[]) => setKind(...a),
  apiGetBrandLineProposal: (...a: unknown[]) => getLineProposal(...a),
  apiSetBrandLine: (...a: unknown[]) => setLine(...a),
  apiUpdateProduct: (...a: unknown[]) => updateProduct(...a),
  apiCreateProduct: (...a: unknown[]) => createProduct(...a),
  apiSetProductVatRate: (...a: unknown[]) => setVat(...a),
  apiGetInventoryLogs: async () => [],
}));

let wide = true;
beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query.includes('1280') ? wide : false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }),
  });
  await i18n.changeLanguage('mk');
});
afterEach(() => {
  vi.clearAllMocks();
  auth.user = { id: 'u-admin', isAdmin: true, isManager: false };
  perms.canSeeBusiness = true;
  wide = true;
});

const { default: ProductsPage } = await import('./ProductsPage');

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = (n: number, name: string, kind: string | null, o: Record<string, unknown> = {}) => ({
  id: uid(n), name, sku: `SKU-${n}`, barcode: null, price: 20, cost_price: 5, suggested_price: 20, stock_quantity: 1000,
  low_stock_threshold: 5, days_of_supply_per_unit: 15, is_active: true, category: '', description: '', supplier_id: null,
  supplier_name: null, brand_line: null, kind, created_at: null, ...o,
});
const ROWS = [
  P(1, 'Neurofix', 'product', { brand_line: 'bio_natural' }),
  P(2, 'СНАИЛ КОМПЛЕКС cps 30', 'product', { brand_line: 'natura_therapy' }),
  P(3, '2x Diet Shake + Slim Complex', 'bundle', { brand_line: 'ad_astra' }),
  P(4, 'ГЛУКОЗАМИН СУЛФАТ 30 cps', 'gift'),
  P(5, 'ТЕЛЕСНА ВАГА', 'other', { is_active: false }),
  P(6, 'Arthriva', null, { description: 'Креиран автоматски (complete-catalogue, run x): производ со продажби' }),
];
const idOf = (name: string) => ROWS.find((r) => r.name === name)!.id;

const KR = (n: number, name: string, o: Record<string, unknown>) => ({
  id: uid(n), name, sku: null, is_active: true, kind: null, kind_set_at: null, kind_set_by_name: null, suggested: 'product',
  confidence: 'high', reason: 'single', hit: null, lines: 0, free_lines: 0, free_share: null, auto: true, ...o,
});
const KIND_PROPOSAL = {
  generated_at: '2026-10-01T00:00:00Z',
  summary: { products: 3, suggested: { product: 1, bundle: 1, gift: 1, other: 0, none: 0 }, decided: 0, auto: 2, low: 1, differs: 0 },
  rows: [
    KR(6, 'Arthriva', {}),
    KR(7, 'СПИРУЛИНА 150+150 tbl', { suggested: 'bundle', reason: 'promo', hit: '150+150' }),
    KR(8, 'САУ ПАЛМЕТТО (Saw Palmetto) 30 cps', { suggested: 'gift', reason: 'free_in_orders', confidence: 'low', auto: false, lines: 100, free_lines: 83, free_share: 0.83 }),
  ],
};
const LINE_PROPOSAL = {
  days: 180, generated_at: '2026-10-01T00:00:00Z',
  summary: { products: 1, sure: 1, mixed: 0, none: 0, anchors: 0, conflicts: 0, hints: { ad_astra: 0, dr_becker: 0 }, decided: 0, auto: 1, few_parcels_auto: 0 },
  rows: [{
    id: uid(6), name: 'Arthriva', sku: null, is_active: true, brand_line: null, brand_line_set_at: null, brand_line_set_by_name: null,
    bio_natural: 30, natura: 0, parcels: 30, majority: 'bio_natural', share: 1, bucket: 'sure', anchor: null, hint: null,
    suggested: 'bio_natural', suggested_profile: 'bio_natural', confidence: 'high', conflict: false, reason: 'parcels_sure', auto: true,
  }],
};
const kindAnswer = (ids: string[], kind: string | null) => ({ kind, requested: ids.length, updated: ids.length, unchanged: 0, missing: [], changes: ids.map((id) => ({ id, name: id, from: null, to: kind })) });
const lineAnswer = (ids: string[], line: string | null) => ({ line, mex_profile: null, requested: ids.length, updated: ids.length, unchanged: 0, missing: [], changes: ids.map((id) => ({ id, name: id, from: null, to: line })) });

let location = '';
function LocationProbe() { location = useLocation().search; return null; }
function renderAt(url = '/products?status=all', rows: unknown[] = ROWS, vatVisible = false) {
  getCatalogue.mockResolvedValue({ generated_at: null, vat_visible: vatVisible, rows: structuredClone(rows) });
  getKindProposal.mockResolvedValue(structuredClone(KIND_PROPOSAL));
  getLineProposal.mockResolvedValue(structuredClone(LINE_PROPOSAL));
  setKind.mockImplementation(async (ids: string[], kind: string | null) => kindAnswer(ids, kind));
  setLine.mockImplementation(async (ids: string[], line: string | null) => lineAnswer(ids, line));
  updateProduct.mockResolvedValue({});
  return render(<MemoryRouter initialEntries={[url]}><ProductsPage /><LocationProbe /></MemoryRouter>);
}

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o) as string;
const table = () => screen.getByRole('table', { name: t('nav.products') });
const shownNames = () => within(table()).queryAllByRole('rowheader').map((h) => ROWS.find((p) => h.textContent?.includes(p.name))?.name);
const rowOf = (name: string) => within(table()).getByRole('rowheader', { name: new RegExp(name) }).closest('tr')!;
const group = (labelKey: string) => within(screen.getByRole('search')).getByRole('group', { name: t(labelKey) });
const chipIn = (labelKey: string, label: string) => within(group(labelKey)).getByRole('button', { name: new RegExp(`^${label}`) });
const loaded = () => screen.findByRole('table', { name: t('nav.products') }, { timeout: 10_000 });

describe('Производи 2.0 — the list', { timeout: 30_000 }, () => {
  it('opens on the ordinary PRODUCTS: the Производи chip is on, the rest are counted', async () => {
    renderAt();
    await loaded();
    // Macedonian order: Cyrillic first
    expect(shownNames()).toEqual(['СНАИЛ КОМПЛЕКС cps 30', 'Neurofix']);
    const products = chipIn('products.kindFilter.label', t('products.kindFilter.product'));
    expect(products.getAttribute('aria-pressed')).toBe('true');
    expect(products.textContent).toContain('2');
    expect(chipIn('products.kindFilter.label', t('products.kindFilter.bundle')).textContent).toContain('1');
    expect(chipIn('products.kindFilter.label', t('products.kindFilter.all')).textContent).toContain('6');
    // no machine description anywhere on the page
    expect(screen.queryByText(/Креиран автоматски/)).toBeNull();
  });

  it('a bare /products shows ACTIVE products only (owner 01.10.2026) — inactive ones one click away', async () => {
    renderAt('/products?kind=all');
    await loaded();
    expect(shownNames()).not.toContain('ТЕЛЕСНА ВАГА');
    expect(chipIn('products.status.label', t('products.status.active')).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chipIn('products.status.label', t('products.status.all')));
    await waitFor(() => expect(shownNames()).toContain('ТЕЛЕСНА ВАГА'));
  });

  it('the kind chips filter (URL ?kind=) and combine with the line chips', async () => {
    renderAt();
    await loaded();
    fireEvent.click(chipIn('products.kindFilter.label', t('products.kindFilter.bundle')));
    expect(shownNames()).toEqual(['2x Diet Shake + Slim Complex']);
    await waitFor(() => expect(new URLSearchParams(location).get('kind')).toBe('bundle'));
    fireEvent.click(chipIn('products.kindFilter.label', t('products.kindFilter.gift')));
    expect(shownNames()).toEqual(['ГЛУКОЗАМИН СУЛФАТ 30 cps']);
    fireEvent.click(chipIn('products.kindFilter.label', t('products.kindFilter.other')));
    expect(shownNames()).toEqual(['ТЕЛЕСНА ВАГА']);
    fireEvent.click(chipIn('products.kindFilter.label', t('products.kindFilter.none')));
    expect(shownNames()).toEqual(['Arthriva']);
    fireEvent.click(chipIn('products.kindFilter.label', t('products.kindFilter.all')));
    expect(shownNames()).toHaveLength(6);
    fireEvent.click(chipIn('products.colLine', 'Natura Therapy'));
    expect(shownNames()).toEqual(['СНАИЛ КОМПЛЕКС cps 30']);
    fireEvent.click(chipIn('products.status.label', t('products.status.inactive')));
    expect(screen.getByText(t('products.nothingMatches'))).toBeTruthy();
  });

  it('search finds Cyrillic from Latin across kinds (with ?kind=all)', async () => {
    renderAt('/products?kind=all&status=all');
    await loaded();
    fireEvent.change(within(screen.getByRole('search')).getByRole('searchbox'), { target: { value: 'snail' } });
    await waitFor(() => expect(shownNames()).toEqual(['СНАИЛ КОМПЛЕКС cps 30']));
  });

  it('50 rows a page, then "Прикажи уште"', async () => {
    const many = Array.from({ length: 63 }, (_, i) => P(100 + i, `Product ${String(i).padStart(2, '0')}`, 'product'));
    renderAt('/products', many);
    await loaded();
    expect(within(table()).getAllByRole('rowheader')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: t('products.showMore', { n: '13' }) }));
    expect(within(table()).getAllByRole('rowheader')).toHaveLength(63);
    expect(screen.queryByRole('button', { name: /Прикажи уште/ })).toBeNull();
  });

  it('cards below xl, the same facts', async () => {
    wide = false;
    renderAt();
    const list = await screen.findByRole('list', { name: t('nav.products') }, { timeout: 10_000 });
    expect(screen.queryByRole('table', { name: t('nav.products') })).toBeNull();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('Neurofix')).toBeTruthy();
  });

  it('one product: the kind chip sets the kind (audited api) and the row leaves the Производи view', async () => {
    renderAt();
    await loaded();
    fireEvent.click(within(rowOf('Neurofix')).getByRole('button', { name: t('products.kind.setFor', { name: 'Neurofix' }) }));
    const picker = await screen.findByRole('dialog');
    fireEvent.click(within(picker).getByRole('button', { name: new RegExp(`^${t('products.kind.bundle')}`) }));
    await waitFor(() => expect(setKind).toHaveBeenCalledWith([idOf('Neurofix')], 'bundle'));
    await waitFor(() => expect(shownNames()).toEqual(['СНАИЛ КОМПЛЕКС cps 30']));
  });

  it('bulk: select → "Постави вид" → one call with every id', async () => {
    renderAt('/products?kind=all&status=all');
    await loaded();
    fireEvent.click(within(rowOf('Arthriva')).getByRole('checkbox'));
    fireEvent.click(within(rowOf('ТЕЛЕСНА ВАГА')).getByRole('checkbox'));
    const bar = screen.getByRole('region', { name: t('products.bulk.setLine') });
    fireEvent.click(within(bar).getByRole('button', { name: t('products.bulkKind.setKind') }));
    const picker = await screen.findByRole('dialog');
    fireEvent.click(within(picker).getByRole('button', { name: new RegExp(`^${t('products.kind.other')}`) }));
    await waitFor(() => expect(setKind).toHaveBeenCalledTimes(1));
    expect(setKind.mock.calls[0][1]).toBe('other');
    expect([...setKind.mock.calls[0][0]].sort()).toEqual([idOf('Arthriva'), idOf('ТЕЛЕСНА ВАГА')].sort());
  });

  it('a manager edits products but sees no cost and sets no kind / line', async () => {
    auth.user = { id: 'u-man', isAdmin: false, isManager: true };
    perms.canSeeBusiness = false;
    renderAt();
    await loaded();
    expect(within(table()).queryByRole('columnheader', { name: t('products.colCostPrice') })).toBeNull();
    expect(within(table()).queryAllByRole('checkbox')).toHaveLength(0);
    expect(within(rowOf('Neurofix')).queryByRole('button', { name: t('products.kind.setFor', { name: 'Neurofix' }) })).toBeNull();
    fireEvent.click(within(rowOf('Neurofix')).getByRole('button', { name: t('products.editOf', { name: 'Neurofix' }) }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(new RegExp(t('products.form.cost')))).toBeNull();
    expect(within(dialog).queryByRole('radiogroup')).toBeNull();
    expect(within(dialog).getByText(t('products.form.ownersOnly'))).toBeTruthy();
  });

  it('an agent sees the list only — no edit, no proposal', async () => {
    auth.user = { id: 'u-agent', isAdmin: false, isManager: false };
    perms.canSeeBusiness = false;
    renderAt('/products?view=proposal');
    await loaded();
    expect(screen.queryByRole('tab', { name: t('products.tabs.proposal') })).toBeNull();
    expect(getKindProposal).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: t('products.addProduct') })).toBeNull();
  });
});

describe('Производи 2.0 — the product form', { timeout: 30_000 }, () => {
  it('has the five sections, the full name, and saves only what changed (+ the kind via its route)', async () => {
    renderAt();
    await loaded();
    fireEvent.click(within(rowOf('СНАИЛ')).getByRole('button', { name: t('products.editOf', { name: 'СНАИЛ КОМПЛЕКС cps 30' }) }));
    const dialog = await screen.findByRole('dialog');
    for (const s of ['sectionBasic', 'sectionPrices', 'sectionCode', 'sectionStock', 'sectionDetails']) {
      expect(within(dialog).getByRole('group', { name: t(`products.form.${s}`) })).toBeTruthy();
    }
    const name = within(dialog).getByLabelText(new RegExp(`^${t('products.form.name')}`)) as HTMLTextAreaElement;
    expect(name.tagName).toBe('TEXTAREA');
    expect(name.value).toBe('СНАИЛ КОМПЛЕКС cps 30');
    // owners see the Sigma purchase cost, read-only (owner 01.10.2026: recipe × CalcBuyPrice, never typed in)
    const cost = within(dialog).getByLabelText(t('productsRecipe.form.cost'));
    expect(cost.tagName).toBe('OUTPUT');
    fireEvent.change(within(dialog).getByLabelText(t('products.form.barcode')), { target: { value: '5310000000' } });
    fireEvent.click(within(within(dialog).getAllByRole('radiogroup')[0]).getByRole('radio', { name: t('products.kind.gift') }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));
    await waitFor(() => expect(updateProduct).toHaveBeenCalledWith(idOf('СНАИЛ КОМПЛЕКС cps 30'), { barcode: '5310000000' }));
    await waitFor(() => expect(setKind).toHaveBeenCalledWith([idOf('СНАИЛ КОМПЛЕКС cps 30')], 'gift'));
    expect(setLine).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('validates: an empty name and a bad price stop the save', async () => {
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: t('products.addProduct') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${t('products.form.price')}`)), { target: { value: 'abc' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));
    expect(await within(dialog).findByText(t('products.form.errors.required'))).toBeTruthy();
    expect(within(dialog).getByText(t('products.form.errors.number'))).toBeTruthy();
    expect(createProduct).not.toHaveBeenCalled();
  });

  it('creates with every field in EUR, then the chosen kind and line', async () => {
    createProduct.mockResolvedValue({ id: uid(99) });
    renderAt();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: t('products.addProduct') }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${t('products.form.name')}`)), { target: { value: 'Zinc 30' } });
    fireEvent.change(within(dialog).getByLabelText(new RegExp(`^${t('products.form.price')}`)), { target: { value: '615' } });
    const [kinds, lines] = within(dialog).getAllByRole('radiogroup');
    fireEvent.click(within(kinds).getByRole('radio', { name: t('products.kind.product') }));
    fireEvent.click(within(lines).getByRole('radio', { name: 'Natura Therapy' }));
    fireEvent.click(within(dialog).getByRole('button', { name: t('common.save') }));
    await waitFor(() => expect(createProduct).toHaveBeenCalled());
    expect(createProduct.mock.calls[0][0]).toMatchObject({ name: 'Zinc 30', price: 10, days_of_supply_per_unit: 15, barcode: null });
    expect(createProduct.mock.calls[0][0]).not.toHaveProperty('cost_price');   // the cost is the guarded Sigma mirror
    await waitFor(() => expect(setKind).toHaveBeenCalledWith([uid(99)], 'product'));
    await waitFor(() => expect(setLine).toHaveBeenCalledWith([uid(99)], 'natura_therapy'));
  });
});

describe('Производи 2.0 — Предлог', { timeout: 30_000 }, () => {
  const kindTable = () => screen.getByRole('table', { name: t('products.kindProposal.title') });

  it('the kind proposal: reasons, accept one, accept all sure', async () => {
    renderAt('/products?view=proposal');
    await screen.findByRole('table', { name: t('products.kindProposal.title') }, { timeout: 10_000 });
    expect(within(kindTable()).getByText(t('products.kindProposal.reason.promo', { hit: '150+150' }))).toBeTruthy();
    fireEvent.click(within(kindTable()).getByRole('button', { name: t('products.kindProposal.acceptFor', { kind: t('products.kind.bundle'), name: 'СПИРУЛИНА 150+150 tbl' }) }));
    await waitFor(() => expect(setKind).toHaveBeenCalledWith([uid(7)], 'bundle'));
    fireEvent.click(screen.getByRole('button', { name: t('products.kindProposal.acceptAll', { n: '1' }) }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: t('products.kindProposal.acceptAllConfirm') }));
    await waitFor(() => expect(setKind).toHaveBeenLastCalledWith([uid(6)], 'product'));
    // the uncertain gift is never in it
    for (const [ids] of setKind.mock.calls) expect(ids).not.toContain(uid(8));
  });

  it('the line proposal sits beside it (?of=line)', async () => {
    renderAt('/products?view=proposal');
    await screen.findByRole('table', { name: t('products.kindProposal.title') }, { timeout: 10_000 });
    fireEvent.click(screen.getByRole('tab', { name: t('products.proposalTabs.line') }));
    await screen.findByRole('table', { name: t('products.proposal.title') }, { timeout: 10_000 });
    await waitFor(() => expect(new URLSearchParams(location).get('of')).toBe('line'));
    fireEvent.click(within(screen.getByRole('table', { name: t('products.proposal.title') })).getByRole('button', { name: t('products.proposal.acceptFor', { line: 'Bio Natural', name: 'Arthriva' }) }));
    await waitFor(() => expect(setLine).toHaveBeenCalledWith([uid(6)], 'bio_natural'));
  });
});

// VAT per product from Sigma (owner 01.10.2026, docs/VAT.md): owners see each product's rate,
// its source and the invoice evidence, filter by it and set it (audited api); nobody else sees it.
describe('ДДВ по производ (Сигма)', { timeout: 30_000 }, () => {
  const VAT_ROWS = [
    P(1, 'Neurofix', 'product', { vat_rate: 0.05, vat_source: 'sigma:crosswalk-VERIFIED', vat_sigma_code: '001317', vat_sigma_name: 'PROSTA FIX BIONATURAL 30 cps', vat_evidence: '2025@5.00: 88; mex@5.00: 10', vat_set_at: '2026-10-01T20:00:00Z' }),
    P(2, 'СНАИЛ КРЕМА 100ml', 'product', { vat_rate: 0.18, vat_source: 'sigma:crosswalk-HIGH', vat_sigma_code: '005040', vat_sigma_name: 'СНАИЛ КРЕМА', vat_evidence: '2026@18.00: 40' }),
    P(3, 'Нов производ', 'product', { vat_rate: null, vat_source: null }),
  ];
  const vatChipOf = (name: string) => within(rowOf(name)).getByRole('button', { name: t('products.vat.setFor', { name }) });

  it('an owner: a ДДВ column with the rate, its Sigma source and evidence; the rate set through the audited api', async () => {
    setVat.mockImplementation(async (ids: string[], rate: number | null) => ({ rate, requested: ids.length, updated: ids.length, unchanged: 0, missing: [], changes: ids.map((id) => ({ id, name: id, from: null, to: rate, from_source: null })) }));
    renderAt('/products?status=all', VAT_ROWS, true);
    await loaded();
    expect(within(table()).getByRole('columnheader', { name: t('products.colVat') })).toBeTruthy();
    expect(vatChipOf('Neurofix').textContent).toContain('5%');
    expect(vatChipOf('СНАИЛ КРЕМА 100ml').textContent).toContain('18%');
    expect(vatChipOf('Нов производ').textContent).toContain(t('products.vat.none'));
    fireEvent.click(vatChipOf('Neurofix'));
    const pop = await screen.findByRole('dialog');
    expect(within(pop).getByText(t('products.vat.sigmaItem', { code: '001317', name: 'PROSTA FIX BIONATURAL 30 cps' }))).toBeTruthy();
    expect(within(pop).getByText(t('products.vat.evidenceMex', { pct: '5%', n: 10 }))).toBeTruthy();
    fireEvent.click(within(pop).getByRole('button', { name: /^18%/ }));
    await waitFor(() => expect(setVat).toHaveBeenCalledWith([idOf('Neurofix')], 0.18));
    await waitFor(() => expect(vatChipOf('Neurofix').textContent).toContain('18%'));
  });

  it('an owner: the ДДВ chips filter (?vat=) and find the unclassified products', async () => {
    renderAt('/products?status=all', VAT_ROWS, true);
    await loaded();
    fireEvent.click(chipIn('products.colVat', t('products.vat.none')));
    await waitFor(() => expect(within(table()).getAllByRole('rowheader')).toHaveLength(1));
    expect(within(table()).getByRole('rowheader', { name: /Нов производ/ })).toBeTruthy();
    await waitFor(() => expect(new URLSearchParams(location).get('vat')).toBe('none'));
    fireEvent.click(chipIn('products.colVat', '18%'));
    await waitFor(() => expect(within(table()).getByRole('rowheader', { name: /СНАИЛ КРЕМА/ })).toBeTruthy());
  });

  it('not an owner (the api sends no VAT columns): no ДДВ column, no chip, no filter', async () => {
    renderAt('/products?status=all', VAT_ROWS.map(({ vat_rate: _r, vat_source: _s, vat_sigma_code: _c, vat_sigma_name: _n, vat_evidence: _e, ...r }) => r), false);
    await loaded();
    expect(within(table()).queryByRole('columnheader', { name: t('products.colVat') })).toBeNull();
    expect(screen.queryAllByTestId('vat-chip')).toHaveLength(0);
    expect(within(screen.getByRole('search')).queryByRole('group', { name: t('products.colVat') })).toBeNull();
  });
});
