import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { CohortBucketKey } from '../shared/cohortTypes';
import type { CohortDrill, Part } from '../shared/cohortModel';
import { COHORT_ICON } from '../shared/CohortBar';
import { OrdersPartLink, cohortWhy } from '../shared/CohortLinks';
import { COHORT_HATCH, COHORT_TONE, STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { DrillLink } from './DrillLink';
import type { SplitBlock } from './cohortOverview';

/** The word colour a part's number wears — status parts only, the rest stay ink (as the header). */
const TILE_TEXT: Partial<Record<CohortBucketKey, string>> = {
  paid: STATUS_TEXT.good, paid_unproven: STATUS_TEXT.critical, returned: STATUS_TEXT.returned,
};

/** Why a number has no link — said in the tooltip, never silently. */
export function whyNoLink(f: InsightsFormat, d: { href: string | null; blocked: SplitBlock | null }): string | undefined {
  return cohortWhy(f, d);
}

/**
 * One cohort part in a department card, as a row of a small table (owner 15.10.2026: two
 * departments side by side, "поедноставно"): dot + icon + label · the count (a link only when it
 * is all orders) · its share of the department's sales · денари for owners. Under it, when there
 * is one, the "N во Нарачки" link to its order part and the part's own line (problem, booked …).
 */
export function CohortPartRow({
  k, part, share, drill, money, sourceName, f, children,
}: {
  k: CohortBucketKey;
  part: Part;
  share: string;
  drill: Pick<CohortDrill, 'href' | 'blocked' | 'ordersHref' | 'orders'>;
  money: boolean;
  sourceName: string;
  f: InsightsFormat;
  children?: ReactNode;
}) {
  const Icon = COHORT_ICON[k];
  const label = f.bucketLabel(k);
  const alert = k === 'paid_unproven' && part.count > 0;
  const ordersPart = <OrdersPartLink drill={drill} label={`${sourceName} · ${label}`} f={f} />;
  return (
    <li
      className={cn(
        'min-w-0 rounded-md px-2 py-1',
        part.count === 0 && 'opacity-55',
        alert && 'bg-red-50/70 dark:bg-red-950/30',
      )}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs leading-tight text-muted-foreground">
          <span
            className={cn('h-2 w-2 shrink-0 translate-y-[-1px] rounded-full', COHORT_TONE[k])}
            style={COHORT_HATCH[k] ? { backgroundImage: COHORT_HATCH[k] } : undefined}
            aria-hidden
          />
          <Icon className="h-3 w-3 shrink-0 translate-y-[1px]" aria-hidden />
          <span className="min-w-0 break-words" title={label}>{label}</span>
        </span>
        <DrillLink
          href={drill.href}
          title={whyNoLink(f, drill)}
          ariaLabel={`${sourceName} · ${label}: ${f.int(part.count)}`}
          className={cn('shrink-0 text-sm font-semibold tabular-nums', TILE_TEXT[k] ?? 'text-card-foreground')}
        >
          {f.int(part.count)}
        </DrillLink>
        <span className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{share}</span>
        {money && (
          <span className="w-[5.75rem] shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:w-28">
            {part.value_mkd != null ? f.den(part.value_mkd) : '—'}
          </span>
        )}
      </div>
      {(children || (drill.ordersHref && drill.orders > 0)) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-[1.375rem]">
          {ordersPart}
          {children}
        </div>
      )}
    </li>
  );
}
