import { useId } from 'react';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { sourceColorVar } from '../overview/palette';
import { CohortBar } from './CohortBar';
import { OrdersPartLink, cohortWhy } from './CohortLinks';
import { COHORT_TONE, OUTSIDE_TONE } from './cohortPalette';
import {
  bucketParts, cohortDrill, isMexOnlySplit, outsideParts, sumParts, type CohortDrill, type DrillKey, type Part,
} from './cohortModel';
import type { CohortBucketKey, CohortLeadsIn, CohortSourceRow } from './cohortTypes';
import type { DayRange } from './period';
import type { InsightsFormat } from './useInsightsFormat';

type Col = { key: string; buckets: CohortBucketKey[]; tone: string };

/** The bucket columns, in the bar's order; "at courier" includes its problem
 *  part, "paid" includes paid by ruling / legacy import. Unproven "paid" gets
 *  its own column, only when there is any. */
const BASE_COLS: Col[] = [
  { key: 'paid', buckets: ['paid', 'paid_legacy'], tone: COHORT_TONE.paid },
  { key: 'paid_unproven', buckets: ['paid_unproven'], tone: COHORT_TONE.paid_unproven },
  { key: 'courier', buckets: ['courier', 'courier_problem'], tone: COHORT_TONE.courier },
  { key: 'label', buckets: ['label'], tone: COHORT_TONE.label },
  { key: 'to_pack', buckets: ['to_pack'], tone: COHORT_TONE.to_pack },
  { key: 'returned', buckets: ['returned'], tone: COHORT_TONE.returned },
];

/**
 * The cohort by source — the table twin of the bars: one row per source
 * (sales, value, where each sale is now, cancelled / trashed after sale, and
 * the leads that came in), a total row that equals the header. Sub-channels
 * (splits) sit under the source name; MEX-only parcels are marked — they are
 * not orders, so they never link to the Orders list. A cell links only when it
 * is all orders; otherwise it offers its order part.
 */
