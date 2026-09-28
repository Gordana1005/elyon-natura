import { Fragment, useMemo, useState } from 'react';
import {
  ArrowDown, ArrowUp, Bell, Circle, CircleDashed, Clock, Coffee, Minus, type LucideIcon,
} from 'lucide-react';
import type { WorkPerson, WorkResponse, WorkTeam } from '@/lib/insightsApi/work';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { fmtNum, ordersHref } from '../overview/model';
import { ClockCaption } from '../shared/ClockCaption';
import { StackedBar } from '../shared/StackedBar';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { OUTCOME_TONE, PRESENCE_TONE } from './workPalette';
import { hoursText, isActive, outcomeCounts, teamLabel } from './workModel';

/** The Overview TeamsBoard's vocabulary: dot colour + a distinct shape + a word. */
const PRESENCE: Record<string, { icon: LucideIcon; tone: string; key: string }> = {
  online: { icon: Circle, tone: 'fill-emerald-500 text-emerald-500', key: 'online' },
  idle: { icon: Clock, tone: 'text-amber-600 dark:text-amber-400', key: 'idle' },
  break: { icon: Coffee, tone: 'text-sky-600 dark:text-sky-400', key: 'break' },
  offline: { icon: CircleDashed, tone: 'text-muted-foreground', key: 'offline' },
  'n/a': { icon: Minus, tone: 'text-muted-foreground', key: 'na' },
};

type SortKey = 'name' | 'worked' | 'sale' | 'conversion' | 'credited' | 'no_answer' | 'reach' | 'days' | 'online' | 'per_hour' | 'alerts';

/**
 * Teams side by side (the comparison), then every person in one sortable
 * table grouped by team. Management and people with no team are included, so
 * the numbers add up to the tiles above; the Teleshop team does not exist yet
 * and is shown as a placeholder rather than hidden.
 */
export function WorkTeams({ data, team, f, selfOnly = false }: { data: WorkResponse; team: string; f: InsightsFormat; selfOnly?: boolean }) {
  const { t } = f;
  const teams = data.teams;
  // The comparison cards: every real team (even empty) + nobody's team when someone is in it.
  const cards = teams.filter((tm) => tm.team_key !== 'unassigned' || tm.members.length > 0);
  const hasTeleshop = teams.some((tm) => /teleshop|collabbox/i.test(tm.team_key));

  return (
    <section aria-labelledby="wk-teams-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id="wk-teams-title" className="text-base font-semibold">{selfOnly ? t('insights.calls.teams.selfTitle') : t('insights.calls.teams.title')}</h3>
          <p className="text-xs text-muted-foreground">{t('insights.calls.teams.subtitle')}</p>
          <ClockCaption clock={['decided', 'call', 'sale']} />
        </div>
        <PresenceLegend f={f} />
      </div>

      {!selfOnly && (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
          {cards.map((tm) => (
            <TeamCard key={tm.team_key} team={tm} dim={!!team && team !== tm.team_key} f={f} />
          ))}
          {!hasTeleshop && (
            <li className="flex min-w-0 flex-col rounded-xl border border-dashed bg-card/50 p-4 text-sm">
              <span className="font-semibold">{t('insights.calls.team.teleshop')}</span>
              <span className="text-xs text-muted-foreground">{t('insights.calls.teams.teleshopKind')}</span>
              <p className="mt-3 text-xs leading-snug text-muted-foreground">{t('insights.calls.teams.teleshopNote')}</p>
            </li>
          )}
        </ul>
      )}

      <PeopleTable data={data} team={team} f={f} />
    </section>
  );
}

