import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import library from '@/components/callscripts/__fixtures__/library.sample.json';
import coverage from '@/components/callscripts/__fixtures__/coverage.sample.json';
import type { ScriptsLibrary, ScriptsModeInfo, TargetedScript } from '@/lib/callScriptsTypes';

// /call-scripts (owner 02.10.2026, docs/CALL-SCRIPTS.md): agents read the published library only;
// a manager writes and publishes but never deletes nor flips the /calls switch; an admin deletes.
// Every save carries the version it was based on (409 stale → reload), duplicates and bulk changes
// go through their routes, a version is restored from the history. The api is mocked.
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
const auth: { user: { id: string; isAdmin: boolean; isManager: boolean; full_name: string } } = {
  user: { id: 'u-admin', isAdmin: true, isManager: false, full_name: 'Мила Админ' },
};
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ canAction: () => true }) }));
vi.mock('@/layouts/AppLayout', () => ({
  AppLayout: ({ title, children }: { title: string; children: React.ReactNode }) => <div><h1>{title}</h1>{children}</div>,
}));

const api = vi.hoisted(() => ({
  apiGetScriptsMode: vi.fn(),
  apiSetScriptsMode: vi.fn(),
  apiGetScriptsLibrary: vi.fn(),
  apiGetTargetedScript: vi.fn(),
  apiCreateTargetedScript: vi.fn(),
  apiSaveTargetedScript: vi.fn(),
  apiDuplicateTargetedScript: vi.fn(),
  apiBulkTargetedScripts: vi.fn(),
  apiGetScriptVersions: vi.fn(),
  apiRestoreTargetedScript: vi.fn(),
  apiDeleteTargetedScript: vi.fn(),
  apiGetDeletedScripts: vi.fn(),
  apiGetScriptsCoverage: vi.fn(),
  apiGetScriptSamples: vi.fn(),
  apiGetCallScriptsForCall: vi.fn(),
}));
vi.mock('@/lib/callScriptsApi', async (orig) => ({ ...(await orig<typeof import('@/lib/callScriptsApi')>()), ...api }));

beforeAll(async () => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  await i18n.changeLanguage('mk');
});

const { default: CallScriptsPage } = await import('./CallScriptsPage');
const { CallScriptsError } = await import('@/lib/callScriptsApi');

const LIB = () => structuredClone(library) as unknown as ScriptsLibrary;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);
type Role = 'agent' | 'manager' | 'admin';
const MODE: Record<Role, ScriptsModeInfo> = {
  agent: { mode: 'off', enabled_for_me: false, can_write: false, can_delete: false, can_switch: false },
  manager: { mode: 'off', enabled_for_me: false, can_write: true, can_delete: false, can_switch: false },
  admin: { mode: 'off', enabled_for_me: false, can_write: true, can_delete: true, can_switch: true },
};

function setup(role: Role, url = '/call-scripts') {
  auth.user = { id: `u-${role}`, isAdmin: role === 'admin', isManager: role === 'manager', full_name: 'Тест' };
  api.apiGetScriptsMode.mockResolvedValue(MODE[role]);
  const lib = LIB();
  // the api gives agents the published rows only
  if (role === 'agent') lib.scripts = lib.scripts.filter((s) => s.status === 'published');
  api.apiGetScriptsLibrary.mockResolvedValue(lib);
  api.apiGetTargetedScript.mockImplementation(async (sid: string) => lib.scripts.find((s) => s.id === sid));
  api.apiGetScriptsCoverage.mockResolvedValue(structuredClone(coverage));
  api.apiGetScriptSamples.mockResolvedValue({ samples: [] });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <CallScriptsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return lib;
}

/** Radix menus open from the keyboard in jsdom. */
const openMore = async () => {
  fireEvent.keyDown(await screen.findByTestId('editor-more'), { key: 'Enter' });
  return screen.findByRole('menu');
};

afterEach(() => { vi.clearAllMocks(); });

