import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { CancellationReason } from '@/lib/api';
import { getCancelReasonOptions, cancelReasonLabel } from '@/lib/cancellationReasons';
import { DISPOSITION_NOTE_MIN } from '@/lib/dispositionNote';
import { DispositionNoteField } from '@/components/DispositionNoteField';

interface Props {
  value: CancellationReason | null;
  notes: string;
  onChange: (value: CancellationReason) => void;
  onNotesChange: (notes: string) => void;
  className?: string;
  disabled?: boolean;
  /** The note is required (a move INTO cancelled — owner 01.10.2026). False only for a
   *  correction of an order already cancelled: then an empty note keeps the stored one. */
  noteRequired?: boolean;
  /** Minimum note length (src/lib/dispositionNote.ts — always 5 on the frontend). */
  minNote?: number;
  /** Unique per mount — two pickers can never share a textarea id. */
  idPrefix?: string;
}

export function CancellationReasonPicker({
  value, notes, onChange, onNotesChange, className, disabled,
  noteRequired = true, minNote = DISPOSITION_NOTE_MIN, idPrefix = 'cancel',
}: Props) {
  const { t } = useTranslation();
  const reasons = getCancelReasonOptions();
  // The order's CURRENT reason may be one nobody can pick: the system-only
  // no_parcel_7d, or a retired reason on an old order. Show it as a fixed,
  // selected chip so the reader sees why it was cancelled; picking any
  // reason below replaces it.
  const unpickable = value && !reasons.some(r => r.value === value) ? value : null;
  return (
    <div className={cn('space-y-2', className)}>
      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t('cancelPicker.reasonLabel')} <span className="text-rose-600">*</span>
      </Label>
      <div className="flex flex-wrap gap-1.5">
        {unpickable && (
          <span
            title={t('cancelPicker.notSelectable')}
            className="px-2.5 py-1 rounded-full text-[11px] font-medium border cursor-default bg-red-100 text-red-800 border-red-300 ring-2 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/40 dark:ring-red-500/30"
          >
            {cancelReasonLabel(unpickable)}
          </span>
        )}
        {reasons.map(r => (
          <button
            key={r.value}
            type="button"
            onClick={() => !disabled && onChange(r.value)}
            disabled={disabled}
            className={cn(
              'px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors',
              value === r.value
                ? 'bg-red-100 text-red-800 border-red-300 ring-2 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/40 dark:ring-red-500/30'
                : 'bg-card text-muted-foreground border-border hover:border-red-300 hover:text-red-800 dark:hover:text-red-300',
              disabled && 'opacity-50 cursor-not-allowed',
            )}
          >
            {r.label}
          </button>
        ))}
      </div>
      <DispositionNoteField
        id={`${idPrefix}-notes`}
        label={t('cancelPicker.customerSaidLabel')}
        value={notes}
        onChange={onNotesChange}
        required={noteRequired}
        min={minNote}
        disabled={disabled}
      />
    </div>
  );
}