function PresenceLegend({ f }: { f: InsightsFormat }) {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
      {Object.entries(PRESENCE).map(([s, p]) => {
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

function TeamCard({ team, dim, f }: { team: WorkTeam; dim: boolean; f: InsightsFormat }) {
  const { t } = f;
  const s = team.totals;
  const online = team.members.filter((m) => m.online_state === 'online' || m.online_state === 'idle').length;
  const onBreak = team.members.filter((m) => m.online_state === 'break').length;
  const mix = outcomeCounts(s);
  const mixTotal = mix.reduce((a, x) => a + x.n, 0);
  const perPerson = s.active_people > 0 ? s.worked / s.active_people : null;
  const rows: { k: string; v: string; title?: string }[] = [
    { k: t('insights.calls.teams.m.sale'), v: f.int(s.sale) },
    { k: t('insights.calls.teams.m.conversion'), v: f.pct(s.conversion) },
    { k: t('insights.calls.teams.m.credited'), v: s.credited == null ? '—' : f.int(s.credited) },
    { k: t('insights.calls.teams.m.noAnswer'), v: f.int(s.no_answer) },
    { k: t('insights.calls.teams.m.reach'), v: f.pct(s.reach), title: t('insights.calls.kpi.hint.reach') },
    { k: t('insights.calls.teams.m.perPerson'), v: perPerson == null ? '—' : fmtNum(perPerson, f.lang, 0) },
    { k: t('insights.calls.teams.m.active'), v: s.active_min ? f.minutes(s.active_min) : '—' },
    { k: t('insights.calls.teams.m.perHour'), v: s.per_active_hour == null ? '—' : fmtNum(s.per_active_hour, f.lang, 1) },
  ];
  return (
    <li className={cn('flex min-w-0 flex-col rounded-xl border bg-card p-4 shadow-sm transition-opacity', dim && 'opacity-50')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="truncate font-semibold">{teamLabel(team, t)}</h4>
          <p className="truncate text-xs text-muted-foreground">{team.name && team.team_key !== 'unassigned' ? team.name : t('insights.calls.teams.noTeamKind')}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
            <Circle className="h-2 w-2 fill-emerald-500 text-emerald-500" aria-hidden />{t('insights.calls.teams.onlineNow', { n: f.int(online) })}
          </span>
          {onBreak > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
              <Coffee className="h-3 w-3" aria-hidden />{f.int(onBreak)}
            </span>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-2xl font-semibold">{f.int(s.worked)}</span>
        <span className="text-xs text-muted-foreground">{t('insights.calls.teams.worked')}</span>
      </div>
      <p className="text-xs text-muted-foreground">{t('insights.calls.teams.people', { active: f.int(s.active_people), n: f.int(s.people) })}</p>
      <StackedBar
        className="mt-3 h-2"
        label={t('insights.calls.daily.mixTitle')}
        segments={mix.map((m) => ({
          key: m.key, weight: m.n, tone: OUTCOME_TONE[m.key],
          text: `${t(`insights.calls.outcome.${m.key}`)} · ${f.int(m.n)} (${f.share(m.n, mixTotal)})`,
        }))}
      />
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        {rows.map((r) => (
          <div key={r.k} className="flex min-w-0 justify-between gap-2" title={r.title}>
            <dt className="truncate text-muted-foreground">{r.k}</dt>
            <dd className="font-semibold tabular-nums">{r.v}</dd>
          </div>
        ))}
      </dl>
    </li>
  );
}

// ── people ──────────────────────────────────────────────────────────────────

const sortValue = (p: WorkPerson, k: SortKey): number | string => {
  switch (k) {
    case 'name': return p.name.toLocaleLowerCase();
    case 'worked': return p.worked;
    case 'sale': return p.sale;
    case 'conversion': return p.conversion ?? -1;
    case 'credited': return p.credited ?? -1;
    case 'no_answer': return p.no_answer;
    case 'reach': return p.reach ?? -1;
    case 'days': return p.days_active;
    case 'online': return p.online_min ?? -1;
    case 'per_hour': return p.per_active_hour ?? -1;
    case 'alerts': return p.idle_alerts ?? -1;
  }
};

function PeopleTable({ data, team, f }: { data: WorkResponse; team: string; f: InsightsFormat }) {
  const { t } = f;
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' } | null>(null);
  const [showIdle, setShowIdle] = useState(false);
  const groups = useMemo(() => (team ? data.teams.filter((tm) => tm.team_key === team) : data.teams), [data, team]);
  const idleCount = groups.reduce((a, g) => a + g.members.filter((m) => !isActive(m)).length, 0);
  const sorted = (members: WorkPerson[]) => {
    const rows = showIdle ? members : members.filter(isActive);
    if (!sort) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = sortValue(a, sort.key), y = sortValue(b, sort.key);
      return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name);
    });
  };
  const toggle = (key: SortKey) =>
    setSort((s) => (s?.key === key ? (s.dir === 'desc' ? { key, dir: 'asc' } : null) : { key, dir: key === 'name' ? 'asc' : 'desc' }));
  const cols: { key: SortKey | null; label: string; left?: boolean; icon?: boolean; hint?: string }[] = [
    { key: 'name', label: t('insights.calls.people.col.person'), left: true },
    { key: 'worked', label: t('insights.calls.people.col.worked'), hint: t('insights.calls.kpi.hint.worked') },
    { key: null, label: t('insights.calls.people.col.mix') },
    { key: 'sale', label: t('insights.calls.people.col.sale'), hint: t('insights.calls.kpi.hint.sale') },
    { key: 'conversion', label: t('insights.calls.people.col.conversion') },
    { key: 'credited', label: t('insights.calls.people.col.credited'), hint: t('insights.calls.kpi.hint.credited') },
    { key: 'no_answer', label: t('insights.calls.people.col.noAnswer'), hint: t('insights.calls.kpi.hint.no_answer') },
    { key: 'reach', label: t('insights.calls.people.col.reach'), hint: t('insights.calls.kpi.hint.reach') },
    { key: 'days', label: t('insights.calls.people.col.days'), left: true },
    { key: 'online', label: t('insights.calls.people.col.online'), left: true, hint: t('insights.calls.kpi.hint.active') },
    { key: 'per_hour', label: t('insights.calls.people.col.perHour'), hint: t('insights.calls.kpi.hint.perHour') },
    { key: 'alerts', label: t('insights.calls.people.col.alerts'), icon: true },
  ];
  const range = { from: data.meta.from, to: data.meta.to };
  const any = groups.some((g) => g.members.length > 0);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{t('insights.calls.people.title')}</h4>
        {idleCount > 0 && (
          <button type="button" onClick={() => setShowIdle((v) => !v)} aria-pressed={showIdle}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {showIdle ? t('insights.calls.people.hideIdle') : t('insights.calls.people.showIdle', { n: f.int(idleCount) })}
          </button>
        )}
      </div>
      {!any ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('insights.calls.people.empty')}</p>
      ) : (
        <div className="relative overflow-x-auto rounded-xl border bg-card shadow-sm">
          <table className="w-full min-w-[1080px] text-[13px]">
            <caption className="sr-only">{t('insights.calls.people.title')}</caption>
            <thead className="text-[11px] text-muted-foreground">
              <tr>
                {cols.map((c, i) => {
                  const active = c.key && sort?.key === c.key;
                  return (
                    <th key={i} scope="col" aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : c.key ? 'none' : undefined}
                      className={cn('whitespace-nowrap px-2 py-2 font-medium', i === 0 && 'sticky left-0 z-10 bg-card pl-3', c.left ? 'text-left' : 'text-right')}>
                      {c.key ? (
                        <button type="button" title={c.hint ?? c.label} onClick={() => toggle(c.key!)}
                          className={cn('inline-flex items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active && 'text-foreground')}>
                          {c.icon ? <><Bell className="h-3.5 w-3.5" aria-hidden /><span className="sr-only">{c.label}</span></> : c.label}
                          {active && (sort!.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                        </button>
                      ) : c.label}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const rows = sorted(g.members);
                if (!rows.length) return null;
                return (
                  <Fragment key={g.team_key}>
                    {groups.length > 1 && (
                      <tr className="border-t bg-muted/40">
                        <th colSpan={cols.length} scope="colgroup" className="sticky left-0 px-3 py-1.5 text-left text-xs font-semibold">
                          {teamLabel(g, t)}
                          <span className="ml-2 font-normal text-muted-foreground">
                            {t('insights.calls.people.groupSum', { worked: f.int(g.totals.worked), sale: f.int(g.totals.sale), n: f.int(g.totals.active_people) })}
                          </span>
                        </th>
                      </tr>
                    )}
                    {rows.map((m) => <PersonRow key={m.person_id} m={m} range={range} f={f} />)}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PersonRow({ m, range, f }: { m: WorkPerson; range: { from: string; to: string }; f: InsightsFormat }) {
  const { t } = f;
  const p = PRESENCE[m.online_state] ?? PRESENCE['n/a'];
  const Icon = p.icon;
  const stateLabel = t(`overview.teams.state.${p.key}`);
  const mix = outcomeCounts(m);
  const mixTotal = mix.reduce((a, x) => a + x.n, 0);
  // The cohort's own list: this person's credited sales, sale day in the period.
  const creditedHref = (m.credited ?? 0) > 0
    ? ordersHref({ cohort_bucket: 'total', sold_by_person_id: m.person_id, sold_from: range.from, sold_to: range.to }, m.name)
    : null;
  const hours = hoursText(m);
  return (
    <tr className="border-t">
      <th scope="row" className="sticky left-0 z-10 max-w-[200px] bg-card py-1.5 pl-3 pr-2 text-left font-medium">
        <span className="flex items-center gap-1.5">
          <Icon className={cn('h-3 w-3 shrink-0', p.tone)} aria-hidden />
          <span className="truncate" title={m.name}>{m.name}</span>
          <span className="sr-only">({stateLabel})</span>
          {m.is_manager && <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground">{t('insights.calls.people.manager')}</span>}
          {!m.has_login && <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground" title={t('insights.calls.people.noLoginHint')}>{t('insights.calls.people.noLogin')}</span>}
        </span>
      </th>
      <td className="px-2 py-1.5 text-right font-semibold tabular-nums" title={t('insights.calls.people.viaTitle', { crm: f.int(m.via_crm), acpa: f.int(m.via_altercpa) })}>
        {f.int(m.worked)}
      </td>
      <td className="px-2 py-1.5">
        <StackedBar className="ml-auto h-1.5 w-20" label={m.name} segments={mix.map((x) => ({
          key: x.key, weight: x.n, tone: OUTCOME_TONE[x.key],
          text: `${t(`insights.calls.outcome.${x.key}`)} · ${f.int(x.n)} (${f.share(x.n, mixTotal)})`,
        }))} />
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">{f.int(m.sale)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{m.worked ? f.pct(m.conversion) : '—'}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        {m.credited == null ? '—' : <DrillLink href={creditedHref} title={t('insights.calls.people.creditedOpen')}>{f.int(m.credited)}</DrillLink>}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">{m.no_answer ? f.int(m.no_answer) : <span className="text-muted-foreground">0</span>}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{f.pct(m.reach)}</td>
      <td className="whitespace-nowrap px-2 py-1.5 text-xs">
        {hours ? (
          <span className="flex flex-col leading-tight">
            <span className="tabular-nums">{hours.averaged ? `~${hours.text}` : hours.text}</span>
            <span className="text-[11px] text-muted-foreground">
              {t('insights.calls.people.days', { count: m.days_active, n: f.int(m.days_active) })}
              {m.per_active_day != null && m.days_active > 1 ? ` · ${t('insights.calls.people.perDay', { n: fmtNum(m.per_active_day, f.lang, 0) })}` : ''}
            </span>
          </span>
        ) : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-2 py-1.5">
        {m.online_min ? <TimeCell m={m} f={f} /> : (
          <span className="text-xs text-muted-foreground">{m.has_login ? '—' : t('overview.teams.state.na')}</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-right tabular-nums">
        {m.per_active_hour == null ? <span className="text-muted-foreground">—</span> : fmtNum(m.per_active_hour, f.lang, 1)}
      </td>
      <td className={cn('px-2 py-1.5 pr-3 text-right tabular-nums',
        (m.idle_alerts ?? 0) > 0 ? 'font-semibold text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
        {m.idle_alerts == null ? '—' : f.int(m.idle_alerts)}
      </td>
    </tr>
  );
}

/** Online time as text + a thin active / idle / break bar (the text is the value; the bar is the shape). */
function TimeCell({ m, f }: { m: WorkPerson; f: InsightsFormat }) {
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
        <span className={cn('h-full', PRESENCE_TONE.active)} style={{ width: `${(act / total) * 100}%` }} />
        <span className={cn('h-full', PRESENCE_TONE.idle)} style={{ width: `${(idl / total) * 100}%` }} />
        <span className={cn('h-full', PRESENCE_TONE.break)} style={{ width: `${(brk / total) * 100}%` }} />
      </span>
      <span className="sr-only">{title}</span>
    </span>
  );
}
