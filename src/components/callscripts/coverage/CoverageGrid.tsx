import type { MouseEvent } from 'react';
import { cn } from '@/lib/utils';
import { LINE_NAMES, type BrandLine } from '@/lib/products/brandLines';
import type { CoverageCell, CoverageResponse, CoverageRow, ScriptGroup } from '@/lib/callScriptsTypes';
import { GROUP_FAMILIES, cellState } from '../scriptsModel';
import { useScriptLabels } from '../parts';
import { CellFace, cellClasses } from './cellStyle';
import type { ActiveCell } from './CoverageCellPopover';

/**
 * The product × group grid (md+): a card with its OWN horizontal scroll (the page never scrolls
 * sideways), the product column sticky on the left, the 12 groups under two headers — Лидови /
 * Предикција — and the "Сите производи" row on top. Each cell: ✓ product + group · ◐ group only ·
 * ○ product only · · general · — none (red when clients wait), dashed when only a draft would win,
 * ×N when scripts compete; the number = clients waiting. A click opens the cell's popover.
 */
export function CoverageGrid({ coverage, rows, onCell, active }: {
  coverage: CoverageResponse;
  rows: readonly CoverageRow[];
  onCell: (a: ActiveCell) => void;
  active: ActiveCell | null;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const groups = coverage.groups.length ? coverage.groups : GROUP_FAMILIES.flatMap((f) => f.groups);
  const fams = GROUP_FAMILIES.map((f) => ({ ...f, groups: f.groups.filter((g) => groups.includes(g)) })).filter((f) => f.groups.length);
  const int = (n: number) => L.int(n);

  const click = (e: MouseEvent<HTMLButtonElement>, group: ScriptGroup, row: CoverageRow | null, cell: CoverageCell) => {
    const r = e.currentTarget.getBoundingClientRect();
    onCell({ rect: { left: r.left, top: r.top, width: r.width, height: r.height }, group, row: row ? { key: row.key, name: row.name, product_ids: row.product_ids } : null, cell });
  };
  const isActive = (g: ScriptGroup, key: string | null) => !!active && active.group === g && (active.row?.key ?? null) === key;

  const cellBtn = (g: ScriptGroup, row: CoverageRow | null, cell: CoverageCell | undefined, rowName: string) => {
    const c: CoverageCell = cell ?? { waiting: 0, assigned: 0, winner: null, draft_winner: null, overlap: 0 };
    const st = cellState(c);
    return (
      <td key={g} className="border-b border-r border-border/40 p-0.5 last:border-r-0">
        <button type="button" onClick={(e) => click(e, g, row, c)} aria-haspopup="dialog" aria-expanded={isActive(g, row?.key ?? null)}
          aria-label={t('callScripts.coverage.cellAria', { product: rowName, group: L.group(g), state: t(`callScripts.coverage.state.${st}`), waiting: int(c.waiting) })}
          title={c.winner?.title ?? undefined}
          data-testid={`cell-${row?.key ?? 'all'}-${g}`} data-state={st}
          className={cn('flex h-9 w-full min-w-[3.25rem] items-center justify-center gap-1 rounded-md border px-1 text-[11px] transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            cellClasses(c), isActive(g, row?.key ?? null) && 'ring-2 ring-primary')}>
          <CellFace cell={c} int={int} />
        </button>
      </td>
    );
  };

  const stickyCol = 'sticky left-0 z-10 bg-card';
  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="overflow-x-auto overscroll-x-contain" data-testid="coverage-scroll">
        <table className="w-full min-w-[60rem] border-separate border-spacing-0 text-xs" data-testid="coverage-grid">
          <caption className="sr-only">{t('callScripts.coverage.title')}</caption>
          <thead>
            <tr>
              <th scope="col" rowSpan={2} className={cn(stickyCol, 'z-20 w-48 min-w-[11rem] max-w-[16rem] border-b border-r px-3 py-2 text-left align-bottom text-[11px] font-medium uppercase tracking-wide text-muted-foreground')}>
                {t('callScripts.coverage.colProduct')}
              </th>
              {fams.map((f) => (
                <th key={f.key} scope="colgroup" colSpan={f.groups.length} className="border-b border-r px-2 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wide last:border-r-0">
                  {L.family(f.key)}
                </th>
              ))}
            </tr>
            <tr>
              {fams.flatMap((f) => f.groups).map((g) => (
                <th key={g} scope="col" title={L.groupDesc(g)} className="border-b border-r px-1 py-1.5 text-center align-bottom text-[10px] font-medium leading-tight text-muted-foreground last:border-r-0">
                  <span className="block min-w-[3.25rem] break-words">{L.group(g)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="bg-muted/30" data-testid="coverage-all-row">
              <th scope="row" className={cn(stickyCol, 'border-b border-r bg-muted/60 px-3 py-1.5 text-left font-semibold backdrop-blur')}>
                <span className="block break-words">{t('callScripts.coverage.allProducts')}</span>
                <span className="block text-[10px] font-normal text-muted-foreground">{t('callScripts.coverage.allProductsHint')}</span>
              </th>
              {fams.flatMap((f) => f.groups).map((g) => cellBtn(g, null, coverage.all_products?.[g], t('callScripts.coverage.allProducts')))}
            </tr>
            {rows.map((r) => (
              <tr key={r.key} data-testid={`coverage-row-${r.key}`}>
                <th scope="row" className={cn(stickyCol, 'border-b border-r px-3 py-1.5 text-left font-medium')}>
                  <span className="block break-words leading-snug">{r.name}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] font-normal text-muted-foreground">
                    {r.brand_line && (LINE_NAMES as Record<string, string>)[r.brand_line] && <span>{LINE_NAMES[r.brand_line as BrandLine]}</span>}
                    <span className="tabular-nums">{t('callScripts.coverage.rowWaiting', { n: int(r.waiting) })}</span>
                    {r.product_ids.length > 1 && <span>{t('callScripts.coverage.twins', { n: r.product_ids.length })}</span>}
                  </span>
                </th>
                {fams.flatMap((f) => f.groups).map((g) => cellBtn(g, r, r.cells?.[g], r.name))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
