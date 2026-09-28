import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronRight, Circle, Coffee } from 'lucide-react';
import type { PeopleMember, PeoplePerson, PeopleTeam } from '@/lib/insightsApi/agents';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { DeltaBadge } from '../overview/KpiRow';
import { delta } from '../overview/model';
import { Sparkline } from '../overview/Sparkline';
import { ClockCaption } from '../shared/ClockCaption';
import { COHORT_TONE } from '../shared/cohortPalette';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { isMainTeam, memberIsWhole, personHref, ratesOf, sortTeams, teamHref, type PartKey } from './model';
import { BucketLegend, BucketsBar, PersonBadges, PresenceIcon, SourceSplit, TimeCell, teamName } from './parts';

/**
 * Teams side by side (the Overview's TeamsBoard, on the cohort): each team
 * counts every sale, decision and minute in the team the person was in THAT
 * day, so its members add up to it. The two call teams sit side by side;
 * Teleshop / collabBox, Management and "no team" follow.
 */
export function TeamsPanel({ teams, people, range, money, onPerson, f }: {
  teams: PeopleTeam[];
  people: PeoplePerson[];
  range: DayRange;
  money: boolean;
  onPerson: (id: string) => void;
  f: InsightsFormat;
}) {
  const { t } = f;
  const ordered = useMemo(() => sortTeams(teams), [teams]);
  const byId = useMemo(() => new Map(people.map((p) => [p.person_id, p])), [people]);
  const main = ordered.filter(isMainTeam);
  const rest = ordered.filter((tm) => !isMainTeam(tm));
  return (
    <section aria-labelledby="ag-teams-title" className="space-y-3">
      <div>
        <h2 id="ag-teams-title" className="text-base font-semibold">{t('insights.agents.teams.title')}</h2>
        <p className="text-xs text-muted-foreground">{t('insights.agents.teams.subtitle')}</p>
        <ClockCaption clock={['sale', 'decided']} />
      </div>
      {ordered.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('insights.agents.teams.empty')}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
            {main.map((tm) => <TeamCard key={tm.key} team={tm} byId={byId} range={range} money={money} onPerson={onPerson} open f={f} />)}
          </div>
          <div className="grid grid-cols-1 gap-3 2xl:grid-cols-2">
            {rest.map((tm) => <TeamCard key={tm.key} team={tm} byId={byId} range={range} money={money} onPerson={onPerson} open={false} f={f} />)}
          </div>
        </>
      )}
    </section>
  );
}

