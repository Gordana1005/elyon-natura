import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ClipboardCheck, History, Package, PackageOpen, Send } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { OVERVIEW_COLOR_VARS } from '@/components/insights/overview/palette';
import { cn } from '@/lib/utils';
import { apiGetProducts } from '@/lib/api';
import { apiGetWarehouseQueue, type SendRow } from '@/lib/warehouseApi';
import StockCountTab from '@/components/warehouse/StockCountTab';
import { WarehouseKpis } from '@/components/warehouse/WarehouseKpis';
import { SendTab } from '@/components/warehouse/SendTab';
import { PackTab } from '@/components/warehouse/PackTab';
import { StockTab } from '@/components/warehouse/StockTab';
import { MovementsTab } from '@/components/warehouse/MovementsTab';
import { MexPushSettingsCard } from '@/components/warehouse/MexPushSettingsCard';

type TabKey = 'send' | 'pack' | 'stock' | 'count' | 'movements';

/**
 * /warehouse — rebuilt for plan Фаза 9 (owner 30.09.2026), in the Insights style:
 *   tiles from the queue's counts (one call, no 22k-order download) ·
 *   Испрати до MEX (confirmed, no parcel → dry run → confirm → MEX) ·
 *   За пакување (parcels at MEX 8, read-only — printing is the MEX portal's) ·
 *   Залихи · Попис · Движења (stock: restyled only — the owner deferred its logic).
 * Removed: Историја (it duplicated /orders), the any-status dropdown, Delete, "Mark shipped"
 * and the English CSV export. ?tab= deep-links (Магацин → Попис = ?tab=count).
 */
export default function WarehousePage() {
  const f = useInsightsFormat();
  const { t } = f;
  const { user } = useAuth();
  const { canSeeBusiness } = usePermissions();
  const canQueue = !!(user?.isAdmin || user?.isManager || user?.isWarehouse);
  const canCount = !!(user?.isAdmin || user?.isWarehouse) || canSeeBusiness;
  const tabs: TabKey[] = [...(canQueue ? (['send', 'pack'] as TabKey[]) : []), 'stock', ...(canCount ? (['count'] as TabKey[]) : []), 'movements'];
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') as TabKey | null;
  const tab: TabKey = asked && tabs.includes(asked) ? asked : tabs[0];
  const setTab = (v: string) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', v); return n; }, { replace: true });

  const kpis = useQuery({
    queryKey: ['warehouse-queue', 'kpis'],
    queryFn: () => apiGetWarehouseQueue<SendRow>({ tab: 'send', limit: 1 }),
    enabled: canQueue,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const products = useQuery<Array<{ is_active: boolean; stock_quantity: number; low_stock_threshold: number }>>({
    queryKey: ['warehouse-products'], queryFn: () => apiGetProducts(), staleTime: 60_000,
  });
  const lowStock = products.data ? products.data.filter((p) => p.is_active && p.stock_quantity < p.low_stock_threshold).length : null;
  const counts = kpis.data?.counts;

  const trigger = (key: TabKey, Icon: typeof Send, label: string, n?: number) => (
    <TabsTrigger key={key} value={key} className="min-h-9 justify-start gap-1.5 whitespace-normal text-left sm:justify-center">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />{label}
      {n != null && <span className="ml-1 rounded-full bg-muted-foreground/10 px-1.5 py-px text-[11px] font-semibold tabular-nums">{f.int(n)}</span>}
    </TabsTrigger>
  );

  return (
    <AppLayout title={t('nav.warehouse')}>
      <div className={cn('mx-auto min-w-0 max-w-[1680px] space-y-4', OVERVIEW_COLOR_VARS)}>
        {canQueue && <WarehouseKpis counts={counts} lowStock={lowStock} f={f} />}

        <Tabs value={tab} onValueChange={setTab}>
          {/* Wraps instead of scrolling sideways on a phone. */}
          <TabsList className="grid h-auto grid-cols-2 gap-1 overflow-visible sm:flex sm:flex-wrap sm:justify-start">
            {canQueue && trigger('send', Send, t('warehousePage.tabs.send'), counts?.send)}
            {canQueue && trigger('pack', PackageOpen, t('warehousePage.tabs.pack'), counts?.pack)}
            {trigger('stock', Package, t('warehousePage.tabs.stock'))}
            {canCount && trigger('count', ClipboardCheck, t('stockCount.tab'))}
            {trigger('movements', History, t('warehousePage.tabs.movements'))}
          </TabsList>

          {canQueue && (
            <TabsContent value="send" className="mt-4 space-y-4">
              <SendTab f={f} />
              {user?.isAdmin && <MexPushSettingsCard f={f} />}
            </TabsContent>
          )}
          {canQueue && (
            <TabsContent value="pack" className="mt-4">
              <PackTab f={f} staleCount={counts?.pack_stale ?? 0} staleDays={counts?.stale_days ?? 14} />
            </TabsContent>
          )}
          <TabsContent value="stock" className="mt-4"><StockTab f={f} /></TabsContent>
          {canCount && <TabsContent value="count" className="mt-4"><StockCountTab /></TabsContent>}
          <TabsContent value="movements" className="mt-4"><MovementsTab f={f} /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
