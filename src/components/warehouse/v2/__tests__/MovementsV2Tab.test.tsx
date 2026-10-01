import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import i18n from '@/i18n';
import { health, move, MOVES } from './fixtures';
import { renderAt, setViewport, urlParams } from './harness';

// Магацин → Движења: the ledger rows with their badges (entered late, re-dated in Sigma, a
// correction, provisional), a running balance only when the api sends it, filters in the URL.
const h = vi.hoisted(() => ({ health: vi.fn(), moves: vi.fn(), config: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/stockV2Api', () => ({
  apiStockV2Health: (d: boolean) => h.health(d),
  apiStockV2Movements: (q: unknown) => h.moves(q),
  apiStockV2Config: () => h.config(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { isAdmin: false, isManager: true, isWarehouse: false } }) }));
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ canSeeBusiness: false }) }));

beforeAll(async () => {
  await i18n.changeLanguage('mk');
});

const { MovementsV2Tab } = await import('../MovementsV2Tab');
const { useInsightsFormat } = await import('@/components/insights/shared/useInsightsFormat');
function Tab() { return <MovementsV2Tab f={useInsightsFormat()} />; }

beforeEach(() => {
  for (const f of [h.health, h.moves, h.config]) f.mockReset();
  h.health.mockResolvedValue(health());
  h.moves.mockResolvedValue(MOVES);
});

describe('Движења', { timeout: 30_000 }, () => {
  it('a table from lg with the badges, no balance column unless the api sends one', async () => {
    setViewport(1280);
    renderAt(<Tab />, '/warehouse?tab=movements&from=2026-09-28&to=2026-09-30');
    const table = await screen.findByTestId('stock2-moves-table');
    expect(h.moves).toHaveBeenLastCalledWith({
      from: '2026-09-28', to: '2026-09-30', warehouse: null, article: null, q: null, kind: null, source: null,
      corrections: false, limit: 100, offset: 0,
    });
    expect(within(table).getByText(i18n.t('stock2.moves.late', { count: 3 }))).toBeInTheDocument();
    expect(within(table).getByText(i18n.t('stock2.moves.redated'))).toBeInTheDocument();
    expect(within(table).getByText(i18n.t('stock2.moves.correction'))).toBeInTheDocument();
    expect(within(table).getByText(i18n.t('stock2.moves.provisional'))).toBeInTheDocument();
    expect(within(table).getByText('+240')).toBeInTheDocument();
    expect(within(table).getByText(i18n.t('stock2.kind.receipt'))).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: i18n.t('stock2.moves.colBalance') })).not.toBeInTheDocument();
  });

  it('one article + one warehouse → the running balance; cards on a phone', async () => {
    setViewport(390);
    h.moves.mockResolvedValue({ total: 1, rows: [move({ id: 9, balance_after: 1160 })] });
    renderAt(<Tab />, '/warehouse?tab=movements&art=100123&wh=main');
    const card = (await screen.findAllByTestId('stock2-move-card'))[0];
    expect(within(card).getByText(i18n.t('stock2.moves.balanceShort', { n: '1.160' }))).toBeInTheDocument();
    expect(h.moves).toHaveBeenLastCalledWith(expect.objectContaining({ article: '100123', warehouse: 'main' }));
  });

  it('filters go to the URL: kind, source, only corrections, a code vs a name in the search', async () => {
    setViewport(1280);
    renderAt(<Tab />, '/warehouse?tab=movements');
    await screen.findByTestId('stock2-moves-table');
    const kind = screen.getByRole('combobox', { name: i18n.t('stock2.moves.kind') });
    fireEvent.change(kind, { target: { value: 'receipt' } });
    await waitFor(() => expect(urlParams().get('kind')).toBe('receipt'));
    fireEvent.change(screen.getByRole('combobox', { name: i18n.t('stock2.moves.source') }), { target: { value: 'sigma' } });
    await waitFor(() => expect(urlParams().get('source')).toBe('sigma'));
    fireEvent.click(screen.getByRole('button', { name: i18n.t('stock2.moves.onlyCorrections') }));
    await waitFor(() => expect(urlParams().get('corr')).toBe('1'));
    await waitFor(() => expect(h.moves).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'receipt', source: 'sigma', corrections: true })));

    const search = screen.getByPlaceholderText(i18n.t('stock2.moves.articlePlaceholder'));
    fireEvent.change(search, { target: { value: '100123' } });
    await waitFor(() => expect(urlParams().get('art')).toBe('100123'), { timeout: 2000 });
    expect(urlParams().get('q')).toBeNull();
    fireEvent.change(search, { target: { value: 'adeno' } });
    await waitFor(() => expect(urlParams().get('q')).toBe('adeno'), { timeout: 2000 });
    expect(urlParams().get('art')).toBeNull();
  });

  it('nothing moved → says so', async () => {
    setViewport(390);
    h.moves.mockResolvedValue({ total: 0, rows: [] });
    renderAt(<Tab />, '/warehouse?tab=movements');
    expect(await screen.findByText(i18n.t('stock2.moves.empty'))).toBeInTheDocument();
  });
});
