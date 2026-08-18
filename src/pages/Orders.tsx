import { useState, useEffect, useMemo, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/layouts/AppLayout';
import { StatusBadge } from '@/components/StatusBadge';
import { orderReasonText as sharedOrderReasonText } from '@/lib/orderReason';
import { SmartPagination } from '@/components/SmartPagination';
import { ALL_STATUSES, statusLabel, STATUS_COLORS, OrderStatus } from '@/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn, formatProductWithQuantity, buildProductNameLookups } from '@/lib/utils';
import { format, addDays } from 'date-fns'; // raw format: fulfilment CSV + machine payloads only
import { formatDate } from '@/i18n/dates';
import {
  Download, ChevronLeft, ChevronRight, ChevronDown, Filter, Search, Loader2,
  CalendarIcon, X, User, Plus, MoreVertical, History, Lock, Copy, CopyPlus, Euro, Package, Send,
} from 'lucide-react';
import { Check } from 'lucide-react';
import { MobileCard, MobileCardHeader, MobileCardField, MobileCardActions } from '@/components/ui/mobile-card';
import { apiGetOrders, apiGetAgents, apiGetProducts, apiBulkStatusUpdate, apiBulkDisposition, apiDuplicateOrder, apiPushOrderAltercpa, apiGetAppSettings, type AltercpaPushPreview, type TrashReason, type CancellationReason } from '@/lib/api';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
// The SAME reason pickers the Calls page and both order modals use — a bulk
// path must never grow its own reason list, or the two drift and the cancel
// insights stop adding up.
import { TrashReasonPicker } from '@/components/TrashReasonPicker';
import { CancellationReasonPicker } from '@/components/CancellationReasonPicker';
import { isTrashSelectionValid } from '@/lib/trashReasons';
import { isCancelSelectionValid } from '@/lib/cancellationReasons';
import { Trash2, Ban } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
// The price filter talks EUR to the API (orders are stored in EUR) but the
// operator picks and types denari — convert at the boundary, show ден only.
import { formatMoney, codFor, eurToDen, denToEur } from '@/lib/currency';
import { toCsv, downloadCsv } from '@/lib/csv';
import { composeHomeAddress, effectiveHomeParts } from '@/lib/address';
import { validateOrderForFulfilment } from '@/lib/fulfilmentValidation';
import { FulfilmentValidationDialog, type InvalidOrder } from '@/components/FulfilmentValidationDialog';
import { Truck } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { BigArenaStatusSync } from '@/components/BigArenaStatusSync';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import { OrderModal, OrderModalData } from '@/components/OrderModal';
import { CreateOrderModal } from '@/components/CreateOrderModal';
import { CustomerHistoryDialog } from '@/components/CustomerHistoryDialog';
import { OrderCallsPanel } from '@/components/OrderCallsPanel';
import { ActiveViewBadge } from '@/components/ActiveViewBadge';
import { supabase } from '@/integrations/supabase/client';
import { toast } from '@/hooks/use-toast';
import { EmptyState } from '@/components/EmptyState';

const PAGE_SIZE = 20;

// Statuses whose expanded row shows the Delivery Details section; the inline
// Calls panel sits beside it there, and stands alone for every other status.
const DELIVERY_STATUSES = ['confirmed', 'shipped', 'delivered', 'paid', 'returned'];

interface ApiOrder {
  id: string;
  display_id: string;
  product_name: string;
  price: number;
  quantity: number;
  status: OrderStatus;
  customer_name: string;
  customer_phone: string;
  customer_city: string;
  customer_address: string;
  postal_code?: string;
  assigned_agent_name: string | null;
  assigned_agent_id: string | null;
  last_action_by?: string | null;
  confirmed_by_name?: string | null;
  confirmed_by_agent_id?: string | null;
  confirmed_at?: string | null;
  created_at: string;
  source_type?: string;
  source_lead_id?: string | null;
  // AlterCPA linkage (GET /orders selects *; these power the CPA push button)
  external_source?: string | null;
  external_order_id?: string | null;
  // Reason pairs — orderReasonText() composes the CPA push comment from these
  cancellation_reason?: string | null;
  cancellation_reason_notes?: string | null;
  trash_reason?: string | null;
  trash_reason_notes?: string | null;
  return_reason?: string | null;
  return_reason_notes?: string | null;
  duplicated_from?: string | null;
  duplicated_from_display?: string | null;
  notes?: string | null;
  delivery_type?: string | null;
  home_courier?: string | null;
  courier_office_name?: string | null;
  courier_office_city?: string | null;
  courier_office_code?: string | null;
  order_items?: any[];
}

// Filter chips + dropdown use the same canonical palette as the table badges.
const STATUS_CHIP_COLORS: Record<OrderStatus, string> = { ...STATUS_COLORS };

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

export default function Orders() {
  const { t } = useTranslation(); // also subscribes status chips/labels to language switches
  const { user } = useAuth();
  const { canAction, canSeePrivacy } = usePermissions();
  // Roles without orders-edit permission (e.g. investor managers) open orders
  // read-only. The server also rejects their mutations — this just hides the controls.
  const canEditOrders = canAction('orders', 'edit');
  // Inline Calls panel on expanded rows — recording-permission roles only.
  const showCallsPanel = canSeePrivacy('can_hear_recordings') || canSeePrivacy('can_hear_own_recordings');
  const isAdmin = user?.isAdmin || user?.isManager;
  const isAgent = !isAdmin;
  // Backend gates POST /orders/bulk-status-update to admin/manager/warehouse,
  // so the "auto-mark shipped" toggle is only meaningful for those roles.
  const canBulkUpdateStatus = !!(user?.isAdmin || user?.isManager || user?.isWarehouse);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<OrderStatus[]>([]);
  const [sourceFilter, setSourceFilter] = useState('all');
  const [agentFilter, setAgentFilter] = useState('all');
  const [myOrdersOnly, setMyOrdersOnly] = useState(isAgent); // agents default to my orders
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();
  const [priceMin, setPriceMin] = useState<number | null>(null);
  const [priceMax, setPriceMax] = useState<number | null>(null);
  const [priceMinDraft, setPriceMinDraft] = useState('');
  const [priceMaxDraft, setPriceMaxDraft] = useState('');
  const [page, setPage] = useState(1);
  const [orders, setOrders] = useState<ApiOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [modalOrder, setModalOrder] = useState<ApiOrder | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [historyOrder, setHistoryOrder] = useState<{ phone: string; name: string } | null>(null);
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
    if (saved) fetchOrders();
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
      fetchOrders();
    } catch (e: any) {
      toast({ title: e.message || 'Error', variant: 'destructive' });
    } finally {
      setDuplicatingId(null);
    }
  };

  // Manual "CPA" push (admin/manager, feature-flagged). Strictly one order per
  // press — no bulk variant exists, by operator decision 2026-08-14. The button
  // first fetches a dry-run preview (the server-assembled payload, so the
  // dialog cannot lie) and only the explicit Confirm fires the live call.
  const { data: appSettings } = useQuery({
    queryKey: ['app-settings'],
    queryFn: apiGetAppSettings,
    enabled: !!isAdmin,
    staleTime: 60_000,
  });
  const cpaPushEnabled = !!isAdmin && appSettings?.altercpa_push_enabled === true;
  const CPA_PUSHABLE = ['confirmed', 'shipped', 'delivered', 'paid', 'returned', 'cancelled', 'trashed'];
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
      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        next.add(orderId);
      }
      return next;
    });
  };

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [debouncedSearch, selectedStatuses, sourceFilter, agentFilter, myOrdersOnly, dateFrom, dateTo, priceMin, priceMax]);

  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: apiGetAgents,
    enabled: !!isAdmin,
  });

  // Product catalogue → product_id:sku map, so the warehouse export can encode
  // line items as sku:quantity (order_items only carries product_id + name).
  const { data: productsData } = useQuery<any[]>({
    queryKey: ['products'],
    queryFn: apiGetProducts,
  });
  const skuById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of productsData || []) if (p.id && p.sku) m[p.id] = p.sku;
    return m;
  }, [productsData]);

  const { nameById, resolveToCleanCatalogueName, resolveSku } = useMemo(() => {
    return buildProductNameLookups(productsData || []);
  }, [productsData]);

  const fetchOrders = () => {
    setLoading(true);
    // When agent is searching, don't restrict by agent_id (global search)
    const isSearching = !!debouncedSearch;
    const effectiveAgentId = isSearching && isAgent
      ? undefined
      : (myOrdersOnly && user?.id ? user.id : (agentFilter !== 'all' ? agentFilter : undefined));
    apiGetOrders({
      status: selectedStatuses.length > 0 ? selectedStatuses.join(',') : undefined,
      source: sourceFilter !== 'all' ? sourceFilter : undefined,
      search: debouncedSearch || undefined,
      agent_id: effectiveAgentId,
      from: dateFrom ? format(dateFrom, "yyyy-MM-dd'T'00:00:00") : undefined,
      to: dateTo ? format(dateTo, "yyyy-MM-dd'T'23:59:59") : undefined,
      price_min: priceMin ?? undefined,
      price_max: priceMax ?? undefined,
      page,
      limit: PAGE_SIZE,
    })
      .then((data) => {
        setOrders(data.orders || []);
        setTotal(data.total || 0);
      })
      .catch((err) => {
        console.error('Failed to fetch orders:', err);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchOrders(); }, [page, selectedStatuses, sourceFilter, debouncedSearch, agentFilter, myOrdersOnly, dateFrom, dateTo, priceMin, priceMax]);

  // Status filtering (single or multi-select) is now done server-side, so the
  // page already contains exactly the orders that match — and total/pagination
  // are correct. No client-side status filtering needed.
  const filteredOrders = orders;

  // Count duplicate phones in current results
  const phoneCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of filteredOrders) {
      const p = o.customer_phone?.replace(/[^0-9+]/g, '');
      if (p && p.length >= 6) counts[p] = (counts[p] || 0) + 1;
    }
    return counts;
  }, [filteredOrders]);

  const getPhoneDupCount = (phone: string) => {
    const p = phone?.replace(/[^0-9+]/g, '');
    return p ? (phoneCounts[p] || 0) : 0;
  };

  // Resolve the product label for an order (shared by the desktop table cell and
  // the mobile card). Handles real line items, clean names, and synthetic
  // cancelled/trashed rows that stash the prior product in notes.
  const productOnlyLabel = (order: any): string => {
    if (order.order_items && order.order_items.length > 0) {
      return order.order_items.map((i: any) => {
        const displayName = i.product_id && nameById[i.product_id] ? nameById[i.product_id] : (i.product_name || '—');
        return formatProductWithQuantity(displayName, i.quantity);
      }).join(', ');
    }
    const pn = order.product_name || '';
    const isSyntheticPlaceholder = /^(Cancelled|Trashed|No prior product on file)/i.test(pn);
    if (pn && !isSyntheticPlaceholder) {
      return formatProductWithQuantity(resolveToCleanCatalogueName(pn), order.quantity || 1);
    }
    const isOutcomeSynthetic = ['cancelled', 'trashed', 'call_again'].includes(order.status);
    if (isOutcomeSynthetic) {
      // Structured trash reason (orders.trash_reason) — translated for display.
      // Replaces the old "No prior product on file" placeholder on trashed rows
      // that carry no product of their own.
      if (order.status === 'trashed' && order.trash_reason) {
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
      if (reasonNote) return resolveToCleanCatalogueName(reasonNote);
    }
    return formatProductWithQuantity(resolveToCleanCatalogueName(pn), order.quantity || 1) || '—';
  };

  // What actually goes in the Product column.
  //
  // On a cancelled or trashed row the product is not the useful fact — the
  // reason is. Which product they declined stays on the cell as a hover title,
  // and is one click away in the order; why they declined is the thing you scan
  // a cancel list for.
  //
  // The reason check has to happen BEFORE the product is resolved. The old
  // reason branch sat at the bottom of productOnlyLabel and only ever ran for
  // legacy rows carrying a placeholder product name, so any row with a real
  // product — every imported order, and every order an agent takes — returned
  // the product and never reached it.
  const isTerminated = (order: any) => order.status === 'cancelled' || order.status === 'trashed';

  const productLabel = (order: any): string => {
    if (isTerminated(order)) {
      const reason = sharedOrderReasonText(order);
      // No reason recorded at all → show the product rather than an empty cell.
      if (reason) return reason;
    }
    return productOnlyLabel(order);
  };

  // Tooltip for the Product cell: on a terminated row it holds the product the
  // reason displaced, so nothing is actually lost from the table.
  const productLabelTitle = (order: any): string | undefined =>
    isTerminated(order) && sharedOrderReasonText(order) ? productOnlyLabel(order) : undefined;

  // Human text for the rich reason panel on cancelled/trashed rows (desktop
  // expanded row + mobile card). Trashed orders carry a STRUCTURED reason in
  // orders.trash_reason (translated with the same trashReason.* labels as the
  // picker) + optional free-text note; cancelled ones keep the legacy
  // free-text chain.
  // Shared with the status-badge tooltip (src/lib/orderReason.ts) so the panel
  // and the hover can never disagree about the same order.
  const orderReasonText = (order: any): string | null =>
    sharedOrderReasonText(order) || order.notes || null;

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const toggleStatus = (s: OrderStatus) => {
    setSelectedStatuses(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  };
  const hasActiveFilters = search.trim() || selectedStatuses.length > 0 || sourceFilter !== 'all' || agentFilter !== 'all' || (myOrdersOnly && isAdmin) || dateFrom || dateTo || priceMin != null || priceMax != null;
  const clearAllFilters = () => {
    setSearch(''); setSelectedStatuses([]); setSourceFilter('all'); setAgentFilter('all'); if (isAdmin) setMyOrdersOnly(false); setDateFrom(undefined); setDateTo(undefined);
    setPriceMin(null); setPriceMax(null); setPriceMinDraft(''); setPriceMaxDraft('');
  };

  const priceLabel = priceMin != null && priceMax != null
    ? `${formatMoney(priceMin)}–${formatMoney(priceMax)}`
    : priceMin != null
      ? `${formatMoney(priceMin)}+`
      : priceMax != null
        ? `≤ ${formatMoney(priceMax)}`
        : null;

  const applyPricePreset = (min: number | null, max: number | null) => {
    setPriceMin(min); setPriceMax(max);
    setPriceMinDraft(min != null ? String(eurToDen(min)) : '');
    setPriceMaxDraft(max != null ? String(eurToDen(max)) : '');
  };

  const applyPriceCustom = () => {
    const minN = priceMinDraft.trim() === '' ? null : denToEur(Number(priceMinDraft));
    const maxN = priceMaxDraft.trim() === '' ? null : denToEur(Number(priceMaxDraft));
    setPriceMin(Number.isFinite(minN as number) ? (minN as number) : null);
    setPriceMax(Number.isFinite(maxN as number) ? (maxN as number) : null);
  };

  // Daily fulfilment export — pulls confirmed orders within a date range and
  // writes a CSV in the format the warehouse / fulfilment company expects.
  // Independent of the active page filters.
  const [fulfilFrom, setFulfilFrom] = useState<Date | undefined>(new Date());
  const [fulfilTo, setFulfilTo] = useState<Date | undefined>(new Date());
  const [fulfilStatus, setFulfilStatus] = useState<OrderStatus>('confirmed');
  const [fulfilLoading, setFulfilLoading] = useState(false);
  // After CSV download, flip every exported order from confirmed → shipped so
  // the warehouse hand-off is recorded in the system. Only applies when the
  // status filter is 'confirmed' — exporting other statuses doesn't auto-flip.
  const [markShippedAfterExport, setMarkShippedAfterExport] = useState(true);
  // "Ready to ship by" cutoff. Orders with a postponed ship_after_date later
  // than this are excluded from today's CSV — they'll come up naturally when
  // their date arrives. Defaults to today+2 to honor the "1-2 days is fine to
  // ship immediately" rule. Orders with no ship_after_date are always included.
  const [readyByDate, setReadyByDate] = useState<Date | undefined>(addDays(new Date(), 2));
  // Manual selection for the fulfilment export. 'range' = classic date-range
  // dump; 'selected' = export exactly the ticked orders. The map stores the
  // FULL order object (not just the id) so the CSV has every field even after
  // the row scrolls off-page or the filters change — selections accumulate
  // across pages/dates.
  const [fulfilSource, setFulfilSource] = useState<'range' | 'selected'>('range');
  const [selectedExport, setSelectedExport] = useState<Map<string, any>>(new Map());
  // Pending validation result when an export batch has incomplete orders. The
  // dialog lets the operator fix them first or export the valid ones only.
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
  const clearExportSelect = () => setSelectedExport(new Map());

  // ── Bulk trash / cancel (rule 8: no order is junked without a reason) ──────
  // Rides on the row selection that already exists for the fulfilment CSV, so
  // there is one selection model on this page, not two.
  const canDisposeOrders = !!(user?.isAdmin || user?.isManager);
  // Mirrors DISPOSABLE in POST /orders/bulk-disposition. Anything shipped and
  // beyond belongs to the warehouse Returned flow.
  const DISPOSABLE_STATUSES = ['pending', 'take', 'call_again', 'duplicated', 'confirmed'];
  const [dispositionAction, setDispositionAction] = useState<'trashed' | 'cancelled' | null>(null);
  const [dispTrashReason, setDispTrashReason] = useState<TrashReason | null>(null);
  const [dispCancelReason, setDispCancelReason] = useState<CancellationReason | null>(null);
  const [dispNotes, setDispNotes] = useState('');
  const [dispBusy, setDispBusy] = useState(false);
  // What the server will actually act on, so the dialog can say "3 of 5" rather
  // than promising a number it won't deliver.
  const disposableSelected = useMemo(
    () => Array.from(selectedExport.values()).filter(
      (o: any) => DISPOSABLE_STATUSES.includes(o.status) && o.status !== dispositionAction,
    ),
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
      fetchOrders();
    } catch (err: any) {
      toast({ title: t('common.error'), description: err?.message, variant: 'destructive' });
    } finally {
      setDispBusy(false);
    }
  };

  // Whether the current selection has anything that can flip → shipped.
  const selectedHasConfirmed = useMemo(
    () => Array.from(selectedExport.values()).some((o: any) => o.status === 'confirmed'),
    [selectedExport],
  );

  // Bulk Send-to-CPA (operator decision 2026-08-18, reversing the 08-14
  // one-per-press rule): the SELECTION drives a sequential client-side loop
  // over the same single-order endpoint — one server call per order, so every
  // order keeps its own payload, note, audit row and read-back verification.
  // There is still NO automatic hook: only this explicit button loops.
  const [cpaBulk, setCpaBulk] = useState<{ eligible: ApiOrder[]; skipped: number } | null>(null);
  const [cpaBulkProgress, setCpaBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const cpaPushableSelected = useMemo(
    () => Array.from(selectedExport.values()).filter((o: any) => canPushCpa(o)) as ApiOrder[],
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
        failed.push(`${o.display_id}: ${e?.message || 'error'}`);
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
    fetchOrders();
  };
  // Build the CSV from the given orders, download it, and (for the confirmed
  // bucket) flip them → shipped. Shared by the direct export and the "Export
  // valid only" path of the validation dialog, so both behave identically.
  const runFulfilmentExport = async (
    orders: any[],
    ctx: { isSelected: boolean; readyByStr: string | null; heldBackPostponed: number; heldBackInvalid: number },
  ) => {
    const { isSelected, readyByStr, heldBackPostponed, heldBackInvalid } = ctx;

    // MEX Poshta shipment file. One row per parcel, comma-separated, no BOM.
    //
    // The columns ARE the add_shipment.php parameter list, verbatim and in the
    // documented order. MEX publishes no CSV spec of its own — their API is
    // JSON-only — so the parameter contract is the only definition of "what MEX
    // expects" that is actually theirs rather than invented. It also means this
    // file can be fed straight into add_shipment.php when the direct push is
    // switched on, with no remapping.
    //
    // Replaced BigArena's Bulgarian 3PL format, which carried a lev-era column
    // layout, Bulgarian office markers and a courier/service pair that means
    // nothing to MEX.
    //
    // NOTE: the product list is deliberately NOT here — MEX has no field for it
    // and a strict importer would reject unknown columns. Picking/packing is
    // served by the Warehouse page's own export.
    // Street-level address only — city goes in its own column. For office
    // delivery this carries the office code + name instead.
    const addressLine = (o: any) => {
      if (o.delivery_type === 'speedy_office' || o.delivery_type === 'econt_office' || o.delivery_type === 'mex_office') {
        // MEX has no office concept at all — receiver_address is free text — so
        // a pickup order states the pickup point inside the address itself.
        return [
          'Подигање:',
          o.courier_office_code && `#${o.courier_office_code}`,
          o.courier_office_name,
          o.courier_office_city,
        ].filter(Boolean).join(' ');
      }
      // Resolve the real parts first — splits a house number stuck in the street
      // field so the line carries "бр. <n>", and parses legacy blob-only rows.
      // Falls back to the raw blob if the address can't be resolved at all.
      return composeHomeAddress(effectiveHomeParts(o)) || (o.customer_address || '');
    };

    const cityName = (o: any) => (o.delivery_type === 'speedy_office' || o.delivery_type === 'econt_office' || o.delivery_type === 'mex_office') ? (o.courier_office_city || '') : (o.customer_city || '');

    // MK national format (0XXXXXXXX) from the stored +389 E.164 number.
    // NOTE: this used to strip only +359. A +389 number fell straight through
    // and was emitted as "389XXXXXXXX" — a plausible-looking but wrong national
    // number that a courier would fail to dial.
    const phoneNational = (o: any) => {
      let p = (o.customer_phone || '').replace(/[^\d+]/g, '');
      if (p.startsWith('+389')) p = '0' + p.slice(4);
      else if (p.startsWith('389')) p = '0' + p.slice(3);
      return p.replace(/\D/g, '');
    };

    // COD amount and its currency come from ONE call, deliberately. They used to
    // be two independent `format:` lambdas, one emitting the currency code and
    // one the converted amount — change one and forget the other and the courier
    // collects the wrong sum on every parcel, with nothing throwing.
    const cod = (o: any) => codFor(o.price || 0);

    const dash = (v: string) => (v && v.trim()) ? v.trim() : '-';

    // MEX takes first_name and last_name separately and requires both. Split on
    // the FIRST space and keep the whole remainder as the surname, so
    // "Ана Марија Петровска" stays intact rather than losing a middle name.
    const splitName = (full: string | null | undefined) => {
      const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { first: '', last: '' };
      if (parts.length === 1) return { first: parts[0], last: '' };
      return { first: parts[0], last: parts.slice(1).join(' ') };
    };

    const csv = toCsv(orders, [
      // Our reference, echoed back by MEX on every status lookup.
      { key: 'tracking_id', header: 'tracking_id', format: (o: any) => o.display_id || '' },
      // The idempotency key. get_shipment_status_by_ref.php takes this, which is
      // how a retry after a timeout can tell "already sent" from "never sent" —
      // MEX has no cancellation endpoint, so a duplicate parcel is permanent.
      { key: 'sender_reference', header: 'sender_reference', format: (o: any) => o.display_id || '' },
      // MEX requires BOTH names. validateOrderForFulfilment already rejects a
      // single-token name, so last_name is never blank in an exported row.
      { key: 'first_name', header: 'first_name', format: (o: any) => splitName(o.customer_name).first },
      { key: 'last_name', header: 'last_name', format: (o: any) => splitName(o.customer_name).last },
      { key: 'receiver_phone', header: 'receiver_phone', format: phoneNational },
      { key: 'receiver_address', header: 'receiver_address', format: addressLine },
      // THE routing key. add_shipment.php has no postcode field and treats the
      // address as free text, so this integer alone decides where the parcel
      // goes. Never blank: an order without a zone is held back by validation.
      { key: 'receiver_city_id', header: 'receiver_city_id', format: (o: any) => o.mex_city_id != null ? String(o.mex_city_id) : '' },
      // Human-readable twin of the id, for the operator eyeballing the file.
      // MEX ignores it whenever receiver_city_id is present.
      { key: 'receiver_city', header: 'receiver_city', format: (o: any) => o.mex_city_name || cityName(o) },
      // A STRING with a dot decimal — "1500.00", not 1500 and not "1500,00".
      // codFor() is the single source for the amount, exactly as before.
      { key: 'cod', header: 'cod', format: (o: any) => `${cod(o).amount}.00` },
      // MEX's own default. Every parcel we ship is well under it.
      { key: 'weight', header: 'weight', format: () => '2' },
      { key: 'instructions', header: 'instructions', format: (o: any) => dash(o.delivery_instructions || '') },
    ], ',', false);

    const today = format(new Date(), 'yyyy-MM-dd');
    const fromStr = fulfilFrom ? format(fulfilFrom, 'yyyy-MM-dd') : today;
    const toStr = fulfilTo ? format(fulfilTo, 'yyyy-MM-dd') : today;
    const fname = isSelected
      ? `mex_shipments_selected_${today}_${orders.length}orders.csv`
      : (fromStr === toStr
        ? `mex_shipments_${fulfilStatus}_${fromStr}.csv`
        : `mex_shipments_${fulfilStatus}_${fromStr}_to_${toStr}.csv`);
    downloadCsv(fname, csv);

    // Flip confirmed → shipped after a successful download so the warehouse
    // hand-off is captured in the system. We only do this when exporting the
    // 'confirmed' bucket — exporting other statuses is a re-export, not a
    // hand-off, and shouldn't move anything.
    // Two kinds of held-back orders never leave: postponed (ship_after_date in
    // the future) and incomplete (failed pre-export validation). Both stay
    // confirmed and re-surface for a clean re-export.
    const postponedSuffix = heldBackPostponed > 0 ? ` · ${heldBackPostponed} postponed past ${readyByStr}` : '';
    const invalidSuffix = heldBackInvalid > 0 ? ` · ${t('ordersPage.exportedWithHeldBack', { held: heldBackInvalid })}` : '';
    const heldBackSuffix = `${postponedSuffix}${invalidSuffix}`;
    // Flip → shipped: in range mode the order set is the chosen 'confirmed'
    // bucket; in selected mode only the picked orders that are confirmed (a
    // manual selection can be mixed-status).
    const flipIds = (isSelected ? orders.filter(o => o.status === 'confirmed') : orders).map(o => o.id);
    const shouldFlip = markShippedAfterExport && canBulkUpdateStatus && flipIds.length > 0
      && (isSelected || fulfilStatus === 'confirmed');
    if (shouldFlip) {
      try {
        await apiBulkStatusUpdate(flipIds, 'shipped');
        toast({
          title: t('ordersPage.exportedShipped'),
          description: `${flipIds.length} order${flipIds.length !== 1 ? 's' : ''} → ${fname} · status set to shipped${heldBackSuffix}`,
        });
        if (isSelected) clearExportSelect();
        fetchOrders();
      } catch (flipErr: any) {
        toast({
          title: t('ordersPage.exportedStatusFailed'),
          description: flipErr?.message || 'CSV downloaded; orders are still in confirmed.',
          variant: 'destructive',
        });
      }
    } else {
      toast({
        title: t('ordersPage.exported'),
        description: `${orders.length} order${orders.length !== 1 ? 's' : ''} → ${fname}${heldBackSuffix}`,
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
      // range — fulfilment dumps can be a few thousand rows.
      let all: any[] = [];
      if (isSelected) {
        all = Array.from(selectedExport.values());
      } else {
        const PAGE = 200;
        for (let page = 1; ; page++) {
          const data = await apiGetOrders({
            status: fulfilStatus,
            from: format(fulfilFrom!, "yyyy-MM-dd'T'00:00:00"),
            to: format(fulfilTo!, "yyyy-MM-dd'T'23:59:59"),
            page,
            limit: PAGE,
          });
          const orders = data.orders || [];
          all.push(...orders);
          if (orders.length < PAGE) break;
          if (all.length >= 10000) break; // hard safety cap
        }
      }

      if (all.length === 0) {
        toast({ title: t('ordersPage.noOrders'), description: t('ordersPage.noOrdersInRange', { status: statusLabel(fulfilStatus) }) });
        return;
      }

      // Apply the "Ready to ship by" cutoff. Orders without ship_after_date go
      // through (they were never postponed); ones with a date pass only when
      // it's <= the cutoff. Lexicographic compare works because both sides are
      // in 'yyyy-MM-dd'.
      // Ready-by cutoff applies only to date-range exports; manual picks are explicit.
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

      // Pre-export validation: split the eligible set into ready-to-ship vs
      // incomplete. BigArena rejects a file with any bad row, so incomplete
      // orders must never be exported or flipped — they stay confirmed and the
      // operator fixes + re-exports them (no more reverting good orders by hand).
      const valid: any[] = [];
      const invalid: InvalidOrder[] = [];
      for (const o of eligible) {
        const res = validateOrderForFulfilment(o);
        if (res.ok) valid.push(o); else invalid.push({ order: o, missing: res.missing });
      }

      const ctx = { isSelected, readyByStr, heldBackPostponed };
      if (invalid.length > 0) {
        // Hand off to the dialog: "Fix first" (cancel) or "Export valid (N)".
        // The continuation lives in handleExportValidOnly.
        setExportValidation({ valid, invalid, ctx });
        return;
      }
      await runFulfilmentExport(eligible, { ...ctx, heldBackInvalid: 0 });
    } catch (err: any) {
      toast({ title: t('ordersPage.exportFailed'), description: err?.message || t('common.unknownError'), variant: 'destructive' });
    } finally {
      setFulfilLoading(false);
    }
  };

  const exportXLSX = async () => {
    const XLSX = await import('xlsx');
    const rows = filteredOrders.map(o => {
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
        'COD AMOUNT': Number(o.price),
        'PRODUCT': items,
        'CONFIRMED BY': o.confirmed_by_name || o.last_action_by || o.assigned_agent_name || '',
        'SOURCE': o.source_type === 'monadon_legacy' ? 'MONADLIST'
          : o.source_type === 'altercpa' ? 'AlterCPA'
          : o.source_type === 'import' ? 'Import'
          : o.source_type === 'affiliate' ? 'Affiliate'
          : o.source_type === 'opencart' ? 'naturatherapy.mk'
          : o.source_type === 'opencart_abandoned' ? 'naturatherapy.mk (abandoned)'
          : o.source_type === 'inbound_lead' ? 'Webhook'
          : o.source_type === 'prediction_lead' ? 'Lead'
          : (o.source_type || 'manual'),
        'DATE': new Date(o.created_at).toLocaleDateString(),
      };
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Orders');
    XLSX.writeFile(wb, `orders_export_${format(new Date(), 'yyyy-MM-dd')}.xlsx`);
  };

  return (
    <AppLayout title={t('nav.orders')}>
      {/* Filter Bar */}
      <div className="sticky top-0 z-10 mb-4 space-y-3">
        <div className="rounded-xl border bg-card/80 backdrop-blur-sm p-3 shadow-sm">
          <div className="flex items-center gap-2.5 overflow-x-auto pb-1 scrollbar-thin md:flex-wrap md:overflow-visible">
            <div className="relative flex-1 min-w-[140px] max-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input placeholder={t('ordersPage.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 pl-8 text-sm rounded-lg bg-background" />
            </div>

            {isMobile && (
              <Sheet>
                <SheetTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg text-sm font-normal">
                    <Filter className="h-3.5 w-3.5" /> {t('ordersPage.filters')}
                    {hasActiveFilters && <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">!</span>}
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" className="h-[80vh] overflow-y-auto">
                  <SheetHeader>
                    <SheetTitle>{t('ordersPage.filters')}</SheetTitle>
                  </SheetHeader>
                  <div className="space-y-4 py-4">
                    {/* Status, Assignee, My Orders, Date, Price will be duplicated here for mobile sheet. For simplicity in this fix, the popovers are still available but this button hints; full extraction would duplicate controls. */}
                    <div className="text-xs text-muted-foreground">{t('ordersPage.mobileSheetHint')}</div>
                    {/* To fully implement, extract FilterControls component and render here + desktop. For now, this + responsive fixes viewport. */}
                  </div>
                </SheetContent>
              </Sheet>
            )}

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg text-sm font-normal">
                  <Filter className="h-3.5 w-3.5" /> Status
                  {selectedStatuses.length > 0 && <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">{selectedStatuses.length}</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-2" align="start">
                <div className="space-y-1">
                  {(isAdmin ? [...ALL_STATUSES, 'duplicated' as OrderStatus] : ALL_STATUSES).map(s => (
                    <button key={s} onClick={() => toggleStatus(s)} className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors', selectedStatuses.includes(s) ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-foreground')}>
                      <div className={cn('h-3.5 w-3.5 rounded border-2 flex items-center justify-center transition-colors', selectedStatuses.includes(s) ? 'border-primary bg-primary' : 'border-muted-foreground/30')}>
                        {selectedStatuses.includes(s) && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                      </div>
                      <span className={cn('inline-flex items-center rounded-full border px-3 py-0 text-[11px] font-semibold leading-4', STATUS_CHIP_COLORS[s])}>{statusLabel(s)}</span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {/* Source filter — isolate affiliate/lead clients from prediction-list clients */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg text-sm font-normal">
                  <Filter className="h-3.5 w-3.5" /> {t('ordersPage.colSource')}
                  {sourceFilter !== 'all' && <span className="ml-1 h-2 w-2 rounded-full bg-primary" />}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-2" align="start">
                <div className="space-y-1">
                  {([
                    ['all', t('ordersPage.allSources')],
                    // AlterCPA is THIS market's lead source and `import` is the
                    // 80k-row history — both were missing, so the two biggest
                    // populations in the table could not be filtered at all.
                    ['altercpa', t('ordersPage.sourceAltercpa')],
                    ['import', t('ordersPage.sourceImport')],
                    ['affiliate', t('ordersPage.sourceAffiliate')],
                    ['opencart', t('ordersPage.sourceSite')],
                    ['inbound_lead', t('ordersPage.sourceWebhook')],
                    ['prediction_lead', t('ordersPage.sourceLead')],
                    ['monadon_legacy', 'MONADLIST'],
                  ] as [string, string][]).map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => setSourceFilter(val)}
                      className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors', sourceFilter === val ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted text-foreground')}
                    >
                      <div className={cn('h-3.5 w-3.5 rounded-full border-2 flex items-center justify-center', sourceFilter === val ? 'border-primary' : 'border-muted-foreground/30')}>
                        {sourceFilter === val && <div className="h-1.5 w-1.5 rounded-full bg-primary" />}
                      </div>
                      {label}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {isAdmin && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg text-sm font-normal">
                    <User className="h-3.5 w-3.5" />
                    {agentFilter === 'all' ? 'Assignee' : (agentsData || []).find((a: any) => a.user_id === agentFilter)?.full_name || 'Assignee'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-56 p-2" align="start">
                  <div className="space-y-0.5 max-h-60 overflow-y-auto">
                    <button onClick={() => setAgentFilter('all')} className={cn('flex w-full rounded-lg px-3 py-2 text-sm transition-colors', agentFilter === 'all' ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted')}>{t('ordersPage.allUsers')}</button>
                    {(agentsData || []).map((a: any) => (
                      <button key={a.user_id} onClick={() => setAgentFilter(a.user_id)} className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors', agentFilter === a.user_id ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted')}>
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary shrink-0">{a.full_name?.charAt(0)?.toUpperCase() || '?'}</span>
                        <span className="flex-1 text-left">{a.full_name}</span>
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}

            {/* My Orders toggle */}
            <Button
              variant={myOrdersOnly ? 'default' : 'outline'}
              size="sm"
              className="h-9 gap-1.5 rounded-lg text-sm font-normal"
              onClick={() => !isAgent && setMyOrdersOnly(!myOrdersOnly)}
              disabled={isAgent}
            >
              <User className="h-3.5 w-3.5" />
              {t('ordersPage.myOrders')}
            </Button>

            <Popover>
              <PopoverTrigger asChild><Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg text-sm font-normal"><CalendarIcon className="h-3.5 w-3.5" />{dateFrom ? formatDate(dateFrom, 'MMM d') : t('ordersPage.from')}</Button></PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start"><Calendar mode="single" selected={dateFrom} onSelect={setDateFrom} className="p-3 pointer-events-auto" /></PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild><Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg text-sm font-normal"><CalendarIcon className="h-3.5 w-3.5" />{dateTo ? formatDate(dateTo, 'MMM d') : t('ordersPage.to')}</Button></PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start"><Calendar mode="single" selected={dateTo} onSelect={setDateTo} className="p-3 pointer-events-auto" /></PopoverContent>
            </Popover>

            {/* Price filter */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg text-sm font-normal">
                  <Euro className="h-3.5 w-3.5" />
                  {priceLabel || t('ordersPage.price')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 p-2" align="start">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-2 pt-1 pb-1.5">{t('ordersPage.quickFilters')}</div>
                <div className="space-y-0.5">
                  {[
                    // Thresholds are chosen as round DENAR figures and converted
                    // to the EUR the API filters on, so the menu reads 500 ден
                    // rather than the 615 ден that a €10 preset would produce.
                    { label: t('ordersPage.anyPrice'), min: null, max: null },
                    { label: '500 ден +', min: denToEur(500), max: null },
                    { label: '1.000 ден +', min: denToEur(1000), max: null },
                    { label: '2.000 ден +', min: denToEur(2000), max: null },
                    { label: '5.000 ден +', min: denToEur(5000), max: null },
                  ].map(p => {
                    const active = priceMin === p.min && priceMax === p.max;
                    return (
                      <button
                        key={p.label}
                        onClick={() => applyPricePreset(p.min, p.max)}
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors',
                          active ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted'
                        )}
                      >
                        <span>{p.label}</span>
                        {active && <Check className="h-3.5 w-3.5" />}
                      </button>
                    );
                  })}
                </div>
                <div className="border-t my-2" />
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-2 pb-1.5">{t('ordersPage.customRange')}</div>
                <div className="flex items-center gap-1.5 px-2 pb-2">
                  <Input
                    type="number"
                    inputMode="decimal"
                    placeholder={t('ordersPage.min')}
                    value={priceMinDraft}
                    onChange={(e) => setPriceMinDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyPriceCustom(); }}
                    className="h-8 text-sm"
                  />
                  <span className="text-xs text-muted-foreground">–</span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    placeholder={t('ordersPage.max')}
                    value={priceMaxDraft}
                    onChange={(e) => setPriceMaxDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyPriceCustom(); }}
                    className="h-8 text-sm"
                  />
                </div>
                <Button size="sm" className="w-full h-8 text-xs" onClick={applyPriceCustom}>{t('ordersPage.applyRange')}</Button>
              </PopoverContent>
            </Popover>

            {hasActiveFilters && <Button variant="ghost" size="sm" className="h-9 text-xs text-muted-foreground hover:text-foreground" onClick={clearAllFilters}>{t('ordersPage.clearAll')}</Button>}

            {/* Daily fulfilment export — independent of the page filters. */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="ml-auto h-9 gap-1.5 rounded-lg text-sm"><Truck className="h-3.5 w-3.5" /> {t('ordersPage.fulfilmentCsv')}</Button>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-3 space-y-3" align="end">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{t('ordersPage.dailyFulfilment')}</div>
                  <p className="text-[11px] text-muted-foreground mb-3">{t('ordersPage.fulfilmentDesc')}</p>
                </div>
                {/* Source: whole date range, or only the hand-picked orders. */}
                <div className="grid grid-cols-2 gap-1">
                  <Button variant={fulfilSource === 'range' ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setFulfilSource('range')}>{t('ordersPage.byDateRange')}</Button>
                  <Button variant={fulfilSource === 'selected' ? 'default' : 'outline'} size="sm" className="h-7 text-xs" onClick={() => setFulfilSource('selected')}>{t('ordersPage.selectedCount', { count: selectedExport.size })}</Button>
                </div>
                {fulfilSource === 'range' ? (
                <>
                <div className="grid grid-cols-2 gap-2">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs justify-start font-normal"><CalendarIcon className="h-3 w-3" />{t('ordersPage.from')}: {fulfilFrom ? formatDate(fulfilFrom, 'MMM d') : '—'}</Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start"><Calendar mode="single" selected={fulfilFrom} onSelect={setFulfilFrom} className="p-3 pointer-events-auto" /></PopoverContent>
                  </Popover>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs justify-start font-normal"><CalendarIcon className="h-3 w-3" />To: {fulfilTo ? format(fulfilTo, 'MMM d') : '—'}</Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start"><Calendar mode="single" selected={fulfilTo} onSelect={setFulfilTo} className="p-3 pointer-events-auto" /></PopoverContent>
                  </Popover>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{t('ordersPage.colStatus')}</div>
                  <div className="grid grid-cols-3 gap-1">
                    {(['confirmed', 'shipped', 'paid'] as OrderStatus[]).map(s => (
                      <Button
                        key={s}
                        variant={fulfilStatus === s ? 'default' : 'outline'}
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setFulfilStatus(s)}
                      >
                        {statusLabel(s)}
                      </Button>
                    ))}
                  </div>
                </div>

                {/* Ship-eligibility cutoff. Orders postponed past this date
                    drop out of today's CSV and surface naturally on their
                    actual ship date. Default = today + 2 days. */}
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{t('ordersPage.readyToShipBy')}</div>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="w-full h-8 gap-1.5 text-xs justify-start font-normal">
                        <CalendarIcon className="h-3 w-3" />
                        {readyByDate ? format(readyByDate, 'EEE, MMM d') : 'Any date'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar mode="single" selected={readyByDate} onSelect={setReadyByDate} className="p-3 pointer-events-auto" />
                      <div className="flex items-center justify-between gap-1 px-2 pb-2">
                        <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setReadyByDate(new Date())}>{t('ordersPage.today')}</Button>
                        <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setReadyByDate(addDays(new Date(), 2))}>+2 days</Button>
                        <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setReadyByDate(addDays(new Date(), 7))}>+7 days</Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-tight">
                    Orders postponed past this date are skipped — they'll appear on their scheduled ship day.
                  </p>
                </div>
                </>
                ) : (
                <div className="rounded-md border bg-muted/30 p-2 text-[11px] space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-foreground">{selectedExport.size} order{selectedExport.size !== 1 ? 's' : ''} selected</span>
                    {selectedExport.size > 0 && <button type="button" onClick={clearExportSelect} className="text-muted-foreground hover:text-foreground underline">{t('common.clear')}</button>}
                  </div>
                  <p className="text-muted-foreground leading-tight">{t('ordersPage.tickOrdersHint')}</p>
                </div>
                )}
                {/* Auto-flip toggle — only meaningful when exporting confirmed
                    orders (the warehouse hand-off step). For shipped/paid
                    re-exports it's disabled and forced off. Hidden for roles
                    that can't perform the bulk status update server-side. */}
                {canBulkUpdateStatus && (() => {
                  const flipEligible = fulfilSource === 'selected' ? selectedHasConfirmed : fulfilStatus === 'confirmed';
                  return (
                  <label className={cn(
                    'flex items-start gap-2 rounded-md border p-2 text-[11px]',
                    flipEligible ? 'cursor-pointer hover:bg-muted/40' : 'opacity-50 cursor-not-allowed',
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
                          ? 'After the CSV downloads, every exported confirmed order moves → shipped.'
                          : (fulfilSource === 'selected' ? 'None of the selected orders are confirmed.' : 'Only available when exporting confirmed orders.')}
                      </div>
                    </div>
                  </label>
                  );
                })()}

                <Button size="sm" className="w-full h-8 gap-1.5" onClick={exportFulfilmentCSV} disabled={fulfilLoading || (fulfilSource === 'selected' && selectedExport.size === 0)}>
                  {fulfilLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  Export CSV
                </Button>
              </PopoverContent>
            </Popover>

            <BigArenaStatusSync onSuccess={() => fetchOrders()} />

            <Button onClick={exportXLSX} size="sm" variant="outline" className="h-9 gap-1.5 rounded-lg text-sm"><Download className="h-3.5 w-3.5" /> {t('ordersPage.exportView')}</Button>
            <Button onClick={() => setShowCreateModal(true)} size="sm" className="h-9 gap-1.5 rounded-lg text-sm"><Plus className="h-3.5 w-3.5" /> {t('common.createOrder')}</Button>
          </div>
        </div>

        {hasActiveFilters && (
          <div className="flex flex-wrap items-center gap-1.5 px-1">
            {selectedStatuses.map(s => <Badge key={s} variant="secondary" className={cn('gap-1 cursor-pointer border text-xs', STATUS_CHIP_COLORS[s])} onClick={() => toggleStatus(s)}>{statusLabel(s)}<X className="h-3 w-3" /></Badge>)}
            {agentFilter !== 'all' && <Badge variant="secondary" className="gap-1 cursor-pointer text-xs" onClick={() => setAgentFilter('all')}>{t('ordersPage.assigneeChip', { name: (agentsData || []).find((a: any) => a.user_id === agentFilter)?.full_name || agentFilter.slice(0, 8) })}<X className="h-3 w-3" /></Badge>}
            {dateFrom && <Badge variant="secondary" className="gap-1 cursor-pointer text-xs" onClick={() => setDateFrom(undefined)}>{t('ordersPage.fromChip', { date: formatDate(dateFrom, 'MMM d') })}<X className="h-3 w-3" /></Badge>}
            {dateTo && <Badge variant="secondary" className="gap-1 cursor-pointer text-xs" onClick={() => setDateTo(undefined)}>{t('ordersPage.toChip', { date: formatDate(dateTo, 'MMM d') })}<X className="h-3 w-3" /></Badge>}
            {priceLabel && <Badge variant="secondary" className="gap-1 cursor-pointer text-xs" onClick={() => applyPricePreset(null, null)}>{t('ordersPage.priceChip', { label: priceLabel })}<X className="h-3 w-3" /></Badge>}
            {search.trim() && <Badge variant="secondary" className="gap-1 cursor-pointer text-xs" onClick={() => setSearch('')}>"{search}"<X className="h-3 w-3" /></Badge>}
            <span className="ml-auto text-xs text-muted-foreground">{t('ordersPage.ofOrders', { shown: filteredOrders.length, total })}</span>
          </div>
        )}
      </div>

      {selectedExport.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-1 text-xs">
          <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 font-medium">{t('ordersPage.nSelectedForExport', { count: selectedExport.size })}</span>
          <button type="button" onClick={clearExportSelect} className="text-muted-foreground hover:text-foreground underline">{t('common.clear')}</button>
          {canDisposeOrders && disposableSelected.length > 0 && (
            <>
              <span className="text-muted-foreground/50">|</span>
              <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={() => openDisposition('trashed')}>
                <Trash2 className="h-3.5 w-3.5" />
                {t('ordersPage.bulkTrash', { count: disposableSelected.length })}
              </Button>
              <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={() => openDisposition('cancelled')}>
                <Ban className="h-3.5 w-3.5" />
                {t('ordersPage.bulkCancel', { count: disposableSelected.length })}
              </Button>
            </>
          )}
          {cpaPushEnabled && cpaPushableSelected.length > 0 && (
            <>
              <span className="text-muted-foreground/50">|</span>
              <Button
                size="sm" variant="outline" className="h-7 gap-1.5 text-xs"
                onClick={() => setCpaBulk({ eligible: cpaPushableSelected, skipped: selectedExport.size - cpaPushableSelected.length })}
              >
                <Send className="h-3.5 w-3.5" />
                {t('ordersPage.cpaBulkSend', { count: cpaPushableSelected.length })}
              </Button>
            </>
          )}
          <span className="text-muted-foreground">{t('ordersPage.openPrefix')} <span className="font-medium text-foreground">{t('ordersPage.fulfilSelectedPath')}</span> {t('ordersPage.openSuffix')}</span>
        </div>
      )}

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
                ? t('ordersPage.bulkDispositionPartial', {
                    count: disposableSelected.length,
                    total: selectedExport.size,
                  })
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
            />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDispositionAction(null)} disabled={dispBusy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={runDisposition} disabled={!dispositionValid || dispBusy || disposableSelected.length === 0}>
              {dispBusy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {dispositionAction === 'trashed'
                ? t('ordersPage.bulkTrash', { count: disposableSelected.length })
                : t('ordersPage.bulkCancel', { count: disposableSelected.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Table — desktop */}
      <div className="hidden md:block overflow-x-auto rounded-xl border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-3 w-10">
                  <Checkbox
                    checked={filteredOrders.length > 0 && filteredOrders.every(o => selectedExport.has(o.id)) ? true : (filteredOrders.some(o => selectedExport.has(o.id)) ? 'indeterminate' : false)}
                    onCheckedChange={() => {
                      const allSel = filteredOrders.length > 0 && filteredOrders.every(o => selectedExport.has(o.id));
                      setSelectedExport(prev => {
                        const next = new Map(prev);
                        if (allSel) filteredOrders.forEach(o => next.delete(o.id));
                        else filteredOrders.forEach(o => next.set(o.id, o));
                        return next;
                      });
                    }}
                    aria-label={t('ordersPage.selectAllOrders')}
                  />
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colStatus')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colOrderId')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colCustomer')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colProduct')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colQty')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colTotalPrice')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground" title={t('ordersPage.confirmedByTitle')}>
                  {t('ordersPage.colConfirmedBy')}
                </th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colSource')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colDate')}</th>
                <th className="px-4 py-3 w-10"><span className="sr-only">{t('common.actions')}</span></th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map(order => {
                const isExpanded = expandedIds.has(order.id);
                return (
                  <Fragment key={order.id}>
                    <tr 
                      className="border-b last:border-0 hover:bg-muted/30 transition-colors cursor-pointer" 
                      onClick={() => toggleRowExpansion(order.id)}
                    >
                  <td className="px-3 py-3" onClick={e => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedExport.has(order.id)}
                      onCheckedChange={() => toggleExportSelect(order)}
                      aria-label={t('ordersPage.selectOrderForExport', { id: order.display_id })}
                    />
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={order.status} order={order} /></td>
                  <td className="px-4 py-3 font-mono text-xs font-semibold">
                    {order.display_id}
                    {order.duplicated_from && (
                      <Badge
                        variant="outline"
                        className="ml-1.5 text-[9px] px-1 py-0 border-indigo-400 text-indigo-600 dark:text-indigo-400 cursor-pointer whitespace-nowrap"
                        onClick={(e) => { e.stopPropagation(); if (order.duplicated_from_display) setSearch(order.duplicated_from_display); }}
                      >
                        {t('ordersPage.duplicateOf', { id: order.duplicated_from_display || '?' })}
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span>{order.customer_name}</span>
                    {getPhoneDupCount(order.customer_phone) > 1 && (
                      <Badge variant="destructive" className="ml-1.5 text-[9px] px-1 py-0 cursor-pointer" onClick={(e) => { e.stopPropagation(); setSearch(order.customer_phone); }}>
                        {getPhoneDupCount(order.customer_phone)}x
                      </Badge>
                    )}
                    <ActiveViewBadge phone={order.customer_phone} className="ml-2" />
                  </td>
                  <td className="px-4 py-3" title={productLabelTitle(order)}>{productLabel(order)}</td>
                  <td className="px-4 py-3 text-center">{order.quantity || 1}</td>
                  <td className="px-4 py-3">
                    <div className="font-bold text-primary leading-tight">{formatMoney(order.price)}</div>
                  </td>
                  <td className="px-4 py-3">
                    {(order.confirmed_by_name || order.last_action_by || order.assigned_agent_name) ? (
                      <span className="inline-flex items-center gap-1.5" title={order.confirmed_by_name ? 'Original sales credit (immutable after first confirm)' : 'Last actor / assigned (no confirmed_by yet)'}>
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                          {(order.confirmed_by_name || order.last_action_by || order.assigned_agent_name)!.charAt(0)}
                        </span>
                        {order.confirmed_by_name || order.last_action_by || order.assigned_agent_name}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={order.source_type === 'monadon_legacy' ? 'destructive' : order.source_type === 'prediction_lead' || order.source_type === 'inbound_lead' || order.source_type === 'opencart' || order.source_type === 'opencart_abandoned' || order.source_type === 'affiliate' || order.source_type === 'altercpa' ? 'secondary' : 'outline'} className="text-[10px]">
                      {order.source_type === 'monadon_legacy' ? 'MONADLIST'
                        : order.source_type === 'altercpa' ? t('ordersPage.sourceAltercpa')
                        : order.source_type === 'import' ? t('ordersPage.sourceImport')
                        : order.source_type === 'affiliate' ? t('ordersPage.sourceAffiliate')
                        : order.source_type === 'prediction_lead' ? t('ordersPage.sourceLead')
                        : order.source_type === 'inbound_lead' ? t('ordersPage.sourceWebhook')
                        : order.source_type === 'opencart' ? t('ordersPage.sourceSite')
                        : order.source_type === 'opencart_abandoned' ? t('ordersPage.sourceSiteAbandoned')
                        : t('ordersPage.sourceManual')}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <div className="leading-tight">
                      <div>{new Date(order.created_at).toLocaleDateString()}</div>
                      <div className="text-xs text-muted-foreground/70 tabular-nums">{new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                  </td>
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setHistoryOrder({ phone: order.customer_phone, name: order.customer_name })}>
                          <History className="h-3.5 w-3.5 mr-2" /> {t('ordersPage.seeHistory')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => { setSearch(order.customer_phone); }}>
                          <Copy className="h-3.5 w-3.5 mr-2" /> {t('ordersPage.viewDuplicates')}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => tryOpenOrder(order)}>
                          <Lock className="h-3.5 w-3.5 mr-2" /> {t('ordersPage.openOrder')}
                        </DropdownMenuItem>
                        {isAdmin && (
                          <DropdownMenuItem disabled={duplicatingId !== null} onClick={() => handleDuplicateOrder(order)}>
                            <CopyPlus className="h-3.5 w-3.5 mr-2" /> {t('ordersPage.duplicateOrder')}
                          </DropdownMenuItem>
                        )}
                        {canPushCpa(order) && (
                          <DropdownMenuItem disabled={cpaLoadingId !== null} onClick={() => handleCpaPreview(order)}>
                            <Send className="h-3.5 w-3.5 mr-2" /> {t('ordersPage.pushCpa')}
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>

                {/* Expanded rich details row */}
                {isExpanded && (
                  <tr className="bg-muted/40 border-b">
                    <td colSpan={11} className="p-0">
                      <div className="px-6 py-5 text-sm border-l-4 border-primary/70 bg-background/50">
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-4">

                          {/* Customer */}
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{t('ordersPage.customerSection')}</div>
                            <div className="font-medium text-base">{order.customer_name || '—'}</div>
                            <div className="font-mono text-xs text-muted-foreground mt-0.5">{order.customer_phone}</div>
                            <div className="text-xs mt-1 leading-tight">
                              {order.customer_address}<br />
                              {order.customer_city}{order.postal_code ? `, ${order.postal_code}` : ''}
                            </div>
                          </div>

                          {/* Order Info & Timing */}
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{t('ordersPage.orderInfoSection')}</div>
                            <div className="space-y-0.5 text-sm">
                              <div><span className="text-muted-foreground">{t('ordersPage.created')}</span> {new Date(order.created_at).toLocaleString()}</div>
                              <div><span className="text-muted-foreground">{t('ordersPage.statusField')}</span> <span className="font-medium">{statusLabel(order.status)}</span></div>
                              {order.source_type && (
                                <div><span className="text-muted-foreground">{t('ordersPage.sourceField')}</span> {order.source_type}</div>
                              )}
                              {order.ship_after_date && (
                                <div><span className="text-muted-foreground">{t('ordersPage.shipAfterField')}</span> {new Date(order.ship_after_date).toLocaleDateString()}</div>
                              )}
                            </div>
                          </div>

                          {/* Agent */}
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{t('ordersPage.agentSection')}</div>
                            <div className="text-sm">
                              {order.assigned_agent_name || order.last_action_by || order.confirmed_by_name || '—'}
                            </div>
                            {order.confirmed_by_name && order.assigned_agent_name !== order.confirmed_by_name && (
                              <div className="text-[11px] text-muted-foreground mt-0.5">
                                {t('ordersPage.salesCredit', { name: order.confirmed_by_name })}
                              </div>
                            )}
                          </div>

                          {/* Status-specific rich info */}
                          {(order.status === 'cancelled' || order.status === 'trashed') && (
                            <div className="md:col-span-2 lg:col-span-3 pt-3 border-t">
                              <div className="text-[10px] font-semibold uppercase tracking-wider text-rose-600 mb-1.5">
                                {order.status === 'cancelled' ? t('ordersPage.cancellationReason') : t('ordersPage.trashReason')}
                              </div>
                              <div className="text-sm bg-rose-50 dark:bg-rose-950/30 p-3 rounded-md border border-rose-200 dark:border-rose-900 whitespace-pre-line">
                                {orderReasonText(order) || t('ordersPage.noReasonRecorded')}
                              </div>
                            </div>
                          )}

                          {DELIVERY_STATUSES.includes(order.status) && (
                            <div className="md:col-span-2 lg:col-span-3 pt-3 border-t grid grid-cols-1 lg:grid-cols-3 gap-x-8 gap-y-4">
                              <div>
                                <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600 mb-1.5">{t('ordersPage.deliveryDetails')}</div>
                                <div className="text-sm space-y-1">
                                  <div>
                                    <span className="text-muted-foreground">{t('ordersPage.sentBy')}</span>{' '}
                                    {(() => {
                                      const dt = order.delivery_type;
                                      if (dt === 'speedy_office') return t('ordersPage.speedyOffice');
                                      if (dt === 'econt_office') return t('ordersPage.econtOffice');
                                      if (dt === 'mex_office') return t('ordersPage.mexOffice');
                                      const hc = order.home_courier === 'speedy' ? 'Speedy'
                                        : order.home_courier === 'econt' ? 'Econt' : null;
                                      return hc ? t('ordersPage.homeDoor', { courier: hc }) : (dt ? dt.replace(/_/g, ' ') : t('ordersPage.notSpecified'));
                                    })()}
                                    {order.courier_office_name && ` → ${order.courier_office_name}`}
                                  </div>
                                </div>
                              </div>
                              {showCallsPanel && (
                                <div className="lg:col-span-2">
                                  <OrderCallsPanel orderId={order.id} />
                                </div>
                              )}
                            </div>
                          )}

                          {/* Calls panel for statuses without a delivery section
                              (pending/call_again/cancelled/trashed — hearing what
                              went wrong is exactly the point). */}
                          {showCallsPanel && !DELIVERY_STATUSES.includes(order.status) && (
                            <div className="md:col-span-2 lg:col-span-3 pt-3 border-t">
                              <OrderCallsPanel orderId={order.id} />
                            </div>
                          )}

                          {/* Products */}
                          <div className="md:col-span-2 lg:col-span-3 pt-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{t('ordersPage.productsSection')}</div>
                            {order.order_items && order.order_items.length > 0 ? (
                              <div className="text-sm">
                                {order.order_items.map((item: any, idx: number) => (
                                  <div key={idx}>
                                    {item.product_name || '—'} × {item.quantity || 1}
                                    {item.price_per_unit && ` ${t('ordersPage.each', { price: formatMoney(item.price_per_unit) })}`}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-sm">{order.product_name || '—'} × {order.quantity || 1}</div>
                            )}
                          </div>

                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
              {filteredOrders.length === 0 && (
                <tr>
                  <td colSpan={10} className="p-0">
                    <EmptyState
                      icon={<Package className="h-5 w-5" />}
                      title={t('ordersPage.noOrdersFound')}
                      description={hasActiveFilters ? t('ordersPage.noOrdersMatch') : t('ordersPage.ordersAppearHere')}
                      size="sm"
                      className="border-0 bg-transparent hover:shadow-none"
                      action={hasActiveFilters ? (
                        <Button variant="outline" size="sm" onClick={clearAllFilters}>{t('ordersPage.clearFilters')}</Button>
                      ) : undefined}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Cards — mobile */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : filteredOrders.length === 0 ? (
          <EmptyState
            icon={<Package className="h-5 w-5" />}
            title={t('ordersPage.noOrdersFound')}
            description={hasActiveFilters ? t('ordersPage.noOrdersMatch') : t('ordersPage.ordersAppearHere')}
            size="sm"
            action={hasActiveFilters ? <Button variant="outline" size="sm" onClick={clearAllFilters}>{t('ordersPage.clearFilters')}</Button> : undefined}
          />
        ) : filteredOrders.map(order => {
          const isExpanded = expandedIds.has(order.id);
          const sourceLabel = order.source_type === 'monadon_legacy' ? 'MONADLIST'
            : order.source_type === 'altercpa' ? 'AlterCPA'
            : order.source_type === 'import' ? 'Import'
            : order.source_type === 'affiliate' ? 'Affiliate'
            : order.source_type === 'prediction_lead' ? 'Lead'
            : order.source_type === 'inbound_lead' ? 'Webhook'
            : order.source_type === 'opencart' ? 'Site'
            : order.source_type === 'opencart_abandoned' ? 'Site · abandoned'
            : 'Manual';
          const confirmedBy = order.confirmed_by_name || order.last_action_by || order.assigned_agent_name;
          return (
            <MobileCard key={order.id}>
              <div className="flex items-start gap-2">
                <Checkbox
                  className="mt-1 shrink-0"
                  checked={selectedExport.has(order.id)}
                  onCheckedChange={() => toggleExportSelect(order)}
                  aria-label={t('ordersPage.selectOrderForExport', { id: order.display_id })}
                />
                <div className="min-w-0 flex-1">
                  <MobileCardHeader
                    title={
                      <span className="flex items-center gap-1.5">
                        {order.customer_name}
                        {getPhoneDupCount(order.customer_phone) > 1 && (
                          <Badge variant="destructive" className="text-[9px] px-1 py-0" onClick={(e) => { e.stopPropagation(); setSearch(order.customer_phone); }}>
                            {getPhoneDupCount(order.customer_phone)}x
                          </Badge>
                        )}
                        <ActiveViewBadge phone={order.customer_phone} />
                      </span>
                    }
                    subtitle={order.customer_phone}
                    badge={<StatusBadge status={order.status} order={order} />}
                  />
                </div>
              </div>
              <MobileCardField
                label={t('ordersPage.colOrderId')}
                value={
                  <span className="font-mono">
                    {order.display_id}
                    {order.duplicated_from && (
                      <Badge variant="outline" className="ml-1.5 text-[9px] px-1 py-0 border-indigo-400 text-indigo-600 dark:text-indigo-400" onClick={(e) => { e.stopPropagation(); if (order.duplicated_from_display) setSearch(order.duplicated_from_display); }}>
                        {t('ordersPage.duplicateOf', { id: order.duplicated_from_display || '?' })}
                      </Badge>
                    )}
                  </span>
                }
              />
              <MobileCardField label={t('ordersPage.colProduct')} value={productLabel(order)} />
              <MobileCardField label={t('ordersPage.colQty')} value={order.quantity || 1} />
              <MobileCardField label={t('createOrder.total')} value={<>{formatMoney(order.price)}</>} />
              <MobileCardField label={t('ordersPage.colConfirmedBy')} value={confirmedBy || '—'} />
              <MobileCardField label={t('ordersPage.colSource')} value={sourceLabel} />
              <MobileCardField label={t('ordersPage.colDate')} value={`${new Date(order.created_at).toLocaleDateString()}, ${new Date(order.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`} />
              <MobileCardActions>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => tryOpenOrder(order)}>
                  <Lock className="h-3.5 w-3.5" /> {t('ordersPage.openOrder')}
                </Button>
                <Button size="sm" variant="ghost" title={t('ordersPage.seeHistory')} onClick={() => setHistoryOrder({ phone: order.customer_phone, name: order.customer_name })}>
                  <History className="h-3.5 w-3.5" />
                </Button>
                {canPushCpa(order) && (
                  <Button size="sm" variant="ghost" title={t('ordersPage.pushCpa')} disabled={cpaLoadingId !== null} onClick={() => handleCpaPreview(order)}>
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                )}
              </MobileCardActions>
              <Button variant="ghost" size="sm" className="w-full justify-center text-xs text-muted-foreground" onClick={() => toggleRowExpansion(order.id)}>
                <ChevronDown className={cn('h-3.5 w-3.5 mr-1 transition-transform', isExpanded && 'rotate-180')} />
                {isExpanded ? 'Hide details' : 'Details'}
              </Button>
              {isExpanded && (
                <div className="border-t pt-2 space-y-2 text-sm">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{t('ordersPage.addressSection')}</div>
                    <div className="text-xs leading-tight">
                      {order.customer_address}<br />
                      {order.customer_city}{order.postal_code ? `, ${order.postal_code}` : ''}
                    </div>
                  </div>
                  <div className="text-xs"><span className="text-muted-foreground">{t('ordersPage.created')}</span> {new Date(order.created_at).toLocaleString()}</div>
                  {(order as any).ship_after_date && (
                    <div className="text-xs"><span className="text-muted-foreground">{t('ordersPage.shipAfterField')}</span> {new Date((order as any).ship_after_date).toLocaleDateString()}</div>
                  )}
                  {(order.status === 'cancelled' || order.status === 'trashed') && orderReasonText(order) && (
                    <div className="text-xs bg-rose-50 dark:bg-rose-950/30 p-2 rounded-md border border-rose-200 dark:border-rose-900 whitespace-pre-line">
                      {orderReasonText(order)}
                    </div>
                  )}
                  {showCallsPanel && <OrderCallsPanel orderId={order.id} />}
                </div>
              )}
            </MobileCard>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">{t('ordersPage.pageOf', { page, totalPages, total })}</p>
          <SmartPagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </div>
      )}

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
          if (created) fetchOrders();
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
              [t('ordersPage.cpaFieldUnitPrice'), p.base],
              [t('ordersPage.cpaFieldComment'), p.comment],
            ];
            const remote = cpaPreview.preview.remote;
            return (
              <div className="space-y-2">
                <div className="space-y-1 text-sm max-h-72 overflow-y-auto">
                  {rows.filter(([, v]) => v !== undefined && v !== '').map(([label, v]) => (
                    <div key={label} className="flex justify-between gap-3">
                      <span className="text-muted-foreground shrink-0">{label}</span>
                      <span className="text-right break-all">{v}</span>
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
              {cpaSending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
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
              <div className="h-2 w-full rounded bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((cpaBulkProgress.done / Math.max(1, cpaBulkProgress.total)) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground text-center">
                {t('ordersPage.cpaBulkProgress', { done: cpaBulkProgress.done, total: cpaBulkProgress.total })}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={!!cpaBulkProgress} onClick={() => setCpaBulk(null)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={!!cpaBulkProgress} onClick={runCpaBulk}>
              {cpaBulkProgress && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
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
