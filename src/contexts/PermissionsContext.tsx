import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { AppRole } from '@/contexts/AuthContext';
import { NO_MONEY_ACCESS, parseMoneyAccess, type AccessLevel, type MoneyAccess } from '@/lib/access';

// ── Types ──

export interface ModuleSetting {
  module_key: string;
  module_label: string;
  is_enabled: boolean;
  is_protected: boolean;
}

export interface RolePermission {
  role: string;
  module_key: string;
  can_view: boolean;
  can_create: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_export: boolean;
}

export interface FinancialVisibility {
  role: string;
  show_profit: boolean;
  show_net_contribution: boolean;
  show_cost: boolean;
  show_returned_value: boolean;
  show_financial_insights: boolean;
}

export interface RolePrivacy {
  role: string;
  show_customer_phone: boolean;
  show_customer_name: boolean;
  show_customer_address: boolean;
  show_order_history: boolean;
  show_segment_members: boolean;
  can_hear_recordings: boolean;
  can_hear_own_recordings: boolean;
}

interface PermissionsContextType {
  modules: ModuleSetting[];
  rolePermissions: RolePermission[];
  financialVisibility: FinancialVisibility[];
  privacy: RolePrivacy[];
  loading: boolean;
  /** Check if a module is globally enabled */
  isModuleEnabled: (moduleKey: string) => boolean;
  /** Check if current user can view a module (enabled + role has can_view) */
  canAccessModule: (moduleKey: string) => boolean;
  /** Check specific action permission for current user on a module */
  canAction: (moduleKey: string, action: 'view' | 'create' | 'edit' | 'delete' | 'export') => boolean;
  /** Check if current user can see a financial metric */
  canSeeFinancial: (metric: keyof Omit<FinancialVisibility, 'role'>) => boolean;
  /** Check a customer-privacy flag for the current user (admin-first, OR across roles) */
  canSeePrivacy: (flag: keyof Omit<RolePrivacy, 'role'>) => boolean;
  /** Company-wide REVENUE: the server's is_business_owner() = can_see_revenue() since
   *  20260947001600 — the levels super_admin / owner / finance / administrator with an
   *  active profile. A dept_admin is NOT here (their revenue is scoped: deptScope).
   *  No client-side role bypass on top of it. UX only: the api enforces the same rule. */
  canSeeBusiness: boolean;
  /** The person's money level (20260947001600): super_admin · owner · finance ·
   *  administrator · dept_admin · team_lead · operator · warehouse · partner; null until
   *  loaded or when the server does not say. App roles still decide the PAGES. */
  accessLevel: AccessLevel | null;
  /** A dept_admin's departments (cohort keys, e.g. ['teleshop_out','teleshop_other','social']).
   *  Non-null ONLY for a dept_admin; null for everyone else (company-wide viewers included —
   *  read canSeeRevenue for them). [] = a dept_admin with no department valid today. */
  deptScope: string[] | null;
  /** Margins, purchase costs (Sigma), VAT per product, net profit: super_admin / owner /
   *  finance (can_see_margins()). Administrators and dept_admins never. */
  canSeeMargins: boolean;
  /** Company-wide revenue + returns (can_see_revenue()) — the same answer as canSeeBusiness. */
  canSeeRevenue: boolean;
  /** The WHOLE Insights → Наплата (MEX) tab (can_see_mex_cash() = can_see_margins()). */
  canSeeMexCash: boolean;
  /** Department-scoped наплата: null = the whole tab, string[] = a dept_admin's departments,
   *  [] = none (administrators included). */
  mexCashDepartments: string[] | null;
  /** Refresh all permissions from DB */
  refresh: () => Promise<void>;
}

const PermissionsContext = createContext<PermissionsContextType | undefined>(undefined);

/** The ONLY modules an external affiliate (partner with no internal role) may
 *  reach. Frontend twin of the server hard wall in
 *  supabase/functions/api/index.ts — keep the two in sync. */
const EXTERNAL_AFFILIATE_MODULES = new Set(['affiliate_portal']);

