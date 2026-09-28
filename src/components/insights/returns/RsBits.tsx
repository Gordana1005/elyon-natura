import { useId, useRef, useState, type ReactNode } from 'react';
import { Table2, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DrillLink } from '../overview/DrillLink';
import { dm } from '../overview/useOverviewFormat';
import { ClockCaption } from '../shared/ClockCaption';
import type { ClockKey, InsightsFormat } from '../shared/useInsightsFormat';
import type { RsDrill } from './returnsModel';

// Small building blocks shared by the Returns and the Products & stock tabs —
// the Overview's card language (rounded-xl card, muted title, clock caption,
// tabular numbers), nothing new.

/** A number with one decimal in the reader's marks (5,9 · 5.9) — days, percentage points. */
export const dec1 = (f: InsightsFormat, v: number) => f.pct(v / 100, 1).replace('%', '');

/** Why a number has no link of its own — said in its tooltip, never silently. */
export function rsWhy(f: InsightsFormat, d: RsDrill): string | undefined {
  if (d.href) return undefined;
  switch (d.blocked) {
    case 'web': return f.t('insights.common.cohort.noLinkWeb');
    case 'mex_only': return f.t('insights.common.cohort.noLinkMexOnly');
    case 'mixed': return f.t('insights.common.cohort.noLinkMixed');
    case 'mex_day': return f.t('insights.returns.noLinkMexDay');
    default: return undefined;
  }
}

/** A count that opens exactly the orders it counts; a number only partly made of
 *  orders offers "N во Нарачки" under it instead. */
export function CountLink({ drill, children, label, f, className }: {
  drill: RsDrill; children: ReactNode; label: string; f: InsightsFormat; className?: string;
}) {
  return (
    <span className="inline-flex flex-col">
      <DrillLink href={drill.href} title={rsWhy(f, drill)} ariaLabel={label} className={className}>{children}</DrillLink>
      {drill.ordersHref && drill.orders > 0 && (
        <DrillLink
          href={drill.ordersHref}
          title={f.t('insights.common.cohort.ordersPartHint')}
          ariaLabel={`${label} — ${f.t('insights.common.cohort.ordersPart', { n: f.int(drill.orders) })}`}
          className="text-[11px] font-medium tabular-nums text-primary"
        >
          {f.t('insights.common.cohort.ordersPart', { n: f.int(drill.orders) })}
        </DrillLink>
      )}
    </span>
  );
}

