import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarDays, ChevronLeft, ChevronRight, Clock, Coins, Headphones, Loader2, PhoneCall, ShoppingBag, Users,
} from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { EmptyState } from '@/components/EmptyState';
import { KpiCard } from '@/components/insights/KpiCard';
import { AgentFloorCard, STATUS_STYLE } from '@/components/agent-floor/AgentFloorCard';
import { AgentFloorSheet } from '@/components/agent-floor/AgentFloorSheet';
import { filterAgents, sortAgents, teamTotals, type StatusFilter } from '@/components/agent-floor/floor';
import CallActivityTimeline from '@/components/insights/calls/CallActivityTimeline';
import { DAY_PARAM } from '@/components/insights/calls/workModel';
import { WORK_COLOR_VARS } from '@/components/insights/calls/workPalette';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { apiGetAgentFloor, apiGetAgents, type AgentLiveStatus } from '@/lib/api';
import { formatDenari } from '@/lib/currency';
import { fmtDuration } from '@/lib/design-utils';
import { shiftDay, skopjeDay } from '@/lib/presence/state';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';

// ── Активност на агенти (owner 05.11.2026, "како на BG") — one page for everything an
// admin / manager needs about the floor on ONE Skopje day: who is working right now,
// login and time on the CRM, calls + talk time, breaks, the day's sales, and the call
// timeline. Data: GET /api/agent-floor (the cohort board + the activity day); the
// timeline is the Insights tab's swimlane (GET /insights/work/day) for the same day.
// Money (денари) shows only for a money viewer — the api decides (access levels).

const parseLocal = (date: string) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const isYmd = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

const FILTERS: StatusFilter[] = ['all', 'in_call', 'online', 'idle', 'break', 'offline'];

