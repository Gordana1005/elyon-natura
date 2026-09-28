import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { PeopleDetail, PeoplePerson } from '@/lib/insightsApi/agents';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { DeltaBadge } from '../overview/KpiRow';
import { delta, fmtNum } from '../overview/model';
import { sourceColorVar } from '../overview/palette';
import { dm } from '../overview/useOverviewFormat';
import { ClockCaption } from '../shared/ClockCaption';
import { STATUS_TEXT } from '../shared/cohortPalette';
import { COHORT_SOURCE_PARAM } from '../shared/cohortTypes';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { personHref, ratesOf, type PartKey } from './model';
import { DECISIONS, DECISION_TONE, decisionVar, type DecisionKey } from './palette';
import { BucketLegend, BucketsBar, PersonBadges, TimeCell, teamName } from './parts';

const DECISION_FIELD: Record<DecisionKey, 'sale_decisions' | 'callback_decisions' | 'cancel_decisions' | 'trash_decisions'> = {
  sale: 'sale_decisions', callback: 'callback_decisions', cancel: 'cancel_decisions', trash: 'trash_decisions',
};

/**
 * One person in depth: their numbers, where their sales are now (each part
 * opens exactly those orders), per source, day by day (decisions stacked by
 * outcome · credited sales — two charts, never two axes), what they sell,
 * the handles that name them and their team history.
 */
