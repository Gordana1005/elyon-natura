import { Link } from 'react-router-dom';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { isLegacy } from '../scriptsModel';
import { GroupBadges, ProductNames, StatusBadge, WarningsBadge, groupLabelCls, useScriptLabels } from '../parts';
import type { LibraryListProps } from './LibraryTable';

/** The library below md: one card per script (title, status, groups, products, last change). */
export function LibraryCards({ rows, selectable, selected, onToggle, hrefOf, productName }: LibraryListProps) {
  const L = useScriptLabels();
  const { t } = L;
  return (
    <ul className="space-y-2" data-testid="library-cards">
      {rows.map((s) => {
        const legacy = isLegacy(s);
        return (
          <li key={s.id} className={cn('rounded-xl border bg-card p-3 shadow-sm', selected.has(s.id) && 'border-primary/50 bg-primary/5')}>
            <div className="flex items-start gap-3">
              {selectable && (
                <Checkbox className="mt-1" checked={selected.has(s.id)} disabled={legacy} onCheckedChange={() => onToggle(s.id)}
                  aria-label={t('callScripts.bulk.selectOne', { title: s.title })} />
              )}
              <div className="min-w-0 flex-1 space-y-2">
                <div>
                  <Link to={hrefOf(s)} className="break-words font-medium hover:text-primary hover:underline">{s.title || t('callScripts.editor.untitled')}</Link>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <StatusBadge script={s} />
                    <WarningsBadge script={s} />
                    {s.priority !== 0 && <span className="text-[11px] text-muted-foreground">{t('callScripts.library.priorityN', { n: s.priority })}</span>}
                  </div>
                  {s.description && <p className="mt-1 break-words text-xs text-muted-foreground">{s.description}</p>}
                </div>
                {legacy ? (
                  <p className="text-xs text-muted-foreground">{t('callScripts.library.legacyPanel')}</p>
                ) : (
                  <dl className="grid gap-1.5 text-xs">
                    <div className="min-w-0"><dt className={groupLabelCls}>{t('callScripts.library.colGroups')}</dt><dd className="mt-0.5"><GroupBadges groups={s.groups} max={6} /></dd></div>
                    <div className="min-w-0"><dt className={groupLabelCls}>{t('callScripts.library.colProducts')}</dt><dd className="mt-0.5"><ProductNames ids={s.product_ids} name={productName} /></dd></div>
                  </dl>
                )}
                <p className="text-[11px] text-muted-foreground">{L.date(s.updated_at)}{s.updated_by_name ? ` · ${s.updated_by_name}` : ''} · v{s.version}</p>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
