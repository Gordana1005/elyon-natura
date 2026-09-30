import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { MexZoneResolution } from '@/lib/api';

// The new order form (Phase 6, plan 30.09): the /calls confirm path, completing an
// existing lead, and the edit path once MEX has the parcel.

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', isAdmin: true, isManager: false } }) }));
vi.mock('@/hooks/useCustomerIntelligence', () => ({ useCustomerIntelligence: () => ({ data: null, loading: false }) }));

const api = vi.hoisted(() => ({
  apiGetProducts: vi.fn(),
  apiGetCustomerPrefill: vi.fn(),
  apiGetOrder: vi.fn(),
  apiResolveAddress: vi.fn(),
  apiGetSettlementZone: vi.fn(),
  apiGetDistricts: vi.fn(),
  apiGetCourierCities: vi.fn(),
  apiSearchSettlements: vi.fn(),
  apiSearchStreets: vi.fn(),
  apiCreateOrder: vi.fn(),
  apiUpdateCustomer: vi.fn(),
  apiSyncOrderItems: vi.fn(),
  apiUpdateOrderStatus: vi.fn(),
  apiAddOrderNote: vi.fn(),
  apiSaveCustomerProfile: vi.fn(),
  apiGetCallScript: vi.fn(),
  apiGetCallLogs: vi.fn(),
  apiGetAgents: vi.fn(),
  apiLogCall: vi.fn(),
}));
vi.mock('@/lib/api', async (orig) => ({ ...(await orig<typeof import('@/lib/api')>()), ...api }));

import { CreateOrderModal } from '@/components/CreateOrderModal';
import { OrderModal } from '@/components/OrderModal';

beforeAll(async () => { await i18n.changeLanguage('mk'); });

const SKOPJE: MexZoneResolution = {
  city_id: 'osm:n170792214', city_name: 'Скопје', district_id: null, district_name: null, post_code: '1000',
  mex_city_id: 185, mex_city_name: 'Skopje - Centar', requires_district: true, basis: 'city_default', city_kind: 'city', municipality: 'Скопје',
};
const KARPOS2: MexZoneResolution = {
  ...SKOPJE, district_id: 'osm:n1926166030', district_name: 'Карпош 2', mex_city_id: 176, mex_city_name: 'Skopje - Karpoš', basis: 'district',
};
const PRODUCTS = [{ id: 'p1', name: 'Neurofix', is_active: true, price: 20, suggested_price: 20 }];

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  api.apiGetProducts.mockResolvedValue(PRODUCTS);
  api.apiGetCourierCities.mockResolvedValue([]);
  api.apiSearchSettlements.mockResolvedValue([]);
  api.apiSearchStreets.mockResolvedValue([]);
  api.apiGetDistricts.mockResolvedValue([
    { id: 'osm:n1929253980', name: 'Центар', name_lat: 'Centar', post_code: '1000', mex_city_id: 185, mex_city_name: 'Skopje - Centar' },
    { id: 'osm:n1926166030', name: 'Карпош 2', name_lat: 'Karpoš 2', post_code: '1000', mex_city_id: 176, mex_city_name: 'Skopje - Karpoš' },
  ]);
  api.apiGetSettlementZone.mockImplementation(async (id: string) => (id === 'osm:n1926166030' ? KARPOS2 : SKOPJE));
  api.apiSaveCustomerProfile.mockResolvedValue({});
  api.apiCreateOrder.mockResolvedValue({ id: 'new' });
  api.apiUpdateCustomer.mockResolvedValue({});
  api.apiSyncOrderItems.mockResolvedValue({});
  api.apiUpdateOrderStatus.mockResolvedValue({});
  api.apiGetCallScript.mockResolvedValue(null);
  api.apiGetCallLogs.mockResolvedValue([]);
  api.apiGetAgents.mockResolvedValue([]);
});

