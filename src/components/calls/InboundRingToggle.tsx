import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MonitorSmartphone, Tv } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiGetInboundRingMe, apiSetInboundRingSelf } from '@/lib/api';
import { useVoip } from '@/contexts/VoipContext';
import { PBX_CONFIG } from '@/lib/voip/pbxConfig';
import { cn } from '@/lib/utils';

export const INBOUND_RING_ME_KEY = ['inbound-ring-me'];

/**
 * Teleshop In on /calls (05.11.2026): the operators who always ring see a quiet chip "ТВ повици: активно";
 * the managers who help by hand (mode 'manual') get the button "Примам ТВ повици: ВКЛ / ИСКЛ" — the PBX picks
 * the change up within 30 s. Everyone else sees nothing. The switch goes off by itself at 21:05.
 */
export function InboundRingToggle({ compact }: { compact?: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: INBOUND_RING_ME_KEY, queryFn: apiGetInboundRingMe, enabled: PBX_CONFIG.useRealVoip, staleTime: 60_000 });
  const flip = useMutation({
    mutationFn: (on: boolean) => apiSetInboundRingSelf(on),
    onSuccess: (r) => {
      qc.setQueryData(INBOUND_RING_ME_KEY, (old: any) => ({ ...(old ?? {}), mode: r.mode, manual_on: r.manual_on }));
      toast({ title: r.manual_on ? t('inboundRing.toggleOn') : t('inboundRing.toggleOff'), description: t('inboundRing.appliesSoon') });
    },
    onError: (e) => toast({ title: t('inboundRing.failed'), description: apiErrorText(e), variant: 'destructive' }),
  });

  const { otherTab } = useVoip();
  if (!PBX_CONFIG.useRealVoip) return null;

  // the phone line is held by another tab of this login — that tab rings and dials, this one does not
  if (otherTab) {
    return (
      <Badge variant="outline" className="h-8 shrink-0 gap-1.5 rounded-md px-2 text-xs font-normal text-muted-foreground" title={t('inboundRing.otherTab')}>
        <MonitorSmartphone className="h-3.5 w-3.5" />{compact ? '' : t('inboundRing.otherTab')}
      </Badge>
    );
  }
  if (!me.data || me.data.mode === 'off') return null;

  if (me.data.mode === 'always') {
    return (
      <Badge
        variant="outline"
        className="h-8 shrink-0 gap-1.5 rounded-md border-[hsl(var(--success))]/40 px-2 text-xs font-medium text-[hsl(var(--success))]"
        title={t('inboundRing.chipAlwaysTitle')}
      >
        <Tv className="h-3.5 w-3.5" />{compact ? t('inboundRing.chipShort') : t('inboundRing.chipAlways')}
      </Badge>
    );
  }

  const on = me.data.manual_on;
  return (
    <Button
      size="sm"
      variant={on ? 'default' : 'outline'}
      className={cn('h-8 shrink-0 gap-1.5 text-xs', on && 'bg-amber-500 text-white hover:bg-amber-600')}
      onClick={() => flip.mutate(!on)}
      disabled={flip.isPending}
      title={t('inboundRing.toggleTitle')}
      aria-pressed={on}
    >
      {flip.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Tv className="h-3.5 w-3.5" />}
      {compact ? (on ? t('inboundRing.on') : t('inboundRing.off')) : (on ? t('inboundRing.toggleOn') : t('inboundRing.toggleOff'))}
    </Button>
  );
}
