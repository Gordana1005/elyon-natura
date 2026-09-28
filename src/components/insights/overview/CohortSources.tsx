import { useState } from 'react';
import { AlertTriangle, Info, LayoutGrid, Table2, Truck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type CohortLeadsIn, type CohortSourceRow } from '../shared/cohortTypes';
import {
  bucketParts, cohortDrill, isMexOnlySplit, mexOnlyCount, outsideParts, tileKeys, type Part,
} from '../shared/cohortModel';
import { COHORT_ICON, CohortBar } from '../shared/CohortBar';
import { OrdersPartLink } from '../shared/CohortLinks';
import { COHORT_TONE, OUTSIDE_TONE, STATUS_TEXT } from '../shared/cohortPalette';
import { ClockCaption } from '../shared/ClockCaption';
import { SourceTable } from '../shared/SourceTable';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { DrillLink } from './DrillLink';
import { sourceColorVar } from './palette';
import { CohortTile, whyNoLink } from './CohortTiles';
import { splitDrill, tileBuckets, tilePart, workedOf } from './cohortOverview';

type SourcesView = 'cards' | 'table';
const VIEW_KEY = 'elyon.overview.sourcesView';
const readView = (): SourcesView => {
  try { return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'cards'; } catch { return 'cards'; }
};
const writeView = (v: SourcesView) => {
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode — the choice just is not remembered */ }
};

const toPart = (m: CohortSourceRow['total'] | undefined): Part => ({
  count: m?.count ?? 0, value_mkd: m?.value_mkd ?? null, cod_mkd: m?.cod_mkd ?? null,
  orders: m?.orders ?? null, web: m?.web ?? null, mex_only: m?.mex_only ?? null,
});

/** A hollow ring = still open (no outcome yet). */
const OPEN_DOT = 'border border-muted-foreground/70 bg-transparent';

/**
 * "Од каде дојдоа парите" — one card per source on the SAME cohort as the
 * header: the source's sales made in the period (never its worked count) and
 * where each one is now, in the header's parts. Its leads (their own clock)
 * sit apart — Обработени, conversion, cancelled in red, trashed in grey —
 * because leads are not sales. The table view is the same numbers as a table.
 */
export function CohortSources({
  rows, total, leadsTotal, money, range, f,
}: {
  rows: CohortSourceRow[];
  /** The header's total (Σ rows) — each card's share is of this. */
  total: Part;
  leadsTotal: CohortLeadsIn | null;
  money: boolean;
  range: DayRange;
  f: InsightsFormat;
}) {
  const { t } = f;
  const [view, setView] = useState<SourcesView>(readView);
  const pick = (v: SourcesView) => { setView(v); writeView(v); };

  return (
    <section aria-labelledby="ov-sources-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 id="ov-sources-title" className="text-base font-semibold">
            {money ? t('overview.cohort.sources.title') : t('overview.cohort.sources.titleNoMoney')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('overview.cohort.sources.subtitle')}</p>
          <ClockCaption clock="sale" className="mt-0.5" />
        </div>
        <div role="group" aria-label={t('overview.cohort.sources.viewLabel')} className="inline-flex rounded-lg border bg-card p-0.5">
          {(['cards', 'table'] as const).map((v) => {
            const Icon = v === 'cards' ? LayoutGrid : Table2;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => pick(v)}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  view === v ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />{t(`overview.cohort.sources.view.${v}`)}
              </button>
            );
          })}
        </div>
      </div>

      {view === 'table' ? (
        <SourceTable rows={rows} total={total} leadsTotal={leadsTotal} money={money} range={range} f={f}
          title={t('overview.cohort.sources.tableTitle')} />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('overview.cohort.sources.empty')}</p>
      ) : (
        rows.map((r) => <SourceCard key={r.key} row={r} grand={total} money={money} range={range} f={f} />)
      )}
    </section>
  );
}