describe('CreateOrderModal — /calls confirm, a new order', () => {
  it('a prefilled Скопје gets its postcode and requires a district before it can confirm', async () => {
    api.apiGetCustomerPrefill.mockResolvedValue({
      profile: {
        customer_name: 'Ана Петровска', city: 'Скопје', street: 'Партизанска', street_number: '5',
        postal_code: '', notes: 'Сака попладне', delivery_instructions: 'ѕвони 12',
      },
      recent: [],
    });
    api.apiResolveAddress.mockResolvedValue({ ...SKOPJE, match: 'settlement' });
    const onClose = vi.fn();
    wrap(<CreateOrderModal open onClose={onClose} prefillPhone="+38970123456" defaultStatus="confirmed" hideStatusPicker />);

    expect(await screen.findByText('Нова нарачка')).toBeInTheDocument();
    // The postcode is filled from the settlement although the profile had none.
    await waitFor(() => expect(screen.getByTestId('postcode-chip')).toHaveTextContent('1000'));
    expect(api.apiResolveAddress).toHaveBeenCalledWith('Скопје', null);
    // Скопје is split over several MEX zones → a REQUIRED district.
    expect(await screen.findByText('Населба *')).toBeInTheDocument();
    expect(screen.getByTestId('mex-zone-chip')).toHaveTextContent('Skopje - Centar');
    // "За курирот" starts empty; the old instruction is a chip, the profile note read-only.
    expect(screen.getByLabelText('Упатство за курирот')).toHaveValue('');
    expect(screen.getByTestId('courier-previous-chip')).toHaveTextContent('Претходно: ѕвони 12');
    expect(screen.getByTestId('profile-note')).toHaveTextContent('За клиентот: Сака попладне');
    // No birthday, no gift for a new order.
    expect(screen.queryByText('Роденден')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('order-form-primary'));
    expect(await screen.findByTestId('order-form-missing')).toHaveTextContent('Недостасува: населба');
    expect(api.apiCreateOrder).not.toHaveBeenCalled();

    // One tap copies the previous courier instruction.
    fireEvent.click(screen.getByTestId('courier-previous-chip'));
    expect(screen.getByLabelText('Упатство за курирот')).toHaveValue('ѕвони 12');
  });

  it('"Друг клиент" clears the form and switching back re-runs the prefill', async () => {
    api.apiGetCustomerPrefill.mockResolvedValue({ profile: { customer_name: 'Ана Петровска', city: 'Скопје' }, recent: [] });
    api.apiResolveAddress.mockResolvedValue({ ...SKOPJE, match: 'settlement' });
    wrap(<CreateOrderModal open onClose={vi.fn()} prefillPhone="+38970123456" hideStatusPicker />);
    const name = await screen.findByLabelText('Име и презиме');
    await waitFor(() => expect(name).toHaveValue('Ана Петровска'));
    fireEvent.click(screen.getByRole('button', { name: /Друг клиент/ }));
    await waitFor(() => expect(screen.getByLabelText('Име и презиме')).toHaveValue(''));
    fireEvent.click(screen.getByRole('button', { name: /Назад кон клиентот/ }));
    await waitFor(() => expect(screen.getByLabelText('Име и презиме')).toHaveValue('Ана Петровска'));
    expect(api.apiGetCustomerPrefill).toHaveBeenCalledTimes(2);
  });
});

