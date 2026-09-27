import { useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { acquirePresence, releasePresence } from '@/lib/presence/tracker';

/**
 * Presence tracking for the signed-in staff member — time on the CRM and the
 * 30-minute idle alert (migration 20260935000200, owner ask 2026-09-27).
 *
 * Mounted by AppLayout, i.e. only on pages with the staff chrome: the login
 * page and the public TV board never run it. External affiliate (partner)
 * logins are never tracked — the server would refuse them anyway (the api
 * hard wall and presence_heartbeat's staff check). Signed out → no beats.
 *
 * The work itself lives in the module-level tracker, so the per-page remount
 * of AppLayout does not restart the idle clock or double the beats.
 */
export function usePresenceTracking(): void {
  const { user, session } = useAuth();
  const uid = user && session && !user.isExternalAffiliate ? user.id : null;

  useEffect(() => {
    if (!uid) return;
    acquirePresence(uid);
    return () => releasePresence(uid);
  }, [uid]);
}
