import { useEffect, useRef } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Link } from 'react-router-dom';
import { FileEdit, Link2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent } from '@/components/ui/popover';
import type { CoverageCell, ScriptGroup, TargetedScript } from '@/lib/callScriptsTypes';
import { CELL_GLYPH, cellState, draftsForCell, editorHref } from '../scriptsModel';
import { useScriptLabels } from '../parts';

export interface ActiveCell {
  /** Where the popover points (the clicked cell, viewport coordinates). */
  rect: { left: number; top: number; width: number; height: number };
  group: ScriptGroup;
  /** null = the "Сите производи" row. */
  row: { key: string; name: string; product_ids: string[] } | null;
  cell: CoverageCell;
}

/**
 * One cell's story: who gets those calls today (and at which level), the draft that would win
 * once published, how many published scripts compete, the drafts aimed at it — and the two ways
 * to fill it: "Нова скрипта за <производ> · <група>" (the editor, already aimed) or "Закачи
 * постоечка…" (bulk attach). One popover for the whole grid, anchored at the clicked cell.
 */
export function CoverageCellPopover({ active, onClose, library, canWrite, onAttach }: {
  active: ActiveCell | null;
  onClose: () => void;
  library: readonly TargetedScript[];
  canWrite: boolean;
  onAttach: (a: ActiveCell) => void;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const contentRef = useRef<HTMLDivElement>(null);
  // The anchor is fixed to where the cell WAS: a scroll of the page / grid closes the popover.
  useEffect(() => {
    if (!active) return;
    const close = (e: Event) => { if (e.target instanceof Node && contentRef.current?.contains(e.target)) return; onClose(); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [active, onClose]);

  const a = active;
  const st = a ? cellState(a.cell) : 'none';
  const drafts = a ? draftsForCell(library, a.group, a.row?.product_ids ?? null) : [];
  const productLabel = a?.row ? a.row.name : t('callScripts.coverage.allProducts');

  return (
    <Popover open={!!a} onOpenChange={(o) => { if (!o) onClose(); }}>
      <PopoverPrimitive.Anchor asChild>
        <span aria-hidden style={a ? { position: 'fixed', left: a.rect.left, top: a.rect.top, width: a.rect.width, height: a.rect.height, pointerEvents: 'none' } : { display: 'none' }} />
      </PopoverPrimitive.Anchor>
      {a && (
        <PopoverContent ref={contentRef} align="center" collisionPadding={12} className="w-[min(22rem,calc(100vw-2rem))] space-y-3 p-3" data-testid="cell-popover">
          <div>
            <p className="break-words text-sm font-semibold">{productLabel} · {L.group(a.group)}</p>
            <p className="text-xs text-muted-foreground">
              {t('callScripts.coverage.cellWaiting', { waiting: L.int(a.cell.waiting), assigned: L.int(a.cell.assigned) })}
            </p>
          </div>
          <div className="space-y-1 rounded-lg border p-2 text-xs">
            <p className="flex items-center gap-1.5 font-medium">
              <span aria-hidden className="font-bold">{CELL_GLYPH[st]}</span>{t(`callScripts.coverage.state.${st}`)}
            </p>
            {a.cell.winner ? (
              <Link to={editorHref({ id: a.cell.winner.script_id, from: 'coverage' })} className="block break-words text-primary hover:underline" data-testid="cell-winner">
                {a.cell.winner.title}
              </Link>
            ) : <p className="text-muted-foreground">{t('callScripts.coverage.noWinner')}</p>}
            {a.cell.overlap > 1 && <p className="text-muted-foreground">{t('callScripts.coverage.overlap', { n: a.cell.overlap })}</p>}
            {a.cell.draft_winner && a.cell.draft_winner.script_id !== a.cell.winner?.script_id && (
              <p className="break-words text-amber-800 dark:text-amber-300">
                {t('callScripts.coverage.draftWould')}{' '}
                <Link to={editorHref({ id: a.cell.draft_winner.script_id, from: 'coverage' })} className="underline">{a.cell.draft_winner.title}</Link>
              </p>
            )}
          </div>
          {drafts.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('callScripts.coverage.drafts', { n: drafts.length })}</p>
              <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs">
                {drafts.slice(0, 10).map((d) => (
                  <li key={d.id} className="flex items-start gap-1.5">
                    <FileEdit className="mt-0.5 h-3 w-3 shrink-0 text-amber-600" aria-hidden />
                    <Link to={editorHref({ id: d.id, from: 'coverage' })} className="min-w-0 break-words hover:underline">{d.title}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {canWrite && (
            <div className="flex flex-col gap-1.5">
              <Button asChild size="sm" className="h-9 justify-start" data-testid="cell-new">
                <Link to={editorHref({ groups: [a.group], products: a.row?.product_ids ?? [], from: 'coverage' })}>
                  <Plus className="mr-1.5 h-4 w-4 shrink-0" aria-hidden />
                  <span className="truncate">{t('callScripts.coverage.newFor', { product: productLabel, group: L.group(a.group) })}</span>
                </Link>
              </Button>
              <Button size="sm" variant="outline" className="h-9 justify-start" onClick={() => onAttach(a)} data-testid="cell-attach">
                <Link2 className="mr-1.5 h-4 w-4 shrink-0" aria-hidden />{t('callScripts.coverage.attachExisting')}
              </Button>
            </div>
          )}
        </PopoverContent>
      )}
    </Popover>
  );
}
