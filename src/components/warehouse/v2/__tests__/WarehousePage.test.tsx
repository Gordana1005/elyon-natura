import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import i18n from '@/i18n';
import { renderAt, urlParams } from './harness';

// /warehouse: who sees which tab (send · pack · stock · parcels · movements · count), and a tab
// switch keeps only the shared day + warehouse (a tab's own filters stay behind).
const h = vi.hoisted(() => ({ user: { isAdmin: false, isManager: false, isWarehouse: true }, owner: false }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/layouts/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ canSeeBusiness: h.owner }) }));
vi.mock('@/lib/api', () => ({ apiGetProducts: () => Promise.resolve([]), apiFetch: vi.fn() }));
vi.mock('@/lib/warehouseApi', () => ({ apiGetWarehouseQueue: () => new Promise(() => {}) }));
vi.mock('@/components/warehouse/WarehouseKpis', () => ({ WarehouseKpis: () => <div data-testid="kpis" /> }));
vi.mock('@/components/warehouse/SendTab', () => ({ SendTab: () => <div data-testid="send" /> }));
vi.mock('@/components/warehouse/PackTab', () => ({ PackTab: () => <div data-testid="pack" /> }));
vi.mock('@/components/warehouse/MexPushSettingsCard', () => ({ MexPushSettingsCard: () => null }));
vi.mock('@/components/warehouse/v2/StockDayTab', () => ({ StockDayTab: () => <div data-testid="stock" /> }));
vi.mock('@/components/warehouse/v2/ParcelsDayTab', () => ({ ParcelsDayTab: () => <div data-testid="parcels" /> }));
vi.mock('@/components/warehouse/v2/MovementsV2Tab', () => ({ MovementsV2Tab: () => <div data-testid="movements" /> }));
vi.mock('@/components/warehouse/v2/CountV2Tab', () => ({ CountV2Tab: () => <div data-testid="count" /> }));

beforeAll(async () => {
  await i18n.changeLanguage('mk');
});

const { default: WarehousePage } = await import('@/pages/WarehousePage');

beforeEach(() => {
  h.user = { isAdmin: false, isManager: false, isWarehouse: true };
  h.owner = false;
});

const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent?.trim());

describe('/warehouse tabs', { timeout: 30_000 }, () => {
  it('the warehouse role sees all six, in order', () => {
    renderAt(<WarehousePage />, '/warehouse');
    expect(tabNames()).toEqual([
      i18n.t('warehousePage.tabs.send'), i18n.t('warehousePage.tabs.pack'), i18n.t('stock2.tabs.stock'),
      i18n.t('stock2.tabs.parcels'), i18n.t('stock2.tabs.movements'), i18n.t('stock2.tabs.count'),
    ]);
    expect(screen.getByTestId('send')).toBeInTheDocument();
  });

  it('a manager does not count', () => {
    h.user = { isAdmin: false, isManager: true, isWarehouse: false };
    renderAt(<WarehousePage />, '/warehouse?tab=count');
    expect(tabNames()).not.toContain(i18n.t('stock2.tabs.count'));
    expect(screen.getByTestId('send')).toBeInTheDocument();
  });

  it('an owner without a staff role sees the stock tabs, no queue', () => {
    h.user = { isAdmin: false, isManager: false, isWarehouse: false };
    h.owner = true;
    renderAt(<WarehousePage />, '/warehouse?tab=parcels');
    expect(tabNames()).toEqual([
      i18n.t('stock2.tabs.stock'), i18n.t('stock2.tabs.parcels'), i18n.t('stock2.tabs.movements'), i18n.t('stock2.tabs.count'),
    ]);
    expect(screen.getByTestId('parcels')).toBeInTheDocument();
    expect(screen.queryByTestId('kpis')).not.toBeInTheDocument();
  });

  it('nobody else gets a tab', () => {
    h.user = { isAdmin: false, isManager: false, isWarehouse: false };
    renderAt(<WarehousePage />, '/warehouse');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByText(i18n.t('stock2.noAccess'))).toBeInTheDocument();
  });

  it('switching tab keeps day + warehouse, drops the tab filters', async () => {
    renderAt(<WarehousePage />, '/warehouse?tab=parcels&day=2026-09-30&wh=main&status=returned&page=3');
    expect(screen.getByTestId('parcels')).toBeInTheDocument();
    const stockTab = screen.getByRole('tab', { name: i18n.t('stock2.tabs.stock') });
    fireEvent.mouseDown(stockTab);
    fireEvent.click(stockTab);
    await waitFor(() => expect(urlParams().get('tab')).toBe('stock'));
    expect(urlParams().get('day')).toBe('2026-09-30');
    expect(urlParams().get('wh')).toBe('main');
    expect(urlParams().get('status')).toBeNull();
    expect(urlParams().get('page')).toBeNull();
  });
});
