import { useSearchParams } from 'react-router-dom';
import { Boxes, CalendarDays, HeartPulse, Store, Trophy, Truck, type LucideIcon } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/EmptyState';
import { useInsightsPeriod } from '@/components/insights/shared/useInsightsPeriod';
import { cn } from '@/lib/utils';
import { DayTab } from '@/components/shops/DayTab';
import { RankingTab } from '@/components/shops/RankingTab';
import { ShopDetailTab } from '@/components/shops/ShopDetailTab';
import { StockMatrixTab } from '@/components/shops/StockMatrixTab';
import { DeliveriesTab } from '@/components/shops/DeliveriesTab';
import { HealthTab } from '@/components/shops/HealthTab';
import { ShopsFilterBar } from '@/components/shops/ShopsFilterBar';
import { SHOPS_COLOR_VARS } from '@/components/shops/parts';
import { PERIOD_TABS, SHOPS_TABS, tabParams, type ShopsTab } from '@/components/shops/shopsModel';
import { useShopsAccess } from '@/components/shops/useShopsAccess';
import { useShopsFormat } from '@/components/shops/useShopsFormat';

const TAB_META: Record<ShopsTab, { icon: LucideIcon; labelKey: string }> = {
  day: { icon: CalendarDays, labelKey: 'shops.tabs.day' },
  ranking: { icon: Trophy, labelKey: 'shops.tabs.ranking' },
  shop: { icon: Store, labelKey: 'shops.tabs.shop' },
  stock: { icon: Boxes, labelKey: 'shops.tabs.stock' },
  deliveries: { icon: Truck, labelKey: 'shops.tabs.deliveries' },
  health: { icon: HeartPulse, labelKey: 'shops.tabs.health' },
};

/**
 * /shops "Продавници" (owner 02.10.2026, docs/SHOPS.md): the 22 shops of НАТУРА ТЕРАПИ СТОРЕС on
 * collabBox — sales today (live) or over a period, the ranking, one shop's detail, the stock
 * across the shops, what Natura delivered, and the reader's health. Owners see money, managers
 * the same pages without it (the api strips every `*_mkd` key; a figure shows only when its key
 * arrived), everyone else is refused and never sees the menu item. Tabs, period and filters live
 * in the URL (?tab=, range / from / to, shop, q …), Skopje days, Insights style, every screen.
 */
export default function ShopsPage() {
  const f = useShopsFormat();
  const { t } = f;
  const access = useShopsAccess();
  const [sp, setSp] = useSearchParams();
  const period = useInsightsPeriod();
  const tabs = SHOPS_TABS.filter((k) => k !== 'health' || access.health);
  const asked = sp.get('tab') as ShopsTab | null;
  const tab: ShopsTab = asked && tabs.includes(asked) ? asked : 'day';

  if (!access.any) {
    return (
      <AppLayout title={t('nav.shops')}>
        <EmptyState icon={<Store className="h-5 w-5" />} title={t('shops.noAccess')} description={t('shops.noAccessDesc')} />
      </AppLayout>
    );
  }

  return (
    <AppLayout title={t('nav.shops')}>
      <div className={cn('mx-auto min-w-0 max-w-[1680px] space-y-4', SHOPS_COLOR_VARS)}>
        <Tabs value={tab} onValueChange={(v) => setSp(tabParams(sp, v as ShopsTab))}>
          {/* Wraps instead of scrolling sideways on a phone (the /warehouse pattern). */}
          <TabsList className="grid h-auto grid-cols-2 gap-1 overflow-visible sm:flex sm:flex-wrap sm:justify-start">
            {tabs.map((k) => {
              const Icon = TAB_META[k].icon;
              return (
                <TabsTrigger key={k} value={k} className="min-h-9 justify-start gap-1.5 whitespace-normal text-left sm:justify-center">
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />{t(TAB_META[k].labelKey)}
                </TabsTrigger>
              );
            })}
          </TabsList>

          {PERIOD_TABS.has(tab) && <ShopsFilterBar period={period} className="mt-4" />}

          <TabsContent value="day" className="mt-4">{tab === 'day' && <DayTab period={period} f={f} />}</TabsContent>
          <TabsContent value="ranking" className="mt-4">{tab === 'ranking' && <RankingTab period={period} f={f} />}</TabsContent>
          <TabsContent value="shop" className="mt-4">{tab === 'shop' && <ShopDetailTab period={period} f={f} />}</TabsContent>
          <TabsContent value="stock" className="mt-4">{tab === 'stock' && <StockMatrixTab today={period.today} f={f} />}</TabsContent>
          <TabsContent value="deliveries" className="mt-4">{tab === 'deliveries' && <DeliveriesTab period={period} f={f} />}</TabsContent>
          {access.health && <TabsContent value="health" className="mt-4">{tab === 'health' && <HealthTab f={f} />}</TabsContent>}
        </Tabs>
      </div>
    </AppLayout>
  );
}
