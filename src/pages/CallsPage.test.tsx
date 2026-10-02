import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import i18n from '@/i18n';

// /calls (plan Фаза 11): the one-tap outcomes against POST /api/calls/outcome, the 5 s
// undo, the tel: link on a phone, the callbacks view and the /call-again redirect. The
// network, the softphone, the auth and the heavy customer card are replaced by mocks.

vi.mock('@/integrations/supabase/client', () => {
  const channel = { on: () => channel, subscribe: () => channel };
  return { supabase: { channel: () => channel, removeChannel: () => Promise.resolve(), auth: { getSession: async () => ({ data: { session: null } }) } } };
});
vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ children, headerActions }: { children: ReactNode; headerActions?: ReactNode }) => <div>{headerActions}{children}</div>,
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-agent', isAdmin: false, isManager: false, full_name: 'Ана' } }),
}));
const voip = vi.hoisted(() => ({ startCall: vi.fn() }));
vi.mock('@/contexts/VoipContext', () => ({
  useVoip: () => ({
    state: 'idle', startCall: voip.startCall, callerIds: null, pendingConfirm: null, clearPendingConfirm: vi.fn(),
    lastFinished: null, clearLastFinished: vi.fn(), endCallForClaim: vi.fn(),
  }),
}));
vi.mock('@/hooks/useActiveCallView', () => ({ useActiveCallView: () => undefined }));
vi.mock('@/components/calls/callSession', () => ({ getCallSession: () => null, setCallSession: () => undefined }));
vi.mock('@/components/calls/PromoOfTheDayBanner', () => ({ PromoOfTheDayBanner: () => null, PROMO_QUERY_KEY: ['promo'] }));
vi.mock('@/components/OrderModal', () => ({ OrderModal: () => null }));
vi.mock('@/components/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/calls/ClientProfileCard', () => ({
  ClientProfileCard: ({ phone, callAction, toolbar, scriptContext }: { phone: string; callAction?: ReactNode; toolbar?: ReactNode; scriptContext?: unknown }) => (
    <div>
      <div data-testid="customer">{phone}</div>
      <div data-testid="script-ctx">{JSON.stringify(scriptContext ?? null)}</div>
      {callAction}{toolbar}
    </div>
  ),
}));
// The prediction queues: the lists the agent has + their members (served the way useMyQueue does).
const queue = vi.hoisted(() => ({ markAfterCall: vi.fn(), queues: [] as unknown[], members: {} as Record<string, unknown[]> }));
vi.mock('@/components/calls/useMyQueue', async (orig) => {
  const { useEffect } = await import('react');
  return {
    ...(await orig<typeof import('@/components/calls/useMyQueue')>()),
    useMyQueue: (activeListId: string | null, onLoaded?: (id: string, m: any[]) => void) => {
      useEffect(() => {
        if (activeListId && queue.members[activeListId]) onLoaded?.(activeListId, queue.members[activeListId] as any[]);
      }, [activeListId]); // eslint-disable-line react-hooks/exhaustive-deps
      return { queues: queue.queues, queuesLoading: false, members: [] };
    },
    useQueueMutations: () => ({ markAfterCall: queue.markAfterCall, skipMember: vi.fn() }),
  };
});
// The targeted call scripts: the switch (GET /call-scripts/mode) and the script for the call.
const scripts = vi.hoisted(() => ({ mode: vi.fn(), forCall: vi.fn() }));
vi.mock('@/lib/callScriptsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/callScriptsApi')>()),
  apiGetScriptsMode: (...a: unknown[]) => scripts.mode(...a),
  apiGetCallScriptsForCall: (...a: unknown[]) => scripts.forCall(...a),
}));

