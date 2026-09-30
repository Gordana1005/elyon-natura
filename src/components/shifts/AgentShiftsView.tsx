import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { CalendarX2, Clock, Coffee, LogIn, OctagonAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadError } from '@/components/insights/shared/LoadError';
import { formatDmy } from '@/components/insights/shared/period';
import {
  addDaysYmd, agentRunway, apiGetMyShiftDays, isZeroWindow, isoDow, monthBounds, skopjeNow, type MyShiftDay,
} from '@/lib/shiftsApi';
import { shiftState } from './model';
import { dayLabel, duration, skopjeHm } from './format';

/**
 * The agent's half of /shifts: today's card (hours, where "now" is, the clock-in, the breaks),
 * the next 14 days and the month at a glance. Red banner when there is no shift in the next
 * 5 days — the login gate would refuse them from that day.
 */
export function AgentShiftsView() {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const { date: today, time: nowTime } = skopjeNow(now);
  const month = monthBounds(today);
  const to = [month.to, addDaysYmd(today, 14)].sort()[1];

  const q = useQuery({
    queryKey: ['shifts', 'my', month.from, to],
    queryFn: () => apiGetMyShiftDays(month.from, to),
    refetchInterval: 60_000,
  });

  const byDate = useMemo(() => {
    const m = new Map<string, MyShiftDay>();
    for (const d of q.data ?? []) if (!m.has(d.date)) m.set(d.date, d);
    return m;
  }, [q.data]);
  const workDates = useMemo(
    () => (q.data ?? []).filter((d) => !isZeroWindow(d.start_time, d.end_time)).map((d) => d.date),
    [q.data],
  );

  if (q.isError) return <LoadError text={t('shiftsPage.agent.loadFailed')} onRetry={() => q.refetch()} />;
  if (q.isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]" aria-hidden>
        <div className="space-y-4"><Skeleton variant="card" className="h-36" /><Skeleton variant="card" className="h-72" /></div>
        <Skeleton variant="card" className="h-72" />
      </div>
    );
  }

  const runway = agentRunway(workDates, today);
  const todayShift = byDate.get(today);
  const next = Array.from({ length: 14 }, (_, i) => addDaysYmd(today, i + 1));

  return (
    <div className="space-y-4">
      {runway.show && runway.from && (
        <div role="alert" data-testid="agent-runway-banner"
          className="flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 px-3 py-2.5 text-red-900 shadow-sm dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100">
          <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium">{t('shiftsPage.agent.banner', { date: formatDmy(runway.from).slice(0, 5) })}</p>
            <p className="text-xs opacity-90">{t('shiftsPage.agent.bannerHint')}</p>
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0 space-y-4">
          <TodayCard shift={todayShift} nowTime={nowTime} today={today} />

          <section aria-labelledby="next14" className="rounded-xl border bg-card p-3 shadow-sm">
            <h3 id="next14" className="mb-2 text-sm font-semibold">{t('shiftsPage.agent.next14')}</h3>
            <ul className="divide-y">
              {next.map((d) => {
                const s = byDate.get(d);
                const off = !s || isZeroWindow(s.start_time, s.end_time);
                return (
                  <li key={d} className="flex min-h-10 items-center justify-between gap-3 py-1.5 text-sm">
                    <span className={cn('tabular-nums', isoDow(d) >= 6 && 'text-muted-foreground')}>{dayLabel(t, d, isoDow(d))}</span>
                    {off ? (
                      <span className="text-xs text-muted-foreground">{t('shiftsPage.agent.off')}</span>
                    ) : (
                      <span className="min-w-0 text-right">
                        <span className="font-medium tabular-nums">{s!.start_time}–{s!.end_time}</span>
                        <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">{s!.name}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        <MiniMonth today={today} monthFrom={month.from} monthTo={month.to} byDate={byDate} />
      </div>
    </div>
  );
}

function TodayCard({ shift, nowTime, today }: { shift: MyShiftDay | undefined; nowTime: string; today: string }) {
  const { t } = useTranslation();
  const off = !shift || isZeroWindow(shift.start_time, shift.end_time);
  const state = off ? null : shiftState(shift!.start_time, shift!.end_time, nowTime);
  return (
    <section aria-labelledby="today-card" data-testid="today-card" className="rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id="today-card" className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('shiftsPage.agent.today')} · {formatDmy(today)}
          </h3>
          {off ? (
            <p className="mt-1 flex items-center gap-2 text-lg font-semibold">
              <CalendarX2 className="h-5 w-5 text-muted-foreground" aria-hidden /> {t('shiftsPage.agent.noShiftToday')}
            </p>
          ) : (
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {shift!.start_time}–{shift!.end_time}
              <span className="ml-2 align-middle text-sm font-normal text-muted-foreground">{shift!.name}</span>
            </p>
          )}
        </div>
        {state && (
          <span className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
            state === 'on' ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200'
              : 'text-muted-foreground',
          )}>
            <Clock className="h-3.5 w-3.5" aria-hidden />
            {t(`shiftsPage.agent.state.${state}`, { time: shift!.start_time })}
          </span>
        )}
      </div>
      {!off && (
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <LogIn className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <dt className="sr-only">{t('shiftsPage.logins.col.login')}</dt>
            <dd>{shift!.clock_in_time ? t('shiftsPage.agent.clockIn', { time: skopjeHm(shift!.clock_in_time) }) : t('shiftsPage.agent.notClockedIn')}</dd>
          </div>
          <div className="flex items-center gap-2">
            <Coffee className={cn('h-4 w-4 shrink-0', shift!.on_break ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')} aria-hidden />
            <dt className="sr-only">{t('shiftsPage.agent.breakTotal', { dur: '' })}</dt>
            <dd className={cn(shift!.on_break && 'font-medium text-amber-700 dark:text-amber-400')}>
              {t('shiftsPage.agent.breakTotal', { dur: duration(t, shift!.total_break_seconds / 60) })}
              {shift!.on_break && ` · ${t('shiftsPage.agent.onBreak')}`}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

function MiniMonth({ today, monthFrom, monthTo, byDate }: {
  today: string; monthFrom: string; monthTo: string; byDate: Map<string, MyShiftDay>;
}) {
  const { t } = useTranslation();
  const lead = isoDow(monthFrom) - 1;
  const days: string[] = [];
  for (let d = monthFrom; d <= monthTo; d = addDaysYmd(d, 1)) days.push(d);
  return (
    <section aria-labelledby="mini-month" className="h-fit rounded-xl border bg-card p-3 shadow-sm">
      <h3 id="mini-month" className="mb-2 text-sm font-semibold">
        {t('shiftsPage.agent.month')} · {formatDmy(monthFrom).slice(3)}
      </h3>
      <div className="grid grid-cols-7 gap-1 text-center text-[11px]">
        {[1, 2, 3, 4, 5, 6, 7].map((d) => (
          <span key={d} className="py-1 font-medium text-muted-foreground">{t(`shiftsPage.dow.${d}`)}</span>
        ))}
        {Array.from({ length: lead }, (_, i) => <span key={`b${i}`} aria-hidden />)}
        {days.map((d) => {
          const s = byDate.get(d);
          const on = !!s && !isZeroWindow(s.start_time, s.end_time);
          return (
            <span key={d}
              title={on ? `${formatDmy(d)} · ${s!.start_time}–${s!.end_time}` : `${formatDmy(d)} · ${t('shiftsPage.agent.off')}`}
              className={cn(
                'flex aspect-square min-h-8 items-center justify-center rounded-md border text-xs tabular-nums',
                on ? 'border-emerald-300 bg-emerald-100 font-medium text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/20 dark:text-emerald-100'
                  : 'border-dashed text-muted-foreground',
                d < today && 'opacity-50',
                d === today && 'ring-2 ring-primary ring-offset-1 ring-offset-card',
              )}>
              {Number(d.slice(8, 10))}
            </span>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded border border-emerald-300 bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/20" aria-hidden />{t('shiftsPage.agent.legendShift')}</span>
        <span className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded border border-dashed" aria-hidden />{t('shiftsPage.agent.legendOff')}</span>
      </div>
    </section>
  );
}
