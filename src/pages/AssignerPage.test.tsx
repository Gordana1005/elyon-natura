import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { AssignerBoard, AssignerBoardAgent, AssignerList, AssignerLists, DistributeBody } from '@/lib/assignerApi';

// Render test for the redesigned Assigner (plan Part B, 29.09.2026) against the
// api contract the backend implements: GET /assigner/board, GET /assigner/lists,
// POST /assigner/distribute (dry run for the preview), GET /orders/unassigned-pending
// and GET /call-agains with `department`. The network is replaced by mocks.

const rt = vi.hoisted(() => {
  const handlers: Record<string, () => void> = {};
  const channel = {
    on: (_type: string, filter: { event: string }, cb: () => void) => { handlers[filter.event] = cb; return channel; },
    subscribe: () => channel,
  };
  return { handlers, channel, topics: [] as string[] };
});
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    channel: (topic: string) => { rt.topics.push(topic); return rt.channel; },
    removeChannel: () => Promise.resolve(),
  },
}));
vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));

const api = vi.hoisted(() => ({
  board: vi.fn(),
  lists: vi.fn(),
  distribute: vi.fn(),
  pendings: vi.fn(),
  callAgains: vi.fn(),
  summary: vi.fn(),
}));
vi.mock('@/lib/assignerApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/assignerApi')>()),
  apiGetAssignerBoard: (...a: unknown[]) => api.board(...a),
  apiGetAssignerLists: (...a: unknown[]) => api.lists(...a),
  apiAssignerDistribute: (...a: unknown[]) => api.distribute(...a),
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetUnassignedPending: (...a: unknown[]) => api.pendings(...a),
  apiGetCallAgains: (...a: unknown[]) => api.callAgains(...a),
  apiGetAssignmentSummary: (...a: unknown[]) => api.summary(...a),
}));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
afterEach(() => { vi.clearAllMocks(); });

const { default: AssignerPage } = await import('./AssignerPage');

