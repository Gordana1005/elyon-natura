import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useSearchParams } from 'react-router-dom';
import { LayoutDashboard, Megaphone, PiggyBank, Users } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InsightsFilterBar } from '@/components/insights/shared/InsightsFilterBar';
import { useInsightsPeriod } from '@/components/insights/shared/useInsightsPeriod';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useWebAccess } from '@/components/web/useWebAccess';
import { WebOverviewTab } from '@/components/web/WebOverviewTab';
import { WebAdsTab } from '@/components/web/WebAdsTab';
import { WebProfitTab } from '@/components/web/WebProfitTab';
import { WebCustomersTab } from '@/components/web/WebCustomersTab';

type TabKey = 'overview' | 'ads' | 'profit' | 'customers';

/**
 * /web — Веб-продавница (naturatherapy.mk; owner 15.10.2026: "подобро да имаме се во еден пејџ во
 * ВЕБ, а во извештаи пресметките"). One page for the web shop: Преглед (the cohort's web sales and
 * their channels, products, coupons, cities, payment) · Реклами (Meta spend, ROAS, paid ROAS) ·
 * Профит (the web row of the profit calculation, POAS) · Купувачи (counts for the e-mail
 * campaigns). The period is THE Insights period (in the URL). Every number is the same as in
 * Insights — this page reads the same calculations.
 */
export default function WebPage() {
  const { t } = useTranslation();
  const access = useWebAccess();
  const { loading } = usePermissions();
  const period = useInsightsPeriod();
  const f = useInsightsFormat();

  const tabs = useMemo<TabKey[]>(
    () => (access.margins ? ['overview', 'ads', 'profit', 'customers'] : ['overview', 'customers']),
    [access.margins],
  );
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as TabKey | null;
  const tab: TabKey = raw && tabs.includes(raw) ? raw : 'overview';
  const setTab = useCallback((v: string) => {
    setParams((prev) => { const n = new URLSearchParams(prev); if (v === 'overview') n.delete('tab'); else n.set('tab', v); return n; }, { replace: true });
  }, [setParams]);

  if (!loading && !access.any) return <Navigate to="/" replace />;
  const icons: Record<TabKey, typeof Users> = { overview: LayoutDashboard, ads: Megaphone, profit: PiggyBank, customers: Users };

  return (
    <AppLayout title={t('webPage.title')}>
      <div className="space-y-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t('webPage.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('webPage.subtitle')}</p>
        </div>
        {tab !== 'customers' && <InsightsFilterBar />}
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:inline-flex sm:w-auto">
            {tabs.map((k) => {
              const Icon = icons[k];
              return (
                <TabsTrigger key={k} value={k} className="min-h-9 gap-1.5">
                  <Icon className="h-3.5 w-3.5" aria-hidden />{t(`webPage.tabs.${k}`)}
                </TabsTrigger>
              );
            })}
          </TabsList>
          <TabsContent value="overview" className="mt-4"><WebOverviewTab period={period} f={f} /></TabsContent>
          {access.margins && <TabsContent value="ads" className="mt-4"><WebAdsTab period={period} f={f} /></TabsContent>}
          {access.margins && <TabsContent value="profit" className="mt-4"><WebProfitTab period={period} f={f} /></TabsContent>}
          <TabsContent value="customers" className="mt-4"><WebCustomersTab f={f} /></TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