export default function AgentActivityPage() {
  const { t } = useTranslation();
  const f = useInsightsFormat();
  const todayStr = skopjeDay();
  // The day lives in the URL (?day=) so the timeline below (which reads the same param) follows it.
  const [sp, setSp] = useSearchParams();
  const rawDay = sp.get(DAY_PARAM);
  const date = isYmd(rawDay) && rawDay <= todayStr ? rawDay : todayStr;
  const setDate = useCallback((d: string) => setSp((prev) => {
    const n = new URLSearchParams(prev);
    if (d === skopjeDay()) n.delete(DAY_PARAM); else n.set(DAY_PARAM, d);
    return n;
  }, { replace: true }), [setSp]);
  const [agentFilter, setAgentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [calOpen, setCalOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const isToday = date === todayStr;

  const { data: agentsList } = useQuery({
    queryKey: ['agents-for-activity'],
    queryFn: apiGetAgents,
    staleTime: 5 * 60 * 1000,
  });

  const { data, isLoading, isError, dataUpdatedAt, isFetching } = useQuery({
    queryKey: ['agent-floor', date, agentFilter],
    queryFn: () => apiGetAgentFloor({ date, agent_id: agentFilter !== 'all' ? agentFilter : undefined }),
    refetchInterval: isToday ? 30_000 : false,
  });

  const sorted = useMemo(() => sortAgents(data?.agents ?? []), [data]);
  const totals = useMemo(() => teamTotals(sorted), [sorted]);
  const shown = useMemo(() => filterAgents(sorted, statusFilter), [sorted, statusFilter]);
  const openAgent = sorted.find((a) => a.user_id === openId) ?? null;
  const live = !!data?.is_today;
  const hasMoney = totals.valueMkd != null;

  const dayControls = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => setDate(shiftDay(date, -1))} aria-label={t('agentFloor.prevDay')}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Popover open={calOpen} onOpenChange={setCalOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="h-9 min-w-[176px] justify-start gap-2 text-sm font-medium">
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              {formatDate(parseLocal(date), 'EEE, d MMM yyyy')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="single"
              selected={parseLocal(date)}
              onSelect={(d) => { if (d) { setDate(ymd(d)); setCalOpen(false); } }}
              disabled={(d) => d > parseLocal(todayStr)}
              initialFocus
            />
          </PopoverContent>
        </Popover>
        <Button variant="outline" size="icon" className="h-9 w-9" onClick={() => { if (!isToday) setDate(shiftDay(date, 1)); }} disabled={isToday} aria-label={t('agentFloor.nextDay')}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        {!isToday && (
          <Button variant="ghost" size="sm" className="h-9" onClick={() => setDate(todayStr)}>{t('agentFloor.today')}</Button>
        )}
      </div>

      <Select value={agentFilter} onValueChange={setAgentFilter}>
        <SelectTrigger className="h-9 w-full text-sm sm:w-48">
          <SelectValue placeholder={t('agentFloor.allAgents')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('agentFloor.allAgents')}</SelectItem>
          {(agentsList || []).map((a: { user_id: string; full_name: string }) => (
            <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
        {live && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
            {t('agentFloor.live')}
          </span>
        )}
        {dataUpdatedAt > 0 && (
          <span className="tabular-nums">{t('agentFloor.updated', { time: formatDate(dataUpdatedAt, 'HH:mm:ss') })}</span>
        )}
        {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
      </div>
    </div>
  );

  return (
    <AppLayout title={t('titles.agentActivity')}>
      <div className="space-y-4">
        {dayControls}

        {isError ? (
          <div className="rounded-xl border bg-card p-10 text-center text-sm text-destructive shadow-sm">{t('agentFloor.failedLoad')}</div>
        ) : isLoading && !data ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : data && sorted.length === 0 ? (
          <div className="rounded-xl border bg-card shadow-sm">
            <EmptyState icon={<Users className="h-6 w-6" />} title={t('agentFloor.empty')} description={t('agentFloor.emptyDesc')} />
          </div>
        ) : data ? (
          <>
            {/* Team KPIs */}
            {/* one column on the narrowest phones: a KPI like "97.790 ден" must never wrap inside the number */}
            <div className={cn('grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 md:grid-cols-3', hasMoney ? 'xl:grid-cols-6' : 'xl:grid-cols-5')}>
              {live ? (
                <KpiCard
                  icon={Users} tone="bg-sky-100 text-sky-700"
                  label={t('agentFloor.kpi.online')} value={`${totals.online} / ${totals.agents}`}
                  sub={t('agentFloor.kpi.onlineSub', { onShift: totals.onShift })}
                />
              ) : (
                <KpiCard
                  icon={Users} tone="bg-sky-100 text-sky-700"
                  label={t('agentFloor.kpi.activeDay')} value={String(totals.agents)}
                  sub={t('agentFloor.kpi.onlineSub', { onShift: totals.onShift })}
                />
              )}
              {live ? (
                <KpiCard
                  icon={Headphones} tone="bg-emerald-100 text-emerald-700"
                  label={t('agentFloor.kpi.inCall')} value={String(totals.byStatus.in_call)}
                  sub={t('agentFloor.kpi.inCallSub', { brk: totals.byStatus.break, idle: totals.byStatus.idle })}
                />
              ) : (
                <KpiCard
                  icon={Clock} tone="bg-emerald-100 text-emerald-700"
                  label={t('agentFloor.online')} value={fmtDuration(totals.onlineMinutes * 60)}
                />
              )}
              <KpiCard
                icon={PhoneCall}
                label={t('agentFloor.kpi.calls')} value={String(totals.calls)}
                sub={t('agentFloor.kpi.callsSub', { answered: totals.answered, rate: Math.round(totals.answerRate * 100) })}
              />
              <KpiCard
                icon={Clock}
                label={t('agentFloor.kpi.talk')} value={fmtDuration(totals.talkSeconds)}
                sub={totals.answered ? t('agentFloor.kpi.talkSub', { avg: fmtDuration(totals.avgTalkSeconds) }) : undefined}
              />
              <KpiCard
                icon={ShoppingBag} tone="bg-indigo-100 text-indigo-700"
                label={t('agentFloor.kpi.sales')} value={String(totals.sales)}
                sub={t('agentFloor.kpi.salesSub', { worked: totals.worked, returned: totals.returned })}
              />
              {hasMoney && (
                <KpiCard
                  icon={Coins} tone="bg-amber-100 text-amber-700"
                  label={t('agentFloor.kpi.value')} value={formatDenari(totals.valueMkd)}
                  sub={data.money === 'dept' ? t('agentFloor.scopedHint') : t('agentFloor.kpi.valueSub')}
                />
              )}
            </div>

            {/* Agents */}
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold">{t('agentFloor.agents')}</h2>
                {live && (
                  <div className="flex flex-wrap gap-1.5" role="tablist">
                    {FILTERS.map((fk) => {
                      const count = fk === 'all' ? totals.agents : totals.byStatus[fk as AgentLiveStatus];
                      const active = statusFilter === fk;
                      return (
                        <button
                          key={fk}
                          type="button"
                          role="tab"
                          aria-selected={active}
                          onClick={() => setStatusFilter(fk)}
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                            active ? 'border-foreground/20 bg-foreground text-background' : 'bg-card text-muted-foreground hover:bg-muted',
                          )}
                        >
                          {fk !== 'all' && <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_STYLE[fk as AgentLiveStatus].dot)} aria-hidden />}
                          {fk === 'all' ? t('agentFloor.filterAll') : t(`agentFloor.status.${fk}`)}
                          <span className="tabular-nums opacity-70">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {shown.length === 0 ? (
                <p className="rounded-xl border bg-card p-8 text-center text-xs text-muted-foreground shadow-sm">{t('agentFloor.noMatch')}</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {shown.map((a) => (
                    <AgentFloorCard key={a.user_id} agent={a} onOpen={() => setOpenId(a.user_id)} />
                  ))}
                </div>
              )}
            </section>

            {/* Call timeline — the Insights swimlane for this day (reads ?day= too) */}
            <section className={cn('rounded-xl border bg-card p-4 shadow-sm sm:p-5', WORK_COLOR_VARS)}>
              <CallActivityTimeline from={date} to={date} team="" f={f} />
            </section>
          </>
        ) : null}
      </div>

      <AgentFloorSheet agent={openAgent} date={date} onClose={() => setOpenId(null)} />
    </AppLayout>
  );
}
