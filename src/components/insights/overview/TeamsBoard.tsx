import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, Bell, ChevronRight, Circle, CircleDashed, Clock, Coffee, ExternalLink, Minus, type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { apiGetLeaderboardAdmin, type OverviewTeam, type OverviewTeamMember, type OverviewPresenceState } from '@/lib/api';
import { cn } from '@/lib/utils';
import { DrillLink } from './DrillLink';
import { ordersHref, sortMembers, type DayRange, type MemberSortKey } from './model';
import type { OverviewFormat } from './useOverviewFormat';

/** Same vocabulary as the owners' "Who is working" panel — dot colour + a distinct shape + a word. */
const PRESENCE: Record<OverviewPresenceState, { icon: LucideIcon; tone: string; key: string }> = {
  online: { icon: Circle, tone: 'fill-emerald-500 text-emerald-500', key: 'online' },
  idle: { icon: Clock, tone: 'text-amber-600 dark:text-amber-400', key: 'idle' },
  break: { icon: Coffee, tone: 'text-sky-600 dark:text-sky-400', key: 'break' },
  offline: { icon: CircleDashed, tone: 'text-muted-foreground', key: 'offline' },
  'n/a': { icon: Minus, tone: 'text-muted-foreground', key: 'na' },
};

const BOARD_MODES = new Set(['pending', 'prediction']);
const TEAM_ORDER = (tm: OverviewTeam) =>
  tm.mode === 'pending' ? 0 : tm.mode === 'prediction' ? 1 : tm.team_key === 'unassigned' ? 9 : 5;
/** Label key for a team's kind: its board mode, else its key (management, unassigned). */
const kindKey = (tm: OverviewTeam) => tm.mode ?? tm.team_key;

/** Teams side by side: who is online, how long, what they worked and sold. */
export function TeamsBoard({
  teams, range, money, canTvLink, f,
}: { teams: OverviewTeam[]; range: DayRange; money: boolean; canTvLink: boolean; f: OverviewFormat }) {
  const { t } = f;
  const ordered = useMemo(() => [...teams].sort((a, b) => TEAM_ORDER(a) - TEAM_ORDER(b)), [teams]);
  // Side by side: the two call teams. Management / unassigned sit collapsed below.
  const main = ordered.filter((tm) => BOARD_MODES.has(tm.mode ?? ''));
  const rest = ordered.filter((tm) => !BOARD_MODES.has(tm.mode ?? ''));

  // The TV board needs its access token; admins/managers can read it from the
  // leaderboard config (same cache key as Settings → Leaderboard).
  const lb = useQuery({
    queryKey: ['lb-admin', 'prediction'],
    queryFn: () => apiGetLeaderboardAdmin('prediction'),
    enabled: canTvLink && main.length > 0,
    staleTime: 10 * 60_000,
    retry: 0,
  });
  const token = lb.data?.tokens?.find((tok) => tok.is_active)?.token ?? null;
  const tvHref = (mode: string) =>
    token ? `/tv/leaderboard?key=${encodeURIComponent(token)}&mode=${mode === 'pending' ? 'pending' : 'prediction'}&lang=${f.lang}` : null;

  return (
    <section aria-labelledby="ov-teams-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="ov-teams-title" className="text-base font-semibold">{t('overview.teams.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('overview.teams.subtitle')}</p>
        </div>
        <PresenceLegend f={f} />
      </div>
      {ordered.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('overview.teams.empty')}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 min-[1600px]:grid-cols-2">
            {main.map((tm) => (
              <TeamCard key={tm.team_key} team={tm} range={range} money={money} tv={canTvLink ? tvHref(tm.mode ?? '') : null} canTvLink={canTvLink} f={f} />
            ))}
          </div>
          {rest.map((tm) => (
            <details key={tm.team_key} className="group rounded-xl border bg-card shadow-sm">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" aria-hidden />
                {tm.name}
                <span className="text-xs font-normal text-muted-foreground">
                  {t('overview.teams.peopleOnline', { n: f.int(tm.members.length), online: f.int(tm.online_now) })}
                  {tm.team_key === 'unassigned' && ` · ${t('overview.teams.mode.unassigned')}`}
                </span>
              </summary>
              <div className="border-t px-1 pb-2">
                <MemberTable members={tm.members} range={range} money={money} f={f} />
              </div>
            </details>
          ))}
        </>
      )}
    </section>
  );
}

