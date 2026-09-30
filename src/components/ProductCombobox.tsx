import { useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { normalizeForSearch } from '@/lib/transliterate';

interface ProductOption {
  id: string;
  name: string;
  is_active?: boolean;
  [k: string]: any;
}

interface ProductComboboxProps {
  products: ProductOption[];
  value: string | null;
  /** Stored line name — shown when value is null (legacy free-text line) or
   *  points to a product that's no longer in the active catalogue. */
  productName?: string;
  onChange: (productId: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Wide, searchable product picker used by the order Create + Edit modals.
 *
 * Search is Cyrillic↔Latin aware via `normalizeForSearch` (transliterate.ts):
 * typing "d" OR "д" both surface "Диабетол" / "Diabetol", so agents never have
 * to switch keyboard layout to match a product's stored script. Filtering is
 * done here (shouldFilter={false}) so we control the fold + prefix-first order.
 */
export function ProductCombobox({ products, value, productName, onChange, disabled, className }: ProductComboboxProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const selected = value ? products.find(p => p.id === value) : null;
  const displayName = selected?.name || productName || '';

  const active = products.filter(p => p.is_active);
  const q = normalizeForSearch(search.trim());
  const filtered = !q
    ? active
    : active
        .map(p => ({ p, n: normalizeForSearch(p.name) }))
        .filter(x => x.n.includes(q))
        // Prefix matches first ("диа" → Диабетол before any mid-word hit),
        // then alphabetical for a stable, predictable list.
        .sort((a, b) => {
          const ap = a.n.startsWith(q) ? 0 : 1;
          const bp = b.n.startsWith(q) ? 0 : 1;
          if (ap !== bp) return ap - bp;
          return a.n.localeCompare(b.n);
        })
        .map(x => x.p);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setSearch(''); }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          // min-w-0: a long product name must never push the row's delete button out
          // of a 360 px phone; the name wraps (two lines) instead of being clipped.
          className={cn('h-auto min-h-9 w-full min-w-0 justify-between py-1.5 font-normal', !displayName && 'text-muted-foreground', className)}
        >
          <span className="line-clamp-2 min-w-0 flex-1 whitespace-normal break-words text-left">{displayName || t('orderModal.chooseProduct')}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder={t('orderModal.searchProduct')} />
          <CommandList>
            {filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">{t('orderModal.noProductFound')}</div>
            ) : (
            <CommandGroup>
              {filtered.map(p => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  // Close over the product — don't trust cmdk's onSelect arg
                  // (it lowercases the value), same pattern as the agent picker.
                  onSelect={() => { onChange(p.id); setSearch(''); setOpen(false); }}
                  className="cursor-pointer"
                >
                  <Check className={cn('mr-2 h-4 w-4 shrink-0', value === p.id ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{p.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
