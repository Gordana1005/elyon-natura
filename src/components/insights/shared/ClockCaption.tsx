import { useTranslation } from 'react-i18next';
import { Clock3 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ClockKey } from './useInsightsFormat';

/**
 * The small line under a widget's title that says which day it counts by —
 * "Бројано по денот на продажбата (скопско време)". Several clocks read as one
 * line ("… по денот на продажбата · по денот кога MEX ја достави пратката");
 * `now` = a state that does not depend on the period. Two widgets on
 * different clocks can never be read as one number again.
 */
export function ClockCaption({ clock, className }: { clock: ClockKey | ClockKey[]; className?: string }) {
  const { t } = useTranslation();
  const list = Array.isArray(clock) ? clock : [clock];
  const days = list.filter((c) => c !== 'now');
  const text = days.length
    ? t('insights.common.clock.counted', { clocks: days.map((c) => t(`insights.common.clock.${c}`)).join(' · ') })
    : t('insights.common.clock.now');
  return (
    <p className={cn('flex items-start gap-1 text-[11px] leading-snug text-muted-foreground', className)}>
      <Clock3 className="mt-px h-3 w-3 shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  );
}
