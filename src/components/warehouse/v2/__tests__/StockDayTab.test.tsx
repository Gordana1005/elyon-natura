import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/i18n';
import { health, ownerStockDay, SERIES, stockDay } from './fixtures';
import { renderAt, setViewport, urlParams } from './harness';

// Магацин → Залихи (stock v2): tiles, articles (cards below lg, a table from lg), the preview
// banner while the switch is off, money only when the api sent the keys, filters in the URL.
const h = vi.hoisted(() => ({ health: vi.fn(), day: vi.fn(), article: vi.fn(), config: vi.fn(), owner: false }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/stockV2Api', () => ({
  apiStockV2Health: (d: boolean) => h.health(d),
  apiStockV2Day: (q: unknown) => h.day(q),
  apiStockV2Article: (q: unknown) => h.article(q),
  apiStockV2Config: () => h.config(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { isAdmin: false, isManager: false, isWarehouse: true } }) }));
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ canSeeBusiness: h.owner }) }));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { StockDayTab } = await import('../StockDayTab');
const { useInsightsFormat } = await import('@/components/insights/shared/useInsightsFormat');
function Tab() { return <StockDayTab f={useInsightsFormat()} />; }

beforeEach(() => {
  for (const f of [h.health, h.day, h.article, h.config]) f.mockReset();
  h.owner = false;
  h.health.mockResolvedValue(health());
  h.config.mockRejectedValue(new Error('owners_only'));
  h.article.mockResolvedValue(SERIES);
});

describe('Залихи', { timeout: 30_000 }, () => {
  it('while the switch is off: asks for the preview, says so, cards on a phone, no money', async () => {
    setViewport(390);
    h.day.mockResolvedValue(stockDay());
    renderAt(<Tab />, '/warehouse?tab=stock&day=2026-09-30');
    expect(await screen.findByTestId('stock2-preview')).toHaveTextContent(i18n.t('stock2.preview.title'));
    expect(h.day).toHaveBeenLastCalledWith({ day: '2026-09-30', warehouse: 'main', at: null, preview: true });
    const flow = screen.getByRole('list', { name: i18n.t('stock2.day.flowTitle') });
    const position = screen.getByRole('list', { name: i18n.t('stock2.day.positionTitle') });
    expect(within(flow).getByText(i18n.t('stock2.tile.opening'))).toBeInTheDocument();
    expect(within(position).getByText(i18n.t('stock2.tile.available'))).toBeInTheDocument();
    expect(within(position).queryByText(i18n.t('stock2.tile.value'))).not.toBeInTheDocument();
    const cards = screen.getAllByTestId('stock2-article-card');
    expect(cards).toHaveLength(3);
    expect(screen.queryByTestId('stock2-article-table')).not.toBeInTheDocument();
    // the negative article is marked, and its closing reads −4
    const neg = cards.find((c) => c.getAttribute('data-negative'))!;
    expect(within(neg).getByText('Neurofix гел')).toBeInTheDocument();
    expect(within(neg).getByText('−4')).toBeInTheDocument();
    // КГ keeps its decimals
    expect(within(cards[2]).getAllByText('12,25').length).toBeGreaterThan(0);
    expect(screen.getByTestId('stock2-fresh')).toHaveTextContent(i18n.t('stock2.fresh.mex', { ago: i18n.t('overview.ago.min', { n: 4 }) }));
  });

  it('switched on: reads the ledger (preview=0), no banner', async () => {
    setViewport(1280);
    h.health.mockResolvedValue(health({ enabled: true }));
    h.day.mockResolvedValue(stockDay({ preview: false, enabled: true }));
    renderAt(<Tab />, '/warehouse?tab=stock&day=2026-09-30');
    expect(await screen.findByTestId('stock2-article-table')).toBeInTheDocument();
    expect(h.day).toHaveBeenLastCalledWith(expect.objectContaining({ preview: false }));
    expect(screen.queryByTestId('stock2-preview')).not.toBeInTheDocument();
  });

  it('an owner gets the value tile and column — from the keys the api sent', async () => {
    setViewport(1280);
    h.owner = true;
    h.config.mockResolvedValue({ settings: {}, warehouses: [], routes: [], sigma_rules: [] });
    h.day.mockResolvedValue(ownerStockDay());
    renderAt(<Tab />, '/warehouse?tab=stock&day=2026-09-30');
    const table = await screen.findByTestId('stock2-article-table');
    expect(within(table).getByRole('columnheader', { name: i18n.t('stock2.col.value') })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: i18n.t('stock2.day.positionTitle') })).getByText(i18n.t('stock2.tile.value'))).toBeInTheDocument();
    expect(screen.getByText('123.456 ден')).toBeInTheDocument();
    // full columns at 1280: the "other in / out" are separate
    expect(within(table).getByRole('columnheader', { name: i18n.t('stock2.col.otherOut') })).toBeInTheDocument();
  });

  it('filters live in the URL: only negatives, search, sort; a click opens the article drawer', async () => {
    setViewport(390);
    h.day.mockResolvedValue(stockDay());
    renderAt(<Tab />, '/warehouse?tab=stock&day=2026-09-30');
    await screen.findAllByTestId('stock2-article-card');

    fireEvent.click(screen.getByRole('button', { name: i18n.t('stock2.day.onlyNegative', { n: '1' }) }));
    await waitFor(() => expect(urlParams().get('neg')).toBe('1'));
    expect(screen.getAllByTestId('stock2-article-card')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(i18n.t('stock2.day.onlyNegative', { n: '1' }).replace(/[()]/g, '.')) }));
    await waitFor(() => expect(urlParams().get('neg')).toBeNull());

    fireEvent.change(screen.getByPlaceholderText(i18n.t('stock2.day.search')), { target: { value: 'adeno' } });
    await waitFor(() => expect(urlParams().get('q')).toBe('adeno'));
    expect(screen.getAllByTestId('stock2-article-card')).toHaveLength(1);

    fireEvent.change(screen.getByDisplayValue(i18n.t('stock2.day.sortBy.out')), { target: { value: 'name' } });
    await waitFor(() => expect(urlParams().get('sort')).toBe('name'));
    // no value sort without the money keys
    expect(screen.queryByRole('option', { name: i18n.t('stock2.day.sortBy.value') })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByTestId('stock2-article-card')[0].querySelector('button')!);
    await waitFor(() => expect(urlParams().get('art')).toBe('100123'));
    expect(await screen.findByTestId('stock2-article-drawer')).toBeInTheDocument();
    await waitFor(() => expect(h.article).toHaveBeenCalledWith(expect.objectContaining({ code: '100123', warehouse: 'main', to: '2026-09-30', preview: true })));
  });

  it('a failed read says so with a retry', async () => {
    setViewport(390);
    h.day.mockRejectedValue(new Error('HTTP 500'));
    renderAt(<Tab />, '/warehouse?tab=stock');
    expect(await screen.findByText(i18n.t('insights.loadFailed'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: i18n.t('common.retry') })).toBeInTheDocument();
  });
});
