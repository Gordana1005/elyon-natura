import { useId } from 'react';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';
import type { ListsQuality, ListsQualityKind } from '@/lib/insightsApi/lists';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { STATUS_TEXT } from '../shared/cohortPalette';
import { ordersSupportsCohortDrill, type QualitySeverity } from '../shared/cohortModel';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { listsHref, staleSoldTo } from './listModel';

const SEVERITY: Record<ListsQualityKind, QualitySeverity> = {
  unproven_paid: 'critical',
  stale_to_pack: 'warning',
  duplicate_original_open: 'warning',
  ghost_dispositions: 'warning',
  cancelled_but_moving: 'warning',
  no_seller: 'warning',
  list_not_recorded: 'info',
  zero_cod_parcels: 'info',
};
const RANK: Record<QualitySeverity, number> = { critical: 0, warning: 1, info: 2 };
const ICON = { critical: OctagonAlert, warning: AlertTriangle, info: Info } as const;
const TEXT: Record<QualitySeverity, string> = { critical: STATUS_TEXT.critical, warning: STATUS_TEXT.warning, info: STATUS_TEXT.neutral };
const BORDER: Record<QualitySeverity, string> = {
  critical: 'border-red-300 dark:border-red-900', warning: 'border-amber-300 dark:border-amber-900', info: '',
};

/**
 * "Квалитет на податоците" for the lists: what the numbers above cannot vouch
 * for yet — list sales still unpacked after N days (and whether MEX already has
 * a parcel on that number), an original left open while its duplicate
 * shipped, a sale whose list was not recorded, 0-ден call rows that hold a
 * parcel or a sold status, the cohort's own flags. Review queues only —
 * nothing here is merged or fixed automatically. A card opens its orders when
 * one /orders filter holds exactly them; otherwise it lists its samples.
 */
export function ListsQualityRail({ items, range, today, staleDays, money, f }: {
  items: ListsQuality[];
  range: DayRange;
  today: string;
  staleDays: number;
  money: boolean;
  f: InsightsFormat;
}) {
  const { t } = f;
  const titleId = useId();
  const supported = ordersSupportsCohortDrill();
  const live = (items ?? []).filter((q) => q.count > 0)
    .sort((a, b) => RANK[SEVERITY[a.kind] ?? 'info'] - RANK[SEVERITY[b.kind] ?? 'info'] || b.count - a.count);
  const hrefFor = (q: ListsQuality): string | null => {
    if (!supported) return null;
    if (q.kind === 'stale_to_pack') {
      const to = staleSoldTo(range, today, staleDays);
      return to ? listsHref('to_pack', range, { soldTo: to }) : null;
    }
    if (q.kind === 'unproven_paid') return listsHref('paid_unproven', range);
    return null;
  };

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <h2 id={titleId} className="text-base font-semibold">{t('insights.lists.quality.title')}</h2>
      {live.length === 0 ? (
        <p className={cn('flex items-center gap-2 rounded-xl border bg-card p-4 text-sm', STATUS_TEXT.good)}>
          <CheckCircle2 className="h-4 w-4" aria-hidden />{t('insights.common.quality.allClear')}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {live.map((q) => {
            const sev = SEVERITY[q.kind] ?? 'info';
            const Icon = ICON[sev];
            const href = hrefFor(q);
            const amount = money ? (q.value_mkd ?? q.cod_mkd ?? null) : null;
            return (
              <li key={q.kind} className={cn('flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-sm', BORDER[sev])}>
                <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide', TEXT[sev])}>
                  <Icon className="h-3.5 w-3.5" aria-hidden />{t(`insights.common.quality.severity.${sev}`)}
                </span>
                <h3 className="mt-1 text-sm font-medium leading-snug">{t(`insights.lists.quality.kind.${q.kind}`, { days: staleDays })}</h3>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
                  <DrillLink href={href} className="text-2xl font-semibold tabular-nums">{f.int(q.count)}</DrillLink>
                  {amount != null && amount !== 0 && <span className="text-sm tabular-nums text-muted-foreground">{f.den(amount)}</span>}
                </div>
                {q.kind === 'stale_to_pack' && (q.with_parcel ?? 0) > 0 && (
                  <p className={cn('mt-1 text-[11px] font-medium', STATUS_TEXT.warning)}>
                    {t('insights.lists.quality.withParcel', { n: f.int(q.with_parcel) })}
                  </p>
                )}
                <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{t(`insights.lists.quality.hint.${q.kind}`, { days: staleDays })}</p>
                {!href && q.samples.length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
                    {q.samples.slice(0, 6).map((s) => {
                      const id = s.split(/ [→←] /)[0];
                      return (
                        <li key={s} className="truncate">
                          <DrillLink href={/^[A-Z]+-\d+$/.test(id) ? `/orders?search=${encodeURIComponent(id)}` : null} className="font-medium">
                            {s}
                          </DrillLink>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
