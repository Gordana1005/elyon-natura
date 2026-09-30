import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { apiCheckShiftLogin, apiLogShiftLogin } from '@/lib/api';
import type { ShiftLoginCheck } from '@/lib/shiftsApi';
import { shiftRefusalText } from '@/components/shifts/loginRefusal';
import { Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// TODO(macedonia): final login domain — must match the admin emails seeded in
// scripts/create-admin-users.mjs (Phase 3). Placeholder for now.
const EMAIL_DOMAIN = 'elyon-mk.local';

export default function LoginPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { signIn } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const loginEmail = email.includes('@') ? email : `${email}@${EMAIL_DOMAIN}`;
      await signIn(loginEmail, password);

      // Check shift restrictions after successful auth (the login gate — no shift covering
      // "now" = no login for anyone but admins / managers).
      try {
        const shiftCheck: ShiftLoginCheck = await apiCheckShiftLogin();
        if (!shiftCheck.allowed) {
          // Sign the user out since they can't use the system
          const { supabase } = await import('@/integrations/supabase/client');
          await supabase.auth.signOut();
          setError(shiftRefusalText(t, shiftCheck));
          setLoading(false);
          return;
        }

        // The api logs the login itself since 01.10.2026 (`logged: true`). Only an older api
        // (no `logged` in the answer) still needs the browser to write it.
        if (!shiftCheck.bypass && shiftCheck.shift_id && shiftCheck.logged === undefined) {
          try {
            await apiLogShiftLogin({
              shift_id: shiftCheck.shift_id,
              shift_date: shiftCheck.shift_date ?? '',
              shift_start_time: shiftCheck.shift_start_time ?? '',
              shift_end_time: shiftCheck.shift_end_time ?? '',
            });
          } catch {
            // Non-critical, don't block login
          }
        }
      } catch {
        // If shift check fails (e.g. network), allow login to proceed
      }

      // /start waits for this login's permissions, then picks its home (agents /calls,
      // admins / managers /insights) — src/lib/homePath.ts.
      navigate('/start', { replace: true });
    } catch (err: any) {
      setError(err.message || t('login.invalidCredentials'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="dark flex min-h-screen items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm space-y-6 rounded-xl border border-zinc-800 bg-zinc-900 p-8 shadow-2xl">
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
            <Phone className="h-6 w-6 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-bold text-zinc-100">Elyon CRM</h1>
          <p className="text-sm text-zinc-400">{t('login.signInToAccount')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-zinc-200">{t('login.username')}</Label>
            <Input
              id="email"
              type="text"
              placeholder={t('login.usernamePlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="username"
              className="border-zinc-700 bg-zinc-800 text-zinc-100 placeholder:text-zinc-500 focus-visible:ring-zinc-500"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-zinc-200">{t('login.password')}</Label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="border-zinc-700 bg-zinc-800 text-zinc-100 placeholder:text-zinc-500 focus-visible:ring-zinc-500"
            />
          </div>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t('login.signingIn') : t('login.signIn')}
          </Button>
        </form>
      </div>
    </div>
  );
}
