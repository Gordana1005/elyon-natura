import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Access levels (migration 20260947001600): get_my_permissions() carries the person's money
// level and scope. The provider reads it STRICTLY (a missing key = the restrictive answer) and
// useInsightsAccess() turns it into the Insights tabs: margins → Pure Profit / Margin Lab, MEX
// cash → the whole tab or a dept_admin's own account, revenue / a dept scope → money.
const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  user: null as null | Record<string, unknown>,
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => h.rpc(...a) } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: h.user }) }));

const { PermissionsProvider, useInsightsAccess, usePermissions } = await import('./PermissionsContext');
const { NO_MONEY_ACCESS, parseMoneyAccess, scopedKeys } = await import('@/lib/access');

const CENTAR = ['teleshop_out', 'teleshop_other', 'social'];

describe('parseMoneyAccess — strict', () => {
  it('reads the six keys of a dept_admin', () => {
    expect(parseMoneyAccess({
      accessLevel: 'dept_admin', departments: CENTAR, canSeeMargins: false, canSeeRevenue: false,
      canSeeMexCash: false, mexCashDepartments: CENTAR,
    })).toEqual({
      accessLevel: 'dept_admin', deptScope: CENTAR, canSeeMargins: false, canSeeRevenue: false,
      canSeeMexCash: false, mexCashDepartments: CENTAR,
    });
  });
  it('the whole MEX tab = null departments; a company-wide viewer has no deptScope', () => {
    const a = parseMoneyAccess({
      accessLevel: 'owner', departments: null, canSeeMargins: true, canSeeRevenue: true, canSeeMexCash: true, mexCashDepartments: null,
    });
    expect(a).toMatchObject({ accessLevel: 'owner', deptScope: null, canSeeMargins: true, canSeeMexCash: true, mexCashDepartments: null });
  });
  it('a missing / malformed key is the restrictive answer', () => {
    expect(parseMoneyAccess(null)).toEqual(NO_MONEY_ACCESS);
    expect(parseMoneyAccess({ isBusinessOwner: true })).toEqual(NO_MONEY_ACCESS);
    expect(parseMoneyAccess({ accessLevel: 'emperor', canSeeMargins: 'yes', canSeeMexCash: 1 })).toEqual(NO_MONEY_ACCESS);
    // a dept_admin whose departments did not arrive is scoped to none, never to all
    expect(parseMoneyAccess({ accessLevel: 'dept_admin' }).deptScope).toEqual([]);
    // a list on someone who is not a dept_admin never scopes them
    expect(parseMoneyAccess({ accessLevel: 'administrator', departments: ['altercpa'] }).deptScope).toBeNull();
    // no whole-tab grant and no list = no MEX cash
    expect(parseMoneyAccess({ accessLevel: 'administrator', mexCashDepartments: null }).mexCashDepartments).toEqual([]);
  });
});

describe('scopedKeys', () => {
  it('null = not scoped; else the order filtered to the scope', () => {
    const order = ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management'] as const;
    expect(scopedKeys(order, null)).toBeNull();
    expect(scopedKeys(order, ['social', 'teleshop_out'])).toEqual(['teleshop_out', 'social']);
    expect(scopedKeys(order, [])).toEqual([]);
  });
});

// ── the provider + useInsightsAccess ──────────────────────────────────────────
const insightsPerm = (role: string) => ({ role, module_key: 'insights', can_view: true, can_create: false, can_edit: false, can_delete: false, can_export: false });

