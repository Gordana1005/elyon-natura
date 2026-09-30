import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { History, Loader2, Package, Plus } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { apiErrorText } from '@/i18n/apiErrors';
import { formatDate } from '@/i18n/dates';
import { apiGetInventoryLogs, apiGetProducts, apiGetSuppliers, apiSetBrandLine, apiUpdateProduct } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { useInsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { cn } from '@/lib/utils';
import {
  LINE_NAMES, applyLineChanges, filterProducts, isLineFilter, lineCounts,
  type BrandLine, type LineFilter, type SetBrandLineResult,
} from '@/lib/products/brandLines';
import { ProductsList, type ProductRow } from '@/components/products/ProductsList';
import { BulkLineBar, ProductFilters } from '@/components/products/ProductFilters';
import { BrandLineProposal } from '@/components/products/BrandLineProposal';
import { ProductFormDialog } from '@/components/products/ProductFormDialog';

interface InventoryLog {
  id: string;
  change_amount: number;
  previous_stock: number;
  new_stock: number;
  reason: string;
  created_at: string;
}

type View = 'list' | 'proposal';

/**
 * Производи: the catalogue in the Insights look, and every product's BRAND LINE
 * (plan 30.09.2026, "Фаза 4"; migration 20260943001300). Owner ruling 30.09:
 * the line decides the MEX account when the CRM ships — Bio Natural and
 * Dr.Becker via BIO NATURAL, Natura Therapy and Ad Astra via NATURA.
 *
 *   Производи (?view=list, the default) — search, the line chips (Сите ·
 *     Natura Therapy · Bio Natural · Ad Astra · Dr.Becker · Неодредено, ?line=),
 *     a table from xl / cards below, a line chip on every product, and for
 *     admins + owners: select rows → "Постави линија".
 *   Предлог (?view=proposal, admins + owners) — the suggestion from the MEX
 *     parcels, accept one, accept all ≥ 90 %, or pick a line per row.
 *
 * Every line write goes through POST /api/products/brand-line (audited). Add /
 * edit / enable / disable and the inventory log work as before (admins and
 * managers; cost admins only). Stock is deferred by the owner — nothing added.
 */
export default function ProductsPage() {
  const { t } = useTranslation();
  const f = useInsightsFormat();
  const { toast } = useToast();
  const { user } = useAuth();
  const { canSeeBusiness } = usePermissions();
  const canEdit = !!(user?.isAdmin || user?.isManager);
  // Cost price is sensitive — admins only. Managers edit products but never see cost.
  const showCost = !!user?.isAdmin;
  // Lines are set by admins + owners (the api's gate: isAdmin || is_business_owner()).
  const canSetLine = !!user?.isAdmin || canSeeBusiness;

  const [params, setParams] = useSearchParams();
  const view: View = canSetLine && params.get('view') === 'proposal' ? 'proposal' : 'list';
  const lineParam = params.get('line');
  const line: LineFilter = isLineFilter(lineParam) ? lineParam : 'all';
  const setParam = (key: string, value: string | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value == null) next.delete(key); else next.set(key, value);
      return next;
    }, { replace: true });

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [form, setForm] = useState<{ open: boolean; product: ProductRow | null }>({ open: false, product: null });
  const [logsProduct, setLogsProduct] = useState<ProductRow | null>(null);
  const [logs, setLogs] = useState<InventoryLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const fetchProducts = useCallback((first = false) => {
    if (first) setPhase('loading');
    apiGetProducts()
      .then((data: ProductRow[]) => { setProducts(data ?? []); setPhase('ready'); })
      .catch((err: unknown) => {
        if (first) { setLoadError(apiErrorText(err)); setPhase('error'); }
        else toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
      });
  }, [t, toast]);

  useEffect(() => {
    fetchProducts(true);
    apiGetSuppliers().then(setSuppliers).catch(() => {});
  }, [fetchProducts]);

  const counts = useMemo(() => lineCounts(products), [products]);
  const rows = useMemo(() => filterProducts(products, { line, query }), [products, line, query]);

  // A selection only ever holds shown rows: a filter change drops the rest.
  useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      const shown = new Set(rows.map((r) => r.id));
      const next = new Set([...s].filter((id) => shown.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [rows]);

  const toggleSelect = (id: string) =>
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const selectShown = (on: boolean) => setSelected(on ? new Set(rows.map((r) => r.id)) : new Set());

  const applyResult = (res: SetBrandLineResult) => setProducts((ps) => applyLineChanges(ps, res));

  const savedToast = (res: SetBrandLineResult, l: BrandLine | null) => toast({
    title: t('products.line.savedTitle'),
    description: t('products.line.saved', {
      line: l ? LINE_NAMES[l] : t('products.line.none'), updated: f.int(res.updated), unchanged: f.int(res.unchanged),
    }),
  });

  const setLine = async (p: ProductRow, l: BrandLine | null) => {
    setBusyIds((s) => new Set([...s, p.id]));
    try {
      const res = await apiSetBrandLine([p.id], l);
      applyResult(res);
      savedToast(res, l);
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setBusyIds((s) => { const n = new Set(s); n.delete(p.id); return n; });
    }
  };

  const setLineBulk = async (l: BrandLine | null) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      // The api takes 1.000 per call; the catalogue is ~700.
      let updated = 0;
      let unchanged = 0;
      for (let i = 0; i < ids.length; i += 1000) {
        const res = await apiSetBrandLine(ids.slice(i, i + 1000), l);
        applyResult(res);
        updated += res.updated;
        unchanged += res.unchanged;
      }
      savedToast({ updated, unchanged } as SetBrandLineResult, l);
      setSelected(new Set());
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setBulkBusy(false);
    }
  };

  const toggleActive = async (p: ProductRow) => {
    try {
      await apiUpdateProduct(p.id, { is_active: !p.is_active });
      fetchProducts();
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  const openLogs = async (p: ProductRow) => {
    setLogsProduct(p);
    setLogsLoading(true);
    try {
      setLogs(await apiGetInventoryLogs(p.id));
    } catch { setLogs([]); }
    finally { setLogsLoading(false); }
  };

  const tabs: { key: View; label: string }[] = [
    { key: 'list', label: t('products.tabs.list') },
    ...(canSetLine ? [{ key: 'proposal' as const, label: t('products.tabs.proposal') }] : []),
  ];

  return (
    <AppLayout title={t('nav.products')}>
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {tabs.length > 1 ? (
            <div role="tablist" aria-label={t('nav.products')} className="inline-flex rounded-lg border bg-muted/40 p-0.5">
              {tabs.map((tab) => (
                <button key={tab.key} type="button" role="tab" aria-selected={view === tab.key}
                  onClick={() => setParam('view', tab.key === 'list' ? null : tab.key)}
                  className={cn(
                    'h-9 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-8',
                    view === tab.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}>
                  {tab.label}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('products.nProducts', { count: products.length })}</p>
          )}
          {canEdit && view === 'list' && (
            <Button onClick={() => setForm({ open: true, product: null })} className="h-9">
              <Plus className="mr-1.5 h-4 w-4" aria-hidden />{t('products.addProduct')}
            </Button>
          )}
        </div>

        {view === 'proposal' ? (
          <BrandLineProposal onChanged={applyResult} f={f} />
        ) : phase === 'error' ? (
          <LoadError text={loadError} onRetry={() => fetchProducts(true)} />
        ) : phase === 'loading' ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : (
          <>
            <ProductFilters
              query={query} onQuery={setQuery}
              line={line} onLine={(l) => setParam('line', l === 'all' ? null : l)}
              counts={counts} shown={rows.length} total={products.length}
              canSelect={canSetLine} onSelectShown={() => selectShown(true)} f={f}
            />
            {products.length === 0 ? (
              <EmptyState icon={<Package className="h-5 w-5" />} title={t('products.noProducts')} description={t('products.noProductsDesc')} size="sm" />
            ) : rows.length === 0 ? (
              <EmptyState icon={<Package className="h-5 w-5" />} title={t('products.nothingMatches')} size="sm" />
            ) : (
              <div className="min-w-0 space-y-3">
                <ProductsList
                  rows={rows} showCost={showCost} canEdit={canEdit} canSetLine={canSetLine}
                  selected={selected} onToggleSelect={toggleSelect} onSelectShown={selectShown}
                  busyIds={busyIds} onSetLine={setLine}
                  onEdit={(p) => setForm({ open: true, product: p })}
                  onToggleActive={toggleActive} onLogs={openLogs}
                />
                {canSetLine && (
                  <BulkLineBar count={selected.size} busy={bulkBusy} onSet={setLineBulk} onClear={() => setSelected(new Set())} f={f} />
                )}
              </div>
            )}
          </>
        )}
      </div>

      <ProductFormDialog
        open={form.open}
        onOpenChange={(open) => setForm((s) => ({ ...s, open }))}
        product={form.product}
        suppliers={suppliers}
        showCost={showCost}
        onSaved={() => fetchProducts()}
      />

      {/* Inventory log */}
      <Dialog open={!!logsProduct} onOpenChange={(open) => !open && setLogsProduct(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle className="break-words pr-6">{t('products.inventoryLogsOf', { name: logsProduct?.name ?? '' })}</DialogTitle></DialogHeader>
          {logsLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
          ) : logs.length === 0 ? (
            <EmptyState icon={<History className="h-5 w-5" />} title={t('products.noInventoryChanges')} size="sm" className="border-0 bg-transparent" />
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {logs.map((log) => (
                <div key={log.id} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className={`font-semibold ${log.change_amount > 0 ? 'text-emerald-600' : 'text-destructive'}`}>
                      {log.change_amount > 0 ? '+' : ''}{log.change_amount}
                    </span>
                    <span className="ml-2 text-muted-foreground">{log.previous_stock} → {log.new_stock}</span>
                  </div>
                  <div className="min-w-0 text-right">
                    <Badge variant="secondary" className="max-w-full truncate text-xs">{log.reason}</Badge>
                    <p className="mt-0.5 text-xs text-muted-foreground">{formatDate(log.created_at, 'dd.MM.yyyy HH:mm')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
