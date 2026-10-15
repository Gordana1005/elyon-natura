import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { apiGetOriginOrders, type OriginKey, type OriginOrderRow } from '@/lib/insightsApi/originOrders';
import { LoadError } from '../shared/LoadError';
import type { DayRange } from '../shared/period';
import type { InsightsFormat } from '../shared/useInsightsFormat';
import { dm } from './useOverviewFormat';

/** Rows drawn at once; "Прикажи уште" adds the next page (a month of Teleshop Out ≈ 3.400 rows). */
const PAGE = 150;

const KIND_TONE: Record<string, string> = {
  order: 'bg-primary/10 text-primary',
  booking: 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
  mex: 'bg-sky-100 text-sky-900 dark:bg-sky-950/50 dark:text-sky-200',
  web: 'bg-orange-100 text-orange-900 dark:bg-orange-950/50 dark:text-orange-200',
};

const norm = (s: string) => s.toLocaleLowerCase('mk').replace(/\s+/g, ' ');
const digits = (s: string) => s.replace(/\D/g, '');

/** "ORD-367109" links to /orders (it IS an order); a booking / parcel / web order shows its number. */
function NumberCell({ r }: { r: OriginOrderRow }) {
  if (r.kind === 'order' && r.display_id) {
    return (
      <Link to={`/orders?search=${encodeURIComponent(r.display_id)}`} className="font-medium text-primary underline-offset-2 hover:underline">
        {r.display_id}
      </Link>
    );
  }
  return <span className="font-medium">{r.display_id ?? '—'}</span>;
}

/**
 * The orders behind an origin tile (owner 15.10.2026: "да ги покажува сите нарачки — ЦРМ + collab —
 * за да знаеме точно кои нарачки ги прават тие пари"): every row the tile adds up, newest first —
 * CRM orders (they open on /orders), collabBox documents still waiting for their parcel, MEX parcels
 * with no order, web orders — with customer, phone, seller, products, status, денари (when the
 * reader sees money) and the first contact that decided the origin. Search + CSV.
 */
