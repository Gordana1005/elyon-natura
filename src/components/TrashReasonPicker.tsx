import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { TrashReason } from '@/lib/api';
import { getTrashReasonOptions } from '@/lib/trashReasons';
import { DISPOSITION_NOTE_MIN } from '@/lib/dispositionNote';
import { DispositionNoteField } from '@/components/DispositionNoteField';

interface Props {
  value: TrashReason | null;
  notes: string;
  onChange: (value: TrashReason) => void;
  onNotesChange: (notes: string) => void;
  className?: string;
  disabled?: boolean;
  /** Unique per mount — two pickers can never share a textarea id. */
  idPrefix?: string;
  /** The note is required (a move INTO trashed — owner 01.10.2026). False only for a
   *  correction of an order already trashed: then an empty note keeps the stored one. */
  noteRequired?: boolean;
  /** Minimum note length (src/lib/dispositionNote.ts — always 5 on the frontend). */
  minNote?: number;
}

/**
 * The trash reason picker. Twin of CancellationReasonPicker — same shape, same
 * props, neutral/zinc styling instead of red so agents can tell the two apart
 * at a glance. Mounted by the /calls outcome bar ("Друго…"), OrderModal and CreateOrderModal.
 */
export function TrashReasonPicker({
  value, notes, onChange, onNotesChange, className, disabled, idPrefix = 'trash',
  noteRequired = true, minNote = DISPOSITION_NOTE_MIN,
}: Props) {
  const { t } = useTranslation();
  const reasons = getTrashReasonOptions();
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
      <DispositionNoteField
        id={`${idPrefix}-notes`}
        label={t('trashPicker.notesLabel')}
        value={notes}
        onChange={onNotesChange}
        required={noteRequired}
        min={minNote}
        disabled={disabled}
      />
    </div>
  );
}
