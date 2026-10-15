import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CalendarHeart, Inbox, LayoutDashboard, Scale, UserRound, UsersRound } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadError } from '@/components/insights/shared/LoadError';
import { apiHrEmployees, apiHrMe, apiHrRequests, MAX_SAME_DAY_HINT } from '@/lib/hrApi';
import { MyLeave } from '@/components/hr/MyLeave';
import { OverviewTab } from '@/components/hr/OverviewTab';
import { CalendarTab } from '@/components/hr/CalendarTab';
import { RequestsTab } from '@/components/hr/RequestsTab';
import { BalancesTab } from '@/components/hr/BalancesTab';
import { EmployeesTab } from '@/components/hr/EmployeesTab';
import { HolidaysTab } from '@/components/hr/HolidaysTab';
import { RequestDialog, type RequestPerson } from '@/components/hr/RequestDialog';

type TabKey = 'my' | 'overview' | 'calendar' | 'requests' | 'balances' | 'employees' | 'holidays';

/**
 * /hr — Човечки ресурси (owner 15.10.2026; migration 20261016120000). One page for everyone on
 * staff: "Мое" (one's own balance, requests, holidays). A team lead (dept_admin, or a named
 * approver) and a manager also get Преглед · Календар · Барања · Салда of their scope; the dossier
 * (Вработени) only super_admin / owner / finance. The api decides every one of these again.
 */
export default function HrPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['hr', 'me'], queryFn: () => apiHrMe() });
  const access = me.data?.access;
  const lead = !!access && (access.seeAll || access.team);

  const tabs = useMemo<TabKey[]>(() => {
    if (!access) return [];
    const out: TabKey[] = [];
    if (lead) out.push('overview', 'calendar', 'requests', 'balances');
    if (access.hasSelf) out.splice(lead ? 1 : 0, 0, 'my');
    if (access.full) out.push('employees');
    out.push('holidays');
    return out;
  }, [access, lead]);

  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as TabKey | null;
  const tab: TabKey = raw && tabs.includes(raw) ? raw : (tabs[0] ?? 'my');
  const setTab = useCallback((v: string) => {
    setParams((prev) => { const next = new URLSearchParams(prev); next.set('tab', v); return next; }, { replace: true });
  }, [setParams]);

  const open = useQuery({
    queryKey: ['hr', 'requests', 'open', me.data?.year],
    queryFn: () => apiHrRequests({ status: 'open' }),
    enabled: lead,
    refetchInterval: 5 * 60_000,
  });
  const openCount = (open.data?.requests ?? []).filter((r) => r.can_decide).length;
  const employees = useQuery({ queryKey: ['hr', 'employees', 'all'], queryFn: () => apiHrEmployees(true), enabled: lead });

  const [dialog, setDialog] = useState<'self' | 'other' | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['hr'] }); void qc.invalidateQueries({ queryKey: ['shifts'] }); };

  const selfPerson: RequestPerson[] = me.data?.employee
    ? [{ id: me.data.employee.id, name: me.data.employee.full_name, work_days: me.data.employee.work_days, holiday_calendars: me.data.employee.holiday_calendars }]
    : [];
  const others: RequestPerson[] = (employees.data?.employees ?? [])
    .filter((e) => e.status === 'active')
    .map((e) => ({ id: e.id, name: e.full_name, work_days: e.work_days, holiday_calendars: e.holiday_calendars }));

  const icons: Record<TabKey, typeof Inbox> = {
    my: UserRound, overview: LayoutDashboard, calendar: CalendarDays, requests: Inbox, balances: Scale, employees: UsersRound, holidays: CalendarHeart,
  };

  return (
    <AppLayout title={t('hrPage.title')}>
      <div className="space-y-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{t('hrPage.title')}</h2>
          <p className="text-xs text-muted-foreground">{lead ? t('hrPage.subtitleLead') : t('hrPage.subtitle')}</p>
        </div>

        {me.isError && !me.data ? (
          <LoadError text={t('hrPage.loadFailed')} onRetry={() => me.refetch()} />
        ) : !me.data || !access ? (
          <div className="space-y-3" aria-hidden><Skeleton variant="card" className="h-10" /><Skeleton variant="card" className="h-48" /></div>
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:inline-flex sm:w-auto sm:flex-wrap">
              {tabs.map((k) => {
                const Icon = icons[k];
                return (
                  <TabsTrigger key={k} value={k} className="min-h-9 gap-1.5">
                    <Icon className="h-3.5 w-3.5" aria-hidden />{t(`hrPage.tabs.${k}`)}
                    {k === 'requests' && openCount > 0 && (
                      <span className="ml-0.5 rounded-full bg-amber-500 px-1.5 text-[10px] font-semibold text-white">{openCount}</span>
                    )}
                  </TabsTrigger>
                );
              })}
            </TabsList>

            {tabs.includes('my') && (
              <TabsContent value="my" className="mt-4">
                <MyLeave me={me.data} onRequest={() => setDialog('self')} onChanged={refresh} />
              </TabsContent>
            )}
            {lead && (
              <>
                <TabsContent value="overview" className="mt-4">
                  <OverviewTab today={me.data.today} openCount={openCount}
                    employees={access.full ? employees.data?.employees : undefined} onOpenRequests={() => setTab('requests')} />
                </TabsContent>
                <TabsContent value="calendar" className="mt-4">
                  <CalendarTab today={me.data.today} maxSameDayHint={MAX_SAME_DAY_HINT} />
                </TabsContent>
                <TabsContent value="requests" className="mt-4">
                  <RequestsTab year={me.data.year} viewerFinal={access.final} canEnter={access.final}
                    onEnter={() => setDialog('other')} onChanged={refresh} />
                </TabsContent>
                <TabsContent value="balances" className="mt-4">
                  <BalancesTab today={me.data.today} canEdit={access.full} />
                </TabsContent>
              </>
            )}
            {access.full && (
              <TabsContent value="employees" className="mt-4"><EmployeesTab today={me.data.today} /></TabsContent>
            )}
            <TabsContent value="holidays" className="mt-4"><HolidaysTab today={me.data.today} /></TabsContent>
          </Tabs>
        )}
      </div>

      {me.data && (
        <RequestDialog
          open={dialog !== null}
          onOpenChange={(v) => { if (!v) setDialog(null); }}
          people={dialog === 'other' ? others : selfPerson}
          defaultPersonId={dialog === 'other' ? null : me.data.employee?.id ?? null}
          holidays={me.data.holidays}
          canRecord={dialog === 'other' && !!access?.final}
          today={me.data.today}
          onDone={refresh}
        />
      )}
    </AppLayout>
  );
}
