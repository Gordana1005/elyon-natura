import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';

/**
 * Who may open /shops (docs/SHOPS.md): owners (is_business_owner() — the owners list and every
 * active admin) see everything; managers (and any admin) the same pages without money; everyone
 * else is refused by the api, so the menu item and the page stay hidden for them. The sidebar and
 * the page read this one hook, so the two can never disagree. UX only — the api enforces it.
 *
 *   any     the page and its menu item
 *   owner   money is expected (the page still renders a figure only when its key arrives)
 *   health  the Здравје tab: the reader, the backfill and the anomalies (owners / admins)
 */
export function useShopsAccess() {
  const { user } = useAuth();
  const { canSeeBusiness } = usePermissions();
  const external = !!user?.isExternalAffiliate;
  const owner = canSeeBusiness && !external;
  const staff = !external && !!(user?.isAdmin || user?.isManager);
  return { any: owner || staff, owner, health: owner || (!external && !!user?.isAdmin) };
}