describe('/call-scripts — an agent reads the published library', { timeout: 30_000 }, () => {
  it('library + promo only, no writing tools, a script opens read-only', async () => {
    setup('agent');
    expect(await screen.findByText('Предикција 21 ден — Простатол', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.queryByText('Корпа — втора шанса')).toBeNull(); // a draft
    expect(screen.getAllByRole('tab').map((x) => x.textContent)).toEqual([t('callScripts.tabs.library'), t('promo.tab')]);
    expect(screen.queryByTestId('new-script')).toBeNull();
    expect(screen.queryByTestId('status-chip-draft')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByTestId('mode-switch')).toBeNull();
  });
  it('?script= shows the viewer, never the editor', async () => {
    setup('agent', `/call-scripts?script=${id(1)}`);
    expect(await screen.findByTestId('script-viewer', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByTestId('script-body')).toBeInTheDocument();
    expect(screen.queryByTestId('editor-status-bar')).toBeNull();
  });
});

describe('/call-scripts — a manager writes and publishes', { timeout: 30_000 }, () => {
  it('sees every tab, the drafts, the bulk checkboxes; the switch is a read-only badge', async () => {
    setup('manager');
    expect(await screen.findByText('Корпа — втора шанса', {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(6);
    expect(await screen.findByTestId('mode-badge')).toHaveTextContent(t('callScripts.mode.off'));
    expect(screen.queryByTestId('mode-on')).toBeNull();
    expect(screen.queryByTestId('open-deleted')).toBeNull();
  });
  it('publishes a draft with the version it read; no delete in the menu', async () => {
    const lib = setup('manager', `/call-scripts?script=${id(6)}`);
    const draft = lib.scripts.find((s) => s.id === id(6))!;
    api.apiSaveTargetedScript.mockResolvedValue({ script: { ...draft, status: 'published', version: draft.version + 1 } });
    fireEvent.click(await screen.findByTestId('editor-publish', {}, { timeout: 10_000 }));
    await waitFor(() => expect(api.apiSaveTargetedScript).toHaveBeenCalled());
    const [sid, body] = api.apiSaveTargetedScript.mock.calls[0];
    expect(sid).toBe(id(6));
    expect(body.expected_version).toBe(draft.version);
    expect(body.patch).toMatchObject({ status: 'published', title: draft.title, groups: ['trash'] });
    expect(body.patch.sections).toEqual(draft.sections);
    const menu = await openMore();
    expect(within(menu).getByTestId('editor-history')).toBeInTheDocument();
    expect(within(menu).queryByTestId('editor-delete')).toBeNull();
  });
  it('a 409 stale save offers to load the newer version', async () => {
    setup('manager', `/call-scripts?script=${id(1)}`);
    api.apiSaveTargetedScript.mockRejectedValue(new CallScriptsError('stale', 409, 'stale', { current_version: 4 }));
    const title = await screen.findByTestId('editor-title', {}, { timeout: 10_000 });
    fireEvent.change(title, { target: { value: 'Предикција 21 ден — Простатол (нова)' } });
    expect(screen.getByTestId('editor-state')).toHaveTextContent(t('callScripts.editor.stateDirty'));
    fireEvent.click(screen.getByTestId('editor-save'));
    const dlg = await screen.findByTestId('stale-dialog');
    expect(dlg).toHaveTextContent(t('callScripts.editor.staleDesc', { version: 4 }));
    const reads = api.apiGetTargetedScript.mock.calls.length;
    fireEvent.click(within(dlg).getByTestId('stale-reload'));
    await waitFor(() => expect(api.apiGetTargetedScript.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.getByTestId('editor-title')).toHaveValue('Предикција 21 ден — Простатол'));
  });
  it('duplicates per group, after showing how many drafts it will make', async () => {
    setup('manager', `/call-scripts?script=${id(1)}`);
    api.apiDuplicateTargetedScript.mockResolvedValue({ created: [{ id: id(30), title: 'копија 1' }, { id: id(31), title: 'копија 2' }] });
    const menu = await openMore();
    fireEvent.click(within(menu).getByTestId('editor-duplicate'));
    const dlg = await screen.findByTestId('duplicate-dialog');
    fireEvent.click(within(dlg).getByTestId('split-group'));
    expect(within(dlg).getByTestId('duplicate-preview')).toHaveTextContent(t('callScripts.duplicate.willCreate', { n: 2 }));
    fireEvent.click(within(dlg).getByTestId('duplicate-submit'));
    await waitFor(() => expect(api.apiDuplicateTargetedScript).toHaveBeenCalled());
    expect(api.apiDuplicateTargetedScript.mock.calls[0]).toEqual([id(1), {
      groups: ['d21', 'd57'], product_ids: ['a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002'], split: 'group', note: undefined,
    }]);
    expect(await within(dlg).findByText('копија 2')).toBeInTheDocument();
  });
  it('bulk-publishes the selected scripts', async () => {
    setup('manager');
    await screen.findByText('Корпа — втора шанса', {}, { timeout: 10_000 });
    api.apiBulkTargetedScripts.mockResolvedValue({ updated: [{ id: id(6), version: 3 }, { id: id(7), version: 2 }], skipped: [] });
    fireEvent.click(screen.getByRole('checkbox', { name: t('callScripts.bulk.selectOne', { title: 'Корпа — втора шанса' }) }));
    fireEvent.click(screen.getByRole('checkbox', { name: t('callScripts.bulk.selectOne', { title: 'Општа скрипта' }) }));
    const bar = screen.getByTestId('bulk-bar');
    expect(bar).toHaveTextContent(t('callScripts.bulk.selected', { n: 2 }));
    expect(within(bar).queryByTestId('bulk-delete')).toBeNull(); // managers never delete
    fireEvent.click(within(bar).getByTestId('bulk-publish'));
    await waitFor(() => expect(api.apiBulkTargetedScripts).toHaveBeenCalledWith({ ids: [id(6), id(7)], op: { status: 'published' } }));
    await waitFor(() => expect(screen.queryByTestId('bulk-bar')).toBeNull());
  });
  it('restores an older version from the history', async () => {
    const lib = setup('manager', `/call-scripts?script=${id(1)}`);
    const cur = lib.scripts.find((s) => s.id === id(1))!;
    const v2: TargetedScript = { ...cur, version: 2, title: 'Стар наслов' };
    api.apiGetScriptVersions.mockResolvedValue({
      versions: [
        { id: 1, script_id: id(1), version: 1, action: 'create', snapshot: { ...cur, version: 1 }, actor_id: null, actor_name: 'Мила', note: null, created_at: '2026-10-02T08:00:00Z' },
        { id: 2, script_id: id(1), version: 2, action: 'update', snapshot: v2, actor_id: null, actor_name: 'Елена', note: 'пократко', created_at: '2026-10-02T09:00:00Z' },
        { id: 3, script_id: id(1), version: 3, action: 'publish', snapshot: cur, actor_id: null, actor_name: 'Елена', note: null, created_at: '2026-10-02T09:15:00Z' },
      ],
    });
    api.apiRestoreTargetedScript.mockResolvedValue({ script: { ...v2, version: 4 } });
    const menu = await openMore();
    fireEvent.click(within(menu).getByTestId('editor-history'));
    const drawer = await screen.findByTestId('history-drawer');
    fireEvent.click(await within(drawer).findByText('пократко', { exact: false }));
    fireEvent.click(within(drawer).getByTestId('restore-v2'));
    fireEvent.click(await screen.findByTestId('restore-confirm'));
    await waitFor(() => expect(api.apiRestoreTargetedScript).toHaveBeenCalledWith(id(1), { version: 2, note: undefined }));
    await waitFor(() => expect(screen.getByTestId('editor-title')).toHaveValue('Стар наслов'));
  });
});

describe('/call-scripts — an admin deletes and flips the switch', { timeout: 30_000 }, () => {
  it('deletes from the editor (admin route)', async () => {
    setup('admin', `/call-scripts?script=${id(7)}`);
    api.apiDeleteTargetedScript.mockResolvedValue({ ok: true, version: 3 });
    const menu = await openMore();
    fireEvent.click(within(menu).getByTestId('editor-delete'));
    fireEvent.click(await screen.findByTestId('delete-confirm'));
    await waitFor(() => expect(api.apiDeleteTargetedScript).toHaveBeenCalledWith(id(7), undefined));
  });
  it('the switch asks first and shows the coverage before "Вклучено"', async () => {
    setup('admin');
    api.apiSetScriptsMode.mockResolvedValue({ ...MODE.admin, mode: 'on', enabled_for_me: true });
    fireEvent.click(await screen.findByTestId('mode-on', {}, { timeout: 10_000 }));
    const dlg = await screen.findByTestId('mode-confirm');
    expect(await within(dlg).findByText(t('callScripts.mode.emptyCells', { n: '17' }))).toBeInTheDocument();
    fireEvent.click(within(dlg).getByTestId('mode-confirm-ok'));
    await waitFor(() => expect(api.apiSetScriptsMode).toHaveBeenCalledWith('on', undefined));
  });
  it('sees the bulk delete and the deleted scripts', async () => {
    setup('admin');
    await screen.findByText('Корпа — втора шанса', {}, { timeout: 10_000 });
    expect(screen.getByTestId('open-deleted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: t('callScripts.bulk.selectOne', { title: 'Општа скрипта' }) }));
    expect(within(screen.getByTestId('bulk-bar')).getByTestId('bulk-delete')).toBeInTheDocument();
  });
});
