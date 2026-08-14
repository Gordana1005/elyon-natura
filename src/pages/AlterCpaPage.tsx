import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Globe, History, Percent, Radio, Tag } from 'lucide-react';
import { AccountsTab } from '@/components/altercpa/AccountsTab';
import { MirrorTab } from '@/components/altercpa/MirrorTab';
import { OfferQueueTab } from '@/components/altercpa/OfferQueueTab';
import { SyncRunsTab } from '@/components/altercpa/SyncRunsTab';
import { RatesTab } from '@/components/altercpa/RatesTab';

/**
 * AlterCPA Bridge — a read-only mirror of an AlterCPA account.
 *
 * Leads keep arriving at AlterCPA exactly as before; this pulls them in so the
 * CRM is one place. Leads in a callable geo become normal pending orders and go
 * through the usual pipeline; every other geo is mirrored for reporting and
 * never enters a calling queue. Nothing is sent back automatically — the one
 * outbound path is the manual CPA push button on /orders (2026-08-14), gated
 * by the altercpa_push_enabled setting.
 *
 * View is admin/manager; every mutation is re-checked admin-only server-side.
 *
 * The Rates tab is the 30% guarantee tracker; the rate-alert notifications
 * deep-link into it with ?tab=rates&wm=&date=.
 */
export default function AlterCpaPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') || 'mirror';

  return (
    <AppLayout title={t('nav.altercpa')}>
      <Tabs
        value={tab}
        onValueChange={(v) => setSearchParams((p) => { p.set('tab', v); return p; }, { replace: true })}
        className="space-y-6"
      >
        <TabsList>
          <TabsTrigger value="mirror" className="gap-2">
            <Globe className="h-4 w-4" /> {t('altercpa.tabMirror')}
          </TabsTrigger>
          <TabsTrigger value="offers" className="gap-2">
            <Tag className="h-4 w-4" /> {t('altercpa.tabOffers')}
          </TabsTrigger>
          <TabsTrigger value="accounts" className="gap-2">
            <Radio className="h-4 w-4" /> {t('altercpa.tabAccounts')}
          </TabsTrigger>
          <TabsTrigger value="rates" className="gap-2">
            <Percent className="h-4 w-4" /> {t('altercpa.tabRates')}
          </TabsTrigger>
          <TabsTrigger value="runs" className="gap-2">
            <History className="h-4 w-4" /> {t('altercpa.tabRuns')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="mirror"><MirrorTab /></TabsContent>
        <TabsContent value="offers"><OfferQueueTab /></TabsContent>
        <TabsContent value="accounts"><AccountsTab /></TabsContent>
        <TabsContent value="rates"><RatesTab /></TabsContent>
        <TabsContent value="runs"><SyncRunsTab /></TabsContent>
      </Tabs>
    </AppLayout>
  );
}
