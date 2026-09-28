import { useId } from 'react';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { ClockCaption } from '../shared/ClockCaption';
import { StackedBar } from '../shared/StackedBar';
import { COHORT_HATCH, COHORT_TONE } from '../shared/cohortPalette';
import { cohortWhy } from '../shared/CohortLinks';
import type { CohortBucketKey } from '../shared/cohortTypes';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { conversionOf, listLabel, listsDrill, type ListView } from './listModel';

const TOP = 10;

/** The bar's parts: paid (+ by ruling), unproven, at the courier (+ problem), label, to pack, returned. */
const PARTS: { key: CohortBucketKey; keys: CohortBucketKey[] }[] = [
  { key: 'paid', keys: ['paid', 'paid_legacy'] },
  { key: 'paid_unproven', keys: ['paid_unproven'] },
  { key: 'courier', keys: ['courier', 'courier_problem'] },
  { key: 'label', keys: ['label'] },
  { key: 'to_pack', keys: ['to_pack'] },
  { key: 'returned', keys: ['returned'] },
];

/**
 * "Кои листи носат пари" — the lists ranked by what they sold in the period
 * (денари for owners, sales otherwise). Bar length = the list's share of the
 * best list; the bar's parts say where those sales are now (MEX-first). A
 * list name opens exactly its sales in /orders.
 */
export function ListsRanking({ rows, range, money, f }: {
  rows: ListView[];
  range: DayRange;
  money: boolean;
  f: InsightsFormat;
}) {
  const { t } = f;
  const titleId = useId();
  const measure = (r: ListView) => (money && r.value_mkd != null ? r.value_mkd : r.count);
  const ranked = rows.filter((r) => r.count > 0).sort((a, b) => measure(b) - measure(a) || b.count - a.count);
  if (!ranked.length) return null;
  const top = ranked.slice(0, TOP);
  const rest = ranked.slice(TOP);
  const max = Math.max(1, measure(top[0]));
  const total = ranked.reduce((a, r) => a + measure(r), 0);
  const fmt = (v: number) => (money ? f.den(v) : f.int(v));

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div>
        <h2 id={titleId} className="text-base font-semibold">{t('insights.lists.ranking.title')}</h2>
        <p className="text-xs text-muted-foreground">
          {t(money ? 'insights.lists.ranking.subtitle' : 'insights.lists.ranking.subtitleNoMoney', { n: f.int(ranked.length) })}
        </p>
        <ClockCaption clock="sale" />
      </div>
      <ol className="space-y-2.5 rounded-xl border bg-card p-4 shadow-sm">
        {top.map((r, i) => {
          const label = listLabel(t, r.name, r.parsed);
          const totalDrill = listsDrill([...r.buckets, ...r.outside], 'total', range, r.drill_name);
          const conv = conversionOf(r.count, r.worked);
          const segs = PARTS.map((p) => {
            const parts = r.buckets.filter((b) => (p.keys as string[]).includes(b.key));
            const n = parts.reduce((a, b) => a + b.count, 0);
            const v = parts.reduce((a, b) => a + (b.value_mkd ?? 0), 0);
            return {
              key: p.key,
              weight: money && r.value_mkd != null ? v : n,
              tone: COHORT_TONE[p.key],
              pattern: COHORT_HATCH[p.key],
              text: `${f.bucketLabel(p.key)} · ${f.int(n)}${money && r.value_mkd != null ? ` · ${f.den(v)}` : ''}`,
              href: listsDrill(r.buckets, p.keys, range, r.drill_name).href,
            };
          });
          return (
            <li key={r.id} className="space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="w-5 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{i + 1}.</span>
                  <DrillLink href={totalDrill.href} title={`${r.name ?? ''}${cohortWhy(f, totalDrill) ? ` — ${cohortWhy(f, totalDrill)}` : ''}`}
                    className="truncate font-medium">
                    {label}
                  </DrillLink>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  <b className="text-sm font-semibold text-foreground">{fmt(measure(r))}</b>
                  {money && <> · {t('insights.lists.ranking.sales', { n: f.int(r.count) })}</>}
                  {' · '}{t('insights.lists.ranking.conv', { pct: f.pct(conv, 1) })}
                </span>
              </div>
              <div className="pl-7">
                <div style={{ width: `${Math.max(2, (measure(r) / max) * 100)}%` }}>
                  <StackedBar segments={segs} label={`${label} — ${t('insights.common.cohort.barLabel')}`} className="h-2.5" />
                </div>
              </div>
            </li>
          );
        })}
        {rest.length > 0 && (
          <li className={cn('border-t pt-2 text-xs text-muted-foreground')}>
            {t('insights.lists.ranking.rest', {
              n: f.int(rest.length),
              value: fmt(rest.reduce((a, r) => a + measure(r), 0)),
              share: f.share(rest.reduce((a, r) => a + measure(r), 0), total),
            })}
          </li>
        )}
      </ol>
    </section>
  );
}