describe('CreateOrderModal — completing the existing lead (/calls)', () => {
  it('updates THAT order with the picked district, syncs items, flips to confirmed, merges the profile', async () => {
    api.apiGetCustomerPrefill.mockResolvedValue({ profile: null, recent: [] });
    api.apiGetOrder.mockResolvedValue({
      id: 'ord-1', display_id: 'ORD-00042', customer_name: 'Ана Петровска', customer_city: 'Скопје', quarter: 'Карпош 2',
      street: 'Партизанска', street_number: '5', postal_code: '', settlement_id: 'osm:n1926166030', delivery_type: 'home',
      order_items: [{ product_id: 'p1', product_name: 'Neurofix', quantity: 2, price_per_unit: 20 }],
    });
    const onClose = vi.fn();
    wrap(<CreateOrderModal open onClose={onClose} prefillPhone="+38970123456" existingOrderId="ord-1" defaultStatus="confirmed" hideStatusPicker />);

    expect(await screen.findByText('Потврди нарачка · ORD-00042')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('mex-zone-chip')).toHaveTextContent('Skopje - Karpoš'));
    await waitFor(() => expect(screen.getByTestId('postcode-chip')).toHaveTextContent('1000'));
    // The MEX preview runs the export's own formatters (Latin, zone name as Grad).
    const preview = screen.getByTestId('mex-preview');
    expect(within(preview).getByText('Skopje - Karpoš')).toBeInTheDocument();
    expect(within(preview).getByText('Karposh 2 Partizanska br. 5')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('order-form-primary'));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true, 'confirmed', false));
    expect(api.apiCreateOrder).not.toHaveBeenCalled();
    const [id, body] = api.apiUpdateCustomer.mock.calls[0];
    expect(id).toBe('ord-1');
    expect(body).toMatchObject({ settlement_id: 'osm:n1926166030', quarter: 'Карпош 2', postal_code: '1000', customer_city: 'Скопје' });
    expect(body).not.toHaveProperty('customer_phone');
    expect(body).not.toHaveProperty('birthday');
    expect(body).not.toHaveProperty('gift_note');
    expect(api.apiSyncOrderItems).toHaveBeenCalledWith('ord-1', [{ product_id: 'p1', product_name: 'Neurofix', quantity: 2, price_per_unit: 20 }]);
    expect(api.apiUpdateOrderStatus).toHaveBeenCalledWith('ord-1', 'confirmed', undefined);
    await waitFor(() => expect(api.apiSaveCustomerProfile).toHaveBeenCalled());
    const merged = api.apiSaveCustomerProfile.mock.calls[0][0];
    expect(merged).toMatchObject({ phone: '+38970123456', settlement_id: 'osm:n1926166030', quarter: 'Карпош 2' });
    expect(merged).not.toHaveProperty('notes');
  });
});

describe('OrderModal — the edit path once MEX has the parcel', () => {
  it('shows the address read-only and never sends it', async () => {
    api.apiGetOrder.mockResolvedValue({
      id: 'ord-9', display_id: 'ORD-00009', status: 'confirmed', customer_name: 'Ана', customer_phone: '+38970123456',
      customer_city: 'Скопје', quarter: 'Карпош 2', street: 'Партизанска', street_number: '5', postal_code: '1000',
      settlement_id: 'osm:n1926166030', delivery_type: 'home', mex_tracking_id: 'MX123', delivery_instructions: 'ѕвони',
      order_items: [{ id: 'i1', product_id: 'p1', product_name: 'Neurofix', quantity: 1, price_per_unit: 20, total_price: 20 }],
      notes: [],
    });
    const onClose = vi.fn();
    wrap(
      <OrderModal
        open
        onClose={onClose}
        contextType="order"
        data={{ id: 'ord-9', name: 'Ана', telephone: '+38970123456', address: '', city: 'Скопје', product: 'Neurofix', status: 'confirmed', notes: null, displayId: 'ORD-00009' }}
      />,
    );
    expect(await screen.findByTestId('address-locked')).toHaveTextContent('Пратката е веќе кај MEX');
    expect(screen.queryByRole('combobox', { name: 'Град / село' })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Упатство за курирот')).toHaveValue('ѕвони'));

    fireEvent.click(screen.getByTestId('order-form-primary'));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    const body = api.apiUpdateCustomer.mock.calls[0][1];
    for (const k of ['customer_city', 'street', 'quarter', 'postal_code', 'settlement_id', 'customer_address']) {
      expect(body).not.toHaveProperty(k);
    }
    expect(body).toMatchObject({ customer_name: 'Ана', delivery_instructions: 'ѕвони' });
  });
});
