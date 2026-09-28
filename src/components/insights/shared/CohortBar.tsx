import { useId, type ReactNode } from 'react';
import {
  AlertTriangle, Ban, BadgeCheck, CheckCircle2, OctagonAlert, PackageOpen, Repeat2, Sigma, Tag, Trash2, Truck, Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { OverviewSparkPoint } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { DeltaBadge } from '../overview/KpiRow';
import { delta } from '../overview/model';
import { Sparkline } from '../overview/Sparkline';
import { ClockCaption } from './ClockCaption';
import { OrdersPartLink, cohortWhy } from './CohortLinks';
import { StackedBar, type StackSegment } from './StackedBar';
import { COHORT_HATCH, COHORT_TONE, OUTSIDE_TONE, STATUS_TEXT } from './cohortPalette';
import {
  bucketParts, canWeighByValue, checkSum, cohortDrill, outsideParts, sumParts, tileKeys, weightOf,
  type CohortDrill, type DrillKey, type Part,
} from './cohortModel';
import { COHORT_BUCKETS, COHORT_OUTSIDE, type CohortBucket, type CohortBucketKey, type CohortOutside, type CohortOutsideKey, type CohortSourceRow } from './cohortTypes';
import type { DayRange } from './period';
import type { InsightsFormat } from './useInsightsFormat';

export const COHORT_ICON: Record<CohortBucketKey | CohortOutsideKey, LucideIcon> = {
  paid: CheckCircle2,
  paid_legacy: BadgeCheck,
  paid_unproven: OctagonAlert,
  courier: Truck,
  courier_problem: AlertTriangle,
  label: Tag,
  to_pack: PackageOpen,
  returned: Undo2,
  cancelled_after_sale: Ban,
  trashed_after_sale: Trash2,
  replacement: Repeat2,
};

/** The word colour a part's number wears (status parts only; the rest stay ink). */
const TILE_TEXT: Partial<Record<CohortBucketKey, string>> = {
  paid: STATUS_TEXT.good, paid_unproven: STATUS_TEXT.critical, returned: STATUS_TEXT.returned,
};

export interface CohortBarProps {
  total: { count: number; value_mkd?: number | null; cod_mkd?: number | null; orders?: number | null; web?: number | null; mex_only?: number | null };
  buckets: CohortBucket[];
  /** Cancelled after sale / replacements — shown apart, never in the total. */
  outside?: CohortOutside[];
  /** meta.money from the server: денари only when true. */
  money: boolean;
  /** The source rows behind the numbers: decide which parts link to /orders. */
  rows?: CohortSourceRow[];
  /** The period the links open (sold_from / sold_to). No range = no links. */
  range?: DayRange | null;
  /** The previous equal period's total (compare), or null. */
  prev?: { count: number; value_mkd?: number | null } | null;
  /** "vs 15.09 – 21.09.2026". */
  prevLabel?: string | null;
  /** The period's sales per day (денари for owners, else counts) — the hero's sparkline. */
  spark?: OverviewSparkPoint[] | null;
  /** Heading; defaults to "Продадено во периодот". */
  title?: ReactNode;
  /** A line under the heading (e.g. "only the selected sources"). */
  note?: ReactNode;
  /** 'full' = hero + bar + tiles + outside; 'bar' = just the bar (table rows). */
  variant?: 'full' | 'bar';
  /** Accessible name of the bar (the 'bar' variant has no heading). */
  barLabel?: string;
  f: InsightsFormat;
  className?: string;
}

/**
 * The sales cohort: the period's sales as ONE total and the parts it splits
 * into — Наплатено · Кај курирот (of which a problem) · Спакувано, чека курир ·
 * Во магацин за пакување · Вратено (+ unproven / legacy paid when there are
 * any). The parts add up to the total, exactly; the sum is checked and a
 * mismatch is shown, never hidden. Cancelled (red) / trashed (grey) after the
 * sale and replacements sit OUTSIDE the total, each with its own dot. A number
 * links to /orders only when it is all orders; otherwise it offers its order
 * part ("N во Нарачки") and says in its tooltip what no list holds.
 */
export function CohortBar({
  total, buckets, outside, money, rows = [], range, prev, prevLabel, spark, title, note, variant = 'full', barLabel, f, className,
}: CohortBarProps) {
  const { t } = f;
  const titleId = useId();
  const parts = bucketParts(buckets);
  const tot: Part = sumParts([{
    count: total.count, value_mkd: total.value_mkd ?? null, cod_mkd: total.cod_mkd ?? null,
    orders: total.orders ?? null, web: total.web ?? null, mex_only: total.mex_only ?? null,
  }]);
  const byValue = canWeighByValue(Object.values(parts), money);
  const check = checkSum({ count: tot.count, ...(tot.value_mkd != null ? { value_mkd: tot.value_mkd } : {}) }, buckets);
  if (!check.ok && import.meta.env.DEV) console.error('[cohort] parts do not add up to the total', check);

  const drill = (key: DrillKey | DrillKey[]): CohortDrill =>
    range ? cohortDrill(rows, key, range) : { href: null, blocked: 'none', ordersHref: null, orders: 0, web: 0, mexOnly: 0 };
  const whyNoLink = (d: CohortDrill): string | undefined => cohortWhy(f, d);

  const share = (n: number) => f.share(n, tot.count);
  const moneyOf = (p: Part) => (money && p.value_mkd != null ? f.den(p.value_mkd) : null);
  const readout = (label: string, p: Part) => {
    const m = moneyOf(p);
    return `${label} · ${f.int(p.count)} (${share(p.count)})${m ? ` · ${m}` : ''}`;
  };

  const segments: StackSegment[] = COHORT_BUCKETS.map((k) => ({
    key: k,
    weight: weightOf(parts[k], byValue),
    tone: COHORT_TONE[k],
    pattern: COHORT_HATCH[k],
    text: readout(f.bucketLabel(k), parts[k]),
    href: drill(k).href,
  }));
  const label = barLabel ?? t('insights.common.cohort.barLabel');

  if (variant === 'bar') return <StackedBar segments={segments} label={label} className={cn('h-2.5', className)} />;

  const hero = money && tot.value_mkd != null ? f.den(tot.value_mkd) : f.int(tot.count);
  const totalDrill = drill('total');
  const d = prev
    ? money && tot.value_mkd != null && prev.value_mkd != null
      ? delta(tot.value_mkd, prev.value_mkd, 'up')
      : delta(tot.count, prev.count, 'up')
    : null;
  const outs = outsideParts(outside);
  const hasOutside = !!outside;
  const composed = tot.orders != null && tot.web != null && tot.mex_only != null;

  return (
    <section aria-labelledby={titleId} className={cn('space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-5', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 space-y-0.5">
          <h2 id={titleId} className="text-sm font-medium text-muted-foreground">
            {title ?? (money ? t('insights.common.cohort.title') : t('insights.common.cohort.titleNoMoney'))}
          </h2>
          <ClockCaption clock="sale" />
          {note && <p className="text-[11px] font-medium text-muted-foreground">{note}</p>}
        </div>
        {prevLabel && <span className="text-[11px] tabular-nums text-muted-foreground">{prevLabel}</span>}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <DrillLink
              href={totalDrill.href}
              title={whyNoLink(totalDrill)}
              className="break-words text-[clamp(2rem,7vw,3rem)] font-semibold leading-none tracking-tight tabular-nums text-card-foreground"
            >
              {hero}
            </DrillLink>
            {money && tot.value_mkd != null && (
              <span className="text-sm tabular-nums text-muted-foreground">{t('insights.common.cohort.salesN', { n: f.int(tot.count) })}</span>
            )}
            <DeltaBadge d={d} f={f} />
          </div>
          {/* What the total is made of — why only its order part opens a list. */}
          {composed && (
            <p className="flex flex-wrap items-baseline gap-x-2 text-[11px] tabular-nums text-muted-foreground">
              <span>{t('insights.common.cohort.composition', { orders: f.int(tot.orders), web: f.int(tot.web), mex: f.int(tot.mex_only) })}</span>
              <OrdersPartLink drill={totalDrill} f={f} />
            </p>
          )}
        </div>
        {spark && spark.length > 1 && <Sparkline points={spark} accentClass={COHORT_TONE.paid} className="w-40 max-w-full" />}
      </div>

      <StackedBar segments={segments} label={label} className="h-4" />

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {tileKeys(parts).map((k) => {
          if (k === 'courier') {
            const moving = parts.courier;
            const problem = parts.courier_problem;
            const both = sumParts([moving, problem]);
            const dAll = drill(['courier', 'courier_problem']);
            const dProblem = drill('courier_problem');
            return (
              <Tile key={k} k={k} label={f.bucketLabel('courier')} part={both} share={share(both.count)} money={moneyOf(both)} drill={dAll} why={whyNoLink(dAll)} f={f}>
                <OrdersPartLink drill={dAll} label={f.bucketLabel('courier')} f={f} />
                {problem.count > 0 && (
                  <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium', STATUS_TEXT.warning)}>
                    <span className={cn('h-2 w-2 shrink-0 rounded-full', COHORT_TONE.courier_problem)} aria-hidden />
                    <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                    <DrillLink href={dProblem.href} title={whyNoLink(dProblem)} className="tabular-nums">
                      {t('insights.common.cohort.problemPart', { n: f.int(problem.count) })}
                    </DrillLink>
                  </span>
                )}
              </Tile>
            );
          }
          const p = parts[k];
          const dk = drill(k);
          return (
            <Tile key={k} k={k} label={f.bucketLabel(k)} part={p} share={share(p.count)} money={moneyOf(p)} drill={dk} why={whyNoLink(dk)}
              alert={k === 'paid_unproven' && p.count > 0} f={f}>
              <OrdersPartLink drill={dk} label={f.bucketLabel(k)} f={f} />
              {k === 'paid' && money && p.cod_mkd != null && (
                <span className="text-[11px] tabular-nums text-muted-foreground">{t('insights.common.cohort.codLine', { value: f.den(p.cod_mkd) })}</span>
              )}
              {k === 'paid_legacy' && (
                <span className="text-[11px] text-muted-foreground">{t('insights.common.cohort.legacyNote')}</span>
              )}
              {k === 'paid_unproven' && (
                <span className={cn('text-[11px] font-medium', STATUS_TEXT.critical)}>{t('insights.common.cohort.unprovenNote')}</span>
              )}
            </Tile>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t pt-2 text-xs">
        {hasOutside ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label={t('insights.common.outside.title')}>
            <span className="font-medium text-muted-foreground">{t('insights.common.outside.title')}:</span>
            {COHORT_OUTSIDE.map((k) => {
              const p = outs[k];
              const Icon = COHORT_ICON[k];
              const dk = drill(k);
              return (
                <span key={k} className={cn('inline-flex items-center gap-1', p.count === 0 && 'opacity-60')}>
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', OUTSIDE_TONE[k])} aria-hidden />
                  <Icon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                  <span>{f.outsideLabel(k)}</span>
                  <DrillLink href={dk.href} title={whyNoLink(dk)} ariaLabel={`${f.outsideLabel(k)}: ${f.int(p.count)}`} className="font-semibold tabular-nums">{f.int(p.count)}</DrillLink>
                  {k !== 'replacement' && moneyOf(p) && p.count > 0 && <span className="tabular-nums text-muted-foreground">· {moneyOf(p)}</span>}
                  <OrdersPartLink drill={dk} label={f.outsideLabel(k)} f={f} />
                </span>
              );
            })}
          </div>
        ) : <span />}
        <SumLine check={check} money={money} f={f} />
      </div>
    </section>
  );
}

function Tile({ k, label, part, share, money, drill, why, alert, children, f }: {
  k: CohortBucketKey; label: string; part: Part; share: string; money: string | null;
  drill: CohortDrill; why?: string; alert?: boolean; children?: ReactNode; f: InsightsFormat;
}) {
  const Icon = COHORT_ICON[k];
  return (
    <li
      className={cn(
        'flex min-w-0 flex-col gap-0.5 rounded-lg border px-2.5 py-2',
        part.count === 0 && 'opacity-60',
        alert && 'border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30',
      )}
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium leading-tight text-muted-foreground">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', COHORT_TONE[k])} aria-hidden />
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate" title={label}>{label}</span>
      </span>
      <span className="flex flex-wrap items-baseline gap-x-1.5">
        <DrillLink
          href={drill.href}
          title={why}
          ariaLabel={`${label}: ${f.int(part.count)}`}
          className={cn('text-lg font-semibold tabular-nums', TILE_TEXT[k] ?? 'text-card-foreground')}
        >
          {f.int(part.count)}
        </DrillLink>
        <span className="text-[11px] tabular-nums text-muted-foreground">{share}</span>
      </span>
      {money && <span className="truncate text-xs tabular-nums text-muted-foreground">{money}</span>}
      {children}
    </li>
  );
}

/** "Σ деловите = 1.337" — or, if the server ever sends parts that do not add up, a red line saying so. */
function SumLine({ check, money, f }: { check: ReturnType<typeof checkSum>; money: boolean; f: InsightsFormat }) {
  const { t } = f;
  if (check.ok) {
    return (
      <span className="inline-flex items-center gap-1 tabular-nums text-muted-foreground">
        <Sigma className="h-3 w-3" aria-hidden />{t('insights.common.cohort.sumOk', { total: f.int(check.count.total) })}
      </span>
    );
  }
  return (
    <span role="alert" className={cn('inline-flex items-center gap-1 font-medium tabular-nums', STATUS_TEXT.critical)}>
      <OctagonAlert className="h-3.5 w-3.5" aria-hidden />
      {t('insights.common.cohort.sumBad', {
        parts: f.int(check.count.parts), total: f.int(check.count.total),
      })}
      {money && check.value && check.value.parts !== check.value.total && (
        <span> · {f.den(check.value.parts)} ≠ {f.den(check.value.total)}</span>
      )}
    </span>
  );
}
