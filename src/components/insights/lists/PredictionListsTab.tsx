import i18n from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Coins, ListChecks, RotateCcw, TrendingUp } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { InsightsResponse } from '@/lib/api';
import { formatMoney } from '@/lib/currency';
import { EmptyState } from '@/components/EmptyState';
import { KpiCard as Kpi } from '@/components/insights/KpiCard';
import { moneyTip, pct } from '@/components/insights/shared/tabFormat';

// Insights → Prediction lists. Moved verbatim out of ManagementInsightsPage
// (WP0) so the Lists package edits its own file.
export default function PredictionListsTab({ data }: { data: InsightsResponse }) {
  const lists = data.prediction_lists || [];
  const totals = lists.reduce(
    (t, l) => ({
      orders: t.orders + l.orders, paid: t.paid + l.paid, returned: t.returned + l.returned,
      cancelled: t.cancelled + l.cancelled, revenue: t.revenue + l.revenue,
      refund_value: t.refund_value + l.refund_value, net_revenue: t.net_revenue + l.net_revenue,
      bonus_paid: t.bonus_paid + l.bonus_paid,
    }),
    { orders: 0, paid: 0, returned: 0, cancelled: 0, revenue: 0, refund_value: 0, net_revenue: 0, bonus_paid: 0 },
  );

  if (lists.length === 0) {
    return (
      <EmptyState
        icon={<ListChecks className="h-5 w-5" />}
        title={i18n.t('insights.noListSales')}
        description={i18n.t('insights.noListSalesDesc')}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={Coins} label={i18n.t('insights.revenueFromLists')} value={formatMoney(totals.revenue)} tone="bg-emerald-100 text-emerald-700" />
        <Kpi icon={TrendingUp} label={i18n.t('insights.netAfterRefunds')} value={formatMoney(totals.net_revenue)} sub={i18n.t('insights.paidOrdersSub', { count: totals.paid.toLocaleString() })} tone="bg-teal-100 text-teal-700" />
        <Kpi icon={RotateCcw} label={i18n.t('insights.refundsReturned')} value={formatMoney(totals.refund_value)} sub={i18n.t('insights.returnedSub', { count: totals.returned.toLocaleString() })} tone="bg-orange-100 text-orange-700" />
        <Kpi icon={Coins} label={i18n.t('insights.bonusesPaid')} value={formatMoney(totals.bonus_paid)} sub={i18n.t('insights.bonusesSub')} tone="bg-amber-100 text-amber-700" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><ListChecks className="h-4 w-4" /> Money generated per prediction list</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left py-2 px-2">{i18n.t('insights.colList')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.membersTitle')}>{i18n.t('insights.colMembers')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.ordersAttrTitle')}>{i18n.t('insights.orders')}</th>
                <th className="text-right py-2 px-2">{i18n.t('insights.colPaid')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.cancelledTitle')}>{i18n.t('insights.colCancelled')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.refundsTitle')}>{i18n.t('insights.colRefunds')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.revenueTitle')}>{i18n.t('insights.revenue')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.netTitle')}>{i18n.t('insights.colNet')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.bonusTitle')}>{i18n.t('insights.colBonus')}</th>
                <th className="text-right py-2 px-2" title={i18n.t('insights.convTitle')}>{i18n.t('insights.colConv')}</th>
              </tr>
            </thead>
            <tbody>
              {lists.map(l => (
                <tr key={l.list_id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="py-2 px-2 font-medium">
                    <span className="flex items-center gap-2">
                      {l.name}
                      <Badge variant="outline" className="text-[10px]">{l.type === 'uploaded' ? 'campaign' : 'segment'}</Badge>
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">{l.members.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{l.orders.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-emerald-600 font-medium">{l.paid.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-red-600">{l.cancelled.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-orange-600">{l.returned.toLocaleString()}</td>
                  <td className="py-2 px-2 text-right tabular-nums font-semibold">{formatMoney(l.revenue)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{formatMoney(l.net_revenue)}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-amber-600">{formatMoney(l.bonus_paid)}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{pct(l.conversion_rate)}</td>
                </tr>
              ))}
              <tr className="border-t-2 font-semibold bg-muted/20">
                <td className="py-2 px-2">{i18n.t('insights.totalRow')}</td>
                <td className="py-2 px-2"></td>
                <td className="py-2 px-2 text-right tabular-nums">{totals.orders.toLocaleString()}</td>
                <td className="py-2 px-2 text-right tabular-nums text-emerald-600">{totals.paid.toLocaleString()}</td>
                <td className="py-2 px-2 text-right tabular-nums text-red-600">{totals.cancelled.toLocaleString()}</td>
                <td className="py-2 px-2 text-right tabular-nums text-orange-600">{totals.returned.toLocaleString()}</td>
                <td className="py-2 px-2 text-right tabular-nums">{formatMoney(totals.revenue)}</td>
                <td className="py-2 px-2 text-right tabular-nums">{formatMoney(totals.net_revenue)}</td>
                <td className="py-2 px-2 text-right tabular-nums text-amber-600">{formatMoney(totals.bonus_paid)}</td>
                <td className="py-2 px-2"></td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{i18n.t('insights.revenueByList')}</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={lists.filter(l => l.revenue > 0).slice(0, 15)}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-25} textAnchor="end" height={70} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(v: any) => moneyTip(Number(v))} />
              <Bar dataKey="revenue" fill="hsl(142,76%,36%)" name="revenue" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground px-1">
        Attribution is captured when an order is created, so list ROI is exact from launch forward.
        Returns count as refunds (money that came back in this COD business). Members shows current list size.
      </p>
    </div>
  );
}
