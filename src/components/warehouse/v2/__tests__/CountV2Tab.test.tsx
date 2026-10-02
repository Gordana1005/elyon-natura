import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/i18n';
import { countResult, health } from './fixtures';
import { renderAt, setViewport } from './harness';

// Магацин → Попис (stock v2): the count form (paste from Excel, a dry preview, save), the history
// (void with a reason, owners approve) and the health card with the owner's switch.
const h = vi.hoisted(() => ({
  health: vi.fn(), config: vi.fn(), articles: vi.fn(), count: vi.fn(), counts: vi.fn(), voidC: vi.fn(), approve: vi.fn(),
  sw: vi.fn(), run: vi.fn(), toast: vi.fn(), owner: true, admin: false,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/stockV2Api', () => ({
  apiStockV2Health: (d: boolean) => h.health(d),
  apiStockV2Config: () => h.config(),
  apiStockV2Articles: (q: string) => h.articles(q),
  apiStockV2Count: (b: unknown) => h.count(b),
  apiStockV2Counts: (w: string) => h.counts(w),
  apiStockV2CountVoid: (id: string, r: string) => h.voidC(id, r),
  apiStockV2CountApprove: (id: string) => h.approve(id),
  apiStockV2Switch: (e: boolean) => h.sw(e),
  apiStockV2Run: (d: boolean) => h.run(d),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { isAdmin: h.admin, isManager: false, isWarehouse: !h.admin } }) }));
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ canSeeBusiness: h.owner, canSeeMargins: h.owner }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: h.toast }) }));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { CountV2Tab } = await import('../CountV2Tab');
const { useInsightsFormat } = await import('@/components/insights/shared/useInsightsFormat');
function Tab() { return <CountV2Tab f={useInsightsFormat()} />; }

beforeEach(() => {
  localStorage.clear();
  for (const f of [h.health, h.config, h.articles, h.count, h.counts, h.voidC, h.approve, h.sw, h.run, h.toast]) f.mockReset();
  h.owner = true;
  h.admin = false;
  h.health.mockResolvedValue(health());
  h.config.mockResolvedValue({ settings: {}, warehouses: [], routes: [], sigma_rules: [] });
  h.articles.mockResolvedValue([]);
  h.counts.mockResolvedValue([]);
});

