import { Info, Truck } from 'lucide-react';
import type { SalesCore } from '@/lib/insightsApi/sales';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { DeltaBadge } from '../overview/KpiRow';
import { delta } from '../overview/model';
import { sourceColorVar } from '../overview/palette';
import { ClockCaption } from '../shared/ClockCaption';
import { CohortBar } from '../shared/CohortBar';
import { OrdersPartLink, cohortWhy } from '../shared/CohortLinks';
import { COHORT_TONE, OUTSIDE_TONE, STATUS_TEXT } from '../shared/cohortPalette';
import { cohortDrill, isMexOnlySplit, outsideParts } from '../shared/cohortModel';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { paidRate, returnRate, sourceViews, type SourceView } from './salesModel';

/**
 * "По извор" — the five sources, each with its share of the period, the change
 * against the previous period, where its sales are now (the same parts as the
 * header), its average sale, paid and return rates, and what it is made of
 * (sub-channels; MEX parcels with no order are marked and never link).
 */
export function SalesSources({ core, money, range, compare, f }: {
  core: SalesCore; money: boolean; range: DayRange; compare: boolean; f: InsightsFormat;
}) {
  const { t } = f;
  const views = sourceViews(core, money);
  return (
    <section aria-labelledby="sa-sources-title" className="space-y-3">
      <div>
        <h2 id="sa-sources-title" className="text-base font-semibold">{t('insights.sales.sources.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('insights.sales.sources.subtitle')}</p>
        <ClockCaption clock="sale" className="mt-0.5" />
      </div>
      {views.every((v) => v.count === 0) ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('insights.sales.empty')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {views.map((v) => <SourceCard key={v.key} v={v} money={money} range={range} compare={compare} f={f} />)}
        </div>
      )}
    </section>
  );
}

function SourceCard({ v, money, range, compare, f }: { v: SourceView; money: boolean; range: DayRange; compare: boolean; f: InsightsFormat }) {
  const { t } = f;
  const name = f.sourceLabel(v.key);
  const total = cohortDrill([v.row], 'total', range);
  const outs = outsideParts(v.row.outside);
  const d = compare
    ? money && v.value != null && v.prevValue != null ? delta(v.value, v.prevValue, 'up') : delta(v.count, v.prevCount, 'up')
    : null;
  const pr = paidRate(v.outcome);
  const rr = returnRate(v.outcome);
  const splits = (v.row.splits ?? []).filter((s) => s.count > 0);

  return (
    <article aria-labelledby={`sa-src-${v.key}`} className={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm', v.count === 0 && 'opacity-70')}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h3 id={`sa-src-${v.key}`} className="flex items-center gap-2 font-semibold">
            <span className="h-[3px] w-4 shrink-0 rounded-full" style={{ background: sourceColorVar(v.key) }} aria-hidden />
            {name}
          </h3>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-2xl font-semibold text-card-foreground">{money && v.value != null ? f.den(v.value) : f.int(v.count)}</span>
            <DeltaBadge d={d} f={f} />
          </div>
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
            <DrillLink href={total.href} title={cohortWhy(f, total)} ariaLabel={`${name}: ${f.int(v.count)}`} className="font-medium tabular-nums text-foreground">
              {t('insights.sales.sources.salesN', { n: f.int(v.count), count: v.count })}
            </DrillLink>
            <OrdersPartLink drill={total} label={name} f={f} />
          </p>
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {t('insights.sales.sources.share', { pct: v.share != null ? f.pct(v.share, 1) : '—' })}
        </span>
      </div>

      <CohortBar variant="bar" total={v.row.total} buckets={v.row.buckets} money={money} rows={[v.row]} range={range}
        barLabel={`${name} — ${t('insights.common.cohort.barLabel')}`} f={f} />

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-4">
        {money && <Stat label={t('insights.sales.sources.avg')} value={v.avg != null ? f.den(Math.round(v.avg)) : '—'} />}
        <Stat label={t('insights.sales.sources.paid')} value={f.pct(pr)} dot={COHORT_TONE.paid} tone={STATUS_TEXT.good} />
        <Stat label={t('insights.sales.sources.returns')} value={f.pct(rr)} dot={COHORT_TONE.returned} tone={STATUS_TEXT.returned} />
        <Stat label={t('insights.sales.sources.inFlight')} value={f.int(v.outcome.inFlight)} dot={COHORT_TONE.courier} />
      </dl>

      {(outs.cancelled_after_sale.count > 0 || outs.trashed_after_sale.count > 0) && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>{t('insights.common.outside.title')}:</span>
          {(['cancelled_after_sale', 'trashed_after_sale'] as const).filter((k) => outs[k].count > 0).map((k) => {
            const dk = cohortDrill([v.row], k, range);
            return (
              <span key={k} className="inline-flex items-center gap-1">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', OUTSIDE_TONE[k])} aria-hidden />
                {f.outsideLabel(k)}
                <DrillLink href={dk.href} title={cohortWhy(f, dk)} className="font-semibold tabular-nums text-foreground">{f.int(outs[k].count)}</DrillLink>
              </span>
            );
          })}
        </p>
      )}

      {splits.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('insights.sales.sources.splits')}>
          {splits.map((sp) => {
            const mex = isMexOnlySplit(sp);
            const href = sp.kind === 'order' ? sp.drill ?? null : null;
            const why = href ? undefined : mex ? t('insights.common.cohort.noLinkMexOnly')
              : sp.kind === 'web' ? t('insights.common.cohort.noLinkWeb') : t('insights.sales.sources.noDetailLink');
            return (
              <li key={`${sp.kind ?? ''}:${sp.key}`}>
                <DrillLink
                  href={href}
                  title={why}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs no-underline',
                    href && 'hover:border-foreground/30 hover:bg-muted hover:no-underline',
                    mex && 'border-dashed',
                  )}
                >
                  {mex && <Truck className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
                  <span className="text-muted-foreground">{f.splitLabel(sp.key)}</span>
                  <b className="font-semibold tabular-nums">{f.int(sp.count)}</b>
                  {money && sp.value_mkd != null && <span className="tabular-nums text-muted-foreground">· {f.den(sp.value_mkd)}</span>}
                </DrillLink>
              </li>
            );
          })}
        </ul>
      )}

      {(v.key === 'web' || (v.row.total.mex_only ?? 0) > 0) && (
        <p className="flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
          <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
          <span>
            {v.key === 'web'
              ? t('overview.cohort.sources.webNote')
              : t('overview.cohort.sources.mexOnlyNote', { n: f.int(v.row.total.mex_only ?? 0), count: v.row.total.mex_only ?? 0 })}
          </span>
        </p>
      )}
    </article>
  );
}

function Stat({ label, value, dot, tone }: { label: string; value: string; dot?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {dot && <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} aria-hidden />}
        <span className="truncate">{label}</span>
      </dt>
      <dd className={cn('font-semibold tabular-nums', tone ?? 'text-foreground')}>{value}</dd>
    </div>
  );
}
