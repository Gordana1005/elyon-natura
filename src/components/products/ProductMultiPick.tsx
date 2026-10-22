import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Package, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { productFamilyKey, type ProductIndexRow } from '@/lib/callScriptsTypes';
import { searchProducts, twinsOf, withoutFamily, withTwins } from '@/components/callscripts/scriptsModel';

/** The api's MAX_PRODUCTS / MAX_FILTER_PRODUCTS — more in one filter is a mistake, not a use case. */
export const MAX_PICKED_PRODUCTS = 50;
/** Rows rendered before "search for more" — 700 products in one list is a scroll nobody needs. */
const RENDER_CAP = 150;

const ROW = 'flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:min-h-8';

/** GET /products rows → the picker's index (catalogue twins share `family`). */
export function toFilterProducts(rows: readonly { id: string; name?: string | null; brand_line?: string | null; kind?: string | null; is_active?: boolean | null }[] | null | undefined): ProductIndexRow[] {
  return (rows ?? [])
    .filter((p) => p?.id && (p.name ?? '').trim())
    .map((p) => ({
      id: p.id,
      name: String(p.name).trim(),
      brand_line: p.brand_line ?? null,
      kind: p.kind ?? null,
      is_active: p.is_active !== false,
      family: productFamilyKey(p.name),
    }));
}

/** The picked products, one per name (catalogue twins share one): what a chip or a summary shows. */
export function pickedNames(ids: readonly string[], products: readonly ProductIndexRow[]): { id: string; name: string }[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const id of ids) {
    const p = byId.get(id);
    const key = p ? p.family : id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id, name: p?.name ?? '…' });
  }
  return out;
}

/**
 * A multi-select over the product catalogue for a FILTER (owner 22.10.2026: "да филтрираме по продукт,
 * пример Urofix") — /orders → Филтри → Производ and the Assigner's product filter. Search Cyrillic ⇄
 * Latin (the call-scripts picker's searchProducts), active products first; "Избери ги сите прикажани"
 * takes every variant a search shows (Neurofix · Neurofix 1+1 · NEUROFIX BIONATURAL 30/1); catalogue
 * twins (the same name) are picked and removed together. Inline: the panel / sheet holds it; the
 * Assigner opens it from ProductFilterButton.
 */
export function ProductMultiPick({ products, value, onChange, testId = 'product-pick' }: {
  products: readonly ProductIndexRow[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const twins = useMemo(() => twinsOf(products), [products]);
  const picked = useMemo(() => new Set(value), [value]);
  const found = useMemo(() => searchProducts(products, q), [products, q]);
  // the picked ones stay in view (on top) whatever the search shows
  const shown = useMemo(() => {
    const top = products.filter((p) => picked.has(p.id));
    return [...top, ...found.filter((p) => !picked.has(p.id))];
  }, [products, found, picked]);
  const rows = shown.slice(0, RENDER_CAP);
  const allShown = withTwins([...value, ...found.map((p) => p.id)], twins);
  const canTakeAll = q.trim() !== '' && found.some((p) => !picked.has(p.id)) && allShown.length <= MAX_PICKED_PRODUCTS;
  const full = value.length >= MAX_PICKED_PRODUCTS;

  const toggle = (id: string) => {
    if (picked.has(id)) onChange(withoutFamily(value, id, twins));
    else if (!full) onChange(withTwins([...value, id], twins).slice(0, MAX_PICKED_PRODUCTS));
  };

  return (
    <div className="space-y-1" data-testid={testId}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('productFilter.search')} aria-label={t('productFilter.search')}
          className="h-9 pl-8 text-base md:h-8 md:text-sm" autoComplete="off" />
      </div>
      {(value.length > 0 || q.trim()) && (
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-[11px]">
          {value.length > 0 && <span className="text-muted-foreground">{t('productFilter.picked', { n: pickedNames(value, products).length })}</span>}
          {q.trim() !== '' && found.length > 0 && (
            <button type="button" disabled={!canTakeAll} onClick={() => onChange(allShown)} data-testid={`${testId}-all`}
              title={allShown.length > MAX_PICKED_PRODUCTS ? t('productFilter.tooMany', { max: MAX_PICKED_PRODUCTS }) : undefined}
              className="font-medium text-primary underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline">
              {t('productFilter.selectAllShown', { n: found.length })}
            </button>
          )}
          {value.length > 0 && (
            <button type="button" onClick={() => onChange([])} className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
              <X className="h-3 w-3" aria-hidden />{t('productFilter.clear')}
            </button>
          )}
        </div>
      )}
      <div role="group" aria-label={t('productFilter.label')} className="max-h-52 space-y-0.5 overflow-y-auto overscroll-contain pr-1">
        {rows.map((p) => {
          const on = picked.has(p.id);
          return (
            <button key={p.id} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(p.id)} data-testid={`${testId}-${p.id}`}
              disabled={!on && full}
              className={cn(ROW, on && 'bg-primary/10 font-medium text-primary', !p.is_active && !on && 'text-muted-foreground', !on && full && 'opacity-50')}>
              <span aria-hidden className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                on ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/45 bg-card',
              )}>
                {on && <Check className="h-3 w-3" />}
              </span>
              <span className="min-w-0 flex-1 break-words">{p.name}</span>
              {!p.is_active && <span className="shrink-0 text-[10px] text-muted-foreground">{t('productFilter.inactive')}</span>}
            </button>
          );
        })}
        {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('productFilter.empty')}</p>}
        {shown.length > RENDER_CAP && (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">{t('productFilter.capped', { shown: RENDER_CAP, total: shown.length })}</p>
        )}
      </div>
    </div>
  );
}

/** A button that opens ProductMultiPick in a popover (the Assigner's filter bar). */
export function ProductFilterButton({ products, value, onChange, className }: {
  products: readonly ProductIndexRow[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const names = pickedNames(value, products);
  const label = names.length === 0 ? t('productFilter.none')
    : names.length === 1 ? names[0].name
    : t('productFilter.many', { n: names.length });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t('productFilter.label')} data-testid="product-filter-button"
          className={cn(
            'inline-flex h-9 min-w-0 max-w-full items-center gap-1.5 rounded-lg border bg-background px-3 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:text-xs',
            names.length > 0 && 'border-primary/50 bg-primary/5 font-medium text-primary',
            className,
          )}>
          <Package className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="shrink-0 text-muted-foreground">{t('productFilter.label')}:</span>
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-2">
        <ProductMultiPick products={products} value={value} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}
