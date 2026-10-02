import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { AccessLevelsResponse } from '@/lib/api';

// Settings → Пристап и улоги against a synthetic GET /settings/access payload (no real people).
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-me' } }) }));
const refresh = vi.fn(async () => {});
vi.mock('@/contexts/PermissionsContext', () => ({ usePermissions: () => ({ refresh }) }));

let payload: AccessLevelsResponse;
const setLevel = vi.fn();
vi.mock('@/lib/api', async (orig) => ({
  ...(await orig<typeof import('@/lib/api')>()),
  apiGetAccessLevels: vi.fn(async () => payload),
  apiSetAccessLevel: (...a: unknown[]) => setLevel(...a),
}));

import { LevelsSection } from './LevelsSection';

const person = (o: Partial<AccessLevelsResponse['people'][number]> & { user_id: string; full_name: string }) => ({
  email: `${o.user_id}@example.test`, roles: ['admin'], level: 'operator' as const, explicit: true, departments: [], note: null,
  updated_at: '2026-10-02T18:00:00Z', updated_by_name: 'Me Test', last_super_admin: false, ...o,
});

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter><LevelsSection /></MemoryRouter></QueryClientProvider>);
}

beforeEach(async () => {
  await i18n.changeLanguage('mk');
  setLevel.mockReset();
  payload = {
    can_edit: true,
    levels: ['super_admin', 'owner', 'finance', 'administrator', 'dept_admin', 'team_lead', 'operator', 'warehouse'],
    departments: ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management'],
    people: [
      person({ user_id: 'u-me', full_name: 'Me Test', level: 'super_admin', last_super_admin: true }),
      person({ user_id: 'u-nina', full_name: 'Nina Test', level: 'administrator' }),
      person({ user_id: 'u-teo', full_name: 'Teo Test', roles: ['manager', 'pending_agent'], level: 'dept_admin',
        departments: ['teleshop_out', 'teleshop_other', 'social'], note: 'Тим Центар' }),
      person({ user_id: 'u-ana', full_name: 'Ana Test', roles: ['pending_agent'], level: 'operator', explicit: false, updated_at: null, updated_by_name: null }),
    ],
  };
});

const editButton = (name: string) => screen.getAllByRole('button', { name: i18n.t('settingsPage.levels.editAria', { name }) })[0];

describe('Settings → Пристап и улоги', () => {
  it('lists every person with the level name, the team departments and the role-rule mark', async () => {
    renderIt();
    expect((await screen.findAllByText('Teo Test')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Администратор на оддел').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Тим Центар Out').length).toBeGreaterThan(0);
    expect(screen.getAllByText(i18n.t('settingsPage.levels.byRule')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(i18n.t('settingsPage.levels.lastSuperAdminBadge')).length).toBeGreaterThan(0);
    // the legend: one line per level
    expect(screen.getByText(i18n.t('access.levelSees.administrator'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('settingsPage.levels.readOnly'))).toBeNull();
  });

  it('an owner reads: no edit buttons, the read-only line', async () => {
    payload = { ...payload, can_edit: false };
    renderIt();
    expect(await screen.findByText(i18n.t('settingsPage.levels.readOnly'))).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: i18n.t('settingsPage.levels.editAria', { name: 'Nina Test' }) })).toHaveLength(0);
  });

  it('the last super admin: the level is locked and said so', async () => {
    renderIt();
    await screen.findAllByText('Me Test');
    fireEvent.click(editButton('Me Test'));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByRole('combobox')).toBeDisabled();
    expect(within(dlg).getByText(i18n.t('settingsPage.levels.lastSuperAdmin', { name: 'Me Test' }))).toBeInTheDocument();
  });

  it('a dept_admin with every department removed cannot be saved; a server refusal shows in the dialog', async () => {
    setLevel.mockRejectedValueOnce(new Error('last_super_admin'));
    renderIt();
    await screen.findAllByText('Teo Test');
    fireEvent.click(editButton('Teo Test'));
    const dlg = await screen.findByRole('dialog');
    const save = within(dlg).getByRole('button', { name: i18n.t('common.save') });
    const centar = within(dlg).getByRole('checkbox', { name: i18n.t('insights.agents.team.byKey.teleshop') });
    fireEvent.click(centar); // the whole Тим Центар off
    expect(within(dlg).getByRole('alert')).toHaveTextContent(i18n.t('settingsPage.err.dept_required'));
    expect(save).toBeDisabled();
    fireEvent.click(within(dlg).getByRole('checkbox', { name: i18n.t('insights.common.source.social') }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(setLevel).toHaveBeenCalledWith('u-teo', { level: 'dept_admin', departments: ['social'] }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent(i18n.t('settingsPage.levels.lastSuperAdmin', { name: 'Teo Test' }));
  });
});
