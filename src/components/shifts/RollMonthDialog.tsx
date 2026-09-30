import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { formatDmy } from '@/components/insights/shared/period';
import { apiRollShiftsMonth, type RollMonthResult } from '@/lib/shiftsApi';
import { shiftErrorText } from './errors';

/**
 * [Пренеси го месецот]: this Skopje month's pattern into the next one (shifts_roll_forward).
 * Always a preview first — who, which hours, which weekdays, how many new days — and only the
 * confirm writes. Existing shifts are never deleted; a covered day is skipped.
 */
export function RollMonthDialog({ open, onOpenChange, onApplied }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [preview, setPreview] = useState<RollMonthResult | null>(null);

  const previewMut = useMutation({
    mutationFn: () => apiRollShiftsMonth({ apply: false }),
    onSuccess: setPreview,
  });
  const applyMut = useMutation({
    mutationFn: () => apiRollShiftsMonth({
      apply: true,
      src_from: preview?.src[0], src_to: preview?.src[1], dst_from: preview?.dst[0], dst_to: preview?.dst[1],
    }),
    onSuccess: (r) => {
      toast({ title: t('shiftsPage.roll.done', { n: r.assignments_created + (r.assignments_widened ?? 0), month: r.name }) });
      onApplied();
      onOpenChange(false);
    },
    onError: (e) => toast({ title: t('common.error'), description: shiftErrorText(e), variant: 'destructive' }),
  });

  useEffect(() => {
    if (open) { setPreview(null); previewMut.mutate(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const dows = (w: string) =>
    w.length >= 7 ? t('shiftsPage.roll.everyDay') : w.split('').map((d) => t(`shiftsPage.dow.${d}`)).join(' ');
  const covered = preview?.people.reduce((s, p) => s + p.already_covered, 0) ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle>{t('shiftsPage.roll.title')}</DialogTitle>
          <DialogDescription>
            {preview
              ? t('shiftsPage.roll.desc', {
                src: `${formatDmy(preview.src[0]).slice(0, 5)}–${formatDmy(preview.src[1])}`,
                dst: `${formatDmy(preview.dst[0]).slice(0, 5)}–${formatDmy(preview.dst[1])}`,
              })
              : t('shiftsPage.roll.loading')}
          </DialogDescription>
        </DialogHeader>

        {previewMut.isPending && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {t('shiftsPage.roll.loading')}
          </div>
        )}
        {previewMut.isError && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">{shiftErrorText(previewMut.error)}</p>
        )}

        {preview && (
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto" data-testid="roll-preview">
            <p className="text-sm font-medium">
              {t('shiftsPage.roll.summary', { people: preview.people.filter((p) => p.days > 0).length, days: preview.person_days, covered })}
            </p>
            {preview.person_days === 0 ? (
              <p className="text-sm text-muted-foreground">{t('shiftsPage.roll.nothing')}</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {preview.people.filter((p) => p.days > 0).map((p) => (
                  <li key={p.user_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_7rem_minmax(0,10rem)_4rem]">
                    <span className="min-w-0 break-words font-medium">{p.name}</span>
                    <span className="text-right tabular-nums text-muted-foreground sm:order-last">
                      <span className="sr-only">{t('shiftsPage.roll.colDays')}: </span>{p.days}
                    </span>
                    <span className="tabular-nums text-xs sm:text-sm">{p.hours.replace('-', '–')}</span>
                    <span className="text-xs text-muted-foreground sm:text-sm">{dows(p.weekdays)}</span>
                  </li>
                ))}
              </ul>
            )}
            {preview.excluded.length > 0 && (
              <p className="break-words text-xs text-muted-foreground">
                {t('shiftsPage.roll.excluded', { names: preview.excluded.map((p) => p.name).join(', ') })}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={applyMut.isPending}>
            {t('shiftsPage.roll.cancel')}
          </Button>
          <Button type="button" onClick={() => applyMut.mutate()}
            disabled={!preview || preview.person_days === 0 || applyMut.isPending}>
            {applyMut.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {t('shiftsPage.roll.confirm', { n: preview?.person_days ?? 0 })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
