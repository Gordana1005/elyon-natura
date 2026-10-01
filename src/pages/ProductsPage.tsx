import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, History, Loader2, Package, Plus } from 'lucide-react';
import { AppLayout } from '@/layouts/AppLayout';
import { apiErrorText } from '@/i18n/apiErrors';
import { formatDate } from '@/i18n/dates';
import {
  apiGetInventoryLogs, apiGetProductCatalogue, apiGetSuppliers, apiSetBrandLine, apiSetProductKind, apiSetProductVatRate, apiUpdateProduct,
} from '@/lib/api';
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
  LINE_NAMES, applyLineChanges, isLineFilter, type BrandLine, type LineFilter, type SetBrandLineResult,
} from '@/lib/products/brandLines';
import {
  DEFAULT_KIND_FILTER, PAGE_SIZE, applyKindChanges, byName, facetCounts, filterCatalogue, indexRows, isKindFilter,
  isStatusFilter, type KindFilter, type ProductKind, type SetKindResult, type StatusFilter,
} from '@/lib/products/kinds';
import { applyVatChanges, isVatFilter, ratePct, type SetVatResult, type VatFilter, type VatRate } from '@/lib/products/vat';
import { ProductsList, type ProductRow, type RowHandlers } from '@/components/products/ProductsList';
import { BulkBar, ProductFilters } from '@/components/products/ProductFilters';
import { BrandLineProposal } from '@/components/products/BrandLineProposal';
import { KindProposal } from '@/components/products/KindProposal';
import { ProductFormDialog } from '@/components/products/ProductFormDialog';
import { useKindLabel } from '@/components/products/KindChip';

interface InventoryLog {
  id: string;
  change_amount: number;
  previous_stock: number;
  new_stock: number;
  reason: string;
  created_at: string;
}

type View = 'list' | 'proposal';
type ProposalOf = 'kind' | 'line';

/**
 * Производи 2.0 (owner 01.10.2026) — the catalogue in the Insights look.
 *
 *   Производи (?view=list, the default) — opens on the ordinary PRODUCTS:
 *     search · Прикажи (?kind=, default Производи; Пакети и промоции · Подароци ·
 *     Друго · Неодредено · Сите) · Линија (?line=) · Статус (?status=), every
 *     chip with the count a click would show; a table from xl, cards below,
 *     50 rows a page + "Прикажи уште"; name, SKU, kind, line, sale price in
 *     денари, status — never a machine description. Admins + owners select
 *     rows → "Постави вид" / "Постави линија".
 *   Предлог (?view=proposal&of=kind|line, admins + owners) — the kind
 *     proposal and the brand-line proposal, accept one / accept all sure.
 *   ДДВ (owners only, 01.10.2026) — each product's VAT rate from Sigma (5 % /
 *     18 %; Некласифицирано = none yet), its source and invoice evidence on the
 *     chip, set through the audited POST /api/products/vat-rate; a ДДВ chip row
 *     (?vat=) and "Постави ДДВ" for a selection. The api sends the VAT columns to
 *     owners only (vat_visible).
 *
 * Speed (the owner: "кочи"): one lean request (GET /api/products/catalogue),
 * filtering over prepared search keys in memory, the search deferred, ONE
 * layout mounted (the old page mounted table AND cards for all 706 rows —
 * 57.000 elements), memoised rows, and local updates instead of reloading the
 * catalogue after each click. Kind and line writes are audited server-side.
 */
