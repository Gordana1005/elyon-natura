import { Fragment, useId, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, OctagonAlert } from 'lucide-react';
import { formatMoney } from '@/lib/currency';
import type { ListsPart, ListsResponse, ListsRow } from '@/lib/insightsApi/lists';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { fmtNum } from '../overview/model';
import { Sparkline } from '../overview/Sparkline';
import { dm } from '../overview/useOverviewFormat';
import { CohortBar } from '../shared/CohortBar';
import { cohortWhy } from '../shared/CohortLinks';
import { ClockCaption } from '../shared/ClockCaption';
import { COHORT_TONE, OUTSIDE_TONE, STATUS_TEXT } from '../shared/cohortPalette';
import { cohortHref, isMexOnlySplit, ordersSupportsCohortDrill, type CohortDrill, type DrillKey } from '../shared/cohortModel';
import { splitDrill } from '../overview/cohortOverview';
import type { CohortBucket, CohortBucketKey, CohortOutsideKey } from '../shared/cohortTypes';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import {
  GROUP_BYS, LIST_COHORT_SOURCE, SORT_BYS, aovOf, conversionOf, groupLists, isQuiet, listLabel, listsDrill, listsHref, reachOf,
  returnRateOf, rollup, type GroupBy, type ListsRollup, type ListView, type SortBy,
} from './listModel';

type RowLike = ListsRollup | ListsRow;
const moneyOf = (r: RowLike, k: 'value_mkd' | 'cash_mkd'): number | null | undefined => r[k];

/**
 * Every list, grouped (recency · value band · orders · none) with a roll-up
 * per group: members NOW, the period's work, its cohort sales and where they
 * are, MEX cash, returns, unpacked sales, the last sale and the trend. Each
 * row opens its details (parts, top sellers, the raw name). The footer ties
 * the tab to the Overview: Σ lists + "list not recorded" = the Affiliate –
 * Lead out · prediction_list split, + its other splits (direct, LEADS-OUT, its
 * 9103 parcels with no order) = the Affiliate – Lead out card. Those rows link
 * the way the Overview's card does: by the department (cohort_source=elyon_crm).
 */
