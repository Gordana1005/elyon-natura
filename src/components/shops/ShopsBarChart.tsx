import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Toggle } from '@/components/insights/sales/SalesTrend';
import { Section } from './parts';
import type { ShopsFormat } from './useShopsFormat';

export interface ChartRow {
  key: string;
  /** Axis label (14 · 01.09). */
  label: string;
  /** Tooltip / table label (14:00–15:00 · 01.09.2026). */
  long: string;
  receipts: number;
  units: number;
  sales_mkd?: number;
  /** The running hour / today — drawn lighter and named. */
  partial?: boolean;
}

type Measure = 'sales' | 'receipts' | 'units';
type View = 'chart' | 'table';

/**
 * One measure at a time on ONE axis (sales for owners, receipts, units) — a single series, so no
 * legend: the title and the toggle name it. The running hour / day is lighter and named in the
 * tooltip and the table. The table is the same numbers.
 */
export function ShopsBarChart({ id, title, subtitle, rows, f, emptyText }: {
  id: string; title: string; subtitle?: string; rows: ChartRow[]; f: ShopsFormat; emptyText: string;
}) {
  const { t } = f;
  const money = rows.some((r) => r.sales_mkd !== undefined);
  const [picked, setMeasure] = useState<Measure>(money ? 'sales' : 'receipts');
  const measure: Measure = picked === 'sales' && !money ? 'receipts' : picked;
  const [view, setView] = useState<View>('chart');
  const value = (r: ChartRow) => (measure === 'sales' ? r.sales_mkd ?? 0 : measure === 'units' ? r.units : r.receipts);
  const empty = rows.length === 0 || rows.every((r) => r.receipts === 0 && r.units === 0);
  const data = rows.map((r) => ({ ...r, v: value(r) }));

  const options: [Measure, string][] = [
    ...(money ? ([['sales', t('shops.chart.sales')]] as [Measure, string][]) : []),
    ['receipts', t('shops.chart.receipts')],
    ['units', t('shops.chart.units')],
  ];

  return (
    <Section
      id={id} title={title} subtitle={subtitle}
      actions={(
        <>
          <Toggle label={t('shops.chart.measure')} value={measure} onChange={setMeasure} options={options} />
          <Toggle label={t('overview.trend.viewLabel')} value={view} onChange={setView}
            options={[['chart', t('overview.trend.chart')], ['table', t('overview.trend.table')]]} />
        </>
      )}
    >
      {empty ? (
        <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">{emptyText}</p>
      ) : view === 'chart' ? (
        <figure className="min-w-0 rounded-xl border bg-card p-3 shadow-sm sm:p-4">
          <div className="h-[220px] sm:h-[240px]" aria-hidden>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 6, right: 16, bottom: 0, left: 0 }} barCategoryGap="16%">
                <CartesianGrid vertical={false} stroke="var(--ov-grid)" />
                <XAxis dataKey="label" minTickGap={8} interval="preserveStartEnd"
                  tick={{ fontSize: 11, fill: 'var(--ov-axis)' }} axisLine={{ stroke: 'var(--ov-grid)' }} tickLine={false} />
                <YAxis width={measure === 'sales' ? 66 : 40} tickFormatter={(v) => f.compact(Number(v))} tickCount={4} allowDecimals={false}
                  tick={{ fontSize: 11, fill: 'var(--ov-axis)' }} axisLine={false} tickLine={false} />
                <Tooltip
                  cursor={{ fill: 'var(--ov-grid)', opacity: 0.5 }}
                  content={({ active, payload }) => {
                    const row = active && payload?.[0]?.payload as (ChartRow & { v: number }) | undefined;
                    if (!row) return null;
                    return (
                      <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md">
                        <div className="mb-1 text-muted-foreground">{row.long}{row.partial ? ` · ${t('shops.chart.partial')}` : ''}</div>
                        {money && <Line label={t('shops.chart.sales')} value={f.den(row.sales_mkd ?? 0)} strong={measure === 'sales'} />}
                        <Line label={t('shops.chart.receipts')} value={f.int(row.receipts)} strong={measure === 'receipts'} />
                        <Line label={t('shops.chart.units')} value={f.int(row.units)} strong={measure === 'units'} />
                      </div>
                    );
                  }}
                />
                <Bar dataKey="v" radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={36}>
                  {data.map((r) => <Cell key={r.key} fill={r.partial ? 'var(--sh-bar-soft)' : 'var(--sh-bar)'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          {rows.some((r) => r.partial) && (
            <figcaption className="mt-1 text-[11px] text-muted-foreground">{t('shops.chart.partialNote')}</figcaption>
          )}
        </figure>
      ) : (
        <div className="max-h-[420px] overflow-y-auto rounded-xl border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead className="sticky top-0 z-10 bg-muted text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium">{t('shops.chart.when')}</th>
                {money && <th scope="col" className="px-2 py-2 text-right font-medium">{t('shops.chart.sales')}</th>}
                <th scope="col" className="px-2 py-2 text-right font-medium">{t('shops.chart.receipts')}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t('shops.chart.units')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t">
                  <th scope="row" className="px-3 py-1.5 text-left font-medium tabular-nums">
                    {r.long}{r.partial && <span className="ml-1 text-[11px] font-normal text-muted-foreground">{t('shops.chart.partial')}</span>}
                  </th>
                  {money && <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{f.den(r.sales_mkd ?? 0)}</td>}
                  <td className="px-2 py-1.5 text-right tabular-nums">{f.int(r.receipts)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{f.int(r.units)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? 'ml-auto font-semibold tabular-nums' : 'ml-auto tabular-nums'}>{value}</span>
    </div>
  );
}