function TeamCard({ team, byId, range, money, onPerson, open, f }: {
  team: PeopleTeam; byId: Map<string, PeoplePerson>; range: DayRange; money: boolean;
  onPerson: (id: string) => void; open: boolean; f: InsightsFormat;
}) {
  const { t } = f;
  const name = teamName(team.key, team.name, f);
  const r = ratesOf(team);
  const href = (k: PartKey | PartKey[], label: string) => teamHref(team, k, range, `${name} · ${label}`);
  const totalHref = teamHref(team, 'total', range, name);
  const noLink = team.kind === 'team' && !team.drill_exact ? t('insights.agents.teams.noLinkMoved') : team.kind !== 'team' ? t('insights.agents.teams.noLinkGroup') : undefined;
  const spark = (team.spark ?? []).map((p) => ({ d: p.d, v: p.sales }));
  const kindText = team.kind === 'team'
    ? t(`insights.agents.teams.mode.${team.mode ?? 'none'}`)
    : t(`insights.agents.teams.kind.${team.kind}`);
  const stat = (label: string, value: string, extra?: ReactNode) => (
    <div className="flex items-baseline gap-1">
      <dt>{label}</dt>
      <dd className="font-semibold tabular-nums text-foreground">{value}</dd>
      {extra}
    </div>
  );
  return (
    <article aria-labelledby={`ag-team-${team.key}`} className="min-w-0 rounded-xl border bg-card shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 px-4 pb-2 pt-3">
        <div className="min-w-0">
          <h3 id={`ag-team-${team.key}`} className="font-semibold">{name}</h3>
          <p className="text-xs text-muted-foreground">{kindText} · {t('insights.agents.teams.people', { n: f.int(team.people) })}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {team.online_now > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
              <Circle className="h-2.5 w-2.5 fill-emerald-500 text-emerald-500" aria-hidden />
              {t('overview.teams.onlineNow', { n: f.int(team.online_now) })}
            </span>
          )}
          {team.break_now > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
              <Coffee className="h-3 w-3" aria-hidden />{t('overview.teams.onBreak', { n: f.int(team.break_now) })}
            </span>
          )}
          {spark.length > 1 && <Sparkline points={spark} accentClass={COHORT_TONE.paid} className="w-24" />}
        </div>
      </header>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 px-4 pb-2 text-xs text-muted-foreground">
        <div className="flex items-baseline gap-1">
          <dt>{t('insights.agents.col.sales')}</dt>
          <dd className="font-semibold tabular-nums text-foreground">
            <DrillLink href={totalHref} title={totalHref ? undefined : noLink}>{f.int(team.sales)}</DrillLink>
          </dd>
          {team.prev && <DeltaBadge d={delta(team.sales, team.prev.sales, 'up')} f={f} />}
        </div>
        {stat(t('insights.agents.col.worked'), f.int(team.worked))}
        {stat(t('insights.agents.col.saleDecisions'), f.int(team.sale_decisions))}
        {stat(t('insights.agents.col.conversion'), r.conversion != null ? f.pct(r.conversion) : '—')}
        {stat(t('insights.agents.col.paidShare'), r.paidShare != null ? f.pct(r.paidShare, 0) : '—')}
        {stat(t('insights.agents.col.returnRate'), r.returnRate != null ? f.pct(r.returnRate) : '—')}
        {stat(t('insights.agents.col.packages'), f.int(team.packages))}
        {team.presence?.online_min != null && stat(t('insights.agents.col.online'), f.minutes(team.presence.online_min))}
        {money && team.value_mkd != null && stat(t('insights.agents.col.value'), f.den(team.value_mkd))}
        {money && team.paid_mkd != null && stat(t('insights.agents.col.paidValue'), f.den(team.paid_mkd))}
      </dl>
      {team.sales > 0 && (
        <div className="space-y-1.5 px-4 pb-3">
          <BucketsBar buckets={team.buckets} total={team.sales} label={t('insights.agents.teams.barLabel', { team: name })} href={href} f={f} />
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <BucketLegend buckets={team.buckets} total={team.sales} cancelled={team.outside?.cancelled_after_sale} href={href} f={f} compact />
            <span className="text-[11px] text-muted-foreground"><SourceSplit m={team} f={f} /></span>
          </div>
        </div>
      )}
      <details className="group border-t" open={open}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden />
          {t('insights.agents.teams.members', { n: f.int(team.members.length) })}
        </summary>
        <MemberTable team={team} byId={byId} range={range} money={money} onPerson={onPerson} f={f} />
      </details>
    </article>
  );
}

type MemberSort = 'name' | 'online' | 'worked' | 'conversion' | 'sales' | 'paid' | 'returned' | 'value';

