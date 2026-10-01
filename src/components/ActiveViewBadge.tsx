import { Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { apiLookupActiveView } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatSkopje } from '@/lib/skopjeTime';

interface Props {
  phone: string;
  className?: string;
}

/**
 * Live "currently being viewed by …" badge for ONE customer (the /calls
 * profile card). The lookup returns live views only (expires_at in the
 * future; the cron sweeps the rest). Hidden when nobody is viewing or when the
 * viewer is the current user (their PersonalListButton already shows that).
 * A list asks for a whole page at once instead (useActiveViews + ActiveViewChip).
 */
export function ActiveViewBadge({ phone, className }: Props) {
  const { user } = useAuth();
  const { data: view } = useQuery({
    queryKey: ['active-view-lookup', phone],
    queryFn: () => apiLookupActiveView(phone),
    enabled: !!phone && phone.replace(/\D/g, '').length >= 6,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });

  if (!view || view.agent_id === user?.id) return null;
  return <ActiveViewChip view={view} className={className} />;
}

/** The chip itself — "Кај X" with the time it was opened. */
export function ActiveViewChip({ view, className }: { view: { agent_name: string | null; opened_at: string }; className?: string }) {
  const { t } = useTranslation();
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium cursor-help',
            'bg-blue-50 text-blue-800 ring-1 ring-blue-200 dark:bg-blue-500/15 dark:text-blue-200 dark:ring-blue-500/30',
            className,
          )}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 motion-safe:animate-pulse" />
            <Eye className="h-3 w-3 shrink-0" />
            <span className="truncate">{t('activeView.onCustomer', { name: view.agent_name ?? '' })}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-[11px]">
          <div className="font-semibold">{view.agent_name}</div>
          <div className="opacity-70">{t('activeView.openedAt', { time: formatSkopje(view.opened_at, 'HH:mm:ss') })}</div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
