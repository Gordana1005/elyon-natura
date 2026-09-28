import i18n from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MapPin, Package, TrendingUp, Truck } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { InsightsResponse } from '@/lib/api';
import { ListCard } from '@/components/insights/shared/ListCard';
import { cap, moneyTip } from '@/components/insights/shared/tabFormat';

// Insights → Sales. Moved verbatim out of ManagementInsightsPage (WP0) so the
// Sales package edits its own file.
export default function SalesTab({ data }: { data: InsightsResponse }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Package className="h-4 w-4" /> Top products by revenue</CardTitle></CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={320}>
            <BarChart data={data.sales.by_product.slice(0, 12)} layout="vertical" margin={{ left: 20 }}>
              <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
              <XAxis type="number" tick={{ fontSize: 11 }} />
              <YAxis dataKey="product" type="category" tick={{ fontSize: 10 }} width={130} />
              <Tooltip formatter={(v: any, n: any) => n === 'revenue' ? moneyTip(Number(v)) : v} />
              <Bar dataKey="revenue" fill="hsl(27,95%,48%)" name="revenue" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
      <ListCard title={i18n.t('insights.revenueByCity')} icon={MapPin} rows={data.sales.by_city} nameKey="city"
        cols={[{ k: 'orders', label: i18n.t('insights.orders') }, { k: 'revenue', label: i18n.t('insights.revenue'), money: true }]} />
      <ListCard title={i18n.t('insights.byDeliveryMethod')} icon={Truck} rows={data.sales.by_delivery} nameKey="delivery"
        cols={[{ k: 'orders', label: i18n.t('insights.orders') }, { k: 'revenue', label: i18n.t('insights.revenue'), money: true }]} transformName={cap} />
      <ListCard title={i18n.t('insights.bySource')} icon={TrendingUp} rows={data.sales.by_source} nameKey="source"
        cols={[{ k: 'orders', label: i18n.t('insights.orders') }, { k: 'revenue', label: i18n.t('insights.revenue'), money: true }]} transformName={cap}
        note="Historical orders are mostly 'manual' imports; source detail grows as webhook/lead orders come in." />
    </div>
  );
}
