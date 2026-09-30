import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { formatDmy } from '@/components/insights/shared/period';
import { cellKey, isoDow, type GridCell, type GridPerson, type StagedCell } from '@/lib/shiftsApi';
import { NEUTRAL_TONE, OFF_TONE, shownCell, shownKey, type Brush } from './model';
import type { PersonGroup } from './ShiftGrid';
import { BrushChips } from './BrushChips';

/**
 * The roster below md: a strip of the week's days (7 buttons, no sideways scroll) and the agents
 * as a list for the chosen day. Tapping an agent opens a sheet with the brushes; picking one
 * stages that person-day (saved with the same [Зачувај (N)] as the grid).
 */
export function ShiftDayList({
  days, today, day, onDay, groups, stored, staged, tones, brushes, onSet,
}: {
  days: string[];
  today: string;
  day: string;
  onDay: (d: string) => void;
  groups: PersonGroup[];
  stored: ReadonlyMap<string, GridCell>;
  staged: ReadonlyMap<string, StagedCell>;
  tones: ReadonlyMap<string, string>;
  brushes: Brush[];
  onSet: (key: string, brushKey: string) => void;
}) {
  const { t } = useTranslation();
  const [pick, setPick] = useState<GridPerson | null>(null);

  return (
    <div className="space-y-3 md:hidden" data-testid="shift-day-list">
      <div role="group" aria-label={t('shiftsPage.grid.day')} className="grid grid-cols-7 gap-1">
        {days.slice(0, 7).map((d) => {
          const on = d === day;
          return (
            <button key={d} type="button" aria-pressed={on} onClick={() => onDay(d)}
              className={cn(
                'flex min-h-11 flex-col items-center justify-center rounded-lg border text-[11px] leading-tight tabular-nums transition-colors',
                on ? 'border-foreground/60 bg-muted font-semibold' : 'bg-card hover:bg-muted',
                d === today && !on && 'border-primary text-primary',
                isoDow(d) >= 6 && !on && 'text-muted-foreground',
              )}>
              <span>{t(`shiftsPage.dow.${isoDow(d)}`)}</span>
              <span>{d.slice(8, 10)}.{d.slice(5, 7)}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">{t('shiftsPage.grid.phoneHint')}</p>

      {groups.map((g) => (
        <section key={g.key} aria-label={g.label} className="space-y-1.5">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {g.label} · {t('shiftsPage.grid.people', { count: g.people.length })}
          </h4>
          <ul className="space-y-1.5">
            {g.people.map((p) => {
              const key = cellKey(p.user_id, day);
              const shown = shownCell(stored.get(key), staged.get(key));
              const isStaged = staged.has(key);
              const tone = shown.kind === 'off' ? OFF_TONE : tones.get(shownKey(shown)) ?? NEUTRAL_TONE;
              return (
                <li key={p.user_id}>
                  <button type="button" onClick={() => setPick(p)} data-person={p.user_id}
                    className={cn('flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border bg-card px-3 py-2 text-left shadow-sm',
                      isStaged && 'ring-2 ring-amber-500')}>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{p.name}</span>
                      {!p.gated && <span className="block text-[11px] text-muted-foreground">{t('shiftsPage.grid.bypassBadge')}</span>}
                    </span>
                    <span className={cn('shrink-0 rounded-md border px-2 py-1 text-xs font-medium tabular-nums', tone)}>
                      {shown.kind === 'off' ? t('shiftsPage.grid.off') : `${shown.start}–${shown.end}`}
                      {isStaged && <span className="sr-only"> · {t('shiftsPage.grid.staged')}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <Sheet open={!!pick} onOpenChange={(v) => { if (!v) setPick(null); }}>
        <SheetContent side="bottom" className="max-h-[80dvh] overflow-y-auto">
          <SheetHeader className="text-left">
            <SheetTitle>{pick ? t('shiftsPage.grid.pickTitle', { name: pick.name, date: formatDmy(day) }) : ''}</SheetTitle>
            <SheetDescription>{t('shiftsPage.grid.pickDesc')}</SheetDescription>
          </SheetHeader>
          {pick && (
            <BrushChips className="mt-4" brushes={brushes} tones={tones} selected={null}
              onSelect={(bk) => { onSet(cellKey(pick.user_id, day), bk); setPick(null); }} />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
