import { AlertTriangle, CheckCircle2, OctagonAlert } from 'lucide-react';
import type { OverviewAttention, OverviewAttentionKind } from '@/lib/api';
import { eurToDen } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { DrillLink } from './DrillLink';
import { ClockCaption } from '../shared/ClockCaption';
import { TONE_TEXT } from './palette';
import { ordersHref } from './model';
import type { OverviewFormat } from './useOverviewFormat';
import { noParcelDaysOr } from '@/lib/noParcelRule';

/** The kinds GET /orders?attention= can list (the api answers 400
 *  attention_not_listable for the rest) — only these open the filtered list. */
const LISTABLE = new Set<OverviewAttentionKind>(['approved_no_parcel_7d', 'mex_problem']);
/** Kinds whose samples are order numbers (openable through the Orders search). */
const ORDER_SAMPLES = new Set<OverviewAttentionKind>([
  'approved_no_parcel_7d', 'mex_problem', 'cod_mismatch', 'night_approvals',
]);

const SEVERITY_ORDER = { critical: 0, warning: 1 } as const;

/** A sample note is server text; for a reader without money it must not carry
 *  an amount (e.g. "CRM 1.490 ден · MEX 4.000 ден"). Belt and braces — the
 *  server should already send money-free notes to non-owners. */
const MONEY_IN_TEXT = /\d[\d.,\s]*(ден|mkd|eur|€)/i;
export const safeNote = (note: string | null | undefined, money: boolean) =>
  !note ? null : !money && MONEY_IN_TEXT.test(note) ? null : note;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A card's amount, always денари: `value_mkd` (the parcel's COD where a parcel
 *  exists, else price × 61,5 — 20260942001920), else the parcels' COD; an older
 *  payload's Σ price (EUR) is shown at the frozen rate, never as euro. */
export const attentionAmount = (a: Pick<OverviewAttention, 'value_mkd' | 'cod_mkd' | 'value_eur'>): number | null =>
  isNum(a.value_mkd) ? a.value_mkd : isNum(a.cod_mkd) ? a.cod_mkd : isNum(a.value_eur) ? eurToDen(a.value_eur) : null;

/** "Треба внимание" — one card per kind: severity icon + word, count, value, who, examples. */
export function AttentionRail({
  items, money, teamPeople, f,
}: {
  items: OverviewAttention[];
  money: boolean;
  /** When a team filter is on: the person ids to keep in the "most from" lists. */
  teamPeople: Set<string> | null;
  f: OverviewFormat;
}) {
  const { t } = f;
  const live = items
    .filter((a) => a.count > 0)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count);

  return (
    <section id="overview-attention" aria-labelledby="ov-att-title" className="scroll-mt-20 space-y-3">
      <div>
        <h2 id="ov-att-title" className="text-base font-semibold">{t('overview.attention.title')}</h2>
        <ClockCaption clock="now" />
      </div>
      {live.length === 0 ? (
        <p className={cn('flex items-center gap-2 rounded-xl border bg-card p-4 text-sm', TONE_TEXT.good)}>
          <CheckCircle2 className="h-4 w-4" aria-hidden />{t('overview.attention.allClear')}
        </p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {live.map((a) => {
            const critical = a.severity === 'critical';
            const Icon = critical ? OctagonAlert : AlertTriangle;
            const base = LISTABLE.has(a.kind) ? { attention: a.kind } : null;
            const orderSamples = ORDER_SAMPLES.has(a.kind);
            // approved_no_parcel_7d carries the rule's own window (`days`, default 10);
            // the "7d" in the kind is only its stored name.
            const kindLabel = t(`overview.attention.kind.${a.kind}`, { days: noParcelDaysOr(a.days) });
            const href = a.kind === 'stale_feed' ? '#overview-freshness' : ordersHref(base, kindLabel);
            const people = (a.by_person ?? []).filter((p) => !teamPeople || teamPeople.has(p.person_id)).slice(0, 3);
            const amount = money ? attentionAmount(a) : null;
            return (
              <li key={a.kind}
                className={cn('flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-sm',
                  critical ? 'border-red-300 dark:border-red-900' : 'border-amber-300 dark:border-amber-900')}>
                <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide',
                  critical ? TONE_TEXT.critical : TONE_TEXT.warning)}>
                  <Icon className="h-3.5 w-3.5" aria-hidden />{t(`overview.attention.severity.${a.severity}`)}
                </span>
                <h3 className="mt-1 text-sm font-medium leading-snug">{kindLabel}</h3>
                <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
                  {href?.startsWith('#') ? (
                    <a href={href} className="text-2xl font-semibold tabular-nums hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{f.int(a.count)}</a>
                  ) : (
                    <DrillLink href={href} className="text-2xl font-semibold tabular-nums">{f.int(a.count)}</DrillLink>
                  )}
                  {amount != null && amount > 0 && (
                    <span className="text-sm tabular-nums text-muted-foreground">{f.den(amount)}</span>
                  )}
                </div>
                {(a.by_status ?? []).length > 0 && (
                  <ul className="mt-2 flex flex-wrap gap-1 text-[11px]">
                    {(a.by_status ?? []).slice(0, 4).map((st) => (
                      <li key={st.status_id} className="rounded-full bg-muted px-2 py-0.5">
                        {st.status_name} <b className="tabular-nums">{f.int(st.count)}</b>
                      </li>
                    ))}
                  </ul>
                )}
                {people.length > 0 && (
                  <div className="mt-2 text-xs">
                    <span className="text-muted-foreground">{t('overview.attention.byPerson')}: </span>
                    {people.map((p, i) => (
                      <span key={p.person_id}>
                        {i > 0 && ', '}
                        <DrillLink href={base ? ordersHref({ ...base, sold_by_person_id: p.person_id }, p.name) : null}>
                          {p.name} <b className="tabular-nums">{f.int(p.count)}</b>
                        </DrillLink>
                      </span>
                    ))}
                  </div>
                )}
                {(a.sample ?? []).length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
                    {(a.sample ?? []).slice(0, 3).map((s, i) => {
                      const note = safeNote(s.note, money);
                      return (
                        <li key={`${s.display_id ?? ''}-${i}`} className="truncate" title={[s.display_id, note].filter(Boolean).join(' · ')}>
                          {s.display_id && (orderSamples
                            ? <DrillLink href={`/orders?search=${encodeURIComponent(s.display_id)}`} className="font-medium text-foreground">{s.display_id}</DrillLink>
                            : <span className="font-medium text-foreground">{s.display_id}</span>)}
                          {s.display_id && note && ' · '}{note}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {!base && !orderSamples && a.kind !== 'stale_feed' && (
                  <p className="mt-auto pt-2 text-[11px] text-muted-foreground">{t('overview.attention.noList')}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
