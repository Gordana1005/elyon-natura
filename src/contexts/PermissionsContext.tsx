import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { AppRole } from '@/contexts/AuthContext';

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
  /** The full business/money view (owner ruling 2026-09-27): true ONLY for a
   *  login listed in public.business_owners. Deliberately NO admin bypass —
   *  nine accounts hold the admin role set and most of them must not see it.
   *  UX only: GET /management-insights enforces the same rule server-side. */
  canSeeBusiness: boolean;
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
  const [loading, setLoading] = useState(true);
  // Only the newest fetch may write state: a slow response for the previous
  // login must never land on top of the next login's permissions.
  const fetchSeq = useRef(0);

  const fetchAll = useCallback(async () => {
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
      } | null;
      setModules(payload?.modules ?? []);
      setRolePermissions(payload?.rolePermissions ?? []);
      setFinancialVisibility(payload?.financialVisibility ?? []);
      setPrivacy(payload?.privacy ?? []);
      // Strictly `true` — a missing key (RPC not migrated yet) means NOT an owner.
      setIsBusinessOwner(payload?.isBusinessOwner === true);
    } catch {
      // Silently fail — permissions will default to restrictive
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // A different login never inherits the previous one's owner flag, not
    // even for the moment its own permissions take to load.
    setIsBusinessOwner(false);
    if (user) fetchAll();
    else setLoading(false);
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

  // No admin bypass (see the type). An external partner login can never be an
  // owner — the server refuses to add one — but the hard wall holds here too.
  const canSeeBusiness = isBusinessOwner && !user?.isExternalAffiliate;

  return (
    <PermissionsContext.Provider value={{
      modules, rolePermissions, financialVisibility, privacy, loading,
      isModuleEnabled, canAccessModule, canAction, canSeeFinancial, canSeePrivacy,
      canSeeBusiness,
      refresh: fetchAll,
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

/** Which parts of /insights the current login may open (owner ruling
 *  2026-09-27). `business` gates the money tabs (Overview, Sales, Pure Profit,
 *  Margin Lab, Prediction Lists, Stock, Returns) and follows canSeeBusiness
 *  ONLY — no admin bypass. The operational tabs keep their module rules.
 *  ManagementInsightsPage and the sidebar both read this, so the two can never
 *  disagree; the server enforces the same split (GET /management-insights is
 *  owners-only except ?scope=calls). */
export function useInsightsAccess() {
  const { canAccessModule, canSeeBusiness, isModuleEnabled } = usePermissions();
  const canInsights = canAccessModule('insights');
  // The global module switch still hides Insights from everyone, owners too.
  const business = canSeeBusiness && isModuleEnabled('insights');
  // Agents also honours the legacy Performance module key.
  const agents = canInsights || canAccessModule('performance');
  // Payout: admin/manager (insights access implies management).
  const payout = canInsights;
  // Call Activity is its own module (admin-only by default), governed from
  // Settings → Role Permissions.
  const calls = canAccessModule('call_activity');
  return { business, agents, payout, calls, any: business || agents || payout || calls };
}
