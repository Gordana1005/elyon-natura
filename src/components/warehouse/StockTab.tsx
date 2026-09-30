import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpCircle, Loader2, Package, Search, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/EmptyState';
import { Chip } from '@/components/assigner/parts';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useToast } from '@/hooks/use-toast';
import { apiGetProducts, apiRestock, apiUpdateProduct } from '@/lib/api';
import { apiGetStockHealth } from '@/lib/stockApi';
import { formatMoney } from '@/lib/currency';
import { cn } from '@/lib/utils';
import { apiErrorText } from '@/i18n/apiErrors';
import { stockMoment } from './stockText';

const LOW_STOCK_PREVIEW = 8;

interface Product {
  id: string; name: string; sku?: string | null; category?: string | null; description?: string | null;
  price: number; cost_price?: number | null; stock_quantity: number; low_stock_threshold: number; is_active: boolean;
}

/**
 * Tab "Залихи" — the stock, restyled only (the owner deferred the stock logic, 29.09): active
 * products by default, a chip for the inactive ones, cards below md, and the low-stock
 * threshold (moved here from Settings) edited inline with a debounced save — the same
 * PATCH /products/:id Settings used (admin / manager).
 */
export function StockTab({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const { user } = useAuth();
  const { canSeeBusiness: showMoney } = usePermissions();
  const canRestock = !!(user?.isAdmin || user?.isManager || user?.isWarehouse);
  const canThreshold = !!(user?.isAdmin || user?.isManager);
  const { toast } = useToast();
  const qc = useQueryClient();
  const products = useQuery<Product[]>({ queryKey: ['warehouse-products'], queryFn: () => apiGetProducts(), staleTime: 60_000 });
  const health = useQuery({ queryKey: ['stock-health'], queryFn: () => apiGetStockHealth(true), staleTime: 60_000, retry: 0 });
  const trusted = health.data?.trusted === true;
  const cover = useMemo(() => new Map((health.data?.products ?? []).map((r) => [r.product_id, r.days_cover])), [health.data]);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [inactive, setInactive] = useState(false);
  const [lowOpen, setLowOpen] = useState(false);
  const [restock, setRestock] = useState<Product | null>(null);
  const [qty, setQty] = useState('');
  const [saving, setSaving] = useState(false);
  const [thresholds, setThresholds] = useState<Record<string, string>>({});
  const timers = useRef<Record<string, number>>({});
  useEffect(() => () => { for (const id of Object.values(timers.current)) window.clearTimeout(id); }, []);

  const all = products.data ?? [];
  const inactiveCount = all.filter((p) => !p.is_active).length;
  const categories = useMemo(() => [...new Set(all.map((p) => p.category).filter(Boolean) as string[])].sort(), [all]);
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return all.filter((p) => (inactive || p.is_active)
      && (!category || p.category === category)
      && (!s || p.name.toLowerCase().includes(s) || String(p.sku ?? '').toLowerCase().includes(s)));
  }, [all, search, category, inactive]);
  const low = all.filter((p) => p.is_active && p.stock_quantity < p.low_stock_threshold);

  const thresholdOf = (p: Product) => thresholds[p.id] ?? String(p.low_stock_threshold);
  const onThreshold = (p: Product, v: string) => {
    setThresholds((m) => ({ ...m, [p.id]: v }));
    window.clearTimeout(timers.current[p.id]);
    const n = Math.trunc(Number(v));
    if (v === '' || !Number.isFinite(n) || n < 0 || n > 100_000) return;
    timers.current[p.id] = window.setTimeout(async () => {
      try {
        await apiUpdateProduct(p.id, { low_stock_threshold: n });
        qc.setQueryData<Product[]>(['warehouse-products'], (old) => (old ?? []).map((x) => (x.id === p.id ? { ...x, low_stock_threshold: n } : x)));
        toast({ title: t('warehousePage.stock.thresholdSaved'), description: p.name });
      } catch (e) {
        toast({ title: t('warehousePage.stock.thresholdFailed'), description: apiErrorText(e), variant: 'destructive' });
      }
    }, 700);
  };

  const doRestock = async () => {
    if (!restock || !qty) return;
    setSaving(true);
    try {
      await apiRestock({ product_id: restock.id, quantity: parseInt(qty, 10) });
      toast({ title: t('wh.stockAdded'), description: t('wh.addedUnits', { count: qty, name: restock.name }) });
      setRestock(null); setQty('');
      void products.refetch();
    } catch (e) {
      toast({ title: t('common.error'), description: apiErrorText(e), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  if (products.isLoading) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden /></div>;

  const level = (p: Product) => {
    const isLow = p.stock_quantity < p.low_stock_threshold;
    const pct = p.low_stock_threshold > 0 ? Math.min((p.stock_quantity / (p.low_stock_threshold * 3)) * 100, 100) : (p.stock_quantity > 0 ? 100 : 0);
    return (
      <div className="min-w-[7rem] space-y-1">
        <span className={cn('text-sm font-semibold tabular-nums', isLow ? 'text-destructive' : 'text-foreground')}>{f.int(p.stock_quantity)}</span>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full', isLow ? 'bg-destructive' : 'bg-primary')} style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  };
  const threshold = (p: Product) => canThreshold ? (
    <Input type="number" inputMode="numeric" min={0} className="h-8 w-20 text-sm tabular-nums" value={thresholdOf(p)}
      aria-label={t('warehousePage.stock.thresholdLabel', { name: p.name })} title={t('warehousePage.stock.thresholdHint')}
      onChange={(e) => onThreshold(p, e.target.value)} />
  ) : <span className="tabular-nums text-muted-foreground">{f.int(p.low_stock_threshold)}</span>;

  return (
    <div className="space-y-3">
      {health.data && !trusted && (
        <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <ShieldAlert className="mt-px h-4 w-4 shrink-0" aria-hidden />
          <div className="space-y-0.5">
            <p className="font-semibold">{t('wh.unverifiedTitle')}</p>
            <p>{health.data.counted
              ? t(health.data.mex.enabled ? 'wh.unverifiedStale' : 'wh.unverifiedMexOff', { date: stockMoment(health.data.counted.at) })
              : t('wh.unverifiedNoCount')}</p>
          </div>
        </div>
      )}

      {low.length > 0 && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
          <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="h-4 w-4" aria-hidden />{t('wh.lowStockAlerts', { count: low.length })}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {(lowOpen ? low : low.slice(0, LOW_STOCK_PREVIEW)).map((p) => (
              <span key={p.id} className="max-w-full break-words rounded-md bg-destructive px-2 py-0.5 text-xs text-destructive-foreground">
                {p.name} — {t('wh.leftMin', { count: p.stock_quantity, min: p.low_stock_threshold })}
              </span>
            ))}
            {low.length > LOW_STOCK_PREVIEW && (
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs font-semibold text-destructive" onClick={() => setLowOpen((v) => !v)}>
                {lowOpen ? t('wh.showLessLowStock') : t('wh.showMoreLowStock', { count: low.length - LOW_STOCK_PREVIEW })}
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input placeholder={t('wh.searchProductsSku')} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" aria-label={t('wh.searchProductsSku')} />
        </div>
        {categories.length > 0 && (
          <select className="min-h-9 max-w-full rounded-md border bg-background px-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('wh.allCategories')}>
            <option value="">{t('wh.allCategories')}</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
        <Chip on={inactive} onClick={() => setInactive((v) => !v)}>{t('warehousePage.stock.showInactive', { count: inactiveCount })}</Chip>
        <span className="ml-auto text-xs text-muted-foreground">{t('wh.ofProducts', { shown: rows.length, total: inactive ? all.length : all.length - inactiveCount })}</span>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={<Package className="h-5 w-5" />} title={t('warehousePage.stock.empty')} size="md" />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-3 py-2 font-medium">{t('wh.colProduct')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('wh.colCategory')}</th>
                  {showMoney && <th scope="col" className="px-2 py-2 text-right font-medium">{t('wh.colCost')}</th>}
                  {showMoney && <th scope="col" className="px-2 py-2 text-right font-medium">{t('wh.colPrice')}</th>}
                  <th scope="col" className="px-2 py-2 font-medium">{t('warehousePage.stock.stock')}</th>
                  <th scope="col" className="px-2 py-2 font-medium" title={t('warehousePage.stock.thresholdHint')}>{t('warehousePage.stock.threshold')}</th>
                  {trusted && <th scope="col" className="px-2 py-2 text-right font-medium">{t('wh.colCover')}</th>}
                  {inactive && <th scope="col" className="px-2 py-2 font-medium">{t('wh.colStatus')}</th>}
                  {canRestock && <th scope="col" className="px-2 py-2"><span className="sr-only">{t('wh.colActions')}</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={cn('border-b last:border-0', p.stock_quantity < p.low_stock_threshold && p.is_active && 'bg-destructive/5', !p.is_active && 'text-muted-foreground')}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{p.name}</div>
                      {p.sku && <div className="text-xs text-muted-foreground">{p.sku}</div>}
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">{p.category || '—'}</td>
                    {showMoney && <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatMoney(p.cost_price || 0)}</td>}
                    {showMoney && <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{formatMoney(p.price)}</td>}
                    <td className="px-2 py-2">{level(p)}</td>
                    <td className="px-2 py-2">{threshold(p)}</td>
                    {trusted && <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{cover.get(p.id) != null ? t('wh.coverDays', { n: cover.get(p.id) }) : '—'}</td>}
                    {inactive && <td className="px-2 py-2 text-xs">{p.is_active ? t('wh.active') : t('wh.disabled')}</td>}
                    {canRestock && (
                      <td className="px-2 py-2 text-right">
                        <Button variant="outline" size="sm" onClick={() => { setRestock(p); setQty(''); }}>
                          <ArrowUpCircle className="mr-1 h-3.5 w-3.5" aria-hidden />{t('wh.restock')}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 lg:hidden">
            {rows.map((p) => (
              <li key={p.id} className={cn('space-y-2 rounded-xl border bg-card p-3 shadow-sm', p.stock_quantity < p.low_stock_threshold && p.is_active && 'border-destructive/40')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="break-words font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">{[p.sku, p.category].filter(Boolean).join(' · ') || '—'}{!p.is_active ? ` · ${t('wh.disabled')}` : ''}</div>
                  </div>
                  {canRestock && (
                    <Button variant="outline" size="sm" className="shrink-0" onClick={() => { setRestock(p); setQty(''); }}>
                      <ArrowUpCircle className="mr-1 h-3.5 w-3.5" aria-hidden />{t('wh.restock')}
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                  {level(p)}
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">{t('warehousePage.stock.threshold')} {threshold(p)}</label>
                  {trusted && cover.get(p.id) != null && <span className="text-xs text-muted-foreground">{t('wh.coverDays', { n: cover.get(p.id) })}</span>}
                  {showMoney && <span className="text-xs tabular-nums">{formatMoney(p.price)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog open={!!restock} onOpenChange={(o) => { if (!o) setRestock(null); }}>
        <DialogContent className="w-[calc(100%-1rem)] max-w-md">
          <DialogHeader><DialogTitle>{t('wh.restockTitle', { name: restock?.name })}</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">{t('wh.currentStock', { count: restock?.stock_quantity ?? 0 })}</p>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>{t('wh.qtyToAdd')}</span>
            <Input type="number" inputMode="numeric" min={1} value={qty} onChange={(e) => setQty(e.target.value)} placeholder={t('wh.enterQty')} autoFocus />
          </label>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRestock(null)}>{t('common.cancel')}</Button>
            <Button onClick={() => void doRestock()} disabled={saving || !qty}>{saving ? t('wh.adding') : t('wh.addStock')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