export function OriginOrdersSheet({
  open, onOpenChange, source, origin, range, f,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  source: string;
  origin: OriginKey;
  range: DayRange;
  f: InsightsFormat;
}) {
  const { t } = f;
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const query = useQuery({
    queryKey: ['insights-origin-orders', source, origin, range.from, range.to],
    queryFn: () => apiGetOriginOrders({ from: range.from, to: range.to, source, origin }),
    enabled: open,
    staleTime: 2 * 60_000,
  });
  const data = query.data;
  const money = !!data?.meta.money;

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const needle = norm(q.trim());
    if (!needle) return all;
    const d = digits(needle);
    return all.filter((r) => {
      const hay = norm([r.display_id, r.tracking_id, r.customer, r.seller, r.products].filter(Boolean).join(' '));
      return hay.includes(needle) || (d.length >= 3 && digits(r.phone ?? '').includes(d));
    });
  }, [data, q]);

  const sum = rows.reduce((a, r) => a + (r.value_mkd ?? 0), 0);
  const byKind = rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.kind]: (a[r.kind] ?? 0) + 1 }), {});
  const kindLabel = (k: string) => t(`overview.cohort.origin.drill.kind.${k}`, { defaultValue: k });
  const firstText = (r: OriginOrderRow) => (r.first_src
    ? `${t(`overview.cohort.origin.drill.firstSrc.${r.first_src}`, { defaultValue: r.first_src })}${r.first_day ? ` · ${dm(r.first_day, true)}` : ''}`
    : t('overview.cohort.origin.drill.firstNone'));

  const exportCsv = () => {
    const head = ['date', 'number', 'kind', 'customer', 'phone', 'seller', 'products', 'status', ...(money ? ['value_mkd'] : []), 'first_contact'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((r) => [
      r.sale_day, r.display_id, kindLabel(r.kind), r.customer, r.phone, r.seller, r.products, f.bucketLabel(r.bucket as never),
      ...(money ? [r.value_mkd ?? ''] : []), firstText(r),
    ].map(esc).join(','));
    const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${source}-${origin}-${range.from}_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setQ(''); setShown(PAGE); } }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <SheetHeader className="space-y-1 border-b px-4 py-3 text-left sm:px-5">
          <SheetTitle className="pr-8 text-base">
            {f.sourceLabel(source as never)} · {t(`overview.cohort.origin.key.${origin}`)}
          </SheetTitle>
          <SheetDescription className="text-xs">
            {f.period(range.from, range.to)} · {t('overview.cohort.origin.drill.subtitle')}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-2 border-b px-4 py-3 sm:px-5">
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm" data-testid="origin-drill-summary">
            <b className="text-lg font-semibold tabular-nums">{f.int(rows.length)}</b>
            <span className="text-muted-foreground">{t('overview.cohort.origin.orders', { count: rows.length })}</span>
            {money && <b className="font-semibold tabular-nums">{f.den(sum)}</b>}
            <span className="text-xs text-muted-foreground">
              {Object.entries(byKind).map(([k, n]) => `${kindLabel(k)} ${f.int(n)}`).join(' · ')}
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} className="h-9 pl-8"
                placeholder={t('overview.cohort.origin.drill.search')} aria-label={t('overview.cohort.origin.drill.search')} />
            </div>
            <Button type="button" variant="outline" size="sm" className="h-9 gap-1.5" onClick={exportCsv} disabled={!rows.length}>
              <Download className="h-4 w-4" aria-hidden />{t('overview.cohort.origin.drill.export')}
            </Button>
          </div>
          {data?.meta.truncated && <p className="text-[11px] text-amber-700 dark:text-amber-300">{t('overview.cohort.origin.drill.truncated')}</p>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
          {query.isLoading ? (
            <div className="space-y-2" aria-hidden>{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-12" />)}</div>
          ) : query.isError ? (
            <LoadError text={t('overview.cohort.origin.drill.loadFailed')} onRetry={() => { void query.refetch(); }} />
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('overview.cohort.origin.drill.empty')}</p>
          ) : (
            <>
              {/* lg+: a table; below: cards (UI law — never a sideways table) */}
              <table className="hidden w-full text-xs lg:table" data-testid="origin-drill-table">
                <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr className="border-b">
                    {['date', 'number', 'customer', 'seller', 'products', 'status', ...(money ? ['value'] : []), 'first'].map((c) => (
                      <th key={c} className={cn('px-2 py-1.5 font-medium', c === 'value' && 'text-right')}>{t(`overview.cohort.origin.drill.cols.${c}`)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, shown).map((r, i) => (
                    <tr key={`${r.kind}-${r.display_id}-${i}`} className="border-b align-top last:border-0">
                      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{dm(r.sale_day, true)}</td>
                      <td className="px-2 py-1.5">
                        <NumberCell r={r} />
                        <span className={cn('mt-0.5 block w-fit rounded px-1.5 py-px text-[10px] font-medium', KIND_TONE[r.kind])}>{kindLabel(r.kind)}</span>
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="block">{r.customer ?? '—'}</span>
                        <span className="block tabular-nums text-muted-foreground">{r.phone ?? ''}</span>
                      </td>
                      <td className="px-2 py-1.5">{r.seller ?? '—'}</td>
                      <td className="max-w-[16rem] px-2 py-1.5 text-muted-foreground">{r.products ?? '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1.5">{f.bucketLabel(r.bucket as never)}</td>
                      {money && <td className="whitespace-nowrap px-2 py-1.5 text-right font-medium tabular-nums">{r.value_mkd != null ? f.den(r.value_mkd) : '—'}</td>}
                      <td className="whitespace-nowrap px-2 py-1.5 text-muted-foreground">{firstText(r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="space-y-2 lg:hidden">
                {rows.slice(0, shown).map((r, i) => (
                  <li key={`${r.kind}-${r.display_id}-${i}`} className="rounded-lg border p-2.5 text-xs">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <NumberCell r={r} />
                        <span className={cn('rounded px-1.5 py-px text-[10px] font-medium', KIND_TONE[r.kind])}>{kindLabel(r.kind)}</span>
                      </span>
                      {money && <b className="tabular-nums">{r.value_mkd != null ? f.den(r.value_mkd) : '—'}</b>}
                    </div>
                    <p className="mt-1">{r.customer ?? '—'} <span className="tabular-nums text-muted-foreground">{r.phone ?? ''}</span></p>
                    {r.products && <p className="mt-0.5 text-muted-foreground">{r.products}</p>}
                    <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      <span className="tabular-nums">{dm(r.sale_day, true)}</span>
                      <span>{f.bucketLabel(r.bucket as never)}</span>
                      {r.seller && <span>{r.seller}</span>}
                      <span>{t('overview.cohort.origin.drill.cols.first')}: {firstText(r)}</span>
                    </p>
                  </li>
                ))}
              </ul>
              {rows.length > shown && (
                <div className="pt-3 text-center">
                  <Button type="button" variant="outline" size="sm" onClick={() => setShown((n) => n + PAGE)}>
                    {t('overview.cohort.origin.drill.more', { n: f.int(Math.min(PAGE, rows.length - shown)), left: f.int(rows.length - shown) })}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
