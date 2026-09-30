import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiGetLeaderboardAdmin } from '@/lib/api';
import type { PeopleResponse, PeopleTeam, PresenceState } from '@/lib/insightsApi/agents';
import { apiErrorText } from '@/i18n/apiErrors';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { TeamsPanel } from '../agents/TeamsPanel';
import { PRESENCE } from '../agents/parts';
import { isMainTeam } from '../agents/model';
import { LoadError } from '../shared/LoadError';
import { switchTabParams, type DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';

/** What the board needs of the Agents query (GET /insights/agents). */
export interface AgentsQueryState {
  data?: PeopleResponse;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
}

/**
 * Teams on the Overview (29.09.2026) = the Agents tab's teams: the same GET
 * /insights/agents query (one cache entry — OverviewTab asks with the tab's own
 * key) drawn by the same TeamsPanel, so every number here IS the Agents tab's
 * number for the period — the cohort's credited sales on the sale day, collabBox
 * bookings included, value = parcel COD else price × 61,5 in денари, a sale
 * cancelled after it was made out of the total, teleshop / social sellers in
 * their own groups. Money only when the payload has it (meta.money: owners).
 * The Overview adds its live presence legend, the idle-alert column, the TV
 * boards and a link to the whole tab. The old board (insights_overview.teams:
 * created-day CRM confirms at price × 61,5) is no longer drawn.
 */
export function TeamsBoard({ q, teamKeys, range, canTvLink, f }: {
  q: AgentsQueryState;
  /** The Overview's team chips (empty = every team). */
  teamKeys: string[];
  range: DayRange;
  canTvLink: boolean;
  f: InsightsFormat;
}) {
  const { t } = f;
  const navigate = useNavigate();
  const [sp] = useSearchParams();
  const data = q.data;
  const money = data?.meta.money === true;
  const teams = useMemo(
    () => (data?.teams ?? []).filter((tm) => !teamKeys.length || teamKeys.includes(tm.key)),
    [data, teamKeys],
  );

  // The Agents tab on the same period (the team chips ride along as its team filter).
  const agentsHref = (personId?: string) => {
    const next = switchTabParams(sp, 'agents');
    if (teamKeys.length) next.set('ag_team', teamKeys.join(','));
    if (personId) next.set('ag_person', personId);
    return `/insights?${next.toString()}`;
  };

  // The TV board needs its access token; admins/managers can read it from the
  // leaderboard config (same cache key as Settings → Leaderboard).
  const lb = useQuery({
    queryKey: ['lb-admin', 'prediction'],
    queryFn: () => apiGetLeaderboardAdmin('prediction'),
    enabled: canTvLink && teams.some(isMainTeam),
    staleTime: 10 * 60_000,
    retry: 0,
  });
  const token = lb.data?.tokens?.find((tok) => tok.is_active)?.token ?? null;
  const tvHref = (tm: PeopleTeam): string | null | undefined => {
    if (!canTvLink || !isMainTeam(tm)) return undefined;
    // the team's own board (teams = business lines, 30.09.2026: ?team=<key>; a legacy key is an alias)
    return token ? `/tv/leaderboard?key=${encodeURIComponent(token)}&team=${encodeURIComponent(tm.key)}&lang=${f.lang}` : null;
  };

  const aside = (
    <div className="flex flex-col items-end gap-1.5">
      <Link to={agentsHref()}
        className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t('overview.teams.openAgents')}<ArrowRight className="h-3 w-3" aria-hidden />
      </Link>
      <PresenceLegend f={f} />
    </div>
  );

  if (!data) {
    return (
      <section aria-labelledby="ov-teams-title" className="space-y-3">
        <h2 id="ov-teams-title" className="text-base font-semibold">{t('insights.agents.teams.title')}</h2>
        {q.isError ? (
          <LoadError text={apiErrorText(q.error)} onRetry={() => { void q.refetch(); }} />
        ) : (
          <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2" aria-hidden>
            <Skeleton variant="card" className="h-56" />
            <Skeleton variant="card" className="h-56" />
          </div>
        )}
      </section>
    );
  }
  return (
    <TeamsPanel
      teams={teams} people={data.people} range={range} money={money}
      onPerson={(id) => navigate(agentsHref(id))}
      aside={aside} tvHref={tvHref} alerts f={f}
    />
  );
}

/** Same vocabulary as the owners' "Who is working" panel — dot colour + a distinct shape + a word. */
function PresenceLegend({ f }: { f: InsightsFormat }) {
  return (
    <ul className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {(Object.keys(PRESENCE) as PresenceState[]).map((s) => {
        const p = PRESENCE[s];
        const Icon = p.icon;
        return (
          <li key={s} className="inline-flex items-center gap-1">
            <Icon className={cn('h-3 w-3', p.tone)} aria-hidden />{f.t(`overview.teams.state.${p.key}`)}
          </li>
        );
      })}
    </ul>
  );
}
