import i18n from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, Coins, Package, TrendingUp, Truck, Users } from 'lucide-react';
import type { InsightsResponse } from '@/lib/api';
import type { DateRange } from '@/components/DateRangePicker';
import { formatMoney } from '@/lib/currency';
import { KpiCard as Kpi } from '@/components/insights/KpiCard';
import PureProfitExportDialog from '@/components/insights/PureProfitExportDialog';
import ChannelPLCard from '@/components/insights/ChannelPLCard';
import AffiliateBreakdownCard from '@/components/insights/AffiliateBreakdownCard';

// Insights → Pure Profit. Moved verbatim out of ManagementInsightsPage (WP0)
// so the Profit package edits its own file.

// Dual EUR/LEV money display (elyon-currency skill): EUR primary, LEV muted.
function Money({ eur, className }: { eur: number; className?: string }) {
  return (
    <span className={className}>
      {formatMoney(eur)}{' '}

    </span>
  );
}

const courierServiceLabel = (k: string): string => ({
  econt_office: i18n.t('insights.econtOffice'), econt_door: i18n.t('insights.econtDoor'),
  speedy_office: i18n.t('insights.speedyOffice'), speedy_door: i18n.t('insights.speedyDoor'),
  mex_office: i18n.t('insights.mexOffice'), mex_door: i18n.t('insights.mexDoor'),
  unknown: i18n.t('insights.courierNotRecorded'),
}[k] || k);

