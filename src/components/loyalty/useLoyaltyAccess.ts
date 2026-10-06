import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';

/**
 * Who may open /loyalty. The same circle as /shops — owners (can_see_revenue), admins and
 * managers, never an agent and never an external affiliate — with one difference the api
 * keeps: managers see the point numbers. There is no redemption here. The sidebar and the
 * page read this one hook. UX only — the api enforces it.
 */
export function useLoyaltyAccess() {
  const { user } = useAuth();
  const { canSeeBusiness } = usePermissions();
  const external = !!user?.isExternalAffiliate;
  const owner = canSeeBusiness && !external;
  const staff = !external && !!(user?.isAdmin || user?.isManager);
  return { any: owner || staff };
}
