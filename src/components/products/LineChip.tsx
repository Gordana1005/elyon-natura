import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  BRAND_LINES, LINE_NAMES, LINE_TONES, PROFILE_NAMES, UNDECIDED_TONE, mexProfileForLine, type BrandLine,
} from '@/lib/products/brandLines';

const chipBase = 'inline-flex max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 font-medium';

/** A line's name, or "not decided" — the brand names are proper names, the same in every language. */
function useLineLabel() {
  const { t } = useTranslation();
  return (line: BrandLine | null) => (line ? LINE_NAMES[line] : t('products.line.none'));
}

/** The line as a read-only chip; its title says which MEX account the line ships with. */
export function LineBadge({ line, size = 'sm' }: { line: BrandLine | null; size?: 'sm' | 'md' }) {
  const { t } = useTranslation();
  const label = useLineLabel();
  const profile = mexProfileForLine(line);
  return (
    <span
      className={cn(chipBase, size === 'md' ? 'h-7 text-xs' : 'h-6 text-[11px]', line ? LINE_TONES[line] : UNDECIDED_TONE)}
      title={profile ? t('products.line.shipsWith', { profile: PROFILE_NAMES[profile] }) : undefined}
    >
      {label(line)}
    </span>
  );
}

/**
 * The four lines (each with the MEX account it ships with) and "not decided".
 * A click picks at once; the caller saves.
 */
export function LineOptions({ current, onPick, allowClear = true }: {
  /** undefined = several products with different lines (nothing is marked). */
  current: BrandLine | null | undefined;
  onPick: (line: BrandLine | null) => void;
  allowClear?: boolean;
}) {
  const { t } = useTranslation();
  const option = 'flex min-h-9 w-full items-center gap-2 rounded-md border px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <div role="group" aria-label={t('products.colLine')} className="flex flex-col gap-1">
      {BRAND_LINES.map((l) => {
        const on = current === l;
        return (
          <button key={l} type="button" aria-pressed={on} onClick={() => onPick(l)}
            className={cn(option, on ? LINE_TONES[l] : 'border-transparent hover:bg-muted')}>
            <span className="min-w-0 flex-1 font-medium">{LINE_NAMES[l]}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground">{PROFILE_NAMES[mexProfileForLine(l)!]}</span>
            {on && <Check className="h-4 w-4 shrink-0" aria-hidden />}
          </button>
        );
      })}
      {allowClear && (
        <button type="button" aria-pressed={current === null} onClick={() => onPick(null)}
          className={cn(option, 'text-muted-foreground', current === null ? UNDECIDED_TONE : 'border-transparent hover:bg-muted')}>
          <span className="min-w-0 flex-1">{t('products.line.clear')}</span>
          {current === null && <Check className="h-4 w-4 shrink-0" aria-hidden />}
        </button>
      )}
    </div>
  );
}

/**
 * A product's line. For a login that sets lines (admins + owners) the chip is a
 * button that opens LineOptions; everyone else sees the plain chip.
 */
export function LineChip({ line, name, editable, busy, onPick, size = 'sm' }: {
  line: BrandLine | null;
  /** The product's name — the button's accessible name says whose line it sets. */
  name: string;
  editable: boolean;
  busy?: boolean;
  onPick: (line: BrandLine | null) => void;
  size?: 'sm' | 'md';
}) {
  const { t } = useTranslation();
  const label = useLineLabel();
  const [open, setOpen] = useState(false);
  if (!editable) return <LineBadge line={line} size={size} />;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" disabled={busy}
          aria-label={t('products.line.setFor', { name })}
          title={t('products.line.setFor', { name })}
          className={cn(
            chipBase,
            // 36 px touch target below lg, the table's 28 px from lg.
            'h-9 text-xs transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 lg:h-7',
            line ? LINE_TONES[line] : UNDECIDED_TONE,
          )}>
          {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
          {label(line)}
          <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <p className="break-words px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('products.line.setFor', { name })}
        </p>
        <LineOptions current={line} onPick={(l) => { setOpen(false); onPick(l); }} />
      </PopoverContent>
    </Popover>
  );
}
