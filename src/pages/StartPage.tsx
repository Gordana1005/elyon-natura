import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { homePath } from '@/lib/homePath';
import { NoAccessScreen } from '@/components/NoAccessScreen';

const Spinner = () => (
  <div className="flex h-screen items-center justify-center bg-background">
    <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
  </div>
);

/**
 * /start — where the login sends everyone (owner, 29.09.2026): waits until the session, the
 * profile (roles) AND this login's permissions are loaded, then lands agents on /calls and
 * admins / managers on /insights (homePath). Never guesses before they are in.
 *
 * Right after sign-in the session exists while the profile is still loading (AuthContext keeps
 * `loading` false during that fetch), so a missing user with a session means WAIT, not "log in
 * again"; only a profile that never arrives (8 s) ends on the no-access screen (sign out there).
 */
export default function StartPage() {
  const { session, user, loading } = useAuth();
  const { canAccessModule, canSeeBusiness, loading: permLoading } = usePermissions();
  const [gaveUp, setGaveUp] = useState(false);
  const waitingForProfile = !!session && !user;

  useEffect(() => {
    if (!waitingForProfile) return;
    const id = setTimeout(() => setGaveUp(true), 8000);
    return () => clearTimeout(id);
  }, [waitingForProfile]);

  if (loading) return <Spinner />;
  if (!session) return <Navigate to="/login" replace />;
  if (!user) return gaveUp ? <NoAccessScreen /> : <Spinner />;
  if (permLoading) return <Spinner />;
  const home = homePath(user, { canAccessModule, canSeeBusiness });
  return home ? <Navigate to={home} replace /> : <NoAccessScreen />;
}