const agent = (over: Partial<AssignerBoardAgent>): AssignerBoardAgent => ({
  user_id: 'u', full_name: 'X', roles: ['agent'], is_admin: false, is_manager: false, team_key: null, team_name: null,
  online: false, in_call: false, last_seen_at: null, shift: null,
  pendings: 0, pendings_pending: 0, pendings_take: 0, call_agains: 0, call_agains_orders: 0, call_agains_members: 0,
  list_open: 0, list_parked: 0, list_assigned: 0, worked_today: 0, ...over,
});
const board: AssignerBoard = {
  generated_at: new Date().toISOString(),
  agents: [
    agent({ user_id: 'u-ana', full_name: 'Ана Петровска', online: true, in_call: true, pendings: 3, pendings_pending: 2, pendings_take: 1, list_open: 12, list_assigned: 14, worked_today: 9 }),
    agent({ user_id: 'u-beti', full_name: 'Бети Николова', online: true, list_open: 2, list_assigned: 2, worked_today: 4 }),
    agent({ user_id: 'u-ivana', full_name: 'Ivana Trajkovska', online: false, call_agains: 2, call_agains_members: 2 }),
  ],
  totals: {
    agents: 3, online: 2, in_call: 1, pendings_unassigned: 3, call_agains_unassigned: 7, call_agains_unassigned_orders: 4,
    call_agains_unassigned_members: 3, oldest_call_again_since: new Date(Date.now() - 4 * 86_400_000).toISOString(), worked_today: 13,
  },
};
const dept = (total: number, distributable: number, assigned: number, done: number) => ({ total, distributable, assigned, done });
const list = (over: Partial<AssignerList>): AssignerList => ({
  id: 'l', name: 'X', description: null, category: 'value', is_static: false, display_order: 10, assignable: true,
  total: 0, distributable: 0, assigned: 0, done: 0, open: 0, by_department: {}, ...over,
});
const lists: AssignerLists = {
  generated_at: new Date().toISOString(),
  departments: null,
  lists: [
    list({
      id: 'l-21', name: '21d 26+ (1-3 orders)', description: 'Last paid 21-57 days ago | last paid order over €26 | 1-2 lifetime paid orders',
      total: 120, distributable: 80, assigned: 25, done: 15, open: 105,
      by_department: { altercpa: dept(70, 50, 15, 5), teleshop_out: dept(50, 30, 10, 10), unknown: dept(0, 0, 0, 0) },
    }),
    list({ id: 'l-new', name: 'NEWCOMERS (1-3 orders)', total: 0, display_order: 5 }),
    list({ id: 'l-cc', name: 'Current Cancels', category: 'cancel', display_order: 5, total: 40, distributable: 40, open: 40, description: 'Most recent action was a cancellation within the last 14 days.' }),
    list({ id: 'l-trash', name: 'Trash List', category: 'other', is_static: true, assignable: false, display_order: 310, total: 9, distributable: 9, open: 9 }),
  ],
  totals: { total: 169, distributable: 129, assigned: 25, done: 15 },
};
const pendings = [
  { id: 'o1', display_id: '100001', customer_name: 'Марија К.', customer_phone: '+38970111222', product_name: 'Артро Плус', source_type: 'altercpa', created_at: '2026-09-29T08:10:00Z', department: 'altercpa' },
  { id: 'o2', display_id: '100002', customer_name: 'Petar S.', customer_phone: '+38970333444', product_name: null, source_type: 'altercpa', created_at: '2026-09-29T09:10:00Z', department: 'altercpa' },
  { id: 'o3', display_id: '100003', customer_name: 'Ели Т.', customer_phone: '+38970555666', product_name: 'Кардио', source_type: 'altercpa', created_at: '2026-09-28T12:00:00Z', department: 'web' },
];
const callAgains = {
  total: 7, page: 1, limit: 50,
  members: [
    { source_kind: 'prediction', list_id: 'l-21', customer_phone: '+38970777888', customer_name: 'Снежана', call_again_since: new Date(Date.now() - 4 * 86_400_000).toISOString(),
      last_call_at: '2026-09-29T10:00:00Z', last_call_outcome: 'no_answer', in_call_again_until: null, assigned_agent_id: null, assigned_agent_name: null,
      lifetime_value: 60, paid_count: 2, avg_package_price: 30, prediction_segment_lists: { name: '21d 26+ (1-3 orders)', category: 'value' }, department: 'altercpa' },
    { source_kind: 'order', list_id: 'order:o9', order_id: 'o9', customer_phone: '+38970999000', customer_name: 'Горан', call_again_since: new Date(Date.now() - 86_400_000).toISOString(),
      last_call_at: null, last_call_outcome: null, in_call_again_until: null, assigned_agent_id: null, assigned_agent_name: null,
      lifetime_value: null, paid_count: null, avg_package_price: 25, prediction_segment_lists: { name: 'Артро Плус', category: 'order' }, department: 'altercpa' },
  ],
};
const summary = {
  agents: [{ agent_id: 'u-ana', full_name: 'Ана Петровска', assigned_total: 30, open_total: 25, pendings_total: 5, lists: [{ list_id: 'l-21', list_name: '21d 26+ (1-3 orders)', display_order: 10, is_active: true, assigned: 30, open: 25 }] }],
  totals: { agents: 1, assigned_total: 30, open_total: 25, pendings_total: 5 },
};

