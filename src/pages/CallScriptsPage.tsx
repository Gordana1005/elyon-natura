import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Flame, FlaskConical, Grid3X3, Library, MonitorSmartphone, ShoppingCart, type LucideIcon } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { useAuth } from '@/contexts/AuthContext';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PromoOfTheDayTab } from '@/components/callscripts/PromoOfTheDayTab';
import { ModeSwitch } from '@/components/callscripts/ModeSwitch';
import { ScriptLibrary } from '@/components/callscripts/library/ScriptLibrary';
import { ScriptEditor } from '@/components/callscripts/editor/ScriptEditor';
import { ScriptViewer } from '@/components/callscripts/editor/ScriptViewer';
import { CoverageTab } from '@/components/callscripts/coverage/CoverageTab';
import { ScriptTester } from '@/components/callscripts/tester/ScriptTester';
import { CurrentPanelTab } from '@/components/callscripts/legacy/CurrentPanelTab';
import { OrderScriptTab } from '@/components/callscripts/legacy/OrderScriptTab';
import { tabOf, tabParams, visibleTabs, type ScriptsTab } from '@/components/callscripts/scriptsModel';
import { useScriptsCoverage, useScriptsLibrary, useScriptsPerms } from '@/components/callscripts/useCallScriptsAdmin';

const TAB_META: Record<ScriptsTab, { icon: LucideIcon; labelKey: string }> = {
  library: { icon: Library, labelKey: 'callScripts.tabs.library' },
  coverage: { icon: Grid3X3, labelKey: 'callScripts.tabs.coverage' },
  tester: { icon: FlaskConical, labelKey: 'callScripts.tabs.tester' },
  current: { icon: MonitorSmartphone, labelKey: 'callScripts.tabs.current' },
  order: { icon: ShoppingCart, labelKey: 'callScripts.tabs.order' },
  promo: { icon: Flame, labelKey: 'promo.tab' },
};

/**
 * /call-scripts — targeted call scripts (owner 02.10.2026, docs/CALL-SCRIPTS.md): one script per
 * list group (Лидови: Нов лид · Повторен повик; Предикција: Нови купувачи … Корпа), optionally
 * attached to products. Tabs in the URL (?tab=library|coverage|tester|current|order|promo), the
 * editor at ?script=<id> or ?new=1&group=…&product=…. Admins and managers who may edit the module
 * write and publish; admins delete and flip the /calls switch; agents read the published library
 * and the promo. Insights style, every screen (cards below md, the grid scrolls inside its card).
 */
export default function CallScriptsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const perms = useScriptsPerms();
  const [sp, setSp] = useSearchParams();
  const tabs = visibleTabs(perms.canWrite);
  const tab = tabOf(sp, tabs);
  const scriptId = sp.get('script');
  const isNew = sp.get('new') === '1';
  const lib = useScriptsLibrary();
  // The coverage feeds the group chips' waiting counts (library attach) — writers only; the api answers 403 to agents.
  const cov = useScriptsCoverage({ families: true, assignedOnly: false }, perms.canWrite && tab === 'library');

  const body = (() => {
    if (scriptId && !perms.canWrite) return <ScriptViewer id={scriptId} backHref={tab === 'library' ? '/call-scripts' : `/call-scripts?tab=${tab}`} />;
    if ((scriptId || isNew) && perms.canWrite) return <ScriptEditor key={scriptId ?? 'new'} id={scriptId} perms={perms} from={tab} />;
    return null;
  })();

  return (
    <AppLayout title={t('nav.callSupportCenter')}>
      <div className="mx-auto min-w-0 max-w-[1680px] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="min-w-0 max-w-3xl text-sm text-muted-foreground">
            {perms.canWrite ? t('callScripts.pageDescWriter') : t('callScripts.pageDescAgent')}
          </p>
          {perms.canWrite && <ModeSwitch perms={perms} />}
        </div>

        {body ?? (
          <Tabs value={tab} onValueChange={(v) => setSp(tabParams(v as ScriptsTab))}>
            {/* Wraps instead of scrolling sideways on a phone (the /shops pattern). */}
            <TabsList className="grid h-auto grid-cols-2 gap-1 overflow-visible sm:flex sm:flex-wrap sm:justify-start">
              {tabs.map((k) => {
                const Icon = TAB_META[k].icon;
                return (
                  <TabsTrigger key={k} value={k} className="min-h-9 justify-start gap-1.5 whitespace-normal text-left sm:justify-center" data-testid={`tab-${k}`}>
                    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />{t(TAB_META[k].labelKey)}
                  </TabsTrigger>
                );
              })}
            </TabsList>

            <TabsContent value="library" className="mt-4">
              {tab === 'library' && <ScriptLibrary perms={perms} library={lib.data} loading={lib.isLoading} error={lib.error} coverage={cov.data ?? null} />}
            </TabsContent>
            {perms.canWrite && (
              <>
                <TabsContent value="coverage" className="mt-4">{tab === 'coverage' && <CoverageTab library={lib.data} canWrite={perms.canWrite} />}</TabsContent>
                <TabsContent value="tester" className="mt-4">{tab === 'tester' && <ScriptTester library={lib.data} />}</TabsContent>
                <TabsContent value="current" className="mt-4">
                  {tab === 'current' && <CurrentPanelTab canEdit={perms.canWrite} canDelete={perms.canDelete} library={lib.data?.scripts ?? []} />}
                </TabsContent>
                <TabsContent value="order" className="mt-4">{tab === 'order' && <OrderScriptTab canEdit={perms.canWrite} />}</TabsContent>
              </>
            )}
            <TabsContent value="promo" className="mt-4">{tab === 'promo' && <PromoOfTheDayTab isAdmin={!!user?.isAdmin} />}</TabsContent>
          </Tabs>
        )}
      </div>
    </AppLayout>
  );
}
