import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trophy } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { CoverageResponse, ProductIndexRow, TargetedScript } from '@/lib/callScriptsTypes';
import { editorHref, editorWins } from '../scriptsModel';
import { card, useScriptLabels } from '../parts';

/**
 * "Каде победува" — every cell the script is aimed at (its groups × its products; with no
 * products: "no product" + every product clients are waiting for) and who would get that call
 * if it were published now (the server's own matcher). The lost cells with the most waiting
 * clients are listed with the script that beats it.
 */
export function WhereItWins({ target, library, products, coverage }: {
  target: TargetedScript;
  library: readonly TargetedScript[];
  products: readonly ProductIndexRow[];
  coverage?: CoverageResponse | null;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const [withDrafts, setWithDrafts] = useState(false);
  const names = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  const titles = useMemo(() => new Map(library.map((s) => [s.id, s.title])), [library]);
  const res = useMemo(
    () => editorWins(target, library, { coverage, products, includeDrafts: withDrafts, limit: 8 }),
    [target, library, coverage, products, withDrafts],
  );
  const total = res.cells.length;
  const pct = total ? Math.round((res.wins / total) * 100) : 0;

  return (
    <section className={cn(card, 'space-y-3 p-3 sm:p-4')} aria-labelledby="cs-wins" data-testid="where-it-wins">
      <div className="flex flex-wrap items-center gap-2">
        <Trophy className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <h3 id="cs-wins" className="min-w-0 flex-1 text-sm font-semibold">{t('callScripts.editor.wins')}</h3>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={withDrafts} onCheckedChange={setWithDrafts} aria-label={t('callScripts.editor.winsWithDrafts')} />
          {t('callScripts.editor.winsWithDrafts')}
        </label>
      </div>
      <p className="text-sm" data-testid="wins-summary">{t('callScripts.editor.winsSummary', { wins: L.int(res.wins), total: L.int(total) })}</p>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
      {res.lost.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('callScripts.editor.winsLost')}</p>
          <ul className="space-y-1">
            {res.lost.map((c) => (
              <li key={`${c.group}|${c.product_id ?? ''}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md bg-muted/30 px-2 py-1.5 text-xs">
                <span className="min-w-0 font-medium">{L.group(c.group)} · {c.product_id ? (names.get(c.product_id) ?? t('callScripts.library.unknownProduct')) : t('callScripts.editor.noProduct')}</span>
                <span className="text-muted-foreground">→</span>
                {c.winner_id ? (
                  <Link to={editorHref({ id: c.winner_id })} className="min-w-0 break-words text-primary hover:underline">{titles.get(c.winner_id) ?? c.winner_id}</Link>
                ) : <span className="text-muted-foreground">{t('callScripts.editor.winsNobody')}</span>}
                {c.waiting > 0 && <span className="ml-auto tabular-nums text-muted-foreground">{t('callScripts.editor.waitingN', { n: L.int(c.waiting) })}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