export function ListsTable({ data, rows, range, money, f }: {
  data: ListsResponse;
  rows: ListView[];
  range: DayRange;
  money: boolean;
  f: InsightsFormat;
}) {
  const { t } = f;
  const titleId = useId();
  const [groupBy, setGroupBy] = useState<GroupBy>('recency');
  const [sort, setSort] = useState<SortBy>('order');
  const [showQuiet, setShowQuiet] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const quiet = rows.filter(isQuiet).length;
  const shown = useMemo(() => (showQuiet ? rows : rows.filter((r) => !isQuiet(r))), [rows, showQuiet]);
  const groups = useMemo(() => groupLists(shown, groupBy, sort), [shown, groupBy, sort]);
  const allLists = useMemo(() => rollup(rows), [rows]);
  const nr = data.not_recorded;
  const trendDays = data.trend.map((p) => p.d);
  const supported = ordersSupportsCohortDrill();

  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const why = (d: CohortDrill) => (d.href ? undefined
    : d.blocked === 'unknown' ? t('insights.lists.table.nameChanged') : cohortWhy(f, d));

  // Σ lists + not recorded must equal the slice's total (the Overview's split).
  const tieCount = allLists.count + nr.count === data.total.count;
  const tieValue = !money || (allLists.value_mkd ?? 0) + (nr.value_mkd ?? 0) === (data.total.value_mkd ?? 0);
  const otherSplits = data.elyon_crm.splits.filter((s) => s.key !== 'prediction_list' && s.count > 0);
  // Affiliate – Lead out also holds its series' parcels with no order (9103 LEADS-OUT, owner
  // 28.09): they are in no /orders list, so neither they nor a total that includes them link
  const elyonMexOnly = otherSplits.some((s) => isMexOnlySplit(s.key));
  // The department's other parts link as the Overview's chips do (cohort_source=elyon_crm + the
  // detail): a detail alone would also list the same detail in another department.
  const splitHref = (s: { key: string; count: number }) =>
    splitDrill({ key: LIST_COHORT_SOURCE }, { key: s.key, count: s.count, kind: isMexOnlySplit(s.key) ? 'mex' : 'order' }, range, supported).href;
  const elyonHref = supported && data.elyon_crm.count > 0 && !elyonMexOnly ? cohortHref('total', [LIST_COHORT_SOURCE], range) : null;

  const cols = money ? 13 : 11;

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id={titleId} className="text-base font-semibold">{t('insights.lists.table.title')}</h2>
          <p className="text-xs text-muted-foreground">{t('insights.lists.table.subtitle')}</p>
          <ClockCaption clock={['sale', 'decided']} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground">{t('insights.lists.table.groupBy')}</span>
            <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}
              className="h-8 rounded-md border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {GROUP_BYS.map((g) => <option key={g} value={g}>{t(`insights.lists.table.group.${g}`)}</option>)}
            </select>
          </label>
          <label className="inline-flex items-center gap-1.5">
            <span className="text-muted-foreground">{t('insights.lists.table.sortBy')}</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortBy)}
              className="h-8 rounded-md border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {SORT_BYS.filter((s) => money || s !== 'value').map((s) => (
                <option key={s} value={s}>{t(`insights.lists.table.sort.${s}`)}</option>
              ))}
            </select>
          </label>
          {quiet > 0 && (
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={showQuiet} onChange={(e) => setShowQuiet(e.target.checked)} className="h-3.5 w-3.5" />
              <span className="text-muted-foreground">{t('insights.lists.table.showQuiet', { n: f.int(quiet) })}</span>
            </label>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className={cn('w-full text-sm', money ? 'min-w-[1180px]' : 'min-w-[980px]')}>
          <caption className="sr-only">{t('insights.lists.table.title')}</caption>
          <thead>
            <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
              <Th left sticky>{t('insights.lists.table.col.list')}</Th>
              <Th title={t('insights.lists.table.hint.members')}>{t('insights.lists.table.col.members')}</Th>
              <Th title={t('insights.lists.table.hint.worked')}>{t('insights.lists.table.col.worked')}</Th>
              <Th>{t('insights.lists.table.col.sales')}</Th>
              <Th title={t('insights.lists.table.hint.conv')}>{t('insights.lists.table.col.conv')}</Th>
              {money && <Th>{t('insights.lists.table.col.value')}</Th>}
              <Th left className="w-32"><span className="sr-only">{t('insights.common.cohort.barLabel')}</span></Th>
              {money ? <Th title={t('insights.lists.table.hint.cash')}>{t('insights.lists.table.col.cash')}</Th>
                : <Th>{t('insights.lists.table.col.paid')}</Th>}
              <Th title={t('insights.lists.table.hint.returnRate')}>{t('insights.lists.table.col.returnRate')}</Th>
              <Th title={t('insights.lists.table.hint.stale', { days: data.meta.stale_days })}>
                {t('insights.lists.table.col.stale', { days: data.meta.stale_days })}
              </Th>
              {money && <Th title={t('insights.lists.table.hint.aov')}>{t('insights.lists.table.col.aov')}</Th>}
              <Th title={t('insights.lists.table.hint.lastSale')}>{t('insights.lists.table.col.lastSale')}</Th>
              <Th left>{t('insights.lists.table.col.trend')}</Th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr><td colSpan={cols} className="px-3 py-6 text-center text-muted-foreground">{t('insights.lists.table.empty')}</td></tr>
            )}
            {groups.map((g) => (
              <Fragment key={g.key}>
                {groupBy !== 'none' && (
                  <Row
                    kind="group" label={groupLabel(t, groupBy, g.key, g.rows)} sub={t('insights.lists.table.listsN', { n: f.int(g.rows.length) })}
                    r={g.total} parts={[...g.total.buckets, ...g.total.outside]} range={range} money={money} f={f} why={why}
                    lastSale={maxDay(g.rows.map((x) => x.last_sale))}
                  />
                )}
                {g.rows.map((r) => {
                  const isOpen = open.has(r.id);
                  const label = listLabel(t, r.name, r.parsed);
                  return (
                    <Fragment key={r.id}>
                      <Row
                        kind="list" r={r} parts={[...r.buckets, ...r.outside]} range={range} money={money} f={f} why={why}
                        listName={r.drill_name} lastSale={r.last_sale}
                        spark={(money ? r.spark_mkd : r.spark) ?? null} trendDays={trendDays}
                        label={
                          <button type="button" onClick={() => toggle(r.id)} aria-expanded={isOpen}
                            className="flex min-w-0 items-start gap-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                            {isOpen ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
                            <span className="min-w-0">
                              <span className="block truncate font-medium" title={r.name ?? ''}>{label}</span>
                              <Badges r={r} f={f} />
                            </span>
                          </button>
                        }
                      />
                      {isOpen && (
                        <tr className="border-b bg-muted/20">
                          <td colSpan={cols} className="px-3 py-3">
                            <ListDetails r={r} range={range} money={money} f={f} why={why} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
          <tfoot className="text-sm">
            <Row kind="foot" label={t('insights.lists.table.foot.lists', { n: f.int(rows.length) })}
              r={allLists} parts={[...allLists.buckets, ...allLists.outside]} range={range} money={money} f={f} why={why} noLinks />
            {(nr.count > 0 || nr.worked > 0) && (
              <Row
                kind="foot" r={{ ...emptyRoll(), count: nr.count, value_mkd: nr.value_mkd ?? null, cash_mkd: nr.cash_mkd ?? null, worked: nr.worked, buckets: nr.buckets, outside: nr.outside, paid: nr.paid ?? part(nr.buckets, 'paid'), returned: nr.returned ?? part(nr.buckets, 'returned'), units: nr.units ?? 0, stale_to_pack: nr.stale_to_pack ?? 0 }}
                parts={[...nr.buckets, ...nr.outside]} range={range} money={money} f={f} why={why} noLinks
                label={
                  <span className="block">
                    <span className={cn('inline-flex items-center gap-1 font-medium', STATUS_TEXT.warning)}>{t('insights.lists.table.foot.notRecorded')}</span>
                    <span className="block text-[11px] font-normal text-muted-foreground">
                      {nr.samples.slice(0, 5).map((s, i) => (
                        <span key={s.display_id}>
                          {i > 0 && ', '}
                          <DrillLink href={`/orders?search=${encodeURIComponent(s.display_id)}`} className="font-medium text-foreground">{s.display_id}</DrillLink>
                          {s.dup_of && <> ← {s.dup_of}{s.dup_of_list ? ` (${listLabel(t, s.dup_of_list)})` : ''}</>}
                        </span>
                      ))}
                    </span>
                  </span>
                }
              />
            )}
            <Row
              kind="total" r={{ ...emptyRoll(), ...data.total, value_mkd: data.total.value_mkd ?? null, cash_mkd: data.total.cash_mkd ?? null, buckets: data.buckets as ListsPart[], outside: data.outside as ListsPart[], members: allLists.members, members_active: allLists.members_active }}
              parts={[...data.buckets, ...data.outside] as ListsPart[]} range={range} money={money} f={f} why={why}
              label={
                <span className="block">
                  <span className="font-semibold">{t('insights.lists.table.foot.slice')}</span>
                  <span className={cn('flex items-center gap-1 text-[11px] font-normal', tieCount && tieValue ? STATUS_TEXT.good : STATUS_TEXT.critical)}>
                    {tieCount && tieValue ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <OctagonAlert className="h-3 w-3" aria-hidden />}
                    {tieCount && tieValue ? t('insights.lists.table.foot.tieOk') : t('insights.lists.table.foot.tieBad')}
                  </span>
                </span>
              }
            />
            {otherSplits.map((s) => (
              <tr key={s.key} className="border-t text-muted-foreground">
                <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-normal">
                  {t('insights.lists.table.foot.other', { split: f.splitLabel(s.key) })}
                </th>
                <td />
                <td />
                <td className="px-3 py-2 text-right tabular-nums">
                  <DrillLink href={splitHref(s)}>
                    {f.int(s.count)}
                  </DrillLink>
                </td>
                <td />
                {money && <td className="px-3 py-2 text-right tabular-nums">{s.value_mkd != null ? f.den(s.value_mkd) : '—'}</td>}
                <td colSpan={money ? 7 : 6} />
              </tr>
            ))}
            <tr className="border-t-2 bg-muted/30 font-semibold">
              <th scope="row" className="sticky left-0 z-10 bg-muted px-3 py-2 text-left">{t('insights.lists.table.foot.elyon')}</th>
              <td />
              <td />
              <td className="px-3 py-2 text-right tabular-nums">
                <DrillLink href={elyonHref}>
                  {f.int(data.elyon_crm.count)}
                </DrillLink>
              </td>
              <td />
              {money && <td className="px-3 py-2 text-right tabular-nums">{data.elyon_crm.value_mkd != null ? f.den(data.elyon_crm.value_mkd) : '—'}</td>}
              <td colSpan={money ? 7 : 6} className="px-3 py-2 text-left text-[11px] font-normal text-muted-foreground">
                {t('insights.lists.table.foot.elyonHint')}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

const part = (parts: ListsPart[], key: string) => parts.filter((p) => p.key === key).reduce((a, p) => a + p.count, 0);

const emptyRoll = (): ListsRollup => ({
  count: 0, value_mkd: null, cod_mkd: null, cash_mkd: null, stale_to_pack_value_mkd: null, paid: 0, returned: 0, units: 0,
  stale_to_pack: 0, worked: 0, worked_sale: 0, worked_no: 0, worked_trash: 0, customers: 0, members: 0, members_active: 0,
  no_answer: 0, lists: 0, buckets: [], outside: [],
});

const maxDay = (days: (string | null)[]) => days.filter(Boolean).sort().pop() ?? null;

function groupLabel(t: InsightsFormat['t'], by: GroupBy, key: string, rows: ListView[]): string {
  if (by === 'value' && (key === 'le' || key === 'gt')) {
    const th = rows.find((r) => r.parsed.threshold != null)?.parsed.threshold;
    return t(`insights.lists.table.groupName.value.${key}`, { value: th != null ? formatThreshold(th) : '' });
  }
  return t(`insights.lists.table.groupName.${by}.${key}`, { defaultValue: key });
}

// Display only: the band threshold is stored EUR; the label shows денари.
const formatThreshold = (eur: number) => formatMoney(eur);

function Th({ children, left, sticky, className, title }: { children?: ReactNode; left?: boolean; sticky?: boolean; className?: string; title?: string }) {
  return (
    <th scope="col" title={title}
      className={cn('px-3 py-2 font-medium', left ? 'text-left' : 'text-right', sticky && 'sticky left-0 z-10 bg-card', className)}>
      {children}
    </th>
  );
}

function Badges({ r, f }: { r: ListView; f: InsightsFormat }) {
  const { t } = f;
  const tags: string[] = [];
  if (!r.known) tags.push(t('insights.lists.table.badge.deleted'));
  else if (!r.is_active) tags.push(t('insights.lists.table.badge.inactive'));
  if (r.is_static) tags.push(t('insights.lists.table.badge.static'));
  if (!tags.length) return null;
  return (
    <span className="mt-0.5 flex flex-wrap gap-1">
      {tags.map((x) => <span key={x} className="rounded-full bg-muted px-1.5 py-px text-[10px] font-normal text-muted-foreground">{x}</span>)}
    </span>
  );
}

/** One table row — a list, a group roll-up or a footer line (same columns). */
function Row({
  kind, label, sub, r, parts, range, money, f, why, listName, lastSale, spark, trendDays, noLinks,
}: {
  kind: 'list' | 'group' | 'foot' | 'total';
  label: ReactNode;
  sub?: string;
  r: RowLike;
  parts: ListsPart[];
  range: DayRange;
  money: boolean;
  f: InsightsFormat;
  why: (d: CohortDrill) => string | undefined;
  /** The list's exact snapshot name (list rows); undefined = the whole slice; null = no exact link. */
  listName?: string | null;
  lastSale?: string | null;
  spark?: number[] | null;
  trendDays?: string[];
  /** A roll-up that is not one /orders filter (a group of lists, Σ lists). */
  noLinks?: boolean;
}) {
  const { t } = f;
  const drill = (k: DrillKey | DrillKey[]): CohortDrill => (noLinks || kind === 'group')
    ? { href: null, blocked: 'none', ordersHref: null, orders: 0, web: 0, mexOnly: 0 }
    : listsDrill(parts, k, range, kind === 'list' ? listName : undefined);
  const conv = conversionOf(r.count, r.worked);
  const rr = returnRateOf(r.paid, r.returned);
  const aov = aovOf(moneyOf(r, 'value_mkd'), r.count);
  const sales = drill('total');
  const cash = moneyOf(r, 'cash_mkd');
  const value = moneyOf(r, 'value_mkd');
  const membersActive = (r as ListsRow).members_active ?? 0;
  const members = (r as ListsRow).members ?? 0;
  const stale = r.stale_to_pack ?? 0;
  const inTotal = parts.filter((p) => !['cancelled_after_sale', 'trashed_after_sale', 'replacement'].includes(p.key));
  const rowCls = kind === 'group' ? 'border-b bg-muted/40 font-semibold'
    : kind === 'total' ? 'border-t-2 bg-muted/30 font-semibold'
      : kind === 'foot' ? 'border-t' : 'border-b last:border-0 hover:bg-muted/20';
  const stickyBg = kind === 'group' || kind === 'total' ? 'bg-muted' : 'bg-card';
  return (
    <tr className={cn('align-top', rowCls)}>
      <th scope="row" className={cn('sticky left-0 z-10 max-w-[18rem] px-3 py-2 text-left font-normal', stickyBg, kind !== 'list' && 'font-semibold')}>
        {label}
        {sub && <span className="block text-[11px] font-normal text-muted-foreground">{sub}</span>}
      </th>
      <td className="px-3 py-2 text-right tabular-nums">
        {kind === 'foot' && members === 0 ? '' : (
          <>
            {f.int(membersActive)}
            {members !== membersActive && <span className="block text-[11px] font-normal text-muted-foreground">{t('insights.lists.table.ofAll', { n: f.int(members) })}</span>}
          </>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {f.int(r.worked)}
        {r.no_answer > 0 && (
          <span className="block text-[11px] font-normal text-muted-foreground" title={t('insights.lists.table.hint.noAnswer')}>
            {t('insights.lists.table.noAnswerShort', { n: f.int(r.no_answer) })}
          </span>
        )}
      </td>
      <td className={cn('px-3 py-2 text-right font-semibold tabular-nums', r.count === 0 && 'font-normal text-muted-foreground')}>
        <DrillLink href={sales.href} title={why(sales)}>{f.int(r.count)}</DrillLink>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{f.pct(conv, 1)}</td>
      {money && <td className="px-3 py-2 text-right tabular-nums">{value != null ? f.den(value) : '—'}</td>}
      <td className="px-3 py-2.5">
        {r.count > 0 && (
          <CohortBar variant="bar" total={{ count: r.count, value_mkd: value ?? null }} buckets={inTotal as unknown as CohortBucket[]}
            money={money} drillFor={drill} barLabel={t('insights.common.cohort.barLabel')} f={f} />
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {money
          ? (<>{cash != null ? f.den(cash) : '—'}<span className="block text-[11px] font-normal text-muted-foreground">{t('insights.lists.table.paidN', { n: f.int(r.paid) })}</span></>)
          : f.int(r.paid)}
      </td>
      <td className={cn('px-3 py-2 text-right tabular-nums', rr != null && rr > 0 && STATUS_TEXT.returned)}>
        {f.pct(rr, 0)}
        {r.returned > 0 && <span className="block text-[11px] font-normal text-muted-foreground">{f.int(r.returned)}</span>}
      </td>
      <td className={cn('px-3 py-2 text-right tabular-nums', stale > 0 ? STATUS_TEXT.warning : 'text-muted-foreground')}>
        {stale > 0 ? f.int(stale) : '—'}
      </td>
      {money && <td className="px-3 py-2 text-right tabular-nums">{aov != null ? f.den(aov) : '—'}</td>}
      <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">{lastSale ? dm(lastSale, true) : '—'}</td>
      <td className="px-3 py-2">
        {spark && spark.length > 1 && spark.some((v) => v > 0) && (
          <Sparkline points={spark.map((v, i) => ({ d: trendDays?.[i] ?? String(i), v }))} accentClass={COHORT_TONE.paid} className="w-24" />
        )}
      </td>
    </tr>
  );
}

/** The opened row: where each sale is (links), who sold, the work, the raw name. */
function ListDetails({ r, range, money, f, why }: {
  r: ListView; range: DayRange; money: boolean; f: InsightsFormat; why: (d: CohortDrill) => string | undefined;
}) {
  const { t } = f;
  const reach = reachOf(r.worked, r.no_answer);
  const perSale = r.count > 0 ? r.units / r.count : null;
  const supported = ordersSupportsCohortDrill();
  return (
    <div className="grid grid-cols-1 gap-4 text-xs md:grid-cols-3">
      <div className="space-y-1.5">
        <h4 className="font-medium text-muted-foreground">{t('insights.lists.detail.parts')}</h4>
        {r.buckets.length + r.outside.length === 0 && <p className="text-muted-foreground">{t('insights.lists.detail.noSales')}</p>}
        <ul className="flex flex-wrap gap-1.5">
          {[...r.buckets, ...r.outside].map((p) => {
            const d = listsDrill([p], p.key as DrillKey, range, r.drill_name);
            const outside = ['cancelled_after_sale', 'trashed_after_sale', 'replacement'].includes(p.key);
            const tone = outside ? OUTSIDE_TONE[p.key as CohortOutsideKey] : COHORT_TONE[p.key as CohortBucketKey];
            return (
              <li key={p.key} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', tone)} aria-hidden />
                {outside ? f.outsideLabel(p.key) : f.bucketLabel(p.key)}
                <DrillLink href={d.href} title={why(d)} className="font-semibold tabular-nums">{f.int(p.count)}</DrillLink>
                {money && p.value_mkd != null && p.value_mkd > 0 && <span className="tabular-nums text-muted-foreground">· {f.den(p.value_mkd)}</span>}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="space-y-1.5">
        <h4 className="font-medium text-muted-foreground">{t('insights.lists.detail.sellers')}</h4>
        {r.agents.length === 0 ? <p className="text-muted-foreground">—</p> : (
          <ol className="space-y-0.5">
            {r.agents.map((a) => (
              <li key={a.person_id} className="flex flex-wrap items-baseline gap-x-2">
                <DrillLink
                  href={supported && r.drill_name ? listsHref('total', range, { listName: r.drill_name, personId: a.person_id }) : null}
                  className="font-medium">
                  {a.name ?? '—'}
                </DrillLink>
                <span className="tabular-nums text-muted-foreground">
                  {t('insights.lists.detail.sellerLine', { sales: f.int(a.sales), worked: f.int(a.worked), pct: f.pct(conversionOf(a.sales, a.worked), 0) })}
                  {money && a.value_mkd != null && <> · {f.den(a.value_mkd)}</>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="space-y-1">
        <h4 className="font-medium text-muted-foreground">{t('insights.lists.detail.work')}</h4>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
          <dt className="text-muted-foreground">{t('insights.lists.detail.members')}</dt>
          <dd>{t('insights.lists.detail.membersLine', { active: f.int(r.members_active), all: f.int(r.members), assigned: f.int(r.members_assigned) })}</dd>
          <dt className="text-muted-foreground">{t('insights.lists.detail.decisions')}</dt>
          <dd>{t('insights.lists.detail.decisionsLine', { sale: f.int(r.worked_sale), no: f.int(r.worked_no), trash: f.int(r.worked_trash) })}</dd>
          <dt className="text-muted-foreground">{t('insights.lists.detail.customers')}</dt>
          <dd>{f.int(r.customers)}</dd>
          <dt className="text-muted-foreground">{t('insights.lists.detail.noAnswer')}</dt>
          <dd>{f.int(r.no_answer)} · {t('insights.lists.detail.reach', { pct: f.pct(reach, 0) })}</dd>
          <dt className="text-muted-foreground">{t('insights.lists.detail.units')}</dt>
          <dd>{f.int(r.units)}{perSale != null && <> · {t('insights.lists.detail.perSale', { n: fmtNum(perSale, f.lang, 1) })}</>}</dd>
        </dl>
        <p className="pt-1 text-[11px] text-muted-foreground">
          {t('insights.lists.detail.rawName')} <code className="rounded bg-muted px-1 py-px text-[11px] text-foreground">{r.name ?? '—'}</code>
        </p>
      </div>
    </div>
  );
}