export default function ProductsPage() {
  const { t } = useTranslation();
  const f = useInsightsFormat();
  const { toast } = useToast();
  const { user } = useAuth();
  const { canSeeBusiness } = usePermissions();
  const kindLabel = useKindLabel();
  const canEdit = !!(user?.isAdmin || user?.isManager);
  // Cost price is sensitive — admins only (the api strips it for everyone else).
  const showCost = !!user?.isAdmin;
  // Lines and kinds are set by admins + owners (the api's gate: isAdmin || is_business_owner()).
  const canSetLine = !!user?.isAdmin || canSeeBusiness;

  const [params, setParams] = useSearchParams();
  const view: View = canSetLine && params.get('view') === 'proposal' ? 'proposal' : 'list';
  const proposalOf: ProposalOf = params.get('of') === 'line' ? 'line' : 'kind';
  const kindParam = params.get('kind');
  const kind: KindFilter = isKindFilter(kindParam) ? kindParam : DEFAULT_KIND_FILTER;
  const lineParam = params.get('line');
  const line: LineFilter = isLineFilter(lineParam) ? lineParam : 'all';
  const statusParam = params.get('status');
  // active products by default (owner 01.10.2026: the first view = the products we sell); Сите / Исклучени one click away
  const status: StatusFilter = isStatusFilter(statusParam) ? statusParam : 'active';
  const setParam = useCallback((key: string, value: string | null) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value == null) next.delete(key); else next.set(key, value);
      return next;
    }, { replace: true }), [setParams]);

  const [products, setProducts] = useState<ProductRow[]>([]);
  // the api sends the VAT columns to owners only and says so (vat_visible)
  const [vatVisible, setVatVisible] = useState(false);
  const vatParam = params.get('vat');
  const vat: VatFilter = vatVisible && isVatFilter(vatParam) ? vatParam : 'all';
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState('');
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [form, setForm] = useState<{ open: boolean; product: ProductRow | null }>({ open: false, product: null });
  const [logsProduct, setLogsProduct] = useState<ProductRow | null>(null);
  const [logs, setLogs] = useState<InventoryLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const fetchProducts = useCallback((first = false) => {
    if (first) setPhase('loading');
    apiGetProductCatalogue()
      .then((data) => { setProducts([...(data?.rows ?? [])].sort(byName)); setVatVisible(data?.vat_visible === true); setPhase('ready'); })
      .catch((err: unknown) => {
        if (first) { setLoadError(apiErrorText(err)); setPhase('error'); }
        else toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
      });
  }, [t, toast]);

  useEffect(() => {
    fetchProducts(true);
    apiGetSuppliers().then(setSuppliers).catch(() => {});
  }, [fetchProducts]);

  // Search keys are prepared once per catalogue, not per keystroke.
  const indexed = useMemo(() => indexRows(products), [products]);
  const filters = useMemo(() => ({ kind, line, status, vat, query: deferredQuery }), [kind, line, status, vat, deferredQuery]);
  const rows = useMemo(() => filterCatalogue(indexed, filters), [indexed, filters]);
  const facets = useMemo(() => facetCounts(indexed, filters), [indexed, filters]);
  const page = useMemo(() => rows.slice(0, limit), [rows, limit]);

  // A new filter starts on the first page again.
  useEffect(() => { setLimit(PAGE_SIZE); }, [kind, line, status, vat, deferredQuery]);

  // A selection only ever holds shown rows: a filter change drops the rest.
  useEffect(() => {
    setSelected((s) => {
      if (s.size === 0) return s;
      const shown = new Set(rows.map((r) => r.id));
      const next = new Set([...s].filter((id) => shown.has(id)));
      return next.size === s.size ? s : next;
    });
  }, [rows]);

  const markBusy = (ids: string[], on: boolean) =>
    setBusyIds((s) => { const n = new Set(s); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; });

  const applyLine = useCallback((res: SetBrandLineResult) => setProducts((ps) => applyLineChanges(ps, res)), []);
  const applyKind = useCallback((res: SetKindResult) => setProducts((ps) => applyKindChanges(ps, res)), []);
  const applyVat = useCallback((res: SetVatResult) => setProducts((ps) => applyVatChanges(ps, res)), []);
  const vatLabel = (r: VatRate | null) => (r === null ? t('products.vat.none') : ratePct(r));

  const handlersRef = useRef<RowHandlers>(null as unknown as RowHandlers);
  handlersRef.current = {
    onToggleSelect: (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }),
    onSetLine: async (p, l) => {
      markBusy([p.id], true);
      try {
        const res = await apiSetBrandLine([p.id], l);
        applyLine(res);
        toast({ title: t('products.line.savedTitle'), description: t('products.line.saved', { line: l ? LINE_NAMES[l] : t('products.line.none'), updated: f.int(res.updated), unchanged: f.int(res.unchanged) }) });
      } catch (err: unknown) {
        toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
      } finally { markBusy([p.id], false); }
    },
    onSetKind: async (p, k) => {
      markBusy([p.id], true);
      try {
        const res = await apiSetProductKind([p.id], k);
        applyKind(res);
        toast({ title: t('products.kind.savedTitle'), description: t('products.kind.saved', { kind: kindLabel(k), updated: f.int(res.updated), unchanged: f.int(res.unchanged) }) });
      } catch (err: unknown) {
        toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
      } finally { markBusy([p.id], false); }
    },
    onSetVat: async (p, r) => {
      markBusy([p.id], true);
      try {
        const res = await apiSetProductVatRate([p.id], r);
        applyVat(res);
        toast({ title: t('products.vat.savedTitle'), description: t('products.vat.saved', { rate: vatLabel(r), updated: f.int(res.updated), unchanged: f.int(res.unchanged) }) });
      } catch (err: unknown) {
        toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
      } finally { markBusy([p.id], false); }
    },
    onEdit: (p) => setForm({ open: true, product: p }),
    onToggleActive: async (p) => {
      try {
        await apiUpdateProduct(p.id, { is_active: !p.is_active });
        setProducts((ps) => ps.map((x) => (x.id === p.id ? { ...x, is_active: !p.is_active } : x)));
      } catch (err: unknown) {
        toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
      }
    },
    onLogs: async (p) => {
      setLogsProduct(p);
      setLogsLoading(true);
      try { setLogs(await apiGetInventoryLogs(p.id)); } catch { setLogs([]); } finally { setLogsLoading(false); }
    },
  };
  // Stable identities for the memoised rows; each call reads the latest closure.
  const handlers = useMemo<RowHandlers>(() => ({
    onToggleSelect: (id) => handlersRef.current.onToggleSelect(id),
    onSetLine: (p, l) => handlersRef.current.onSetLine(p, l),
    onSetKind: (p, k) => handlersRef.current.onSetKind(p, k),
    onSetVat: (p, r) => handlersRef.current.onSetVat(p, r),
    onEdit: (p) => handlersRef.current.onEdit(p),
    onToggleActive: (p) => handlersRef.current.onToggleActive(p),
    onLogs: (p) => handlersRef.current.onLogs(p),
  }), []);

  const selectShown = useCallback((on: boolean) => setSelected(on ? new Set(rows.map((r) => r.id)) : new Set()), [rows]);

  const bulk = async (write: (ids: string[]) => Promise<SetBrandLineResult | SetKindResult | SetVatResult>, apply: (r: never) => void, done: (updated: number, unchanged: number) => void) => {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkBusy(true);
    try {
      let updated = 0;
      let unchanged = 0;
      for (let i = 0; i < ids.length; i += 1000) {
        const res = await write(ids.slice(i, i + 1000));
        apply(res as never);
        updated += res.updated;
        unchanged += res.unchanged;
      }
      done(updated, unchanged);
      setSelected(new Set());
    } catch (err: unknown) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setBulkBusy(false);
    }
  };
  const setLineBulk = (l: BrandLine | null) => bulk((ids) => apiSetBrandLine(ids, l), applyLine as (r: never) => void, (updated, unchanged) =>
    toast({ title: t('products.line.savedTitle'), description: t('products.line.saved', { line: l ? LINE_NAMES[l] : t('products.line.none'), updated: f.int(updated), unchanged: f.int(unchanged) }) }));
  const setKindBulk = (k: ProductKind | null) => bulk((ids) => apiSetProductKind(ids, k), applyKind as (r: never) => void, (updated, unchanged) =>
    toast({ title: t('products.kind.savedTitle'), description: t('products.kind.saved', { kind: kindLabel(k), updated: f.int(updated), unchanged: f.int(unchanged) }) }));

  const setVatBulk = (r: VatRate | null) => bulk((ids) => apiSetProductVatRate(ids, r), applyVat as (x: never) => void, (updated, unchanged) =>
    toast({ title: t('products.vat.savedTitle'), description: t('products.vat.saved', { rate: vatLabel(r), updated: f.int(updated), unchanged: f.int(unchanged) }) }));

  const tabs: { key: View; label: string }[] = [
    { key: 'list', label: t('products.tabs.list') },
    ...(canSetLine ? [{ key: 'proposal' as const, label: t('products.tabs.proposal') }] : []),
  ];
  const segment = (on: boolean) => cn(
    'h-9 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:h-8',
    on ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
  );

  return (
    <AppLayout title={t('nav.products')}>
      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          {tabs.length > 1 ? (
            <div role="tablist" aria-label={t('nav.products')} className="inline-flex rounded-lg border bg-muted/40 p-0.5">
              {tabs.map((tab) => (
                <button key={tab.key} type="button" role="tab" aria-selected={view === tab.key}
                  onClick={() => setParam('view', tab.key === 'list' ? null : tab.key)} className={segment(view === tab.key)}>
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
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('products.proposalTabs.label')}</span>
              <div role="tablist" aria-label={t('products.proposalTabs.label')} className="inline-flex rounded-lg border bg-muted/40 p-0.5">
                {(['kind', 'line'] as const).map((k) => (
                  <button key={k} type="button" role="tab" aria-selected={proposalOf === k}
                    onClick={() => setParam('of', k === 'kind' ? null : k)} className={segment(proposalOf === k)}>
                    {t(`products.proposalTabs.${k}`)}
                  </button>
                ))}
              </div>
            </div>
            {proposalOf === 'kind' ? <KindProposal onChanged={applyKind} f={f} /> : <BrandLineProposal onChanged={applyLine} f={f} />}
          </div>
        ) : phase === 'error' ? (
          <LoadError text={loadError} onRetry={() => fetchProducts(true)} />
        ) : phase === 'loading' ? (
          <div className="space-y-3" aria-busy="true">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : (
          <>
            <ProductFilters
              query={query} onQuery={setQuery}
              kind={kind} onKind={(k) => setParam('kind', k === DEFAULT_KIND_FILTER ? null : k)}
              line={line} onLine={(l) => setParam('line', l === 'all' ? null : l)}
              status={status} onStatus={(s) => setParam('status', s === 'active' ? null : s)}
              showVat={vatVisible} vat={vat} onVat={(v) => setParam('vat', v === 'all' ? null : v)}
              facets={facets} shown={rows.length} total={products.length}
              canSelect={canSetLine} onSelectShown={() => selectShown(true)} f={f}
            />
            {products.length === 0 ? (
              <EmptyState icon={<Package className="h-5 w-5" />} title={t('products.noProducts')} description={t('products.noProductsDesc')} size="sm" />
            ) : rows.length === 0 ? (
              <EmptyState icon={<Package className="h-5 w-5" />} title={t('products.nothingMatches')} size="sm" />
            ) : (
              <div className="min-w-0 space-y-3" aria-busy={query !== deferredQuery}>
                <ProductsList
                  rows={page} showCost={showCost} canEdit={canEdit} canSetLine={canSetLine} showVat={vatVisible}
                  selected={selected} onSelectShown={selectShown} busyIds={busyIds} handlers={handlers}
                />
                {rows.length > page.length && (
                  <div className="flex flex-col items-center gap-1">
                    <Button variant="outline" className="h-10" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
                      <ChevronDown className="mr-1.5 h-4 w-4" aria-hidden />
                      {t('products.showMore', { n: f.int(Math.min(PAGE_SIZE, rows.length - page.length)) })}
                    </Button>
                    <span className="text-xs tabular-nums text-muted-foreground" data-testid="products-page">
                      {t('products.shownPage', { shown: f.int(page.length), total: f.int(rows.length) })}
                    </span>
                  </div>
                )}
                {canSetLine && (
                  <BulkBar count={selected.size} busy={bulkBusy} onSetLine={setLineBulk} onSetKind={setKindBulk}
                    onSetVat={vatVisible ? setVatBulk : undefined}
                    onClear={() => setSelected(new Set())} f={f} />
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
        canSetKind={canSetLine}
        canSetLine={canSetLine}
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
