import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { apiGetVoipHealth } from '@/lib/api';
import { PBX_CONFIG } from '@/lib/voip/pbxConfig';

/**
 * Superadmin-only telephony alert bar. Reads incidents[] from the same
 * /voip/health query the dashboard uses (shared cache — no duplicate fetch),
 * and surfaces a red/amber strip when something is wrong with the phone system
 * (trunk down, disk filling, recordings stopped, attack, one-way audio). Quiet
 * when everything is healthy. Links to the full VOIP Health page.
 */
const DISMISS_KEY = 'voip-banner-dismissed-sig';

export function VoipIncidentBanner() {
  const { t } = useTranslation();
  const { user } = useAuth();
  // Persisted dismissal, keyed to the current incident set. Dismissing keeps the
  // strip hidden across reloads for the SAME issues; a new/different incident
  // (e.g. trunk down) changes the signature and surfaces the banner again.
  const [dismissedSig, setDismissedSig] = useState<string>(() => {
    try { return localStorage.getItem(DISMISS_KEY) || ''; } catch { return ''; }
  });

  const { data } = useQuery({
    queryKey: ['voip-health'],
    queryFn: apiGetVoipHealth,
    // Telephony is deferred on MK (VITE_USE_REAL_VOIP=false): no PBX to watch, so no polling —
    // it was 18.7k calls in 61 days to an endpoint that answers 500 (owner audit 30.09.2026).
    enabled: !!user?.isAdmin && PBX_CONFIG.useRealVoip,
    refetchInterval: 60000,
    staleTime: 30000,
  });

  if (!user?.isAdmin || !PBX_CONFIG.useRealVoip) return null;
  const incidents = data?.incidents || [];
  if (incidents.length === 0) return null;

  const sig = JSON.stringify([...new Set(incidents.map((i) => i.code || i.message))].sort());
  if (sig === dismissedSig) return null;
  const dismiss = () => { try { localStorage.setItem(DISMISS_KEY, sig); } catch { /* ignore */ } setDismissedSig(sig); };

  const hasCritical = incidents.some((i) => i.level === 'critical');
  const lead = incidents.find((i) => i.level === 'critical') || incidents[0];
  const more = incidents.length - 1;

  return (
    <div
      className={`flex items-center gap-2 px-4 py-2 text-sm ${
        hasCritical ? 'bg-destructive text-destructive-foreground' : 'bg-amber-500 text-white'
      }`}
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <Link to="/voip-health" className="flex-1 min-w-0 truncate font-medium hover:underline">
        {lead.message}
        {more > 0 && <span className="ml-1 opacity-90">{t('voipHealth.banner.more', { count: more })}</span>}
      </Link>
      <Link to="/voip-health" className="shrink-0 rounded px-2 py-0.5 text-xs font-semibold underline-offset-2 hover:underline">
        {t('voipHealth.banner.view')}
      </Link>
      <button onClick={dismiss} aria-label={t('common.dismiss')} className="shrink-0 rounded p-0.5 hover:bg-black/10">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
