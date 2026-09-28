import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Check, Download, Search } from 'lucide-react';
import type { PeoplePerson } from '@/lib/insightsApi/agents';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { DeltaBadge } from '../overview/KpiRow';
import { delta, fmtNum } from '../overview/model';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import {
  DEFAULT_SORT, filterPeople, lastActivityOf, peopleCsv, personHref, ratesOf, sortPeople,
  type CsvCol, type PeopleFilter, type PeopleSort, type PeopleSortKey, type PartKey,
} from './model';
import { PersonBadges, PresenceIcon, SourceSplit, TimeCell, teamName } from './parts';

const chip = 'inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

interface Col {
  key: PeopleSortKey;
  label: string;
  title?: string;
  left?: boolean;
  money?: boolean;
  /** A column that is not a sort (the source split). */
  nosort?: boolean;
}

/**
 * Every person in the period, one row each — sortable, searchable, filtered by
 * team, exportable. Each count opens exactly the orders behind it
 * (/orders?cohort_bucket&sold_by_person_id&sold_from&sold_to). Owners also see
 * денари; the default order is by sales (never by money).
 */
export function PeopleTable({ people, teams, range, money, filter, onFilter, onPerson, f }: {
  people: PeoplePerson[];
  teams: { key: string; name: string | null }[];
  range: DayRange;
  money: boolean;
  filter: PeopleFilter;
  onFilter: (next: Partial<PeopleFilter>) => void;
  onPerson: (id: string) => void;
  f: InsightsFormat;
}) {
  const { t } = f;
  const [sort, setSort] = useState<PeopleSort>(DEFAULT_SORT);
  const [now] = useState(() => Date.now());
  const teamLabel = useMemo(() => {
    const names = new Map(teams.map((tm) => [tm.key, tm.name]));
    return (k: string) => teamName(k, names.get(k) ?? null, f);
  }, [teams, f]);
  const rows = useMemo(() => sortPeople(filterPeople(people, filter), sort, teamLabel), [people, filter, sort, teamLabel]);
  const hidden = people.length - filterPeople(people, { ...filter, search: '', teams: [] }).length;

  const cols: Col[] = [
    { key: 'name', label: t('insights.agents.col.person'), left: true },
    { key: 'online', label: t('insights.agents.col.online'), left: true, title: t('insights.agents.col.onlineHint') },
    { key: 'worked', label: t('insights.agents.col.worked'), title: t('insights.agents.col.workedHint') },
    { key: 'sale_decisions', label: t('insights.agents.col.saleDecisions') },
    { key: 'conversion', label: t('insights.agents.col.conversion'), title: t('insights.agents.col.conversionHint') },
    { key: 'sales', label: t('insights.agents.col.sales'), title: t('insights.agents.col.salesHint') },
    { key: 'sales', label: t('insights.agents.col.sources'), title: t('insights.agents.col.sourcesHint'), nosort: true },
    { key: 'paid', label: t('insights.agents.col.paid'), title: t('insights.agents.col.paidHint') },
    { key: 'open', label: t('insights.agents.col.open'), title: t('insights.agents.col.openHint') },
    { key: 'returned', label: t('insights.agents.col.returned') },
    { key: 'return_rate', label: t('insights.agents.col.returnRate'), title: t('insights.agents.col.returnRateHint') },
    { key: 'cancelled', label: t('insights.agents.col.cancelledAfter'), title: t('insights.agents.col.cancelledAfterHint') },
    { key: 'packages', label: t('insights.agents.col.packages'), title: t('insights.agents.col.packagesHint') },
    { key: 'per_hour', label: t('insights.agents.col.perHour'), title: t('insights.agents.col.perHourHint') },
    { key: 'value', label: t('insights.agents.col.value'), money: true, title: t('insights.agents.col.valueHint') },
    { key: 'aov', label: t('insights.agents.col.aov'), money: true },
    { key: 'paid_value', label: t('insights.agents.col.paidValue'), money: true, title: t('insights.agents.col.paidValueHint') },
    { key: 'last', label: t('insights.agents.col.last') },
  ];
  const shown = cols.filter((c) => money || !c.money);
  const toggle = (key: PeopleSortKey) =>
    setSort((s) => (s.key === key ? (s.dir === 'desc' ? { key, dir: 'asc' } : DEFAULT_SORT) : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  const exportCsv = () => {
    const pct = (v: number | null) => (v == null ? '' : Math.round(v * 1000) / 10);
    const csvCols: CsvCol[] = [
      { header: t('insights.agents.col.person'), get: (p) => p.name },
      { header: t('insights.agents.csv.team'), get: (p) => teamLabel(p.team_key) },
      { header: t('insights.agents.csv.onlineMin'), get: (p) => p.presence?.online_min ?? '' },
      { header: t('insights.agents.csv.activeMin'), get: (p) => p.presence?.active_min ?? '' },
      { header: t('insights.agents.col.worked'), get: (p) => p.worked },
      { header: t('insights.agents.col.saleDecisions'), get: (p) => p.sale_decisions },
      { header: t('insights.agents.csv.cancelDecisions'), get: (p) => p.cancel_decisions },
      { header: t('insights.agents.csv.trashDecisions'), get: (p) => p.trash_decisions },
      { header: t('insights.agents.csv.conversionPct'), get: (p) => pct(ratesOf(p).conversion) },
      { header: t('insights.agents.col.sales'), get: (p) => p.sales },
      { header: f.sourceLabel('altercpa'), get: (p) => p.by_source.altercpa },
      { header: f.sourceLabel('elyon_crm'), get: (p) => p.by_source.elyon_crm },
      { header: f.sourceLabel('teleshop_other'), get: (p) => p.by_source.teleshop_other },
      { header: f.bucketLabel('paid'), get: (p) => p.buckets.paid },
      { header: f.bucketLabel('paid_legacy'), get: (p) => p.buckets.paid_legacy },
      { header: f.bucketLabel('paid_unproven'), get: (p) => p.buckets.paid_unproven },
      { header: f.bucketLabel('courier'), get: (p) => p.buckets.courier + p.buckets.courier_problem },
      { header: f.bucketLabel('label'), get: (p) => p.buckets.label },
      { header: f.bucketLabel('to_pack'), get: (p) => p.buckets.to_pack },
      { header: f.bucketLabel('returned'), get: (p) => p.buckets.returned },
      { header: t('insights.agents.csv.returnRatePct'), get: (p) => pct(ratesOf(p).returnRate) },
      { header: f.outsideLabel('cancelled_after_sale'), get: (p) => p.outside.cancelled_after_sale },
      { header: t('insights.agents.col.packages'), get: (p) => p.packages },
      { header: t('insights.agents.csv.valueMkd'), get: (p) => p.value_mkd, money: true },
      { header: t('insights.agents.csv.paidMkd'), get: (p) => p.paid_mkd, money: true },
      { header: t('insights.agents.csv.aovMkd'), get: (p) => { const a = ratesOf(p).aov; return a == null ? '' : Math.round(a); }, money: true },
    ];
    const blob = new Blob([peopleCsv(rows, csvCols, money)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t('insights.agents.csv.file')}-${range.from}_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleTeam = (k: string) =>
    onFilter({ teams: filter.teams.includes(k) ? filter.teams.filter((x) => x !== k) : [...filter.teams, k] });

  return (
    <section aria-labelledby="ag-people-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="ag-people-title" className="text-base font-semibold">{t('insights.agents.people.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('insights.agents.people.subtitle')}</p>
          <ClockCaption clock={['sale', 'decided']} />
        </div>
        <Button variant="outline" size="sm" className="h-8 text-xs" onClick={exportCsv} disabled={rows.length === 0}>
          <Download className="mr-1 h-3.5 w-3.5" aria-hidden />{t('insights.agents.people.csv')}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card/80 px-3 py-2 shadow-sm">
        <div className="relative w-full min-w-0 sm:w-56">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input value={filter.search} onChange={(e) => onFilter({ search: e.target.value })}
            placeholder={t('insights.agents.people.search')} aria-label={t('insights.agents.people.search')} className="h-8 pl-7 text-xs" />
        </div>
        <div role="group" aria-label={t('insights.agents.people.teamsLabel')} className="flex flex-wrap items-center gap-1.5">
          {teams.map((tm) => {
            const on = filter.teams.includes(tm.key);
            return (
              <button key={tm.key} type="button" aria-pressed={on} onClick={() => toggleTeam(tm.key)}
                className={cn(chip, on ? 'border-foreground/60 bg-muted' : 'bg-card hover:bg-muted')}>
                {teamName(tm.key, tm.name, f)}{on && <Check className="h-3 w-3" aria-hidden />}
              </button>
            );
          })}
          {filter.teams.length > 0 && (
            <button type="button" onClick={() => onFilter({ teams: [] })} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
              {t('insights.agents.people.allTeams')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Switch id="ag-idle" checked={filter.showIdle} onCheckedChange={(v) => onFilter({ showIdle: v })} className="scale-75" />
          <Label htmlFor="ag-idle" className="cursor-pointer text-xs text-muted-foreground">
            {t('insights.agents.people.showIdle')}{hidden > 0 && !filter.showIdle ? ` (${f.int(hidden)})` : ''}
          </Label>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{t('insights.agents.people.empty')}</p>
      ) : (
        <div className="relative max-h-[70vh] overflow-auto rounded-xl border bg-card shadow-sm">
          <table className="w-full min-w-[1100px] text-[13px]">
            <caption className="sr-only">{t('insights.agents.people.title')}</caption>
            <thead className="sticky top-0 z-20 bg-card text-[11px] text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
              <tr>
                {shown.map((c, i) => {
                  const active = sort.key === c.key && !c.nosort;
                  return (
                    <th key={`${c.key}-${i}`} scope="col" aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className={cn('whitespace-nowrap px-2 py-2 font-medium', i === 0 && 'sticky left-0 z-30 bg-card pl-3', c.left ? 'text-left' : 'text-right')}>
                      {c.nosort ? <span title={c.title}>{c.label}</span> : (
                        <button type="button" title={c.title} onClick={() => toggle(c.key)}
                          className={cn('inline-flex items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', active && 'text-foreground')}>
                          {c.label}
                          {active && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                        </button>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const r = ratesOf(p);
                const link = (k: PartKey | PartKey[], n: number, label: string) =>
                  n > 0 ? personHref(p.person_id, k, range, `${p.name} · ${label}`) : null;
                const last = lastActivityOf(p);
                return (
                  <tr key={p.person_id} className="border-t hover:bg-muted/30">
                    <th scope="row" className="sticky left-0 z-10 max-w-[220px] bg-card py-1.5 pl-3 pr-2 text-left font-medium">
                      <span className="flex items-center gap-1.5">
                        <PresenceIcon state={p.online_state} f={f} />
                        <button type="button" onClick={() => onPerson(p.person_id)} title={t('insights.agents.people.openDrill', { name: p.name })}
                          className="truncate rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {p.name}
                        </button>
                      </span>
                      <span className="flex flex-wrap items-center gap-1">
                        <span className="text-[10px] font-normal text-muted-foreground">{teamLabel(p.team_key)}</span>
                        <PersonBadges p={p} f={f} />
                      </span>
                    </th>
                    <td className="px-2 py-1.5"><TimeCell m={p} f={f} /></td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{f.int(p.worked)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{f.int(p.sale_decisions)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.conversion != null ? f.pct(r.conversion) : '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      <span className="inline-flex items-baseline gap-1">
                        <DrillLink href={link('total', p.sales, t('insights.agents.col.sales'))} className="font-semibold">{f.int(p.sales)}</DrillLink>
                        {p.prev && <DeltaBadge d={delta(p.sales, p.prev.sales, 'up')} f={f} />}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 text-right text-[11px]"><SourceSplit m={p} f={f} /></td>
                    <td className={cn('px-2 py-1.5 text-right tabular-nums', STATUS_TEXT.good)}>
                      <DrillLink href={link('paid', p.buckets.paid, f.bucketLabel('paid'))}>{f.int(p.buckets.paid)}</DrillLink>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      <DrillLink href={link(['courier', 'courier_problem', 'label', 'to_pack'], r.open, t('insights.agents.col.open'))}>{f.int(r.open)}</DrillLink>
                    </td>
                    <td className={cn('px-2 py-1.5 text-right tabular-nums', STATUS_TEXT.returned)}>
                      <DrillLink href={link('returned', p.buckets.returned, f.bucketLabel('returned'))}>{f.int(p.buckets.returned)}</DrillLink>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.returnRate != null ? f.pct(r.returnRate) : '—'}</td>
                    <td className={cn('px-2 py-1.5 text-right tabular-nums', p.outside.cancelled_after_sale > 0 && STATUS_TEXT.critical)}>
                      <DrillLink href={link('cancelled_after_sale', p.outside.cancelled_after_sale, f.outsideLabel('cancelled_after_sale'))}>
                        {f.int(p.outside.cancelled_after_sale)}
                      </DrillLink>
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{f.int(p.packages)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {r.salesPerActiveHour != null ? f.t('insights.agents.boards.perHourValue', { n: fmtNum(r.salesPerActiveHour, f.lang, 1) }) : '—'}
                    </td>
                    {money && <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{p.value_mkd != null ? f.den(p.value_mkd) : '—'}</td>}
                    {money && <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{r.aov != null ? f.den(r.aov) : '—'}</td>}
                    {money && <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{p.paid_mkd != null ? f.den(p.paid_mkd) : '—'}</td>}
                    <td className="whitespace-nowrap px-2 py-1.5 pr-3 text-right text-xs text-muted-foreground" title={last ?? undefined}>
                      {last ? f.ago(last, now) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
