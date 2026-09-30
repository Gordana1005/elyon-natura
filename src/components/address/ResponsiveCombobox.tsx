import { useState, type ReactNode } from 'react';
import { ChevronsUpDown, Loader2, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

export interface ComboItem<T> {
  key: string;
  item: T;
  /** Main line. */
  label: ReactNode;
  /** Small secondary text on the right (postcode, zone). */
  hint?: ReactNode;
}

interface Props<T> {
  /** Text shown on the closed trigger (the current value), or '' for the placeholder. */
  value: string;
  placeholder: string;
  /** Drawer title / accessible name. */
  title: string;
  search: string;
  onSearch: (q: string) => void;
  items: ComboItem<T>[];
  onPick: (item: T) => void;
  loading?: boolean;
  /** Shown when there is nothing to list (empty search or no hit). */
  emptyText: string;
  /** "Use what I typed" — for free-text fields (a street MEX does not know). */
  freeText?: { label: (q: string) => string; onUse: (q: string) => void };
  onClear?: () => void;
  clearLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  /** Marks the field for "scroll to the first gap". */
  gap?: string;
  className?: string;
}

/**
 * One searchable picker for the order form: a Popover under the field from md up,
 * a bottom Drawer with the same cmdk search below md (the 390 px phone layout —
 * the list gets the whole width and the keyboard never covers the input). The
 * caller filters (server search or a local list), so cmdk's own filter is off.
 */
export function ResponsiveCombobox<T>({
  value, placeholder, title, search, onSearch, items, onPick, loading, emptyText, freeText, onClear, clearLabel,
  disabled, invalid, id, gap, className,
}: Props<T>) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const q = search.trim();

  const pick = (it: T) => { onPick(it); setOpen(false); };
  const use = () => { if (freeText && q) { freeText.onUse(q); setOpen(false); } };

  const body = (
    <Command shouldFilter={false} className="bg-transparent">
      <CommandInput value={search} onValueChange={onSearch} placeholder={placeholder} autoFocus className="h-11 text-base md:text-sm" />
      <CommandList className={cn(isMobile ? 'max-h-[55dvh]' : 'max-h-72')}>
        {loading && (
          <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          </div>
        )}
        {!loading && items.length === 0 && !(freeText && q) && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</div>
        )}
        {(items.length > 0 || (freeText && q)) && (
          <CommandGroup>
            {items.map((it) => (
              <CommandItem
                key={it.key}
                value={it.key}
                // Close over the item — never trust cmdk's lower-cased onSelect arg.
                onSelect={() => pick(it.item)}
                className="flex min-h-11 cursor-pointer items-center justify-between gap-3 md:min-h-9"
              >
                <span className="min-w-0 flex-1 break-words">{it.label}</span>
                {it.hint != null && <span className="shrink-0 text-xs text-muted-foreground">{it.hint}</span>}
              </CommandItem>
            ))}
            {freeText && q && (
              <CommandItem value={`__free__${q}`} onSelect={use} className="min-h-11 cursor-pointer italic md:min-h-9">
                {freeText.label(q)}
              </CommandItem>
            )}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );

  const trigger = (
    <button
      type="button"
      id={id}
      role="combobox"
      aria-expanded={open}
      aria-invalid={invalid || undefined}
      aria-label={title}
      data-gap={gap}
      disabled={disabled}
      // The Popover trigger toggles itself; the Drawer needs the click.
      onClick={isMobile ? () => !disabled && setOpen(true) : undefined}
      className={cn(
        // Grows to two lines instead of clipping a long street or placeholder on a phone.
        'flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-md border bg-background px-3 py-1.5 text-left text-base md:min-h-9 md:text-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
        invalid ? 'border-destructive ring-1 ring-destructive/40' : 'border-input',
        className,
      )}
    >
      <span className={cn('line-clamp-2 min-w-0 flex-1 break-words', !value && 'text-muted-foreground')}>{value || placeholder}</span>
      {value && onClear && !disabled ? (
        <span
          role="button"
          tabIndex={-1}
          aria-label={clearLabel}
          title={clearLabel}
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" aria-hidden />
        </span>
      ) : (
        <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden />
      )}
    </button>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <Drawer open={open} onOpenChange={setOpen} shouldScaleBackground={false}>
          <DrawerContent className="max-h-[90dvh]">
            <DrawerHeader className="pb-1 text-left">
              <DrawerTitle className="text-base">{title}</DrawerTitle>
            </DrawerHeader>
            <div className="px-2 pb-4">{body}</div>
          </DrawerContent>
        </Drawer>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0" align="start">
        {body}
      </PopoverContent>
    </Popover>
  );
}
