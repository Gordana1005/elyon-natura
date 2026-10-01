import { useTranslation } from 'react-i18next';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { TrashReason } from '@/lib/api';
import { getTrashReasonOptions, trashReasonRequiresNote } from '@/lib/trashReasons';

interface Props {
  value: TrashReason | null;
  notes: string;
  onChange: (value: TrashReason) => void;
  onNotesChange: (notes: string) => void;
  className?: string;
  disabled?: boolean;
  /** Unique per mount — two pickers can never share a textarea id. */
  idPrefix?: string;
}

/**
 * The trash reason picker. Twin of CancellationReasonPicker — same shape, same
 * props, neutral/zinc styling instead of red so agents can tell the two apart
 * at a glance. Mounted by the /calls outcome bar ("Друго…"), OrderModal and CreateOrderModal.
 */
export function TrashReasonPicker({ value, notes, onChange, onNotesChange, className, disabled, idPrefix = 'trash' }: Props) {
  const { t } = useTranslation();
  const reasons = getTrashReasonOptions();
  const requireNote = trashReasonRequiresNote(value);
  const notesId = `${idPrefix}-notes`;
  return (
    <div className={cn('space-y-2', className)}>
      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('chooseAnswer.trashReasonLabel')} <span className="text-rose-600">*</span>
      </Label>
      <div className="flex flex-wrap gap-1.5">
        {reasons.map(r => (
          <button
            key={r.value}
            type="button"
            onClick={() => !disabled && onChange(r.value)}
            disabled={disabled}
            className={cn(
              'px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors',
              value === r.value
                ? 'bg-zinc-200 text-zinc-900 border-zinc-400 ring-2 ring-zinc-300 dark:bg-zinc-500/20 dark:text-zinc-100 dark:border-zinc-400/50 dark:ring-zinc-500/30'
                : 'bg-card text-muted-foreground border-border hover:border-muted-foreground/60 hover:text-foreground',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div>
        <Label htmlFor={notesId} className="text-[11px] text-muted-foreground">
          {t('trashPicker.notesLabel')}
          {requireNote && <span className="text-rose-600"> *</span>}
        </Label>
        <Textarea
          id={notesId}
          value={notes}
          onChange={e => onNotesChange(e.target.value)}
          placeholder={requireNote ? t('chooseAnswer.otherRequiredPlaceholder') : t('chooseAnswer.optionalNote')}
          maxLength={1000}
          disabled={disabled}
          className="mt-1 min-h-[60px] text-xs"
        />
      </div>
    </div>
  );
}
