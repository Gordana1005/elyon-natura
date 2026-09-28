import { useId } from 'react';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { STATUS_TEXT } from './cohortPalette';
import { QUALITY_SEVERITY, liveQuality, type QualitySeverity } from './cohortModel';
import type { CohortQuality, CohortQualityKind } from './cohortTypes';
import type { InsightsFormat } from './useInsightsFormat';

const SEVERITY_ICON = { critical: OctagonAlert, warning: AlertTriangle, info: Info } as const;
const SEVERITY_TEXT: Record<QualitySeverity, string> = {
  critical: STATUS_TEXT.critical, warning: STATUS_TEXT.warning, info: STATUS_TEXT.neutral,
};
const SEVERITY_BORDER: Record<QualitySeverity, string> = {
  critical: 'border-red-300 dark:border-red-900',
  warning: 'border-amber-300 dark:border-amber-900',
  info: '',
};

/**
 * "Квалитет на податоците" — what the numbers above cannot vouch for yet:
 * unproven "paid" (should be 0), CRM-cancelled sales MEX shows moving, MEX-only
 * parcels that may be a CRM sale counted twice, sales with no seller, 0-ден
 * parcels. Review queues only — nothing here is merged or fixed automatically.
 * Each card: severity icon + word, count, value (owners), what it means.
 */
export function QualityRail({
  items, money, f, hrefFor, title, className,
}: {
  items: CohortQuality[] | undefined;
  money: boolean;
  f: InsightsFormat;
  /** A list that holds exactly these rows, when there is one. */
  hrefFor?: (kind: CohortQualityKind) => string | null;
  title?: string;
  className?: string;
}) {
  const { t } = f;
  const titleId = useId();
  const live = liveQuality(items);
  return (
    <section aria-labelledby={titleId} className={cn('space-y-3', className)}>
      <h2 id={titleId} className="text-base font-semibold">{title ?? t('insights.common.quality.title')}</h2>
      {live.length === 0 ? (
        <p className={cn('flex items-center gap-2 rounded-xl border bg-card p-4 text-sm', STATUS_TEXT.good)}>
          <CheckCircle2 className="h-4 w-4" aria-hidden />{t('insights.common.quality.allClear')}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {live.map((q) => {
            const sev = QUALITY_SEVERITY[q.kind] ?? 'info';
            const Icon = SEVERITY_ICON[sev];
            return (
              <li key={q.kind} className={cn('flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-sm', SEVERITY_BORDER[sev])}>
                <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide', SEVERITY_TEXT[sev])}>
                  <Icon className="h-3.5 w-3.5" aria-hidden />{t(`insights.common.quality.severity.${sev}`)}
                </span>
                <h3 className="mt-1 text-sm font-medium leading-snug">{f.qualityLabel(q.kind)}</h3>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
                  <DrillLink href={hrefFor?.(q.kind) ?? null} className="text-2xl font-semibold tabular-nums">{f.int(q.count)}</DrillLink>
                  {money && q.value_mkd != null && q.value_mkd !== 0 && (
                    <span className="text-sm tabular-nums text-muted-foreground">{f.den(q.value_mkd)}</span>
                  )}
                </div>
                <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{t(`insights.common.quality.hint.${q.kind}`)}</p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
