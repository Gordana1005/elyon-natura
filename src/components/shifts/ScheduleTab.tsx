import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, ChevronLeft, ChevronRight, Copy, LayoutTemplate, Loader2, Search, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { LoadError } from '@/components/insights/shared/LoadError';
import { periodText } from '@/components/insights/shared/period';
import { Chip, LABEL } from '@/components/assigner/parts';
import { userMatchesQuery } from '@/lib/users/filterUsers';
import {
  addDaysYmd, apiCopyShifts, apiGetShiftsGrid, apiSetShiftCells, cellKey, diffCells, isoDow, skopjeNow,
  stagedFromInput, type GridCell, type GridPerson, type ShiftCellInput, type StagedCell,
} from '@/lib/shiftsApi';
import {
  EMPTY_STAGING, TEAM_ORDER, baselineCells, brushToStaged, buildBrushes, stagingReducer, stepAnchor, toneMap, viewDays,
  type Brush, type GridView,
} from './model';
import { teamLabel } from './format';
import { shiftErrorText } from './errors';
import { BrushChips } from './BrushChips';
import { ShiftGrid, type PersonGroup } from './ShiftGrid';
import { ShiftDayList } from './ShiftDayList';
import { TemplatesDialog } from './TemplatesDialog';

function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return matches;
}

/**
 * Распоред: the roster grid. Paint with a brush (a template, a window in use, or "Слободен"),
 * changes are staged (amber ring) and saved atomically with [Зачувај (N)] → POST /shifts/cells;
 * the answer's `undo` is kept for one [Врати]. Week view from md, month view from xl; below md
 * a day strip + the agents as a list with a pick sheet.
 */
