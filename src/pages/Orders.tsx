import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/layouts/AppLayout';
import { orderReasonText as sharedOrderReasonText } from '@/lib/orderReason';
import { SmartPagination } from '@/components/SmartPagination';
import { statusLabel, OrderStatus } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn, formatProductWithQuantity, buildProductNameLookups, isSyntheticProductName } from '@/lib/utils';
import { format, addDays } from 'date-fns'; // raw format: fulfilment CSV + machine payloads only
import { formatDate, formatDayDmy } from '@/i18n/dates';
import { apiErrorText } from '@/i18n/apiErrors';
import { planExportWindow, clampPageRange, estimateExportRows } from '@/lib/exportPageRange';
import {
  Download, Filter, Search, Loader2, CalendarIcon, X, Plus, History, Lock, Copy, CopyPlus, Package, Send,
  ChevronDown, ChevronLeft, ChevronRight, ListCollapse, Truck, Trash2, Ban,
} from 'lucide-react';
import {
  apiGetOrders, apiGetOrderViewCounts, apiGetOrderSellers, apiGetAgents, apiGetProducts, apiBulkStatusUpdate,
  apiBulkDisposition, apiDuplicateOrder, apiPushOrderAltercpa, apiGetAppSettings, apiGetCpaAttributionDimensions,
  type AltercpaPushPreview, type CpaAttributionDimensions, type TrashReason, type CancellationReason,
} from '@/lib/api';
import { sourceLabel, affiliateLabel, offerLabel, departmentLabel, creditName } from '@/lib/orderSource';
import { useWebmasterNames } from '@/hooks/useWebmasterNames';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
// The SAME reason pickers the Calls page and both order modals use — a bulk
// path must never grow its own reason list, or the two drift and the cancel
// insights stop adding up.
import { TrashReasonPicker } from '@/components/TrashReasonPicker';
import { CancellationReasonPicker } from '@/components/CancellationReasonPicker';
import { isTrashSelectionValid } from '@/lib/trashReasons';
import { isCancelSelectionValid } from '@/lib/cancellationReasons';
import { Checkbox } from '@/components/ui/checkbox';
import { formatMoney, formatDenari, codFor } from '@/lib/currency';
import { toCsv, downloadCsv } from '@/lib/csv';
import { buildMexImportColumns } from '@/lib/mexImportCsv';
import { validateOrderForFulfilment } from '@/lib/fulfilmentValidation';
import { FulfilmentValidationDialog, type InvalidOrder } from '@/components/FulfilmentValidationDialog';
import { useQuery } from '@tanstack/react-query';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { OrderModal, OrderModalData } from '@/components/OrderModal';
import { CreateOrderModal } from '@/components/CreateOrderModal';
import { CustomerHistoryDialog } from '@/components/CustomerHistoryDialog';
import { OrderCallsPanel } from '@/components/OrderCallsPanel';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { EmptyState } from '@/components/EmptyState';
// Drill-down from Insights → Overview: /orders?sale_source=…&outcome=…&created_from=…
import { parseDrillParams, DRILL_LABEL_PARAM } from '@/components/insights/overview/model';
import { OrdersDrillBanner } from '@/components/insights/overview/OrdersDrillBanner';
import { OVERVIEW_COLOR_VARS } from '@/components/insights/overview/palette';
import { periodText, skopjeToday, stepRange } from '@/components/insights/shared/period';
import { skopjeTodayLocal } from '@/lib/skopjeTime';
import { ResponsivePager } from '@/components/assigner/parts';
import {
  activeFilterCount, clearDrillParams, clearListParams, effectiveRange, effectiveView, phoneLast8, readListParams,
  toApiParams, writeListParams, type ListPatch,
} from '@/lib/ordersList/listParams';
import { fmtCount, skopjeDayTime } from '@/lib/ordersList/rowModel';
import { OrderViewChips, OrdersFilterFields, ActiveFilterChips, type FilterSources } from '@/components/orders/OrdersFilters';
import { OrdersList, MexBadge, DeptLine, type RowAction } from '@/components/orders/OrdersList';
import { useActiveViews } from '@/components/orders/useActiveViews';
import type { ApiOrder } from '@/components/orders/types';

const PAGE_SIZE = 20;

// Browser-side XLSX generation has to hold every row in memory and serialise it
// on the main thread, so "Export view" is bounded. Well past any real reporting
// need (a whole filtered year of Shipped is a few thousand rows), and the
// operator is TOLD when the cap bites rather than quietly receiving a short
// file — which is the bug this whole export change exists to fix.
const EXPORT_ROW_CAP = 20000;

/** How long the URL trails the last keystroke in the search box. */
const SEARCH_DELAY_MS = 350;

// Statuses whose expanded row shows the Delivery Details section; the inline
// Calls panel sits beside it there, and stands alone for every other status.
const DELIVERY_STATUSES = ['confirmed', 'shipped', 'delivered', 'paid', 'returned'];

/** The MEX profile a parcel was sent on (reference_mex_two_accounts). */
const MEX_ACCOUNT_LABEL: Record<string, string> = { bio_natural: 'BIO NATURAL', natura: 'NATURA' };

// The CPA push preview's unit price is in the LEAD's own currency (the api
// computes it for AlterCPA). Денари when it is mkd — every lead that reaches
// orders today — shown with formatDenari, never ×61.5 again; another
// currency keeps its own code; an older api without the currency: as sent.
function cpaBaseText(base: string | undefined, currency: string | undefined): string | undefined {
  if (base === undefined || base === '') return base;
  const cur = (currency || '').toLowerCase();
  if (cur === 'mkd') return formatDenari(base);
  return cur ? `${base} ${cur.toUpperCase()}` : base;
}

function orderToModalData(order: ApiOrder): OrderModalData {
  return {
    id: order.id,
    displayId: order.display_id,
    name: order.customer_name,
    telephone: order.customer_phone,
    address: order.customer_address,
    city: order.customer_city,
    postalCode: order.postal_code || '',
    product: order.product_name,
    status: order.status,
    notes: order.notes || null,
    quantity: order.quantity,
    price: order.price,
    assigned_agent_id: order.assigned_agent_id,
    items: (order.order_items || []).map((i: any) => ({
      id: i.id,
      product_id: i.product_id,
      product_name: i.product_name,
      quantity: i.quantity,
      price_per_unit: i.price_per_unit,
      total_price: i.total_price,
    })),
  };
}

/**
 * Нарачки — every order, in the Insights look (Phase 11 A, 01.10.2026).
 *
 * Opens on "Нарачки" (confirmed · packed · shipped · paid · returned) for
 * TODAY (Skopje), with ← / → by day (owner 01.10.2026); leads, cancels and trash are their own chips, each with
 * its count, and "Сите" is their sum. Everything that narrows the list lives in
 * the URL (lib/ordersList/listParams.ts) and is applied by the api
 * (supabase/functions/api/ordersList.ts): department, seller, MEX status,
 * source, assignee, price, CPA provenance, the period. A phone in the search
 * box matches by its last 8 digits. An Insights drill-down or a ?search= link
 * lists every status and date unless the URL says otherwise.
 *
 * A table from md (columns join as the screen widens), compact cards below; a
 * row opens the order. Bulk trash / cancel, the CPA push, the MEX import CSV
 * and "Export view" work on the ticked rows / the current filters as before.
 */
