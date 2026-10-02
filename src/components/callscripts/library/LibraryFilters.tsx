import { useRef } from 'react';
import { Search, X } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { ALL_GROUPS, type ProductIndexRow, type ScriptGroup } from '@/lib/callScriptsTypes';
import {
  DEFAULT_LIBRARY_FILTERS, LIBRARY_STATUSES, hasLibraryFilters, type LibraryFilters as Filters, type LibraryStatus,
} from '../scriptsModel';
import { chip, chipOff, chipOn, groupLabelCls, useScriptLabels } from '../parts';
import { ProductPicker } from '../editor/ProductPicker';

const ANY = '__any__';

/**
 * The library's toolbar (Insights filter-bar style): search over every text (Cyrillic ⇄ Latin),
 * "N од M", the status chips with what each would show, the group, the product (twins count), and
 * two toggles — "Без закачување" (general scripts) and "Со предупредувања". Agents see only the
 * search, the group and the product: they read published scripts only.
 */
export function LibraryFilters({ f, onChange, counts, shown, total, products, twins, productName, canWrite }: {
  f: Filters;
  onChange: (patch: Partial<Filters>) => void;
  counts: Record<LibraryStatus, number>;
  shown: number;
  total: number;
  products: readonly ProductIndexRow[];
  twins: Readonly<Record<string, readonly string[]>>;
  productName: (id: string) => string | undefined;
  canWrite: boolean;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div role="search" aria-label={t('callScripts.library.search')} className="space-y-2.5 rounded-xl border bg-card/80 p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 lg:max-w-xl">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input ref={inputRef} type="search" value={f.q} onChange={(e) => onChange({ q: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape' && f.q) { e.preventDefault(); onChange({ q: '' }); } }}
            placeholder={t('callScripts.library.search')} aria-label={t('callScripts.library.search')}
            autoComplete="off" spellCheck={false} enterKeyHint="search"
            className={cn('h-9 w-full rounded-lg border bg-background pl-8 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm [&::-webkit-search-cancel-button]:hidden', f.q ? 'pr-9' : 'pr-3')} />
          {f.q && (
            <button type="button" onClick={() => { onChange({ q: '' }); inputRef.current?.focus(); }} aria-label={t('common.clear')}
              className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted">
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 sm:ml-auto">
          <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite" data-testid="library-shown">
            {t('callScripts.library.shown', { shown: L.int(shown), total: L.int(total) })}
          </span>
          {hasLibraryFilters(f) && (
            <button type="button" onClick={() => onChange(DEFAULT_LIBRARY_FILTERS)}
              className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-xs font-medium text-muted-foreground hover:bg-muted lg:h-8">
              <X className="h-3.5 w-3.5" aria-hidden />{t('callScripts.library.clearFilters')}
            </button>
          )}
        </div>
      </div>

      {canWrite && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <span id="cs-status-filter" className={cn(groupLabelCls, 'w-16 shrink-0 basis-full sm:basis-auto')}>{t('callScripts.library.statusLabel')}</span>
          <div role="group" aria-labelledby="cs-status-filter" className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {LIBRARY_STATUSES.map((k) => (
              <button key={k} type="button" aria-pressed={f.status === k} onClick={() => onChange({ status: k })}
                className={cn(chip, f.status === k ? chipOn : chipOff)} data-testid={`status-chip-${k}`}>
                {k === 'all' ? t('common.all') : L.status(k)}
                <span className="tabular-nums opacity-70">{L.int(counts[k])}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={f.group ?? ANY} onValueChange={(v) => onChange({ group: v === ANY ? null : (v as ScriptGroup | 'every') })}>
          <SelectTrigger className="h-9 w-full min-w-0 sm:w-56 lg:h-8" aria-label={t('callScripts.library.groupLabel')} data-testid="library-group">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t('callScripts.library.groupAny')}</SelectItem>
            <SelectItem value="every">{t('callScripts.library.groupEvery')}</SelectItem>
            {ALL_GROUPS.map((g) => <SelectItem key={g} value={g}>{L.group(g)}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex min-w-0 basis-full items-center gap-1 sm:basis-auto">
          <ProductPicker single products={products} twins={twins} value={f.product ? [f.product] : []}
            onChange={(ids) => onChange({ product: ids[0] ?? null })} className="w-full sm:w-64 lg:h-8 lg:min-h-8" testId="library-product"
            label={f.product ? (productName(f.product) ?? t('callScripts.library.unknownProduct')) : t('callScripts.library.productAny')} />
          {f.product && (
            <button type="button" onClick={() => onChange({ product: null })} aria-label={t('common.clear')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted lg:h-8 lg:w-8">
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
        {canWrite && (
          <>
            <button type="button" aria-pressed={f.untargeted} onClick={() => onChange({ untargeted: !f.untargeted })}
              className={cn(chip, f.untargeted ? chipOn : chipOff)} data-testid="toggle-untargeted">
              {t('callScripts.library.untargeted')}
            </button>
            <button type="button" aria-pressed={f.warnings} onClick={() => onChange({ warnings: !f.warnings })}
              className={cn(chip, f.warnings ? chipOn : chipOff)} data-testid="toggle-warnings">
              {t('callScripts.library.withWarnings')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
