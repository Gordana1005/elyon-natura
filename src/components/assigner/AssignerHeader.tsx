import { useTranslation } from 'react-i18next';
import { AlertTriangle, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ASSIGNER_DEPARTMENTS } from '@/lib/assignerApi';
import { Chip, DeptDash, LABEL, deptName } from './parts';

/**
 * The page header: the department chips (Сите + the six, multi-select — the
 * Overview FilterBar's look) and the live indicator. The page title itself is
 * the layout's ("Распределувач").
 */
export function AssignerHeader({
  departments, onDepartmentsChange, updatedAt, now, fetching, failed,
}: {
  departments: string[];
  onDepartmentsChange: (next: string[]) => void;
  /** When the board last arrived (ms), 0 = never. */
  updatedAt: number;
  now: number;
  fetching: boolean;
  failed: boolean;
}) {
  const { t } = useTranslation();
  const toggle = (d: string) =>
    onDepartmentsChange(
      departments.includes(d)
        ? departments.filter((x) => x !== d)
        : ASSIGNER_DEPARTMENTS.filter((x) => x === d || departments.includes(x)),
    );

  return (
    <div className="rounded-xl border bg-card/80 px-3 py-2 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {/* One row that scrolls sideways (scrollbar hidden) on a phone; wraps from sm up. */}
        <div role="group" aria-label={t('assigner.header.departments')} data-hscroll
          className="-mx-1 flex min-w-0 max-w-full flex-nowrap items-center gap-1.5 overflow-x-auto px-1 py-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
          <span className={cn(LABEL, 'mr-0.5')}>{t('assigner.header.departments')}</span>
          <Chip on={departments.length === 0} onClick={() => onDepartmentsChange([])}>
            {t('assigner.header.allDepartments')}
          </Chip>
          {ASSIGNER_DEPARTMENTS.map((d) => (
            <Chip key={d} on={departments.includes(d)} onClick={() => toggle(d)}>
              <DeptDash dept={d} />
              {deptName(t, d)}
            </Chip>
          ))}
        </div>
        <LiveIndicator updatedAt={updatedAt} now={now} fetching={fetching} failed={failed} />
      </div>
    </div>
  );
}

export function LiveIndicator({ updatedAt, now, fetching, failed }: { updatedAt: number; now: number; fetching: boolean; failed: boolean }) {
  const { t } = useTranslation();
  const secs = updatedAt > 0 ? Math.max(0, Math.round((now - updatedAt) / 1000)) : null;
  const ago = secs == null ? '' : secs < 60
    ? t('assigner.live.secondsAgo', { n: secs })
    : t('assigner.live.minutesAgo', { n: Math.floor(secs / 60) });
  if (failed) {
    return (
      <span role="status" className="inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t('assigner.live.offline')}{ago && ` · ${t('assigner.live.refreshed', { ago })}`}</span>
      </span>
    );
  }
  return (
    <span role="status" aria-live="off" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="relative flex h-2 w-2" aria-hidden>
        <span className={cn('absolute inline-flex h-full w-full rounded-full bg-emerald-500/60', fetching && 'motion-safe:animate-ping')} />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
      </span>
      <Radio className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
      <span className="font-medium text-foreground">{t('assigner.live.label')}</span>
      {ago && <span className="tabular-nums">· {t('assigner.live.refreshed', { ago })}</span>}
    </span>
  );
}
