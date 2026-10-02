import { useState, type MouseEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { LINE_NAMES, type BrandLine } from '@/lib/products/brandLines';
import type { CoverageCell, CoverageResponse, CoverageRow, ScriptGroup } from '@/lib/callScriptsTypes';
import { GROUP_FAMILIES, cellState } from '../scriptsModel';
import { groupLabelCls, useScriptLabels } from '../parts';
import { CellFace, cellClasses } from './cellStyle';
import type { ActiveCell } from './CoverageCellPopover';

const PAGE = 25;

/**
 * The grid below md: one card per product (the "Сите производи" card first), its 12 groups as
 * rows under Лидови / Предикција — the state, the waiting clients and the script that gets them.
 * A tap opens the same cell popover as the grid. 25 products at a time.
 */
export function CoverageCards({ coverage, rows, onCell }: {
  coverage: CoverageResponse;
  rows: readonly CoverageRow[];
  onCell: (a: ActiveCell) => void;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const [shown, setShown] = useState(PAGE);
  const groups = coverage.groups.length ? coverage.groups : GROUP_FAMILIES.flatMap((f) => f.groups);
  const fams = GROUP_FAMILIES.map((f) => ({ ...f, groups: f.groups.filter((g) => groups.includes(g)) })).filter((f) => f.groups.length);
  const int = (n: number) => L.int(n);

  const click = (e: MouseEvent<HTMLButtonElement>, group: ScriptGroup, row: CoverageRow | null, cell: CoverageCell) => {
    const r = e.currentTarget.getBoundingClientRect();
    onCell({ rect: { left: r.left, top: r.top, width: r.width, height: r.height }, group, row: row ? { key: row.key, name: row.name, product_ids: row.product_ids } : null, cell });
  };

  const card = (row: CoverageRow | null, cells: Partial<Record<ScriptGroup, CoverageCell>>, title: string, sub: string) => (
    <li key={row?.key ?? '__all__'} className="rounded-xl border bg-card p-3 shadow-sm" data-testid={`coverage-card-${row?.key ?? 'all'}`}>
      <p className="break-words text-sm font-semibold">{title}</p>
      <p className="text-[11px] text-muted-foreground">{sub}</p>
      <div className="mt-2 space-y-2">
        {fams.map((f) => (
          <div key={f.key}>
            <p className={groupLabelCls}>{L.family(f.key)}</p>
            <ul className="mt-1 divide-y divide-border/50">
              {f.groups.map((g) => {
                const c: CoverageCell = cells[g] ?? { waiting: 0, assigned: 0, winner: null, draft_winner: null, overlap: 0 };
                const st = cellState(c);
                return (
                  <li key={g}>
                    <button type="button" onClick={(e) => click(e, g, row, c)} aria-haspopup="dialog" data-testid={`ccell-${row?.key ?? 'all'}-${g}`}
                      className="flex min-h-11 w-full items-center gap-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <span className={cn('flex h-8 min-w-[3.5rem] shrink-0 items-center justify-center gap-1 rounded-md border px-1 text-[11px]', cellClasses(c))}>
                        <CellFace cell={c} int={int} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium">{L.group(g)}</span>
                        <span className={cn('block break-words text-[11px]', c.winner ? 'text-muted-foreground' : c.waiting > 0 ? 'text-red-700 dark:text-red-300' : 'text-muted-foreground')}>
                          {c.winner ? c.winner.title : t(`callScripts.coverage.state.${st}`)}
                        </span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </li>
  );

  return (
    <div className="space-y-2">
      <ul className="space-y-2" data-testid="coverage-cards">
        {card(null, coverage.all_products ?? {}, t('callScripts.coverage.allProducts'), t('callScripts.coverage.allProductsHint'))}
        {rows.slice(0, shown).map((r) => card(r, r.cells ?? {}, r.name, [
          r.brand_line && (LINE_NAMES as Record<string, string>)[r.brand_line] ? LINE_NAMES[r.brand_line as BrandLine] : null,
          t('callScripts.coverage.rowWaiting', { n: int(r.waiting) }),
        ].filter(Boolean).join(' · ')))}
      </ul>
      {rows.length > shown && (
        <Button variant="outline" className="h-10 w-full" onClick={() => setShown((n) => n + PAGE)}>
          {t('callScripts.coverage.showMore', { n: Math.min(PAGE, rows.length - shown), left: rows.length - shown })}
        </Button>
      )}
    </div>
  );
}
