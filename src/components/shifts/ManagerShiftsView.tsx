import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, CalendarDays, LogIn } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiGetShiftsRunway } from '@/lib/shiftsApi';
import { RunwayBanner } from './RunwayBanner';
import { RollMonthDialog } from './RollMonthDialog';
import { ScheduleTab } from './ScheduleTab';
import { LoginsTab } from './LoginsTab';
import { StatsTab } from './StatsTab';

const TABS = ['schedule', 'logins', 'stats'] as const;
type TabKey = (typeof TABS)[number];

/**
 * The roster manager's half of /shifts (admin / manager with the `shifts` module): the runway
 * banner (5 days' warning + [Пренеси го месецот]) and the tabs Распоред · Најави · Статистика.
 * The tab lives in the URL (?tab=) so a reload or a shared link keeps it.
 */
export function ManagerShiftsView() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  const tab: TabKey = (TABS as readonly string[]).includes(raw ?? '') ? (raw as TabKey) : 'schedule';
  const setTab = useCallback((v: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (v === 'schedule') next.delete('tab'); else next.set('tab', v);
      return next;
    }, { replace: true });
  }, [setParams]);
  const [rollOpen, setRollOpen] = useState(false);

  const runway = useQuery({ queryKey: ['shifts', 'runway'], queryFn: apiGetShiftsRunway, refetchInterval: 10 * 60_000 });

  return (
    <div className="space-y-4">
      <RunwayBanner runway={runway.data} failed={runway.isError} onRoll={() => setRollOpen(true)} />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid h-auto w-full grid-cols-3 gap-1 sm:inline-flex sm:w-auto">
          <TabsTrigger value="schedule" className="min-h-9 gap-1.5"><CalendarDays className="h-3.5 w-3.5" aria-hidden />{t('shiftsPage.tabs.schedule')}</TabsTrigger>
          <TabsTrigger value="logins" className="min-h-9 gap-1.5"><LogIn className="h-3.5 w-3.5" aria-hidden />{t('shiftsPage.tabs.logins')}</TabsTrigger>
          <TabsTrigger value="stats" className="min-h-9 gap-1.5"><BarChart3 className="h-3.5 w-3.5" aria-hidden />{t('shiftsPage.tabs.stats')}</TabsTrigger>
        </TabsList>
        <TabsContent value="schedule" className="mt-4"><ScheduleTab onRoll={() => setRollOpen(true)} /></TabsContent>
        <TabsContent value="logins" className="mt-4"><LoginsTab /></TabsContent>
        <TabsContent value="stats" className="mt-4"><StatsTab /></TabsContent>
      </Tabs>

      <RollMonthDialog open={rollOpen} onOpenChange={setRollOpen}
        onApplied={() => { void qc.invalidateQueries({ queryKey: ['shifts'] }); }} />
    </div>
  );
}
