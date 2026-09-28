import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { CohortBucketKey } from '../shared/cohortTypes';
import type { CohortDrill, Part } from '../shared/cohortModel';
import { COHORT_ICON } from '../shared/CohortBar';
import { COHORT_HATCH, COHORT_TONE, STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { DrillLink } from './DrillLink';
import type { SplitBlock } from './cohortOverview';

/** The word colour a part's number wears — status parts only, the rest stay ink (as the header). */
const TILE_TEXT: Partial<Record<CohortBucketKey, string>> = {
  paid: STATUS_TEXT.good, paid_unproven: STATUS_TEXT.critical, returned: STATUS_TEXT.returned,
};

/** Why a number has no link (or opens only part of it) — said in the tooltip, never silently. */
export function whyNoLink(
  f: InsightsFormat, d: { href: string | null; blocked: SplitBlock | null; mexOnly?: number },
): string | undefined {
  const { t } = f;
  if (d.href) return (d.mexOnly ?? 0) > 0 ? t('insights.common.cohort.partialLink', { n: f.int(d.mexOnly) }) : undefined;
  switch (d.blocked) {
    case 'web': return t('insights.common.cohort.noLinkWeb');
    case 'mex_only': return t('insights.common.cohort.noLinkMexOnly');
    case 'unsupported': return t('overview.cohort.link.unsupported');
    case 'not_orders': return t('overview.cohort.link.notOrders');
    default: return undefined;
  }
}

/**
 * One cohort part in a source card: dot + icon + label, the count (a link when
 * exact), its share of the source's sales, денари for owners, an optional line.
 */
export function CohortTile({
  k, part, share, drill, money, sourceName, f, children,
}: {
  k: CohortBucketKey;
  part: Part;
  share: string;
  drill: Pick<CohortDrill, 'href' | 'blocked' | 'mexOnly'>;
  money: boolean;
  sourceName: string;
  f: InsightsFormat;
  children?: ReactNode;
}) {
  const Icon = COHORT_ICON[k];
  const label = f.bucketLabel(k);
  const alert = k === 'paid_unproven' && part.count > 0;
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 py-2',
        part.count === 0 && 'opacity-60',
        alert && 'border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30',
      )}
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium leading-tight text-muted-foreground">
        <span
          className={cn('h-2 w-2 shrink-0 rounded-full', COHORT_TONE[k])}
          style={COHORT_HATCH[k] ? { backgroundImage: COHORT_HATCH[k] } : undefined}
          aria-hidden
        />
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate" title={label}>{label}</span>
      </span>
      <span className="flex flex-wrap items-baseline gap-x-1.5">
        <DrillLink
          href={drill.href}
          title={whyNoLink(f, drill)}
          ariaLabel={`${sourceName} · ${label}: ${f.int(part.count)}`}
          className={cn('text-lg font-semibold tabular-nums', TILE_TEXT[k] ?? 'text-card-foreground')}
        >
          {f.int(part.count)}
        </DrillLink>
        <span className="text-[11px] tabular-nums text-muted-foreground">{share}</span>
      </span>
      {money && (
        <span className="truncate text-xs tabular-nums text-muted-foreground">{part.value_mkd != null ? f.den(part.value_mkd) : '—'}</span>
      )}
      {children}
    </li>
  );
}
