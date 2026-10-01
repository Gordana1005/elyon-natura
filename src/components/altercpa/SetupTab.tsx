import { useTranslation } from 'react-i18next';
import { Globe, History, Radio, Tag, Users, Waypoints } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AccountsTab } from './AccountsTab';
import { MirrorTab } from './MirrorTab';
import { OfferQueueTab } from './OfferQueueTab';
import { SyncRunsTab } from './SyncRunsTab';
import { AffiliatesTab } from './AffiliatesTab';
import { SourcesTab } from './SourcesTab';
import type { SetupSub } from './tabs';

const SUBS: Array<{ key: SetupSub; icon: typeof Globe; label: string }> = [
  { key: 'mirror', icon: Globe, label: 'altercpa.tabMirror' },
  { key: 'offers', icon: Tag, label: 'altercpa.tabOffers' },
  { key: 'affiliates', icon: Users, label: 'altercpa.tabAffiliates' },
  { key: 'sources', icon: Waypoints, label: 'altercpa.tabSources' },
  { key: 'accounts', icon: Radio, label: 'altercpa.tabAccounts' },
  { key: 'runs', icon: History, label: 'altercpa.tabRuns' },
];

/**
 * Поставки — the AlterCPA bridge's working tabs, unchanged, as wrapping inner tabs (?sub=):
 * Огледало · Понуди · Афилијати · Извори · Сметки · Синхронизации. Old links
 * (?tab=mirror … ?tab=runs) land here through resolveAlterCpaTab.
 */
export function SetupTab({ sub, onSub }: { sub: SetupSub; onSub: (s: SetupSub) => void }) {
  const { t } = useTranslation();
  return (
    <Tabs value={sub} onValueChange={(v) => onSub(v as SetupSub)} className="space-y-4">
      <TabsList className="grid h-auto grid-cols-2 gap-1 overflow-visible sm:flex sm:flex-wrap sm:justify-start">
        {SUBS.map(({ key, icon: Icon, label }) => (
          <TabsTrigger key={key} value={key} className="min-h-9 justify-start gap-1.5 whitespace-normal text-left sm:justify-center">
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />{t(label)}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="mirror"><MirrorTab /></TabsContent>
      <TabsContent value="offers"><OfferQueueTab /></TabsContent>
      <TabsContent value="affiliates"><AffiliatesTab /></TabsContent>
      <TabsContent value="sources"><SourcesTab /></TabsContent>
      <TabsContent value="accounts"><AccountsTab /></TabsContent>
      <TabsContent value="runs"><SyncRunsTab /></TabsContent>
    </Tabs>
  );
}
