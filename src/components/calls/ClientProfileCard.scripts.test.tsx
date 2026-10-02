import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';

// ClientProfileCard × the targeted call scripts: the switch decides between today's panel (inside
// CustomerHistoryTabs, at the bottom) and the new dock (right after the toolbar). The heavy
// children are replaced by markers that show what they were given.

const api = vi.hoisted(() => ({ mode: vi.fn() }));
vi.mock('@/lib/callScriptsApi', async (orig) => ({
  ...(await orig<typeof import('@/lib/callScriptsApi')>()),
  apiGetScriptsMode: (...a: unknown[]) => api.mode(...a),
}));
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetCustomerHistory: async () => ({ orders: [], calls: [] }),
  apiGetCustomerPrefill: async () => ({ profile: null }),
}));
vi.mock('@/hooks/useCustomerIntelligence', () => ({ useCustomerIntelligence: () => ({ data: null, loading: false }) }));
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ canAction: () => false }) }));
vi.mock('./CustomerHistoryTabs', () => ({
  CustomerHistoryTabs: ({ showScripts }: { showScripts?: boolean }) => <div data-testid="history" data-show-scripts={String(!!showScripts)} />,
}));
vi.mock('./scripts/ScriptDock', () => ({
  ScriptDock: ({ context, className }: { context: unknown; className?: string }) => (
    <div data-testid="dock" className={className} data-context={JSON.stringify(context)} />
  ),
}));
vi.mock('./CustomerNotesPanel', () => ({ CustomerNotesPanel: () => null }));
vi.mock('./PriorDecisions', () => ({ PriorDecisions: () => null }));
vi.mock('@/components/PersonalHoldBadge', () => ({ PersonalHoldBadge: () => null }));
vi.mock('@/components/calls/PersonalListButton', () => ({ PersonalListButton: () => null }));
vi.mock('@/components/ActiveViewBadge', () => ({ ActiveViewBadge: () => null }));

const { ClientProfileCard } = await import('./ClientProfileCard');

beforeAll(async () => { await i18n.changeLanguage('mk'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderCard(props: Partial<Parameters<typeof ClientProfileCard>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ClientProfileCard phone="+38970123456" toolbar={<div data-testid="toolbar" />} showScripts {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClientProfileCard — which script panel', () => {
  it('mode off: today\'s panel exactly as before (inside the history), no dock', async () => {
    api.mode.mockResolvedValue({ mode: 'off', enabled_for_me: false, can_write: false, can_delete: false, can_switch: false });
    renderCard({ scriptContext: { source: 'lead', orderId: 'o1' } });
    await waitFor(() => expect(screen.getByTestId('history')).toHaveAttribute('data-show-scripts', 'true'));
    expect(screen.queryByTestId('dock')).toBeNull();
  });

  it('preview for an agent (enabled_for_me false) and an api without the route behave like off', async () => {
    api.mode.mockResolvedValue({ mode: 'preview', enabled_for_me: false, can_write: false, can_delete: false, can_switch: false });
    const first = renderCard();
    await waitFor(() => expect(screen.getByTestId('history')).toHaveAttribute('data-show-scripts', 'true'));
    first.unmount();
    api.mode.mockRejectedValue(new Error('HTTP 404'));
    renderCard();
    await waitFor(() => expect(screen.getByTestId('history')).toHaveAttribute('data-show-scripts', 'true'));
    expect(screen.queryByTestId('dock')).toBeNull();
  });

  it('mode on: the dock right after the toolbar (md and up), today\'s panel off', async () => {
    api.mode.mockResolvedValue({ mode: 'on', enabled_for_me: true, can_write: false, can_delete: false, can_switch: false });
    renderCard({ scriptContext: { source: 'prediction', listId: 'list-21' } });
    const dock = await screen.findByTestId('dock');
    expect(dock).toHaveClass('hidden', 'md:block');
    expect(JSON.parse(dock.getAttribute('data-context')!)).toEqual({ source: 'prediction', listId: 'list-21' });
    expect(screen.getByTestId('toolbar').nextElementSibling).toBe(dock);
    expect(screen.getByTestId('history')).toHaveAttribute('data-show-scripts', 'false');
  });

  it('nothing is shown while the mode loads (no flash of the old panel)', () => {
    api.mode.mockReturnValue(new Promise(() => {}));
    renderCard();
    expect(screen.getByTestId('history')).toHaveAttribute('data-show-scripts', 'false');
    expect(screen.queryByTestId('dock')).toBeNull();
  });
});
