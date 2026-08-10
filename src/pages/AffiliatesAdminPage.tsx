import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Globe, Handshake, LayoutDashboard, Send, Tag } from 'lucide-react';
import { AffiliateDashboardTab } from '@/components/affiliates/AffiliateDashboardTab';
import { AffiliatesTab } from '@/components/affiliates/AffiliatesTab';
import { OffersTab } from '@/components/affiliates/OffersTab';
import { PostbackLogTab } from '@/components/affiliates/PostbackLogTab';
import { MirrorTab } from '@/components/altercpa/MirrorTab';

const TABS = ['dashboard', 'affiliates', 'offers', 'postbacks', 'countries'] as const;

/**
 * Affiliates (Admin) — per-affiliate dashboard + staff super-metrics, then
 * webmaster management, offers/payouts, the postback delivery log and the
 * AlterCPA country mirror. View is admin/manager; every mutation is
 * re-checked admin-only server-side. Tabs are URL-synced (?tab=&affiliate=)
 * so affiliate rows can deep-link into the dashboard.
 */
export default function AffiliatesAdminPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const requested = searchParams.get('tab');
  const activeTab = TABS.find((v) => v === requested) ?? 'dashboard';

  return (
    <AppLayout title={t('nav.affiliates')}>
      <Tabs
        value={activeTab}
        onValueChange={(v) => setSearchParams((prev) => ({ ...Object.fromEntries(prev), tab: v }))}
        className="space-y-6"
      >
        <TabsList>
          <TabsTrigger value="dashboard" className="gap-2">
            <LayoutDashboard className="h-4 w-4" /> {t('affiliatesAdmin.tabDashboard')}
          </TabsTrigger>
          <TabsTrigger value="affiliates" className="gap-2">
            <Handshake className="h-4 w-4" /> {t('affiliatesAdmin.tabAffiliates')}
          </TabsTrigger>
          <TabsTrigger value="offers" className="gap-2">
            <Tag className="h-4 w-4" /> {t('affiliatesAdmin.tabOffers')}
          </TabsTrigger>
          <TabsTrigger value="postbacks" className="gap-2">
            <Send className="h-4 w-4" /> {t('affiliatesAdmin.tabPostbacks')}
          </TabsTrigger>
          {/* The AlterCPA mirror, by country. Same component as /altercpa's
              Mirror tab — one implementation, two entry points, so the two can
              never drift apart. */}
          <TabsTrigger value="countries" className="gap-2">
            <Globe className="h-4 w-4" /> {t('affiliatesAdmin.tabCountries')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard"><AffiliateDashboardTab /></TabsContent>
        <TabsContent value="affiliates"><AffiliatesTab /></TabsContent>
        <TabsContent value="offers"><OffersTab /></TabsContent>
        <TabsContent value="postbacks"><PostbackLogTab /></TabsContent>
        <TabsContent value="countries"><MirrorTab /></TabsContent>
      </Tabs>
    </AppLayout>
  );
}
