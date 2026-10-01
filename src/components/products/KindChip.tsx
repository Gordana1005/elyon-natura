import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { KIND_TONES, PRODUCT_KINDS, UNDECIDED_KIND_TONE, type ProductKind } from '@/lib/products/kinds';

const chipBase = 'inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 font-medium';

/** A kind's word (products.kind.*), or Неодредено. */
export function useKindLabel() {
  const { t } = useTranslation();
  return (kind: ProductKind | null) => t(`products.kind.${kind ?? 'none'}`);
}

/** The kind as a read-only chip. */
export function KindBadge({ kind, size = 'sm' }: { kind: ProductKind | null; size?: 'sm' | 'md' }) {
  const label = useKindLabel();
  return (
    <span className={cn(chipBase, size === 'md' ? 'h-7 text-xs' : 'h-6 text-[11px]', kind ? KIND_TONES[kind] : UNDECIDED_KIND_TONE)}>
      {label(kind)}
    </span>
  );
}

/** The four kinds and "Неодредено". A click picks at once; the caller saves. */
export function KindOptions({ current, onPick, allowClear = true }: {
  /** undefined = several products of different kinds (nothing is marked). */
  current: ProductKind | null | undefined;
  onPick: (kind: ProductKind | null) => void;
  allowClear?: boolean;
}) {
  const { t } = useTranslation();
  const label = useKindLabel();
  const option = 'flex min-h-9 w-full items-center gap-2 rounded-md border px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <div role="group" aria-label={t('products.colKind')} className="flex flex-col gap-1">
      {PRODUCT_KINDS.map((k) => {
        const on = current === k;
        return (
          <button key={k} type="button" aria-pressed={on} onClick={() => onPick(k)}
            className={cn(option, on ? KIND_TONES[k] : 'border-transparent hover:bg-muted')}>
            <span className="min-w-0 flex-1 font-medium">{label(k)}</span>
            {on && <Check className="h-4 w-4 shrink-0" aria-hidden />}
          </button>
        );
      })}
      {allowClear && (
        <button type="button" aria-pressed={current === null} onClick={() => onPick(null)}
          className={cn(option, 'text-muted-foreground', current === null ? UNDECIDED_KIND_TONE : 'border-transparent hover:bg-muted')}>
          <span className="min-w-0 flex-1">{t('products.kind.clear')}</span>
          {current === null && <Check className="h-4 w-4 shrink-0" aria-hidden />}
        </button>
      )}
    </div>
  );
}

/**
 * A product's kind. For a login that sets kinds (admins + owners) the chip is a
 * button that opens KindOptions; everyone else sees the plain chip.
 */
export function KindChip({ kind, name, editable, busy, onPick, size = 'sm' }: {
  kind: ProductKind | null;
  name: string;
  editable: boolean;
  busy?: boolean;
  onPick: (kind: ProductKind | null) => void;
  size?: 'sm' | 'md';
}) {
  const { t } = useTranslation();
  const label = useKindLabel();
  const [open, setOpen] = useState(false);
  if (!editable) return <KindBadge kind={kind} size={size} />;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={busy}
          aria-label={t('products.kind.setFor', { name })} title={t('products.kind.setFor', { name })}
          className={cn(
            chipBase,
            'h-9 text-xs transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 lg:h-7',
            kind ? KIND_TONES[kind] : UNDECIDED_KIND_TONE,
          )}>
          {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          {label(kind)}
          <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-2">
        <p className="break-words px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('products.kind.setFor', { name })}
        </p>
        <KindOptions current={kind} onPick={(k) => { setOpen(false); onPick(k); }} />
      </PopoverContent>
    </Popover>
  );
}
