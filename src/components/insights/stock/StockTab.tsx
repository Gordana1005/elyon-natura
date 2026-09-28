import i18n from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Package, PackageX, TrendingUp } from 'lucide-react';
import type { InsightsResponse } from '@/lib/api';
import { cn } from '@/lib/utils';
import { KpiCard as Kpi } from '@/components/insights/KpiCard';
import { ListCard } from '@/components/insights/shared/ListCard';

// Insights → Stock. Moved verbatim out of ManagementInsightsPage (WP0) so the
// Returns & Stock package edits its own file.
export default function StockTab({ data }: { data: InsightsResponse }) {
  const ps = data.products_stock;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Kpi icon={AlertTriangle} label={i18n.t('insights.lowStock')} value={String(ps.low_stock.length)} tone="bg-amber-100 text-amber-700" />
        <Kpi icon={PackageX} label={i18n.t('insights.outOfStock')} value={String(ps.out_of_stock.length)} tone="bg-red-100 text-red-700" />
        <Kpi icon={Package} label={i18n.t('insights.activeProducts')} value={String(ps.stock.length)} tone="bg-blue-100 text-blue-700" />
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Package className="h-4 w-4" /> Stock report</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left py-2 px-2">{i18n.t('ordersPage.colProduct')}</th>
                <th className="text-right py-2 px-2">{i18n.t('insights.colStock')}</th>
                <th className="text-left py-2 px-2 pl-3">{i18n.t('insights.colState')}</th>
                <th className="text-right py-2 px-2">{i18n.t('insights.soldRange')}</th>
                <th className="text-right py-2 px-2">{i18n.t('insights.daysCover')}</th>
              </tr>
            </thead>
            <tbody>
              {ps.stock.map(s => (
                <tr key={s.name} className={cn('border-b last:border-0', s.state === 'out' && 'bg-red-50', s.state === 'low' && 'bg-amber-50')}>
                  <td className="py-2 px-2 font-medium max-w-[260px] truncate" title={s.name}>{s.name}</td>
                  <td className="py-2 px-2 text-right tabular-nums font-semibold">{s.stock_quantity}</td>
                  <td className="py-2 px-2 pl-3">
                    <Badge className={cn('text-[10px]',
                      s.state === 'out' ? 'bg-red-100 text-red-800' : s.state === 'low' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800')}>
                      {s.state === 'out' ? 'Out' : s.state === 'low' ? 'Low' : 'OK'}
                    </Badge>
                  </td>
                  <td className="py-2 px-2 text-right tabular-nums">{s.units_sold}</td>
                  <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">{s.days_of_cover ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <ListCard title={i18n.t('insights.topSellers')} icon={TrendingUp} rows={[...ps.top_sellers].sort((a, b) => b.units - a.units)} nameKey="product"
        cols={[{ k: 'units', label: i18n.t('insights.units') }, { k: 'revenue', label: i18n.t('insights.revenue'), money: true }]} />
    </div>
  );
}