function renderAt(url: string) {
  api.board.mockResolvedValue(board);
  api.lists.mockResolvedValue(lists);
  api.pendings.mockResolvedValue(pendings);
  api.callAgains.mockResolvedValue(callAgains);
  api.summary.mockResolvedValue(summary);
  api.distribute.mockImplementation(async (body: DistributeBody) => ({
    kind: body.kind, dry_run: body.dry_run, pool: 3, selected: 3, assigned: 0,
    per_agent: body.agent_ids.map((id, i) => ({ agent_id: id, full_name: id, count: i === 0 ? 3 : 0 })),
  }));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <AssignerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ENGLISH_LEFTOVERS = /Prediction Lists|\bactive\b|Unassign|matching|tick rows|\bwhole\b|\bhalf\b|\bcustom\b|Product|each to|\bAgent\b|Call Agains|Distribute|Received|Last paid|lifetime/;

describe('Распределувач', { timeout: 30_000 }, () => {
  it('renders in Macedonian: KPI tiles, the agent board, the tabs with their counts — no English leftovers', async () => {
    renderAt('/assigner');
    expect(await screen.findByText('Ана Петровска', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Распределувач' })).toBeInTheDocument();
    expect(screen.getByText('Пендинзи за делење')).toBeInTheDocument();
    expect(screen.getByText('најстариот чека 4 дена')).toBeInTheDocument();
    expect(screen.getByText('Во живо')).toBeInTheDocument();

    // The tab counts are what each tab shows.
    expect(await screen.findByRole('tab', { name: 'Списоци (3)' })).toBeInTheDocument();       // NEWCOMERS is empty here
    expect(await screen.findByRole('tab', { name: 'Пендинзи (3)' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Повторни повици (7)' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'Одземање (35)' })).toBeInTheDocument();

    // Lists: the name and a GENERATED description in mk; the Trash List is read-only.
    expect(await screen.findByText('21–57 дена · над 1.599 ден · 1–3 нарачки')).toBeInTheDocument();
    expect(screen.getByText('Последно платиле пред 21–57 дена · последната платена нарачка над 1.599 ден · 1–2 платени нарачки вкупно')).toBeInTheDocument();
    expect(screen.getByText('Само преглед')).toBeInTheDocument();
    expect(screen.getByText('Прикажи 1 празни листи')).toBeInTheDocument();

    await waitFor(() => expect(api.callAgains).toHaveBeenCalled());
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(ENGLISH_LEFTOVERS);
  });

  it('the department chips filter through the URL and the api', async () => {
    renderAt('/assigner?dept=web');
    await screen.findByText('Ана Петровска', {}, { timeout: 10_000 });
    await waitFor(() => expect(api.lists).toHaveBeenCalledWith(['web'], expect.anything()));
    const group = screen.getByRole('group', { name: 'Оддели' });
    expect(within(group).getByRole('button', { name: /Веб-продавница/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Сите' })).toHaveAttribute('aria-pressed', 'false');
    // Pendings in the chosen department only.
    expect(await screen.findByRole('tab', { name: 'Пендинзи (1)' })).toBeInTheDocument();
  });

  it('the DistributeBar previews with a dry run: "N → 1 агент: …"', async () => {
    renderAt('/assigner?tab=pendings');
    await screen.findAllByText('Марија К.', {}, { timeout: 10_000 });
    expect(screen.getByText('Избери агенти на таблата погоре.')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/^Бети Николова · /));
    await waitFor(() => expect(api.distribute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pendings', dry_run: true, agent_ids: ['u-beti'], count: 20, split: 'total', order: 'newest', include_assigned: false }),
      expect.anything(),
    ));
    const preview = screen.getByTestId('distribute-preview');
    await waitFor(() => expect(preview).toHaveTextContent('3 → 1 агент: Бети Николова 3'));
    expect(preview).toHaveTextContent('нема доволно: достапни 3');
    expect(screen.getByRole('button', { name: 'Распредели 3' })).toBeEnabled();
    expect(document.body.textContent ?? '').not.toMatch(ENGLISH_LEFTOVERS);
  });

  it('call-agains warn when a chosen agent is offline', async () => {
    renderAt('/assigner?tab=call_agains');
    await screen.findAllByText('Снежана', {}, { timeout: 10_000 });
    expect(api.callAgains).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, agent_id: 'unassigned', order: 'oldest', source: 'all' }), expect.anything(),
    );
    // The row shows the translated list label and how long it has waited.
    expect(screen.getAllByText('21–57 дена · над 1.599 ден · 1–3 нарачки').length).toBeGreaterThan(0);
    expect(screen.getAllByText('чека 4 дена').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle(/^Ivana Trajkovska · /));
    expect(await screen.findByRole('alert')).toHaveTextContent('Офлајн: Ivana Trajkovska');
    expect(document.body.textContent ?? '').not.toMatch(ENGLISH_LEFTOVERS);
  });

  it('a realtime "refresh" on the assigner channel refetches the board', async () => {
    renderAt('/assigner');
    await screen.findByText('Ана Петровска', {}, { timeout: 10_000 });
    expect(rt.topics).toContain('assigner');
    const before = api.board.mock.calls.length;
    rt.handlers.refresh?.();
    await waitFor(() => expect(api.board.mock.calls.length).toBeGreaterThan(before), { timeout: 3_000 });
  });
});
