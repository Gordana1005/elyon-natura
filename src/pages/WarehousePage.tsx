import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ClipboardCheck, History, Lock, Package, PackageOpen, Send, Truck } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/EmptyState';
import { useAuth } from '@/contexts/AuthContext';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { OVERVIEW_COLOR_VARS } from '@/components/insights/overview/palette';
import { cn } from '@/lib/utils';
import { apiGetProducts } from '@/lib/api';
import { apiGetWarehouseQueue, type SendRow } from '@/lib/warehouseApi';
import { WarehouseKpis } from '@/components/warehouse/WarehouseKpis';
import { SendTab } from '@/components/warehouse/SendTab';
import { PackTab } from '@/components/warehouse/PackTab';
import { MexPushSettingsCard } from '@/components/warehouse/MexPushSettingsCard';
import { StockDayTab } from '@/components/warehouse/v2/StockDayTab';
import { ParcelsDayTab } from '@/components/warehouse/v2/ParcelsDayTab';
import { MovementsV2Tab } from '@/components/warehouse/v2/MovementsV2Tab';
import { CountV2Tab } from '@/components/warehouse/v2/CountV2Tab';
import { useStockAccess } from '@/components/warehouse/v2/shared';

type TabKey = 'send' | 'pack' | 'stock' | 'parcels' | 'movements' | 'count';

/** The params every tab understands; a tab's own filters stay behind when the reader switches tab. */
const SHARED_PARAMS = ['day', 'wh'] as const;

/**
 * /warehouse — the Insights style (plan Фаза 9, owner 30.09.2026; stock v2, owner 01.10.2026):
 *   tiles from the queue's counts (one call) ·
 *   Испрати до MEX (confirmed, no parcel → dry run → confirm → MEX) ·
 *   За пакување (parcels at MEX 8, read-only — printing is the MEX portal's) ·
 *   Залихи (stock v2: the stock per article on a Skopje day, from the 22.09 count + every parcel) ·
 *   Пратки (the day's parcels as stock sees them) · Движења (the stock ledger) · Попис (counts +
 *   the stock v2 health card). ?tab= deep-links; `day` and `wh` follow the reader across tabs.
 */
export default function WarehousePage() {
  const f = useInsightsFormat();
  const { t } = f;
  const { user } = useAuth();
  const access = useStockAccess();
  const canQueue = !!(user?.isAdmin || user?.isManager || user?.isWarehouse);
  const tabs: TabKey[] = [
    ...(canQueue ? (['send', 'pack'] as TabKey[]) : []),
    ...(access.canSee ? (['stock', 'parcels', 'movements'] as TabKey[]) : []),
    ...(access.canCount ? (['count'] as TabKey[]) : []),
  ];
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') as TabKey | null;
  const tab: TabKey | undefined = asked && tabs.includes(asked) ? asked : tabs[0];
  const setTab = (v: string) => setParams((p) => {
    const n = new URLSearchParams();
    n.set('tab', v);
    for (const k of SHARED_PARAMS) { const x = p.get(k); if (x) n.set(k, x); }
    return n;
  }, { replace: true });

  const kpis = useQuery({
    queryKey: ['warehouse-queue', 'kpis'],
    queryFn: () => apiGetWarehouseQueue<SendRow>({ tab: 'send', limit: 1 }),
    enabled: canQueue,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const products = useQuery<Array<{ is_active: boolean; stock_quantity: number; low_stock_threshold: number }>>({
    queryKey: ['warehouse-products'], queryFn: () => apiGetProducts(), staleTime: 60_000, enabled: canQueue,
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

        {!tab ? (
          <EmptyState icon={<Lock className="h-5 w-5" />} title={t('stock2.noAccess')} size="md" />
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            {/* Wraps instead of scrolling sideways on a phone. */}
            <TabsList className="grid h-auto grid-cols-2 gap-1 overflow-visible sm:flex sm:flex-wrap sm:justify-start">
              {canQueue && trigger('send', Send, t('warehousePage.tabs.send'), counts?.send)}
              {canQueue && trigger('pack', PackageOpen, t('warehousePage.tabs.pack'), counts?.pack)}
              {access.canSee && trigger('stock', Package, t('stock2.tabs.stock'))}
              {access.canSee && trigger('parcels', Truck, t('stock2.tabs.parcels'))}
              {access.canSee && trigger('movements', History, t('stock2.tabs.movements'))}
              {access.canCount && trigger('count', ClipboardCheck, t('stock2.tabs.count'))}
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
            {access.canSee && <TabsContent value="stock" className="mt-4"><StockDayTab f={f} /></TabsContent>}
            {access.canSee && <TabsContent value="parcels" className="mt-4"><ParcelsDayTab f={f} /></TabsContent>}
            {access.canSee && <TabsContent value="movements" className="mt-4"><MovementsV2Tab f={f} /></TabsContent>}
            {access.canCount && <TabsContent value="count" className="mt-4"><CountV2Tab f={f} /></TabsContent>}
          </Tabs>
        )}
      </div>
    </AppLayout>
  );
}
