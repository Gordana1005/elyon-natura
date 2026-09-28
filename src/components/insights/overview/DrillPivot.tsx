import { Fragment, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Loader2 } from 'lucide-react';
import type {
  OrdersDrillParams, OverviewPivotDim, OverviewPivotResponse, OverviewPivotRow, OverviewSource, OverviewTeam,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { DrillLink } from './DrillLink';
import { ClockCaption } from '../shared/ClockCaption';
import { sourceColorVar } from './palette';
import { groupPivotRows, ordersHref, PIVOT_LEAF_PARAM, PIVOT_NONE, placedOf, sourceDrill, type DayRange } from './model';
import type { OverviewFormat } from './useOverviewFormat';

export type PivotFetcher = (by: OverviewPivotDim[], signal?: AbortSignal) => Promise<OverviewPivotResponse>;

const LEAVES: OverviewPivotDim[] = ['product', 'list', 'webmaster', 'stream', 'city', 'detail'];
const L2: OverviewPivotDim[] = ['source', 'team'];
const L3: OverviewPivotDim[] = ['source', 'team', 'person'];
const SEP = '\u0002';

type LevelState = OverviewPivotRow[] | 'loading' | 'error' | 'owners';

/** Σ of the splits' sold value (the cohort's sales), when the server sends it. */
const soldValueOf = (src: OverviewSource): number | null => {
  const v = src.splits.map((sp) => sp.sold_value_eur).filter((x): x is number => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};
const isNone = (v: unknown) => v == null || PIVOT_NONE.has(String(v));

/**
 * Source → team → person → one detail dimension (insights_pivot). Level 1 comes
 * from the overview itself; each deeper level is fetched the first time any row
 * at that depth is opened — one request per level and range, shared by every
 * row. It is also the page's full-detail table, so every row is a real <tr>.
 * The server reports teams, people and leaves by NAME ('(none)' for none).
 */
export function DrillPivot({
  sources, teamsFilter, range, money, fetchPivot, queryKeyBase, teams, f,
}: {
  sources: OverviewSource[];
  /** team_key values to keep (empty = all). */
  teamsFilter: string[];
  range: DayRange;
  money: boolean;
  fetchPivot: PivotFetcher;
  queryKeyBase: unknown[];
  teams: OverviewTeam[];
  f: OverviewFormat;
}) {
  const { t } = f;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [leaf, setLeaf] = useState<OverviewPivotDim>('product');
  const depthOpen = (d: number) => [...open].some((k) => k.split(SEP).length === d);

  // The pivot names teams; the page filters and drills by team_key.
  const keyByName = useMemo(() => new Map(teams.map((tm) => [tm.name, tm.team_key])), [teams]);
  const keptNames = useMemo(
    () => (teamsFilter.length ? new Set(teams.filter((tm) => teamsFilter.includes(tm.team_key)).map((tm) => tm.name)) : null),
    [teams, teamsFilter],
  );

  const opts = (by: OverviewPivotDim[], enabled: boolean) => ({
    queryKey: [...queryKeyBase, 'pivot', by.join(',')],
    queryFn: ({ signal }: { signal?: AbortSignal }) => fetchPivot(by, signal),
    enabled,
    staleTime: 5 * 60_000,
    retry: 0,
  });
  const q2 = useQuery(opts(L2, depthOpen(1)));
  const q3 = useQuery(opts(L3, depthOpen(2)));
  const q4 = useQuery(opts([...L3, leaf], depthOpen(3)));

  const toggle = (key: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(key)) { for (const k of [...n]) if (k === key || k.startsWith(`${key}${SEP}`)) n.delete(k); } else n.add(key);
    return n;
  });

  const level = (
    q: { data?: OverviewPivotResponse; isError: boolean; error: unknown },
    dims: OverviewPivotDim[],
    match: (r: OverviewPivotRow) => boolean,
  ): LevelState => {
    if (q.isError) return q.error instanceof Error && q.error.message === 'owners_only' ? 'owners' : 'error';
    if (!q.data) return 'loading';
    const rows = groupPivotRows(q.data.rows, dims).filter((r) => match(r) && (!keptNames || keptNames.has(String(r.team))));
    return rows.sort((a, b) => (money ? (b.value_eur ?? 0) - (a.value_eur ?? 0) : 0) || b.count - a.count);
  };

  const label = (r: OverviewPivotRow, d: OverviewPivotDim): string => {
    const v = r[d];
    if (isNone(v)) return d === 'team' ? t('overview.pivot.noTeam') : d === 'person' ? t('overview.pivot.noPerson') : t('overview.pivot.none');
    if (d === 'source') return f.source(String(v));
    return String(v);
  };

  const drillFor = (src: OverviewSource, extra: Partial<OrdersDrillParams>, lbl?: string) =>
    ordersHref(sourceDrill(src, range, extra), lbl);

  const cells = (
    r: { count: number; sold?: number | null; value_eur?: number | null; delivered_cash_mkd?: number | null },
    href: string | null,
  ) => (
    <>
      <td className="px-3 py-1.5 text-right tabular-nums"><DrillLink href={r.count > 0 ? href : null}>{f.int(r.count)}</DrillLink></td>
      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{r.sold != null ? f.int(r.sold) : '—'}</td>
      {money && <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{r.value_eur != null ? f.eur(r.value_eur) : '—'}</td>}
      {money && <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums">{r.delivered_cash_mkd != null ? f.den(r.delivered_cash_mkd) : '—'}</td>}
    </>
  );
  const colSpan = money ? 5 : 3;

  const stateRow = (key: string, depth: number, state: Exclude<LevelState, OverviewPivotRow[]> | 'empty') => (
    <tr key={`${key}-state`} className="border-t">
      <td colSpan={colSpan} className="py-1.5 pr-3 text-xs text-muted-foreground" style={{ paddingLeft: 12 + depth * 20 }}>
        {state === 'loading'
          ? <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" aria-hidden />{t('common.loading')}</span>
          : state === 'owners' ? t('insights.ownersOnly')
            : state === 'error' ? t('overview.pivot.failed') : t('overview.pivot.nothing')}
      </td>
    </tr>
  );
  const states = (key: string, depth: number, st: LevelState | null) =>
    st == null ? null : typeof st === 'string' ? stateRow(key, depth, st) : st.length === 0 ? stateRow(key, depth, 'empty') : null;

  const rowHead = (key: string, depth: number, text: string, expandable: boolean, swatch?: string) => {
    const isOpen = open.has(key);
    return (
      <th scope="row" className="max-w-[320px] py-1.5 pr-3 text-left font-medium" style={{ paddingLeft: 8 + depth * 20 }}>
        <span className="flex min-w-0 items-center gap-1.5">
          {expandable ? (
            <button type="button" onClick={() => toggle(key)} aria-expanded={isOpen}
              aria-label={t(isOpen ? 'overview.pivot.collapse' : 'overview.pivot.expand', { name: text })}
              className="rounded-sm p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', isOpen && 'rotate-90')} aria-hidden />
            </button>
          ) : <span className="w-[18px] shrink-0" />}
          {swatch && <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: swatch }} aria-hidden />}
          <span className={cn('truncate', depth > 0 && 'font-normal')} title={text}>{text}</span>
        </span>
      </th>
    );
  };

  return (
    <section aria-labelledby="ov-pivot-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="ov-pivot-title" className="text-base font-semibold">{t('overview.pivot.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('overview.pivot.subtitle')}</p>
          <ClockCaption clock="created" />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('overview.pivot.leaf')}
          <select value={leaf} onChange={(e) => setLeaf(e.target.value as OverviewPivotDim)}
            className="h-8 rounded-md border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {LEAVES.map((d) => <option key={d} value={d}>{t(`overview.pivot.dim.${d}`)}</option>)}
          </select>
        </label>
      </div>
      <div className="relative overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[560px] text-sm">
          <caption className="sr-only">{t('overview.pivot.subtitle')}</caption>
          <thead className="bg-muted/50 text-[11px] text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">{t('overview.pivot.col.name')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('overview.pivot.col.count')}</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">{t('overview.pivot.col.sold')}</th>
              {money && <th scope="col" className="px-3 py-2 text-right font-medium">{t('overview.pivot.col.value')}</th>}
              {money && <th scope="col" className="px-3 py-2 text-right font-medium">{t('overview.pivot.col.cash')}</th>}
            </tr>
          </thead>
          <tbody>
            {sources.map((src) => {
              const k1 = src.key;
              const placed = placedOf(src);
              // The web mirror is not `orders`: the pivot holds nothing under it.
              const expandable = !!sourceDrill(src, range);
              const l2 = open.has(k1) ? level(q2, L2, (r) => r.source === src.key) : null;
              return (
                <Fragment key={k1}>
                  <tr className="border-t">
                    {rowHead(k1, 0, f.source(src.key), expandable, sourceColorVar(src.key))}
                    {cells({
                      count: placed.count,
                      sold: src.cohort_sold ?? null,
                      // Same measure as the rows below: sold value of the placed cohort.
                      value_eur: soldValueOf(src),
                      delivered_cash_mkd: src.money?.collected_mkd ?? null,
                    }, drillFor(src, {}))}
                  </tr>
                  {states(k1, 1, l2)}
                  {Array.isArray(l2) && l2.map((r2) => {
                    const team = isNone(r2.team) ? null : String(r2.team);
                    const k2 = `${k1}${SEP}${String(r2.team ?? '')}`;
                    const teamKey = team ? keyByName.get(team) : undefined;
                    const l3 = open.has(k2) ? level(q3, L3, (r) => r.source === src.key && r.team === r2.team) : null;
                    return (
                      <Fragment key={k2}>
                        <tr className="border-t bg-muted/10">
                          {rowHead(k2, 1, label(r2, 'team'), true)}
                          {cells(r2, teamKey ? drillFor(src, { team_key: teamKey }, team!) : null)}
                        </tr>
                        {states(k2, 2, l3)}
                        {Array.isArray(l3) && l3.map((r3) => {
                          const pid = r3.person_id ? String(r3.person_id) : null;
                          const k3 = `${k2}${SEP}${pid ?? String(r3.person ?? '')}`;
                          const l4 = open.has(k3)
                            ? level(q4, [...L3, leaf], (r) =>
                              r.source === src.key && r.team === r2.team && (r.person_id ?? null) === (r3.person_id ?? null) && r.person === r3.person)
                            : null;
                          const personDrill = pid ? { sold_by_person_id: pid } : null;
                          return (
                            <Fragment key={k3}>
                              <tr className="border-t bg-muted/20">
                                {rowHead(k3, 2, label(r3, 'person'), true)}
                                {cells(r3, personDrill ? drillFor(src, personDrill, label(r3, 'person')) : null)}
                              </tr>
                              {states(k3, 3, l4)}
                              {Array.isArray(l4) && l4.map((r4) => {
                                const v = r4[leaf];
                                const param = PIVOT_LEAF_PARAM[leaf];
                                const href = personDrill && param && !isNone(v)
                                  ? drillFor(src, { ...personDrill, [param]: String(v) }, `${label(r3, 'person')} · ${label(r4, leaf)}`)
                                  : null;
                                const k4 = `${k3}${SEP}${String(v ?? '')}`;
                                return (
                                  <tr key={k4} className="border-t bg-muted/30">
                                    {rowHead(k4, 3, label(r4, leaf), false)}
                                    {cells(r4, href)}
                                  </tr>
                                );
                              })}
                            </Fragment>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {(q2.data?.truncated || q3.data?.truncated || q4.data?.truncated) && (
        <p className="text-[11px] text-muted-foreground">{t('overview.pivot.truncated')}</p>
      )}
    </section>
  );
}
