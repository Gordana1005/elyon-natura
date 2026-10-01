import { useTranslation } from 'react-i18next';
import { Copy, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { formatLocalDisplay, telHref, toLocalDial } from '@/lib/callsWork/dial';
import { cn } from '@/lib/utils';

export interface DialPanelProps {
  phone: string;
  /** Phones get a tel: link; md and up the number + a copy button. */
  isMobile: boolean;
  /** PBX_CONFIG.useRealVoip — the softphone dials (the old green button). */
  voip: boolean;
  /** The softphone is idle (VOIP mode only). */
  voipIdle?: boolean;
  /** VOIP mode: start the softphone call. */
  onVoipDial?: () => void;
  /**
   * The agent is about to dial from their own handset (tel: tap / number copied).
   * Return false to stop it (an answer is still owed for another hand-opened client).
   */
  onAttempt: () => boolean;
  className?: string;
}

/**
 * The Call button while VOIP is off (plan Фаза 11): agents dial from their own phones,
 * so the CRM no longer pretends to place the call — the mock engine "answered" every
 * dial after 800 ms and the button was pressed once in a week. On a phone it is a real
 * tel: link in the local form (070 123 456); on a computer the number is shown big with
 * a copy button. Either records the attempt start; the outcome tap logs the call.
 */
export function DialPanel({ phone, isMobile, voip, voipIdle = true, onVoipDial, onAttempt, className }: DialPanelProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const local = toLocalDial(phone);
  const shown = formatLocalDisplay(local) || phone;
  const href = telHref(phone);

  if (voip) {
    if (!voipIdle || !onVoipDial) return null;
    return (
      <Button size="sm" onClick={onVoipDial} className={className}>
        <Phone className="h-3.5 w-3.5" /> {t('callsPage.dialBtn', { phone })}
      </Button>
    );
  }

  if (!href) return null;

  if (isMobile) {
    return (
      <a
        href={href}
        onClick={(e) => { if (!onAttempt()) e.preventDefault(); }}
        className={cn(
          'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-base font-semibold text-white shadow-sm transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
        aria-label={t('callsWork.dial.callNumber', { phone: shown })}
        data-testid="dial-tel"
      >
        <Phone className="h-4 w-4 shrink-0" />
        <span className="truncate tabular-nums">{t('callsWork.dial.callNumber', { phone: shown })}</span>
      </a>
    );
  }

  const copy = async () => {
    if (!onAttempt()) return;
    try {
      await navigator.clipboard.writeText(local);
      toast({ title: t('callsWork.dial.copied'), description: t('callsWork.dial.copiedDesc') });
    } catch {
      toast({ title: t('callsWork.dial.copyFailed'), description: shown, variant: 'destructive' });
    }
  };

  return (
    // The number is never cut: in a narrow column the copy button wraps under it.
    <div className={cn('flex min-w-0 flex-wrap items-center gap-2', className)} data-testid="dial-desktop">
      <span className="flex shrink-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 py-1">
        <Phone className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
        <span className="select-all whitespace-nowrap font-mono text-lg font-semibold tabular-nums" title={t('callsWork.dial.fromHandset')}>
          {shown}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={() => { void copy(); }} className="shrink-0 gap-1.5">
        <Copy className="h-3.5 w-3.5" /> {t('callsWork.dial.copy')}
      </Button>
    </div>
  );
}
