import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, FileWarning, Inbox, UserX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadError } from '@/components/insights/shared/LoadError';
import { formatDmy } from '@/components/insights/shared/period';
import { addDaysYmd } from '@/lib/shiftsApi';
import { LEAVE_LETTER, apiHrCalendar, dueWithin, type HrEmployee, type LeaveType } from '@/lib/hrApi';
import { ABSENCE_TILE, PENDING_TILE, rangeText, typeLabel } from './labels';
import { groupKey, groupLabel } from './groups';

/**
 * Преглед — who is away today and in the next two weeks (approved; waiting dashed), how many
 * requests wait for the viewer, and (dossier viewers) contracts / probation ending within 30 days.
 */
export function OverviewTab({ today, openCount, employees, onOpenRequests }: {
  today: string;
  openCount: number;
  /** The dossier list (super_admin / owner / finance) — for the contract warnings; else undefined. */
  employees?: HrEmployee[];
  onOpenRequests: () => void;
}) {
  const { t } = useTranslation();
  const to = addDaysYmd(today, 13);
  const q = useQuery({ queryKey: ['hr', 'calendar', today, to], queryFn: () => apiHrCalendar(today, to) });

  const names = useMemo(() => new Map((q.data?.employees ?? []).map((e) => [e.id, e])), [q.data]);
  const todayAway = (q.data?.absences ?? []).filter((a) => a.status === 'approved' && a.date_from <= today && a.date_to >= today);
  const soon = (q.data?.absences ?? []).filter((a) => !(a.status === 'approved' && a.date_from <= today && a.date_to >= today));
  const due = (employees ?? []).flatMap((e) => [
    ...(dueWithin(e.contract_end, today, 30) ? [{ e, kind: 'contract', date: e.contract_end! }] : []),
    ...(dueWithin(e.probation_end, today, 30) ? [{ e, kind: 'probation', date: e.probation_end! }] : []),
  ]).sort((a, b) => a.date.localeCompare(b.date));

  if (q.isError && !q.data) return <LoadError text={t('hrPage.loadFailed')} onRetry={() => q.refetch()} />;
  if (!q.data) return <div className="grid gap-4 md:grid-cols-2" aria-hidden><Skeleton variant="card" className="h-40" /><Skeleton variant="card" className="h-40" /></div>;

  const Row = ({ id, from, to: end, type, approved }: { id: string; from: string; to: string; type: string; approved: boolean }) => {
    const p = names.get(id);
    return (
      <li className="flex min-h-10 items-center justify-between gap-3 py-1.5">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{p?.name ?? '—'}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{p ? groupLabel(t, groupKey(p)) : ''} · <span className="tabular-nums">{rangeText(from, end)}</span></span>
        </span>
        <span className={cn('shrink-0 rounded-md border px-2 py-0.5 text-xs font-medium', approved ? ABSENCE_TILE : PENDING_TILE)}>
          {LEAVE_LETTER[type as LeaveType]} · {typeLabel(t, type)}
        </span>
      </li>
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile icon={UserX} label={t('hrPage.overview.awayToday')} value={todayAway.length} />
        <Tile icon={CalendarClock} label={t('hrPage.overview.next14')} value={soon.filter((a) => a.status === 'approved').length} />
        <button type="button" onClick={onOpenRequests} className="col-span-2 text-left sm:col-span-1">
          <Tile icon={Inbox} label={t('hrPage.overview.waiting')} value={openCount} tone={openCount > 0 ? 'text-amber-700 dark:text-amber-400' : undefined} />
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card p-3 shadow-sm" aria-labelledby="hr-away-today">
          <h3 id="hr-away-today" className="mb-1 text-sm font-semibold">{t('hrPage.overview.awayTodayTitle', { date: formatDmy(today) })}</h3>
          {todayAway.length === 0 ? <p className="py-2 text-xs text-muted-foreground">{t('hrPage.overview.allIn')}</p> : (
            <ul className="divide-y">{todayAway.map((a) => <Row key={a.id} id={a.employee_id} from={a.date_from} to={a.date_to} type={a.type} approved />)}</ul>
          )}
        </section>
        <section className="rounded-xl border bg-card p-3 shadow-sm" aria-labelledby="hr-away-soon">
          <h3 id="hr-away-soon" className="mb-1 text-sm font-semibold">{t('hrPage.overview.soonTitle')}</h3>
          {soon.length === 0 ? <p className="py-2 text-xs text-muted-foreground">{t('hrPage.overview.nothingSoon')}</p> : (
            <ul className="divide-y">{soon.map((a) => <Row key={a.id} id={a.employee_id} from={a.date_from} to={a.date_to} type={a.type} approved={a.status === 'approved'} />)}</ul>
          )}
        </section>
      </div>

      {employees && (
        <section className="rounded-xl border bg-card p-3 shadow-sm" aria-labelledby="hr-due">
          <h3 id="hr-due" className="mb-1 flex items-center gap-1.5 text-sm font-semibold"><FileWarning className="h-4 w-4" aria-hidden />{t('hrPage.overview.dueTitle')}</h3>
          {due.length === 0 ? <p className="py-2 text-xs text-muted-foreground">{t('hrPage.overview.nothingDue')}</p> : (
            <ul className="divide-y">
              {due.map((d) => (
                <li key={`${d.e.id}-${d.kind}`} className="flex min-h-10 items-center justify-between gap-3 py-1.5 text-sm">
                  <span className="min-w-0 truncate">{d.e.full_name}</span>
                  <span className="shrink-0 text-xs text-amber-800 dark:text-amber-300">{t(`hrPage.overview.due.${d.kind}`, { date: formatDmy(d.date) })}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {openCount > 0 && (
        <Button type="button" variant="outline" className="h-10" onClick={onOpenRequests}>
          <Inbox className="h-4 w-4" aria-hidden /> {t('hrPage.overview.openRequests', { count: openCount })}
        </Button>
      )}
    </div>
  );
}

function Tile({ icon: Icon, label, value, tone }: { icon: typeof Inbox; label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2 shadow-sm">
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Icon className="h-3.5 w-3.5" aria-hidden />{label}</p>
      <p className={cn('text-2xl font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  );
}
