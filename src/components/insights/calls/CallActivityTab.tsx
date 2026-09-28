import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock3, Info, PhoneOff, Users } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiGetInsightsWork } from '@/lib/insightsApi/work';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { skopjeHm } from '@/lib/presence/state';
import { LoadError } from '../shared/LoadError';
import { useInsightsPeriod } from '../shared/useInsightsPeriod';
import { useInsightsFormat } from '../shared/useInsightsFormat';
import { formatDmy } from '../shared/period';
import { WORK_COLOR_VARS } from './workPalette';
import { TEAM_PARAM, presenceGap, teamLabel } from './workModel';
import { WorkKpis } from './WorkKpis';
import { WorkDaily } from './WorkDaily';
import { WorkTeams } from './WorkTeams';
import { HourHeatGrid } from './HourHeatGrid';
import { WorkQueues } from './WorkQueues';
import CallActivityTimeline from './CallActivityTimeline';

const chip = 'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const chipOn = 'border-foreground/80 bg-foreground text-background';
const chipOff = 'bg-card text-foreground hover:bg-muted';

/**
 * Insights → Активност на повици — who worked, how much, how well.
 *
 * One period (the page's InsightsFilterBar), one payload (GET /insights/work):
 * decisions from the work ledger (CRM + the AlterCPA panel), agent-reported
 * call logs, presence minutes (from 28.09.2026), breaks, cohort-credited
 * sales, the call-again queues and the data-quality rail. The swimlane below
 * reads one day of the same period (GET /insights/work/day).
 * No money on this tab: counts, time and rates for everyone who may open it.
 */
export default function CallActivityTab() {
  const f = useInsightsFormat();
  const { t } = f;
  const { user } = useAuth();
  const period = useInsightsPeriod();
  const [sp, setSp] = useSearchParams();
  const team = sp.get(TEAM_PARAM) ?? '';
  const setTeam = useCallback((k: string) => setSp((prev) => {
    const n = new URLSearchParams(prev);
    if (k) n.set(TEAM_PARAM, k); else n.delete(TEAM_PARAM);
    return n;
  }, { replace: true }), [setSp]);

  const q = useQuery({
    queryKey: ['insights-work', user?.id, period.from, period.to, period.compare],
    queryFn: ({ signal }) => apiGetInsightsWork({ from: period.from, to: period.to, compare: period.compare }, signal),
    staleTime: 2 * 60_000,
    placeholderData: keepPreviousData,
    retry: 0,
  });
  const data = q.data;

  // Chips: the teams that exist in this payload (an unknown ?wteam falls back to all).
  const teamChips = useMemo(() => (data?.teams ?? []).map((tm) => ({ key: tm.team_key, label: teamLabel(tm, t) })), [data, t]);
  const activeTeam = teamChips.some((c) => c.key === team) ? team : '';

  const errorText = (err: unknown) =>
    err instanceof Error && /^HTTP 404$|not found/i.test(err.message) ? t('insights.calls.notDeployed') : apiErrorText(err);

  return (
    <div className={cn('space-y-5', WORK_COLOR_VARS)}>
      <header className="space-y-1">
        <h2 className="text-base font-semibold">{t('insights.calls.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('insights.calls.subtitle')}</p>
      </header>

      {!data ? (
        q.isError ? (
          <LoadError text={errorText(q.error)} onRetry={() => { void q.refetch(); }} />
        ) : (
          <WorkSkeleton />
        )
      ) : (
        // A refetch keeps the frame: the previous numbers stay, dimmed.
        <div aria-busy={q.isFetching} className={cn('space-y-8 transition-opacity duration-200', q.isPlaceholderData && 'opacity-60')}>
          {q.isError && (
            <p role="alert" className="flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              {t('insights.calls.staleError')} {errorText(q.error)}
              <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={() => { void q.refetch(); }}>{t('common.retry')}</Button>
            </p>
          )}

          <Caveats
            voip={data.meta.voip}
            presenceSince={data.meta.presence_since}
            showPresence={presenceGap(data.meta.from, data.meta.presence_since)}
            altercpa={data.totals.via_altercpa > 0}
            asOf={skopjeHm(data.meta.generated_at)}
            f={f}
          />

          {!data.meta.self && teamChips.length > 1 && (
            <div role="group" aria-label={t('insights.calls.filter.team')} className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('insights.calls.filter.team')}</span>
              <button type="button" aria-pressed={!activeTeam} onClick={() => setTeam('')} className={cn(chip, !activeTeam ? chipOn : chipOff)}>
                {t('insights.calls.filter.all')}
              </button>
              {teamChips.map((c) => (
                <button key={c.key} type="button" aria-pressed={activeTeam === c.key} onClick={() => setTeam(c.key)}
                  className={cn(chip, activeTeam === c.key ? chipOn : chipOff)}>
                  {c.label}
                </button>
              ))}
            </div>
          )}

          <WorkKpis data={data} team={activeTeam} f={f} />
          <WorkDaily data={data} team={activeTeam} f={f} />
          {!data.meta.self && <WorkTeams data={data} team={activeTeam} f={f} />}
          {data.meta.self && <WorkTeams data={data} team="" f={f} selfOnly />}
          <HourHeatGrid data={data} team={activeTeam} f={f} />
          <CallActivityTimeline from={data.meta.from} to={data.meta.to} team={activeTeam} f={f} />
          <WorkQueues data={data} f={f} />
        </div>
      )}
    </div>
  );
}

function Caveats({ voip, presenceSince, showPresence, altercpa, asOf, f }: {
  voip: boolean; presenceSince: string | null; showPresence: boolean; altercpa: boolean; asOf: string; f: ReturnType<typeof useInsightsFormat>;
}) {
  const { t } = f;
  const items: { icon: typeof Info; text: string }[] = [];
  if (!voip) items.push({ icon: PhoneOff, text: t('insights.calls.caveat.voip') });
  if (showPresence) {
    items.push({
      icon: Clock3,
      text: presenceSince
        ? t('insights.calls.caveat.presence', { date: formatDmy(presenceSince) })
        : t('insights.calls.caveat.presenceNone'),
    });
  }
  if (altercpa) items.push({ icon: Users, text: t('insights.calls.caveat.altercpa') });
  return (
    <section aria-label={t('insights.calls.caveat.title')} className="rounded-xl border border-sky-200 bg-sky-50/60 p-3 dark:border-sky-900 dark:bg-sky-950/30">
      <ul className="space-y-1.5">
        {items.map((it, i) => {
          const Icon = it.icon;
          return (
            <li key={i} className="flex items-start gap-2 text-xs leading-snug text-sky-950 dark:text-sky-100">
              <Icon className="mt-px h-3.5 w-3.5 shrink-0 text-sky-700 dark:text-sky-300" aria-hidden />
              <span>{it.text}</span>
            </li>
          );
        })}
      </ul>
      {asOf && <p className="mt-2 text-[11px] tabular-nums text-sky-900/70 dark:text-sky-200/70">{t('insights.calls.asOf', { time: asOf })}</p>}
    </section>
  );
}

function WorkSkeleton() {
  return (
    <div className="space-y-5" aria-hidden>
      <Skeleton variant="card" className="h-16" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} variant="card" className="h-28" />)}
      </div>
      <Skeleton variant="card" className="h-64" />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Skeleton variant="card" className="h-56" />
        <Skeleton variant="card" className="h-56" />
      </div>
      <Skeleton variant="card" className="h-72" />
    </div>
  );
}