export function SourceTable({
  rows, total, leadsTotal, money, range, f, title, className,
}: {
  rows: CohortSourceRow[];
  /** The header's total (Σ rows); the footer shows it. */
  total?: { count: number; value_mkd?: number | null };
  leadsTotal?: CohortLeadsIn | null;
  money: boolean;
  range?: DayRange | null;
  f: InsightsFormat;
  title?: string;
  className?: string;
}) {
  const { t } = f;
  const titleId = useId();
  const drill = (r: CohortSourceRow[], k: DrillKey | DrillKey[]): CohortDrill =>
    range ? cohortDrill(r, k, range) : { href: null, blocked: 'none', ordersHref: null, orders: 0, web: 0, mexOnly: 0 };
  const why = (d: CohortDrill) => cohortWhy(f, d);
  const colPart = (r: CohortSourceRow, c: Col): Part => {
    const p = bucketParts(r.buckets);
    return sumParts(c.buckets.map((b) => p[b]));
  };
  const leadsLine = (l: CohortLeadsIn | null | undefined) => {
    if (!l || !l.came_in) return '—';
    return t('insights.common.table.leadsLine', {
      in: f.int(l.came_in), sales: f.int(l.became_sales),
      pct: l.conversion != null ? f.pct(l.conversion, 0) : f.share(l.became_sales, l.came_in),
    });
  };
  const COLS = BASE_COLS.filter((c) => c.key !== 'paid_unproven'
    || rows.some((r) => (r.buckets ?? []).some((b) => b.key === 'paid_unproven' && b.count > 0)));
  // Откажани (red) and Во корпа (grey) after the sale — outside the total, each its own column.
  const OUT_COLS = (['cancelled_after_sale', 'trashed_after_sale'] as const);
  const footTotal = total ?? sumParts(rows.map((r) => ({ count: r.total.count, value_mkd: r.total.value_mkd ?? null, cod_mkd: null })));

  return (
    <section aria-labelledby={titleId} className={cn('space-y-2', className)}>
      <h2 id={titleId} className="text-base font-semibold">{title ?? t('insights.common.table.title')}</h2>
      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('insights.common.table.source')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.common.table.sales')}</th>
              {money && <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.common.table.value')}</th>}
              <th scope="col" className="w-40 px-3 py-2 text-left font-medium"><span className="sr-only">{t('insights.common.cohort.barLabel')}</span></th>
              {COLS.map((c) => (
                <th key={c.key} scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="inline-flex items-center gap-1">
                    <span className={cn('h-2 w-2 rounded-full', c.tone)} aria-hidden />{f.bucketLabel(c.key)}
                  </span>
                </th>
              ))}
              {OUT_COLS.map((k) => (
                <th key={k} scope="col" className="px-3 py-2 text-right font-medium">
                  <span className="inline-flex items-center gap-1">
                    <span className={cn('h-2 w-2 rounded-full', OUTSIDE_TONE[k])} aria-hidden />
                    {f.outsideLabel(k)}
                  </span>
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('insights.common.table.leads')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={COLS.length + OUT_COLS.length + (money ? 5 : 4)} className="px-3 py-6 text-center text-muted-foreground">{t('insights.common.table.empty')}</td></tr>
            ) : rows.map((r) => {
              const name = f.sourceLabel(r.key);
              const totalDrill = drill([r], 'total');
              const outs = outsideParts(r.outside);
              const splits = (r.splits ?? []).filter((s) => s.count > 0);
              return (
                <tr key={r.key} className="border-b align-top last:border-0">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-[3px] w-4 shrink-0 rounded-full" style={{ background: sourceColorVar(r.key) }} aria-hidden />
                      {name}
                    </span>
                    {splits.length > 0 && (
                      <ul className="mt-1 flex flex-wrap gap-1 text-[11px] font-normal text-muted-foreground">
                        {splits.map((s) => (
                          <li key={`${s.kind ?? ''}:${s.key}`} className="rounded-full bg-muted px-2 py-0.5"
                            title={isMexOnlySplit(s) ? t('insights.common.cohort.noLinkMexOnly') : undefined}>
                            {f.splitLabel(s.key)}{' '}
                            <b className="tabular-nums">{f.int(s.count)}</b>
                            {isMexOnlySplit(s) && <span className="ml-1 font-semibold uppercase">{t('insights.common.table.mexOnlyTag')}</span>}
                            {money && s.value_mkd != null && <span className="tabular-nums"> · {f.den(s.value_mkd)}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </th>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    <DrillLink href={totalDrill.href} title={why(totalDrill)} ariaLabel={`${name}: ${f.int(r.total.count)}`}>{f.int(r.total.count)}</DrillLink>
                    <OrdersPartLink drill={totalDrill} label={name} f={f} className="block font-normal" />
                  </td>
                  {money && <td className="px-3 py-2 text-right tabular-nums">{r.total.value_mkd != null ? f.den(r.total.value_mkd) : '—'}</td>}
                  <td className="px-3 py-2.5">
                    <CohortBar variant="bar" total={r.total} buckets={r.buckets} money={money} rows={[r]} range={range}
                      barLabel={`${name} — ${t('insights.common.cohort.barLabel')}`} f={f} />
                  </td>
                  {COLS.map((c) => {
                    const p = colPart(r, c);
                    const d = drill([r], c.buckets);
                    return (
                      <td key={c.key} className={cn('px-3 py-2 text-right tabular-nums', p.count === 0 && 'text-muted-foreground')}>
                        <DrillLink href={d.href} title={why(d)} ariaLabel={`${name} · ${f.bucketLabel(c.key)}: ${f.int(p.count)}`}>{f.int(p.count)}</DrillLink>
                        <span className="block text-[11px] text-muted-foreground">{f.share(p.count, r.total.count)}</span>
                        <OrdersPartLink drill={d} label={`${name} · ${f.bucketLabel(c.key)}`} f={f} className="block" />
                      </td>
                    );
                  })}
                  {OUT_COLS.map((k) => {
                    const p = outs[k];
                    const d = drill([r], k);
                    return (
                      <td key={k} className={cn('px-3 py-2 text-right tabular-nums', p.count === 0 && 'text-muted-foreground')}>
                        <DrillLink href={d.href} title={why(d)} ariaLabel={`${name} · ${f.outsideLabel(k)}: ${f.int(p.count)}`}>{f.int(p.count)}</DrillLink>
                        <OrdersPartLink drill={d} label={`${name} · ${f.outsideLabel(k)}`} f={f} className="block" />
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">{leadsLine(r.leads_in)}</td>
                </tr>
              );
            })}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr className="border-t-2 bg-muted/30 font-semibold">
                <th scope="row" className="px-3 py-2 text-left">{t('insights.common.table.total')}</th>
                <td className="px-3 py-2 text-right tabular-nums">{f.int(footTotal.count)}</td>
                {money && <td className="px-3 py-2 text-right tabular-nums">{footTotal.value_mkd != null ? f.den(footTotal.value_mkd) : '—'}</td>}
                <td />
                {COLS.map((c) => {
                  const p = sumParts(rows.map((r) => colPart(r, c)));
                  return <td key={c.key} className="px-3 py-2 text-right tabular-nums">{f.int(p.count)}</td>;
                })}
                {OUT_COLS.map((k) => (
                  <td key={k} className="px-3 py-2 text-right tabular-nums">
                    {f.int(sumParts(rows.map((r) => outsideParts(r.outside)[k])).count)}
                  </td>
                ))}
                <td className="px-3 py-2 text-right text-xs tabular-nums">{leadsLine(leadsTotal)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </section>
  );
}
