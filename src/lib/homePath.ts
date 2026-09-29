/**
 * Where a login lands (owner, 29.09.2026): "agents land on /calls and it must work; managers and
 * admins land on Insights; never a white screen, never an unwanted page."
 *
 * One function decides it for the login, the /start route and every ProtectedRoute bounce, so
 * they can never disagree — and a bounce always goes to a page the user CAN open (the old
 * bounce sent every agent to /assigned, which prediction agents cannot open: /assigned →
 * /assigned → … a white screen).
 */
export interface HomeUser {
  isAdmin?: boolean;
  isManager?: boolean;
  isAgent?: boolean;
  isPendingAgent?: boolean;
  isPredictionAgent?: boolean;
  isInboundAgent?: boolean;
  isWarehouse?: boolean;
  isAdsAdmin?: boolean;
  isAffiliate?: boolean;
  isExternalAffiliate?: boolean;
}

export interface HomeAccess {
  canAccessModule: (key: string) => boolean;
  /** Business owners may open Insights whatever their role permissions say. */
  canSeeBusiness?: boolean;
}

/** Pages a bounce may fall back to, in order, with the module that guards each. */
const FALLBACKS: ReadonlyArray<readonly [string, string]> = [
  ['/calls', 'calls'],
  ['/', 'dashboard'],
  ['/orders', 'orders'],
  ['/warehouse', 'warehouse'],
  ['/webhooks', 'webhooks'],
];

const INSIGHTS_KEYS = ['insights', 'performance', 'agent_activity', 'call_activity'] as const;

/** The page this user should land on; null when there is no page they may open. */
export function homePath(user: HomeUser | null | undefined, access: HomeAccess): string | null {
  if (!user) return '/login';
  const can = access.canAccessModule;
  if (user.isExternalAffiliate) return can('affiliate_portal') ? '/affiliate' : null;
  // Admins and managers (and business owners): the reports first.
  if (user.isAdmin || user.isManager || access.canSeeBusiness) {
    if (INSIGHTS_KEYS.some((k) => can(k)) || access.canSeeBusiness) return '/insights';
    if (can('operations')) return '/operations';
  }
  // Call agents: the calling page.
  if (user.isAgent || user.isPendingAgent || user.isPredictionAgent || user.isInboundAgent) {
    if (can('calls')) return '/calls';
  }
  if (user.isWarehouse && can('warehouse')) return '/warehouse';
  if (user.isAdsAdmin && can('webhooks')) return '/webhooks';
  if (user.isAffiliate && can('affiliate_portal')) return '/affiliate';
  for (const [path, key] of FALLBACKS) if (can(key)) return path;
  return null;
}