const api = vi.hoisted(() => ({
  orders: vi.fn(), summary: vi.fn(), obligation: vi.fn(), claim: vi.fn(), release: vi.fn(), openLead: vi.fn(),
  record: vi.fn(), callbacks: vi.fn(), progress: vi.fn(),
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetOrders: (...a: unknown[]) => api.orders(...a),
  apiGetMyPendingsSummary: (...a: unknown[]) => api.summary(...a),
  apiGetMyCallObligation: (...a: unknown[]) => api.obligation(...a),
  apiClaimCallback: (...a: unknown[]) => api.claim(...a),
  apiReleaseActiveView: (...a: unknown[]) => api.release(...a),
  apiGetOpenLead: (...a: unknown[]) => api.openLead(...a),
}));
vi.mock('@/lib/callsWorkApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/callsWorkApi')>()),
  apiRecordCallOutcome: (...a: unknown[]) => api.record(...a),
  apiGetMyCallbacks: (...a: unknown[]) => api.callbacks(...a),
  apiGetCallsProgress: (...a: unknown[]) => api.progress(...a),
}));

const { default: CallsPage } = await import('./CallsPage');
const { CallAgainRedirect } = await import('@/components/calls/work/CallAgainRedirect');

const A = '+38970111111';
const B = '+38970222222';
const leads = [
  { id: 'lead-a', customer_phone: A, customer_name: 'Марија', status: 'pending', assigned_at: '2026-10-01T08:00:00Z', created_at: '2026-10-01T08:00:00Z' },
  { id: 'lead-b', customer_phone: B, customer_name: 'Петар', status: 'pending', assigned_at: '2026-10-01T07:00:00Z', created_at: '2026-10-01T07:00:00Z' },
];
const callbacks = {
  generated_at: '2026-10-01T08:00:00Z', total: 1, due: 1, soon: 0,
  items: [{
    kind: 'order', key: 'order:o9', order_id: 'o9', display_id: '100009', list_id: null, list_name: null, product_name: 'Артро Плус',
    customer_phone: '+38970999000', customer_name: 'Горан', due_at: null, due_state: 'due', call_again_since: '2026-09-29T08:00:00Z',
    last_call_at: '2026-09-30T08:00:00Z', last_call_outcome: 'no_answer',
  }],
};

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});
beforeEach(() => {
  api.orders.mockImplementation(async (p: { agent_id?: string }) => (p?.agent_id ? { orders: leads, total: 2 } : { orders: [], total: 0 }));
  api.summary.mockResolvedValue({ ready: 2, open: 2, parked: 0, talked_today: 0 });
  api.obligation.mockResolvedValue({ obligation: null });
  api.claim.mockResolvedValue({ claimed: false, orders: 0, members: 0 });
  api.release.mockResolvedValue({ ok: true, reverted: 0 });
  api.openLead.mockResolvedValue({ lead: null, leads: [] });
  api.record.mockResolvedValue({ ok: true, outcome: 'no_answer', order_id: 'lead-a', order_action: 'none', product_name: null, call_log_id: 'log-1', member_marked: 0, callback_at: null, warnings: [], next: 'fetch' });
  api.callbacks.mockResolvedValue(callbacks);
  api.progress.mockResolvedValue({ day: '2026-10-01', calls_today: 7, sales_today: 2, worked_today: 5, generated_at: '2026-10-01T08:00:00Z' });
  queue.queues = [];
  queue.members = {};
  scripts.mode.mockResolvedValue({ mode: 'off', enabled_for_me: false, can_write: false, can_delete: false, can_switch: false });
  scripts.forCall.mockResolvedValue({ enabled: false, mode: 'off', drafts_included: false, context: null, vars: null, best: null, alternatives: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
});

function renderAt(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/call-again" element={<CallAgainRedirect />} />
          <Route path="/calls" element={<CallsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const noAnswerButton = () => within(screen.getByRole('toolbar')).getByRole('button', { name: /Не одговара/ });

describe('CallsPage — one-tap outcomes', () => {
  it('"Не одговара": the next lead at once, the outcome sent to POST /calls/outcome when the undo closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAt('/calls');
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(A));

    fireEvent.click(noAnswerButton());
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(B)); // advanced
    expect(screen.getByTestId('undo-bar')).toHaveTextContent('Марија');
    expect(api.record).not.toHaveBeenCalled(); // still undoable

    await act(async () => { vi.advanceTimersByTime(5_100); });
    await waitFor(() => expect(api.record).toHaveBeenCalledTimes(1));
    expect(api.record.mock.calls[0][0]).toMatchObject({ phone: A, outcome: 'no_answer' });
    expect(api.record.mock.calls[0][0].list_id).toBeUndefined(); // a lead, not a list member
    expect(queue.markAfterCall).not.toHaveBeenCalled(); // the server marks members now
    expect(screen.queryByTestId('undo-bar')).toBeNull();
  });

  it('Undo puts the customer back and sends nothing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderAt('/calls');
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(A));
    fireEvent.click(noAnswerButton());
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(B));

    fireEvent.click(within(screen.getByTestId('undo-bar')).getByRole('button', { name: /Врати/ }));
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(A));
    await act(async () => { vi.advanceTimersByTime(6_000); });
    expect(api.record).not.toHaveBeenCalled();
  });

  it('a cancel needs its reason chip AND the written note, and goes out as ONE call with both', async () => {
    api.record.mockResolvedValue({ ok: true, outcome: 'cancelled', order_id: 'lead-a', order_action: 'updated', product_name: null, call_log_id: 'l', member_marked: 0, callback_at: null, warnings: [], next: 'fetch' });
    renderAt('/calls');
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(A));
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: /Откажа/ }));
    expect(api.record).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Не е заинтересиран' }));
    expect(api.record).not.toHaveBeenCalled(); // the chip opens the note step
    const field = within(screen.getByTestId('note-step')).getByRole('textbox');
    fireEvent.change(field, { target: { value: '  не  му треба ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(api.record).toHaveBeenCalledTimes(1));
    expect(api.record.mock.calls[0][0]).toMatchObject({ phone: A, outcome: 'cancelled', reason: 'not_interested', note: 'не му треба' });
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(B));
  });

  it('a note the server finds too short is explained in Macedonian', async () => {
    const { CallOutcomeError } = await import('@/lib/callsWorkApi');
    api.record.mockRejectedValueOnce(new CallOutcomeError('The note must be at least 7 characters long', 400, 'note_too_short'));
    const { Toaster } = await import('@/components/ui/toaster');
    render(<Toaster />);
    renderAt('/calls');
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(A));
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: /Откажа/ }));
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Нема пари' }));
    const field = within(screen.getByTestId('note-step')).getByRole('textbox');
    fireEvent.change(field, { target: { value: 'нема пари' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(api.record).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/најмалку 7 знаци/)).toBeInTheDocument();
    expect(screen.getByTestId('customer')).toHaveTextContent(A); // the customer stays on screen
  });

  it('two open orders: the server asks (409 choose_order) and the agent picks — never the code', async () => {
    const { CallOutcomeError } = await import('@/lib/callsWorkApi');
    const two = [
      { id: 'lead-a', display_id: '100001', status: 'pending', assigned_agent_id: null, assigned_agent_name: null, source_type: 'altercpa' },
      { id: 'dup-1', display_id: '100002', status: 'duplicated', assigned_agent_id: null, assigned_agent_name: null, source_type: 'manual', duplicated_from_display: '100001' },
    ];
    api.record
      .mockRejectedValueOnce(new CallOutcomeError('choose', 409, 'choose_order', two as any))
      .mockResolvedValueOnce({ ok: true, outcome: 'trash', order_id: 'dup-1', order_action: 'updated', product_name: null, call_log_id: 'l', member_marked: 0, callback_at: null, warnings: [], next: 'fetch' });
    renderAt('/calls');
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(A));
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: /Корпа/ }));
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Погрешен број' }));
    fireEvent.change(within(screen.getByTestId('note-step')).getByRole('textbox'), { target: { value: 'друг човек' } });
    fireEvent.click(within(screen.getByTestId('note-step')).getByRole('button', { name: 'Зачувај' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /100002/ }));
    await waitFor(() => expect(api.record).toHaveBeenCalledTimes(2));
    expect(api.record.mock.calls[1][0]).toMatchObject({ outcome: 'trash', reason: 'wrong_number', note: 'друг човек', order_id: 'dup-1' });
  });
});

