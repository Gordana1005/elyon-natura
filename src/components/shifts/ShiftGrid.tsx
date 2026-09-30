import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Eraser, MoreHorizontal, Paintbrush } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatDmy } from '@/components/insights/shared/period';
import { cellKey, isoDow, type GridCell, type GridPerson, type StagedCell } from '@/lib/shiftsApi';
import { NEUTRAL_TONE, OFF_TONE, shortWindow, shownCell, shownKey, type GridView } from './model';

export interface PersonGroup { key: string; label: string; people: GridPerson[] }

/**
 * The roster grid from md up: people (grouped by team) × days, the first column sticky.
 * Pointer down on a cell paints it with the brush; keep the button down and move to paint
 * more (mouse or touch — the cell under the pointer is looked up, so a drag across a row or
 * down a column works). The grid scrolls sideways inside its own card, never the page.
 */
export function ShiftGrid({
  view, days, today, groups, stored, staged, tones, brushActive, onPaint, onRowWeekdays, onRowClear,
}: {
  view: GridView;
  days: string[];
  today: string;
  groups: PersonGroup[];
  stored: ReadonlyMap<string, GridCell>;
  staged: ReadonlyMap<string, StagedCell>;
  tones: ReadonlyMap<string, string>;
  /** A brush is selected: a touch drag paints instead of scrolling. */
  brushActive: boolean;
  onPaint: (key: string) => void;
  onRowWeekdays: (userId: string) => void;
  onRowClear: (userId: string) => void;
}) {
  const { t } = useTranslation();
  const painting = useRef(false);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    const stop = () => { painting.current = false; lastKey.current = null; };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => { window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); };
  }, []);

  const paintOnce = useCallback((key: string | null) => {
    if (!key || key === lastKey.current) return;
    lastKey.current = key;
    onPaint(key);
  }, [onPaint]);

  const onCellPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, key: string) => {
    if (e.button !== 0) return;
    painting.current = true;
    lastKey.current = null;
    // touch captures the pointer on the first element; release it so the drag can travel
    try { e.currentTarget.releasePointerCapture?.(e.pointerId); } catch { /* not captured */ }
    paintOnce(key);
  };
  const onGridPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!painting.current) return;
    const el = document.elementFromPoint?.(e.clientX, e.clientY)?.closest('[data-cell-key]');
    paintOnce(el?.getAttribute('data-cell-key') ?? null);
  };

  const month = view === 'month';
  const valueText = (key: string) => {
    const shown = shownCell(stored.get(key), staged.get(key));
    return shown.kind === 'off' ? t('shiftsPage.grid.off') : `${shown.start}–${shown.end}${shown.name ? ` · ${shown.name}` : ''}`;
  };

  return (
    <div
      data-testid="shift-grid"
      className="overflow-x-auto rounded-xl border bg-card shadow-sm"
      onPointerMove={onGridPointerMove}
      style={{ touchAction: brushActive ? 'none' : 'auto' }}
    >
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th scope="col" className={cn('sticky left-0 top-0 z-20 border-b bg-card px-2 py-2 text-left font-medium text-muted-foreground', month ? 'w-32 min-w-32' : 'w-36 min-w-36 lg:w-44 lg:min-w-44')}>
              {t('shiftsPage.grid.agent')}
            </th>
            {days.map((d) => {
              const dow = isoDow(d);
              return (
                <th key={d} scope="col"
                  className={cn('border-b px-0.5 py-1.5 text-center font-medium tabular-nums',
                    month ? 'min-w-[22px]' : 'min-w-[60px]',
                    dow >= 6 ? 'text-muted-foreground' : 'text-foreground',
                    d === today && 'bg-primary/10 text-primary')}>
                  <span className="block text-[10px] uppercase leading-tight">{month ? t(`shiftsPage.dow.${dow}`).slice(0, 2) : t(`shiftsPage.dow.${dow}`)}</span>
                  <span className="block leading-tight">{month ? Number(d.slice(8, 10)) : `${d.slice(8, 10)}.${d.slice(5, 7)}`}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <GroupRows key={g.key} group={g} days={days} today={today} month={month}
              stored={stored} staged={staged} tones={tones} valueText={valueText}
              onCellPointerDown={onCellPointerDown} onKeyPaint={onPaint}
              onRowWeekdays={onRowWeekdays} onRowClear={onRowClear} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({
  group, days, today, month, stored, staged, tones, valueText, onCellPointerDown, onKeyPaint, onRowWeekdays, onRowClear,
}: {
  group: PersonGroup; days: string[]; today: string; month: boolean;
  stored: ReadonlyMap<string, GridCell>; staged: ReadonlyMap<string, StagedCell>; tones: ReadonlyMap<string, string>;
  valueText: (key: string) => string;
  onCellPointerDown: (e: ReactPointerEvent<HTMLButtonElement>, key: string) => void;
  onKeyPaint: (key: string) => void;
  onRowWeekdays: (userId: string) => void;
  onRowClear: (userId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <tr>
        <th colSpan={days.length + 1} scope="colgroup"
          className="sticky left-0 border-b bg-muted/60 px-2 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {group.label} · {t('shiftsPage.grid.people', { count: group.people.length })}
        </th>
      </tr>
      {group.people.map((p) => (
        <tr key={p.user_id} className="group">
          <th scope="row" className="sticky left-0 z-10 border-b bg-card px-2 py-1 text-left font-normal group-hover:bg-muted/40">
            <div className="flex items-center gap-1">
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-xs font-medium text-foreground', month ? 'max-w-[7rem]' : 'max-w-[7.5rem] lg:max-w-[11rem]')} title={p.name}>{p.name}</span>
                {!p.gated && (
                  <span className="block text-[10px] text-muted-foreground" title={t('shiftsPage.grid.bypassTitle')}>{t('shiftsPage.grid.bypassBadge')}</span>
                )}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label={t('shiftsPage.grid.rowMenu', { name: p.name })}>
                    <MoreHorizontal className="h-4 w-4" aria-hidden />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => onRowWeekdays(p.user_id)}>
                    <Paintbrush className="mr-2 h-3.5 w-3.5" aria-hidden /> {t('shiftsPage.grid.weekdaysFill')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onRowClear(p.user_id)}>
                    <Eraser className="mr-2 h-3.5 w-3.5" aria-hidden /> {month ? t('shiftsPage.grid.clearMonth') : t('shiftsPage.grid.clearWeek')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </th>
          {days.map((d) => {
            const key = cellKey(p.user_id, d);
            const shown = shownCell(stored.get(key), staged.get(key));
            const isStaged = staged.has(key);
            const tone = shown.kind === 'off' ? OFF_TONE : tones.get(shownKey(shown)) ?? NEUTRAL_TONE;
            const label = t('shiftsPage.grid.cellTitle', { name: p.name, date: formatDmy(d), value: valueText(key) })
              + (isStaged ? ` · ${t('shiftsPage.grid.staged')}` : '');
            return (
              <td key={d} className={cn('border-b', month ? 'px-px py-0.5' : 'p-0.5', d === today && 'bg-primary/5')}>
                <button
                  type="button"
                  data-cell-key={key}
                  data-staged={isStaged || undefined}
                  aria-label={label}
                  title={label}
                  onPointerDown={(e) => onCellPointerDown(e, key)}
                  onClick={(e) => { if (e.detail === 0) onKeyPaint(key); }}
                  className={cn(
                    'relative flex w-full select-none items-center justify-center rounded-md border font-medium tabular-nums leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    month ? 'h-8 px-0 text-[10px]' : 'h-9 px-0.5 text-[11px]',
                    tone,
                    isStaged && 'ring-2 ring-amber-500 ring-offset-1 ring-offset-card',
                  )}>
                  {shown.kind === 'shift' && (month
                    ? <span className="flex flex-col items-center leading-[1.05]"><span>{shown.start.slice(0, 2)}</span><span>{shown.end.slice(0, 2)}</span></span>
                    : shortWindow(shown.start, shown.end))}
                  {isStaged && <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />}
                </button>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
