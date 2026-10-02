import { cn } from '@/lib/utils';
import type { CoverageCell } from '@/lib/callScriptsTypes';
import { CELL_GLYPH, cellAlert, cellDraftWins, cellState, type CellState } from '../scriptsModel';

/** One tone per state — always with its glyph and the waiting count, never colour alone. */
export const CELL_TONES: Record<CellState, string> = {
  product_group: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200',
  group: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200',
  product: 'border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-200',
  general: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300',
  none: 'border-transparent bg-transparent text-muted-foreground',
};
export const ALERT_TONE = 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300';
export const DRAFT_OUTLINE = 'outline-dashed outline-2 -outline-offset-2 outline-amber-500';

export function cellClasses(cell: CoverageCell | null | undefined): string {
  const st = cellState(cell);
  return cn(cellAlert(cell) ? ALERT_TONE : CELL_TONES[st], cellDraftWins(cell) && DRAFT_OUTLINE);
}

/** The glyph, the waiting count and (when scripts compete) "×N". */
export function CellFace({ cell, int }: { cell: CoverageCell | null | undefined; int: (n: number) => string }) {
  const st = cellState(cell);
  return (
    <>
      <span aria-hidden className="text-sm font-bold leading-none">{CELL_GLYPH[st]}</span>
      <span className="tabular-nums leading-none">{int(cell?.waiting ?? 0)}</span>
      {(cell?.overlap ?? 0) > 1 && <span className="text-[9px] font-semibold leading-none opacity-70" aria-hidden>×{cell!.overlap}</span>}
    </>
  );
}
