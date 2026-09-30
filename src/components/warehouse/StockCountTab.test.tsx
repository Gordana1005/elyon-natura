import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { StockHealth } from '@/lib/stockApi';

// Warehouse → Попис: the count form (blank = not counted, a server preview, one
// save), the health card, and the owner's MEX switch. Owners see the value of
// the difference in денари; nobody else does.
const h = vi.hoisted(() => ({
  products: vi.fn(), health: vi.fn(), count: vi.fn(), setMex: vi.fn(), owner: true, toast: vi.fn(),
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/api', () => ({ apiGetProducts: () => h.products(), apiFetch: vi.fn() }));
vi.mock('@/lib/stockApi', async (orig) => {
  const m = await orig<typeof import('@/lib/stockApi')>();
  return {
    ...m,
    apiGetStockHealth: () => h.health(),
    apiPostStockCount: (b: unknown) => h.count(b),
    apiSetStockMexMovements: (b: unknown) => h.setMex(b),
  };
});
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ canSeeBusiness: h.owner }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: h.toast }) }));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { default: StockCountTab } = await import('./StockCountTab');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'aaaaaaaa-0000-4000-8000-000000000002';
const PRODUCTS = [
  { id: A, name: 'Adenofrin', sku: 'NT01', stock_quantity: 1000, cost_price: 2, is_active: true },
  { id: B, name: 'Neurofix', sku: 'NT02', stock_quantity: 1000, cost_price: 3, is_active: true },
];

function health(over: Partial<StockHealth> = {}): StockHealth {
  return {
    trusted: false, counted: null, counted_at: null,
    catalogue: { active: 2, counted: 0, never_counted: 2 },
    mex: { enabled: false, from: null, free_units: 'deduct', enabled_at: null, changed_by_name: null },
    last_run: null, last_ok_run: null, applied: null, review: null, pending: null, products: [],
    can_count: true, can_switch: true,
    ...over,
  };
}

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><StockCountTab /></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  for (const f of [h.products, h.health, h.count, h.setMex, h.toast]) f.mockReset();
  h.products.mockResolvedValue(PRODUCTS);
  h.owner = true;
});