export default function Orders() {
  const { t } = useTranslation(); // also subscribes status chips/labels to language switches
  const { user } = useAuth();
  const { canAction, canSeePrivacy } = usePermissions();
  // Roles without orders-edit permission (e.g. investor managers) open orders
  // read-only. The server also rejects their mutations — this just hides the controls.
  const canEditOrders = canAction('orders', 'edit');
  // Inline Calls panel on expanded rows — recording-permission roles only.
  const showCallsPanel = canSeePrivacy('can_hear_recordings') || canSeePrivacy('can_hear_own_recordings');
  const isAdmin = !!(user?.isAdmin || user?.isManager);
  const isAgent = !isAdmin;
  // Backend gates POST /orders/bulk-status-update to admin/manager/warehouse,
  // so the "auto-mark shipped" toggle is only meaningful for those roles.
  const canBulkUpdateStatus = !!(user?.isAdmin || user?.isManager || user?.isWarehouse);

  // ── the list's state: the URL ─────────────────────────────────────────────
  const [searchParams, setSearchParams] = useSearchParams();
  const drill = useMemo(() => parseDrillParams(searchParams), [searchParams]);
  const drillKey = drill ? JSON.stringify(drill) : '';
  const drillLabel = searchParams.get(DRILL_LABEL_PARAM);
  const state = useMemo(() => readListParams(searchParams), [searchParams]);
  const today = skopjeToday();
  const ctx = useMemo(() => ({ drill: !!drill }), [drill]);
  const view = effectiveView(state, ctx);
  const period = effectiveRange(state, today, ctx);
  const page = state.page;
  const patch = useCallback(
    (p: ListPatch) => setSearchParams((prev) => writeListParams(prev, p), { replace: true }),
    [setSearchParams],
  );
  const clearDrill = () => setSearchParams((prev) => clearDrillParams(prev), { replace: true });

  // The search box answers every keystroke; the URL (and the query) follow.
  const [searchText, setSearchText] = useState(state.search);
  const writtenSearch = useRef(state.search.trim());
  useEffect(() => {
    const q = state.search.trim();
    if (q === writtenSearch.current) return;
    writtenSearch.current = q;
    setSearchText(state.search);
  }, [state.search]);
  useEffect(() => {
    const id = window.setTimeout(() => {
      const next = searchText.trim();
      if (next === writtenSearch.current) return;
      writtenSearch.current = next;
      patch({ search: next });
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [searchText, patch]);
  const searchFor = (text: string) => { writtenSearch.current = text.trim(); setSearchText(text); patch({ search: text }); };

  const apiParams = useMemo(
    () => toApiParams(state, { ...ctx, today, isAgent, userId: user?.id }),
    [state, ctx, today, isAgent, user?.id],
  );
  const listKey = JSON.stringify(apiParams) + drillKey;

  // ── "Export view" scope ───────────────────────────────────────────────────
  // The export walks the server pages itself, using the exact same filters the
  // list is showing. 'all' = every matching row; 'range' = the operator's page
  // window, numbered the same as the pager at the bottom of the screen.
  const [exportScope, setExportScope] = useState<'all' | 'range'>('all');
  // Kept as strings so the inputs can be emptied while typing; clamped on use.
  const [exportPageFrom, setExportPageFrom] = useState('1');
  const [exportPageTo, setExportPageTo] = useState('1');
  const [exportLoading, setExportLoading] = useState(false);
  // Rows fetched so far. A 20.000-row export is ~100 sequential requests; with
  // only a spinner the operator cannot tell a slow export from a hung one.
  const [exportProgress, setExportProgress] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);

  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modalOrder, setModalOrder] = useState<ApiOrder | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [historyOrder, setHistoryOrder] = useState<{ phone: string; name: string } | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const isMobile = useIsMobile();

  // Expandable rows state - supports multiple rows open at once
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Order locking
  const tryOpenOrder = async (order: ApiOrder) => {
    // Clean up expired locks first
    await supabase.rpc('cleanup_expired_order_locks');

    // Check if already locked by someone else
    const { data: existingLock } = await supabase
      .from('order_locks')
      .select('locked_by, locked_by_name, locked_at')
      .eq('order_id', order.id)
      .maybeSingle();

    if (existingLock && existingLock.locked_by !== user?.id) {
      toast({
        title: t('ordersPage.orderLocked'),
        description: t('ordersPage.lockedBy', { name: existingLock.locked_by_name || t('ordersPage.anotherUser') }),
        variant: 'destructive',
      });
      return;
    }

    // Lock the order
    if (!existingLock) {
      if (!user?.id) {
        toast({ title: t('ordersPage.notSignedIn'), variant: 'destructive' });
        return;
      }
      const { error } = await supabase.from('order_locks').insert({
        order_id: order.id,
        locked_by: user.id,
        locked_by_name: user.full_name || user.email || '',
      });
      if (error && error.code === '23505') {
        // Race condition - someone else locked it
        toast({ title: t('ordersPage.justTaken'), variant: 'destructive' });
        return;
      }
    }

    setModalOrder(order);
  };

  const handleCloseModal = async (saved?: boolean) => {
    // Release lock
    if (modalOrder && user?.id) {
      await supabase.from('order_locks').delete().eq('order_id', modalOrder.id).eq('locked_by', user.id);
    }
    setModalOrder(null);
    if (saved) refresh();
  };

  // Duplicate order (admin/manager only) — server creates a copy with the next
  // ORD number and status 'duplicated'; the source order is never touched.
  // Since 2026-08-13 the copy is a normal open order agents can settle.
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const handleDuplicateOrder = async (order: ApiOrder) => {
    if (duplicatingId) return;
    setDuplicatingId(order.id);
    try {
      const dup = await apiDuplicateOrder(order.id);
      toast({ title: t('ordersPage.duplicateCreated', { id: dup.display_id }) });
      refresh();
    } catch (e: any) {
      toast({ title: e.message || t('common.error'), variant: 'destructive' });
    } finally {
      setDuplicatingId(null);
    }
  };

  // Manual "CPA" push (admin/manager, feature-flagged). The button first fetches
  // a dry-run preview (the server-assembled payload, so the dialog cannot lie)
  // and only the explicit Confirm fires the live call.
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: apiGetAppSettings,
    enabled: isAdmin,
    staleTime: 60_000,
  });
  const cpaPushEnabled = isAdmin && appSettings?.altercpa_push_enabled === true;
  // call_again added 2026-08-19 → their status 3 Callback; the server refuses
  // it for leads AlterCPA has already moved past phase 2 (no regressions).
  const CPA_PUSHABLE = ['confirmed', 'call_again', 'shipped', 'delivered', 'paid', 'returned', 'cancelled', 'trashed'];
  const canPushCpa = (order: ApiOrder) =>
    cpaPushEnabled && order.source_type === 'altercpa' && !!order.external_order_id && CPA_PUSHABLE.includes(order.status);
  const [cpaLoadingId, setCpaLoadingId] = useState<string | null>(null);
  const [cpaPreview, setCpaPreview] = useState<{ order: ApiOrder; preview: AltercpaPushPreview } | null>(null);
  const [cpaSending, setCpaSending] = useState(false);
  const handleCpaPreview = async (order: ApiOrder) => {
    if (cpaLoadingId) return;
    setCpaLoadingId(order.id);
    try {
      const res = await apiPushOrderAltercpa(order.id, { dry_run: true, comment: sharedOrderReasonText(order) ?? undefined });
      setCpaPreview({ order, preview: res as AltercpaPushPreview });
    } catch (e: any) {
      toast({ title: e.message || t('ordersPage.cpaPushError'), variant: 'destructive' });
    } finally {
      setCpaLoadingId(null);
    }
  };
  const handleCpaConfirm = async () => {
    if (!cpaPreview || cpaSending) return;
    setCpaSending(true);
    try {
      const res: any = await apiPushOrderAltercpa(cpaPreview.order.id, { comment: sharedOrderReasonText(cpaPreview.order) ?? undefined });
      if (res.warning) {
        toast({ title: t('ordersPage.cpaPushPartial'), description: res.warning, variant: 'destructive' });
      } else {
        toast({ title: res.noop ? t('ordersPage.cpaPushNoop') : t('ordersPage.cpaPushSuccess') });
      }
      setCpaPreview(null);
    } catch (e: any) {
      toast({ title: e.message || t('ordersPage.cpaPushError'), variant: 'destructive' });
    } finally {
      setCpaSending(false);
    }
  };

  const toggleRowExpansion = (orderId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(orderId)) next.delete(orderId); else next.add(orderId);
      return next;
    });
  };

  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: apiGetAgents,
    enabled: isAdmin,
  });
  // The seller filter: sales_people (who is CREDITED with a sale).
  const { data: sellersData } = useQuery({
    queryKey: ['order-sellers'],
    queryFn: apiGetOrderSellers,
    enabled: isAdmin,
    staleTime: 300_000,
  });

  // Affiliate names. AlterCPA gives us only a numeric `wm` and has no directory
  // endpoint, so these come from altercpa_webmasters. Agents never receive the
  // ids, so the request is skipped for them entirely.
  const webmasterNames = useWebmasterNames(isAdmin);

  // The provenance dropdowns, grouped in Postgres — 80k rows must not be
  // counted in the browser.
  const { data: cpaDimensions } = useQuery<CpaAttributionDimensions>({
    queryKey: ['cpa-attribution-dimensions'],
    queryFn: apiGetCpaAttributionDimensions,
    enabled: isAdmin,
    staleTime: 300_000,
  });

  // Product catalogue → product_id:sku map, so the warehouse export can encode
  // line items as sku:quantity (order_items only carries product_id + name).
  const { data: productsData } = useQuery<any[]>({
    queryKey: ['products'],
    queryFn: apiGetProducts,
  });
  const { nameById, resolveToCleanCatalogueName } = useMemo(() => {
    return buildProductNameLookups(productsData || []);
  }, [productsData]);

  // The filter set behind the on-screen list. "Export view" re-runs the EXACT
  // same query across every page — the two can never drift apart.
  const currentFilterParams = () => ({ ...apiParams, drill: drill ?? undefined });

  // ── the page ──────────────────────────────────────────────────────────────
  const seq = useRef(0);
  const fetchOrders = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    apiGetOrders({ ...apiParams, drill: drill ?? undefined, page, limit: PAGE_SIZE })
      .then((data) => {
        if (mine !== seq.current) return; // a newer filter answered first
        setOrders(data.orders || []);
        setTotal(data.total || 0);
        setLoadError(null);
      })
      .catch((err) => {
        if (mine !== seq.current) return;
        console.error('Failed to fetch orders:', err);
        setLoadError(apiErrorText(err));
      })
      .finally(() => { if (mine === seq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, page]);
  useEffect(() => { fetchOrders(); }, [fetchOrders]);

  // One count per status chip, for the same filters (the chips' numbers).
  const { data: countsData, refetch: refetchCounts } = useQuery({
    queryKey: ['orders-view-counts', listKey],
    queryFn: () => apiGetOrderViewCounts({ ...apiParams, drill: drill ?? undefined }),
    staleTime: 30_000,
  });
  const refresh = () => { fetchOrders(); refetchCounts(); };

  // "Who is viewing" — one request for the whole page.
  const views = useActiveViews(useMemo(() => orders.map((o) => o.customer_phone), [orders]));

  // Count duplicate phones in current results
  const phoneCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of orders) {
      const p = o.customer_phone?.replace(/[^0-9+]/g, '');
      if (p && p.length >= 6) counts[p] = (counts[p] || 0) + 1;
    }
    return counts;
  }, [orders]);
  const getPhoneDupCount = (phone: string) => {
    const p = phone?.replace(/[^0-9+]/g, '');
    return p ? (phoneCounts[p] || 0) : 0;
  };

  // Resolve the product label for an order (the table cell and the card).
  // Handles real line items, clean names, and synthetic cancelled/trashed rows
  // that stash the prior product in notes. reasonFallback: on a legacy row with
  // no product of its own this falls back to the reason text; the product cell
  // prints the reason on its own line, so it passes false there.
  const productOnlyLabel = (order: any, opts?: { reasonFallback?: boolean }): string => {
    const reasonFallback = opts?.reasonFallback !== false;
    if (order.order_items && order.order_items.length > 0) {
      return order.order_items.map((i: any) => {
        const displayName = i.product_id && nameById[i.product_id] ? nameById[i.product_id] : (i.product_name || '—');
        return formatProductWithQuantity(displayName, i.quantity);
      }).join(', ');
    }
    const pn = order.product_name || '';
    if (pn && !isSyntheticProductName(pn)) {
      return formatProductWithQuantity(resolveToCleanCatalogueName(pn), order.quantity || 1);
    }
    const isOutcomeSynthetic = ['cancelled', 'trashed', 'returned', 'call_again'].includes(order.status);
    if (isOutcomeSynthetic) {
      if (reasonFallback && order.status === 'trashed' && order.trash_reason) {
        const label = t(`trashReason.${order.trash_reason}`, { defaultValue: order.trash_reason });
        const extra = (order.trash_reason_notes || '').trim();
        return extra ? `${label} — ${extra}` : label;
      }
      const note = order.cancellation_reason_notes || order.notes || '';
      const priorMatch = note.match(/(?:Original|Prior|prior)\s*product[:\s]+([^\n(]+)/i);
      if (priorMatch && priorMatch[1]) {
        return formatProductWithQuantity(resolveToCleanCatalogueName(priorMatch[1].trim()), order.quantity || 1);
      }
      const reasonNote = order.cancellation_reason_notes || order.notes;
      if (reasonFallback && reasonNote) return resolveToCleanCatalogueName(reasonNote);
      if (!reasonFallback) return '—';
    }
    return formatProductWithQuantity(resolveToCleanCatalogueName(pn), order.quantity || 1) || '—';
  };

  // Product on top, the reason (cancel / trash / return) under it — a cancel
  // list must stay scannable by product.
  const isTerminated = (order: any) =>
    order.status === 'cancelled' || order.status === 'trashed' || order.status === 'returned';
  const productCellParts = (order: any): { product: string; reason: string | null } => {
    const reason = isTerminated(order) ? sharedOrderReasonText(order) : null;
    return { product: productOnlyLabel(order, { reasonFallback: !reason }), reason };
  };
  // The rich reason panel on cancelled/trashed rows (src/lib/orderReason.ts, shared
  // with the status-badge tooltip so the two never disagree).
  const orderReasonText = (order: any): string | null =>
    sharedOrderReasonText(order) || order.notes || null;

  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Rows the current export settings would produce, shown before they click.
  const exportEstimate = useMemo(() => {
    const { pageFrom, pageTo } = clampPageRange(exportPageFrom, exportPageTo, totalPages);
    return estimateExportRows(exportScope, pageFrom, pageTo, total, PAGE_SIZE, EXPORT_ROW_CAP);
  }, [exportScope, exportPageFrom, exportPageTo, total, totalPages]);

  const filterCount = activeFilterCount(state, isAgent);
  const hasActiveFilters = !!drill || !!state.search.trim() || state.view != null || filterCount > 0;
  const clearAllFilters = () => {
    writtenSearch.current = '';
    setSearchText('');
    setSearchParams((prev) => clearListParams(prev), { replace: true });
  };

  // Daily fulfilment export — pulls orders of one status within a date range
  // (Skopje days) and writes the CSV the MEX portal imports. Independent of the
  // list's filters.
  const [fulfilFrom, setFulfilFrom] = useState<Date | undefined>(() => skopjeTodayLocal());
  const [fulfilTo, setFulfilTo] = useState<Date | undefined>(() => skopjeTodayLocal());
  const [fulfilStatus, setFulfilStatus] = useState<OrderStatus>('confirmed');
  const [fulfilLoading, setFulfilLoading] = useState(false);
  // After CSV download, flip every exported order from confirmed → shipped so
  // the warehouse hand-off is recorded in the system. Only applies when the
  // status filter is 'confirmed' — exporting other statuses doesn't auto-flip.
  const [markShippedAfterExport, setMarkShippedAfterExport] = useState(true);
  // "Ready to ship by" cutoff. Orders with a postponed ship_after_date later
  // than this are excluded from today's CSV. Defaults to today+2 ("1-2 days is
  // fine to ship immediately"). Orders with no ship_after_date always pass.
  const [readyByDate, setReadyByDate] = useState<Date | undefined>(() => addDays(skopjeTodayLocal(), 2));
  // 'range' = classic date-range dump; 'selected' = exactly the ticked orders.
  // The map stores the FULL order object so the CSV has every field even after
  // the row scrolls off-page or the filters change.
  const [fulfilSource, setFulfilSource] = useState<'range' | 'selected'>('range');
  const [selectedExport, setSelectedExport] = useState<Map<string, any>>(new Map());
  // Pending validation result when an export batch has incomplete orders.
  const [exportValidation, setExportValidation] = useState<{
    valid: any[];
    invalid: InvalidOrder[];
    ctx: { isSelected: boolean; readyByStr: string | null; heldBackPostponed: number };
  } | null>(null);
  const toggleExportSelect = (order: any) => setSelectedExport(prev => {
    const next = new Map(prev);
    if (next.has(order.id)) next.delete(order.id); else next.set(order.id, order);
    return next;
  });
  const toggleAllOnPage = () => {
    const allSel = orders.length > 0 && orders.every(o => selectedExport.has(o.id));
    setSelectedExport(prev => {
      const next = new Map(prev);
      if (allSel) orders.forEach(o => next.delete(o.id));
      else orders.forEach(o => next.set(o.id, o));
      return next;
    });
  };
  const clearExportSelect = () => setSelectedExport(new Map());

  // ── Bulk trash / cancel (rule 8: no order is junked without a reason — and, since
  // 01.10.2026, without a written note of 5+ characters: the shared validators below) ──
  const canDisposeOrders = isAdmin;
  // Mirrors DISPOSABLE in POST /orders/bulk-disposition. Anything shipped and
  // beyond belongs to the warehouse Returned flow.
  const DISPOSABLE_STATUSES = ['pending', 'take', 'call_again', 'duplicated', 'confirmed'];
  const [dispositionAction, setDispositionAction] = useState<'trashed' | 'cancelled' | null>(null);
  const [dispTrashReason, setDispTrashReason] = useState<TrashReason | null>(null);
  const [dispCancelReason, setDispCancelReason] = useState<CancellationReason | null>(null);
  const [dispNotes, setDispNotes] = useState('');
  const [dispBusy, setDispBusy] = useState(false);
  const disposableSelected = useMemo(
    () => Array.from(selectedExport.values()).filter(
      (o: any) => DISPOSABLE_STATUSES.includes(o.status) && o.status !== dispositionAction,
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedExport, dispositionAction],
  );
  const openDisposition = (action: 'trashed' | 'cancelled') => {
    setDispTrashReason(null);
    setDispCancelReason(null);
    setDispNotes('');
    setDispositionAction(action);
  };
  const dispositionValid = dispositionAction === 'trashed'
    ? isTrashSelectionValid(dispTrashReason, dispNotes)
    : isCancelSelectionValid(dispCancelReason, dispNotes);
  const runDisposition = async () => {
    if (!dispositionAction || !dispositionValid || disposableSelected.length === 0) return;
    const reason = dispositionAction === 'trashed' ? dispTrashReason! : dispCancelReason!;
    setDispBusy(true);
    try {
      const res = await apiBulkDisposition(
        disposableSelected.map((o: any) => o.id), dispositionAction, reason, dispNotes.trim() || undefined,
      );
      toast({
        title: t('ordersPage.bulkDispositionDone', { count: res.updated }),
        description: res.skipped > 0
          ? t('ordersPage.bulkDispositionSkipped', { count: res.skipped, ids: res.skipped_ids.join(', ') })
          : undefined,
      });
      setDispositionAction(null);
      clearExportSelect();
      refresh();
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setDispBusy(false);
    }
  };

  // Whether the current selection has anything that can flip → shipped.
  const selectedHasConfirmed = useMemo(
    () => Array.from(selectedExport.values()).some((o: any) => o.status === 'confirmed'),
    [selectedExport],
  );

  // Bulk Send-to-CPA (operator decision 2026-08-18): the SELECTION drives a
  // sequential client-side loop over the same single-order endpoint — one call
  // per order, so every order keeps its own payload, note, audit row and
  // read-back verification. There is still NO automatic hook.
  const [cpaBulk, setCpaBulk] = useState<{ eligible: ApiOrder[]; skipped: number } | null>(null);
  const [cpaBulkProgress, setCpaBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const cpaPushableSelected = useMemo(
    () => Array.from(selectedExport.values()).filter((o: any) => canPushCpa(o)) as ApiOrder[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedExport, cpaPushEnabled],
  );
  const runCpaBulk = async () => {
    if (!cpaBulk || cpaBulkProgress) return;
    const { eligible } = cpaBulk;
    setCpaBulkProgress({ done: 0, total: eligible.length });
    let ok = 0, noop = 0;
    const warned: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < eligible.length; i++) {
      const o = eligible[i];
      try {
        const res: any = await apiPushOrderAltercpa(o.id, { comment: sharedOrderReasonText(o) ?? undefined });
        if (res.warning) warned.push(`${o.display_id}: ${res.warning}`);
        else if (res.noop) noop++;
        else ok++;
      } catch (e: any) {
        failed.push(`${o.display_id}: ${e?.message || t('common.error')}`);
      }
      setCpaBulkProgress({ done: i + 1, total: eligible.length });
    }
    const detail = [...failed, ...warned].join('\n');
    toast({
      title: t('ordersPage.cpaBulkDone', { ok, noop, warned: warned.length, failed: failed.length }),
      ...(detail ? { description: detail } : {}),
      ...(failed.length || warned.length ? { variant: 'destructive' as const } : {}),
    });
    setCpaBulk(null);
    setCpaBulkProgress(null);
    clearExportSelect();
    refresh();
  };

  // Build the CSV from the given orders, download it, and (for the confirmed
  // bucket) flip them → shipped. Shared by the direct export and the "Export
  // valid only" path of the validation dialog, so both behave identically.
  const runFulfilmentExport = async (
    rows: any[],
    fctx: { isSelected: boolean; readyByStr: string | null; heldBackPostponed: number; heldBackInvalid: number },
  ) => {
    const { isSelected, readyByStr, heldBackPostponed, heldBackInvalid } = fctx;

    // MEX Poshta CLIENT-PORTAL import file — the 8 fixed columns their bulk
    // importer accepts (Kod na pratka … Tezina), comma-separated, no BOM, and
    // never a quoted field. The whole column contract lives in
    // src/lib/mexImportCsv.ts. This page only decides WHICH orders go in.
    const csv = toCsv(rows, buildMexImportColumns(), ',', false);

    const todayStr = skopjeToday(); // the Skopje day, whatever the computer's clock says
    const fromStr = fulfilFrom ? format(fulfilFrom, 'yyyy-MM-dd') : todayStr;
    const toStr = fulfilTo ? format(fulfilTo, 'yyyy-MM-dd') : todayStr;
    const fname = isSelected
      ? `mex_shipments_selected_${todayStr}_${rows.length}orders.csv`
      : (fromStr === toStr
        ? `mex_shipments_${fulfilStatus}_${fromStr}.csv`
        : `mex_shipments_${fulfilStatus}_${fromStr}_to_${toStr}.csv`);
    downloadCsv(fname, csv);

    // Flip confirmed → shipped after a successful download (the warehouse
    // hand-off). Held-back orders (postponed, or incomplete) never leave: they
    // stay confirmed and re-surface for a clean re-export.
    const postponedSuffix = heldBackPostponed > 0
      ? ` · ${t('ordersPage.exportPostponedPast', { n: heldBackPostponed, date: readyByStr ? readyByStr.split('-').reverse().join('.') : '' })}`
      : '';
    const invalidSuffix = heldBackInvalid > 0 ? ` · ${t('ordersPage.exportedWithHeldBack', { held: heldBackInvalid })}` : '';
    const heldBackSuffix = `${postponedSuffix}${invalidSuffix}`;
    const flipIds = (isSelected ? rows.filter(o => o.status === 'confirmed') : rows).map(o => o.id);
    const shouldFlip = markShippedAfterExport && canBulkUpdateStatus && flipIds.length > 0
      && (isSelected || fulfilStatus === 'confirmed');
    if (shouldFlip) {
      try {
        await apiBulkStatusUpdate(flipIds, 'shipped');
        toast({
          title: t('ordersPage.exportedShipped'),
          description: `${t('ordersPage.exportedShippedDesc', { count: flipIds.length, file: fname })}${heldBackSuffix}`,
        });
        if (isSelected) clearExportSelect();
        refresh();
      } catch (flipErr: any) {
        toast({
          title: t('ordersPage.exportedStatusFailed'),
          description: flipErr?.message ? apiErrorText(flipErr) : t('ordersPage.exportedStatusFailedDesc'),
          variant: 'destructive',
        });
      }
    } else {
      toast({
        title: t('ordersPage.exported'),
        description: `${t('ordersPage.exportedDesc', { count: rows.length, file: fname })}${heldBackSuffix}`,
      });
      if (isSelected) clearExportSelect();
    }
  };

  // Proceed from the validation dialog with the complete orders only; the
  // incomplete ones stay confirmed (held back) for the operator to fix.
  const handleExportValidOnly = async () => {
    const pending = exportValidation;
    if (!pending) return;
    setExportValidation(null);
    setFulfilLoading(true);
    try {
      await runFulfilmentExport(pending.valid, { ...pending.ctx, heldBackInvalid: pending.invalid.length });
    } catch (err: any) {
      toast({ title: t('ordersPage.exportFailed'), description: err?.message || t('common.unknownError'), variant: 'destructive' });
    } finally {
      setFulfilLoading(false);
    }
  };

  const exportFulfilmentCSV = async () => {
    if (fulfilLoading) return;
    const isSelected = fulfilSource === 'selected';
    if (isSelected) {
      if (selectedExport.size === 0) { toast({ title: t('ordersPage.noOrdersSelected'), description: t('ordersPage.tickFirst'), variant: 'destructive' }); return; }
    } else if (!fulfilFrom || !fulfilTo) {
      toast({ title: t('ordersPage.pickDateRange'), variant: 'destructive' });
      return;
    }
    setFulfilLoading(true);
    try {
      // Source: the ticked orders (manual), or all matching pages for the date
      // range — fulfilment dumps can be a few thousand rows. The range is in
      // Skopje days (each order by its own date), like the list.
      let all: any[] = [];
      if (isSelected) {
        all = Array.from(selectedExport.values());
      } else {
        const PAGE = 200;
        let a = format(fulfilFrom!, 'yyyy-MM-dd'), b = format(fulfilTo!, 'yyyy-MM-dd');
        if (a > b) [a, b] = [b, a];
        for (let p = 1; ; p++) {
          const data = await apiGetOrders({ status: fulfilStatus, day_from: a, day_to: b, page: p, limit: PAGE });
          const batch = data.orders || [];
          all.push(...batch);
          if (batch.length < PAGE) break;
          if (all.length >= 10000) break; // hard safety cap
        }
      }

      if (all.length === 0) {
        toast({ title: t('ordersPage.noOrders'), description: t('ordersPage.noOrdersInRange', { status: statusLabel(fulfilStatus) }) });
        return;
      }

      // The "Ready to ship by" cutoff (date-range exports only; manual picks are explicit).
      const readyByStr = (!isSelected && readyByDate) ? format(readyByDate, 'yyyy-MM-dd') : null;
      const eligible = readyByStr
        ? all.filter(o => !o.ship_after_date || String(o.ship_after_date) <= readyByStr)
        : all;
      const heldBackPostponed = all.length - eligible.length;

      if (eligible.length === 0) {
        toast({
          title: t('ordersPage.nothingReady'),
          description: t('ordersPage.allPostponed', { count: all.length, status: statusLabel(fulfilStatus), date: readyByStr }),
        });
        return;
      }

      // Pre-export validation: incomplete orders are never exported or flipped —
      // they stay confirmed and the operator fixes + re-exports them.
      const valid: any[] = [];
      const invalid: InvalidOrder[] = [];
      for (const o of eligible) {
        const res = validateOrderForFulfilment(o);
        if (res.ok) valid.push(o); else invalid.push({ order: o, missing: res.missing });
      }

      const fctx = { isSelected, readyByStr, heldBackPostponed };
      if (invalid.length > 0) {
        setExportValidation({ valid, invalid, ctx: fctx });
        return;
      }
      await runFulfilmentExport(eligible, { ...fctx, heldBackInvalid: 0 });
    } catch (err: any) {
      toast({ title: t('ordersPage.exportFailed'), description: err?.message || t('common.unknownError'), variant: 'destructive' });
    } finally {
      setFulfilLoading(false);
    }
  };

  /** Fetch every row matching the current filters, over `pageFrom..pageTo` of
   *  the on-screen pager (or all pages when `scope === 'all'`), in 200-row
   *  chunks; the loop stops on a short chunk rather than trusting `total`. */
  const fetchOrdersForExport = async (
    scope: 'all' | 'range',
    pageFrom: number,
    pageTo: number,
  ): Promise<{ rows: any[]; capped: boolean }> => {
    const params = currentFilterParams();
    const CHUNK = 200;
    const { startRow, endRow, firstChunk, offsetIntoChunk } =
      planExportWindow(scope, pageFrom, pageTo, PAGE_SIZE, CHUNK);
    const collected: any[] = [];
    let capped = false;

    for (let chunk = firstChunk; ; chunk++) {
      const data = await apiGetOrders({ ...params, page: chunk, limit: CHUNK });
      const batch = data.orders || [];
      collected.push(...batch);
      setExportProgress(Math.max(0, Math.min(collected.length - offsetIntoChunk, endRow - startRow)));
      const fetchedThrough = chunk * CHUNK;
      if (batch.length < CHUNK) break;              // ran out of matching rows
      if (fetchedThrough >= endRow) break;          // covered the page window
      if (collected.length >= EXPORT_ROW_CAP + startRow) { capped = true; break; }
    }

    let rows = collected.slice(offsetIntoChunk);
    if (endRow !== Infinity) rows = rows.slice(0, endRow - startRow);
    if (rows.length > EXPORT_ROW_CAP) { rows = rows.slice(0, EXPORT_ROW_CAP); capped = true; }
    return { rows, capped };
  };

  const exportXLSX = async () => {
    if (exportLoading) return;
    const { pageFrom: pFrom, pageTo: pTo } = clampPageRange(exportPageFrom, exportPageTo, totalPages);
    setExportLoading(true);
    setExportProgress(0);
    try {
      const { rows: sourceOrders, capped } = await fetchOrdersForExport(exportScope, pFrom, pTo);
      if (sourceOrders.length === 0) {
        toast({ title: t('ordersPage.noOrders'), description: t('ordersPage.exportNothingMatched') });
        return;
      }
      await writeOrdersXLSX(sourceOrders);
      setExportOpen(false);
      toast({
        title: t('ordersPage.exportDone'),
        description: capped
          ? t('ordersPage.exportCapped', { count: sourceOrders.length, cap: EXPORT_ROW_CAP })
          : t('ordersPage.exportRows', { count: sourceOrders.length }),
      });
    } catch (err: any) {
      toast({ title: t('ordersPage.exportFailed'), description: err?.message || t('common.unknownError'), variant: 'destructive' });
    } finally {
      setExportLoading(false);
    }
  };

  const writeOrdersXLSX = async (sourceOrders: any[]) => {
    const XLSX = await import('xlsx');
    const rows = sourceOrders.map(o => {
      const items = o.order_items && o.order_items.length > 0
        ? o.order_items.map((i: any) => formatProductWithQuantity(i.product_name, i.quantity)).join(', ')
        : formatProductWithQuantity(o.product_name, o.quantity || 1);
      return {
        'ORDER ID': o.display_id,
        'STATUS': o.status,
        'RECEIVER': o.customer_name || '',
        'PHONE': o.customer_phone || '',
        'CITY': o.customer_city || '',
        'ADDRESS': o.customer_address || '',
        // Денари, the same whole-10 figure the MEX file's Otkup carries (codFor)
        // — orders.price is stored EUR and must never reach a COD column raw.
        'COD AMOUNT (MKD)': codFor(o.price || 0).amount,
        'PRODUCT': items,
        'CONFIRMED BY': creditName(o) || '',
        'SOURCE': departmentLabel(t, o.department) || sourceLabel(t, o.source_type),
        'MEX TRACKING': o.mex_tracking_id || '',
        'MEX STATUS': o.mex_status_id != null ? t(`customer360.mexStatus.${o.mex_status_id}`, { defaultValue: String(o.mex_status_id) }) : '',
        // Empty rather than "—" for non-CPA orders: a spreadsheet column reads
        // better blank, and agents never receive these fields at all.
        'AFFILIATE': o.cpa_webmaster_id ? affiliateLabel(o.cpa_webmaster_id, webmasterNames) : '',
        'OFFER': o.cpa_offer_name || (o.cpa_offer_id ? `#${o.cpa_offer_id}` : ''),
        'PUBLISHER': o.cpa_stream_id || '',
        'DATE': formatDayDmy(o.created_at),
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Orders');
    XLSX.writeFile(wb, `orders_export_${skopjeToday()}.xlsx`);
  };

  // ── row pieces ────────────────────────────────────────────────────────────
  const rowActions = (order: ApiOrder): RowAction[] => [
    { key: 'open', label: t('ordersPage.openOrder'), icon: Lock, onClick: () => tryOpenOrder(order) },
    {
      key: 'details', label: expandedIds.has(order.id) ? t('ordersList.hideDetails') : t('ordersList.details'),
      icon: ListCollapse, onClick: () => toggleRowExpansion(order.id),
    },
    { key: 'history', label: t('ordersPage.seeHistory'), icon: History, onClick: () => setHistoryOrder({ phone: order.customer_phone, name: order.customer_name }) },
    { key: 'dups', label: t('ordersPage.viewDuplicates'), icon: Copy, onClick: () => searchFor(order.customer_phone) },
    ...(isAdmin ? [{ key: 'duplicate', label: t('ordersPage.duplicateOrder'), icon: CopyPlus, onClick: () => handleDuplicateOrder(order), disabled: duplicatingId !== null }] : []),
    ...(canPushCpa(order) ? [{ key: 'cpa', label: t('ordersPage.pushCpa'), icon: Send, onClick: () => handleCpaPreview(order), disabled: cpaLoadingId !== null }] : []),
  ];

  const renderDetails = (order: ApiOrder) => {
    const created = skopjeDayTime(order.created_at);
    return (
      <div className="border-l-4 border-primary/70 bg-background/50 px-3 py-3 text-sm md:px-5 md:py-4">
        <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="min-w-0">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t('ordersPage.customerSection')}</div>
            <div className="break-words font-medium">{order.customer_name || '—'}</div>
            <div className="break-all font-mono text-xs text-muted-foreground">{order.customer_phone}</div>
            <div className="mt-1 break-words text-xs leading-tight">
              {order.customer_address}<br />
              {order.customer_city}{order.postal_code ? `, ${order.postal_code}` : ''}
            </div>
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t('ordersPage.orderInfoSection')}</div>
            <div className="space-y-0.5 text-sm">
              <div><span className="text-muted-foreground">{t('ordersPage.created')}</span> <span className="tabular-nums">{created.day} {created.time}</span></div>
              <div><span className="text-muted-foreground">{t('ordersPage.statusField')}</span> <span className="font-medium">{statusLabel(order.status)}</span></div>
              {order.department && <div className="flex flex-wrap items-center gap-1"><DeptLine o={order} /></div>}
              {order.source_type && <div><span className="text-muted-foreground">{t('ordersPage.sourceField')}</span> {sourceLabel(t, order.source_type)}</div>}
              {order.cpa_webmaster_id && (
                <div className="break-words">
                  <span className="text-muted-foreground">{t('ordersPage.affiliateField')}</span>{' '}
                  <span className="font-medium">{affiliateLabel(order.cpa_webmaster_id, webmasterNames)}</span>
                  <span className="ml-1 text-xs text-muted-foreground">#{order.cpa_webmaster_id}</span>
                </div>
              )}
              {(order.cpa_offer_name || order.cpa_offer_id) && (
                <div className="break-words">
                  <span className="text-muted-foreground">{t('ordersPage.offerField')}</span>{' '}
                  <span className="font-medium">{offerLabel(order)}</span>
                </div>
              )}
              {order.cpa_stream_id && (
                <div className="break-all"><span className="text-muted-foreground">{t('ordersPage.publisherField')}</span> <span className="font-mono text-xs">{order.cpa_stream_id}</span></div>
              )}
              {order.ship_after_date && (
                <div><span className="text-muted-foreground">{t('ordersPage.shipAfterField')}</span> {formatDayDmy(order.ship_after_date)}</div>
              )}
            </div>
          </div>
          <div className="min-w-0">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t('ordersPage.agentSection')}</div>
            <div className="break-words">{order.assigned_agent_name || order.last_action_by || order.confirmed_by_name || '—'}</div>
            {(order.seller_name || order.confirmed_by_name) && order.assigned_agent_name !== (order.seller_name || order.confirmed_by_name) && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {t('ordersPage.salesCredit', { name: order.seller_name || order.confirmed_by_name })}
              </div>
            )}
          </div>

          {(order.status === 'cancelled' || order.status === 'trashed') && (
            <div className="border-t pt-3 sm:col-span-2 lg:col-span-3">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-rose-600">
                {order.status === 'cancelled' ? t('ordersPage.cancellationReason') : t('ordersPage.trashReason')}
              </div>
              <div className="whitespace-pre-line break-words rounded-md border border-rose-200 bg-rose-50 p-3 text-sm dark:border-rose-900 dark:bg-rose-950/30">
                {orderReasonText(order) || t('ordersPage.noReasonRecorded')}
              </div>
            </div>
          )}

          {DELIVERY_STATUSES.includes(order.status) && (
            <div className="grid grid-cols-1 gap-x-8 gap-y-3 border-t pt-3 sm:col-span-2 lg:col-span-3 lg:grid-cols-3">
              <div className="min-w-0">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600">{t('ordersPage.deliveryDetails')}</div>
                <div className="space-y-1 text-sm">
                  <div>
                    <span className="text-muted-foreground">{t('ordersPage.sentBy')}</span>{' '}
                    {order.delivery_type === 'mex_office' ? t('ordersPage.mexOffice') : t('ordersList.delivery.home')}
                    {order.courier_office_name && ` → ${order.courier_office_name}`}
                  </div>
                  {order.mex_account && (
                    <div className="text-xs text-muted-foreground">{t('ordersList.delivery.profile', { name: MEX_ACCOUNT_LABEL[order.mex_account] ?? order.mex_account })}</div>
                  )}
                  <MexBadge o={order} withTracking />
                </div>
              </div>
              {showCallsPanel && (
                <div className="min-w-0 lg:col-span-2">
                  <OrderCallsPanel orderId={order.id} />
                </div>
              )}
            </div>
          )}

          {showCallsPanel && !DELIVERY_STATUSES.includes(order.status) && (
            <div className="min-w-0 border-t pt-3 sm:col-span-2 lg:col-span-3">
              <OrderCallsPanel orderId={order.id} />
            </div>
          )}

          <div className="pt-1 sm:col-span-2 lg:col-span-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t('ordersPage.productsSection')}</div>
            {order.order_items && order.order_items.length > 0 ? (
              <div className="text-sm">
                {order.order_items.map((item: any, idx: number) => (
                  <div key={idx} className="break-words">
                    {item.product_name || '—'} × {item.quantity || 1}
                    {item.price_per_unit && ` ${t('ordersPage.each', { price: formatMoney(item.price_per_unit) })}`}
                  </div>
                ))}
              </div>
            ) : (
              <div className="break-words text-sm">{order.product_name || '—'} × {order.quantity || 1}</div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ── the filter sheet (phone) — edits a draft, "Примени" writes the URL ────
  const [draftSp, setDraftSp] = useState<URLSearchParams>(() => new URLSearchParams());
  const openSheet = () => { setDraftSp(new URLSearchParams(searchParams)); setSheetOpen(true); };
  const draft = useMemo(() => readListParams(draftSp), [draftSp]);
  const applySheet = () => { setSearchParams(writeListParams(draftSp, { page: 1 }), { replace: true }); setSheetOpen(false); };
  const resetSheet = () => setDraftSp((prev) => writeListParams(prev, {
    range: null, depts: [], seller: null, mex: [], sources: [], agent: null, mine: null,
    priceMin: null, priceMax: null, wm: null, offer: null, stream: null,
  }));

  const filterSrc: FilterSources = {
    isAdmin, isAgent,
    sellers: sellersData?.sellers,
    agents: agentsData as any,
    cpa: cpaDimensions,
    webmasterNames,
  };

  const counts = countsData?.counts;
  const periodLabel = period.days ? periodText(period.days) : t('ordersList.period.all');
  const periodPresetLabel = period.preset === 'all' ? t('ordersList.period.all') : t(`insights.common.period.${period.preset}`);
  const stepPeriod = (next: { preset: string; range: { from: string; to: string } }) =>
    patch(next.preset === 'today' ? { range: null } : { range: 'custom', from: next.range.from, to: next.range.to });
  const firstRow = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastRow = Math.min(total, page * PAGE_SIZE);
  const searchIsPhone = !!phoneLast8(searchText);

  const csvButton = (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg px-2.5 text-sm lg:px-3" aria-label={t('ordersPage.fulfilmentCsv')}>
          <Truck className="h-4 w-4 shrink-0" aria-hidden /> <span className="hidden lg:inline">{t('ordersPage.fulfilmentCsv')}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] space-y-3 p-3" align="end">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('ordersPage.dailyFulfilment')}</div>
          <p className="mb-3 text-[11px] text-muted-foreground">{t('ordersPage.fulfilmentDesc')}</p>
        </div>
        {/* Source: whole date range, or only the hand-picked orders. */}
        <div className="grid grid-cols-2 gap-1">
          <Button variant={fulfilSource === 'range' ? 'default' : 'outline'} size="sm" className="h-8 text-xs" onClick={() => setFulfilSource('range')}>{t('ordersPage.byDateRange')}</Button>
          <Button variant={fulfilSource === 'selected' ? 'default' : 'outline'} size="sm" className="h-8 text-xs" onClick={() => setFulfilSource('selected')}>{t('ordersPage.selectedCount', { count: selectedExport.size })}</Button>
        </div>
        {fulfilSource === 'range' ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 justify-start gap-1.5 text-xs font-normal"><CalendarIcon className="h-3 w-3" />{t('ordersPage.from')}: {fulfilFrom ? formatDayDmy(fulfilFrom).slice(0, 5) : '—'}</Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start"><Calendar mode="single" selected={fulfilFrom} onSelect={setFulfilFrom} weekStartsOn={1} className="pointer-events-auto p-3" /></PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 justify-start gap-1.5 text-xs font-normal"><CalendarIcon className="h-3 w-3" />{t('ordersList.csv.to')}: {fulfilTo ? formatDayDmy(fulfilTo).slice(0, 5) : '—'}</Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start"><Calendar mode="single" selected={fulfilTo} onSelect={setFulfilTo} weekStartsOn={1} className="pointer-events-auto p-3" /></PopoverContent>
              </Popover>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{t('ordersPage.colStatus')}</div>
              <div className="grid grid-cols-3 gap-1">
                {(['confirmed', 'shipped', 'paid'] as OrderStatus[]).map(s => (
                  <Button key={s} variant={fulfilStatus === s ? 'default' : 'outline'} size="sm" className="h-8 px-1 text-xs" onClick={() => setFulfilStatus(s)}>
                    {statusLabel(s)}
                  </Button>
                ))}
              </div>
            </div>
            {/* Ship-eligibility cutoff: orders postponed past it drop out of today's CSV. */}
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">{t('ordersPage.readyToShipBy')}</div>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 w-full justify-start gap-1.5 text-xs font-normal">
                    <CalendarIcon className="h-3 w-3" />
                    {readyByDate ? formatDate(readyByDate, 'EEE, d MMM') : t('ordersList.csv.anyDate')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={readyByDate} onSelect={setReadyByDate} weekStartsOn={1} className="pointer-events-auto p-3" />
                  <div className="flex items-center justify-between gap-1 px-2 pb-2">
                    <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setReadyByDate(skopjeTodayLocal())}>{t('ordersPage.today')}</Button>
                    <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setReadyByDate(addDays(skopjeTodayLocal(), 2))}>{t('ordersList.csv.plus2')}</Button>
                    <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setReadyByDate(addDays(skopjeTodayLocal(), 7))}>{t('ordersList.csv.plus7')}</Button>
                  </div>
                </PopoverContent>
              </Popover>
              <p className="mt-1 text-[10px] leading-tight text-muted-foreground">{t('ordersList.csv.readyHint')}</p>
            </div>
          </>
        ) : (
          <div className="space-y-1 rounded-md border bg-muted/30 p-2 text-[11px]">
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">{t('ordersList.csv.selected', { count: selectedExport.size })}</span>
              {selectedExport.size > 0 && <button type="button" onClick={clearExportSelect} className="text-muted-foreground underline hover:text-foreground">{t('common.clear')}</button>}
            </div>
            <p className="leading-tight text-muted-foreground">{t('ordersPage.tickOrdersHint')}</p>
          </div>
        )}
        {/* Auto-flip toggle — only meaningful when exporting confirmed orders (the
            warehouse hand-off). Hidden for roles that can't bulk-update status. */}
        {canBulkUpdateStatus && (() => {
          const flipEligible = fulfilSource === 'selected' ? selectedHasConfirmed : fulfilStatus === 'confirmed';
          return (
            <label className={cn(
              'flex items-start gap-2 rounded-md border p-2 text-[11px]',
              flipEligible ? 'cursor-pointer hover:bg-muted/40' : 'cursor-not-allowed opacity-50',
            )}>
              <Checkbox
                checked={flipEligible && markShippedAfterExport}
                onCheckedChange={(v) => setMarkShippedAfterExport(v === true)}
                disabled={!flipEligible}
                className="mt-0.5"
              />
              <div className="leading-tight">
                <div className="font-medium text-foreground">{t('ordersPage.markShippedAfter')}</div>
                <div className="text-muted-foreground">
                  {flipEligible
                    ? t('ordersList.csv.flipOn')
                    : (fulfilSource === 'selected' ? t('ordersList.csv.flipNoneSelected') : t('ordersList.csv.flipOnlyConfirmed'))}
                </div>
              </div>
            </label>
          );
        })()}
        <Button size="sm" className="h-9 w-full gap-1.5" onClick={exportFulfilmentCSV} disabled={fulfilLoading || (fulfilSource === 'selected' && selectedExport.size === 0)}>
          {fulfilLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {t('ordersList.csv.export')}
        </Button>
      </PopoverContent>
    </Popover>
  );

  const exportButton = (
    <Popover
      open={exportOpen}
      onOpenChange={(o) => {
        setExportOpen(o);
        if (o) { setExportPageFrom('1'); setExportPageTo(String(Math.max(1, totalPages))); }
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-9 gap-1.5 rounded-lg px-2.5 text-sm lg:px-3" aria-label={t('ordersPage.exportView')}>
          <Download className="h-4 w-4 shrink-0" aria-hidden /> <span className="hidden lg:inline">{t('ordersPage.exportView')}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(20rem,calc(100vw-2rem))] space-y-3 p-3" align="end">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t('ordersPage.exportView')}</div>
          <p className="text-[11px] leading-tight text-muted-foreground">{t('ordersPage.exportScopeDesc')}</p>
        </div>
        {/* The period is the list's own (the toolbar) — what the count below describes. */}
        <div className="rounded-md border bg-muted/30 p-2 text-[11px]">
          <span className="text-muted-foreground">{t('ordersPage.exportDateRange')}: </span>
          <span className="font-medium tabular-nums">{periodLabel}</span>
          <span className="text-muted-foreground"> · {t(`ordersList.view.${view}`)}</span>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <Button variant={exportScope === 'all' ? 'default' : 'outline'} size="sm" className="h-8 text-xs" onClick={() => setExportScope('all')}>{t('ordersPage.exportAllPages')}</Button>
          <Button variant={exportScope === 'range' ? 'default' : 'outline'} size="sm" className="h-8 text-xs" onClick={() => setExportScope('range')}>{t('ordersPage.exportPageRange')}</Button>
        </div>
        {exportScope === 'range' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="shrink-0 text-[11px] text-muted-foreground">{t('ordersPage.exportPagesLabel')}</span>
            <Input type="number" min={1} max={Math.max(1, totalPages)} value={exportPageFrom}
              onChange={(e) => setExportPageFrom(e.target.value)} className="h-8 w-16 text-xs" aria-label={t('ordersPage.exportPageFrom')} />
            <span className="text-[11px] text-muted-foreground">–</span>
            <Input type="number" min={1} max={Math.max(1, totalPages)} value={exportPageTo}
              onChange={(e) => setExportPageTo(e.target.value)} className="h-8 w-16 text-xs" aria-label={t('ordersPage.exportPageTo')} />
            <span className="whitespace-nowrap text-[11px] text-muted-foreground">{t('ordersPage.exportOfPages', { pages: Math.max(1, totalPages) })}</span>
          </div>
        )}
        <div className="rounded-md border bg-muted/30 p-2 text-[11px] leading-tight">
          <span className="font-medium text-foreground">{t('ordersPage.exportEstimate', { count: exportEstimate })}</span>
          <span className="text-muted-foreground"> · {t('ordersPage.exportKeepsFilters')}</span>
        </div>
        <Button size="sm" className="h-9 w-full gap-1.5" onClick={exportXLSX} disabled={exportLoading || total === 0}>
          {exportLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {exportLoading
            ? (exportProgress > 0 ? t('ordersPage.exportingProgress', { count: exportProgress }) : t('ordersPage.exporting'))
            : t('ordersPage.exportView')}
        </Button>
      </PopoverContent>
    </Popover>
  );

  return (
    <AppLayout title={t('nav.orders')}>
      <div className={cn('mx-auto min-w-0 max-w-[1680px] space-y-3', OVERVIEW_COLOR_VARS)}>
        {drill && <OrdersDrillBanner drill={drill} label={drillLabel} onClear={clearDrill} />}

        {/* ── the toolbar ─────────────────────────────────────────────── */}
        <section role="search" aria-label={t('ordersList.search.label')} className="min-w-0 space-y-3 rounded-xl border bg-card/80 p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 basis-full md:flex-1 md:basis-auto lg:max-w-xl">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                type="search"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape' && searchText) { e.preventDefault(); searchFor(''); } }}
                placeholder={isMobile ? t('ordersList.search.short') : t('ordersList.search.placeholder')}
                aria-label={t('ordersList.search.label')}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="search"
                className={cn(
                  // 16 px below md: iOS Safari zooms into any smaller input on focus.
                  'h-9 w-full rounded-lg border bg-background pl-8 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm [&::-webkit-search-cancel-button]:hidden',
                  searchText ? 'pr-9' : 'pr-3',
                )}
              />
              {searchText && (
                <button type="button" onClick={() => searchFor('')} aria-label={t('ordersList.search.clear')} title={t('ordersList.search.clear')}
                  className="absolute right-0 top-0 flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted">
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2 md:flex-none">
              <Button variant="outline" size="sm" className="mr-auto h-9 gap-1.5 rounded-lg text-sm xl:hidden" onClick={openSheet}>
                <Filter className="h-3.5 w-3.5" aria-hidden /> {t('ordersList.filters.open')}
                {filterCount > 0 && <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">{filterCount}</span>}
              </Button>
              {csvButton}
              {exportButton}
              <Button onClick={() => setShowCreateModal(true)} size="sm" className="h-9 gap-1.5 rounded-lg text-sm" aria-label={t('common.createOrder')}>
                <Plus className="h-3.5 w-3.5" aria-hidden /> <span className="hidden sm:inline">{t('common.createOrder')}</span><span className="sm:hidden">{t('ordersList.new')}</span>
              </Button>
            </div>
          </div>
          {searchIsPhone && <p className="text-[11px] text-muted-foreground">{t('ordersList.search.phone')}</p>}

          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <OrderViewChips view={view} counts={counts} onChange={(v) => patch({ view: v })} />
            <div className="flex items-center gap-3">
              <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite" data-testid="orders-shown">
                {t('ordersList.range', { from: fmtCount(firstRow), to: fmtCount(lastRow), total: fmtCount(total) })}
              </span>
              {hasActiveFilters && (
                <button type="button" onClick={clearAllFilters}
                  className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border px-3 text-xs font-medium text-muted-foreground hover:bg-muted lg:h-8">
                  <X className="h-3.5 w-3.5" aria-hidden />{t('ordersList.filters.clear')}
                </button>
              )}
            </div>
          </div>

          {/* xl+: every filter in view. Below xl (phones, tablets, a 1024 laptop with the sidebar open): a summary + the sheet. */}
          <div className="hidden xl:block">
            <OrdersFilterFields value={state} onChange={patch} today={today} drill={!!drill} src={filterSrc} layout="inline" />
          </div>
          <div className="space-y-2 xl:hidden">
            {/* ← day → right here on a phone (owner 01.10.2026); the rest of the filters live in the sheet. */}
            <div className="flex items-center gap-1.5">
              {period.days && <PhoneDayArrow dir={-1} days={period.days} today={today} onStep={stepPeriod} />}
              <button type="button" onClick={openSheet} className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-lg border bg-background px-3 py-2 text-left text-xs">
                <span className="min-w-0 truncate">
                  <span className="text-muted-foreground">{t('ordersList.period.label')}: </span>
                  <span className="font-medium">{periodPresetLabel}</span>
                  {period.days && <span className="tabular-nums text-muted-foreground"> · {periodLabel}</span>}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </button>
              {period.days && <PhoneDayArrow dir={1} days={period.days} today={today} onStep={stepPeriod} />}
            </div>
            <ActiveFilterChips value={state} onChange={patch} src={filterSrc} />
          </div>
        </section>

        {/* ── the selection ───────────────────────────────────────────── */}
        {selectedExport.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-1 text-xs">
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">{t('ordersPage.nSelectedForExport', { count: selectedExport.size })}</span>
            <button type="button" onClick={clearExportSelect} className="text-muted-foreground underline hover:text-foreground">{t('common.clear')}</button>
            {canDisposeOrders && disposableSelected.length > 0 && (
              <>
                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => openDisposition('trashed')}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('ordersPage.bulkTrash', { count: disposableSelected.length })}
                </Button>
                <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={() => openDisposition('cancelled')}>
                  <Ban className="h-3.5 w-3.5" />
                  {t('ordersPage.bulkCancel', { count: disposableSelected.length })}
                </Button>
              </>
            )}
            {cpaPushEnabled && cpaPushableSelected.length > 0 && (
              <Button
                size="sm" variant="outline" className="h-8 gap-1.5 text-xs"
                onClick={() => setCpaBulk({ eligible: cpaPushableSelected, skipped: selectedExport.size - cpaPushableSelected.length })}
              >
                <Send className="h-3.5 w-3.5" />
                {t('ordersPage.cpaBulkSend', { count: cpaPushableSelected.length })}
              </Button>
            )}
            <span className="text-muted-foreground">{t('ordersPage.openPrefix')} <span className="font-medium text-foreground">{t('ordersPage.fulfilSelectedPath')}</span> {t('ordersPage.openSuffix')}</span>
          </div>
        )}

        {/* ── the list ────────────────────────────────────────────────── */}
        {loadError && !loading ? (
          <EmptyState
            icon={<Package className="h-5 w-5" />}
            title={t('common.error')}
            description={loadError}
            size="sm"
            action={<Button variant="outline" size="sm" onClick={refresh}>{t('common.retry')}</Button>}
          />
        ) : loading && orders.length === 0 ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-label={t('insights.common.period.loading')} /></div>
        ) : orders.length === 0 ? (
          <EmptyState
            icon={<Package className="h-5 w-5" />}
            title={t('ordersPage.noOrdersFound')}
            description={hasActiveFilters || view !== 'all' || period.days ? t('ordersList.emptyHint') : t('ordersPage.ordersAppearHere')}
            size="sm"
            action={hasActiveFilters ? <Button variant="outline" size="sm" onClick={clearAllFilters}>{t('ordersPage.clearFilters')}</Button> : undefined}
          />
        ) : (
          <div className={cn('min-w-0 transition-opacity', loading && 'opacity-60')} aria-busy={loading}>
            <OrdersList
              orders={orders}
              selected={selectedExport}
              onToggleSelect={toggleExportSelect}
              onToggleAll={toggleAllOnPage}
              onOpen={tryOpenOrder}
              expanded={expandedIds}
              renderDetails={renderDetails}
              actions={rowActions}
              productParts={productCellParts}
              views={views}
              currentUserId={user?.id}
              dupCount={getPhoneDupCount}
              onSearch={searchFor}
            />
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">{t('ordersPage.pageOf', { page, totalPages, total: fmtCount(total) })}</p>
            <ResponsivePager page={page} totalPages={totalPages} onPageChange={(p) => patch({ page: p })} t={t}
              desktop={<SmartPagination page={page} totalPages={totalPages} onPageChange={(p) => patch({ page: p })} />} />
          </div>
        )}
      </div>

      {/* Filters — phone sheet: a draft of every filter; "Примени" writes it. */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className={cn('flex max-h-[90dvh] flex-col gap-0 p-0', OVERVIEW_COLOR_VARS)}>
          <SheetHeader className="border-b px-4 py-3 text-left">
            <SheetTitle>{t('ordersList.filters.title')}</SheetTitle>
            <SheetDescription className="text-xs">{t('ordersList.period.hint')}</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <OrdersFilterFields
              value={draft}
              onChange={(p) => setDraftSp((prev) => writeListParams(prev, p))}
              today={today} drill={!!drill} src={filterSrc} layout="sheet"
            />
          </div>
          <div className="flex gap-2 border-t px-4 py-3">
            <Button variant="outline" className="h-11" onClick={resetSheet}>{t('ordersList.filters.reset')}</Button>
            <Button className="h-11 flex-1" onClick={applySheet}>{t('ordersList.filters.apply')}</Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Bulk trash / cancel — one reason for the whole selection. */}
      <Dialog open={!!dispositionAction} onOpenChange={(o) => { if (!o && !dispBusy) setDispositionAction(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {dispositionAction === 'trashed'
                ? t('ordersPage.bulkTrashTitle', { count: disposableSelected.length })
                : t('ordersPage.bulkCancelTitle', { count: disposableSelected.length })}
            </DialogTitle>
            <DialogDescription>
              {selectedExport.size > disposableSelected.length
                ? t('ordersPage.bulkDispositionPartial', { count: disposableSelected.length, total: selectedExport.size })
                : t('ordersPage.bulkDispositionHint')}
            </DialogDescription>
          </DialogHeader>
          {dispositionAction === 'trashed' ? (
            <TrashReasonPicker
              value={dispTrashReason}
              notes={dispNotes}
              onChange={setDispTrashReason}
              onNotesChange={setDispNotes}
              disabled={dispBusy}
              idPrefix="orders-bulk-trash"
            />
          ) : (
            <CancellationReasonPicker
              value={dispCancelReason}
              notes={dispNotes}
              onChange={setDispCancelReason}
              onNotesChange={setDispNotes}
              disabled={dispBusy}
              idPrefix="orders-bulk-cancel"
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDispositionAction(null)} disabled={dispBusy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={runDisposition} disabled={!dispositionValid || dispBusy || disposableSelected.length === 0}>
              {dispBusy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {dispositionAction === 'trashed'
                ? t('ordersPage.bulkTrash', { count: disposableSelected.length })
                : t('ordersPage.bulkCancel', { count: disposableSelected.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Order Modal */}
      <OrderModal
        open={!!modalOrder}
        onClose={handleCloseModal}
        data={modalOrder ? orderToModalData(modalOrder) : null}
        contextType="order"
        readOnly={!!(modalOrder && (!(modalOrder as any).is_owned || !canEditOrders))}
      />

      {/* Create Order Modal */}
      <CreateOrderModal
        open={showCreateModal}
        onClose={(created) => {
          setShowCreateModal(false);
          if (created) refresh();
        }}
      />

      {/* Customer History Dialog */}
      <CustomerHistoryDialog
        open={!!historyOrder}
        onClose={() => setHistoryOrder(null)}
        customerPhone={historyOrder?.phone || ''}
        customerName={historyOrder?.name || ''}
      />

      {/* CPA push confirm — renders the SERVER-assembled dry-run payload, so
          what the operator approves is exactly what will be sent. */}
      <Dialog open={!!cpaPreview} onOpenChange={(o) => { if (!o && !cpaSending) setCpaPreview(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('ordersPage.cpaDialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('ordersPage.cpaDialogDesc', { account: cpaPreview?.preview.account ?? '' })}
            </DialogDescription>
          </DialogHeader>
          {cpaPreview && (() => {
            const p = cpaPreview.preview.params;
            const rows: [string, string | undefined][] = [
              [t('ordersPage.cpaFieldOid'), cpaPreview.preview.oid],
              [t('ordersPage.cpaFieldStatus'), p.accept === '1'
                ? t('ordersPage.cpaStatusAccept')
                : `${t(`status.${cpaPreview.order.status}`)} → ${p.status}`],
              [t('ordersPage.cpaFieldReason'), p.reason],
              [t('ordersPage.cpaFieldName'), p.name],
              [t('ordersPage.cpaFieldPhone'), p.phone],
              [t('ordersPage.cpaFieldCity'), p.city],
              [t('ordersPage.cpaFieldStreet'), p.street],
              [t('ordersPage.cpaFieldArea'), p.area],
              [t('ordersPage.cpaFieldAddress'), p.addr],
              [t('ordersPage.cpaFieldPostal'), p.index],
              [t('ordersPage.cpaFieldQty'), p.count],
              [t('ordersPage.cpaFieldUnitPrice'), cpaBaseText(p.base, cpaPreview.preview.base_currency)],
              [t('ordersPage.cpaFieldComment'), p.comment],
            ];
            const remote = cpaPreview.preview.remote;
            return (
              <div className="space-y-2">
                <div className="max-h-72 space-y-1 overflow-y-auto text-sm">
                  {rows.filter(([, v]) => v !== undefined && v !== '').map(([label, v]) => (
                    <div key={label} className="flex justify-between gap-3">
                      <span className="shrink-0 text-muted-foreground">{label}</span>
                      <span className="break-all text-right">{v}</span>
                    </div>
                  ))}
                </div>
                {cpaPreview.preview.warning && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">{cpaPreview.preview.warning}</p>
                )}
                {!cpaPreview.preview.token_present && (
                  <p className="text-xs text-destructive">{t('ordersPage.cpaNoToken')}</p>
                )}
                {remote && (
                  <p className="text-xs text-muted-foreground">
                    {t('ordersPage.cpaRemoteState', {
                      phase: remote.phase ?? '—', status: remote.status ?? '—', reason: remote.reason ?? '—',
                    })}
                  </p>
                )}
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" disabled={cpaSending} onClick={() => setCpaPreview(null)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={cpaSending || !cpaPreview?.preview.token_present} onClick={handleCpaConfirm}>
              {cpaSending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t('ordersPage.cpaConfirmSend')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk CPA push — sequential loop over the single-order endpoint, one
          payload per order. Closing the dialog is blocked while sending. */}
      <Dialog open={!!cpaBulk} onOpenChange={(o) => { if (!o && !cpaBulkProgress) setCpaBulk(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('ordersPage.cpaBulkTitle', { count: cpaBulk?.eligible.length ?? 0 })}</DialogTitle>
            <DialogDescription>
              {t('ordersPage.cpaBulkDesc')}
              {(cpaBulk?.skipped ?? 0) > 0 && ` ${t('ordersPage.cpaBulkSkipped', { count: cpaBulk!.skipped })}`}
            </DialogDescription>
          </DialogHeader>
          {cpaBulkProgress && (
            <div className="space-y-1.5">
              <div className="h-2 w-full overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((cpaBulkProgress.done / Math.max(1, cpaBulkProgress.total)) * 100)}%` }}
                />
              </div>
              <p className="text-center text-xs text-muted-foreground">
                {t('ordersPage.cpaBulkProgress', { done: cpaBulkProgress.done, total: cpaBulkProgress.total })}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={!!cpaBulkProgress} onClick={() => setCpaBulk(null)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!!cpaBulkProgress} onClick={runCpaBulk}>
              {cpaBulkProgress && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {t('ordersPage.cpaBulkConfirm', { count: cpaBulk?.eligible.length ?? 0 })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pre-export validation gate */}
      <FulfilmentValidationDialog
        open={!!exportValidation}
        onOpenChange={(o) => { if (!o) setExportValidation(null); }}
        validCount={exportValidation?.valid.length ?? 0}
        invalid={exportValidation?.invalid ?? []}
        onExportValid={handleExportValidOnly}
      />
    </AppLayout>
  );
}

/** One ← / → of the phone period row (the same step as the period's arrows, see stepRange). */
function PhoneDayArrow({ dir, days, today, onStep }: {
  dir: -1 | 1; days: { from: string; to: string }; today: string;
  onStep: (next: { preset: string; range: { from: string; to: string } }) => void;
}) {
  const { t } = useTranslation();
  const next = stepRange(days, dir, today);
  const oneDay = days.from === days.to;
  const label = t(dir < 0 ? (oneDay ? 'insights.common.period.prevDay' : 'insights.common.period.prevPeriod') : (oneDay ? 'insights.common.period.nextDay' : 'insights.common.period.nextPeriod'));
  const Icon = dir < 0 ? ChevronLeft : ChevronRight;
  return (
    <button type="button" disabled={!next} onClick={() => next && onStep(next)} aria-label={label} title={label}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-background disabled:opacity-40">
      <Icon className="h-4 w-4" aria-hidden />
    </button>
  );
}