export function PersonDetail({ person, detail, range, money, granularity, f }: {
  person: PeoplePerson;
  detail: PeopleDetail | null;
  range: DayRange;
  money: boolean;
  granularity: 'day' | 'month';
  f: InsightsFormat;
}) {
  const { t } = f;
  const r = ratesOf(person);
  const href = (k: PartKey | PartKey[], label: string) => personHref(person.person_id, k, range, `${person.name} · ${label}`);
  const allHref = person.sales > 0 ? personHref(person.person_id, 'total', range, person.name) : null;
  // one source's part of the person's sales: GET /orders?cohort_source= (collabBox is two
  // sources — Social media and Teleshop – Lead in — so a sale_source list cannot say it)
  const srcHref = (source: string) => {
    const u = new URL(personHref(person.person_id, 'total', range, person.name), 'http://x');
    u.searchParams.set(COHORT_SOURCE_PARAM, source);
    return `${u.pathname}${u.search}`;
  };
  const stat = (label: string, value: ReactNode, sub?: ReactNode, tone?: string) => (
    <div className="min-w-0 rounded-lg border px-2.5 py-2">
      <p className="truncate text-[11px] text-muted-foreground" title={label}>{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', tone)}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{teamName(person.team_key, null, f)}</span>
        <PersonBadges p={person} f={f} />
        {allHref && (
          <Link to={allHref} className="ml-auto inline-flex items-center gap-1 rounded-md border px-2 py-1 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {t('insights.agents.drill.openOrders', { n: f.int(person.sales) })}<ExternalLink className="h-3 w-3" aria-hidden />
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat(t('insights.agents.col.sales'), <DrillLink href={allHref}>{f.int(person.sales)}</DrillLink>,
          person.prev ? <DeltaBadge d={delta(person.sales, person.prev.sales, 'up')} f={f} /> : null)}
        {stat(t('insights.agents.col.worked'), f.int(person.worked),
          t('insights.agents.drill.decisionsLine', { sale: f.int(person.sale_decisions), cancel: f.int(person.cancel_decisions), trash: f.int(person.trash_decisions) }))}
        {stat(t('insights.agents.col.conversion'), r.conversion != null ? f.pct(r.conversion) : '—')}
        {stat(t('insights.agents.col.paidShare'), r.paidShare != null ? f.pct(r.paidShare, 0) : '—', null, STATUS_TEXT.good)}
        {stat(t('insights.agents.col.returnRate'), r.returnRate != null ? f.pct(r.returnRate) : '—', null, STATUS_TEXT.returned)}
        {stat(t('insights.agents.col.packages'), f.int(person.packages),
          r.packagesPerSale != null ? t('insights.agents.drill.perSale', { n: fmtNum(r.packagesPerSale, f.lang, 1) }) : null)}
        {stat(t('insights.agents.col.online'), <TimeCell m={person} f={f} />,
          r.salesPerActiveHour != null ? t('insights.agents.boards.perHourValue', { n: fmtNum(r.salesPerActiveHour, f.lang, 1) }) : null)}
        {money
          ? stat(t('insights.agents.col.value'), person.value_mkd != null ? f.den(person.value_mkd) : '—',
            r.aov != null ? t('insights.agents.drill.aovLine', { v: f.den(r.aov) }) : null)
          : stat(t('insights.agents.col.cancelledAfter'), f.int(person.outside.cancelled_after_sale), null, person.outside.cancelled_after_sale > 0 ? STATUS_TEXT.critical : undefined)}
      </div>

      {person.sales > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t('insights.agents.drill.whereNow')}</h3>
          <BucketsBar buckets={person.buckets} total={person.sales} label={t('insights.agents.drill.whereNow')} href={href} f={f} className="h-3" />
          <BucketLegend buckets={person.buckets} total={person.sales} cancelled={person.outside.cancelled_after_sale} href={href} f={f} />
          {money && person.paid_mkd != null && (
            <p className="text-[11px] tabular-nums text-muted-foreground">{t('insights.agents.drill.paidValue', { v: f.den(person.paid_mkd) })}</p>
          )}
          <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs">
            {(['altercpa', 'elyon_crm', 'teleshop_other', 'social'] as const).filter((k) => (person.by_source[k] ?? 0) > 0).map((k) => (
              <li key={k} className="inline-flex items-center gap-1.5">
                <span className="h-[3px] w-3 rounded-full" style={{ background: sourceColorVar(k) }} aria-hidden />
                {f.sourceLabel(k)}
                <DrillLink href={srcHref(k)} className="font-semibold tabular-nums">{f.int(person.by_source[k])}</DrillLink>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail && <DayCharts detail={detail} money={money} granularity={granularity} f={f} />}

      {detail && detail.products.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-sm font-medium">{t('insights.agents.drill.products')}</h3>
          <ol className="space-y-1 text-[13px]">
            {detail.products.map((p) => (
              <li key={p.name} className="flex items-baseline justify-between gap-2">
                <span className="truncate">{f.dimLabel(p.name)}</span>
                <span className="shrink-0 tabular-nums">
                  <span className="font-semibold">{f.int(p.count)}</span>
                  {money && p.value_mkd != null && <span className="text-muted-foreground"> · {f.den(p.value_mkd)}</span>}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {detail && (detail.identities.length > 0 || detail.memberships.length > 0) && (
        <section className="grid grid-cols-1 gap-3 text-[12px] sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-sm font-medium">{t('insights.agents.drill.identities')}</h3>
            <ul className="space-y-0.5 text-muted-foreground">
              {detail.identities.map((i) => (
                <li key={`${i.kind}-${i.value}`}><span className="text-foreground">{i.value}</span> · {t(`insights.agents.drill.kind.${i.kind}`, { defaultValue: i.kind })}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-1 text-sm font-medium">{t('insights.agents.drill.memberships')}</h3>
            <ul className="space-y-0.5 text-muted-foreground">
              {detail.memberships.length === 0 && <li>{t('insights.agents.team.byKey.none')}</li>}
              {detail.memberships.map((m) => (
                <li key={`${m.team_key}-${m.from}`}>
                  <span className="text-foreground">{teamName(m.team_key, m.name, f)}</span>
                  {' · '}{dm(m.from, true)} – {m.to ? dm(m.to, true) : t('insights.agents.drill.now')}
                  {m.role === 'lead' && ` · ${t('insights.agents.drill.lead')}`}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}

function DayCharts({ detail, money, granularity, f }: { detail: PeopleDetail; money: boolean; granularity: 'day' | 'month'; f: InsightsFormat }) {
  const { t } = f;
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const rows = detail.days;
  const label = (b: string, long = false) => {
    if (granularity === 'month' || b.length === 7) {
      const [y, m] = b.split('-').map(Number);
      return formatDate(new Date(y, m - 1, 1), long ? 'LLLL yyyy' : 'LLL yy');
    }
    return long ? dm(b, true) : dm(b);
  };
  const any = useMemo(() => rows.some((d) => d.worked > 0 || d.sales > 0), [rows]);
  if (rows.length < 2 || !any) return null;
  const axis = { fontSize: 11, fill: 'var(--ov-axis)' };
  const tip = (keys: { key: string; name: string; color: string }[]) =>
    function Tip({ active, payload, label: lb }: { active?: boolean; payload?: { dataKey?: unknown; value?: unknown }[]; label?: unknown }) {
      if (!active || !payload?.length) return null;
      return (
        <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
          <div className="mb-1 text-muted-foreground">{label(String(lb), true)}</div>
          {keys.map((k) => {
            const v = payload.find((p) => p.dataKey === k.key)?.value;
            return (
              <div key={k.key} className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-sm" style={{ background: k.color }} />
                <span className="font-semibold tabular-nums">{f.int(Number(v ?? 0))}</span>
                <span className="text-muted-foreground">{k.name}</span>
              </div>
            );
          })}
        </div>
      );
    };
  const decKeys = DECISIONS.map((k) => ({ key: DECISION_FIELD[k], name: t(`insights.agents.drill.decision.${k}`), color: decisionVar(k) }));
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">{t('insights.agents.drill.byDay')}</h3>
          <ClockCaption clock={['decided', 'sale']} />
        </div>
        <div role="group" aria-label={t('overview.trend.viewLabel')} className="inline-flex rounded-lg border p-0.5">
          {(['chart', 'table'] as const).map((v) => (
            <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
              className={cn('rounded-md px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                view === v ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
              {t(`overview.trend.${v}`)}
            </button>
          ))}
        </div>
      </div>
      {view === 'chart' ? (
        <div className="grid grid-cols-1 gap-3">
          <figure className="min-w-0">
            <figcaption className="mb-1 text-xs text-muted-foreground">{t('insights.agents.drill.decisionsChart')}</figcaption>
            <ul className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-hidden>
              {DECISIONS.map((k) => (
                <li key={k} className="inline-flex items-center gap-1"><span className={cn('h-2 w-2 rounded-sm', DECISION_TONE[k])} />{t(`insights.agents.drill.decision.${k}`)}</li>
              ))}
            </ul>
            <div className="h-[160px]" aria-hidden>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
                  <CartesianGrid vertical={false} stroke="var(--ov-grid)" />
                  <XAxis dataKey="d" tickFormatter={(b) => label(String(b))} minTickGap={14} tick={axis} axisLine={{ stroke: 'var(--ov-grid)' }} tickLine={false} />
                  <YAxis width={40} allowDecimals={false} tickCount={4} tick={axis} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: 'var(--ov-grid)', opacity: 0.4 }} content={tip(decKeys)} />
                  {DECISIONS.map((k, i) => (
                    <Bar key={k} dataKey={DECISION_FIELD[k]} stackId="d" fill={decisionVar(k)} stroke="hsl(var(--card))" strokeWidth={1}
                      radius={i === DECISIONS.length - 1 ? [3, 3, 0, 0] : 0} isAnimationActive={false} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </figure>
          <figure className="min-w-0">
            <figcaption className="mb-1 text-xs text-muted-foreground">{t('insights.agents.drill.salesChart')}</figcaption>
            <div className="h-[120px]" aria-hidden>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
                  <CartesianGrid vertical={false} stroke="var(--ov-grid)" />
                  <XAxis dataKey="d" tickFormatter={(b) => label(String(b))} minTickGap={14} tick={axis} axisLine={{ stroke: 'var(--ov-grid)' }} tickLine={false} />
                  <YAxis width={40} allowDecimals={false} tickCount={4} tick={axis} axisLine={false} tickLine={false} />
                  <Tooltip cursor={{ fill: 'var(--ov-grid)', opacity: 0.4 }}
                    content={tip([{ key: 'sales', name: t('insights.agents.col.sales'), color: decisionVar('sale') }])} />
                  <Bar dataKey="sales" fill={decisionVar('sale')} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </figure>
        </div>
      ) : (
        <div className="relative max-h-[320px] overflow-auto rounded-lg border">
          <table className="w-full min-w-[520px] text-xs">
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-left font-medium">{t('overview.trend.colPeriod')}</th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.agents.col.worked')}</th>
                {DECISIONS.map((k) => <th key={k} scope="col" className="px-2 py-1.5 text-right font-medium">{t(`insights.agents.drill.decision.${k}`)}</th>)}
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.agents.col.sales')}</th>
                {money && <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.agents.col.value')}</th>}
                <th scope="col" className="px-2 py-1.5 text-right font-medium">{t('insights.agents.col.online')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.d} className="border-t">
                  <th scope="row" className="px-2 py-1 text-left font-medium tabular-nums">{label(d.d, true)}</th>
                  <td className="px-2 py-1 text-right tabular-nums">{f.int(d.worked)}</td>
                  {DECISIONS.map((k) => <td key={k} className="px-2 py-1 text-right tabular-nums">{f.int(d[DECISION_FIELD[k]])}</td>)}
                  <td className="px-2 py-1 text-right font-semibold tabular-nums">{f.int(d.sales)}</td>
                  {money && <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">{d.value_mkd != null ? f.den(d.value_mkd) : '—'}</td>}
                  <td className="px-2 py-1 text-right tabular-nums">{d.online_min != null ? f.minutes(d.online_min) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
