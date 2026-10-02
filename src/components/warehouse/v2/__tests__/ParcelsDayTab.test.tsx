import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/i18n';
import { health, ownerParcelsDay, parcelsDay } from './fixtures';
import { renderAt, setViewport, urlParams } from './harness';

// Магацин → Пратки: the day's parcels as stock sees them — tiles, breakdowns that filter (URL),
// the rows as cards below lg / a table from lg, COD only when the api sent it.
const h = vi.hoisted(() => ({ health: vi.fn(), parcels: vi.fn(), config: vi.fn(), owner: false }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/stockV2Api', () => ({
  apiStockV2Health: (d: boolean) => h.health(d),
  apiStockV2Parcels: (q: unknown) => h.parcels(q),
  apiStockV2Config: () => h.config(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { isAdmin: true, isManager: false, isWarehouse: false } }) }));
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ canSeeBusiness: h.owner, canSeeMargins: h.owner }) }));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { ParcelsDayTab } = await import('../ParcelsDayTab');
const { useInsightsFormat } = await import('@/components/insights/shared/useInsightsFormat');
function Tab() { return <ParcelsDayTab f={useInsightsFormat()} />; }

beforeEach(() => {
  for (const f of [h.health, h.parcels, h.config]) f.mockReset();
  h.owner = false;
  h.health.mockResolvedValue(health());
  h.config.mockRejectedValue(new Error('owners_only'));
});

describe('Пратки', { timeout: 30_000 }, () => {
  it('tiles, breakdowns and parcel cards on a phone — no COD without the key', async () => {
    setViewport(360);
    h.parcels.mockResolvedValue(parcelsDay());
    renderAt(<Tab />, '/warehouse?tab=parcels&day=2026-09-30');
    const cards = await screen.findByTestId('stock2-parcel-cards');
    expect(h.parcels).toHaveBeenLastCalledWith({
      day: '2026-09-30', warehouse: null, account: null, department: null, status: null, city: null, state: null, limit: 50, offset: 0,
    });
    const tiles = screen.getByRole('list', { name: i18n.t('stock2.parcels.totalsTitle') });
    expect(within(tiles).getByText(i18n.t('stock2.parcels.tParcels'))).toBeInTheDocument();
    expect(within(tiles).getByText(i18n.t('stock2.parcels.tGiftsSub', { pct: '20,0%' }))).toBeInTheDocument();
    expect(within(cards).getByText('9110123456')).toBeInTheDocument();
    expect(within(cards).getByText(i18n.t('stock2.state.unmapped'))).toBeInTheDocument();
    expect(within(cards).getAllByText('BIO NATURAL', { exact: false }).length).toBeGreaterThan(0);
    // department words come from the /orders helper (the Insights labels)
    expect(within(cards).getAllByText(i18n.t('insights.common.source.teleshop_out'), { exact: false }).length).toBeGreaterThan(0);
    expect(screen.queryByText(i18n.t('stock2.parcels.cod'), { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByTestId('stock2-parcel-table')).not.toBeInTheDocument();
  });

  it('an owner sees COD; a table from lg', async () => {
    setViewport(1024);
    h.owner = true;
    h.config.mockResolvedValue({ settings: {}, warehouses: [], routes: [], sigma_rules: [] });
    h.parcels.mockResolvedValue(ownerParcelsDay());
    renderAt(<Tab />, '/warehouse?tab=parcels&day=2026-09-30');
    const table = await screen.findByTestId('stock2-parcel-table');
    expect(within(table).getByRole('columnheader', { name: i18n.t('stock2.parcels.cod') })).toBeInTheDocument();
    expect(within(table).getByText('2.490 ден')).toBeInTheDocument();
  });

  it('a breakdown row filters, the filter lives in the URL and goes to the api; the chip removes it', async () => {
    setViewport(360);
    h.parcels.mockResolvedValue(parcelsDay());
    renderAt(<Tab />, '/warehouse?tab=parcels&day=2026-09-30');
    await screen.findByTestId('stock2-parcel-cards');
    const status = screen.getByRole('heading', { name: i18n.t('stock2.parcels.byStatus') }).closest('section')!;
    fireEvent.click(within(status).getByRole('button', { name: new RegExp(i18n.t('stock2.status.returned')) }));
    await waitFor(() => expect(urlParams().get('status')).toBe('returned'));
    await waitFor(() => expect(h.parcels).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'returned', offset: 0 })));

    const account = screen.getByRole('heading', { name: i18n.t('stock2.parcels.byAccount') }).closest('section')!;
    fireEvent.click(within(account).getByRole('button', { name: /^NATURA/ }));
    await waitFor(() => expect(urlParams().get('account')).toBe('natura'));

    fireEvent.change(screen.getByDisplayValue(i18n.t('stock2.common.all')), { target: { value: 'no_lines' } });
    await waitFor(() => expect(urlParams().get('state')).toBe('no_lines'));

    fireEvent.click(screen.getByRole('button', { name: i18n.t('stock2.common.removeFilter', { name: i18n.t('stock2.status.returned') }) }));
    await waitFor(() => expect(urlParams().get('status')).toBeNull());
    expect(urlParams().get('account')).toBe('natura');
  });

  it('pages through the rows (?page=)', async () => {
    setViewport(360);
    h.parcels.mockResolvedValue(parcelsDay({ total_rows: 120 }));
    renderAt(<Tab />, '/warehouse?tab=parcels&day=2026-09-30');
    await screen.findByTestId('stock2-parcel-cards');
    fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.t('stock2.common.nextPage')) }));
    await waitFor(() => expect(urlParams().get('page')).toBe('2'));
    await waitFor(() => expect(h.parcels).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })));
  });
});