describe('CallsPage — dialling and the callbacks view', () => {
  it('on a phone (390 px) the Call button is a tel: link in the local form — no mock softphone', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    renderAt('/calls');
    const link = await screen.findByTestId('dial-tel');
    expect(link).toHaveAttribute('href', 'tel:070111111');
    link.addEventListener('click', (e) => e.preventDefault()); // jsdom cannot open the phone app
    fireEvent.click(link);
    expect(voip.startCall).not.toHaveBeenCalled();
  });

  it('/call-again redirects to the callbacks view of /calls ("Мои")', async () => {
    renderAt('/call-again');
    const card = await screen.findByTestId('callback-card');
    expect(card).toHaveTextContent('Горан');
    expect(card).toHaveTextContent('Артро Плус');
    expect(screen.getByRole('tab', { name: /Повторни повици/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the progress row from GET /calls/progress', async () => {
    renderAt('/calls');
    const row = await screen.findByRole('region', { name: 'Денес' });
    expect(row).toHaveTextContent('Повици денес');
    await waitFor(() => expect(row).toHaveTextContent('7'));
    await waitFor(() => expect(row).toHaveTextContent('2'));
  });
});

describe('CallsPage — the call script context', () => {
  const ctx = () => JSON.parse(screen.getByTestId('script-ctx').textContent || 'null');

  it('a lead on screen → source lead + that order', async () => {
    renderAt('/calls');
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(A));
    expect(ctx()).toEqual({ source: 'lead', orderId: 'lead-a' });
  });

  it('a prediction list member → source prediction + the list (never the Pendings entry)', async () => {
    const C = '+38970333333';
    api.orders.mockResolvedValue({ orders: [], total: 0 });
    api.summary.mockResolvedValue({ ready: 0, open: 0, parked: 0, talked_today: 0 });
    queue.queues = [{ list_id: 'list-21', list_name: '21d 26+ (1-3 orders)', list_category: 'prediction', display_order: 1, remaining: 1, total: 1 }];
    queue.members = { 'list-21': [{ list_id: 'list-21', customer_phone: C, customer_name: 'Ристо', trigger_event_at: '2026-09-10T09:00:00Z', paid_count: 2, lifetime_value: 52 }] };
    renderAt('/calls');
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(C));
    expect(ctx()).toEqual({ source: 'prediction', listId: 'list-21' });
  });

  it('a callback opened from "Повторни повици" KEEPS its order (it used to arrive as a bare phone)', async () => {
    renderAt('/calls?queue=call-again');
    const card = await screen.findByTestId('callback-card');
    fireEvent.click(within(card).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent('+38970999000'));
    expect(ctx()).toEqual({ source: 'manual', orderId: 'o9', listId: null });
  });

  it('a prediction callback keeps its list', async () => {
    api.callbacks.mockResolvedValue({
      ...callbacks,
      items: [{ ...callbacks.items[0], kind: 'prediction', key: 'member:l57', order_id: null, display_id: null, list_id: 'list-57', list_name: '57d 26+ (1-3 orders)' }],
    });
    renderAt('/calls?queue=call-again');
    fireEvent.click(within(await screen.findByTestId('callback-card')).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent('+38970999000'));
    expect(ctx()).toEqual({ source: 'manual', orderId: null, listId: 'list-57' });
  });

  it("mode off: no script row in the pinned bar and today's padding", async () => {
    const { container } = renderAt('/calls');
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(A));
    await waitFor(() => expect(scripts.mode).toHaveBeenCalled());
    expect(screen.queryByTestId('outcome-bar-accessory')).toBeNull();
    expect(container.querySelector('.pb-28')).not.toBeNull();
    expect(scripts.forCall).not.toHaveBeenCalled();
  });

  it('mode on: the phone script row sits in the pinned bar (pb-36 makes room) and asks for this lead', async () => {
    scripts.mode.mockResolvedValue({ mode: 'on', enabled_for_me: true, can_write: false, can_delete: false, can_switch: false });
    const { container } = renderAt('/calls');
    await waitFor(() => expect(screen.getByTestId('customer')).toHaveTextContent(A));
    const acc = await screen.findByTestId('outcome-bar-accessory');
    expect(within(acc).getByTestId('script-dock-trigger')).toBeInTheDocument();
    expect(container.querySelector('.pb-36')).not.toBeNull();
    await waitFor(() => expect(scripts.forCall).toHaveBeenCalled());
    expect(scripts.forCall.mock.calls[0][0]).toEqual({ phone: A, source: 'lead', order_id: 'lead-a', list_id: null });
  });
});