describe('Попис — before the first count', { timeout: 30_000 }, () => {
  it('says there is no count, the switch waits for one, and a count previews then saves', async () => {
    h.health.mockResolvedValue(health());
    renderTab();
    expect(await screen.findByText(i18n.t('stockCount.health.never'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('stockCount.health.switchOn') })).toBeDisabled();
    expect(screen.getByText(i18n.t('stockCount.firstCountNote'))).toBeInTheDocument();

    const inputA = await screen.findByLabelText(i18n.t('stockCount.countedFor', { name: 'Adenofrin' }));
    fireEvent.change(inputA, { target: { value: '1.020' } });   // Macedonian thousands dot
    // the live difference and, for an owner, its value at cost (+20 × €2 = €40 → денари)
    expect(screen.getByText('+20')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('stockCount.valueEstimate', { value: '2.460 ден' }))).toBeInTheDocument();

    h.count.mockResolvedValueOnce({
      ok: true, dry: true, products: 1, changed: 1, units_before: 1000, units_after: 1020, up: 20, down: 0,
      not_counted: 1, anchors: true, from: null,
      lines: [{ product_id: A, name: 'Adenofrin', sku: 'NT01', system: 1000, counted: 1020, diff: 20 }],
    });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('stockCount.preview') }));
    const dialog = await screen.findByRole('dialog');
    expect(h.count).toHaveBeenLastCalledWith({ lines: [{ product_id: A, counted: 1020 }], dry: true });
    expect(within(dialog).getByText(i18n.t('stockCount.previewAnchors'))).toBeInTheDocument();
    expect(within(dialog).getByText(i18n.t('stockCount.previewNotCounted', { n: '1' }))).toBeInTheDocument();
    expect(within(dialog).getByText(i18n.t('stockCount.previewValue', { value: '2.460 ден' }))).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(i18n.t('stockCount.noteLabel')), { target: { value: 'Полица А' } });
    h.count.mockResolvedValueOnce({
      ok: true, dry: false, count_id: 'c1', products: 1, changed: 1, units_before: 1000, units_after: 1020, up: 20, down: 0,
      not_counted: 1, anchored: true, from: '2026-10-01T08:00:00+00:00', lines: [],
    });
    fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('stockCount.save') }));
    await waitFor(() => expect(h.count).toHaveBeenLastCalledWith({ lines: [{ product_id: A, counted: 1020 }], note: 'Полица А', dry: false }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ title: i18n.t('stockCount.saved') })));
    expect(localStorage.getItem('elyon.stockCountDraft.v1')).toBeNull();
  });

  it('an invalid field blocks the preview; a non-owner never sees money', async () => {
    h.owner = false;
    h.health.mockResolvedValue(health({ can_switch: false }));
    const { container } = renderTab();
    const inputB = await screen.findByLabelText(i18n.t('stockCount.countedFor', { name: 'Neurofix' }));
    fireEvent.change(inputB, { target: { value: '2.5' } });
    expect(screen.getByText(i18n.t('stockCount.invalid', { count: 1 }))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('stockCount.preview') })).toBeDisabled();
    fireEvent.change(inputB, { target: { value: '990' } });
    // no amount in денари (a digit then "ден" — "Последен" is a word, not money) and no euro
    expect(container.textContent).not.toMatch(/\d ден|€/);
    expect(screen.queryByRole('button', { name: i18n.t('stockCount.health.switchOn') })).toBeNull();
    expect(screen.getByText(i18n.t('stockCount.health.ownerOnly'))).toBeInTheDocument();
  });

  it('keeps the draft on this device', async () => {
    localStorage.setItem('elyon.stockCountDraft.v1', JSON.stringify({ [B]: '7' }));
    h.health.mockResolvedValue(health());
    renderTab();
    expect(await screen.findByDisplayValue('7')).toBeInTheDocument();
  });
});

describe('Попис — after the count', { timeout: 30_000 }, () => {
  it('the owner switches MEX stock movements on after seeing what it applies', async () => {
    h.health.mockResolvedValue(health({
      counted: { at: '2026-10-01T08:00:00Z', by: 'Mile Stoev', count_id: 'c1', products: 170, changed: 160, anchored: true },
      counted_at: '2026-10-01T08:00:00Z',
      catalogue: { active: 2, counted: 2, never_counted: 0 },
      mex: { enabled: false, from: '2026-10-01T08:00:00Z', free_units: 'deduct', enabled_at: null, changed_by_name: null },
      review: {
        parcels: 400, deduct_events: 380, skipped: { no_owner: 120, no_lines: 0, unmapped: 3, test_phone: 0 },
        unmapped: { lines: 5, units: 9, names: 2, rows: [{ name: '2 ПРОСТАТОЛ + 2 ДИАБЕТОЛ', src: 'collabbox', why: 'product', lines: 3, units: 6 }] },
        not_stock: [{ kind: 'loyalty_point', lines: 40, units: 41 }],
      },
      pending: { keys: 300, parcels: 260, units_out: 540, units_in: 30, units_reversed: 0, frozen: 0 },
    }));
    h.setMex.mockResolvedValue({ ok: true, settings: {}, run: { ok: true } });
    renderTab();
    expect(await screen.findByText(i18n.t('stockCount.health.pendingValue', { parcels: '260', out: '540', in: '30' }))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('stockCount.health.unmappedValue', { lines: '5', units: '9', names: '2' }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('stockCount.health.showNames') }));
    expect(screen.getByText('2 ПРОСТАТОЛ + 2 ДИАБЕТОЛ')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: i18n.t('stockCount.health.switchOn') }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(i18n.t('stockCount.health.switchOnBody', { date: '01.10.2026', parcels: '260', out: '540', in: '30' }))).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole('button', { name: i18n.t('stockCount.health.switchOn') }));
    await waitFor(() => expect(h.setMex).toHaveBeenCalledWith({ enabled: true }));
  });
});
