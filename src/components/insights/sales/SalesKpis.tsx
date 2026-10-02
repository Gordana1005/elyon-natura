import type { ReactNode } from 'react';
import { CheckCircle2, Package, Receipt, Truck, Undo2, Users, type LucideIcon } from 'lucide-react';
import type { SalesCore, SalesDetail } from '@/lib/insightsApi/sales';
import { cn } from '@/lib/utils';
import { DeltaBadge } from '../overview/KpiRow';
import { delta, fmtNum, type Delta } from '../overview/model';
import { STATUS_TEXT } from '../shared/cohortPalette';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { outcomeOf, paidRate, ratio, returnRate } from './salesModel';

/**
 * The period's sales in six numbers, each saying what it divides by: average
 * sale (owners), paid, returns among the closed, still in flight, packages per
 * sale, buyers (new / returning). Only the average sale is compared with the
 * previous period: a paid or return RATE is not — the older period has had
 * more time at the courier, so it always looks better (cohort maturity).
 */
export function SalesKpis({ core, detail, money, f }: { core: SalesCore; detail: SalesDetail | null; money: boolean; f: InsightsFormat }) {
  const { t } = f;
  const o = outcomeOf(core.total, core.buckets);
  const prev = core.prev ?? null;

  const avg = money && core.total.value_mkd != null ? ratio(core.total.value_mkd, o.count) : null;
  const prevAvg = money && prev?.total.value_mkd != null ? ratio(prev.total.value_mkd, prev.total.count) : null;
  const pr = paidRate(o);
  const rr = returnRate(o);

  // A dept_admin's detail is the whole company's counts (meta.company_wide): the two tiles built
  // on it say so, so they are never read as the department's.
  const cw = detail?.meta?.company_wide === true ? ` · ${t('access.companyWideShort')}` : '';
  const units = detail?.products?.summary?.units ?? null;
  const unitSales = detail?.basket?.by_source?.reduce((a, s) => a + s.with_units, 0) ?? null;
  const perSale = units != null && unitSales ? ratio(units, unitSales) : null;
  const buyers = detail?.customers ?? null;

  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label={t('insights.sales.kpi.label')}>
      {money && (
        <Kpi icon={Receipt} label={t('insights.sales.kpi.avg')} value={avg != null ? f.den(Math.round(avg)) : '—'}
          hint={t('insights.sales.kpi.avgHint')} d={prevAvg != null && avg != null ? delta(avg, prevAvg, 'up') : null} f={f} />
      )}
      <Kpi icon={CheckCircle2} tone={STATUS_TEXT.good} label={t('insights.sales.kpi.paid')} value={f.pct(pr)}
        hint={t('insights.sales.kpi.paidHint', { n: f.int(o.paid), of: f.int(o.count) })}
        f={f} />
      <Kpi icon={Undo2} tone={STATUS_TEXT.returned} label={t('insights.sales.kpi.returns')} value={f.pct(rr)}
        hint={t('insights.sales.kpi.returnsHint', { n: f.int(o.returned), of: f.int(o.paid + o.returned) })}
        f={f} />
      <Kpi icon={Truck} label={t('insights.sales.kpi.inFlight')} value={f.int(o.inFlight)}
        hint={t('insights.sales.kpi.inFlightHint', { pct: f.share(o.inFlight, o.count) })} f={f} />
      <Kpi icon={Package} label={t('insights.sales.kpi.perSale')}
        value={perSale != null ? fmtNum(perSale, f.lang, 1) : detail ? '—' : '…'}
        hint={units != null ? t('insights.sales.kpi.perSaleHint', { n: f.int(units) }) + cw : t('insights.sales.detailLoading')} f={f} />
      <Kpi icon={Users} label={t('insights.sales.kpi.buyers')} value={buyers ? f.int(buyers.buyers) : detail ? '—' : '…'}
        hint={buyers
          ? t('insights.sales.kpi.buyersHint', { new: f.int(buyers.new), returning: f.int(buyers.returning) }) + cw
          : t('insights.sales.detailLoading')} f={f} />
    </ul>
  );
}

function Kpi({ icon: Icon, label, value, hint, d, tone, f }: {
  icon: LucideIcon; label: string; value: ReactNode; hint?: ReactNode; d?: Delta | null; tone?: string; f: InsightsFormat;
}) {
  return (
    <li className="flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card px-3 py-2.5 shadow-sm">
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', tone)} aria-hidden />
        <span className="truncate" title={label}>{label}</span>
      </span>
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-xl font-semibold text-card-foreground">{value}</span>
        {d && <DeltaBadge d={d} f={f} />}
      </span>
      {hint && <span className="text-[11px] leading-snug text-muted-foreground">{hint}</span>}
    </li>
  );
}