// ── Module key → route path mapping ──
export const MODULE_ROUTE_MAP: Record<string, string> = {
  dashboard: '/',
  insights: '/insights',
  operations: '/operations',
  orders: '/orders',
  inbound_leads: '/inbound-leads',
  assigner: '/assigner',
  lead_distribution: '/lead-distribution',
  assigned: '/assigned',
  prediction_leads: '/prediction-leads',
  prediction_lists: '/predictions',
  order_import: '/import-orders',
  search_prediction: '/search-prediction',
  warehouse: '/warehouse',
  users: '/users',
  performance: '/performance',
  agent_activity: '/agent-activity',
  shifts: '/shifts',
  my_shifts: '/my-shifts',
  call_scripts: '/call-scripts',
  call_history: '/call-history',
  calls: '/calls',
  recordings: '/recordings',
  missed_calls: '/missed-calls',
  segments: '/segments',
  products: '/products',
  webhooks: '/webhooks',
  affiliates_admin: '/affiliates-admin',
  affiliate_portal: '/affiliate',
  altercpa_bridge: '/altercpa',
  ads: '/ads',
  settings: '/settings',
  voip_health: '/voip-health',
};

export const ROUTE_MODULE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(MODULE_ROUTE_MAP).map(([k, v]) => [v, k])
);