export default function PureProfitTab({ data, range, canExport }: { data: InsightsResponse; range: DateRange; canExport: boolean }) {
  const pp = data.pure_profit;
  const hasPureProfit = !!pp;

  // Costs (new actuals fields, with safe fallbacks to the legacy keys).
  const cash = pp?.cash_collected ?? 0;
  const vat = pp?.vat ?? 0;
  const vatPct = Math.round((pp?.vat_rate ?? 0.2) * 100);
  const cogs = pp?.cogs ?? 0;
  const commissions = pp?.agent_commissions ?? pp?.special_agent_commissions ?? 0;
  const delivery = pp?.delivery_cost ?? 0;
  const returnLoss = pp?.return_loss ?? 0;
  const clear = pp?.clear_profit ?? 0;
  const totalCosts = vat + cogs + commissions + delivery + returnLoss;
  const costCoverage = pp?.cost_coverage ?? 1;
  const missingCost = pp?.products_missing_cost ?? [];

  const byProduct = pp?.by_product || [];
  const paidOrders = pp?.paid_orders ?? 0;
  const paidPackages = pp?.paid_packages ?? 0;
  const packagesPerOrder = pp?.packages_per_order ?? 0;

  const logistics = data.logistics || [];
  const logiTotals = logistics.reduce(
    (t, l) => ({
      delivered: t.delivered + l.delivered, returned: t.returned + l.returned,
      deliver_cost: t.deliver_cost + l.deliver_cost, return_cost: t.return_cost + l.return_cost,
      total_cost: t.total_cost + l.total_cost,
    }),
    { delivered: 0, returned: 0, deliver_cost: 0, return_cost: 0, total_cost: 0 },
  );

  // Agents with payout data
  const agentsWithPayout = (data.agents || []).filter((a: any) => (a.payout_earned ?? 0) > 0)
    .sort((a: any, b: any) => (b.payout_earned ?? 0) - (a.payout_earned ?? 0));

  return (
    <div className="space-y-4">
      {/* The export carries the whole money picture — owners only. */}
      {canExport && (
        <div className="flex justify-end">
          <PureProfitExportDialog data={data} range={range} />
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi
          icon={Coins}
          label={i18n.t('insights.kpiCash')}
          value={hasPureProfit ? formatMoney(cash) : '—'}
          tone="bg-emerald-100 text-emerald-700"
        />
        <Kpi
          icon={Coins}
          label={i18n.t('insights.kpiVat', { pct: vatPct })}
          value={hasPureProfit ? `−${formatMoney(vat)}` : '—'}
          tone="bg-rose-100 text-rose-700"
        />
        <Kpi
          icon={Package}
          label={i18n.t('insights.kpiCogs')}
          value={hasPureProfit ? `−${formatMoney(cogs)}` : '—'}
        />
        <Kpi
          icon={Truck}
          label={i18n.t('insights.kpiDelivery')}
          value={hasPureProfit ? `−${formatMoney(delivery + returnLoss)}` : '—'}
          tone="bg-sky-100 text-sky-700"
        />
        <Kpi
          icon={Users}
          label={i18n.t('insights.kpiCommissions')}
          value={hasPureProfit ? `−${formatMoney(commissions)}` : '—'}
          tone="bg-amber-100 text-amber-700"
        />
        <Kpi
          icon={TrendingUp}
          label={i18n.t('insights.kpiClear')}
          value={hasPureProfit ? formatMoney(clear) : '—'}
          tone="bg-primary/10 text-primary"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Coins className="h-4 w-4" /> Pure Profit Breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!hasPureProfit ? (
            <div className="text-sm text-muted-foreground">{i18n.t('insights.noPureProfit')}</div>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="font-medium text-emerald-700">{i18n.t('insights.cashCollected')}</span>
                <Money eur={cash} className="font-semibold text-emerald-700" />
              </div>
              <div className="flex justify-between text-rose-600">
                <span>{i18n.t('insights.vatLine', { pct: vatPct })}</span>
                <span className="font-semibold">−<Money eur={vat} /></span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>{i18n.t('insights.cogsLine')}</span>
                <span className="font-semibold">−<Money eur={cogs} /></span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>{i18n.t('insights.deliveryLine')}</span>
                <span className="font-semibold">−<Money eur={delivery} /></span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>{i18n.t('insights.returnLossLine')}</span>
                <span className="font-semibold">−<Money eur={returnLoss} /></span>
              </div>
              <div className="flex justify-between text-amber-600">
                <span>{i18n.t('insights.commissionsLine')}</span>
                <span className="font-semibold">−<Money eur={commissions} /></span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground border-t pt-2">
                <span>{i18n.t('insights.totalCosts')}</span>
                <span>−{formatMoney(totalCosts)}</span>
              </div>
              <div className="border-t pt-2 flex justify-between font-bold text-lg">
                <span>{i18n.t('insights.clearMoney')}</span>
                <Money eur={clear} />
              </div>
              <div className="text-xs text-muted-foreground pt-1">
                {i18n.t('insights.cashBasisNote')}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {hasPureProfit && costCoverage < 1 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 flex gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <span className="font-semibold">{i18n.t('insights.coverageKnown', { pct: (costCoverage * 100).toFixed(1) })}</span>
            {i18n.t('insights.coverageWarning')}<span className="font-medium">{missingCost.join(', ')}</span>
          </div>
        </div>
      )}

      {/* Where the money came from: the same waterfall split by channel, plus
          the per-affiliator (webmaster) breakdown. Lead cost is 0 until
          per-webmaster rates are injected. */}
      {data.channel_pl && (
        <ChannelPLCard data={data.channel_pl} vatPct={vatPct} rangeFrom={range?.from} />
      )}
      {data.channel_pl && <AffiliateBreakdownCard byAffiliate={data.channel_pl.by_affiliate} />}

      {byProduct.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Package className="h-4 w-4" /> Product Breakdown (paid orders)
            </CardTitle>
            <div className="text-xs text-muted-foreground">
              {paidOrders.toLocaleString()} paid orders · {paidPackages.toLocaleString()} packages ·{' '}
              {packagesPerOrder.toFixed(1)} per order
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left py-2">{i18n.t('ordersPage.colProduct')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colPackages')}</th>
                  <th className="text-right py-2">{i18n.t('insights.orders')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colUnitPrice')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colUnitCost')}</th>
                  <th className="text-right py-2">{i18n.t('insights.revenue')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colNetRevenue')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colCost')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colProfit')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colNetProfit')}</th>
                </tr>
              </thead>
              <tbody>
                {byProduct.map((p) => (
                  <tr key={p.product} className="border-b last:border-0">
                    <td className="py-2 font-medium">
                      {p.product}
                      <span className="text-muted-foreground font-normal"> · {p.packages}×{formatMoney(p.unit_price)}</span>
                    </td>
                    <td className="py-2 text-right">{p.packages.toLocaleString()}</td>
                    <td className="py-2 text-right">{p.orders.toLocaleString()}</td>
                    <td className="py-2 text-right">{formatMoney(p.unit_price)}</td>
                    <td className="py-2 text-right text-muted-foreground">{p.unit_cost > 0 ? formatMoney(p.unit_cost) : '—'}</td>
                    <td className="py-2 text-right">{formatMoney(p.revenue)}</td>
                    <td className="py-2 text-right text-muted-foreground">{formatMoney(p.net_revenue ?? p.revenue)}</td>
                    <td className="py-2 text-right text-muted-foreground">{formatMoney(p.cogs)}</td>
                    <td className="py-2 text-right font-semibold text-emerald-600">{formatMoney(p.profit)}</td>
                    <td className="py-2 text-right font-semibold">{formatMoney(p.net_profit ?? p.profit)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="py-2">{i18n.t('insights.totalRow')}</td>
                  <td className="py-2 text-right">{paidPackages.toLocaleString()}</td>
                  <td className="py-2 text-right">{paidOrders.toLocaleString()}</td>
                  <td className="py-2 text-right" colSpan={2}></td>
                  <td className="py-2 text-right">{formatMoney(byProduct.reduce((s, p) => s + p.revenue, 0))}</td>
                  <td className="py-2 text-right text-muted-foreground">{formatMoney(byProduct.reduce((s, p) => s + (p.net_revenue ?? p.revenue), 0))}</td>
                  <td className="py-2 text-right text-muted-foreground">{formatMoney(byProduct.reduce((s, p) => s + p.cogs, 0))}</td>
                  <td className="py-2 text-right text-emerald-600">{formatMoney(byProduct.reduce((s, p) => s + p.profit, 0))}</td>
                  <td className="py-2 text-right">{formatMoney(byProduct.reduce((s, p) => s + (p.net_profit ?? p.profit), 0))}</td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}

      {logistics.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Truck className="h-4 w-4" /> Logistics Spend by Courier
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left py-2">{i18n.t('insights.courierService')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colDelivered')}</th>
                  <th className="text-right py-2">{i18n.t('status.returned')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colDeliveryCost')}</th>
                  <th className="text-right py-2">{i18n.t('insights.colReturnLoss')}</th>
                  <th className="text-right py-2">{i18n.t('insights.totalRow')}</th>
                </tr>
              </thead>
              <tbody>
                {logistics.map((l) => {
                  const key = `${l.courier}_${l.service}`;
                  return (
                    <tr key={key} className="border-b last:border-0">
                      <td className="py-2 font-medium">{courierServiceLabel(key)}</td>
                      <td className="py-2 text-right">{l.delivered.toLocaleString()}</td>
                      <td className="py-2 text-right">{l.returned.toLocaleString()}</td>
                      <td className="py-2 text-right">{formatMoney(l.deliver_cost)}</td>
                      <td className="py-2 text-right text-pink-600">{formatMoney(l.return_cost)}</td>
                      <td className="py-2 text-right font-semibold">{formatMoney(l.total_cost)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="py-2">{i18n.t('insights.totalRow')}</td>
                  <td className="py-2 text-right">{logiTotals.delivered.toLocaleString()}</td>
                  <td className="py-2 text-right">{logiTotals.returned.toLocaleString()}</td>
                  <td className="py-2 text-right">{formatMoney(logiTotals.deliver_cost)}</td>
                  <td className="py-2 text-right text-pink-600">{formatMoney(logiTotals.return_cost)}</td>
                  <td className="py-2 text-right"><Money eur={logiTotals.total_cost} /></td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}

      {agentsWithPayout.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4" /> Agent Earnings (Payouts)
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="text-left py-2">{i18n.t('search.colAgent')}</th>
                  <th className="text-right py-2">{i18n.t('insights.payoutEarned')}</th>
                  <th className="text-right py-2">{i18n.t('insights.packagesSold')}</th>
                </tr>
              </thead>
              <tbody>
                {agentsWithPayout.map((a: any) => (
                  <tr key={a.name} className="border-b last:border-0">
                    <td className="py-2 font-medium">{a.name}</td>
                    <td className="py-2 text-right font-semibold text-emerald-600">{formatMoney(a.payout_earned || 0)}</td>
                    <td className="py-2 text-right">{(a.packages_sold ?? a.units ?? 0).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
