import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A KPI tile — the Insights look (white card, small label, big tabular number). */
export function Tile({ icon: Icon, label, value, sub, tone, testId }: {
  icon?: LucideIcon; label: string; value: ReactNode; sub?: ReactNode; tone?: string; testId?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-card px-3 py-2.5 shadow-sm" data-testid={testId}>
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />}<span className="truncate">{label}</span>
      </p>
      <p className={cn('mt-0.5 truncate text-xl font-semibold tabular-nums sm:text-2xl', tone)}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function Section({ title, note, children, className, id }: {
  title: ReactNode; note?: ReactNode; children: ReactNode; className?: string; id?: string;
}) {
  return (
    <section className={cn('min-w-0 rounded-xl border bg-card p-3 shadow-sm', className)} aria-labelledby={id}>
      <h3 id={id} className="text-sm font-semibold">{title}</h3>
      {note && <p className="mt-0.5 text-[11px] text-muted-foreground">{note}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

export interface Col<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /** Shown as the card's title below md (one column per table). */
  primary?: boolean;
}

/** A table from md; below md each row is a card (the primary column as its title). */
export function ResponsiveTable<T>({ rows, cols, rowKey, empty, testId }: {
  rows: T[]; cols: Col<T>[]; rowKey: (r: T, i: number) => string; empty: string; testId?: string;
}) {
  if (!rows.length) return <p className="py-2 text-xs text-muted-foreground">{empty}</p>;
  const primary = cols.find((c) => c.primary) ?? cols[0];
  const rest = cols.filter((c) => c !== primary);
  return (
    <div data-testid={testId}>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              {cols.map((c) => (
                <th key={c.key} className={cn('px-2 py-1.5 font-medium', c.align === 'right' && 'text-right')}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={rowKey(r, i)} className="border-b last:border-0 hover:bg-muted/30">
                {cols.map((c) => (
                  <td key={c.key} className={cn('px-2 py-1.5 align-top', c.align === 'right' && 'text-right tabular-nums')}>{c.render(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((r, i) => (
          <li key={rowKey(r, i)} className="rounded-lg border bg-background/60 p-2.5">
            <div className="min-w-0 break-words text-sm font-medium">{primary.render(r)}</div>
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
              {rest.map((c) => (
                <div key={c.key} className="flex min-w-0 justify-between gap-2">
                  <dt className="truncate text-muted-foreground">{c.label}</dt>
                  <dd className="shrink-0 tabular-nums">{c.render(r)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** ROAS colour: ≥ 2,5 green · ≥ 1,5 amber · below red · none muted. */
export function roasTone(v: number | null | undefined): string {
  if (v == null) return 'text-muted-foreground';
  if (v >= 2.5) return 'text-emerald-700 dark:text-emerald-400';
  if (v >= 1.5) return 'text-amber-700 dark:text-amber-400';
  return 'text-red-700 dark:text-red-400';
}

/** POAS colour (profit ÷ spend): ≥ 1 green (the ads paid for themselves) · ≥ 0,6 amber · below red. */
export function poasTone(v: number | null | undefined): string {
  if (v == null) return 'text-muted-foreground';
  if (v >= 1) return 'text-emerald-700 dark:text-emerald-400';
  if (v >= 0.6) return 'text-amber-700 dark:text-amber-400';
  return 'text-red-700 dark:text-red-400';
}

/** 2.21 → "2,21×"; null → "—". */
export const xText = (v: number | null | undefined, lang = 'mk') => {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = v.toFixed(2);
  return `${lang === 'en' ? s : s.replace('.', ',')}×`;
};
