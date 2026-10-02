import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';

// "My performance" (/ for a non-admin) under the access levels (20260947001600): a manager
// whose payload says money: false sees no money tile — never "0 ден"; a dept_admin's carries
// dept_scope (a "Тим Центар" badge beside the period) and no payout_earned (no payout tile).
const h = vi.hoisted(() => ({ stats: vi.fn() }));
const channel = { on: () => channel, subscribe: () => channel };
vi.mock('@/integrations/supabase/client', () => ({ supabase: { channel: () => channel, removeChannel: () => {} } }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-man', isAdmin: false, isManager: true, roles: ['manager'] } }),
}));
vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));
vi.mock('@/components/dashboard/MyOrdersSection', () => ({ MyOrdersSection: () => null }));
vi.mock('@/components/dashboard/MyDayWorkTable', () => ({ MyDayWorkTable: () => null }));
vi.mock('@/components/insights/overview/OverviewTab', () => ({ default: () => null }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetDashboardStats: (...a: unknown[]) => h.stats(...a),
  apiGetRecentActivity: async () => [],
  apiGetMyDayWork: async () => ({ totals: {} }),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { default: Dashboard } = await import('./Dashboard');
const t = i18n.t.bind(i18n);

const base = {
  lead_count: 0, deals_won: 0, deals_lost: 0, tasks_completed: 0, total_orders: 12,
  daily: {}, statusCounts: {}, packages_sold: 7, packages_awaiting: 3, packages_returned: 1,
};

function renderWith(stats: Record<string, unknown>) {
  h.stats.mockResolvedValue(stats);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><Dashboard /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('My performance — money by access level', { timeout: 30_000 }, () => {
  it('money: false hides payout, paid revenue, confirmed revenue and the per-package price', async () => {
    const { container } = renderWith({ ...base, money: false });
    expect(await screen.findByText(t('dashboard.packagesSold'), {}, { timeout: 10_000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(t('dashboard.payoutEarned'))).toBeNull(), { timeout: 10_000 });
    expect(screen.queryByText(t('dashboard.paidRevenue'))).toBeNull();
    expect(screen.queryByText(t('dashboard.revenueConfirmed'))).toBeNull();
    expect(screen.getByText(t('dashboard.packagesSoldSub'))).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\d ден(?![а-яѓќљњџѕ])/);
  });

  it('a dept_admin: the team badge beside the period, revenue shown, no payout tile', async () => {
    renderWith({ ...base, money: true, dept_scope: ['teleshop_out', 'teleshop_other', 'social'], paid_revenue: 100, total_value: 300 });
    expect(await screen.findByTestId('dept-scope-badge', {}, { timeout: 10_000 })).toHaveTextContent('Тим Центар');
    expect(screen.getByText(t('dashboard.paidRevenue'))).toBeInTheDocument();
    expect(screen.getByText(t('dashboard.revenueConfirmed'))).toBeInTheDocument();
    expect(screen.queryByText(t('dashboard.payoutEarned'))).toBeNull();
  });

  it('an agent (no access keys): every tile as before', async () => {
    renderWith({ ...base, paid_revenue: 100, payout_earned: 20 });
    expect(await screen.findByText(t('dashboard.payoutEarned'), {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByText(t('dashboard.paidRevenue'))).toBeInTheDocument();
    expect(screen.queryByTestId('dept-scope-badge')).toBeNull();
  });
});
