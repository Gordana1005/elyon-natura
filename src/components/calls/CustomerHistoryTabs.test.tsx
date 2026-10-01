import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';

const api = vi.hoisted(() => ({ history: vi.fn() }));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetCustomerHistory: (...a: unknown[]) => api.history(...a),
}));

beforeAll(async () => { await i18n.changeLanguage('mk'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const { CustomerHistoryTabs } = await import('./CustomerHistoryTabs');

const orders = [
  { id: 'o1', display_id: '100231', status: 'cancelled', product_name: 'Parafix', price: 29, quantity: 1, order_items: [],
    cancellation_reason: 'no_money', cancellation_reason_notes: 'по плата', assigned_agent_name: 'Ана', created_at: '2026-09-30T08:00:00Z' },
  { id: 'o2', display_id: '100100', status: 'paid', product_name: 'Neurofix', price: 39, quantity: 1, order_items: [],
    assigned_agent_name: null, created_at: '2026-08-01T08:00:00Z' },
];
const calls = [
  { id: 'c1', agent_id: 'a', agent_name: 'Ана', context_type: 'order', context_id: 'o1', outcome: 'cancelled', notes: '',
    created_at: '2026-09-30T08:01:00Z', started_at: '2026-09-30T08:00:00Z', connected_at: '2026-09-30T08:00:00Z',
    ended_at: '2026-09-30T08:01:00Z', ring_seconds: 0, talk_seconds: 60, total_seconds: 60, customer_phone: '+38970123456', connection_state: 'answered' },
];

describe('CustomerHistoryTabs — phones get cards, not a sideways table', () => {
  it('renders one card per order below xl (so below md too) and keeps the table for xl and up', async () => {
    api.history.mockResolvedValue({ orders, calls });
    const onOpenOrder = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CustomerHistoryTabs phone="+38970123456" onOpenOrder={onOpenOrder} />
      </QueryClientProvider>,
    );
    const cards = await screen.findByTestId('history-cards');
    expect(cards).toHaveClass('xl:hidden'); // visible on phones and tablets
    expect(cards).not.toHaveClass('hidden');
    const items = within(cards).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('100231');
    expect(items[0]).toHaveTextContent('Parafix');
    expect(items[0]).toHaveTextContent('Нема пари — по плата');
    expect(items[1]).toHaveTextContent('100100');
    expect(items[1]).toHaveTextContent(i18n.t('customerHistory.unassigned'));
    // the 7-column table is only for xl and up, and never wider than its card
    const table = screen.getAllByRole('table')[0];
    expect(table.closest('.hidden.xl\\:block')).not.toBeNull();
    expect(table).toHaveClass('table-fixed');
    // a card opens the order like a table row
    fireEvent.click(within(items[0]).getByRole('button'));
    expect(onOpenOrder).toHaveBeenCalledWith('o1');
    // the calls log is a compact list on every width (no table)
    const callCards = screen.getByTestId('history-call-cards');
    expect(within(callCards).getAllByRole('listitem')).toHaveLength(1);
    expect(callCards).toHaveTextContent('Ана');
  });
});
