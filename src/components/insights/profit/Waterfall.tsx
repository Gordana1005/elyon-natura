import { useId, useState } from 'react';
import { BadgeAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PLRow, ProfitResponse } from '@/lib/insightsApi/profit';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { PP_FILL, PP_HATCH } from './profitPalette';
import { waterfall, type Basis, type Step } from './profitModel';

/**
 * Revenue → every cost → net profit, as a waterfall that reads top to bottom
 * (one row per step: label, a floating bar on one shared scale, the value).
 * Costs are the gray; an ESTIMATE (uncosted packages, allocations) is hatched;
 * a slot with no data yet (lead cost) says so. Two bases: every package with
 * the uncosted ones estimated (the headline) · the costed packages alone.
 */
export function Waterfall({ row, meta, clockLabel, f }: {
  row: PLRow;
  meta: ProfitResponse['meta'];
  clockLabel: string;
  f: InsightsFormat;
}) {
  const { t } = f;
  const titleId = useId();
  const [basis, setBasis] = useState<Basis>('estimated');
  const steps = waterfall(row, basis, meta.vat.rate);
  const top = Math.max(1, ...steps.map((s) => Math.max(s.from, s.to)));
  const bottom = Math.min(0, ...steps.map((s) => Math.min(s.from, s.to)));
  const span = top - bottom;
  const pos = (v: number) => ((v - bottom) / span) * 100;
  const revenue = steps[0].value;
  const net = steps[steps.length - 1].value;

  const label = (s: Step): string => {
    switch (s.key) {
      case 'vat': return t('insights.profit.step.vat', { pct: f.pct(meta.vat.rate, 0) });
      case 'courier': return t('insights.profit.step.courier', { fee: f.den(meta.courier.deliver_mkd) });
      case 'returns': return t('insights.profit.step.returns', { fee: f.den(meta.courier.return_mkd) });
      default: return t(`insights.profit.step.${s.key}`);
    }
  };
  const chip = (s: Step) => {
    if (basis === 'costed' && (s.key === 'courier' || s.key === 'returns' || s.key === 'commission')) return t('insights.profit.chip.allocated');
    if (s.key === 'vat' && !meta.vat.confirmed) return t('insights.profit.chip.vatPending');
    if (s.key === 'lead' && !meta.lead_cost.configured) return t('insights.profit.chip.leadMissing');
    if (s.key === 'commission') return t('insights.profit.chip.commissionRule');
    if (s.key === 'returns' && meta.courier.return_mkd === 0) return t('insights.profit.chip.returnFeePending');
    if (s.key === 'cogs_est') return t('insights.profit.chip.estimate', { share: f.pct(row.revenue_mkd > 0 ? (row.cogs_est_mkd ?? 0) / Math.max(1, row.revenue_uncosted_mkd) : null) });
    return null;
  };

  return (
    <section aria-labelledby={titleId} className="space-y-3 rounded-xl border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={titleId} className="text-base font-semibold">{t('insights.profit.waterfall.title')}</h2>
          <p className="text-xs text-muted-foreground">{clockLabel}</p>
        </div>
        <div role="group" aria-label={t('insights.profit.waterfall.basisLabel')} className="inline-flex rounded-lg border p-0.5">
          {(['estimated', 'costed'] as const).map((b) => (
            <button key={b} type="button" aria-pressed={basis === b} onClick={() => setBasis(b)}
              className={cn('rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                basis === b ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
              {t(`insights.profit.waterfall.basis.${b}`)}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">{t(`insights.profit.waterfall.basisHint.${basis}`)}</p>

      <ol className="space-y-1.5" aria-label={t('insights.profit.waterfall.title')}>
        {steps.map((s) => {
          const isTotal = s.key === 'revenue' || s.key === 'net';
          const left = pos(Math.min(s.from, s.to));
          const width = Math.max(pos(Math.max(s.from, s.to)) - left, s.value === 0 ? 0 : 0.4);
          const fill = s.key === 'revenue' ? PP_FILL.revenue : s.key === 'net' ? (s.value < 0 ? PP_FILL.loss : PP_FILL.net) : PP_FILL.cost;
          const c = chip(s);
          return (
            <li key={s.key} className={cn('grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-x-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]', isTotal && 'font-semibold', s.key === 'net' && 'border-t pt-2')}>
              <span className="min-w-0 text-xs leading-tight sm:text-sm">
                <span className="block truncate" title={label(s)}>{label(s)}</span>
                {c && (
                  <span className={cn('mt-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-medium',
                    s.pending || (s.key === 'vat' && !meta.vat.confirmed) || s.key === 'returns'
                      ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200' : 'bg-muted text-muted-foreground')}>
                    {(s.pending || s.key === 'vat') && <BadgeAlert className="h-3 w-3" aria-hidden />}{c}
                  </span>
                )}
              </span>
              <span className="relative h-5 min-w-0" aria-hidden>
                {s.value !== 0 && (
                  <span
                    className={cn('absolute top-0.5 h-4 rounded-[4px]', fill)}
                    style={{ left: `${left}%`, width: `${width}%`, ...(s.estimate ? { backgroundImage: PP_HATCH } : {}) }}
                  />
                )}
                {s.value === 0 && <span className="absolute top-2 h-px w-full bg-border" />}
              </span>
              <span className={cn('text-right text-xs tabular-nums sm:text-sm', s.key === 'net' && s.value < 0 && 'text-red-700 dark:text-red-400')}>
                {s.value === 0 && s.pending ? '—' : `${s.value < 0 && !isTotal ? '−' : ''}${f.den(Math.abs(s.value))}`}
                {!isTotal && revenue > 0 && s.value !== 0 && (
                  <span className="block text-[10px] font-normal text-muted-foreground">{f.pct(Math.abs(s.value) / revenue)}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-[11px] leading-snug text-muted-foreground">
        {basis === 'estimated'
          ? t('insights.profit.waterfall.upperNote', { upper: f.den(row.net_upper_mkd), margin: f.pct(net / Math.max(1, revenue)) })
          : t('insights.profit.waterfall.costedNote', { rev: f.den(row.revenue_costed_mkd), margin: f.pct(row.costed.margin) })}
      </p>
    </section>
  );
}