/** A card with a title, the clock it counts by, and an optional control on the right. */
export function Section({ title, clock, right, children, className, sub }: {
  title: ReactNode; clock?: ClockKey | ClockKey[]; right?: ReactNode; children: ReactNode; className?: string; sub?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm', className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 space-y-0.5">
          <h3 id={id} className="text-sm font-medium text-muted-foreground">{title}</h3>
          {clock && <ClockCaption clock={clock} />}
          {sub && <p className="text-[11px] leading-snug text-muted-foreground">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** A KPI tile: label, big number, a line or two under it. */
export function Tile({ icon: Icon, label, value, sub, tone, alert, children }: {
  icon?: LucideIcon;
  label: string; value: ReactNode; sub?: ReactNode; tone?: string; alert?: 'warning' | 'critical' | null; children?: ReactNode;
}) {
  return (
    <li className={cn(
      'flex min-w-0 flex-col gap-0.5 rounded-xl border bg-card p-3 shadow-sm',
      alert === 'warning' && 'border-amber-300 dark:border-amber-900',
      alert === 'critical' && 'border-red-300 bg-red-50/60 dark:border-red-900 dark:bg-red-950/30',
    )}>
      <span className="flex items-center gap-1.5 text-[11px] font-medium leading-tight text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" />}
        <span className="min-w-0">{label}</span>
      </span>
      <span className={cn('text-2xl font-semibold tabular-nums leading-tight', tone ?? 'text-card-foreground')}>{value}</span>
      {sub && <span className="text-[11px] leading-snug text-muted-foreground">{sub}</span>}
      {children}
    </li>
  );
}

/** A thin share bar (0..1) in one hue — the rate columns of the tables. */
export function ShareBar({ value, tone, label }: { value: number | null | undefined; tone: string; label?: string }) {
  const w = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return (
    <span className="block h-1.5 w-full min-w-[3rem] overflow-hidden rounded-full bg-muted" role="img" aria-label={label}>
      <span className={cn('block h-full rounded-full', tone)} style={{ width: `${w * 100}%` }} />
    </span>
  );
}

export interface RateRowView {
  key: string;
  name: ReactNode;
  base: number;
  returned: number;
  rate: number | null;
  value_mkd?: number | null;
  drill?: RsDrill | null;
  muted?: boolean;
  hint?: string;
}

/**
 * name · base · returned · rate (with its bar) · uncollected value (owners).
 * A rate on a small base is shown, not bolded: MIN base keeps a 1-of-2 from
 * reading like a pattern.
 */
export function RateTable({ rows, baseLabel, returnedLabel, money, tone, f, minBase = 0, empty, footer }: {
  rows: RateRowView[]; baseLabel: string; returnedLabel: string; money: boolean; tone: string; f: InsightsFormat;
  minBase?: number; empty?: string; footer?: ReactNode;
}) {
  const { t } = f;
  if (!rows.length) return <p className="py-4 text-center text-sm text-muted-foreground">{empty ?? t('insights.returns.empty')}</p>;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[420px] text-sm">
        <thead>
          <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="px-1 py-1.5 text-left font-medium"><span className="sr-only">{t('insights.returns.col.name')}</span></th>
            <th scope="col" className="px-1 py-1.5 text-right font-medium">{baseLabel}</th>
            <th scope="col" className="px-1 py-1.5 text-right font-medium">{returnedLabel}</th>
            <th scope="col" className="w-28 px-1 py-1.5 text-right font-medium">{t('insights.returns.col.rate')}</th>
            {money && <th scope="col" className="px-1 py-1.5 text-right font-medium">{t('insights.returns.col.uncollected')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const small = r.base < minBase;
            return (
              <tr key={r.key} className={cn('border-b align-top last:border-0', r.muted && 'text-muted-foreground')}>
                <th scope="row" className="max-w-[14rem] px-1 py-1.5 text-left font-medium" title={r.hint}>
                  <span className="line-clamp-2 break-words">{r.name}</span>
                </th>
                <td className="px-1 py-1.5 text-right tabular-nums">{f.int(r.base)}</td>
                <td className="px-1 py-1.5 text-right font-semibold tabular-nums">
                  {r.drill
                    ? <CountLink drill={r.drill} label={`${typeof r.name === 'string' ? r.name : ''} · ${returnedLabel}: ${f.int(r.returned)}`} f={f}>{f.int(r.returned)}</CountLink>
                    : f.int(r.returned)}
                </td>
                <td className="px-1 py-1.5 text-right tabular-nums">
                  <span className={cn('block', small ? 'text-muted-foreground' : 'font-medium')} title={small ? t('insights.returns.smallBase', { n: f.int(minBase) }) : undefined}>
                    {r.rate != null ? f.pct(r.rate) : '—'}
                  </span>
                  <ShareBar value={r.rate} tone={tone} label={r.rate != null ? f.pct(r.rate) : undefined} />
                </td>
                {money && <td className="px-1 py-1.5 text-right tabular-nums text-muted-foreground">{r.value_mkd != null ? f.den(r.value_mkd) : '—'}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {footer && <div className="mt-2 text-[11px] text-muted-foreground">{footer}</div>}
    </div>
  );
}

export interface ColumnSegView { key: string; value: number }

/**
 * Stacked columns, one per day (per month on long periods): heights are
 * counts on ONE axis, 2 px surface gaps between the parts, 4 px rounded tops,
 * a tooltip per column (hover or keyboard focus), a legend with words and
 * totals, and the same numbers as a table one click away.
 */
export function DayColumns({ columns, parts, granularity, f, label, height = 150 }: {
  columns: { d: string; total: number; segs: ColumnSegView[] }[];
  /** Legend order = stack order, bottom → top. `tone` is a class, `color` a CSS colour. */
  parts: { key: string; label: string; tone?: string; color?: string }[];
  granularity: 'day' | 'month';
  f: InsightsFormat;
  label: string;
  height?: number;
}) {
  const { t } = f;
  const ref = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ i: number; x: number } | null>(null);
  const max = Math.max(1, ...columns.map((c) => c.segs.reduce((a, s) => a + s.value, 0)));
  const dayLabel = (d: string) => (granularity === 'day' ? dm(d) : `${d.slice(5, 7)}.${d.slice(0, 4)}`);
  const totals = parts.map((p) => columns.reduce((a, c) => a + (c.segs.find((s) => s.key === p.key)?.value ?? 0), 0));
  const partOf = (k: string) => parts.find((p) => p.key === k);
  const show = (i: number, el: HTMLElement) => {
    const box = ref.current?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    if (box) setTip({ i, x: r.left - box.left + r.width / 2 });
  };
  const active = tip ? columns[tip.i] : null;
  const ticks = columns.length <= 1 ? [0] : [0, Math.floor((columns.length - 1) / 2), columns.length - 1];

  return (
    <div className="space-y-2">
      <div ref={ref} className="relative">
        <div className="flex items-start gap-2">
          <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{f.compact(max)}</span>
          <div
            role="img"
            aria-label={`${label}: ${parts.map((p, i) => `${p.label} ${f.int(totals[i])}`).join(' · ')}`}
            className="flex min-w-0 flex-1 items-end gap-[2px] border-b border-border"
            style={{ height }}
          >
            {columns.map((c, i) => (
              <div
                key={c.d}
                tabIndex={0}
                aria-label={`${dayLabel(c.d)}: ${c.segs.map((s) => `${partOf(s.key)?.label ?? s.key} ${f.int(s.value)}`).join(' · ')}`}
                onPointerEnter={(e) => show(i, e.currentTarget)}
                onPointerLeave={() => setTip(null)}
                onFocus={(e) => show(i, e.currentTarget)}
                onBlur={() => setTip(null)}
                className={cn('flex h-full min-w-[3px] flex-1 flex-col-reverse gap-[2px] rounded-t-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  tip?.i === i && 'bg-muted/60')}
              >
                {c.segs.filter((s) => s.value > 0).map((s, j, arr) => {
                  const p = partOf(s.key);
                  return (
                    <div
                      key={s.key}
                      className={cn('w-full shrink-0', p?.tone, j === arr.length - 1 && 'rounded-t-[4px]')}
                      style={{ height: `${(s.value / max) * 100}%`, ...(p?.color ? { background: p.color } : {}) }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="ml-10 mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
          {ticks.map((i) => <span key={i}>{columns[i] ? dayLabel(columns[i].d) : ''}</span>)}
        </div>
        {active && tip && (() => {
          const w = ref.current?.clientWidth ?? 0;
          const align = tip.x < w * 0.25 ? 'left' : tip.x > w * 0.75 ? 'right' : 'center';
          return (
            <div
              role="presentation"
              className={cn('pointer-events-none absolute top-0 z-20 rounded-md border bg-popover px-2 py-1.5 text-xs tabular-nums text-popover-foreground shadow-md',
                align === 'center' && '-translate-x-1/2')}
              style={align === 'left' ? { left: tip.x } : align === 'right' ? { right: w - tip.x } : { left: tip.x }}
            >
              <p className="font-medium">{dayLabel(active.d)}</p>
              {[...parts].reverse().map((p) => {
                const v = active.segs.find((s) => s.key === p.key)?.value ?? 0;
                return (
                  <p key={p.key} className="flex items-center gap-1.5">
                    <span className={cn('h-2 w-2 rounded-full', p.tone)} style={p.color ? { background: p.color } : undefined} aria-hidden />
                    {p.label} <b className="ml-auto pl-2">{f.int(v)}</b>
                  </p>
                );
              })}
            </div>
          );
        })()}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {parts.map((p, i) => (
            <li key={p.key} className="inline-flex items-center gap-1">
              <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', p.tone)} style={p.color ? { background: p.color } : undefined} aria-hidden />
              {p.label} <b className="tabular-nums text-foreground">{f.int(totals[i])}</b>
            </li>
          ))}
        </ul>
        <details className="text-[11px] text-muted-foreground [&[open]]:w-full">
          <summary className="inline-flex cursor-pointer select-none items-center gap-1 hover:text-foreground">
            <Table2 className="h-3 w-3" aria-hidden />{t('insights.returns.asTable')}
          </summary>
          <div className="mt-2 max-h-64 overflow-auto">
            <table className="w-full text-xs tabular-nums">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th scope="col" className="px-1 py-1 text-left font-medium">{t('insights.returns.col.day')}</th>
                  {parts.map((p) => <th key={p.key} scope="col" className="px-1 py-1 text-right font-medium">{p.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {columns.map((c) => (
                  <tr key={c.d} className="border-b last:border-0 text-foreground">
                    <th scope="row" className="px-1 py-0.5 text-left font-normal">{dayLabel(c.d)}</th>
                    {parts.map((p) => <td key={p.key} className="px-1 py-0.5 text-right">{f.int(c.segs.find((s) => s.key === p.key)?.value ?? 0)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </div>
  );
}

/** A labelled horizontal bar list in one hue (weekday rate, days to return, ages). */
export function BarList({ rows, tone, f, scale }: {
  rows: { key: string; label: ReactNode; value: number; display: ReactNode; sub?: ReactNode; alert?: boolean; href?: ReactNode }[];
  tone: string; f: InsightsFormat; scale?: (v: number) => number;
}) {
  void f;
  const max = Math.max(1e-9, ...rows.map((r) => (scale ? scale(r.value) : r.value)));
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(4.5rem,auto)_1fr_auto] items-center gap-2 text-xs">
          <span className={cn('truncate text-muted-foreground', r.alert && 'font-medium text-amber-700 dark:text-amber-400')}>{r.label}</span>
          <span className="block h-2 overflow-hidden rounded-full bg-muted">
            <span className={cn('block h-full rounded-full', tone)} style={{ width: `${((scale ? scale(r.value) : r.value) / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums">
            {r.href ?? <b>{r.display}</b>}
            {r.sub && <span className="ml-1 text-muted-foreground">{r.sub}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