function Probe() {
  const p = usePermissions();
  const a = useInsightsAccess();
  if (p.loading) return <p>loading</p>;
  return (
    <pre data-testid="probe">{JSON.stringify({
      level: p.accessLevel, deptScope: p.deptScope, margins: p.canSeeMargins, revenue: p.canSeeRevenue, business: p.canSeeBusiness,
      tabs: { business: a.business, mexCash: a.mexCash, overview: a.overview, money: a.money, deptScope: a.deptScope, any: a.any },
    })}</pre>
  );
}
async function probe(user: Record<string, unknown>, payload: Record<string, unknown>) {
  h.user = user;
  h.rpc.mockResolvedValue({ data: { modules: [], financialVisibility: [], privacy: [], ...payload }, error: null });
  render(<PermissionsProvider><Probe /></PermissionsProvider>);
  const el = await screen.findByTestId('probe');
  await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('get_my_permissions'));
  return JSON.parse(el.textContent ?? '{}');
}
const admin = { id: 'u-admin', roles: ['admin'], isAdmin: true, isManager: false, isExternalAffiliate: false };
const manager = { id: 'u-man', roles: ['manager'], isAdmin: false, isManager: true, isExternalAffiliate: false };

beforeEach(() => { h.rpc.mockReset(); });

describe('useInsightsAccess — by level', () => {
  it('an administrator: revenue + Overview, no margin tabs, no MEX cash', async () => {
    const r = await probe(admin, {
      rolePermissions: [], isBusinessOwner: true, accessLevel: 'administrator', departments: null,
      canSeeMargins: false, canSeeRevenue: true, canSeeMexCash: false, mexCashDepartments: [],
    });
    expect(r).toMatchObject({ level: 'administrator', deptScope: null, margins: false, revenue: true, business: true });
    expect(r.tabs).toMatchObject({ business: false, mexCash: false, overview: true, money: true, deptScope: null, any: true });
  });

  it('an owner / finance: everything', async () => {
    const r = await probe(admin, {
      rolePermissions: [], isBusinessOwner: true, accessLevel: 'finance', departments: null,
      canSeeMargins: true, canSeeRevenue: true, canSeeMexCash: true, mexCashDepartments: null,
    });
    expect(r.tabs).toMatchObject({ business: true, mexCash: true, overview: true, money: true });
  });

  it('a dept_admin (a manager): their departments money + their MEX account, no margin tabs', async () => {
    const r = await probe(manager, {
      rolePermissions: [insightsPerm('manager')], isBusinessOwner: false, accessLevel: 'dept_admin', departments: CENTAR,
      canSeeMargins: false, canSeeRevenue: false, canSeeMexCash: false, mexCashDepartments: CENTAR,
    });
    expect(r).toMatchObject({ level: 'dept_admin', deptScope: CENTAR, business: false });
    expect(r.tabs).toMatchObject({ business: false, mexCash: true, overview: true, money: true, deptScope: CENTAR });
  });

  it('a manager with no level money: the Overview counted, nothing else', async () => {
    const r = await probe(manager, {
      rolePermissions: [insightsPerm('manager')], isBusinessOwner: false, accessLevel: 'team_lead', departments: [],
      canSeeMargins: false, canSeeRevenue: false, canSeeMexCash: false, mexCashDepartments: [],
    });
    expect(r.tabs).toMatchObject({ business: false, mexCash: false, overview: true, money: false, deptScope: null });
  });

  it('an RPC without the new keys: revenue as before, never margins or MEX cash', async () => {
    const r = await probe(admin, { rolePermissions: [], isBusinessOwner: true });
    expect(r).toMatchObject({ level: null, margins: false, business: true });
    expect(r.tabs).toMatchObject({ business: false, mexCash: false, money: true });
  });

  it('an external partner never sees company money, whatever the RPC says', async () => {
    const r = await probe({ id: 'u-ext', roles: ['affiliate'], isAdmin: false, isManager: false, isExternalAffiliate: true }, {
      rolePermissions: [], isBusinessOwner: true, accessLevel: 'owner', departments: null,
      canSeeMargins: true, canSeeRevenue: true, canSeeMexCash: true, mexCashDepartments: null,
    });
    expect(r).toMatchObject({ margins: false, revenue: false, business: false });
    expect(r.tabs).toMatchObject({ business: false, mexCash: false, overview: false, money: false });
  });
});
