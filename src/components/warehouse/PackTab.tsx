import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, PackageOpen } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { Chip, DeptDash, deptName } from '@/components/assigner/parts';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { cn, formatProductWithQuantity } from '@/lib/utils';
import { formatDenari } from '@/lib/currency';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiGetWarehouseQueue, type PackRow, type QueueOrder, type QueueResponse } from '@/lib/warehouseApi';
import { QueueFilters, QueuePager } from './QueueFilters';
import { accountName, daysBetween, groupByDay, skopjeDate } from './warehouseText';

const PAGE = 100;

/**
 * Tab 2 — "За пакување": every parcel at MEX 8 "Shipment created" — created, waiting for
 * the courier — from both accounts, the CRM's own pushes, the collabBox-booked ones and the
 * MEX-only ones (no CRM order). Read-only, grouped by the Skopje day with its age: the labels
 * and the packing slip come from the MEX portal (owner 30.09.2026 — no printing here).
 */
export function PackTab({ f, staleCount, staleDays }: { f: InsightsFormat; staleCount: number; staleDays: number }) {
  const { t } = f;
  const [departments, setDepartments] = useState<string[]>([]);
  const [order, setOrder] = useState<QueueOrder>('oldest');
  const [offset, setOffset] = useState(0);
  const [stale, setStale] = useState(false);
  const tab = stale ? 'pack_stale' : 'pack';

  const q = useQuery<QueueResponse<PackRow>>({
    queryKey: ['warehouse-queue', tab, departments, order, offset],
    queryFn: () => apiGetWarehouseQueue<PackRow>({ tab, departments, order, limit: PAGE, offset }),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  useEffect(() => { setOffset(0); }, [departments, order, stale]);

  const data = q.data;
  const money = !!data?.money;
  const groups = useMemo(() => groupByDay(data?.rows ?? []), [data]);
  const now = new Date();

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('warehousePage.pack.desc')}</p>
      <QueueFilters departments={departments} onDepartments={setDepartments} order={order} onOrder={setOrder}
        byDepartment={stale ? undefined : data?.counts.pack_by_department} f={f}
        right={
          <Chip on={stale} onClick={() => setStale((s) => !s)}>
            {stale ? t('warehousePage.pack.showFresh', { days: staleDays }) : t('warehousePage.pack.showStale', { count: staleCount, days: staleDays })}
          </Chip>
        } />
      {stale && <p className="text-xs text-amber-800 dark:text-amber-300">{t('warehousePage.pack.staleNote', { days: staleDays })}</p>}

      {q.isError && !data ? (
        <LoadError text={apiErrorText(q.error)} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden /></div>
      ) : groups.length === 0 ? (
        <EmptyState icon={<PackageOpen className="h-5 w-5" />} title={t('warehousePage.pack.empty')} size="md" />
      ) : (
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.day ?? 'none'} aria-label={skopjeDate(g.day)} className="space-y-2">
              <h3 className="text-sm font-semibold">
                {t('warehousePage.pack.day', { date: skopjeDate(g.day ? `${g.day}T12:00:00Z` : null), count: g.rows.length })}
                <span className="ml-2 text-xs font-normal text-muted-foreground">{age(t, daysBetween(g.rows[0].created_at, now))}</span>
              </h3>
              {/* xl and up: a table — fixed columns, so every day lines up */}
              <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm xl:block">
                <table className="w-full table-fixed text-sm">
                  <colgroup>
                    <col className="w-[11.5rem]" /><col className="w-[7rem]" /><col className="w-[10rem]" /><col />
                    {money && <col className="w-[6.5rem]" />}<col className="w-[8.5rem]" />
                  </colgroup>
                  <thead>
                    <tr className="border-b bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="px-3 py-2 font-medium">{t('warehousePage.pack.col.tracking')}</th>
                      <th scope="col" className="px-2 py-2 font-medium">{t('warehousePage.pack.col.order')}</th>
                      <th scope="col" className="px-2 py-2 font-medium">{t('warehousePage.pack.col.receiver')}</th>
                      <th scope="col" className="px-2 py-2 font-medium">{t('warehousePage.pack.col.products')}</th>
                      {money && <th scope="col" className="px-2 py-2 text-right font-medium">{t('warehousePage.pack.col.cod')}</th>}
                      <th scope="col" className="px-2 py-2 font-medium">{t('warehousePage.pack.col.department')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r) => (
                      <tr key={r.tracking_id} className="border-b align-top last:border-0">
                        <td className="px-3 py-2"><Tracking r={r} f={f} /></td>
                        <td className="px-2 py-2"><OrderRef r={r} f={f} /></td>
                        <td className="px-2 py-2 text-xs">
                          <div className="font-medium">{r.customer_name || r.receiver_name || '—'}</div>
                          <div className="text-muted-foreground">{r.receiver_city || '—'}</div>
                        </td>
                        <td className="max-w-[18rem] px-2 py-2 text-xs"><Items r={r} /></td>
                        {money && <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{r.cod_mkd != null ? formatDenari(r.cod_mkd) : '—'}</td>}
                        <td className="px-2 py-2 text-xs"><span className="inline-flex items-center gap-1"><DeptDash dept={r.department} />{deptName(t, r.department)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* below xl: cards */}
              <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:hidden">
                {g.rows.map((r) => (
                  <li key={r.tracking_id} className="space-y-1 rounded-xl border bg-card p-3 text-sm shadow-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <Tracking r={r} f={f} />
                      {money && r.cod_mkd != null && <span className="font-semibold tabular-nums">{formatDenari(r.cod_mkd)}</span>}
                    </div>
                    <OrderRef r={r} f={f} />
                    <div className="text-xs"><span className="font-medium">{r.customer_name || r.receiver_name || '—'}</span>
                      <span className="ml-1.5 text-muted-foreground">{r.receiver_city}</span></div>
                    <div className="text-xs"><Items r={r} /></div>
                    <div className="text-xs"><span className="inline-flex items-center gap-1"><DeptDash dept={r.department} />{deptName(t, r.department)}</span></div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <QueuePager offset={offset} limit={PAGE} total={data?.total ?? 0} onOffset={setOffset} f={f} />
        </div>
      )}
    </div>
  );
}

function age(t: InsightsFormat['t'], days: number | null) {
  if (days == null) return '';
  return days <= 0 ? t('warehousePage.pack.ageToday') : t('warehousePage.pack.age', { count: days });
}

function Tracking({ r, f }: { r: PackRow; f: InsightsFormat }) {
  const { t } = f;
  return (
    <div className="min-w-0">
      <div className="whitespace-nowrap font-mono text-xs font-semibold">{r.tracking_id}</div>
      <div className="flex flex-wrap gap-1 text-[11px] text-muted-foreground">
        <span className={cn('rounded border px-1', r.account === 'bio_natural' ? 'border-emerald-300 text-emerald-800 dark:text-emerald-300' : 'border-sky-300 text-sky-800 dark:text-sky-300')}>
          {accountName(r.account)}
        </span>
        {r.link_method === 'push' && <span className="rounded bg-primary/10 px-1 text-primary">{t('warehousePage.pack.pushed')}</span>}
      </div>
    </div>
  );
}

function OrderRef({ r, f }: { r: PackRow; f: InsightsFormat }) {
  const { t } = f;
  if (!r.order_id) return <span className="text-xs italic text-muted-foreground">{t('warehousePage.pack.mexOnly')}</span>;
  return (
    <div className="text-xs">
      <div className="whitespace-nowrap font-semibold">{r.display_id}</div>
      {r.order_status && <span className="text-muted-foreground">{t(`status.${r.order_status}`, { defaultValue: r.order_status })}</span>}
    </div>
  );
}

function Items({ r }: { r: PackRow }) {
  if (!r.items?.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="break-words">
      {r.items.map((i, idx) => <span key={idx}>{idx > 0 && ', '}{formatProductWithQuantity(i.product_name ?? '—', i.quantity ?? 1)}</span>)}
    </span>
  );
}
