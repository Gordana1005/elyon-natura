import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { Session, User } from '@supabase/supabase-js';
import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, type AppLanguage } from '@/i18n';

export type AppRole = 'admin' | 'manager' | 'pending_agent' | 'prediction_agent' | 'warehouse' | 'ads_admin' | 'agent' | 'inbound_agent' | 'affiliate';

export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  roles: AppRole[];
  isAdmin: boolean;
  isManager: boolean;
  isPendingAgent: boolean;
  isPredictionAgent: boolean;
  isWarehouse: boolean;
  isAdsAdmin: boolean;
  isAgent: boolean;
  isInboundAgent: boolean;
  /** External partner (webmaster) — sees only the affiliate portal. */
  isAffiliate: boolean;
  /** Affiliate with NO internal role — a pure external partner. Mirrors the
   *  server's hard wall (api/index.ts `hasInternalRole`): may touch only the
   *  portal. A hybrid affiliate+staff login is NOT external. */
  isExternalAffiliate: boolean;
  /** Primary role for display purposes */
  role: AppRole;
  /** UI language preference from profiles.language; undefined until migration applied */
  language?: AppLanguage;
}

interface AuthContextType {
  session: Session | null;
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function determinePrimaryRole(roles: AppRole[]): AppRole {
  if (roles.includes('admin')) return 'admin';
  if (roles.includes('manager')) return 'manager';
  if (roles.includes('affiliate')) return 'affiliate';
  if (roles.includes('prediction_agent')) return 'prediction_agent';
  if (roles.includes('pending_agent')) return 'pending_agent';
  if (roles.includes('agent')) return 'agent';
  if (roles.includes('inbound_agent')) return 'inbound_agent';
  if (roles.includes('warehouse')) return 'warehouse';
  if (roles.includes('ads_admin')) return 'ads_admin';
  return 'pending_agent';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = async (supabaseUser: User) => {
    try {
      const { data: initialProfile, error: profileError } = await supabase
        .from('profiles')
        .select('full_name, email, language')
        .eq('user_id', supabaseUser.id)
        .single();
      let profile = initialProfile;
      if (profileError) {
        // profiles.language may not exist yet (migration not applied) —
        // retry without it so login never breaks on a stale schema.
        const { data: fallback } = await supabase
          .from('profiles')
          .select('full_name, email')
          .eq('user_id', supabaseUser.id)
          .single();
        profile = fallback ? { ...fallback, language: DEFAULT_LANGUAGE } : null;
      }

      const { data: roleRows } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', supabaseUser.id);

      const roles: AppRole[] = (roleRows || []).map(r => r.role as AppRole);
      if (roles.length === 0) roles.push('pending_agent');

      setUser({
        id: supabaseUser.id,
        email: profile?.email || supabaseUser.email || '',
        full_name: profile?.full_name || supabaseUser.email || '',
        roles,
        isAdmin: roles.includes('admin'),
        isManager: roles.includes('manager'),
        isPendingAgent: roles.includes('pending_agent'),
        isPredictionAgent: roles.includes('prediction_agent'),
        isAgent: roles.includes('agent') || roles.includes('pending_agent') || roles.includes('prediction_agent') || roles.includes('inbound_agent'),
        isWarehouse: roles.includes('warehouse'),
        isAdsAdmin: roles.includes('ads_admin'),
        isInboundAgent: roles.includes('inbound_agent'),
        isAffiliate: roles.includes('affiliate'),
        isExternalAffiliate: roles.length > 0 && roles.every(r => r === 'affiliate'),
        role: determinePrimaryRole(roles),
        // Validate against SUPPORTED_LANGUAGES — never hardcode the language
        // list here. It was pinned to bg|en until 2026-07-22, which silently
        // coerced Albanian users back to English on every fresh device.
        language: SUPPORTED_LANGUAGES.includes(profile?.language as AppLanguage)
          ? (profile!.language as AppLanguage)
          : DEFAULT_LANGUAGE,
      });
    } catch {
      setUser(null);
    }
  };

  useEffect(() => {
    let mounted = true;
    
    const timeout = setTimeout(() => {
      if (mounted && loading) {
        console.warn('Auth loading timeout - forcing load complete');
        setLoading(false);
      }
    }, 5000);

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        if (!mounted) return;
        setSession(newSession);
        if (newSession?.user) {
          fetchProfile(newSession.user).finally(() => {
            if (mounted) setLoading(false);
          });
        } else {
          setUser(null);
          setLoading(false);
        }
      }
    );

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (!mounted) return;
      setSession(s);
      if (s?.user) {
        fetchProfile(s.user).finally(() => {
          if (mounted) setLoading(false);
        });
      } else {
        setLoading(false);
      }
    }).catch(() => {
      if (mounted) setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(timeout);
      subscription.unsubscribe();
    };
  }, []);

  // Presence heartbeat — while a session is active, ping the server every
  // 45s so agents/online can show real "here right now" status. Only fires
  // when the tab is visible, so a backgrounded/forgotten tab naturally
  // ages out of "online" after the server's 2-minute window — EXCEPT while
  // the softphone is live: a call keeps the beat (and voip_state) fresh even
  // if the agent backgrounds the tab mid-call. The state is included only
  // when non-idle so a second idle tab never overwrites the calling tab's
  // reported state ('idle' is written solely by VoipContext on call end).
  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;

    const ping = async () => {
      try {
        const { getBusCallState } = await import('@/lib/voip/callStateBus');
        const voipState = getBusCallState();
        if (document.visibilityState !== 'visible' && voipState === 'idle') return;
        const { apiPresenceHeartbeat } = await import('@/lib/api');
        if (!cancelled) {
          await apiPresenceHeartbeat(voipState !== 'idle' ? { voip_state: voipState } : undefined);
        }
      } catch {
        // Non-critical — next tick retries.
      }
    };

    void ping(); // immediate beat on login / load
    const interval = setInterval(ping, 45_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void ping(); };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session?.user?.id]);

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signOut = async () => {
    // Log shift logout before signing out
    try {
      const { apiLogShiftLogout } = await import('@/lib/api');
      await apiLogShiftLogout();
    } catch {
      // Non-critical
    }
    await supabase.auth.signOut();
    setSession(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ session, user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
