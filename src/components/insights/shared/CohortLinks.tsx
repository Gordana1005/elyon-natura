import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import type { CohortDrill } from './cohortModel';
import type { InsightsFormat } from './useInsightsFormat';

/** Why a number has no link of its own — said in its tooltip, never silently. */
export function cohortWhy(f: InsightsFormat, d: { href: string | null; blocked: string | null }): string | undefined {
  if (d.href) return undefined;
  switch (d.blocked) {
    case 'web': return f.t('insights.common.cohort.noLinkWeb');
    case 'mex_only': return f.t('insights.common.cohort.noLinkMexOnly');
    case 'mixed': return f.t('insights.common.cohort.noLinkMixed');
    case 'unknown': return f.t('insights.common.cohort.noLinkUnknown');
    case 'unsupported': return f.t('overview.cohort.link.unsupported');
    case 'not_orders': return f.t('overview.cohort.link.notOrders');
    default: return undefined;
  }
}

/**
 * "{{n}} во Нарачки" — under a number that is only partly orders (the rest are
 * web-shop orders or MEX parcels with no order): the exact link to its order
 * part. The number itself stays plain text, so no link ever opens a list that
 * holds more or less than what it says.
 */
export function OrdersPartLink({ drill, label, f, className }: {
  drill: Pick<CohortDrill, 'ordersHref' | 'orders'>;
  /** What the number is ("AlterCPA · Наплатено"), for the link's accessible name. */
  label?: string;
  f: InsightsFormat;
  className?: string;
}) {
  if (!drill.ordersHref || drill.orders <= 0) return null;
  const text = f.t('insights.common.cohort.ordersPart', { n: f.int(drill.orders) });
  return (
    <DrillLink
      href={drill.ordersHref}
      title={f.t('insights.common.cohort.ordersPartHint')}
      ariaLabel={label ? `${label} — ${text}` : text}
      className={cn('text-[11px] font-medium tabular-nums text-primary', className)}
    >
      {text}
    </DrillLink>
  );
}
