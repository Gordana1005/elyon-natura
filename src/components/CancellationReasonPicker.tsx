import { useTranslation } from 'react-i18next';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { CancellationReason } from '@/lib/api';
import { getCancelReasonOptions, cancelReasonRequiresNote, cancelReasonLabel } from '@/lib/cancellationReasons';

interface Props {
  value: CancellationReason | null;
  notes: string;
  onChange: (value: CancellationReason) => void;
  onNotesChange: (notes: string) => void;
  className?: string;
  disabled?: boolean;
}

export function CancellationReasonPicker({ value, notes, onChange, onNotesChange, className, disabled }: Props) {
  const { t } = useTranslation();
  const reasons = getCancelReasonOptions();
  const requireNote = cancelReasonRequiresNote(value);
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
      <div>
        <Label htmlFor="cancel-notes" className="text-[11px] text-muted-foreground">
          {t('cancelPicker.customerSaidLabel')}
          {requireNote && <span className="text-rose-600"> *</span>}
        </Label>
        <Textarea
          id="cancel-notes"
          value={notes}
          onChange={e => onNotesChange(e.target.value)}
          placeholder={requireNote ? t('cancelPicker.otherRequiredPlaceholder') : t('cancelPicker.notesPlaceholder')}
          maxLength={1000}
          disabled={disabled}
          className="mt-1 min-h-[60px] text-xs"
        />
      </div>
    </div>
  );
}
