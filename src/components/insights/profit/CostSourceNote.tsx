import { Link } from 'react-router-dom';
import { BadgeAlert, Boxes } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProfitResponse } from '@/lib/insightsApi/profit';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { costSource } from './profitModel';

/** dd.mm.yyyy of a YYYY-MM-DD day. */
const dmy = (ymd: string) => `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}.${ymd.slice(0, 4)}`;

/**
 * Where the purchase cost of the P&L comes from (owner 01.10.2026: Sigma CalcBuyPrice for
 * everything, through each product's approved recipe at the sale day): "Набавни цени: Сигма
 * (CalcBuyPrice, 29.09.2026)", how many packages it covers, and whether the gifts packed in the
 * parcels are counted (Phase B). While the old CRM catalogue prices are still in use it says so,
 * in amber — never a silent mix.
 */
export function CostSourceNote({ meta, clock, f }: {
  meta: ProfitResponse['meta'];
  clock: 'cohort' | 'cash';
  f: InsightsFormat;
}) {
  const { t } = f;
  const source = costSource(meta);
  const cov = meta.cost?.coverage?.[clock]?.packages ?? null;
  const sigma = source === 'sigma';
  return (
    <p data-testid="profit-cost-source"
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]', sigma ? 'text-muted-foreground' : 'text-amber-800 dark:text-amber-300')}>
      {sigma ? <Boxes className="h-3 w-3 shrink-0" aria-hidden /> : <BadgeAlert className="h-3 w-3 shrink-0" aria-hidden />}
      <span className="font-medium">
        {sigma && meta.cost?.as_of
          ? t('profitCost.source.sigma', { date: dmy(meta.cost.as_of) })
          : source === 'mixed' ? t('profitCost.source.mixed') : t('profitCost.source.legacy')}
      </span>
      {cov != null && <span>· {t('profitCost.source.coverage', { pct: f.pct(cov, 0) })}</span>}
      {sigma && <span>· {meta.cost?.extra_goods ? t('profitCost.source.extraOn') : t('profitCost.source.extraOff')}</span>}
      <Link to="/products?recipe=none" className="font-medium text-foreground underline-offset-2 hover:underline">
        {t('profitCost.source.recipes')}
      </Link>
    </p>
  );
}
