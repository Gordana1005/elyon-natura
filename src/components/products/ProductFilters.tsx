import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { LINE_FILTERS, LINE_NAMES, type BrandLine, type LineFilter } from '@/lib/products/brandLines';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { LineOptions } from './LineChip';

// The chips of the Insights filter bars (users/UserFilters): a single choice is
// a filled chip. 36 px tall on phones and tablets (touch), 32 px from lg.
export const chip = 'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-8';
export const chipOne = 'border-foreground/80 bg-foreground text-background';
export const chipOff = 'bg-card text-foreground hover:bg-muted';
const groupLabel = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';

/**
 * The toolbar above the catalogue: search (name, SKU or category — Cyrillic or
 * Latin; Esc clears), "N од M", and the line chips Сите · Natura Therapy · Bio
 * Natural · Ad Astra · Dr.Becker · Неодредено with their counts over ALL
 * products. For a login that sets lines, "select all shown" too.
 */
export function ProductFilters({ query, onQuery, line, onLine, counts, shown, total, canSelect, onSelectShown, f }: {
  query: string;
  onQuery: (q: string) => void;
  line: LineFilter;
  onLine: (l: LineFilter) => void;
  counts: Record<LineFilter, number>;
  shown: number;
  total: number;
  canSelect: boolean;
  onSelectShown: () => void;
  f: InsightsFormat;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();
  const filtering = line !== 'all' || query.trim() !== '';
  const lineLabel = (k: LineFilter) => (k === 'all' ? t('products.line.all') : k === 'none' ? t('products.line.none') : LINE_NAMES[k]);

  return (
    <div role="search" aria-label={t('products.searchPlaceholder')} className="space-y-2 rounded-xl border bg-card/80 p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="relative min-w-0 basis-full sm:basis-auto sm:flex-1 lg:max-w-xl">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) { e.preventDefault(); onQuery(''); }
            }}
            placeholder={isMobile ? t('products.searchShort') : t('products.searchPlaceholder')}
            aria-label={t('products.searchPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            className={cn(
              // 16 px below md: iOS Safari zooms into any smaller input on focus.
              'h-9 w-full rounded-lg border bg-background pl-8 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm [&::-webkit-search-cancel-button]:hidden',
              query ? 'pr-9' : 'pr-3',
            )}
          />
          {query && (
            <button type="button" onClick={() => { onQuery(''); inputRef.current?.focus(); }}
              aria-label={t('products.clearSearch')} title={t('products.clearSearch')}
              className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite" data-testid="products-shown">
            {t('products.shown', { shown: f.int(shown), total: f.int(total) })}
          </span>
          {canSelect && shown > 0 && (
            <button type="button" onClick={onSelectShown}
              className="inline-flex h-9 items-center whitespace-nowrap rounded-lg border px-3 text-xs font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-8">
              {t('products.bulk.selectAllShown', { n: f.int(shown) })}
            </button>
          )}
          {filtering && (
            <button type="button" onClick={() => { onQuery(''); onLine('all'); }}
              className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-8">
              <X className="h-3.5 w-3.5" aria-hidden />{t('products.clearFilters')}
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className={cn(groupLabel, 'basis-full sm:basis-auto')} id="products-line-filter">{t('products.colLine')}</span>
        <div role="group" aria-labelledby="products-line-filter" className="flex min-w-0 flex-wrap items-center gap-1.5">
          {LINE_FILTERS.map((k) => (
            <button key={k} type="button" aria-pressed={line === k} onClick={() => onLine(k)}
              className={cn(chip, line === k ? chipOne : chipOff)}>
              {lineLabel(k)}
              <span className="tabular-nums opacity-70">{f.int(counts[k])}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The selection bar: "Избрани: N" · "Постави линија" (the four lines and "not
 * decided") · clear. Sticky at the bottom of the list so it stays in reach
 * while scrolling a long catalogue.
 */
export function BulkLineBar({ count, busy, onSet, onClear, f }: {
  count: number;
  busy: boolean;
  onSet: (line: BrandLine | null) => void;
  onClear: () => void;
  f: InsightsFormat;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div role="region" aria-label={t('products.bulk.setLine')}
      className="sticky bottom-3 z-30 flex flex-wrap items-center gap-2 rounded-xl border bg-card p-2 shadow-lg">
      <span className="px-1 text-sm font-medium tabular-nums" data-testid="products-selected">
        {t('products.bulk.selected', { n: f.int(count) })}
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" className="h-9" disabled={busy}>
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
            {t('products.bulk.setLine')}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-2">
          <p className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t('products.bulk.setLineFor', { n: f.int(count) })}
          </p>
          <LineOptions current={undefined} onPick={(l) => { setOpen(false); onSet(l); }} />
        </PopoverContent>
      </Popover>
      <Button variant="ghost" size="sm" className="ml-auto h-9" onClick={onClear} disabled={busy}>
        <X className="mr-1.5 h-4 w-4" aria-hidden />{t('products.bulk.clearSelection')}
      </Button>
    </div>
  );
}
