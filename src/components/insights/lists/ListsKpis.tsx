import type { ReactNode } from 'react';
import { BadgeCheck, Gauge, PackageOpen, Percent, ShoppingBag, Undo2, type LucideIcon } from 'lucide-react';
import type { ListsResponse } from '@/lib/insightsApi/lists';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { DeltaBadge } from '../overview/KpiRow';
import { delta, fmtNum } from '../overview/model';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import { ordersSupportsCohortDrill } from '../shared/cohortModel';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { aovOf, conversionOf, listsHref, paidRateOf, reachOf, returnRateOf, staleSoldTo } from './listModel';

/**
 * The six numbers under the cohort: what MEX already paid, how well the calls
 * convert, how much was worked, the average sale, how much comes back, and
 * what sits unpacked. Each says what it is made of in its second line.
 */
export function ListsKpis({ data, range, money, f }: {
  data: ListsResponse;
  range: DayRange;
  money: boolean;
  f: InsightsFormat;
}) {
  const { t } = f;
  const tot = data.total;
  const conv = conversionOf(tot.count, tot.worked);
  const paidRate = paidRateOf(tot.paid, tot.count);
  const rr = returnRateOf(tot.paid, tot.returned);
  const aov = aovOf(tot.value_mkd, tot.count);
  const reach = reachOf(tot.worked, tot.no_answer);
  const perSale = tot.count > 0 ? tot.units / tot.count : null;
  const supported = ordersSupportsCohortDrill();
  const staleTo = staleSoldTo(range, data.meta.today, data.meta.stale_days);
  const staleHref = supported && tot.stale_to_pack > 0 && staleTo ? listsHref('to_pack', range, { soldTo: staleTo }) : null;
  const paidHref = supported && tot.paid > 0 ? listsHref('paid', range) : null;
  const retHref = supported && tot.returned > 0 ? listsHref('returned', range) : null;
  const staleWithParcel = data.quality.find((q) => q.kind === 'stale_to_pack')?.with_parcel ?? 0;
  const prev = data.prev;

  return (
    <section aria-label={t('insights.lists.kpi.title')} className="space-y-1.5">
      <ClockCaption clock={['sale', 'decided']} />
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile
          icon={BadgeCheck} tone={STATUS_TEXT.good}
          label={money ? t('insights.lists.kpi.cash') : t('insights.lists.kpi.paid')}
          value={money && tot.cash_mkd != null ? f.den(tot.cash_mkd) : f.int(tot.paid)}
          href={money ? null : paidHref}
          delta={prev ? (money && tot.cash_mkd != null && prev.cash_mkd != null
            ? <DeltaBadge d={delta(tot.cash_mkd, prev.cash_mkd, 'up')} f={f} /> : null) : null}
          sub={t('insights.lists.kpi.cashSub', { paid: f.int(tot.paid), n: f.int(tot.count), pct: f.pct(paidRate, 0) })}
          hint={t('insights.lists.kpi.cashHint')}
        />
        <Tile
          icon={Percent}
          label={t('insights.lists.kpi.conversion')}
          value={f.pct(conv)}
          sub={t('insights.lists.kpi.conversionSub', { sales: f.int(tot.count), worked: f.int(tot.worked) })}
          hint={t('insights.lists.kpi.conversionHint')}
        />
        <Tile
          icon={Gauge}
          label={t('insights.lists.kpi.worked')}
          value={f.int(tot.worked)}
          sub={t('insights.lists.kpi.workedSub', { customers: f.int(tot.customers), people: f.int(tot.people), reach: f.pct(reach, 0) })}
          hint={t('insights.lists.kpi.workedHint')}
        />
        <Tile
          icon={ShoppingBag}
          label={money ? t('insights.lists.kpi.aov') : t('insights.lists.kpi.units')}
          value={money && aov != null ? f.den(aov) : f.int(tot.units)}
          sub={money
            ? t('insights.lists.kpi.aovSub', { units: f.int(tot.units), per: perSale != null ? fmtNum(perSale, f.lang, 1) : '—' })
            : t('insights.lists.kpi.unitsSub', { per: perSale != null ? fmtNum(perSale, f.lang, 1) : '—' })}
          hint={t('insights.lists.kpi.aovHint')}
        />
        <Tile
          icon={Undo2} tone={STATUS_TEXT.returned}
          label={t('insights.lists.kpi.returnRate')}
          value={f.pct(rr)}
          href={retHref}
          sub={t('insights.lists.kpi.returnRateSub', { returned: f.int(tot.returned), done: f.int(tot.paid + tot.returned) })}
          hint={t('insights.lists.kpi.returnRateHint')}
        />
        <Tile
          icon={PackageOpen} tone={tot.stale_to_pack > 0 ? STATUS_TEXT.warning : undefined}
          label={t('insights.lists.kpi.stale', { days: data.meta.stale_days })}
          value={f.int(tot.stale_to_pack)}
          href={staleHref}
          alert={tot.stale_to_pack > 0}
          sub={[
            money && tot.stale_to_pack_value_mkd ? f.den(tot.stale_to_pack_value_mkd) : null,
            staleWithParcel > 0 ? t('insights.lists.kpi.staleWithParcel', { n: f.int(staleWithParcel) }) : null,
          ].filter(Boolean).join(' · ') || t('insights.lists.kpi.staleNone')}
          hint={t('insights.lists.kpi.staleHint', { days: data.meta.stale_days })}
        />
      </ul>
    </section>
  );
}

function Tile({ icon: Icon, label, value, sub, hint, href, tone, alert, delta: d }: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string | null;
  hint?: string;
  href?: string | null;
  tone?: string;
  alert?: boolean;
  delta?: ReactNode;
}) {
  return (
    <li
      title={hint}
      className={cn(
        'flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card p-3 shadow-sm sm:p-4',
        alert && 'border-amber-300 dark:border-amber-900',
      )}
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium leading-tight text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
      </span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <DrillLink href={href} className={cn('break-words text-xl font-semibold tabular-nums sm:text-2xl', tone ?? 'text-card-foreground')}>
          {value}
        </DrillLink>
        {d}
      </span>
      {sub && <span className="text-[11px] leading-snug tabular-nums text-muted-foreground">{sub}</span>}
    </li>
  );
}
