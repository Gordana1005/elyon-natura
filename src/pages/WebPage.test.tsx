import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import { shapeCustomers, shapeWebPage } from '@/lib/webApi';

// Render tests for /web (owner 15.10.2026): a margin viewer gets the four tabs and the ads
// numbers; a revenue-only viewer (administrator) gets Преглед + Купувачи and never a spend.

vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));
const who = vi.hoisted(() => ({ margins: true }));
vi.mock('@/components/web/useWebAccess', () => ({ useWebAccess: () => ({ any: true, margins: who.margins }) }));
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ loading: false }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
vi.mock('@/components/insights/shared/InsightsFilterBar', () => ({ InsightsFilterBar: () => <div data-testid="filter-bar" /> }));

const RPC = {
  from: '2026-10-01', to: '2026-10-15', spend_from: '2026-10-01', floor_day: '2026-09-11',
  total: { orders: 367, value_mkd: 795619, paid: 206, paid_mkd: 451903, returned: 13, returned_mkd: 27025, no_order: 0 },
  channels: [
    { channel: 'organic_search', source: 'google', orders: 139, value_mkd: 290465, paid: 75, paid_mkd: 159269, returned: 2, returned_mkd: 4490 },
    { channel: 'paid_social', source: 'facebook', orders: 170, value_mkd: 358684, paid: 94, paid_mkd: 197574, returned: 10, returned_mkd: 18555 },
  ],
  paid_social: { orders: 170, value_mkd: 358684, paid: 94, paid_mkd: 197574, returned: 10, returned_mkd: 18555, no_campaign: 0 },
  ads: { spend_mkd: 162358, spend_other_mkd: 65335, impressions: 1792630, link_clicks: 14973, meta_purchases: 310, currency: 'USD', synced_at: '2026-10-15T17:33:03Z' },
  campaigns: [{ id: '1', name: 'ABO || Magnesium', status: 'ACTIVE', orders: 70, value_mkd: 142344, paid: 40, paid_mkd: 78956, returned: 2, returned_mkd: 3900, spend_mkd: 64260, meta_purchases: 137 }],
  daily: [{ d: '2026-10-01', orders: 19, value_mkd: 38220, paid_social_mkd: 20000, spend_mkd: 9000 }, { d: '2026-10-02', orders: 28, value_mkd: 65062, paid_social_mkd: 30000, spend_mkd: 11000 }],
  coupons: [{ code: 'WELCOME10', orders: 21, value_mkd: 45104 }],
  cities: [{ city: 'Skopje', orders: 105, value_mkd: 227503, returned: 5 }],
  payment: [{ method: 'COD', orders: 319, value_mkd: 673158, returned: 13 }],
  products: [{ name: 'Magnesium Bisglycinate', qty: 488, value_mkd: 334622, orders: 191 }],
  lost: { card_unpaid: { orders: 57, value_mkd: 125800 } },
};
const COHORT = {
  meta: { from: '2026-10-01', to: '2026-10-15', generated_at: '2026-10-15T17:00:00Z', money: true, clock: 'sale' },
  total: { count: 367, value_mkd: 795619 },
  buckets: [{ key: 'paid', count: 206, value_mkd: 451903 }, { key: 'returned', count: 13, value_mkd: 27025 }],
  outside: [], by_source: [], spark: [], quality: [], prev: null,
};

vi.mock('@/lib/webApi', async (orig) => {
  const m = await orig<typeof import('@/lib/webApi')>();
  return {
    ...m,
    apiWebPage: () => Promise.resolve(m.shapeWebPage(RPC, who.margins)),
    apiWebCohort: () => Promise.resolve(COHORT),
    apiWebCustomers: () => Promise.resolve(m.shapeCustomers({ total: 16961, with_email: 16913, opted_in: 10377, recency: { d21_57: { count: 435, with_email: 435 } } })),
  };
});

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
afterEach(() => { vi.clearAllMocks(); });

const { default: WebPage } = await import('./WebPage');

function renderPage(path = '/web') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><WebPage /></MemoryRouter></QueryClientProvider>,
  );
}

describe('/web', () => {
  it('a margin viewer: four tabs, the channels add up, failed cards apart', async () => {
    who.margins = true;
    renderPage();
    expect(await screen.findByTestId('web-channels-table')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Преглед', 'Реклами', 'Профит', 'Купувачи']);
    expect(screen.getByTestId('web-channel-groups')).toHaveTextContent('Платени реклами');
    expect(screen.getByText('Неуспешни картички').closest('div')!.parentElement).toHaveTextContent('57');
  });

  it('the ads tab: spend and ROAS', async () => {
    who.margins = true;
    renderPage('/web?tab=ads');
    const roas = await screen.findByTestId('web-ads-roas');
    expect(roas).toHaveTextContent('2,21×');
    expect(screen.getByTestId('web-campaigns-table')).toHaveTextContent('ABO || Magnesium');
  });

  it('a revenue-only viewer: no ads or profit tab, never a spend', async () => {
    who.margins = false;
    renderPage('/web?tab=ads');
    expect(await screen.findByTestId('web-channels-table')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Преглед', 'Купувачи']);
    expect(document.body.textContent).not.toContain('162');
  });

  it('customers: counts for the campaigns, no e-mails', async () => {
    who.margins = false;
    renderPage('/web?tab=customers');
    const total = await screen.findByTestId('web-customers-total');
    expect(total).toHaveTextContent('16');
    expect(within(screen.getByTestId('web-segments-table')).getAllByText(/Потсетник за повторна нарачка/).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/@/);
  });
});

// keep the pure shapes referenced (the mock spreads them)
void shapeWebPage; void shapeCustomers;
