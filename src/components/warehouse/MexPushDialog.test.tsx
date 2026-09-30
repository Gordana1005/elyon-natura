import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { PushResult, PushSwitch, SendRow } from '@/lib/warehouseApi';

// "Испрати до MEX": the dialog always dry-runs first, sends only after the explicit
// "MEX нема откажување" confirmation, sends only the ready orders, and shows what
// happened to each one. The SendTab keeps the button disabled while the switch is off.
const h = vi.hoisted(() => ({ push: vi.fn(), queue: vi.fn(), toast: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), apiGetProducts: vi.fn(async () => []) }));
vi.mock('@/lib/warehouseApi', async (orig) => {
  const m = await orig<typeof import('@/lib/warehouseApi')>();
  return { ...m, apiMexPush: (b: unknown) => h.push(b), apiGetWarehouseQueue: (p: unknown) => h.queue(p) };
});
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: h.toast }) }));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { MexPushDialog } = await import('./MexPushDialog');
const { SendTab } = await import('./SendTab');
const { useInsightsFormat } = await import('@/components/insights/shared/useInsightsFormat');

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

const row = (id: string, display: string, over: Partial<SendRow> = {}): SendRow => ({
  id, display_id: display, status: 'confirmed', created_at: '2026-09-29T08:00:00Z', sale_at: '2026-09-29T08:00:00Z',
  department: 'altercpa', customer_name: 'Ана Петровска', customer_phone: '+38976123456', customer_city: 'Скопје',
  postal_code: '1000', mex_city_id: 262, mex_city_name: 'Skopje - Aerodrom', ship_after_date: null, price_eur: 30.08,
  product_name: 'Alpha Male', quantity: 1, items: [{ product_name: 'Alpha Male', quantity: 1, brand_line: 'bio_natural' }],
  seller: null, seller_team: null, mex_sent_at: null,
  validation: { ok: true, missing: [] },
  account: { suggested: 'bio_natural', basis: 'product_line', reasons: [], needs_pick: false, line_profiles: ['bio_natural'], department_profile: 'bio_natural', team_profile: null, open: true },
  warnings: [], blockers: [], no_parcel_days_left: 5, zone: { id: 262, name: 'Skopje - Aerodrom' },
  ...over,
});

const PUSH_ON: PushSwitch = {
  enabled: true, accounts: { bio_natural: true, natura: true }, max_per_send: 50, auto_send_at: null,
  auto_send_scheduled: false, keys: { bio_natural: true, natura: true }, can_push: true, can_toggle: false,
};

const payload = { tracking_id: 'ORD-1', sender_reference: 'ORD-1', first_name: 'Ana', last_name: 'Petrovska', receiver_phone: '076123456',
  receiver_address: 'Partizanska br. 12', receiver_city_id: 262, cod: '1850', weight: 1 };
const dryReady: PushResult = { order_id: ID1, display_id: 'ORD-1', outcome: 'dry_run', account: 'bio_natural', blockers: [], warnings: [],
  decision: { account: 'bio_natural', basis: 'product_line', reasons: [], needs_pick: false }, payload };
const dryBlocked: PushResult = { order_id: ID2, display_id: 'ORD-2', outcome: 'dry_run', account: 'bio_natural', blockers: ['address'], warnings: [],
  decision: { account: 'bio_natural', basis: 'product_line', reasons: [], needs_pick: false }, payload: null };

function Harness(props: { rows: SendRow[]; push: PushSwitch; onDone: (r: PushResult[]) => void }) {
  const f = useInsightsFormat();
  return <MexPushDialog open onOpenChange={() => {}} rows={props.rows} push={props.push} money onDone={props.onDone} f={f} />;
}
function TabHarness() {
  const f = useInsightsFormat();
  return <SendTab f={f} />;
}
const wrap = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

beforeEach(() => { h.push.mockReset(); h.queue.mockReset(); h.toast.mockReset(); });

