import { Navigate, useLocation } from 'react-router-dom';
import { homePath } from '@/lib/homePath';
import { NoAccessScreen } from '@/components/NoAccessScreen';
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
  const location = useLocation();

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
      // Bounce to this login's own home (homePath: agents /calls, admins / managers /insights,
      // warehouse /warehouse …) — always a page it CAN open. Never to the page we are on: that
      // loop renders nothing (the white screen of 29.09.2026, when every agent was sent to
      // /assigned, which prediction agents cannot open).
      const home = homePath(user, { canAccessModule, canSeeBusiness });
      if (home && home !== location.pathname) return <Navigate to={home} replace />;
      return <NoAccessScreen />;
    }
  }

  return <>{children}</>;
}
