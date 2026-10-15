import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useInsightsPeriod } from '../shared/useInsightsPeriod';
import { DayTab } from '@/components/shops/DayTab';
import { SHOPS_COLOR_VARS } from '@/components/shops/parts';
import { tabParams } from '@/components/shops/shopsModel';
import { useShopsFormat } from '@/components/shops/useShopsFormat';

/**
 * Insights → Продавници (owner 15.10.2026: "продавниците се изоставени од извештаи"): the 22
 * shops' sales over the page's one period — the /shops Денес / Период view itself (the tiles, the
 * hours or the days, what Natura invoiced the shops, the shops by sales), so the two can never
 * show different numbers. Each shop opens its detail on /shops; the stock, deliveries and the
 * reader's health stay there. Money follows the payload (owners all, administrators sales without
 * margins, managers counts) — GET shops/day | shops/period decide, as on /shops.
 */
export default function ShopsTab() {
  const f = useShopsFormat();
  const { t } = f;
  const period = useInsightsPeriod();
  const [sp] = useSearchParams();
  return (
    <div className={cn('min-w-0 space-y-4', SHOPS_COLOR_VARS)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="min-w-0 text-xs text-muted-foreground">{t('insights.shopsTab.note')}</p>
        <Link
          to={`/shops?${tabParams(sp, 'day')}`}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          {t('insights.shopsTab.openShops')}<ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      <DayTab period={period} f={f} />
    </div>
  );
}
