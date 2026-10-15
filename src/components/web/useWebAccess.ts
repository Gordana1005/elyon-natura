import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';

/**
 * Who may open /web (owner 15.10.2026): company-wide revenue (can_see_revenue — super_admin,
 * owner, finance, administrator) with the module `web`; the Meta spend, ROAS and the profit only
 * with can_see_margins. The sidebar and the page read this one hook. UX only — the api enforces it.
 */
export function useWebAccess() {
  const { user } = useAuth();
  const { canSeeBusiness, canSeeMargins, canAccessModule } = usePermissions();
  const external = !!user?.isExternalAffiliate;
  const any = !external && canSeeBusiness && canAccessModule('web');
  return { any, margins: any && canSeeMargins };
}
