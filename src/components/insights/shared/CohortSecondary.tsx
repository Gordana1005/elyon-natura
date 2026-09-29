import { useId } from 'react';
import { CreditCard } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DeltaBadge } from '../overview/KpiRow';
import { delta } from '../overview/model';
import { ClockCaption } from './ClockCaption';
import { StackedBar } from './StackedBar';
import { COHORT_TONE, OUTSIDE_TONE } from './cohortPalette';
import { workedOf } from './cohortModel';
import type { CohortCashFlow, CohortLeadsIn } from './cohortTypes';
import type { InsightsFormat } from './useInsightsFormat';

/**
 * Leads-funnel order (validated like the cohort bar, light #fff / dark #171b26):
 * sales · open · cancelled · trashed — adjacent CVD ≥ 20.2 light / 10.7 dark;
 * all pairs ≥ 8.6 light, dark sales~cancelled 7.4 (floor band: the 2 px gaps
 * and the worded legend carry it).
 */
const LEADS_PARTS = [
  { key: 'became_sales', tone: COHORT_TONE.paid },
  { key: 'open', tone: COHORT_TONE.to_pack },
  { key: 'cancelled', tone: OUTSIDE_TONE.cancelled_after_sale },
  { key: 'trashed', tone: OUTSIDE_TONE.trashed },
  // a free replacement, a sale re-opened — shown only when there is any
  { key: 'other', tone: OUTSIDE_TONE.replacement },
] as const;

/** "Дојдени во периодот" — the leads that came in, and what became of them
 *  (the parts are a partition of came_in). A separate small figure: leads are
 *  not sales and never add to the total. A CRM "no" call is a worked
 *  decision (a cancel), said in its own line. */
export function LeadsInCard({ leads, prev, f, className }: {
  leads: CohortLeadsIn | null | undefined;
  prev?: CohortLeadsIn | null;
  f: InsightsFormat;
  className?: string;
}) {
  const { t } = f;
  const titleId = useId();
  if (!leads) return null;
  const conv = leads.conversion ?? (leads.came_in > 0 ? leads.became_sales / leads.came_in : null);
  const val = (k: (typeof LEADS_PARTS)[number]['key']) => leads[k] ?? 0;
  const parts = LEADS_PARTS.filter((p) => p.key !== 'other' || val('other') > 0);
  return (
    <section aria-labelledby={titleId} className={cn('flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm', className)}>
      <div>
        <h3 id={titleId} className="text-sm font-medium text-muted-foreground">{t('insights.common.leads.title')}</h3>
        <ClockCaption clock="created" />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tabular-nums">{f.int(leads.came_in)}</span>
        <span className="text-xs text-muted-foreground">
          {t('insights.common.leads.became', { n: f.int(leads.became_sales), pct: conv != null ? f.pct(conv, 0) : '—' })}
        </span>
        {prev && <DeltaBadge d={delta(leads.came_in, prev.came_in, 'up')} f={f} />}
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t('insights.common.leads.worked', { n: f.int(workedOf(leads)) })}
      </p>
      <StackedBar
        className="h-2.5"
        label={t('insights.common.leads.title')}
        segments={parts.map((p) => ({
          key: p.key, weight: val(p.key), tone: p.tone,
          text: `${t(`insights.common.leads.${p.key}`)} · ${f.int(val(p.key))} (${f.share(val(p.key), leads.came_in)})`,
        }))}
      />
      <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {parts.map((p) => (
          <li key={p.key} className="inline-flex items-center gap-1">
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', p.tone)} aria-hidden />
            {t(`insights.common.leads.${p.key}`)} <b className="tabular-nums text-foreground">{f.int(val(p.key))}</b>
          </li>
        ))}
      </ul>
      {(leads.disposition ?? 0) > 0 && (
        <p className="text-[11px] text-muted-foreground">
          {t('insights.common.leads.dispositionNote', { n: f.int(leads.disposition), count: leads.disposition })}
        </p>
      )}
    </section>
  );
}

/** "Прилив од MEX" — cash on the DELIVERY-day clock: what MEX collected in the
 *  period, for sales of any day (split into this period's sales and earlier
 *  ones), plus card-paid web orders on their own line (their COD at MEX is 0). */
export function CashFlowCard({ cash, money, f, className }: {
  cash: CohortCashFlow | null | undefined;
  money: boolean;
  f: InsightsFormat;
  className?: string;
}) {
  const { t } = f;
  const titleId = useId();
  if (!cash) return null;
  const showMoney = money && cash.cod_mkd != null;
  return (
    <section aria-labelledby={titleId} className={cn('flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 shadow-sm', className)}>
      <div>
        <h3 id={titleId} className="text-sm font-medium text-muted-foreground">
          {showMoney ? t('insights.common.cash.title') : t('insights.common.cash.titleNoMoney')}
        </h3>
        <ClockCaption clock="delivered" />
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-2xl font-semibold tabular-nums">{showMoney ? f.den(cash.cod_mkd) : f.int(cash.parcels)}</span>
        {showMoney && <span className="text-xs text-muted-foreground">{t('insights.common.cash.parcelsN', { n: f.int(cash.parcels) })}</span>}
      </div>
      {showMoney && (
        <dl className="space-y-0.5 text-xs">
          {cash.from_this_period_mkd != null && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{t('insights.common.cash.fromThis')}</dt>
              <dd className="tabular-nums">{f.den(cash.from_this_period_mkd)}</dd>
            </div>
          )}
          {cash.from_earlier_mkd != null && (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{t('insights.common.cash.fromEarlier')}</dt>
              <dd className="tabular-nums">{f.den(cash.from_earlier_mkd)}</dd>
            </div>
          )}
          {cash.card_mkd != null && cash.card_mkd !== 0 && (
            <div className="flex justify-between gap-3 border-t pt-1">
              <dt className="inline-flex items-center gap-1 text-muted-foreground">
                <CreditCard className="h-3 w-3" aria-hidden />{t('insights.common.cash.card')}
              </dt>
              <dd className="tabular-nums">+ {f.den(cash.card_mkd)}</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
