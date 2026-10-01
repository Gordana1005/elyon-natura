import { forwardRef, type KeyboardEventHandler } from 'react';
import { useTranslation } from 'react-i18next';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { DISPOSITION_NOTE_MAX, DISPOSITION_NOTE_MIN, noteLength } from '@/lib/dispositionNote';

/**
 * "3 / 5" under a cancel / trash note — muted while short, emerald once the note is long
 * enough (owner 01.10.2026: a written note of at least 5 characters, src/lib/dispositionNote.ts).
 */
export function DispositionNoteCounter({ value, min = DISPOSITION_NOTE_MIN, id, className }: {
  value: string; min?: number; id?: string; className?: string;
}) {
  const { t } = useTranslation();
  const length = noteLength(value);
  const ok = length >= min && length <= DISPOSITION_NOTE_MAX;
  return (
    <span
      id={id}
      aria-live="polite"
      aria-label={t('dispositionNote.counterLabel', { length, min })}
      data-testid="note-counter"
      data-ok={ok ? 'true' : 'false'}
      className={cn(
        'shrink-0 tabular-nums text-[11px] font-medium',
        ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground',
        className,
      )}
    >
      {t('dispositionNote.counter', { length, min })}
    </span>
  );
}

interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** Required = a star and the counter always; optional = the counter once something is typed. */
  required?: boolean;
  min?: number;
  disabled?: boolean;
  autoFocus?: boolean;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  className?: string;
  textareaClassName?: string;
}

/** The note field of the reason pickers: label (+ star), textarea, live counter. */
export const DispositionNoteField = forwardRef<HTMLTextAreaElement, FieldProps>(function DispositionNoteField(
  { id, label, value, onChange, required = true, min = DISPOSITION_NOTE_MIN, disabled, autoFocus, onKeyDown, className, textareaClassName },
  ref,
) {
  const { t } = useTranslation();
  const showCounter = required || value.trim().length > 0;
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id} className="text-[11px] text-muted-foreground">
          {label}
          {required && <span className="text-rose-600"> *</span>}
        </Label>
        {showCounter && <DispositionNoteCounter id={`${id}-counter`} value={value} min={min} />}
      </div>
      <Textarea
        ref={ref}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('dispositionNote.placeholder', { min })}
        maxLength={DISPOSITION_NOTE_MAX}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-required={required || undefined}
        aria-describedby={showCounter ? `${id}-counter` : undefined}
        // text-base below md: iOS zooms into any field under 16 px.
        className={cn('mt-1 min-h-[60px] text-base md:text-xs', textareaClassName)}
      />
    </div>
  );
});
