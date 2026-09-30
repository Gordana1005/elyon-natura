import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, History, Info, StickyNote, UserRound } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * "За курирот" — orders.delivery_instructions, which becomes MEX "Opis": the ONLY
 * text the courier ever sees. It starts EMPTY on a new order; the previous order's
 * instruction is one tap away as a chip, never copied silently (12 of 19 old
 * "notes" were courier instructions MEX never saw, and stale ones were re-sent).
 *
 * "Внатрешна белешка" (collapsed) is an order_notes row for the team — the courier
 * never sees it. The customer's profile note is shown read-only and never copied.
 */
export function CourierNoteField({
  value, onChange, previous, internalNote, onInternalNoteChange, profileNote, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  /** The last order's courier instruction — offered as a one-tap chip. */
  previous?: string | null;
  /** Omit both to hide the internal note (the edit modal keeps its own notes). */
  internalNote?: string;
  onInternalNoteChange?: (v: string) => void;
  profileNote?: string | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(!!internalNote);
  const prev = (previous || '').trim();
  const showPrev = !!prev && prev !== value.trim() && !disabled;
  const note = (profileNote || '').trim();
  return (
    <div className="space-y-2">
      <label htmlFor="order-courier-note" className="block text-xs font-medium text-muted-foreground">
        {t('orderForm.courier.label')}
      </label>
      <Textarea
        id="order-courier-note"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('orderForm.courier.placeholder')}
        className="min-h-[64px] text-base md:text-sm"
        maxLength={1000}
        disabled={disabled}
      />
      <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
        <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {t('orderForm.courier.hint')}
      </p>
      {showPrev && (
        <button
          type="button"
          onClick={() => onChange(prev)}
          className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background px-3 py-1 text-left text-xs hover:bg-muted"
          data-testid="courier-previous-chip"
        >
          <History className="h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">{t('orderForm.courier.previous', { text: prev })}</span>
        </button>
      )}
      {note && (
        <div className="flex items-start gap-1.5 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground" data-testid="profile-note">
          <UserRound className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0 whitespace-pre-wrap break-words">{t('orderForm.courier.aboutCustomer', { text: note })}</span>
        </div>
      )}
      {onInternalNoteChange && (
        <div>
          <button
            type="button"
            onClick={() => setInternalOpen((o) => !o)}
            aria-expanded={internalOpen}
            className="inline-flex min-h-9 items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            {internalOpen ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
            <StickyNote className="h-3 w-3" aria-hidden /> {t('orderForm.courier.internal')}
          </button>
          {internalOpen && (
            <div className={cn('mt-1 space-y-1')}>
              <Textarea
                id="order-internal-note"
                value={internalNote ?? ''}
                onChange={(e) => onInternalNoteChange(e.target.value)}
                placeholder={t('orderForm.courier.internalPlaceholder')}
                className="min-h-[56px] text-base md:text-sm"
                maxLength={2000}
                disabled={disabled}
              />
              <p className="text-[11px] text-muted-foreground">{t('orderForm.courier.internalHint')}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
