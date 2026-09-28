import type { ReactNode } from 'react';
import { Activity, Percent, Undo2, UserCheck, Users } from 'lucide-react';
import type { PeopleBuckets, PeoplePerson, PeopleResponse } from '@/lib/insightsApi/agents';
import { cn } from '@/lib/utils';
import { DeltaBadge } from '../overview/KpiRow';
import { delta } from '../overview/model';
import { Sparkline } from '../overview/Sparkline';
import { ClockCaption } from '../shared/ClockCaption';
import { COHORT_TONE, STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { closedOf, hasActivity } from './model';
import { BucketLegend, BucketsBar } from './parts';

const EMPTY: PeopleBuckets = { paid: 0, paid_legacy: 0, paid_unproven: 0, courier: 0, courier_problem: 0, label: 0, to_pack: 0, returned: 0 };

export function sumBuckets(rows: { buckets: PeopleBuckets }[]): PeopleBuckets {
  const out = { ...EMPTY };
  for (const r of rows) for (const k of Object.keys(out) as (keyof PeopleBuckets)[]) out[k] += r.buckets?.[k] ?? 0;
  return out;
}

/**
 * The tab's header: the sales people made in the period (credited, on the sale
 * day) out of all sales, where those sales are now, and the work behind them —
 * worked decisions, conversion, MEX-paid share, return rate, who was active.
 */
export function AgentsKpis({ data, people, money, prevLabel, onNoSeller, f }: {
  data: PeopleResponse;
  people: PeoplePerson[];
  money: boolean;
  prevLabel: string | null;
  onNoSeller: () => void;
  f: InsightsFormat;
}) {
  const { t } = f;
  const tot = data.totals!;
  const b = sumBuckets(people);
  const withPerson = tot.with_person;
  const closed = closedOf(b);
  const active = people.filter(hasActivity).length;
  const online = people.filter((p) => p.online_state === 'online' || p.online_state === 'idle').length;
  const cancelledAfter = people.reduce((a, p) => a + (p.outside?.cancelled_after_sale ?? 0), 0);
  const prev = tot.prev;
  const spark = (data.spark ?? []).map((p) => ({ d: p.d, v: p.with_person }));

  const hero = money && tot.with_person_mkd != null ? f.den(tot.with_person_mkd) : f.int(withPerson);

  return (
    <section aria-labelledby="ag-kpi-title" className="space-y-3">
      <h2 id="ag-kpi-title" className="sr-only">{t('insights.agents.kpi.title')}</h2>
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="min-w-0">
              <p className="text-sm font-medium text-muted-foreground">
                {money ? t('insights.agents.kpi.heroMoney') : t('insights.agents.kpi.hero')}
              </p>
              <ClockCaption clock="sale" />
            </div>
            {prevLabel && <span className="text-[11px] tabular-nums text-muted-foreground">{prevLabel}</span>}
          </div>
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="break-words text-[clamp(2rem,7vw,3rem)] font-semibold leading-none tracking-tight tabular-nums">{hero}</span>
                {money && <span className="text-sm tabular-nums text-muted-foreground">{t('insights.agents.kpi.salesN', { n: f.int(withPerson) })}</span>}
                <DeltaBadge d={prev ? delta(withPerson, prev.with_person, 'up') : null} f={f} />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('insights.agents.kpi.ofTotal', { share: f.share(withPerson, tot.sales), total: f.int(tot.sales) })}{' '}
                <button type="button" onClick={onNoSeller}
                  className="rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {t('insights.agents.kpi.noSellerLink', { n: f.int(tot.without_person) })}
                </button>
              </p>
            </div>
            {spark.length > 1 && <Sparkline points={spark} accentClass={COHORT_TONE.paid} className="w-40 max-w-full" />}
          </div>
          <BucketsBar buckets={b} total={withPerson} label={t('insights.agents.kpi.barLabel')} f={f} className="h-3" />
          <BucketLegend buckets={b} total={withPerson} cancelled={cancelledAfter} f={f} />
        </div>

        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Tile icon={Activity} label={t('insights.agents.kpi.worked')} value={f.int(tot.worked)}
            d={prev ? delta(tot.worked, prev.worked, 'up') : null}
            sub={t('insights.agents.kpi.workedSub', { sale: f.int(tot.sale_decisions), cancel: f.int(tot.cancel_decisions), trash: f.int(tot.trash_decisions) })}
            f={f} />
          <Tile icon={Percent} label={t('insights.agents.kpi.conversion')}
            value={tot.conversion != null ? f.pct(tot.conversion) : '—'}
            d={prev && prev.worked > 0 && tot.worked > 0 ? delta(tot.sale_decisions / tot.worked, prev.sale_decisions / prev.worked, 'up') : null}
            sub={t('insights.agents.kpi.conversionSub')} f={f} />
          <Tile icon={UserCheck} label={t('insights.agents.kpi.paid')} value={f.int(b.paid)} tone={STATUS_TEXT.good}
            sub={t('insights.agents.kpi.paidSub', { share: f.share(b.paid, withPerson) })} f={f} />
          <Tile icon={Undo2} label={t('insights.agents.kpi.returnRate')} tone={STATUS_TEXT.returned}
            value={closed > 0 ? f.pct(b.returned / closed) : '—'}
            sub={t('insights.agents.kpi.returnRateSub', { n: f.int(b.returned), closed: f.int(closed) })} f={f} />
          <Tile icon={Users} label={t('insights.agents.kpi.active')} value={f.int(active)}
            sub={t('insights.agents.kpi.activeSub', { online: f.int(online) })} f={f} />
          {money ? (
            <Tile label={t('insights.agents.kpi.aov')}
              value={tot.with_person_mkd != null && withPerson > 0 ? f.den(tot.with_person_mkd / withPerson) : '—'}
              sub={t('insights.agents.kpi.aovSub')} f={f} />
          ) : (
            <Tile label={t('insights.agents.kpi.packages')}
              value={f.int(people.reduce((a, p) => a + p.packages, 0))}
              sub={t('insights.agents.kpi.packagesSub')} f={f} />
          )}
        </ul>
      </div>
    </section>
  );
}

function Tile({ icon: Icon, label, value, sub, d, tone, f }: {
  icon?: typeof Activity; label: string; value: ReactNode; sub?: ReactNode;
  d?: ReturnType<typeof delta> | null; tone?: string; f: InsightsFormat;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-xl border bg-card p-3 shadow-sm">
      <span className="flex items-center gap-1.5 text-[11px] font-medium leading-tight text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
        <span className="truncate" title={label}>{label}</span>
      </span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className={cn('text-xl font-semibold tabular-nums', tone ?? 'text-card-foreground')}>{value}</span>
        {d && <DeltaBadge d={d} f={f} />}
      </span>
      {sub && <span className="text-[11px] leading-snug text-muted-foreground">{sub}</span>}
    </li>
  );
}
