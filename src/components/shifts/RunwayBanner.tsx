import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarCheck, CalendarPlus, OctagonAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatDmy } from '@/components/insights/shared/period';
import type { RunwaySummary } from '@/lib/shiftsApi';

const SHOW_NAMES = 6;

/**
 * The manager's early warning (owner 30.09: 5 days before the roster runs out). Without a shift
 * the login gate refuses an agent, so this is the one line that must never be missed:
 * warn = amber, critical (someone is locked out today or tomorrow) = red, ok = a quiet caption.
 * Always a word + an icon, never colour alone.
 */
export function RunwayBanner({ runway, failed, onRoll }: {
  runway: RunwaySummary | undefined;
  failed: boolean;
  onRoll: () => void;
}) {
  const { t } = useTranslation();
  const rollButton = (variant: 'default' | 'outline') => (
    <Button type="button" size="sm" variant={variant} onClick={onRoll} className="h-9 shrink-0">
      <CalendarPlus className="h-4 w-4" aria-hidden /> {t('shiftsPage.runway.roll')}
    </Button>
  );

  if (failed) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm">
        <span className="inline-flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" aria-hidden />{t('shiftsPage.runway.failed')}</span>
        {rollButton('outline')}
      </div>
    );
  }
  if (!runway) return null;

  if (runway.level === 'ok') {
    return (
      <div data-testid="runway-ok" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2 shadow-sm">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarCheck className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
          {runway.ends_on ? t('shiftsPage.runway.ok', { date: formatDmy(runway.ends_on) }) : null}
        </span>
        {rollButton('outline')}
      </div>
    );
  }

  const critical = runway.level === 'critical';
  const agents = t('shiftsPage.runway.agents', { count: runway.count });
  const text = runway.days_left === 0 || !runway.ends_on
    ? t('shiftsPage.runway.today', { agents })
    : t('shiftsPage.runway.warn', {
      date: formatDmy(runway.ends_on),
      inDays: t('shiftsPage.runway.inDays', { count: runway.days_left ?? 0 }),
      agents,
    });
  const names = runway.people.slice(0, SHOW_NAMES).map((p) => p.name).join(', ');
  const more = runway.people.length - SHOW_NAMES;
  const Icon = critical ? OctagonAlert : AlertTriangle;

  return (
    <div role="alert" data-testid="runway-banner"
      className={cn(
        'flex flex-col gap-2 rounded-xl border px-3 py-2.5 shadow-sm sm:flex-row sm:items-center sm:justify-between',
        critical
          ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100'
          : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100',
      )}>
      <div className="flex min-w-0 items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium leading-snug">{text}</p>
          {names && (
            <p className="break-words text-xs opacity-90">
              {t('shiftsPage.runway.who', { names })}{more > 0 ? ` ${t('shiftsPage.runway.more', { n: more })}` : ''}
            </p>
          )}
        </div>
      </div>
      {rollButton('default')}
    </div>
  );
}