function MemberTable({ team, byId, range, money, onPerson, f }: {
  team: PeopleTeam; byId: Map<string, PeoplePerson>; range: DayRange; money: boolean;
  onPerson: (id: string) => void; f: InsightsFormat;
}) {
  const { t } = f;
  const [sort, setSort] = useState<{ key: MemberSort; dir: 'asc' | 'desc' }>({ key: 'sales', dir: 'desc' });
  const rows = useMemo(() => {
    const val = (m: PeopleMember): number | string | null => {
      switch (sort.key) {
        case 'name': return (byId.get(m.person_id)?.name ?? '').toLocaleLowerCase();
        case 'online': return m.presence?.online_min ?? null;
        case 'worked': return m.worked;
        case 'conversion': return ratesOf(m).conversion;
        case 'sales': return m.sales;
        case 'paid': return m.buckets.paid;
        case 'returned': return m.buckets.returned;
        case 'value': return m.value_mkd ?? null;
      }
    };
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...team.members].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va == null && vb != null) return 1;
      if (vb == null && va != null) return -1;
      if (va != null && vb != null && va !== vb) return (typeof va === 'string' ? va.localeCompare(String(vb)) : (va as number) - (vb as number)) * dir;
      return b.sales - a.sales || b.worked - a.worked;
    });
  }, [team.members, sort, byId]);
  const cols: { key: MemberSort; label: string; left?: boolean }[] = [
    { key: 'name', label: t('insights.agents.col.person'), left: true },
    { key: 'online', label: t('insights.agents.col.online'), left: true },
    { key: 'worked', label: t('insights.agents.col.worked') },
    { key: 'conversion', label: t('insights.agents.col.conversion') },
    { key: 'sales', label: t('insights.agents.col.sales') },
    { key: 'paid', label: t('insights.agents.col.paid') },
    { key: 'returned', label: t('insights.agents.col.returned') },
    ...(money ? [{ key: 'value' as const, label: t('insights.agents.col.value') }] : []),
  ];
  const toggle = (key: MemberSort) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  if (!rows.length) return <p className="px-4 pb-3 text-sm text-muted-foreground">{t('insights.agents.teams.noMembers')}</p>;
  return (
    <div className="relative overflow-x-auto pb-1">
      <table className="w-full min-w-[560px] text-[13px]">
        <thead className="text-[11px] text-muted-foreground">
          <tr>
            {cols.map((c) => {
              const active = sort.key === c.key;
              return (
                <th key={c.key} scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={cn('whitespace-nowrap px-2 py-1.5 font-medium first:sticky first:left-0 first:z-10 first:bg-card first:pl-4', c.left ? 'text-left' : 'text-right')}>
                  <button type="button" onClick={() => toggle(c.key)}
                    className={cn('inline-flex items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active && 'text-foreground')}>
                    {c.label}
                    {active && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const p = byId.get(m.person_id);
            const whole = memberIsWhole(m, p);
            const name = p?.name ?? '—';
            const link = (k: PartKey | PartKey[], n: number, label: string) =>
              n > 0 && whole ? personHref(m.person_id, k, range, `${name} · ${label}`) : null;
            const why = whole ? undefined : t('insights.agents.teams.partOfPerson');
            const r = ratesOf(m);
            return (
              <tr key={m.person_id} className="border-t">
                <th scope="row" className="sticky left-0 z-10 max-w-[200px] bg-card py-1.5 pl-4 pr-2 text-left font-medium">
                  <span className="flex items-center gap-1.5">
                    {p && <PresenceIcon state={p.online_state} f={f} />}
                    <button type="button" onClick={() => onPerson(m.person_id)} title={t('insights.agents.people.openDrill', { name })}
                      className="truncate rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {name}
                    </button>
                  </span>
                  {p && <PersonBadges p={p} f={f} />}
                </th>
                <td className="px-2 py-1.5"><TimeCell m={m} f={f} /></td>
                <td className="px-2 py-1.5 text-right tabular-nums">{f.int(m.worked)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.conversion != null ? f.pct(r.conversion) : '—'}</td>
                <td className="px-2 py-1.5 text-right font-semibold tabular-nums">
                  <DrillLink href={link('total', m.sales, t('insights.agents.col.sales'))} title={why}>{f.int(m.sales)}</DrillLink>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  <DrillLink href={link('paid', m.buckets.paid, f.bucketLabel('paid'))} title={why}>{f.int(m.buckets.paid)}</DrillLink>
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">
                  <DrillLink href={link('returned', m.buckets.returned, f.bucketLabel('returned'))} title={why}>{f.int(m.buckets.returned)}</DrillLink>
                </td>
                {money && <td className="whitespace-nowrap px-2 py-1.5 pr-4 text-right tabular-nums">{m.value_mkd != null ? f.den(m.value_mkd) : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
