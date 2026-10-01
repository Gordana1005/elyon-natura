import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';

// The mirror (Поставки → Огледало): Macedonia first, and the partner price column only for a
// business owner — managers are not owners (the api leaves the prices out for them too).
const h = vi.hoisted(() => ({ owner: false, leads: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ canSeeBusiness: h.owner }) }));
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  apiGetAlterCpaAccounts: vi.fn(async () => []),
  apiGetAlterCpaWebmasters: vi.fn(async () => []),
  apiGetAlterCpaSummary: vi.fn(async () => ({
    totals: { leads: 3, mirrored: 1, ledger_only: 2, geos: 2, offers: 1, webmasters: 1, approved: 1, priced: 3, unpriced: 0 },
    geos: [{ geo: 'MK', leads: 2, mirrored: 1, approved: 1, currencies: ['MKD'] }, { geo: 'RS', leads: 1, mirrored: 0, approved: 0, currencies: ['RSD'] }],
    offers: [], webmasters: [],
  })),
  apiGetAlterCpaLeads: (p: unknown) => h.leads(p),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { MirrorTab } = await import('./MirrorTab');

const lead = {
  id: 'l1', account_id: 'a', altercpa_id: '1544467', order_id: null, geo: 'MK', offer_name: 'Adenofrin', offer_ext_id: '1',
  product_id: null, webmaster: '3221', phase: 3, status: 1, reason: 0, phase_seen_at: null, created_remote: '2026-10-01T08:00:00Z',
  phone_raw: '•••••••••757', phone_e164: null, customer_name: 'Ана П.', city: null, price_raw: 1990, currency_raw: 'MKD', price_eur: 32.36,
  quantity: 1, skip_reason: null, first_seen_at: '2026-10-01T08:00:00Z', last_seen_at: '2026-10-01T08:00:00Z',
};
const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><MirrorTab /></MemoryRouter></QueryClientProvider>);
};

beforeEach(() => { h.leads.mockReset(); h.leads.mockResolvedValue({ rows: [lead], total: 1, page: 1, limit: 30 }); });

describe('MirrorTab', { timeout: 30_000 }, () => {
  it('opens on Macedonia', async () => {
    h.owner = false;
    wrap();
    await waitFor(() => expect(h.leads).toHaveBeenCalled());
    expect(h.leads.mock.calls[0][0]).toMatchObject({ geo: 'MK' });
  });

  it('a non-owner (manager) sees no price column', async () => {
    h.owner = false;
    wrap();
    expect(await screen.findByText('Adenofrin')).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('altercpa.colPrice'))).not.toBeInTheDocument();
  });

  it('an owner sees the price column', async () => {
    h.owner = true;
    wrap();
    expect(await screen.findByText('Adenofrin')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('altercpa.colPrice'))).toBeInTheDocument();
  });
});
