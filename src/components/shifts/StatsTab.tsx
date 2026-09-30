import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Ban, Briefcase, CalendarDays, CalendarRange, Clock, LogIn, Timer, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { MobileCard, MobileCardField, MobileCardHeader } from '@/components/ui/mobile-card';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { DmyDateInput } from '@/components/insights/shared/DmyDateInput';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { fmtNum } from '@/components/insights/overview/model';
import { Chip } from '@/components/assigner/parts';
import { addDaysYmd, apiGetShiftStatistics, monthBounds, skopjeNow, type StatsRow } from '@/lib/shiftsApi';

/**
 * Статистика: one SQL aggregate per person (shifts_statistics — the old path stopped at 1.000
 * assignment rows). Tiles on top, a table from md, cards below.
 */
export function StatsTab() {
  const { t, i18n } = useTranslation();
  const f = useInsightsFormat();
  const today = skopjeNow().date;
  const thisMonth = monthBounds(today);
  const lastMonth = monthBounds(addDaysYmd(thisMonth.from, -1));
  const [from, setFrom] = useState<string | null>(thisMonth.from);
  const [to, setTo] = useState<string | null>(thisMonth.to);
  const valid = !!from && !!to && from <= to;

  const q = useQuery({
    queryKey: ['shifts', 'stats', from, to],
    queryFn: () => apiGetShiftStatistics(from!, to!),
    enabled: valid,
    placeholderData: keepPreviousData,
  });
  // the app's own marks (mk / sq / bg: 14.900,5 — the browser's 'mk' data is not reliable)
  const h = (v: number) => fmtNum(v, i18n.language, Number.isInteger(v) ? 0 : 1);
  const data = q.data;
  const rows = data?.rows.filter((r) => r.total_shifts > 0 || r.days_logged_in > 0 || r.blocked_attempts > 0) ?? [];

  const tiles: { icon: LucideIcon; label: string; value: string; tone?: string }[] = data ? [
    { icon: Briefcase, label: t('shiftsPage.stats.tiles.scheduled'), value: h(data.totals.scheduled_hours) },
    { icon: Timer, label: t('shiftsPage.stats.tiles.actual'), value: h(data.totals.actual_hours) },
    { icon: CalendarDays, label: t('shiftsPage.stats.tiles.weekday'), value: f.int(data.totals.weekday_shifts) },
    { icon: CalendarRange, label: t('shiftsPage.stats.tiles.weekend'), value: f.int(data.totals.weekend_shifts) },
    { icon: LogIn, label: t('shiftsPage.stats.tiles.loggedDays'), value: f.int(data.totals.days_logged_in) },
    { icon: Clock, label: t('shiftsPage.stats.tiles.late'), value: f.int(data.totals.late_days), tone: data.totals.late_days ? 'text-amber-700 dark:text-amber-400' : undefined },
    { icon: Ban, label: t('shiftsPage.stats.tiles.blocked'), value: f.int(data.totals.blocked_attempts), tone: data.totals.blocked_attempts ? 'text-red-700 dark:text-red-400' : undefined },
  ] : [];

  const cols: { key: keyof StatsRow; label: string; fmt: (r: StatsRow) => string }[] = [
    { key: 'total_worked_days', label: t('shiftsPage.stats.col.days'), fmt: (r) => f.int(r.total_worked_days) },
    { key: 'total_weekend_days', label: t('shiftsPage.stats.col.weekendDays'), fmt: (r) => f.int(r.total_weekend_days) },
    { key: 'total_shifts', label: t('shiftsPage.stats.col.shifts'), fmt: (r) => f.int(r.total_shifts) },
    { key: 'total_hours_scheduled', label: t('shiftsPage.stats.col.scheduled'), fmt: (r) => h(r.total_hours_scheduled) },
    { key: 'total_hours_actual', label: t('shiftsPage.stats.col.actual'), fmt: (r) => h(r.total_hours_actual) },
    { key: 'average_hours_per_shift', label: t('shiftsPage.stats.col.avg'), fmt: (r) => h(r.average_hours_per_shift) },
    { key: 'days_logged_in', label: t('shiftsPage.stats.col.loggedDays'), fmt: (r) => f.int(r.days_logged_in) },
    { key: 'late_days', label: t('shiftsPage.stats.col.late'), fmt: (r) => f.int(r.late_days) },
    { key: 'blocked_attempts', label: t('shiftsPage.stats.col.blocked'), fmt: (r) => f.int(r.blocked_attempts) },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card/80 p-2 shadow-sm">
        <DmyDateInput label={t('shiftsPage.logins.from')} value={from} onChange={setFrom} max={to ?? undefined} />
        <DmyDateInput label={t('shiftsPage.logins.to')} value={to} onChange={setTo} min={from ?? undefined} />
        <div className="flex flex-wrap gap-1.5">
          <Chip on={from === thisMonth.from && to === thisMonth.to} onClick={() => { setFrom(thisMonth.from); setTo(thisMonth.to); }}>{t('shiftsPage.stats.thisMonth')}</Chip>
          <Chip on={from === lastMonth.from && to === lastMonth.to} onClick={() => { setFrom(lastMonth.from); setTo(lastMonth.to); }}>{t('shiftsPage.stats.lastMonth')}</Chip>
        </div>
      </div>

      {q.isError && !data ? (
        <LoadError text={t('shiftsPage.stats.loadFailed')} onRetry={() => q.refetch()} />
      ) : !data ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="card" className="h-20" />)}
        </div>
      ) : (
        <>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-7" data-testid="stats-tiles">
            {tiles.map(({ icon: Icon, label, value, tone }) => (
              <li key={label} className="flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card p-3 shadow-sm">
                <span className="flex items-start gap-1.5 text-[11px] font-medium leading-tight text-muted-foreground">
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="min-w-0 break-words">{label}</span>
                </span>
                <span className={cn('text-2xl font-semibold tabular-nums', tone ?? 'text-card-foreground')}>{value}</span>
              </li>
            ))}
          </ul>

          {rows.length === 0 ? (
            <EmptyState title={t('shiftsPage.stats.none')} size="sm" className="rounded-xl shadow-sm" />
          ) : (
            <>
              <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm xl:block">
                <table className="w-full text-sm">
                  <thead className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">{t('shiftsPage.stats.col.agent')}</th>
                      {cols.map((c) => <th key={c.key} className="px-3 py-2 text-right font-medium">{c.label}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((r) => (
                      <tr key={r.user_id}>
                        <td className="px-3 py-2 font-medium">{r.full_name}</td>
                        {cols.map((c) => <td key={c.key} className="px-3 py-2 text-right tabular-nums">{c.fmt(r)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:hidden">
                {rows.map((r) => (
                  <MobileCard key={r.user_id}>
                    <MobileCardHeader title={r.full_name} />
                    {cols.filter((c) => ['total_worked_days', 'total_hours_scheduled', 'days_logged_in', 'late_days', 'blocked_attempts'].includes(c.key))
                      .map((c) => <MobileCardField key={c.key} label={c.label} value={c.fmt(r)} />)}
                  </MobileCard>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