export function PermissionsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [modules, setModules] = useState<ModuleSetting[]>([]);
  const [rolePermissions, setRolePermissions] = useState<RolePermission[]>([]);
  const [financialVisibility, setFinancialVisibility] = useState<FinancialVisibility[]>([]);
  const [privacy, setPrivacy] = useState<RolePrivacy[]>([]);
  const [isBusinessOwner, setIsBusinessOwner] = useState(false);
  const [money, setMoney] = useState<MoneyAccess>(NO_MONEY_ACCESS);
  const [loading, setLoading] = useState(true);
  // Whose permissions are loaded. The fetch starts in an effect AFTER the render in which a login
  // appears, so for that one render `loading` still says false (it was false on the login page)
  // while rolePermissions is empty — every ProtectedRoute then saw "no access" and bounced the
  // fresh login (agents to /assigned; prediction agents, who cannot open /assigned, into a
  // redirect loop = a white screen). Loading is therefore also "not yet loaded for THIS user".
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // Only the newest fetch may write state: a slow response for the previous
  // login must never land on top of the next login's permissions.
  const fetchSeq = useRef(0);

  const fetchAll = useCallback(async (uid: string) => {
    const seq = ++fetchSeq.current;
    try {
      // Single RPC replaces three direct table SELECTs. The RPC is
      // SECURITY DEFINER so it works regardless of how restrictive the
      // underlying table policies are.
      const { data, error } = await supabase.rpc('get_my_permissions');
      if (error) throw error;
      if (seq !== fetchSeq.current) return;
      const payload = data as {
        modules?: ModuleSetting[];
        rolePermissions?: RolePermission[];
        financialVisibility?: FinancialVisibility[];
        privacy?: RolePrivacy[];
        isBusinessOwner?: boolean;
        accessLevel?: unknown;
        departments?: unknown;
        canSeeMargins?: unknown;
        canSeeRevenue?: unknown;
        canSeeMexCash?: unknown;
        mexCashDepartments?: unknown;
      } | null;
      setModules(payload?.modules ?? []);
      setRolePermissions(payload?.rolePermissions ?? []);
      setFinancialVisibility(payload?.financialVisibility ?? []);
      setPrivacy(payload?.privacy ?? []);
      // Strictly `true` — a missing key (RPC not migrated yet) means NOT an owner.
      setIsBusinessOwner(payload?.isBusinessOwner === true);
      // The access level and its money scope (20260947001600) — strict, see parseMoneyAccess.
      setMoney(parseMoneyAccess(payload));
    } catch {
      // Silently fail — permissions will default to restrictive
    } finally {
      if (seq === fetchSeq.current) { setLoading(false); setLoadedFor(uid); }
    }
  }, []);

  useEffect(() => {
    // A different login never inherits the previous one's owner flag or money
    // scope, not even for the moment its own permissions take to load.
    setIsBusinessOwner(false);
    setMoney(NO_MONEY_ACCESS);
    if (user) { setLoading(true); fetchAll(user.id); }
    else { setLoading(false); setLoadedFor(null); }
  }, [user?.id]);

  const isModuleEnabled = useCallback((moduleKey: string): boolean => {
    const mod = modules.find(m => m.module_key === moduleKey);
    return mod ? mod.is_enabled : true; // default enabled if not found
  }, [modules]);

  const userRoles: AppRole[] = user?.roles ?? [];

  const canAccessModule = useCallback((moduleKey: string): boolean => {
    if (!isModuleEnabled(moduleKey)) return false;
    // External partner: allowlist, not blocklist. The hardcoded module
    // short-circuits below (calls/missed_calls) grant staff pages to any login
    // holding at least one role, which used to put Calls / Call Again /
    // Missed Calls / Personal List in an affiliate's sidebar.
    if (user?.isExternalAffiliate) return EXTERNAL_AFFILIATE_MODULES.has(moduleKey);
    // Admin always has access
    if (userRoles.includes('admin')) return true;
    // VOIP mockup: keys not yet seeded in module_settings. Remove when seed migration lands.
    if (moduleKey === 'calls' || moduleKey === 'missed_calls') return userRoles.length > 0;
    // Segments page: admin/manager can see that lists EXIST (the member counts + the
    // people inside are hidden separately via the show_segment_members flag, server-side).
    if (moduleKey === 'segments') return userRoles.includes('admin') || userRoles.includes('manager');
    // Recordings (playback): admins + roles granted can_hear_recordings (e.g. inbound_agent).
    if (moduleKey === 'recordings') return userRoles.includes('admin') || userRoles.some(role => privacy.find(p => p.role === role)?.can_hear_recordings ?? false);
    // Products & Ads: hidden from call agents (agent/pending_agent/prediction_agent).
    // Products is for stock owners (manager/warehouse); Webhooks & Ads for
    // manager/ads_admin. Admin already returned true above.
    if (moduleKey === 'products') return userRoles.some(r => r === 'manager' || r === 'warehouse');
    if (moduleKey === 'webhooks') return userRoles.some(r => r === 'manager' || r === 'ads_admin');
    // Check if any of user's roles have can_view for this module
    return userRoles.some(role => {
      const perm = rolePermissions.find(p => p.role === role && p.module_key === moduleKey);
      return perm?.can_view ?? false;
    });
  }, [isModuleEnabled, userRoles, rolePermissions, privacy, user]);

  const canAction = useCallback((moduleKey: string, action: 'view' | 'create' | 'edit' | 'delete' | 'export'): boolean => {
    if (!isModuleEnabled(moduleKey)) return false;
    if (user?.isExternalAffiliate && !EXTERNAL_AFFILIATE_MODULES.has(moduleKey)) return false;
    if (userRoles.includes('admin')) return true;
    return userRoles.some(role => {
      const perm = rolePermissions.find(p => p.role === role && p.module_key === moduleKey);
      if (!perm) return false;
      switch (action) {
        case 'view': return perm.can_view;
        case 'create': return perm.can_create;
        case 'edit': return perm.can_edit;
        case 'delete': return perm.can_delete;
        case 'export': return perm.can_export;
        default: return false;
      }
    });
  }, [isModuleEnabled, userRoles, rolePermissions, user]);

  const canSeeFinancial = useCallback((metric: keyof Omit<FinancialVisibility, 'role'>): boolean => {
    if (userRoles.includes('admin')) return true;
    return userRoles.some(role => {
      const vis = financialVisibility.find(v => v.role === role);
      return vis ? vis[metric] : false;
    });
  }, [userRoles, financialVisibility]);

  // Customer-privacy flags (mask phone/name/address, order history, segment members,
  // recordings). Admin-first; otherwise true if ANY of the user's roles grants it.
  const canSeePrivacy = useCallback((flag: keyof Omit<RolePrivacy, 'role'>): boolean => {
    if (userRoles.includes('admin')) return true;
    return userRoles.some(role => {
      const p = privacy.find(v => v.role === role);
      return p ? p[flag] : false;
    });
  }, [userRoles, privacy]);

  // The server's predicate only (see the type). An external partner login can never be an
  // owner — the server refuses to add one — but the hard wall holds here too.
  const canSeeBusiness = isBusinessOwner && !user?.isExternalAffiliate;
  // The same hard wall for the access level: an external partner never sees company money.
  const m = user?.isExternalAffiliate ? NO_MONEY_ACCESS : money;

  return (
    <PermissionsContext.Provider value={{
      modules, rolePermissions, financialVisibility, privacy,
      loading: loading || (!!user && loadedFor !== user.id),
      isModuleEnabled, canAccessModule, canAction, canSeeFinancial, canSeePrivacy,
      canSeeBusiness,
      accessLevel: m.accessLevel,
      deptScope: m.deptScope,
      canSeeMargins: m.canSeeMargins,
      canSeeRevenue: m.canSeeRevenue,
      canSeeMexCash: m.canSeeMexCash,
      mexCashDepartments: m.mexCashDepartments,
      refresh: () => (user ? fetchAll(user.id) : Promise.resolve()),
    }}>
      {children}
    </PermissionsContext.Provider>
  );
}

