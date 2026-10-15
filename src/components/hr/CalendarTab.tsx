import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Loader2, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { formatDmy } from '@/components/insights/shared/period';
import { Chip } from '@/components/assigner/parts';
import { userMatchesQuery } from '@/lib/users/filterUsers';
import { addDaysYmd, isoDow, monthBounds } from '@/lib/shiftsApi';
import {
  LEAVE_LETTER, apiHrCalendar, maxSameDay, type HrAbsence, type HrCalendar, type LeaveType,
} from '@/lib/hrApi';
import { ABSENCE_TILE, HOLIDAY_TILE, PENDING_TILE, rangeText, statusLabel, typeLabel } from './labels';
import { groupKey, groupLabel, groupOrder } from './groups';

type CalPerson = HrCalendar['employees'][number];

/**
 * Календар — a month of the people in the viewer's scope: approved absences as their letter
 * (violet), requests still waiting dashed amber, the person's holidays shaded, days outside their
 * work week dimmed. Grouped by team / shop / warehouse; a chip per group and a search. From md a
 * grid that scrolls sideways inside its own card; below md the month's absences as a list.
 */
export function CalendarTab({ today, maxSameDayHint }: { today: string; maxSameDayHint: number }) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState(today.slice(0, 8) + '01');
  const { from, to } = monthBounds(anchor);
  const [group, setGroup] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const q = useQuery({
    queryKey: ['hr', 'calendar', from, to],
    queryFn: () => apiHrCalendar(from, to),
    placeholderData: keepPreviousData,
  });

  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDaysYmd(d, 1)) out.push(d);
    return out;
  }, [from, to]);

  const data = q.data;
  const people = data?.employees ?? [];
  const groups = useMemo(() => {
    const m = new Map<string, CalPerson[]>();
    for (const p of people) m.set(groupKey(p), [...(m.get(groupKey(p)) ?? []), p]);
    return [...m.entries()].sort(([a], [b]) => groupOrder(a) - groupOrder(b) || a.localeCompare(b));
  }, [people]);
  const shownGroups = groups
    .filter(([k]) => !group || k === group)
    .map(([k, list]) => [k, list.filter((p) => !search.trim() || userMatchesQuery({ full_name: p.name }, search))] as const)
    .filter(([, list]) => list.length > 0);

  const byPersonDay = useMemo(() => {
    const m = new Map<string, HrAbsence>();
    for (const a of data?.absences ?? []) {
      for (let d = a.date_from < from ? from : a.date_from; d <= a.date_to && d <= to; d = addDaysYmd(d, 1)) {
        const k = `${a.employee_id}|${d}`;
        if (!m.has(k) || a.status === 'approved') m.set(k, a);
      }
    }
    return m;
  }, [data, from, to]);
  const holidaysOf = useMemo(() => {
    const m = new Map<string, { name: string; scope: string }[]>();
    for (const h of data?.holidays ?? []) m.set(h.date, [...(m.get(h.date) ?? []), { name: h.name, scope: h.scope }]);
    return m;
  }, [data]);
  const holidayFor = (p: CalPerson, d: string) =>
    (holidaysOf.get(d) ?? []).find((h) => h.scope === 'all' || p.holiday_calendars.includes(h.scope)) ?? null;

  // the busiest day per group (approved + waiting), for the "too many at once" hint
  const busiest = useMemo(() => {
    const groupOf = new Map(people.map((p) => [p.id, groupKey(p)]));
    return new Map(groups.map(([k]) => [k, maxSameDay(data?.absences ?? [], (id) => groupOf.get(id) ?? null, k, from, to)]));
  }, [groups, people, data, from, to]);

  const step = (dir: -1 | 1) => {
    const [y, m] = anchor.split('-').map(Number);
    const nm = m + dir;
    const ny = nm < 1 ? y - 1 : nm > 12 ? y + 1 : y;
    const mm = ((nm + 11) % 12) + 1;
    setAnchor(`${ny}-${String(mm).padStart(2, '0')}-01`);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-xl border bg-card/80 p-2 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="icon" className="h-9 w-9" aria-label={t('hrPage.calendar.prev')} onClick={() => step(-1)}>
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setAnchor(today.slice(0, 8) + '01')}>{t('hrPage.calendar.thisMonth')}</Button>
            <Button type="button" variant="outline" size="icon" className="h-9 w-9" aria-label={t('hrPage.calendar.next')} onClick={() => step(1)}>
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <span className="text-sm font-semibold tabular-nums">{t(`hrPage.months.${Number(from.slice(5, 7))}`)} {from.slice(0, 4)}</span>
          {q.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />}
          <label className="relative ml-auto block w-full sm:w-56">
            <span className="sr-only">{t('hrPage.calendar.search')}</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('hrPage.calendar.search')} className="h-9 pl-8 text-sm" />
          </label>
        </div>
        {groups.length > 1 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('hrPage.calendar.groups')}>
            <Chip on={!group} onClick={() => setGroup(null)}>{t('common.all')}</Chip>
            {groups.map(([k, list]) => (
              <Chip key={k} on={group === k} onClick={() => setGroup(group === k ? null : k)}>{groupLabel(t, k)} · {list.length}</Chip>
            ))}
          </div>
        )}
        <Legend />
      </div>

      {q.isError && !data ? (
        <LoadError text={t('hrPage.loadFailed')} onRetry={() => q.refetch()} />
      ) : !data ? (
        <div className="space-y-2" aria-hidden>{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="tableRow" className="h-10" />)}</div>
      ) : shownGroups.length === 0 ? (
        <EmptyState title={t('hrPage.calendar.empty')} size="sm" className="rounded-xl shadow-sm" />
      ) : (
        <>
          {/* md+: the month grid */}
          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm md:block" data-testid="hr-calendar-grid">
            <table className="w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  <th scope="col" className="sticky left-0 z-20 w-36 min-w-36 border-b bg-card px-2 py-2 text-left font-medium text-muted-foreground lg:w-44 lg:min-w-44">
                    {t('hrPage.calendar.person')}
                  </th>
                  {days.map((d) => (
                    <th key={d} scope="col" className={cn('min-w-[24px] border-b px-px py-1.5 text-center font-medium tabular-nums',
                      isoDow(d) >= 6 ? 'text-muted-foreground' : 'text-foreground', d === today && 'bg-primary/10 text-primary',
                      (holidaysOf.get(d) ?? []).some((h) => h.scope === 'all') && HOLIDAY_TILE)}
                      title={(holidaysOf.get(d) ?? []).map((h) => h.name).join(' · ') || undefined}>
                      <span className="block text-[10px] uppercase leading-tight">{t(`shiftsPage.dow.${isoDow(d)}`).slice(0, 2)}</span>
                      <span className="block leading-tight">{Number(d.slice(8, 10))}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownGroups.map(([k, list]) => {
                  const busy = busiest.get(k);
                  return (
                    <GroupBlock key={k} label={groupLabel(t, k)} count={list.length} cols={days.length}
                      warn={busy && busy.count >= maxSameDayHint && busy.day
                        ? t('hrPage.calendar.busy', { n: busy.count, date: formatDmy(busy.day).slice(0, 5) }) : null}>
                      {list.map((p) => (
                        <tr key={p.id} className="group">
                          <th scope="row" className="sticky left-0 z-10 border-b bg-card px-2 py-1 text-left font-normal group-hover:bg-muted/40">
                            <span className="block max-w-[8rem] truncate text-xs font-medium lg:max-w-[11rem]" title={p.name}>{p.name}</span>
                            {p.position && <span className="block max-w-[8rem] truncate text-[10px] text-muted-foreground lg:max-w-[11rem]">{p.position}</span>}
                          </th>
                          {days.map((d) => {
                            const a = byPersonDay.get(`${p.id}|${d}`);
                            const hol = holidayFor(p, d);
                            const offDay = !p.work_days.includes(isoDow(d));
                            const title = a
                              ? `${p.name} · ${typeLabel(t, a.type)} · ${statusLabel(t, a.status)} · ${rangeText(a.date_from, a.date_to)}`
                              : hol ? `${formatDmy(d)} · ${hol.name}` : `${p.name} · ${formatDmy(d)}`;
                            return (
                              <td key={d} className={cn('border-b px-px py-0.5', d === today && 'bg-primary/5', !a && hol && HOLIDAY_TILE)}>
                                <div title={title} aria-label={title} role="img"
                                  data-absence={a ? `${a.type}:${a.status}` : undefined}
                                  className={cn('flex h-7 items-center justify-center rounded-md border text-[10px] font-semibold',
                                    a ? (a.status === 'approved' ? ABSENCE_TILE : PENDING_TILE)
                                      : offDay ? 'border-transparent bg-muted/40' : 'border-transparent')}>
                                  {a ? LEAVE_LETTER[a.type as LeaveType] : hol ? '•' : ''}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </GroupBlock>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* below md: the month's absences, by group */}
          <div className="space-y-3 md:hidden" data-testid="hr-calendar-list">
            {shownGroups.map(([k, list]) => {
              const ids = new Set(list.map((p) => p.id));
              const rows = (data.absences ?? []).filter((a) => ids.has(a.employee_id));
              const name = new Map(list.map((p) => [p.id, p.name]));
              return (
                <section key={k} className="space-y-1.5" aria-label={groupLabel(t, k)}>
                  <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{groupLabel(t, k)} · {list.length}</h4>
                  {rows.length === 0 ? (
                    <p className="rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">{t('hrPage.calendar.nobodyAway')}</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {rows.map((a) => (
                        <li key={a.id} className="flex min-h-11 items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2 shadow-sm">
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">{name.get(a.employee_id)}</span>
                            <span className="block text-xs text-muted-foreground tabular-nums">{rangeText(a.date_from, a.date_to)}</span>
                          </span>
                          <span className={cn('shrink-0 rounded-md border px-2 py-1 text-xs font-medium', a.status === 'approved' ? ABSENCE_TILE : PENDING_TILE)}>
                            {LEAVE_LETTER[a.type as LeaveType]} · {typeLabel(t, a.type)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function GroupBlock({ label, count, cols, warn, children }: { label: string; count: number; cols: number; warn: string | null; children: ReactNode }) {
  return (
    <>
      <tr>
        <th colSpan={cols + 1} scope="colgroup" className="sticky left-0 border-b bg-muted/60 px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label} · {count}
          {warn && <span className="ml-2 normal-case tracking-normal text-amber-700 dark:text-amber-400">{warn}</span>}
        </th>
      </tr>
      {children}
    </>
  );
}

function Legend() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {(['annual', 'sick', 'personal_paid', 'unpaid', 'business_trip'] as LeaveType[]).map((k) => (
        <span key={k} className="inline-flex items-center gap-1">
          <span className={cn('inline-flex h-4 w-4 items-center justify-center rounded border text-[9px] font-semibold', ABSENCE_TILE)} aria-hidden>{LEAVE_LETTER[k]}</span>
          {typeLabel(t, k)}
        </span>
      ))}
      <span className="inline-flex items-center gap-1"><span className={cn('h-4 w-4 rounded border', PENDING_TILE)} aria-hidden />{t('hrPage.calendar.legendPending')}</span>
      <span className="inline-flex items-center gap-1"><span className={cn('h-4 w-4 rounded border', HOLIDAY_TILE)} aria-hidden />{t('hrPage.calendar.legendHoliday')}</span>
    </div>
  );
}