function SourceCard({ row, grand, money, range, f }: {
  row: CohortSourceRow; grand: Part; money: boolean; range: DayRange; f: InsightsFormat;
}) {
  const { t } = f;
  const name = f.sourceLabel(row.key);
  const total = toPart(row.total);
  const parts = bucketParts(row.buckets);
  const outs = outsideParts(row.outside);
  const rowDrill = cohortDrill([row], 'total', range);
  const mexOnly = mexOnlyCount(row);
  const isWeb = row.key === 'web';
  const leads = row.leads_in;
  const splits = row.splits ?? [];
  // A split's words come from the shared vocabulary (insights.common.split.*);
  // a key it does not know yet (a new collabBox series) shows as sent.
  const splitLabel = (k: string) => f.splitLabel(k);

  return (
    <article aria-labelledby={`ov-src-${row.key}`} className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
      {/* The source's cohort total: sales made in the period · денари (owners). */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="h-[3px] w-4 shrink-0 translate-y-[-3px] rounded-full" style={{ background: sourceColorVar(row.key) }} aria-hidden />
          <h3 id={`ov-src-${row.key}`} className="font-semibold">{name}</h3>
          <DrillLink
            href={rowDrill.href}
            title={whyNoLink(f, rowDrill)}
            ariaLabel={`${name}: ${f.int(total.count)}`}
            className="text-sm font-medium tabular-nums text-card-foreground"
          >
            {money && total.value_mkd != null
              ? t('overview.cohort.sources.header', { n: f.int(total.count), count: total.count, value: f.den(total.value_mkd) })
              : t('overview.cohort.ordersN', { n: f.int(total.count), count: total.count })}
          </DrillLink>
          <OrdersPartLink drill={rowDrill} label={name} f={f} />
        </div>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {t('overview.cohort.sources.shareOfAll', { pct: f.share(total.count, grand.count) })}
        </span>
      </div>

      <div className="mt-3">
        <CohortBar variant="bar" total={row.total} buckets={row.buckets} money={money} rows={[row]} range={range}
          barLabel={`${name} — ${t('insights.common.cohort.barLabel')}`} f={f} />
      </div>

      {/* The header's parts, for this source — they add up to the card's total. */}
      <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none">
        {tileKeys(parts).map((k) => {
          const p = tilePart(parts, k);
          const problem = parts.courier_problem;
          const problemDrill = cohortDrill([row], 'courier_problem', range);
          return (
            <CohortTile
              key={k}
              k={k}
              part={p}
              share={f.share(p.count, total.count)}
              drill={cohortDrill([row], tileBuckets(k), range)}
              money={money}
              sourceName={name}
              f={f}
            >
              {k === 'courier' && problem.count > 0 && (
                <span className={cn('inline-flex items-center gap-1 text-[11px] font-medium', STATUS_TEXT.warning)}>
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', COHORT_TONE.courier_problem)} aria-hidden />
                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                  <DrillLink href={problemDrill.href} title={whyNoLink(f, problemDrill)} className="tabular-nums">
                    {t('insights.common.cohort.problemPart', { n: f.int(problem.count) })}
                  </DrillLink>
                </span>
              )}
            </CohortTile>
          );
        })}
      </ul>

      {/* Outside this source's total: cancelled (red) / trashed (grey) after the sale · replacements (only when there are any). */}
      <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t('insights.common.outside.title')}>
        {(['cancelled_after_sale', 'trashed_after_sale', 'replacement'] as const)
          .filter((k) => k !== 'replacement' || outs[k].count > 0)
          .map((k) => {
            const p = outs[k];
            const Icon = COHORT_ICON[k];
            const dk = cohortDrill([row], k, range);
            return (
              <li key={k} className={cn('inline-flex items-center gap-1', p.count === 0 && 'opacity-60')}>
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', OUTSIDE_TONE[k])} aria-hidden />
                <Icon className="h-3 w-3 shrink-0" aria-hidden />
                <span>{f.outsideLabel(k)}</span>
                <DrillLink href={dk.href} title={whyNoLink(f, dk)} ariaLabel={`${name} · ${f.outsideLabel(k)}: ${f.int(p.count)}`}
                  className="font-semibold tabular-nums text-foreground">
                  {f.int(p.count)}
                </DrillLink>
                {money && k !== 'replacement' && p.value_mkd != null && p.count > 0 && (
                  <span className="tabular-nums">· {f.den(p.value_mkd)}</span>
                )}
                <OrdersPartLink drill={dk} label={`${name} · ${f.outsideLabel(k)}`} f={f} />
              </li>
            );
          })}
        <li className="text-[11px]">{t('overview.cohort.sources.outsideNote')}</li>
      </ul>

      {/* This source's leads, on their own clock — decisions, not sales. */}
      <div className="mt-3 rounded-lg bg-muted/40 px-3 py-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h4 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('overview.cohort.sources.leadsTitle')}</h4>
          <ClockCaption clock="created" />
        </div>
        {leads && leads.came_in > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <LeadStat label={t('overview.cohort.leads.cameIn')} value={f.int(leads.came_in)} />
            <LeadStat label={t('overview.cohort.leads.worked')} value={f.int(workedOf(leads))} />
            <LeadStat label={t('insights.common.leads.became_sales')} value={f.int(leads.became_sales)} dot={COHORT_TONE.paid} />
            <LeadStat
              label={t('overview.cohort.leads.conversion')}
              value={f.pct(leads.conversion ?? (leads.came_in > 0 ? leads.became_sales / leads.came_in : null))}
            />
            <LeadStat label={t('insights.common.leads.cancelled')} value={f.int(leads.cancelled)} dot={OUTSIDE_TONE.cancelled_after_sale} />
            <LeadStat label={t('insights.common.leads.trashed')} value={f.int(leads.trashed)} dot={OUTSIDE_TONE.trashed} />
            <LeadStat label={t('insights.common.leads.open')} value={f.int(leads.open)} dot={OPEN_DOT} />
            {(leads.other ?? 0) > 0 && <LeadStat label={t('insights.common.leads.other')} value={f.int(leads.other)} />}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">{t('overview.cohort.leads.none')}</p>
        )}
        {/* ElyonCRM's "no" calls are decisions too (Обработени), never sales. */}
        {(leads?.disposition ?? 0) > 0 && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            {t('insights.common.leads.dispositionNote', { n: f.int(leads!.disposition), count: leads!.disposition })}
          </p>
        )}
      </div>

      {splits.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label={t('overview.cohort.sources.splits')}>
          {splits.map((sp) => {
            const d = splitDrill(row, sp, range);
            const mex = isMexOnlySplit(sp);
            return (
              <li key={sp.key}>
                <DrillLink
                  href={d.href}
                  title={whyNoLink(f, d)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs no-underline',
                    d.href && 'hover:border-foreground/30 hover:bg-muted hover:no-underline',
                    mex && 'border-dashed',
                    sp.count === 0 && 'opacity-50',
                  )}
                >
                  {mex && <Truck className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
                  <span className="text-muted-foreground">{splitLabel(sp.key)}</span>
                  <b className="font-semibold tabular-nums">{f.int(sp.count)}</b>
                  {money && sp.value_mkd != null && <span className="tabular-nums text-muted-foreground">· {f.den(sp.value_mkd)}</span>}
                </DrillLink>
              </li>
            );
          })}
        </ul>
      )}

      {(isWeb || mexOnly > 0) && (
        <p className="mt-2 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
          <Info className="mt-px h-3 w-3 shrink-0" aria-hidden />
          <span>
            {isWeb
              ? t('overview.cohort.sources.webNote')
              : t('overview.cohort.sources.mexOnlyNote', { n: f.int(mexOnly), count: mexOnly })}
          </span>
        </p>
      )}
    </article>
  );
}

function LeadStat({ label, value, dot }: { label: string; value: string; dot?: string }) {
  return (
    <li className="inline-flex items-center gap-1">
      {dot && <span className={cn('h-2 w-2 shrink-0 rounded-full', dot)} aria-hidden />}
      <span>{label}</span>
      <b className="font-semibold tabular-nums text-foreground">{value}</b>
    </li>
  );
}