export function usePermissions() {
  const ctx = useContext(PermissionsContext);
  if (!ctx) throw new Error('usePermissions must be used within PermissionsProvider');
  return ctx;
}

/** A dept_admin's departments, or null — for a widget that may render outside the provider
 *  (a report tab under test): no provider = no scope known, the payload's meta.dept_scope
 *  still narrows the view. Display only; the api enforces. */
export function useDeptScope(): string[] | null {
  return useContext(PermissionsContext)?.deptScope ?? null;
}

/** Which parts of /insights the current login may open (access levels, 20260947001600).
 *  - `business` — the MARGIN tabs (Pure Profit, Margin Lab; any profit tab): canSeeMargins
 *    only (super_admin / owner / finance). Administrators and dept_admins never.
 *  - `mexCash` — Наплата (MEX): the whole tab (canSeeMexCash) or a dept_admin's own account
 *    (mexCashDepartments holds ≥ 1 department; the api narrows the payload to it).
 *  - `overview` — the cohort tabs (Overview, Sales, Prediction lists, Stock, Returns): every
 *    company-wide revenue viewer (canSeeBusiness), any admin/manager with Insights (the same
 *    pages counted) and a dept_admin with Insights (their departments' money).
 *  - `money` — some money on /insights: company-wide revenue or a dept_admin's departments.
 *    Every tab renders money from the payload's meta.money; this flag is for the UI around it
 *    (a money column's header, an export button) before or without a payload.
 *  - `deptScope` — a dept_admin's departments (null for everyone else).
 *  The operational tabs keep their module rules. ManagementInsightsPage and the sidebar both
 *  read this, so the two can never disagree; the server enforces the same split (GET
 *  /insights/profit is margins-only, /insights/mex-cash 403s anyone without a scope, and every
 *  other /insights/* endpoint strips or narrows money for the viewer). The global Insights
 *  module switch still hides everything from everyone. */
export function useInsightsAccess() {
  const {
    canAccessModule, canSeeBusiness, canSeeMargins, canSeeMexCash, mexCashDepartments, deptScope, isModuleEnabled,
  } = usePermissions();
  const { user } = useAuth();
  const canInsights = canAccessModule('insights');
  const insightsOn = isModuleEnabled('insights');
  const deptAdmin = (deptScope?.length ?? 0) > 0;
  // Margins / purchase costs / profit: super_admin, owner, finance only.
  const business = canSeeMargins && insightsOn;
  // Наплата (MEX): the whole tab, or a dept_admin's own MEX account.
  const mexCash = (canSeeMexCash || (mexCashDepartments?.length ?? 0) > 0) && insightsOn;
  // The connected Overview: company-wide revenue viewers see it with money; any admin/manager
  // with Insights the same page counted; a dept_admin their departments' money.
  // GET /insights/overview enforces the same split (meta.money, meta.dept_scope).
  const overview = (canSeeBusiness && insightsOn)
    || (canInsights && !!(user?.isAdmin || user?.isManager) && !user?.isExternalAffiliate)
    || (canInsights && deptAdmin);
  // Agents also honours the legacy Performance module key.
  const agents = canInsights || canAccessModule('performance');
  // Payout: admin/manager (insights access implies management).
  const payout = canInsights;
  // Call Activity is its own module (admin-only by default), governed from
  // Settings → Role Permissions.
  const calls = canAccessModule('call_activity');
  const money = canSeeBusiness || deptAdmin;
  return {
    business, mexCash, overview, agents, payout, calls, money, deptScope,
    any: business || mexCash || overview || agents || payout || calls,
  };
}
