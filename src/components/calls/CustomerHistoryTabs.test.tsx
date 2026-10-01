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
const { PriorDecisions } = await import('./PriorDecisions');

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

describe('CustomerHistoryTabs — trash reasons and call reasons (plan 01.10.2026, Фаза 1)', () => {
  it('a trashed order shows its trash reason and note; a call row shows the reason of its order', async () => {
    api.history.mockResolvedValue({
      orders: [
        ...orders,
        { id: 'o3', display_id: '100300', status: 'trashed', product_name: 'Parafix', price: 0, quantity: 1, order_items: [],
          trash_reason: 'wrong_number', trash_reason_notes: 'друг човек се јави', assigned_agent_name: 'Ива', created_at: '2026-09-29T08:00:00Z' },
      ],
      calls: [
        ...calls,
        { ...calls[0], id: 'c2', context_id: 'o3', outcome: 'wrong_number', notes: '' },
        { ...calls[0], id: 'c3', context_id: null, context_type: 'standalone', outcome: 'no_answer', notes: '' },
      ],
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <CustomerHistoryTabs phone="+38970123456" />
      </QueryClientProvider>,
    );
    const cards = await screen.findByTestId('history-cards');
    const items = within(cards).getAllByRole('listitem');
    expect(items[2]).toHaveTextContent('Погрешен број — друг човек се јави');
    expect(items[0]).toHaveTextContent('Нема пари — по плата');
    const reasons = within(screen.getByTestId('history-call-cards')).getAllByTestId('call-reason');
    expect(reasons.map((r) => r.textContent)).toEqual(['Нема пари', 'Погрешен број']);
  });
});

describe('PriorDecisions — the strip above the /calls toolbar', () => {
  const history = [
    { id: 'c1', display_id: '100231', status: 'cancelled', cancellation_reason: 'no_money', cancellation_reason_notes: 'ќе плати по 15-ти',
      cancelled_at: '2026-09-28T09:00:00Z', created_at: '2026-09-27T08:00:00Z', decided_by_name: 'Марија', decided_auto: false },
    { id: 't1', display_id: '100100', status: 'trashed', trash_reason: 'not_reachable', trashed_at: '2026-08-12T10:00:00Z',
      created_at: '2026-08-01T08:00:00Z', decided_by_name: null, decided_auto: true },
    { id: 'p1', status: 'paid', created_at: '2026-07-01T08:00:00Z' },
  ];
  it('one line per decision: what, when, who (or "автоматски"), reason — „note“', () => {
    render(<PriorDecisions orders={history} />);
    const strip = screen.getByTestId('prior-decisions');
    expect(strip).toHaveAccessibleName('Претходни одлуки');
    expect(screen.getByTestId('prior-cancel')).toHaveTextContent('Откажа · 28.09.2026 · Марија · Нема пари — „ќе плати по 15-ти“');
    expect(screen.getByTestId('prior-trash')).toHaveTextContent('Корпа · 12.08.2026 · автоматски · Недостапен');
  });
  it('a note opens on tap (clamped to two lines before)', () => {
    render(<PriorDecisions orders={history} />);
    const line = screen.getByTestId('prior-cancel');
    expect(line).toHaveAttribute('aria-expanded', 'false');
    expect(line.querySelector('.line-clamp-2')).not.toBeNull();
    fireEvent.click(line);
    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(line.querySelector('.line-clamp-2')).toBeNull();
  });
  it('renders nothing without a cancel or a trash', () => {
    render(<PriorDecisions orders={[history[2]]} />);
    expect(screen.queryByTestId('prior-decisions')).toBeNull();
  });
});
