import { Link } from 'react-router-dom';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import type { TargetedScript } from '@/lib/callScriptsTypes';
import { isLegacy } from '../scriptsModel';
import { GroupBadges, ProductNames, StatusBadge, WarningsBadge, useScriptLabels } from '../parts';

export interface LibraryListProps {
  rows: readonly TargetedScript[];
  /** Admins and managers who may write: rows can be selected for the bulk bar. */
  selectable: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (on: boolean) => void;
  hrefOf: (s: TargetedScript) => string;
  productName: (id: string) => string | undefined;
}

/**
 * The library from md: one row per script — title (status, warnings, description), the groups,
 * the products, the priority and who changed it last. The table wraps its text (table-fixed);
 * it never scrolls sideways. Legacy rows (today's /calls panel) are not selectable.
 */
export function LibraryTable({ rows, selectable, selected, onToggle, onToggleAll, hrefOf, productName }: LibraryListProps) {
  const L = useScriptLabels();
  const { t } = L;
  const pickable = rows.filter((r) => !isLegacy(r));
  const allOn = pickable.length > 0 && pickable.every((r) => selected.has(r.id));
  const someOn = !allOn && pickable.some((r) => selected.has(r.id));
  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <table className="w-full table-fixed text-sm" data-testid="library-table">
        <caption className="sr-only">{t('callScripts.library.title')}</caption>
        <thead>
          <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            {selectable && (
              <th scope="col" className="w-10 px-3 py-2">
                <Checkbox checked={allOn ? true : someOn ? 'indeterminate' : false} onCheckedChange={(v) => onToggleAll(v === true)}
                  aria-label={t('callScripts.bulk.selectAll')} />
              </th>
            )}
            <th scope="col" className="px-3 py-2 font-medium">{t('callScripts.library.colScript')}</th>
            <th scope="col" className="w-[24%] px-3 py-2 font-medium">{t('callScripts.library.colGroups')}</th>
            <th scope="col" className="w-[22%] px-3 py-2 font-medium">{t('callScripts.library.colProducts')}</th>
            <th scope="col" className="hidden w-20 px-3 py-2 text-right font-medium lg:table-cell">{t('callScripts.library.colPriority')}</th>
            <th scope="col" className="hidden w-40 px-3 py-2 font-medium lg:table-cell">{t('callScripts.library.colUpdated')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const legacy = isLegacy(s);
            return (
              <tr key={s.id} className={cn('border-b align-top last:border-0 hover:bg-muted/30', selected.has(s.id) && 'bg-primary/5')} data-testid={`library-row-${s.id}`}>
                {selectable && (
                  <td className="px-3 py-2.5">
                    <Checkbox checked={selected.has(s.id)} disabled={legacy} onCheckedChange={() => onToggle(s.id)}
                      aria-label={t('callScripts.bulk.selectOne', { title: s.title })} />
                  </td>
                )}
                <td className="min-w-0 px-3 py-2.5">
                  <Link to={hrefOf(s)} className="break-words font-medium text-foreground hover:text-primary hover:underline">
                    {s.title || t('callScripts.editor.untitled')}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <StatusBadge script={s} />
                    <WarningsBadge script={s} />
                    {s.priority !== 0 && <span className="text-[11px] text-muted-foreground lg:hidden">{t('callScripts.library.priorityN', { n: s.priority })}</span>}
                  </div>
                  {s.description && <p className="mt-1 break-words text-xs text-muted-foreground">{s.description}</p>}
                  <p className="mt-1 text-[11px] text-muted-foreground lg:hidden">{L.date(s.updated_at)}{s.updated_by_name ? ` · ${s.updated_by_name}` : ''}</p>
                </td>
                <td className="px-3 py-2.5">{legacy ? <span className="text-xs text-muted-foreground">{t('callScripts.library.legacyPanel')}</span> : <GroupBadges groups={s.groups} />}</td>
                <td className="px-3 py-2.5">{legacy ? <span className="text-xs text-muted-foreground">—</span> : <ProductNames ids={s.product_ids} name={productName} />}</td>
                <td className="hidden px-3 py-2.5 text-right tabular-nums lg:table-cell">{s.priority}</td>
                <td className="hidden px-3 py-2.5 text-xs lg:table-cell">
                  <span className="block tabular-nums">{L.date(s.updated_at)}</span>
                  {s.updated_by_name && <span className="block break-words text-muted-foreground">{s.updated_by_name}</span>}
                  <span className="block text-muted-foreground">v{s.version}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