function PresenceLegend({ f }: { f: OverviewFormat }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {(Object.keys(PRESENCE) as OverviewPresenceState[]).map((s) => {
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

function TeamCard({ team, range, money, tv, canTvLink, f }: {
  team: OverviewTeam; range: DayRange; money: boolean; tv: string | null; canTvLink: boolean; f: OverviewFormat;
}) {
  const { t } = f;
  // The server's team totals when present (they also count work nobody on the
  // roster did that day); otherwise the members' sum.
  const summed = team.members.reduce(
    (a, m) => ({
      worked: a.worked + (m.worked || 0), confirmed: a.confirmed + (m.confirmed || 0),
      sold: a.sold + (m.sold_value_eur ?? 0), cash: a.cash + (m.delivered_cash_mkd ?? 0),
    }),
    { worked: 0, confirmed: 0, sold: 0, cash: 0 },
  );
  const tot = {
    worked: team.worked ?? summed.worked,
    confirmed: team.confirmed ?? summed.confirmed,
    sold: team.sold_value_eur ?? summed.sold,
    cash: team.delivered_cash_mkd ?? summed.cash,
  };
  return (
    <article aria-labelledby={`ov-team-${team.team_key}`} className="min-w-0 rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <h3 id={`ov-team-${team.team_key}`} className="font-semibold">{team.name}</h3>
          <p className="text-xs text-muted-foreground">{t(`overview.teams.mode.${kindKey(team)}`, { defaultValue: kindKey(team) })}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
            <Circle className="h-2.5 w-2.5 fill-emerald-500 text-emerald-500" aria-hidden />
            {t('overview.teams.onlineNow', { n: f.int(team.online_now) })}
          </span>
          {(team.break_now ?? 0) > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
              <Coffee className="h-3 w-3" aria-hidden />{t('overview.teams.onBreak', { n: f.int(team.break_now) })}
            </span>
          )}
          {canTvLink && (tv ? (
            <a href={tv} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {t('overview.teams.tvBoard')}<ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          ) : (
            <Link to="/settings" title={t('overview.teams.tvNoLink')}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {t('overview.teams.tvBoard')}
            </Link>
          ))}
        </div>
      </header>
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 px-4 pb-2 text-xs text-muted-foreground">
        <div className="flex gap-1"><dt>{t('overview.teams.col.worked')}</dt><dd className="font-semibold tabular-nums text-foreground">{f.int(tot.worked)}</dd></div>
        <div className="flex gap-1"><dt>{t('overview.teams.col.confirmed')}</dt><dd className="font-semibold tabular-nums text-foreground">{f.int(tot.confirmed)}</dd></div>
        <div className="flex gap-1"><dt>{t('overview.teams.col.conversion')}</dt><dd className="font-semibold tabular-nums text-foreground">{tot.worked ? f.pct(tot.confirmed / tot.worked) : '—'}</dd></div>
        {money && <div className="flex gap-1"><dt>{t('overview.teams.col.sold')}</dt><dd className="font-semibold tabular-nums text-foreground">{f.eur(tot.sold)}</dd></div>}
        {money && <div className="flex gap-1"><dt>{t('overview.teams.col.cash')}</dt><dd className="font-semibold tabular-nums text-foreground">{f.den(tot.cash)}</dd></div>}
      </dl>
      <div className="border-t">
        <MemberTable members={team.members} range={range} money={money} f={f} />
      </div>
    </article>
  );
}

function MemberTable({ members, range, money, f }: { members: OverviewTeamMember[]; range: DayRange; money: boolean; f: OverviewFormat }) {
  const { t } = f;
  const [sort, setSort] = useState<{ key: MemberSortKey; dir: 'asc' | 'desc' } | null>(null);
  const rows = useMemo(() => sortMembers(members, sort, money), [members, sort, money]);
  const [now] = useState(() => Date.now());
  const cols: { key: MemberSortKey; label: string; align?: 'left'; icon?: boolean }[] = [
    { key: 'name', label: t('overview.teams.col.person'), align: 'left' },
    { key: 'online', label: t('overview.teams.col.time'), align: 'left' },
    { key: 'worked', label: t('overview.teams.col.worked') },
    { key: 'confirmed', label: t('overview.teams.col.confirmed') },
    { key: 'conversion', label: t('overview.teams.col.conversion') },
    ...(money ? [
      { key: 'sold' as const, label: t('overview.teams.col.sold') },
      { key: 'cash' as const, label: t('overview.teams.col.cash') },
    ] : []),
    // A bell, not the word: keeps two teams side by side on a normal wide screen.
    { key: 'alerts', label: t('overview.teams.col.alerts'), icon: true },
  ];
  const toggle = (key: MemberSortKey) =>
    setSort((s) => (s?.key === key ? (s.dir === 'desc' ? { key, dir: 'asc' } : null) : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  if (members.length === 0) return <p className="px-4 py-4 text-sm text-muted-foreground">{t('overview.teams.empty')}</p>;
  return (
    <div className="relative overflow-x-auto">
      <table className="w-full min-w-[560px] text-[13px]">
        <thead className="text-[11px] text-muted-foreground">
          <tr>
            {cols.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th key={c.key} scope="col" aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={cn('whitespace-nowrap px-2 py-2 font-medium first:sticky first:left-0 first:z-10 first:bg-card first:pl-3', c.align === 'left' ? 'text-left' : 'text-right')}>
                  <button type="button" title={c.label} onClick={() => toggle(c.key)}
                    className={cn('inline-flex items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active && 'text-foreground')}>
                    {c.icon ? <><Bell className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">{c.label}</span></> : c.label}
                    {active && (sort!.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const p = PRESENCE[m.online_state] ?? PRESENCE['n/a'];
            const Icon = p.icon;
            const stateLabel = t(`overview.teams.state.${p.key}`);
            // null minutes = no presence data (it starts 28.09.2026): "—", never 0.
            const tracked = m.online_state !== 'n/a' && (m.online_min ?? 0) > 0;
            const soldHref = m.confirmed > 0
              ? ordersHref({ sold_by_person_id: m.person_id, sold_from: range.from, sold_to: range.to }, m.name)
              : null;
            return (
              <tr key={m.person_id} className="border-t">
                <th scope="row" className="sticky left-0 z-10 max-w-[180px] bg-card py-1.5 pl-3 pr-2 text-left font-medium">
                  <span className="flex items-center gap-1.5">
                    <Icon className={cn('h-3 w-3 shrink-0', p.tone)} aria-hidden />
                    <span className="truncate" title={m.name}>{m.name}</span>
                    <span className="sr-only">({stateLabel})</span>
                  </span>
                </th>
                <td className="px-2 py-1.5">
                  {tracked ? (
                    <TimeCell m={m} f={f} />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {m.online_state === 'n/a'
                        ? (m.last_decision_at ? t('overview.teams.lastDecision', { ago: f.ago(m.last_decision_at, now) }) : stateLabel)
                        : '—'}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{f.int(m.worked)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  <DrillLink href={soldHref}>{f.int(m.confirmed)}</DrillLink>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{m.worked && m.conversion != null ? f.pct(m.conversion) : '—'}</td>
                {money && <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{m.sold_value_eur != null ? f.eur(m.sold_value_eur) : '—'}</td>}
                {money && <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{m.delivered_cash_mkd != null ? f.den(m.delivered_cash_mkd) : '—'}</td>}
                <td className={cn('px-2 py-1.5 pr-3 text-right tabular-nums',
                  (m.idle_alerts ?? 0) > 0 ? 'font-semibold text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
                  {m.idle_alerts == null ? '—' : m.idle_alerts > 0 ? f.int(m.idle_alerts) : '0'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Online time as text + a thin active / idle / break bar (the text is the value; the bar is the shape). */
function TimeCell({ m, f }: { m: OverviewTeamMember; f: OverviewFormat }) {
  const { t } = f;
  const act = m.active_min ?? 0, idl = m.idle_min ?? 0, brk = m.break_min ?? 0;
  const total = Math.max(1, act + idl + brk);
  const title = t('overview.teams.timeTitle', {
    online: f.minutes(m.online_min), active: f.minutes(m.active_min), idle: f.minutes(m.idle_min), brk: f.minutes(m.break_min),
  });
  return (
    <span className="flex min-w-[96px] flex-col gap-1" title={title}>
      <span className="text-xs tabular-nums">{f.minutes(m.online_min)}</span>
      <span className="flex h-1.5 w-full max-w-[96px] gap-px overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className="h-full bg-emerald-500" style={{ width: `${(act / total) * 100}%` }} />
        <span className="h-full bg-amber-400" style={{ width: `${(idl / total) * 100}%` }} />
        <span className="h-full bg-sky-500" style={{ width: `${(brk / total) * 100}%` }} />
      </span>
      <span className="sr-only">{title}</span>
    </span>
  );
}
