import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Loader2, Phone, PhoneIncoming, PhoneOff, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useVoip } from '@/contexts/VoipContext';
import { useCustomerIntelligence } from '@/hooks/useCustomerIntelligence';
import { prettyMkPhone } from '@/lib/voip/inboundIdentity';
import { formatSkopje } from '@/lib/skopjeTime';

/**
 * The inbound Teleshop call ringing this browser (05.11.2026) — rendered by AppLayout on EVERY page, so the
 * operator sees "Ѕвони · 02 512 8888 · <caller>" wherever they are, with the customer's name and last order,
 * and answers (Прими → the call opens on /calls with the caller's number) or declines (Одбиј → the queue rings
 * the other free operators). Nothing while idle. Phone: a bottom sheet; desktop: a card bottom-right.
 */
export function IncomingCallPanel() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, incoming, answerIncoming, rejectIncoming, ringtoneBlocked } = useVoip();
  const active = state === 'incoming' && incoming ? incoming : null;
  const { data: intel, loading } = useCustomerIntelligence(active?.phone ?? '');
  const [busy, setBusy] = useState<'answer' | 'reject' | null>(null);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) { setSeconds(0); setBusy(null); return; }
    const since = active.received_at;
    setSeconds(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    const id = window.setInterval(() => setSeconds(Math.max(0, Math.floor((Date.now() - since) / 1000))), 1000);
    return () => window.clearInterval(id);
  }, [active]);

  if (!active) return null;
  const phone = active.phone;

  const onAnswer = async () => {
    setBusy('answer');
    try {
      await answerIncoming();
      navigate(`/calls?phone=${encodeURIComponent(phone)}`);
    } catch {
      /* the context toasted; the line is free again */
    } finally {
      setBusy(null);
    }
  };
  const onReject = async () => {
    setBusy('reject');
    try { await rejectIncoming(); } finally { setBusy(null); }
  };

  const last = intel?.last_order;
  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label={t('incomingCall.title')}
      className={cn(
        'fixed z-[70] overflow-hidden rounded-2xl border border-[hsl(var(--success))]/50 bg-card shadow-xl',
        'inset-x-2 bottom-2 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-[22rem]',
        'animate-in fade-in-0 slide-in-from-bottom-2 duration-200',
      )}
    >
      <div className="flex items-start gap-3 px-4 pt-4">
        <span className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--success))]/15 text-[hsl(var(--success))]">
          <span className="absolute inset-0 animate-ping rounded-full bg-[hsl(var(--success))]/30" />
          <PhoneIncoming className="relative h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[hsl(var(--success))]">
            {t('incomingCall.title')}{active.did_pretty ? ` · ${active.did_pretty}` : ''}
          </div>
          <div className="truncate font-mono text-lg font-bold tabular-nums text-card-foreground">{prettyMkPhone(phone) || t('incomingCall.unknownCaller')}</div>
          <div className="mt-0.5 min-h-[1.25rem] text-sm">
            {loading && !intel ? (
              <span className="inline-block h-3.5 w-32 animate-pulse rounded bg-muted" />
            ) : intel?.found && intel.customer_name ? (
              <span className="font-medium text-card-foreground">{intel.customer_name}</span>
            ) : (
              <span className="text-muted-foreground">{t('incomingCall.unknownCaller')}</span>
            )}
          </div>
          {last ? (
            <div className="mt-0.5 truncate text-xs text-muted-foreground" title={`${last.display_id} · ${last.product}`}>
              {t('incomingCall.lastOrder')}: #{last.display_id} · {last.product}
              {last.status ? ` · ${t(`status.${last.status}`, { defaultValue: last.status })}` : ''}
              {last.date ? ` · ${formatSkopje(last.date, 'dd/MM/yy')}` : ''}
            </div>
          ) : intel && intel.found === false ? (
            <div className="mt-0.5 text-xs text-muted-foreground">{t('incomingCall.noHistory')}</div>
          ) : null}
        </div>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{t('incomingCall.ringingFor', { s: seconds })}</span>
      </div>
      {ringtoneBlocked && (
        <div className="mx-4 mt-2 flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <VolumeX className="h-3.5 w-3.5 shrink-0" /> {t('incomingCall.soundBlocked')}
        </div>
      )}
      <div className="flex gap-2 p-4 pt-3">
        <Button
          className="h-11 flex-1 gap-2 bg-[hsl(var(--success))] text-white hover:bg-[hsl(var(--success))]/90"
          onClick={() => void onAnswer()}
          disabled={busy !== null}
        >
          {busy === 'answer' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Phone className="h-4 w-4" />} {t('incomingCall.accept')}
        </Button>
        <Button
          variant="outline"
          className="h-11 flex-1 gap-2 text-destructive hover:text-destructive"
          onClick={() => void onReject()}
          disabled={busy !== null}
        >
          {busy === 'reject' ? <Loader2 className="h-4 w-4 animate-spin" /> : <PhoneOff className="h-4 w-4" />} {t('incomingCall.reject')}
        </Button>
      </div>
    </div>
  );
}
