import { Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDate } from '@/i18n/dates';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { apiLookupPersonalHold } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface Props {
  phone: string;
  /** Render compact (only icon + name) instead of the full pill. */
  compact?: boolean;
  className?: string;
}

/**
 * Lock badge shown on customer cards / order rows. Three states:
 * - mine (green): I claimed this customer.
 * - theirs (amber): another agent claimed this customer; I see their name + reason.
 * - none: nothing rendered.
 */
export function PersonalHoldBadge({ phone, compact, className }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { data: hold } = useQuery({
    queryKey: ['personal-hold', phone],
    queryFn: () => apiLookupPersonalHold(phone),
    enabled: !!phone && phone.replace(/\D/g, '').length >= 6,
    staleTime: 30_000,
  });

  if (!hold) return null;
  const mine = hold.agent_id === user?.id;
  const expiresLabel = hold.expires_at ? formatDate(hold.expires_at, 'd MMM') : '';

  const tone = mine
    ? 'bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200'
    : 'bg-amber-50 text-amber-800 ring-1 ring-amber-200';

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium cursor-help',
            tone,
            className,
          )}>
            <Lock className="h-3 w-3" />
            {mine
              ? (compact ? t('personalList.mine') : t('personalList.inYourList', { date: expiresLabel }))
              : (compact ? hold.agent_name : t('personalList.otherExpires', { name: hold.agent_name, date: expiresLabel }))}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[320px] text-[11px]">
          <div className="font-semibold">{mine ? t('personalList.heldByYou') : t('personalList.heldBy', { name: hold.agent_name })}</div>
          <div className="opacity-80 mt-1 whitespace-pre-wrap">{hold.reason}</div>
          {hold.follow_up_by && (
            <div className="opacity-60 mt-1">{t('personalList.followUpBy', { date: formatDate(hold.follow_up_by, 'd MMM yyyy') })}</div>
          )}
          <div className="opacity-60 mt-1">
            {t('personalList.expiresAt', { date: hold.expires_at ? formatDate(hold.expires_at, 'd MMM yyyy HH:mm') : '—' })}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