async function pasteTwo() {
  fireEvent.click(screen.getByRole('button', { name: i18n.t('stock2.count.paste') }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '100123\t1.150\n100456\t0\n' } });
  expect(within(dialog).getByText(i18n.t('stock2.count.pasteFound', { n: '2' }))).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('button', { name: new RegExp(i18n.t('stock2.count.pasteApply', { n: '2' })) }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

describe('Попис v2', { timeout: 30_000 }, () => {
  it('owner: paste → preview (dry) with value → save → approved', async () => {
    setViewport(1280);
    renderAt(<Tab />, '/warehouse?tab=count');
    expect(await screen.findByTestId('stock2-health')).toBeInTheDocument();
    await pasteTwo();
    expect(screen.getByLabelText(i18n.t('stock2.count.qtyFor', { name: '100123' }))).toHaveValue('1.150');

    h.count.mockResolvedValueOnce(countResult({
      totals: { lines: 2, system_qty: 1158, counted_qty: 1150, diff: -8, value_diff_mkd: -1200 },
      lines: countResult().lines.map((l) => ({ ...l, value_diff_mkd: l.diff * 100 })),
    }));
    fireEvent.click(screen.getByRole('button', { name: i18n.t('stock2.count.preview') }));
    const preview = await screen.findByTestId('stock2-count-preview');
    const body = h.count.mock.calls[0][0];
    expect(body).toMatchObject({ warehouse: 'main', kind: 'partial', packed_counted: false, source: 'manual', dry: true,
      lines: [{ code: '100123', qty: 1150 }, { code: '100456', qty: 0 }] });
    expect(body.counted_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(within(preview).getByText(i18n.t('stock2.count.warn.parcels_near_count', { n: '3' }))).toBeInTheDocument();
    expect(within(preview).getByRole('columnheader', { name: i18n.t('stock2.count.colValue') })).toBeInTheDocument();
    expect(within(preview).getAllByText('-1.200 ден').length).toBeGreaterThan(0);
    // names come back from the preview
    expect(screen.getByText('Neurofix гел', { selector: 'p' })).toBeInTheDocument();

    h.count.mockResolvedValueOnce(countResult({ dry: false, count_id: 'c-9', status: 'approved' }));
    fireEvent.click(within(preview).getByRole('button', { name: i18n.t('stock2.count.save') }));
    expect(await screen.findByTestId('stock2-count-saved')).toHaveTextContent(i18n.t('stock2.count.savedApprovedBody', { lines: '2', diff: '−8' }));
    expect(h.count.mock.calls[1][0]).toMatchObject({ dry: false });
    expect(h.toast).toHaveBeenCalledWith({ title: i18n.t('stock2.count.savedApproved') });
    expect(screen.getByText(i18n.t('stock2.count.noLines'))).toBeInTheDocument();
  });

  it('warehouse role: no health card, no money, the count waits for an owner', async () => {
    h.owner = false;
    setViewport(390);
    renderAt(<Tab />, '/warehouse?tab=count');
    await screen.findByText(i18n.t('stock2.count.title'));
    expect(screen.queryByTestId('stock2-health')).not.toBeInTheDocument();
    expect(screen.getByText(i18n.t('stock2.count.pendingNote'))).toBeInTheDocument();
    await pasteTwo();
    h.count.mockResolvedValueOnce(countResult());
    fireEvent.click(screen.getByRole('button', { name: i18n.t('stock2.count.preview') }));
    const preview = await screen.findByTestId('stock2-count-preview');
    expect(within(preview).queryByText(i18n.t('stock2.count.colValue'))).not.toBeInTheDocument();
    h.count.mockResolvedValueOnce(countResult({ dry: false, count_id: 'c-10', status: 'pending' }));
    fireEvent.click(within(preview).getByRole('button', { name: i18n.t('stock2.count.save') }));
    expect(await screen.findByTestId('stock2-count-saved')).toHaveTextContent(i18n.t('stock2.count.savedPendingBody', { lines: '2', diff: '−8' }));
  });

  it('an invalid quantity blocks the preview', async () => {
    setViewport(1280);
    renderAt(<Tab />, '/warehouse?tab=count');
    await pasteTwo();
    fireEvent.change(screen.getByLabelText(i18n.t('stock2.count.qtyFor', { name: '100123' })), { target: { value: 'дваесет' } });
    expect(screen.getByRole('alert')).toHaveTextContent(i18n.t('stock2.count.invalid', { n: '1' }));
    expect(screen.getByRole('button', { name: i18n.t('stock2.count.preview') })).toBeDisabled();
  });

  it('the owner switches stock v2 on through a confirm, and can compute now (dry)', async () => {
    setViewport(1280);
    h.sw.mockResolvedValue({ ok: true, enabled: true });
    h.run.mockResolvedValue({ inserted: 0, would_insert: 1520 });
    renderAt(<Tab />, '/warehouse?tab=count');
    const card = await screen.findByTestId('stock2-health');
    expect(within(card).getByText(i18n.t('stock2.health.off'))).toBeInTheDocument();
    expect(within(card).getByText(i18n.t('stock2.health.q.unmapped'))).toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: i18n.t('stock2.health.runNow') }));
    expect(await screen.findByTestId('stock2-run-result')).toHaveTextContent('would_insert');
    expect(h.run).toHaveBeenCalledWith(true);

    fireEvent.click(within(card).getByRole('button', { name: i18n.t('stock2.health.switchOn') }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(i18n.t('stock2.health.switchOnBody', { groups: '1.520', units: '8.400' }))).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('stock2.health.switchOn') }));
    await waitFor(() => expect(h.sw).toHaveBeenCalledWith(true));
  });

  it('the switch waits for an approved opening', async () => {
    setViewport(1280);
    h.health.mockResolvedValue(health({ openings: [] }));
    renderAt(<Tab />, '/warehouse?tab=count');
    const card = await screen.findByTestId('stock2-health');
    expect(within(card).getByRole('button', { name: i18n.t('stock2.health.switchOn') })).toBeDisabled();
  });

  it('history: owners approve a pending count; void needs a reason', async () => {
    setViewport(1280);
    h.counts.mockResolvedValue([{
      id: 'c-5', warehouse: 'main', counted_at: '2026-09-30T06:00:00Z', kind: 'partial', source: 'manual', status: 'pending',
      packed_counted: true, lines: 12, diff_units: -3, note: 'Полица Б', created_by_name: 'Магацин', created_at: '2026-09-30T06:30:00Z',
      approved_by_name: null, approved_at: null, void_reason: null,
    }]);
    h.approve.mockResolvedValue({ ok: true });
    h.voidC.mockResolvedValue({ ok: true });
    renderAt(<Tab />, '/warehouse?tab=count');
    const hist = await screen.findByTestId('stock2-count-history');
    expect(await within(hist).findByText('Полица Б')).toBeInTheDocument();
    fireEvent.click(within(hist).getByRole('button', { name: i18n.t('stock2.count.approve') }));
    await waitFor(() => expect(h.approve).toHaveBeenCalledWith('c-5'));

    fireEvent.click(within(hist).getByRole('button', { name: i18n.t('stock2.count.void') }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: i18n.t('stock2.count.void') });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(i18n.t('stock2.count.voidReason')), { target: { value: 'грешен магацин' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(h.voidC).toHaveBeenCalledWith('c-5', 'грешен магацин'));
  });

  it('every stock role picks from the active, tracked warehouses of the health read — no owners-only config', async () => {
    h.owner = false;
    setViewport(390);
    renderAt(<Tab />, '/warehouse?tab=count');
    const select = await screen.findByRole('combobox', { name: new RegExp('^' + i18n.t('stock2.common.warehouse')) });
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Главен магацин Скопје', 'Оштетена роба']);
    expect(h.config).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: 'damaged' } });
    await waitFor(() => expect(h.counts).toHaveBeenLastCalledWith('damaged'));
  });

  it('the preview says every warning code in words; free text is shown as sent', async () => {
    h.owner = false;
    setViewport(1280);
    renderAt(<Tab />, '/warehouse?tab=count');
    await pasteTwo();
    h.count.mockResolvedValueOnce(countResult({ warnings: ['not_counted:4', 'pending_owner_approval', 'no_opening', 'Нешто ново'] }));
    fireEvent.click(screen.getByRole('button', { name: i18n.t('stock2.count.preview') }));
    const preview = await screen.findByTestId('stock2-count-preview');
    expect(within(preview).getByText(i18n.t('stock2.count.warn.not_counted', { n: '4' }))).toBeInTheDocument();
    expect(within(preview).getByText(i18n.t('stock2.count.warn.pending_owner_approval'))).toBeInTheDocument();
    expect(within(preview).getByText(i18n.t('stock2.count.warn.no_opening'))).toBeInTheDocument();
    expect(within(preview).getByText('Нешто ново')).toBeInTheDocument();
  });

  it('a refused count is said in words — with the article codes the api names', async () => {
    setViewport(1280);
    renderAt(<Tab />, '/warehouse?tab=count');
    await pasteTwo();
    const preview = () => fireEvent.click(screen.getByRole('button', { name: i18n.t('stock2.count.preview') }));
    h.count.mockRejectedValueOnce(new Error('unknown_article:100123, 100456'));
    preview();
    await waitFor(() => expect(h.toast).toHaveBeenLastCalledWith(expect.objectContaining({
      variant: 'destructive', description: i18n.t('stock2.count.warn.unknown_article', { n: '100123, 100456' }),
    })));
    h.count.mockRejectedValueOnce(new Error('kom_fraction:100123'));
    preview();
    await waitFor(() => expect(h.toast).toHaveBeenLastCalledWith(expect.objectContaining({
      description: i18n.t('stock2.count.warn.kom_fraction', { n: '100123' }),
    })));
    h.count.mockRejectedValueOnce(new Error('before_last_count'));
    preview();
    await waitFor(() => expect(h.toast).toHaveBeenLastCalledWith(expect.objectContaining({
      description: i18n.t('stock2.count.warn.before_last_count'),
    })));
    // anything else goes through the general api-error words
    h.count.mockRejectedValueOnce(new Error('Rate limit exceeded — slow down'));
    preview();
    await waitFor(() => expect(h.toast).toHaveBeenLastCalledWith(expect.objectContaining({ description: i18n.t('apiErrors.rateLimited') })));
  });

  it('history: an owner sees the value of a count difference', async () => {
    setViewport(1280);
    h.counts.mockResolvedValue([{
      id: 'c-6', warehouse: 'main', counted_at: '2026-09-21T22:00:00Z', kind: 'opening', source: 'sigma_variant', status: 'approved',
      packed_counted: false, lines: 2, diff_units: 15, value_diff_mkd: 6183.61, note: null, created_by_name: 'Mile Stoev',
      created_at: '2026-10-01T22:52:48Z', approved_by_name: 'Mile Stoev', approved_at: '2026-10-01T22:52:48Z', void_reason: null,
    }]);
    renderAt(<Tab />, '/warehouse?tab=count');
    const hist = await screen.findByTestId('stock2-count-history');
    expect(await within(hist).findByText(/6\.184 ден/)).toBeInTheDocument();
    expect(within(hist).queryByText(i18n.t('stock2.count.historyPartial'))).not.toBeInTheDocument();
  });

  it('history falls back to the openings while the api has no count list', async () => {
    setViewport(390);
    h.counts.mockRejectedValue(new Error('HTTP 404'));
    renderAt(<Tab />, '/warehouse?tab=count');
    const hist = await screen.findByTestId('stock2-count-history');
    expect(await within(hist).findByText(i18n.t('stock2.count.historyPartial'))).toBeInTheDocument();
    expect(within(hist).getByText(i18n.t('stock2.countStatus.approved'))).toBeInTheDocument();
    expect(within(hist).queryByRole('button', { name: i18n.t('stock2.count.void') })).not.toBeInTheDocument();
  });
});