describe('MexPushDialog — dry run → confirm → send', { timeout: 30_000 }, () => {
  it('dry-runs first, sends only the ready order after the no-cancel confirmation, shows the result', async () => {
    h.push.mockImplementation(async (b: { dry_run: boolean; order_ids: string[] }) => b.dry_run
      ? { dry_run: true, results: [dryReady, dryBlocked], stopped: null, settings: { enabled: true, accounts: PUSH_ON.accounts }, keys: PUSH_ON.keys, money: true }
      : { dry_run: false, results: [{ order_id: ID1, display_id: 'ORD-1', outcome: 'sent', account: 'bio_natural', tracking_id: 'ORD-1' }], stopped: null,
          settings: { enabled: true, accounts: PUSH_ON.accounts }, keys: PUSH_ON.keys, money: true });
    const onDone = vi.fn();
    wrap(<Harness rows={[row(ID1, 'ORD-1'), row(ID2, 'ORD-2', { validation: { ok: false, missing: ['address'] } })]} push={PUSH_ON} onDone={onDone} />);

    // the dry run: nothing sent yet, the exact payload shown, the blocked one explained
    expect(await screen.findByText(i18n.t('warehousePage.dialog.summary', { ready: 1, blocked: 1 }))).toBeInTheDocument();
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0]).toMatchObject({ order_ids: [ID1, ID2], dry_run: true });
    expect(screen.getByText('Partizanska br. 12')).toBeInTheDocument();
    expect(screen.getByText('1.850 ден')).toBeInTheDocument();
    expect(screen.getByText(i18n.t('warehousePage.code.address'))).toBeInTheDocument();
    expect(screen.getByText(i18n.t('warehousePage.dialog.noCancel'))).toBeInTheDocument();

    // the send button waits for the confirmation
    const send = screen.getByRole('button', { name: i18n.t('warehousePage.dialog.send', { count: 1 }) });
    expect(send).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: i18n.t('warehousePage.dialog.confirm', { count: 1 }) }));
    expect(send).toBeEnabled();
    fireEvent.click(send);

    expect(await screen.findByText(i18n.t('warehousePage.dialog.result.sent', { tracking: 'ORD-1' }), { exact: false })).toBeInTheDocument();
    const real = h.push.mock.calls.find((c) => c[0].dry_run === false)![0];
    expect(real).toMatchObject({ order_ids: [ID1], dry_run: false });
    expect(real.order_ids).not.toContain(ID2);
    expect(screen.getByText(i18n.t('warehousePage.dialog.done', { sent: 1, linked: 0, failed: 0 }))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: i18n.t('warehousePage.dialog.close') }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith([expect.objectContaining({ order_id: ID1, outcome: 'sent' })]));
  });

  it('with the switch off nothing can be sent — only the dry run runs', async () => {
    h.push.mockResolvedValue({ dry_run: true, results: [{ ...dryReady, blockers: ['account_disabled'] }], stopped: null,
      settings: { enabled: false, accounts: { bio_natural: false, natura: false } }, keys: PUSH_ON.keys, money: true });
    wrap(<Harness rows={[row(ID1, 'ORD-1')]} push={{ ...PUSH_ON, enabled: false }} onDone={vi.fn()} />);
    expect(await screen.findByText(i18n.t('warehousePage.send.switchOff'))).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: i18n.t('warehousePage.dialog.confirm', { count: 0 }) })).toBeDisabled();
    expect(screen.getByRole('button', { name: i18n.t('warehousePage.dialog.send', { count: 0 }) })).toBeDisabled();
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0].dry_run).toBe(true);
  });

  it('a needed pick sends the chosen account with its reason (and re-checks)', async () => {
    const needs: PushResult = { ...dryReady, account: null, blockers: ['needs_pick'],
      decision: { account: 'bio_natural', basis: 'department', reasons: ['line_missing'], needs_pick: true } };
    h.push.mockImplementation(async (b: { account_overrides?: Record<string, unknown> }) => ({
      dry_run: true, results: [b.account_overrides?.[ID1] ? { ...dryReady, account: 'natura' } : needs], stopped: null,
      settings: { enabled: true, accounts: PUSH_ON.accounts }, keys: PUSH_ON.keys, money: true }));
    wrap(<Harness rows={[row(ID1, 'ORD-1')]} push={PUSH_ON} onDone={vi.fn()} />);
    const select = await screen.findByLabelText(`${i18n.t('warehousePage.dialog.account')} ORD-1`);
    fireEvent.change(select, { target: { value: 'natura' } });
    fireEvent.change(screen.getByLabelText(`${i18n.t('warehousePage.dialog.reason')} ORD-1`), { target: { value: 'Natura производ' } });
    await waitFor(() => expect(h.push.mock.calls.some((c) => c[0].account_overrides?.[ID1]?.account === 'natura')).toBe(true), { timeout: 3_000 });
    const last = h.push.mock.calls.at(-1)![0];
    expect(last.account_overrides[ID1]).toEqual({ account: 'natura', reason: 'Natura производ', double_ok: false });
    expect(await screen.findByText(i18n.t('warehousePage.dialog.summary', { ready: 1, blocked: 0 }))).toBeInTheDocument();
  });
});

describe('SendTab — the switch', { timeout: 30_000 }, () => {
  it('switched off: the button is disabled and says to use the MEX CSV', async () => {
    h.queue.mockResolvedValue({
      tab: 'send', order: 'oldest', limit: 50, offset: 0, total: 1, money: false, generated_at: '2026-10-01T09:00:00Z',
      counts: { send: 1, send_by_department: { altercpa: 1 }, send_over_3d: 0, send_no_address: 0, send_no_zone: 0, send_unconfirmed: 0,
        pack: 0, pack_by_department: {}, pack_over_3d: 0, pack_stale: 0, active_products: 1, stale_days: 14 },
      rows: [row(ID1, 'ORD-1', { price_eur: undefined })],
      push: { ...PUSH_ON, enabled: false, accounts: { bio_natural: false, natura: false } },
    });
    wrap(<TabHarness />);
    expect(await screen.findByTestId('mex-switch-off')).toHaveTextContent(i18n.t('warehousePage.send.switchOff'));
    const rowBox = await screen.findAllByRole('checkbox', { name: i18n.t('warehousePage.send.selectRow', { id: 'ORD-1' }) });
    fireEvent.click(rowBox[0]);
    expect(screen.getByRole('button', { name: new RegExp(i18n.t('warehousePage.send.buttonDisabled')) })).toBeDisabled();
    // non-owner: no value column
    expect(screen.queryByText(i18n.t('warehousePage.send.col.value'))).not.toBeInTheDocument();
  });
});
