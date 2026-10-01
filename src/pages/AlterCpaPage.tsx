import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarCheck, ListChecks, Percent, Settings2 } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { OVERVIEW_COLOR_VARS } from '@/components/insights/overview/palette';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { TodayTab } from '@/components/altercpa/guarantee/TodayTab';
import { LeadsTab } from '@/components/altercpa/guarantee/LeadsTab';
import { RatesTab } from '@/components/altercpa/RatesTab';
import { SetupTab } from '@/components/altercpa/SetupTab';
import { resolveAlterCpaTab, tabParams, type AlterCpaTab } from '@/components/altercpa/tabs';

/**
 * /altercpa — Афилијати (AlterCPA), Macedonia only (plan 01.10.2026, Фаза 4).
 *
 *   Денес     the default: today's guarantee per webmaster — the rate, what to confirm or may
 *             cancel to land on 30%, the open leads, yesterday / the day before
 *   Стапки    the guarantee per arrival day × webmaster (?wm=&date= — the notification links)
 *   Лидови    every lead: arrival, webmaster / stream / offer, decision, operator, CRM, MEX
 *   Поставки  the bridge's working tabs (mirror, offers, affiliates, sources, accounts, runs)
 *
 * The guarantee (owner, 01.10.2026): (approved + cancel_other) ÷ every MK lead, target 30%,
 * test leads apart — migration 20260944000210. View is admin/manager; no money anywhere here
 * (the mirror's prices are owners-only, server-side). Leads keep arriving in AlterCPA; nothing
 * is sent back automatically — the one outbound path is the manual CPA button on /orders.
 */
export default function AlterCpaPage() {
  const f = useInsightsFormat();
  const { t } = f;
  const [params, setParams] = useSearchParams();
  const { tab, sub, canonical } = resolveAlterCpaTab(params);

  // An old ?tab=mirror … ?tab=runs link: rewrite it to Поставки with that inner tab.
  useEffect(() => {
    if (canonical) setParams(canonical, { replace: true });
  }, [canonical, setParams]);

  const choose = (v: string) => setParams((p) => tabParams(p, v as AlterCpaTab), { replace: true });

  const trigger = (key: AlterCpaTab, Icon: typeof Percent, label: string) => (
    <TabsTrigger key={key} value={key} className="min-h-9 justify-start gap-1.5 whitespace-normal text-left sm:justify-center">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />{label}
    </TabsTrigger>
  );

  return (
    <AppLayout title={t('nav.altercpa')}>
      <div className={cn('mx-auto min-w-0 max-w-[1680px] space-y-4', OVERVIEW_COLOR_VARS)}>
        <Tabs value={tab} onValueChange={choose}>
          {/* Wraps instead of scrolling sideways on a phone. */}
          <TabsList className="grid h-auto grid-cols-2 gap-1 overflow-visible sm:flex sm:flex-wrap sm:justify-start">
            {trigger('today', CalendarCheck, t('altercpaGuarantee.tabs.today'))}
            {trigger('rates', Percent, t('altercpaGuarantee.tabs.rates'))}
            {trigger('leads', ListChecks, t('altercpaGuarantee.tabs.leads'))}
            {trigger('setup', Settings2, t('altercpaGuarantee.tabs.setup'))}
          </TabsList>

          <TabsContent value="today" className="mt-4">{tab === 'today' && <TodayTab f={f} />}</TabsContent>
          <TabsContent value="rates" className="mt-4">{tab === 'rates' && <RatesTab f={f} />}</TabsContent>
          <TabsContent value="leads" className="mt-4">{tab === 'leads' && <LeadsTab f={f} />}</TabsContent>
          <TabsContent value="setup" className="mt-4">
            {tab === 'setup' && (
              <SetupTab sub={sub} onSub={(s) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', 'setup'); n.set('sub', s); return n; }, { replace: true })} />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
