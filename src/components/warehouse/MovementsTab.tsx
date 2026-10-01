import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowDownCircle, ArrowUpCircle, ClipboardCheck, History, Loader2, RotateCcw, Truck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { apiGetProducts } from '@/lib/api';
import { apiGetStockMovementsPage, type StockMovement } from '@/lib/warehouseApi';
import { cn } from '@/lib/utils';
import { apiErrorText } from '@/i18n/apiErrors';
import { movementNote, skopjeDateTime } from './warehouseText';

const PAGE = 100;
const KNOWN = ['restock', 'order_deduction', 'manual_adjust', 'deduction', 'order_return', 'bigarena_sync', 'count', 'mex_deduct', 'mex_restock', 'mex_reverse'];

function MovementIcon({ type }: { type: string }) {
  if (type === 'restock' || type === 'mex_restock' || type === 'order_return') return <ArrowUpCircle className="h-4 w-4 text-emerald-600" aria-hidden />;
  if (type === 'order_deduction' || type === 'mex_deduct') return <ArrowDownCircle className="h-4 w-4 text-destructive" aria-hidden />;
  if (type === 'count') return <ClipboardCheck className="h-4 w-4 text-primary" aria-hidden />;
  if (type === 'mex_reverse') return <Truck className="h-4 w-4 text-muted-foreground" aria-hidden />;
  return <RotateCcw className="h-4 w-4 text-muted-foreground" aria-hidden />;
}

/**
 * Tab "Движења" — the stock ledger, restyled only: Skopje dd.MM.yyyy HH:mm, the known
 * machine notes in the reader's language, "Вчитај повеќе" instead of a silent 200-row cap,
 * and cards below md.
 */
export function MovementsTab({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const [type, setType] = useState('');
  const [product, setProduct] = useState('');
  const products = useQuery<Array<{ id: string; name: string; is_active: boolean }>>({ queryKey: ['warehouse-products'], queryFn: () => apiGetProducts(), staleTime: 60_000 });
  const q = useInfiniteQuery({
    queryKey: ['warehouse-movements', type, product],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => apiGetStockMovementsPage({ movement_type: type || undefined, product_id: product || undefined, limit: PAGE, offset: pageParam as number }),
    getNextPageParam: (last: StockMovement[], pages) => (last.length === PAGE ? pages.length * PAGE : undefined),
    staleTime: 30_000,
  });
  const rows = useMemo(() => (q.data?.pages ?? []).flat(), [q.data]);
  const label = (ty: string) => (KNOWN.includes(ty) ? t(`wh.mv.${ty}`) : ty || t('common.unknown'));
  const kind = (m: StockMovement) => m.movement_type || m.reason || '';
  const activeProducts = (products.data ?? []).filter((p) => p.is_active);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className="min-h-9 max-w-full rounded-md border bg-background px-2 text-sm" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('wh.allTypes')}>
          <option value="">{t('wh.allTypes')}</option>
          {KNOWN.map((k) => <option key={k} value={k}>{t(`wh.mv.${k}`)}</option>)}
        </select>
        <select className="min-h-9 min-w-0 max-w-full flex-1 basis-48 rounded-md border bg-background px-2 text-sm sm:flex-none" value={product} onChange={(e) => setProduct(e.target.value)} aria-label={t('wh.allProducts')}>
          <option value="">{t('wh.allProducts')}</option>
          {activeProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <span className="ml-auto text-xs text-muted-foreground">{t('warehousePage.movements.shown', { count: rows.length })}</span>
      </div>

      {q.isError && !rows.length ? (
        <LoadError text={apiErrorText(q.error)} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<History className="h-5 w-5" />} title={t('wh.noMovements')} description={t('wh.noMovementsDesc')} size="md" />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">{t('wh.colDate')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('wh.colType')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('wh.colProduct')}</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">{t('wh.colChange')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('wh.colOldNew')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('wh.colUser')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('wh.colNotes')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((m) => (
                  <tr key={m.id} className="border-b align-top last:border-0">
                    <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted-foreground">{skopjeDateTime(m.created_at)}</td>
                    <td className="px-2 py-2"><span className="inline-flex items-center gap-1.5 text-xs"><MovementIcon type={kind(m)} />{label(kind(m))}</span></td>
                    <td className="px-2 py-2"><div className="font-medium">{m.product_name}</div>{m.product_sku && <div className="text-xs text-muted-foreground">{m.product_sku}</div>}</td>
                    <td className={cn('px-2 py-2 text-right font-semibold tabular-nums', m.change_amount > 0 ? 'text-emerald-600' : 'text-destructive')}>{m.change_amount > 0 ? '+' : ''}{m.change_amount}</td>
                    <td className="whitespace-nowrap px-2 py-2 text-xs tabular-nums text-muted-foreground">{m.previous_stock ?? '—'} → {m.new_stock ?? '—'}</td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">{m.user_name}</td>
                    <td className="max-w-[22rem] px-2 py-2 text-xs text-muted-foreground"><span className="break-words">{movementNote(t, m.notes)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 lg:hidden">
            {rows.map((m) => (
              <li key={m.id} className="space-y-1 rounded-xl border bg-card p-3 text-sm shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-xs"><MovementIcon type={kind(m)} />{label(kind(m))}</span>
                  <span className={cn('shrink-0 font-semibold tabular-nums', m.change_amount > 0 ? 'text-emerald-600' : 'text-destructive')}>{m.change_amount > 0 ? '+' : ''}{m.change_amount}</span>
                </div>
                <div className="break-words font-medium">{m.product_name}</div>
                <div className="text-xs text-muted-foreground">{skopjeDateTime(m.created_at)} · {m.previous_stock ?? '—'} → {m.new_stock ?? '—'} · {m.user_name}</div>
                <div className="break-words text-xs text-muted-foreground">{movementNote(t, m.notes)}</div>
              </li>
            ))}
          </ul>
          {q.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="outline" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage && <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />}{t('warehousePage.movements.loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
