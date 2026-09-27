import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';

interface ProtectedRouteProps {
  children: React.ReactNode;
  /** Module key for permission check */
  moduleKey?: string;
  /** Extra module keys that also grant access (any-of). Used by pages that
   *  merged in other modules' content (e.g. Insights hosts Performance +
   *  Agent Activity), so users with only those keys keep their access. */
  moduleKeysAny?: string[];
  /** Business owners (owner ruling 2026-09-27 — see useInsightsAccess) may open
   *  the page whatever their role permissions say, as long as the module
   *  itself is switched on. Owners see the sidebar link from canSeeBusiness,
   *  so without this the link could bounce them straight back out. */
  allowBusinessOwner?: boolean;
}

export function ProtectedRoute({ children, moduleKey, moduleKeysAny, allowBusinessOwner }: ProtectedRouteProps) {
  const { session, user, loading } = useAuth();
  const { canAccessModule, canSeeBusiness, isModuleEnabled, loading: permLoading } = usePermissions();

  if (loading || permLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  // Check module-level access (enabled + role permission)
  if (moduleKey && user) {
    const hasAccess = canAccessModule(moduleKey) ||
      (moduleKeysAny?.some(k => canAccessModule(k)) ?? false) ||
      (!!allowBusinessOwner && canSeeBusiness && isModuleEnabled(moduleKey));
    if (!hasAccess) {
      // Find a module the user CAN access for redirect
      if (user.isPendingAgent || user.isPredictionAgent || user.isAgent) {
        return <Navigate to="/assigned" replace />;
      }
      // Affiliates land on their portal — without this branch an affiliate
      // hitting "/" would bounce to "/" forever (infinite redirect).
      if (user.isAffiliate) {
        return <Navigate to="/affiliate" replace />;
      }
      if (user.isWarehouse) {
        return <Navigate to="/warehouse" replace />;
      }
      if (user.isAdsAdmin) {
        return <Navigate to="/ads" replace />;
      }
      return <Navigate to="/" replace />;
    }
  }

  return <>{children}</>;
}