export function ScheduleTab({ onRoll }: { onRoll: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isXl = useMediaQuery('(min-width: 1280px)');
  const [viewPref, setViewPref] = useState<GridView>('week');
  const view: GridView = isXl ? viewPref : 'week';
  const today = skopjeNow().date;
  const [anchor, setAnchor] = useState(today);
  const days = useMemo(() => viewDays(view, anchor), [view, anchor]);
  const from = days[0];
  const to = days[days.length - 1];
  const [phoneDay, setPhoneDay] = useState(today);
  useEffect(() => { if (!days.includes(phoneDay)) setPhoneDay(days.includes(today) ? today : days[0]); }, [days, phoneDay, today]);

  const grid = useQuery({
    queryKey: ['shifts', 'grid', from, to],
    queryFn: () => apiGetShiftsGrid(from, to),
    placeholderData: keepPreviousData,
  });

  const [staging, dispatch] = useReducer(stagingReducer, EMPTY_STAGING);
  const [brushKey, setBrushKey] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showBypass, setShowBypass] = useState(false);
  const [lastUndo, setLastUndo] = useState<ShiftCellInput[] | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const templates = useMemo(() => grid.data?.templates ?? [], [grid.data]);
  const brushes = useMemo(() => buildBrushes(templates, grid.data?.windows ?? []), [templates, grid.data]);
  const tones = useMemo(() => toneMap(brushes), [brushes]);
  const stored = useMemo(() => {
    const m = new Map<string, GridCell>();
    for (const c of grid.data?.cells ?? []) m.set(cellKey(c.user_id, c.date), c);
    return m;
  }, [grid.data]);
  const brushOf = useCallback((key: string | null): Brush | null => {
    if (!key) return null;
    if (key === 'off') return { key: 'off', kind: 'off' };
    return brushes.find((b) => b.key === key) ?? null;
  }, [brushes]);
  const brush = brushOf(brushKey);

  const paint = useCallback((entries: [string, StagedCell][]) => {
    if (entries.length) dispatch({ type: 'paint', entries, stored });
  }, [stored]);
  const needBrush = useCallback(() => toast({ title: t('shiftsPage.grid.needBrush') }), [toast, t]);
  const onPaintCell = useCallback((key: string) => {
    if (!brush) { needBrush(); return; }
    paint([[key, brushToStaged(brush)]]);
  }, [brush, paint, needBrush]);
  const onRowWeekdays = (userId: string) => {
    if (!brush) { needBrush(); return; }
    const v = brushToStaged(brush);
    paint(days.filter((d) => isoDow(d) <= 5).map((d) => [cellKey(userId, d), v]));
  };
  const onRowClear = (userId: string) => paint(days.map((d) => [cellKey(userId, d), { kind: 'off' }]));

  // people → the groups the grid shows
  const people = grid.data?.people ?? [];
  const bypassCount = people.filter((p) => !p.gated).length;
  const groups: PersonGroup[] = useMemo(() => {
    const shown = people.filter((p) => (showBypass || p.gated) && (!search.trim() || userMatchesQuery({ full_name: p.name }, search)));
    const byTeam = new Map<string, GridPerson[]>();
    for (const p of shown) {
      const k = p.team_key ?? 'none';
      byTeam.set(k, [...(byTeam.get(k) ?? []), p]);
    }
    return [...byTeam.entries()]
      .sort(([a], [b]) => (TEAM_ORDER[a] ?? (a === 'none' ? 99 : 50)) - (TEAM_ORDER[b] ?? (b === 'none' ? 99 : 50)) || a.localeCompare(b))
      .map(([k, list]) => ({
        key: k,
        label: teamLabel(t, k === 'none' ? null : k, list[0]?.team_name ?? null),
        people: [...list].sort((a, b) => Number(b.gated) - Number(a.gated) || a.name.localeCompare(b.name)),
      }));
  }, [people, showBypass, search, t]);

  const changes = useMemo(() => diffCells(baselineCells(staging), staging.staged), [staging]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['shifts'] });
  };
  const save = useMutation({
    mutationFn: () => apiSetShiftCells(changes),
    onSuccess: (r) => {
      dispatch({ type: 'reset' });
      setLastUndo(r.undo?.length ? r.undo : null);
      toast({ title: r.changed ? t('shiftsPage.grid.saved', { count: r.changed }) : t('shiftsPage.grid.savedNothing') });
      invalidate();
    },
    onError: (e) => toast({ title: t('common.error'), description: shiftErrorText(e), variant: 'destructive' }),
  });
  const undo = useMutation({
    mutationFn: (cells: ShiftCellInput[]) => apiSetShiftCells(cells),
    onSuccess: () => { setLastUndo(null); toast({ title: t('shiftsPage.grid.undone') }); invalidate(); },
    onError: (e) => toast({ title: t('common.error'), description: shiftErrorText(e), variant: 'destructive' }),
  });
  const copyPrev = useMutation({
    mutationFn: () => apiCopyShifts({ src_from: addDaysYmd(from, -7), src_to: addDaysYmd(from, -1), dst_from: from, mode: 'fill_empty' }),
    onSuccess: (r) => {
      const entries = r.cells
        .map((c) => [cellKey(c.user_id, c.date), stagedFromInput(c, templates)] as const)
        .filter((e): e is readonly [string, StagedCell] => e[1] != null)
        .map(([k, v]) => [k, v] as [string, StagedCell]);
      paint(entries);
      toast({ title: entries.length ? t('shiftsPage.grid.copyStaged', { n: entries.length }) : t('shiftsPage.grid.copyNothing') });
    },
    onError: (e) => toast({ title: t('common.error'), description: shiftErrorText(e), variant: 'destructive' }),
  });

  const pending = changes.length;

  return (
    <div className="space-y-3">
      {/* Toolbar: period + view, then the brushes and the actions. Wraps; never scrolls the page. */}
      <div className="space-y-2 rounded-xl border bg-card/80 p-2 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="icon" className="h-9 w-9" aria-label={t('shiftsPage.grid.prev')}
              onClick={() => setAnchor((a) => stepAnchor(view, a, -1))}>
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setAnchor(today)}>{t('shiftsPage.grid.today')}</Button>
            <Button type="button" variant="outline" size="icon" className="h-9 w-9" aria-label={t('shiftsPage.grid.next')}
              onClick={() => setAnchor((a) => stepAnchor(view, a, 1))}>
              <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          </div>
          <span className="text-sm font-semibold tabular-nums" data-testid="grid-period">{periodText({ from, to })}</span>
          {grid.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden />}
          {isXl && (
            <div role="group" aria-label={t('shiftsPage.grid.viewWeek')} className="ml-auto flex gap-1.5">
              <Chip on={view === 'week'} onClick={() => setViewPref('week')}>{t('shiftsPage.grid.viewWeek')}</Chip>
              <Chip on={view === 'month'} onClick={() => setViewPref('month')}>{t('shiftsPage.grid.viewMonth')}</Chip>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="relative block w-full sm:w-56">
            <span className="sr-only">{t('shiftsPage.grid.search')}</span>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('shiftsPage.grid.search')} className="h-9 pl-8 text-sm" />
          </label>
          {view === 'week' && (
            <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => copyPrev.mutate()} disabled={copyPrev.isPending || !grid.data}>
              <Copy className="h-4 w-4" aria-hidden /> {t('shiftsPage.grid.copyPrevWeek')}
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" className="h-9" onClick={onRoll}>
            <CalendarPlus className="h-4 w-4" aria-hidden /> {t('shiftsPage.runway.roll')}
          </Button>
          <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => setTemplatesOpen(true)}>
            <LayoutTemplate className="h-4 w-4" aria-hidden /> {t('shiftsPage.grid.templates')}
          </Button>
          {bypassCount > 0 && (
            <Chip on={showBypass} onClick={() => setShowBypass((v) => !v)}>
              {showBypass ? t('shiftsPage.grid.hideBypass') : t('shiftsPage.grid.showBypass', { n: bypassCount })}
            </Chip>
          )}
        </div>

        <div className="hidden space-y-1 md:block">
          <span className={LABEL}>{t('shiftsPage.grid.brushes')}</span>
          <BrushChips brushes={brushes} tones={tones} selected={brushKey}
            onSelect={(k) => setBrushKey((cur) => (cur === k ? null : k))} />
          {!brush && <p className="text-[11px] text-muted-foreground">{t('shiftsPage.grid.brushHint')}</p>}
        </div>
      </div>

      {grid.isError && !grid.data ? (
        <LoadError text={t('shiftsPage.grid.loadFailed')} onRetry={() => grid.refetch()} />
      ) : !grid.data ? (
        <div className="space-y-2" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="tableRow" className="h-10" />)}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState title={search.trim() ? t('shiftsPage.grid.noMatch') : t('shiftsPage.grid.noPeople')} size="sm" className="rounded-xl shadow-sm" />
      ) : (
        <>
          <div className="hidden md:block">
            <ShiftGrid view={view} days={days} today={today} groups={groups} stored={stored} staged={staging.staged}
              tones={tones} brushActive={!!brush} onPaint={onPaintCell} onRowWeekdays={onRowWeekdays} onRowClear={onRowClear} />
          </div>
          <ShiftDayList days={days} today={today} day={phoneDay} onDay={setPhoneDay} groups={groups}
            stored={stored} staged={staging.staged} tones={tones} brushes={brushes}
            onSet={(key, bk) => { const b = brushOf(bk); if (b) paint([[key, brushToStaged(b)]]); }} />
        </>
      )}

      {(pending > 0 || lastUndo) && (
        <div role="region" aria-label={t('shiftsPage.grid.save', { n: pending })}
          className="sticky bottom-2 z-30 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card/95 p-2 shadow-lg backdrop-blur">
          <span className={cn('text-sm', pending > 0 ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
            {pending > 0 ? t('shiftsPage.grid.unsaved', { count: pending }) : null}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {lastUndo && pending === 0 && (
              <Button type="button" variant="outline" size="sm" className="h-9" onClick={() => undo.mutate(lastUndo)} disabled={undo.isPending}>
                <Undo2 className="h-4 w-4" aria-hidden /> {t('shiftsPage.grid.undo')}
              </Button>
            )}
            {pending > 0 && (
              <>
                <Button type="button" variant="ghost" size="sm" className="h-9" onClick={() => dispatch({ type: 'reset' })} disabled={save.isPending}>
                  {t('shiftsPage.grid.discard')}
                </Button>
                <Button type="button" size="sm" className="h-9" onClick={() => save.mutate()} disabled={save.isPending}>
                  {save.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  {t('shiftsPage.grid.save', { n: pending })}
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      <TemplatesDialog open={templatesOpen} onOpenChange={setTemplatesOpen} templates={templates}
        onChanged={() => { invalidate(); }} />
    </div>
  );
}
