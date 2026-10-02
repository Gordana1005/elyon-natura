import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';

// The order window's script (legacy "order" / "prediction_lead" rows, docs/CALL-SCRIPTS.md "Fixes"):
// the save sent the bare string, so nothing was ever saved — it now sends { script_text }; admins
// and managers see "Уреди ја скриптата", agents never do.

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
const auth = vi.hoisted(() => ({ user: { id: 'u1', isAdmin: true, isManager: false } as { id: string; isAdmin: boolean; isManager: boolean } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/useCustomerIntelligence', () => ({ useCustomerIntelligence: () => ({ data: null, loading: false }) }));

const api = vi.hoisted(() => ({
  apiGetProducts: vi.fn(),
  apiGetOrder: vi.fn(),
  apiResolveAddress: vi.fn(),
  apiGetSettlementZone: vi.fn(),
  apiGetDistricts: vi.fn(),
  apiGetCourierCities: vi.fn(),
  apiSearchSettlements: vi.fn(),
  apiSearchStreets: vi.fn(),
  apiGetCallScript: vi.fn(),
  apiUpdateCallScript: vi.fn(),
  apiGetCallLogs: vi.fn(),
  apiGetAgents: vi.fn(),
}));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

import { OrderModal } from '@/components/OrderModal';

beforeAll(async () => { await i18n.changeLanguage('mk'); });

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.apiGetProducts.mockResolvedValue([{ id: 'p1', name: 'Neurofix', is_active: true, price: 20, suggested_price: 20 }]);
  api.apiGetCourierCities.mockResolvedValue([]);
  api.apiSearchSettlements.mockResolvedValue([]);
  api.apiSearchStreets.mockResolvedValue([]);
  api.apiGetDistricts.mockResolvedValue([]);
  api.apiResolveAddress.mockResolvedValue(null);
  api.apiGetCallLogs.mockResolvedValue([]);
  api.apiGetAgents.mockResolvedValue([]);
  api.apiGetCallScript.mockResolvedValue({ id: 's-order', context_type: 'order', title: 'Order', script_text: 'Здраво [Customer Name]', translations: {} });
  api.apiGetOrder.mockResolvedValue({
    id: 'ord-5', display_id: 'ORD-00005', status: 'pending', customer_name: 'Ана', customer_phone: '+38970123456',
    customer_city: 'Скопје', delivery_type: 'home', order_items: [], notes: [],
  });
});

function open() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactNode = (
    <OrderModal open onClose={vi.fn()} contextType="order"
      data={{ id: 'ord-5', name: 'Ана', telephone: '+38970123456', address: '', city: 'Скопје', product: 'Neurofix', status: 'pending', notes: null, displayId: 'ORD-00005' }} />
  );
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('OrderModal — the order-window script', { timeout: 20_000 }, () => {
  it('saves { script_text } (not the bare string) and shows the saved text', async () => {
    auth.user = { id: 'u-m', isAdmin: false, isManager: true };
    api.apiUpdateCallScript.mockImplementation(async (_ctx: string, body: { script_text: string }) => ({ id: 's-order', context_type: 'order', script_text: body.script_text }));
    open();
    await waitFor(() => expect(api.apiGetCallScript).toHaveBeenCalledWith('order'));
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('orderModal.showScript') }));
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('orderModal.editScript') }));
    const box = screen.getByDisplayValue('Здраво [Customer Name]');
    fireEvent.change(box, { target: { value: 'Добар ден [Customer Name]' } });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('orderModal.saveScript') }));
    await waitFor(() => expect(api.apiUpdateCallScript).toHaveBeenCalledWith('order', { script_text: 'Добар ден [Customer Name]' }));
    expect(await screen.findByText(/Добар ден/)).toBeInTheDocument();
  });

  it('an agent reads the script but never sees the edit link', async () => {
    auth.user = { id: 'u-a', isAdmin: false, isManager: false };
    open();
    fireEvent.click(await screen.findByRole('button', { name: i18n.t('orderModal.showScript') }));
    expect(await screen.findByText(/Здраво/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('orderModal.editScript') })).toBeNull();
  });
});
