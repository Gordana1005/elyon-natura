import type { ReactNode } from 'react';
import type { ShopMoney } from '@/lib/shopsTypes';
import { hasKey, numOrNull, shareOf } from './shopsModel';
import { Tile } from './parts';
import type { ShopsFormat } from './useShopsFormat';

export interface KpiTotals extends ShopMoney { receipts: number; units: number; returns_units: number; shops_open?: number }

/**
 * The tiles of Денес / Период. Counts for everyone; a money tile only when its key arrived
 * (owners) — a manager's payload has no `*_mkd` key, so those tiles are simply not there.
 * Group margin = null means Natura's Sigma costs are not loaded yet: said in words, never 0.
 *
 * `shopsTotal` null = one shop (no "open shops" tile); `extra` = more tiles at the end (the detail's).
 */
export function ShopsKpis({ totals, shopsTotal, extra, f }: { totals: KpiTotals; shopsTotal: number | null; extra?: ReactNode; f: ShopsFormat }) {
  const { t } = f;
  const sales = numOrNull(totals.sales_mkd);
  const exVat = numOrNull(totals.sales_ex_vat_mkd);
  const cash = numOrNull(totals.cash_mkd);
  const card = numOrNull(totals.card_mkd);
  const cashShare = cash != null && card != null && cash + card > 0 ? cash / (cash + card) : null;
  const shopMargin = numOrNull(totals.shop_margin_mkd);
  const groupMargin = numOrNull(totals.group_margin_mkd);

  return (
    <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4" aria-label={t('shops.kpi.title')} data-testid="shops-kpis">
      {hasKey(totals, 'sales_mkd') && (
        <Tile label={t('shops.kpi.sales')} value={sales != null ? f.den(sales) : '—'}
          sub={exVat != null ? t('shops.kpi.salesSub', { value: f.den(exVat) }) : undefined} hint={t('shops.kpi.salesHint')} />
      )}
      <Tile label={t('shops.kpi.receipts')} value={f.int(totals.receipts)} />
      <Tile label={t('shops.kpi.units')} value={f.int(totals.units)}
        sub={totals.returns_units > 0 ? t('shops.kpi.unitsReturned', { n: f.int(totals.returns_units) }) : undefined} />
      {hasKey(totals, 'avg_receipt_mkd') && (
        <Tile label={t('shops.kpi.avgReceipt')} value={numOrNull(totals.avg_receipt_mkd) != null ? f.den(totals.avg_receipt_mkd) : '—'} />
      )}
      {hasKey(totals, 'cash_mkd') && (
        <Tile label={t('shops.kpi.cashCard')}
          value={cashShare != null ? `${f.pct(cashShare, 0)} / ${f.pct(1 - cashShare, 0)}` : '—'}
          sub={cash != null && card != null ? t('shops.kpi.cashCardSub', { cash: f.den(cash), card: f.den(card) }) : undefined}>
          {cashShare != null && (
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div className="h-full rounded-l-full bg-[var(--sh-bar)]" style={{ width: `${cashShare * 100}%` }} />
              <div className="h-full flex-1 border-l-2 border-card bg-[var(--sh-bar-soft)]" />
            </div>
          )}
        </Tile>
      )}
      {hasKey(totals, 'shop_margin_mkd') && (
        <Tile label={t('shops.kpi.shopMargin')} value={shopMargin != null ? f.den(shopMargin) : '—'} hint={t('shops.kpi.shopMarginHint')}
          sub={shareOf(shopMargin, exVat) != null ? t('shops.kpi.marginOf', { pct: f.pct(shareOf(shopMargin, exVat)) }) : undefined}
          alert={shopMargin != null && shopMargin < 0} />
      )}
      {hasKey(totals, 'group_margin_mkd') && (
        <Tile label={t('shops.kpi.groupMargin')} value={groupMargin != null ? f.den(groupMargin) : '—'} hint={t('shops.kpi.groupMarginHint')}
          sub={groupMargin == null ? t('shops.kpi.groupPending')
            : shareOf(groupMargin, exVat) != null ? t('shops.kpi.marginOf', { pct: f.pct(shareOf(groupMargin, exVat)) }) : undefined} />
      )}
      {shopsTotal != null && (
        <Tile label={t('shops.kpi.shopsOpen')} value={f.int(totals.shops_open ?? 0)}
          sub={shopsTotal > 0 ? t('shops.kpi.shopsOpenOf', { n: f.int(shopsTotal) }) : undefined} />
      )}
      {extra}
    </ul>
  );
}
