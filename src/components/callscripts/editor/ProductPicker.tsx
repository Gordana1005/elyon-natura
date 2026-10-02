import { useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { LINE_NAMES } from '@/lib/products/brandLines';
import { proposeProductsForTitle, type ProductIndexRow } from '@/lib/callScriptsTypes';
import {
  PICKER_KINDS, byBrandLine, searchProducts, withTwins, withoutFamily, type PickerKind,
} from '../scriptsModel';
import { chip, chipOff, chipOn, useScriptLabels } from '../parts';

/** Rendered rows are capped — 706 products in one list is a scroll nobody needs; search narrows it. */
const RENDER_CAP = 250;

/**
 * The product picker: a search (Cyrillic ⇄ Latin) over the catalogue grouped by brand line, a kind
 * filter, "Предлог од насловот" (the products the script's title names — proposeProductsForTitle),
 * "Избери ги сите (N)" for what the search shows, and twins: picking a product picks its catalogue
 * duplicates (the same normalised name) too, because the matcher treats them as one product.
 * `single` = pick one and close (the library's product filter).
 */
export function ProductPicker({
  products, value, onChange, twins, title, single = false, disabled, label, className, testId = 'product-picker',
}: {
  products: readonly ProductIndexRow[];
  value: readonly string[];
  onChange: (ids: string[]) => void;
  twins: Readonly<Record<string, readonly string[]>>;
  /** The script's title — feeds "Предлог од насловот". */
  title?: string;
  single?: boolean;
  disabled?: boolean;
  /** The trigger's text (default: "Избери производи"). */
  label?: ReactNode;
  className?: string;
  testId?: string;
}) {
  const L = useScriptLabels();
  const { t } = L;
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<PickerKind>('all');
  const selected = useMemo(() => new Set(value), [value]);

  const found = useMemo(() => searchProducts(products, q, kind), [products, q, kind]);
  const groups = useMemo(() => byBrandLine(found.slice(0, RENDER_CAP)), [found]);
  const proposals = useMemo(() => {
    if (single || !title?.trim() || q.trim()) return [];
    const byId = new Map(products.map((p) => [p.id, p]));
    return proposeProductsForTitle(title, products).map((p) => byId.get(p.product_id)!).filter(Boolean).slice(0, 12);
  }, [single, title, q, products]);

  const toggle = (id: string) => {
    if (single) {
      onChange(selected.has(id) ? [] : [id]);
      setOpen(false);
      setQ('');
      return;
    }
    onChange(selected.has(id) ? withoutFamily(value, id, twins) : withTwins([...value, id], twins));
  };
  const addAll = (ids: string[]) => onChange(withTwins([...value, ...ids], twins));

  const item = (p: ProductIndexRow) => (
    <CommandItem key={p.id} value={p.id} onSelect={() => toggle(p.id)} className="cursor-pointer gap-2" data-testid={`pick-${p.id}`}>
      <Check className={cn('h-4 w-4 shrink-0', selected.has(p.id) ? 'opacity-100' : 'opacity-0')} aria-hidden />
      <span className={cn('min-w-0 flex-1 break-words', !p.is_active && 'text-muted-foreground')}>{p.name}</span>
      {p.kind && p.kind !== 'product' && (
        <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">{t(`products.kind.${p.kind}`, { defaultValue: p.kind })}</span>
      )}
      {!p.is_active && <span className="shrink-0 text-[10px] text-muted-foreground">{t('products.disabled')}</span>}
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(''); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-expanded={open} disabled={disabled}
          className={cn('h-auto min-h-9 min-w-0 justify-between gap-2 py-1.5 font-normal', className)} data-testid={testId}>
          <span className="min-w-0 flex-1 truncate text-left">{label ?? t('callScripts.editor.pickProducts')}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(30rem,calc(100vw-2rem))] p-0">
        <Command shouldFilter={false}>
          <CommandInput value={q} onValueChange={setQ} placeholder={t('callScripts.editor.searchProducts')} />
          <div className="flex flex-wrap gap-1 border-b p-2" role="group" aria-label={t('products.kind.label')}>
            {PICKER_KINDS.map((k) => (
              <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
                className={cn(chip, 'h-7 px-2.5 text-[11px] lg:h-7', kind === k ? chipOn : chipOff)}>
                {k === 'all' ? t('common.all') : t(`products.kind.${k}`)}
              </button>
            ))}
          </div>
          {!single && (
            <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5 text-xs">
              <span className="text-muted-foreground">{t('callScripts.editor.pickedN', { n: value.length })}</span>
              {proposals.length > 0 && (
                <button type="button" onClick={() => addAll(proposals.map((p) => p.id))}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline" data-testid="pick-proposals">
                  <Sparkles className="h-3 w-3" aria-hidden />{t('callScripts.editor.addProposals', { n: proposals.length })}
                </button>
              )}
              {found.length > 0 && (
                <button type="button" onClick={() => addAll(found.map((p) => p.id))} className="font-medium text-primary hover:underline"
                  data-testid="pick-all">
                  {t('callScripts.editor.selectAllShown', { n: found.length })}
                </button>
              )}
              {value.length > 0 && (
                <button type="button" onClick={() => onChange([])} className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" aria-hidden />{t('common.clear')}
                </button>
              )}
            </div>
          )}
          <CommandList className="max-h-[min(22rem,50vh)]">
            {proposals.length > 0 && (
              <CommandGroup heading={t('callScripts.editor.fromTitle')} data-testid="title-proposals">
                {proposals.map(item)}
              </CommandGroup>
            )}
            {found.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">{t('callScripts.editor.noProductFound')}</div>
            ) : groups.map((g) => (
              <CommandGroup key={g.line ?? 'none'} heading={g.line ? LINE_NAMES[g.line] : t('products.line.none')}>
                {g.products.map(item)}
              </CommandGroup>
            ))}
            {found.length > RENDER_CAP && (
              <p className="px-3 py-2 text-[11px] text-muted-foreground">{t('callScripts.editor.cappedHint', { shown: RENDER_CAP, total: found.length })}</p>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The picked products as removable chips ("Сите производи" when none). Removing one removes its twins. */
export function PickedProducts({ value, onChange, twins, name, disabled }: {
  value: readonly string[];
  onChange: (ids: string[]) => void;
  twins: Readonly<Record<string, readonly string[]>>;
  name: (id: string) => string | undefined;
  disabled?: boolean;
}) {
  const L = useScriptLabels();
  if (!value.length) return <p className="text-xs text-muted-foreground">{L.t('callScripts.editor.everyProductHint')}</p>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label={L.t('callScripts.editor.products')}>
      {value.map((id) => (
        <li key={id} className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/40 py-0.5 pl-2.5 pr-1 text-xs">
          <span className="min-w-0 break-words">{name(id) ?? L.t('callScripts.library.unknownProduct')}</span>
          {!disabled && (
            <button type="button" onClick={() => onChange(withoutFamily(value, id, twins))}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={L.t('callScripts.editor.removeProduct', { name: name(id) ?? '' })}>
              <X className="h-3 w-3" aria-hidden />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
