import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/EmptyState';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppLayout } from '@/layouts/AppLayout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { OrderModal, OrderModalData } from '@/components/OrderModal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/contexts/AuthContext';
// Orders are stored in EUR; the warehouse export reports denars.
import { eurToDen } from '@/lib/currency';
import { usePermissions } from '@/contexts/PermissionsContext';
import { useToast } from '@/hooks/use-toast';
import {
  apiGetProducts,
  apiGetIncomingOrders,
  apiGetAgents,
  apiRestock,
  apiGetStockMovements,
  apiUpdateWarehouseOrder,
  apiDeleteWarehouseOrder,
  apiBulkStatusUpdate,
} from '@/lib/api';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Package,
  PackageCheck,
  Loader2,
  Download,
  Trash2,
  Edit,
  ChevronRight,
  AlertTriangle,
  ArrowUpCircle,
  ArrowDownCircle,
  RotateCcw,
  Truck,
  Search,
  ClipboardList,
  History,
  Archive,
  Boxes,
  TrendingDown,
  DollarSign,
  ShoppingCart,
} from 'lucide-react';
import { format, isToday, parseISO, subDays } from 'date-fns';
import { cn, formatProductWithQuantity } from '@/lib/utils';
import { formatDate } from '@/i18n/dates';
import { apiErrorText } from '@/i18n/apiErrors';

// How many low-stock chips show before the banner collapses behind "+N more".
const LOW_STOCK_PREVIEW = 8;

// Shared by PackingTab and HistoryTab (plain mapper, no hooks).
function orderToModalData(order: any): OrderModalData {
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
    notes: null,
    quantity: order.quantity,
    price: order.price,
    assigned_agent_id: order.assigned_agent_id,
    ship_after_date: order.ship_after_date || null,
    items: (order.order_items || []).map((i: any) => ({
      id: i.id, product_id: i.product_id, product_name: i.product_name,
      quantity: i.quantity, price_per_unit: i.price_per_unit, total_price: i.total_price,
    })),
  };
}

// ─── Packing Tab (За пакување) ─────────────────────────────────
// The warehouse worker's queue: confirmed orders arrive here, get marked packed
// (a substate — status stays 'confirmed'), then shipped when the courier collects.
function PackingTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [agentFilter, setAgentFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [view, setView] = useState<'topack' | 'packed'>('topack');
  const [agents, setAgents] = useState<any[]>([]);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Edit via OrderModal
  const [modalOrder, setModalOrder] = useState<any>(null);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkModalDate, setBulkModalDate] = useState('');
  const [bulkStatus, setBulkStatus] = useState('shipped');
  const [bulkUpdating, setBulkUpdating] = useState(false);

  const queryClient = useQueryClient();

  // React Query for the packing queue. The fetch is hard-fixed to confirmed orders —
  // the to-pack/packed split is a client-side substate (packed_at), one query serves both.
  // After mutations we invalidate the 'warehouse-incoming-orders' prefix, which also
  // refreshes the History tab's query.
  const { data: orders = [], isLoading: loading } = useQuery<any[]>({
    queryKey: ['warehouse-incoming-orders', 'packing', agentFilter, dateFrom, dateTo, sourceFilter],
    queryFn: () =>
      apiGetIncomingOrders({
        agent_id: agentFilter && agentFilter !== 'all' ? agentFilter : undefined,
        from: dateFrom ? dateFrom + 'T00:00:00Z' : undefined,
        to: dateTo ? dateTo + 'T23:59:59Z' : undefined,
        source: sourceFilter && sourceFilter !== 'all' ? sourceFilter : undefined,
        status: 'confirmed',
      }),
    staleTime: 15_000,
  });

  const toPackOrders = useMemo(() => orders.filter((o: any) => !o.packed_at), [orders]);
  const packedOrders = useMemo(() => orders.filter((o: any) => o.packed_at), [orders]);
  const visible = view === 'topack' ? toPackOrders : packedOrders;

  useEffect(() => {
    apiGetAgents().then(setAgents).catch(() => {});
  }, []);

  // Default to a recent window on first mount so we never load the entire history.
  // The backend also has a hard safety default (90 days). This just makes the UI nice.
  useEffect(() => {
    if (!dateFrom) {
      const d = subDays(new Date(), 60); // 60-day sweet spot for daily warehouse work
      setDateFrom(format(d, 'yyyy-MM-dd'));
    }
  }, []); // run once

  const groupedOrders = useMemo(() => {
    const groups: Record<string, any[]> = {};
    for (const o of visible) {
      const dateKey = format(new Date(o.created_at), 'yyyy-MM-dd');
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(o);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [visible]);

  const [openDates, setOpenDates] = useState<Set<string>>(new Set());

  useEffect(() => {
    const todayStr = format(new Date(), 'yyyy-MM-dd');
    setOpenDates(new Set([todayStr]));
  }, []);

  const toggleDate = (date: string) => {
    setOpenDates(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      return next;
    });
  };

  const handleStatusChange = async (orderId: string, source: string, newStatus: string) => {
    if (source === 'prediction_lead_direct') {
      toast({ title: t('wh.cannotChangeStatus'), description: t('wh.noLinkedOrder'), variant: 'destructive' });
      return;
    }
    setUpdatingId(orderId);
    try {
      await apiUpdateWarehouseOrder(orderId, { status: newStatus, _source: source });
      toast({ title: t('wh.statusUpdatedTo', { status: t('status.' + newStatus) }) });
      // Targeted invalidation instead of blind full refetch — React Query will
      // refetch only what's needed with the current filters (and the new indexes make it fast).
      queryClient.invalidateQueries({ queryKey: ['warehouse-incoming-orders'] });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setUpdatingId(null);
    }
  };

  // Pack / unpack — always targets the orders row (_source: 'order'), even for
  // orders that originated from a prediction lead; unconverted leads can't be packed.
  const handlePack = async (o: any, packed: boolean) => {
    if (o.unconverted) {
      toast({ title: t('wh.cannotChangeStatus'), description: t('wh.noLinkedOrder'), variant: 'destructive' });
      return;
    }
    setUpdatingId(o.id);
    try {
      await apiUpdateWarehouseOrder(o.id, { packed, _source: 'order' });
      if (packed) toast({ title: t('wh.markedPacked', { id: o.display_id }) });
      queryClient.invalidateQueries({ queryKey: ['warehouse-incoming-orders'] });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setUpdatingId(null);
    }
  };

  // Ship a packed order — only real orders reach the packed view, so _source is 'order'.
  const handleShip = async (o: any) => {
    setUpdatingId(o.id);
    try {
      await apiUpdateWarehouseOrder(o.id, { status: 'shipped', _source: 'order' });
      toast({ title: t('wh.statusUpdatedTo', { status: t('status.shipped') }) });
      queryClient.invalidateQueries({ queryKey: ['warehouse-incoming-orders'] });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setUpdatingId(null);
    }
  };

  // Bulk selection helpers
  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleDateGroup = (dayOrders: any[]) => {
    const ids = dayOrders.map((o: any) => o.id);
    const allSelected = ids.every(id => selectedIds.has(id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allSelected) ids.forEach(id => next.delete(id));
      else ids.forEach(id => next.add(id));
      return next;
    });
  };

  const openBulkModal = (dateKey: string) => {
    setBulkModalDate(dateKey);
    setBulkStatus('shipped');
    setBulkModalOpen(true);
  };

  const handleBulkUpdate = async () => {
    const dateOrders = visible.filter((o: any) => format(new Date(o.created_at), 'yyyy-MM-dd') === bulkModalDate);
    // If checkboxes selected within that date, use those; otherwise all in date
    const idsInDate = dateOrders.map(o => o.id);
    const selectedInDate = idsInDate.filter(id => selectedIds.has(id));
    const targetIds = selectedInDate.length > 0 ? selectedInDate : idsInDate;

    if (targetIds.length === 0) return;
    setBulkUpdating(true);
    try {
      const result = await apiBulkStatusUpdate(targetIds, bulkStatus);
      toast({ title: t('wh.bulkUpdated', { count: result.updated, status: t('status.' + bulkStatus) }) + (result.skipped > 0 ? ' ' + t('wh.bulkSkipped', { count: result.skipped }) : '') });
      setBulkModalOpen(false);
      setSelectedIds(new Set());
      // Targeted invalidation — same key as the main useQuery so the list + grouping refresh cleanly.
      queryClient.invalidateQueries({ queryKey: ['warehouse-incoming-orders'] });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setBulkUpdating(false);
    }
  };

  const exportCSV = () => {
    if (visible.length === 0) return;
    const headers = [
      'Order_ID', 'Customer_Name', 'Phone', 'Product_List', 'Quantity_Total',
      // Denars, and the currency is named in the header. The column used to be a
      // bare EUR figure with no currency anywhere in the file, which is exactly
      // the ambiguity codFor() exists to prevent on the courier hand-off.
      'Total_Price_MKD', 'Status', 'Agent', 'Source', 'Address', 'City', 'Postal_Code', 'Created_At',
    ];
    const esc = (v: string) => `"${(v || '').replace(/"/g, '""')}"`;
    const rows = visible.map((o: any) => {
      // Build product list from order_items if available
      const items = o.order_items && o.order_items.length > 0 ? o.order_items : null;
      let productList = '';
      let qtyTotal = 0;
      if (items) {
        productList = items.map((i: any) => formatProductWithQuantity(i.product_name, i.quantity)).join(' | ');
        qtyTotal = items.reduce((s: number, i: any) => s + (i.quantity || 0), 0);
      } else {
        productList = o.product_name || '';
        qtyTotal = o.quantity || 1;
      }
      return [
        o.display_id,
        esc(o.customer_name),
        o.customer_phone || '',
        esc(productList),
        qtyTotal,
        eurToDen(o.price || 0),
        o.status || '',
        o.assigned_agent_name || '',
        o.source === 'prediction_lead' ? 'Prediction Lead' : 'Standard Order',
        esc(o.customer_address),
        esc(o.customer_city),
        o.postal_code || '',
        format(new Date(o.created_at), 'yyyy-MM-dd HH:mm'),
      ].join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `warehouse_orders_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const allStatuses = [
    { value: 'pending', color: 'bg-muted' },
    { value: 'take', color: 'bg-blue-500' },
    { value: 'call_again', color: 'bg-orange-500' },
    { value: 'confirmed', color: 'bg-yellow-500' },
    { value: 'shipped', color: 'bg-green-500' },
    { value: 'delivered', color: 'bg-sky-500' },
    { value: 'paid', color: 'bg-purple-500' },
    { value: 'returned', color: 'bg-red-500' },
    { value: 'trashed', color: 'bg-muted' },
    { value: 'cancelled', color: 'bg-muted' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="w-48"><SelectValue placeholder={t('wh.allAgents')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('wh.allAgents')}</SelectItem>
            {agents.map((a: any) => <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-48"><SelectValue placeholder={t('wh.allSources')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('wh.allSources')}</SelectItem>
            <SelectItem value="order">{t('wh.standardOrders')}</SelectItem>
            <SelectItem value="prediction_lead">{t('wh.predictionLeads')}</SelectItem>
          </SelectContent>
        </Select>
        {/* Quick date presets — the real "ultra-fast" control. Backend also protects. */}
        <div className="flex items-center gap-1 text-xs">
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => { const d = subDays(new Date(), 7); setDateFrom(format(d, 'yyyy-MM-dd')); setDateTo(''); }}>7d</Button>
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => { const d = subDays(new Date(), 30); setDateFrom(format(d, 'yyyy-MM-dd')); setDateTo(''); }}>30d</Button>
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => { const d = subDays(new Date(), 90); setDateFrom(format(d, 'yyyy-MM-dd')); setDateTo(''); }}>90d</Button>
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => {
            setDateFrom(''); setDateTo('');
            toast({ title: t('wh.allTime'), description: t('wh.allTimeDesc') });
          }}>{t('wh.allTime')}</Button>
        </div>

        <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-40" />
        <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-40" />
        <Button variant="outline" size="sm" onClick={exportCSV} disabled={visible.length === 0}>
          <Download className="h-4 w-4 mr-1" /> {t('wh.exportCsv')}
        </Button>
        <span className="text-sm text-muted-foreground ml-auto">{t('wh.ordersTotal', { count: visible.length })}</span>
      </div>

      {/* To-pack / packed sub-views: same confirmed queue, split on the packed_at substate */}
      <div className="inline-flex rounded-lg border bg-muted/40 p-1 gap-1">
        <button
          onClick={() => { setView('topack'); setSelectedIds(new Set()); }}
          className={cn('flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            view === 'topack' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          <ClipboardList className="h-4 w-4" /> {t('wh.queueToPack')}
          <Badge variant={view === 'topack' ? 'default' : 'secondary'}>{toPackOrders.length}</Badge>
        </button>
        <button
          onClick={() => { setView('packed'); setSelectedIds(new Set()); }}
          className={cn('flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
            view === 'packed' ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}
        >
          <PackageCheck className="h-4 w-4" /> {t('wh.queuePacked')}
          <Badge variant={view === 'packed' ? 'default' : 'secondary'}>{packedOrders.length}</Badge>
        </button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : groupedOrders.length === 0 ? (
        <EmptyState
          title={view === 'topack' ? t('wh.noToPack') : t('wh.noPacked')}
          description={view === 'topack' ? t('wh.noToPackDesc') : t('wh.noPackedDesc')}
          size="md"
        />
      ) : (
        <div className="space-y-2">
          {groupedOrders.map(([dateKey, dayOrders]) => {
            const isOpen = openDates.has(dateKey);
            const dateObj = parseISO(dateKey);
            const isTodayDate = isToday(dateObj);
            return (
              <div key={dateKey} className="rounded-xl border bg-card shadow-sm overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                  <button onClick={() => toggleDate(dateKey)} className="flex items-center gap-3 flex-1 min-w-0">
                    <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform duration-200', isOpen && 'rotate-90')} />
                    <span className="font-semibold text-card-foreground">
                      {formatDate(dateObj, 'EEEE, MMM d, yyyy')}
                      {isTodayDate && <Badge className="ml-2 bg-primary/15 text-primary border-primary/30 text-[10px]">{t('wh.today')}</Badge>}
                    </span>
                    <Badge variant="secondary">{dayOrders.length}</Badge>
                  </button>
                  <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={(e) => { e.stopPropagation(); openBulkModal(dateKey); }}>
                    <Truck className="h-3 w-3 mr-1" /> {t('wh.bulkUpdateStatus')}
                  </Button>
                </div>
                <div className={cn('overflow-hidden transition-all duration-300', isOpen ? 'max-h-[5000px] opacity-100' : 'max-h-0 opacity-0')}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-t border-b bg-muted/50">
                          <th className="px-2 py-2.5 text-center">
                            <Checkbox
                              checked={dayOrders.length > 0 && dayOrders.every((o: any) => selectedIds.has(o.id))}
                              onCheckedChange={() => toggleDateGroup(dayOrders)}
                            />
                          </th>
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colId')}</th>
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colCustomer')}</th>
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colPhone')}</th>
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs min-w-[220px]">{t('wh.colProduct')}</th>
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colTotalPrice')}</th>
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colAgent')}</th>
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colSource')}</th>
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colStatus')}</th>
                          {view === 'packed' && (
                            <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colPackedAt')}</th>
                          )}
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colTime')}</th>
                          <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colActions')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dayOrders.map((o: any) => {
                          const isFromLead = o.source_type === 'prediction_lead' || o.source === 'prediction_lead';
                          return (
                            <tr key={o.id} className={cn("border-b last:border-0 hover:bg-muted/30 transition-colors", isFromLead && "bg-accent/30", selectedIds.has(o.id) && "bg-primary/5")}>
                              <td className="px-2 py-2.5 text-center">
                                <Checkbox checked={selectedIds.has(o.id)} onCheckedChange={() => toggleSelect(o.id)} />
                              </td>
                               <td className="px-4 py-2.5 font-medium text-xs">
                                 {o.display_id}
                                 {o.ship_after_date && (
                                   <Badge className="ml-1 bg-amber-500/15 text-amber-700 border-amber-500/30 text-[9px]">
                                     {t('wh.shipAfter', { date: formatDate(parseISO(o.ship_after_date), 'MMM d') })}
                                   </Badge>
                                 )}
                               </td>
                              <td className="px-4 py-2.5 text-xs">{o.customer_name}</td>
                              <td className="px-4 py-2.5 text-muted-foreground text-xs">{o.customer_phone || '—'}</td>
                              <td className="px-4 py-2.5 text-xs min-w-[220px] whitespace-normal leading-relaxed">
                                {o.order_items && o.order_items.length > 0
                                  ? o.order_items.map((i: any, idx: number) => (
                                    <span key={i.id || idx}>
                                      {idx > 0 && <span className="text-muted-foreground">, </span>}
                                      <span className="font-medium">{formatProductWithQuantity(i.product_name, i.quantity)}</span>
                                    </span>
                                  ))
                                  : <span className="font-medium">{formatProductWithQuantity(o.product_name, o.quantity)}</span>}
                              </td>
                              <td className="px-4 py-2.5 font-semibold text-primary text-xs">{o.price ? Number(o.price).toFixed(2) : '—'}</td>
                              <td className="px-4 py-2.5 text-muted-foreground text-xs">{o.assigned_agent_name || '—'}</td>
                              <td className="px-4 py-2.5 text-xs">
                                <Badge variant={isFromLead ? 'secondary' : 'default'} className="text-[10px]">{isFromLead ? t('wh.lead') : t('wh.order')}</Badge>
                              </td>
                              <td className="px-4 py-2.5">
                                <Select value={o.status} onValueChange={(val) => handleStatusChange(o.id, o.source, val)} disabled={updatingId === o.id}>
                                  <SelectTrigger className="h-7 w-[130px] text-xs"><SelectValue /></SelectTrigger>
                                  <SelectContent>
                                    {allStatuses.map(s => (
                                      <SelectItem key={s.value} value={s.value}>
                                        <span className="flex items-center gap-1.5">
                                          <span className={cn("h-2 w-2 rounded-full", s.color)} />
                                          {t('status.' + s.value)}
                                        </span>
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </td>
                              {view === 'packed' && (
                                <td className="px-4 py-2.5 text-xs">
                                  <div className="text-emerald-700 font-medium">{format(new Date(o.packed_at), 'MMM d, HH:mm')}</div>
                                  {o.packed_by_name && <div className="text-muted-foreground text-[10px]">{o.packed_by_name}</div>}
                                </td>
                              )}
                              <td className="px-4 py-2.5 text-muted-foreground text-xs">{format(new Date(o.created_at), 'HH:mm')}</td>
                              <td className="px-4 py-2.5 flex items-center gap-1">
                                {view === 'topack' ? (
                                  <Button
                                    size="sm"
                                    className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                                    disabled={updatingId === o.id || o.unconverted}
                                    title={o.unconverted ? t('wh.noLinkedOrder') : undefined}
                                    onClick={() => handlePack(o, true)}
                                  >
                                    {updatingId === o.id ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <PackageCheck className="h-3 w-3 mr-1" />}
                                    {t('wh.markPacked')}
                                  </Button>
                                ) : (
                                  <>
                                    <Button
                                      size="sm"
                                      className="h-7 text-xs"
                                      disabled={updatingId === o.id}
                                      onClick={() => handleShip(o)}
                                    >
                                      {updatingId === o.id ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Truck className="h-3 w-3 mr-1" />}
                                      {t('wh.markShipped')}
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 text-xs text-muted-foreground"
                                      disabled={updatingId === o.id}
                                      title={t('wh.unpack')}
                                      onClick={() => handlePack(o, false)}
                                    >
                                      <RotateCcw className="h-3 w-3" />
                                    </Button>
                                  </>
                                )}
                                <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setModalOrder(o)}>
                                  <Edit className="h-3 w-3 mr-1" /> {t('common.edit')}
                                </Button>
                                <Button variant="destructive" size="sm" className="h-7 text-xs" disabled={deletingId === o.id} onClick={async () => {
                                  if (!confirm(t('wh.deleteOrderConfirm', { id: o.display_id }))) return;
                                  setDeletingId(o.id);
                                  try {
                                    await apiDeleteWarehouseOrder(o.id, o.source);
                                    toast({ title: t('wh.deleted') });
                                    queryClient.invalidateQueries({ queryKey: ['warehouse-incoming-orders'] });
                                  } catch (err: any) {
                                    toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
                                  } finally { setDeletingId(null); }
                                }}>
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {/* Selected count action bar */}
      {selectedIds.size > 0 && (
        <div className="sticky bottom-4 flex items-center justify-between bg-card border rounded-lg px-4 py-3 shadow-lg">
          <span className="text-sm font-medium">{t('wh.selectedCount', { count: selectedIds.size })}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedIds(new Set())}>{t('wh.clearSelection')}</Button>
            <Select value={bulkStatus} onValueChange={setBulkStatus}>
              <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="shipped">{t('status.shipped')}</SelectItem>
                <SelectItem value="paid">{t('status.paid')}</SelectItem>
                <SelectItem value="cancelled">{t('status.cancelled')}</SelectItem>
                <SelectItem value="returned">{t('status.returned')}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" disabled={bulkUpdating} onClick={async () => {
              const ids = Array.from(selectedIds);
              setBulkUpdating(true);
              try {
                const result = await apiBulkStatusUpdate(ids, bulkStatus);
                toast({ title: t('wh.bulkUpdated', { count: result.updated, status: t('status.' + bulkStatus) }) + (result.skipped > 0 ? ' ' + t('wh.bulkSkipped', { count: result.skipped }) : '') });
                setSelectedIds(new Set());
                queryClient.invalidateQueries({ queryKey: ['warehouse-incoming-orders'] });
              } catch (err: any) {
                toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
              } finally { setBulkUpdating(false); }
            }}>
              {bulkUpdating && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              {t('wh.applyToSelected')}
            </Button>
          </div>
        </div>
      )}

      {/* Bulk update by date modal */}
      <Dialog open={bulkModalOpen} onOpenChange={setBulkModalOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('wh.updateAllOrders', { date: bulkModalDate ? formatDate(parseISO(bulkModalDate), 'MMM d, yyyy') : '' })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('wh.bulkModalDesc')}</p>
            <Select value={bulkStatus} onValueChange={setBulkStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="shipped">{t('status.shipped')}</SelectItem>
                <SelectItem value="paid">{t('status.paid')}</SelectItem>
                <SelectItem value="cancelled">{t('status.cancelled')}</SelectItem>
                <SelectItem value="returned">{t('status.returned')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkModalOpen(false)}>{t('common.cancel')}</Button>
            <Button disabled={bulkUpdating} onClick={handleBulkUpdate}>
              {bulkUpdating && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OrderModal
        open={!!modalOrder}
        onClose={(saved) => {
          setModalOrder(null);
          if (saved) queryClient.invalidateQueries({ queryKey: ['warehouse-incoming-orders'] });
        }}
        data={modalOrder ? orderToModalData(modalOrder) : null}
        contextType="order"
      />
    </div>
  );
}

// ─── Inventory Tab (Enhanced) ──────────────────────────────────
function InventoryTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  // The warehouse worker restocks too — the server guard matches (POST /restock).
  const canRestock = user?.isAdmin || user?.isManager || user?.isWarehouse;
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [showRestock, setShowRestock] = useState(false);
  const [restockProduct, setRestockProduct] = useState<any>(null);
  const [restockQty, setRestockQty] = useState('');
  const [lowStockExpanded, setLowStockExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const fetchProducts = () => {
    setLoading(true);
    apiGetProducts().then(setProducts).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { fetchProducts(); }, []);

  const categories = useMemo(() => {
    const cats = new Set(products.map(p => p.category).filter(Boolean));
    return Array.from(cats).sort();
  }, [products]);

  const filtered = useMemo(() => {
    return products.filter(p => {
      if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !(p.sku || '').toLowerCase().includes(search.toLowerCase())) return false;
      if (categoryFilter && categoryFilter !== 'all' && p.category !== categoryFilter) return false;
      return true;
    });
  }, [products, search, categoryFilter]);

  const lowStockProducts = products.filter(p => p.stock_quantity < p.low_stock_threshold);

  const handleRestock = async () => {
    if (!restockProduct || !restockQty) return;
    setSaving(true);
    try {
      // Quantity only — the movement date is recorded automatically (inventory_logs.created_at).
      await apiRestock({
        product_id: restockProduct.id,
        quantity: parseInt(restockQty),
      });
      toast({ title: t('wh.stockAdded'), description: t('wh.addedUnits', { count: restockQty, name: restockProduct.name }) });
      setShowRestock(false);
      setRestockProduct(null);
      setRestockQty('');
      fetchProducts();
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const openRestock = (p: any) => {
    setRestockProduct(p);
    setRestockQty('');
    setShowRestock(true);
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-4">
      {/* Low stock alerts — collapsed to a preview so 100+ warnings can't swallow the page */}
      {lowStockProducts.length > 0 && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <span className="font-semibold text-destructive text-sm">{t('wh.lowStockAlerts', { count: lowStockProducts.length })}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(lowStockExpanded ? lowStockProducts : lowStockProducts.slice(0, LOW_STOCK_PREVIEW)).map(p => (
              <Badge key={p.id} variant="destructive" className="text-xs">
                {p.name} — {t('wh.leftMin', { count: p.stock_quantity, min: p.low_stock_threshold })}
              </Badge>
            ))}
            {lowStockProducts.length > LOW_STOCK_PREVIEW && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs font-semibold text-destructive hover:bg-destructive/10"
                onClick={() => setLowStockExpanded(v => !v)}
              >
                {lowStockExpanded
                  ? t('wh.showLessLowStock')
                  : t('wh.showMoreLowStock', { count: lowStockProducts.length - LOW_STOCK_PREVIEW })}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Search & filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder={t('wh.searchProductsSku')} value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        {categories.length > 0 && (
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-44"><SelectValue placeholder={t('wh.allCategories')} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('wh.allCategories')}</SelectItem>
              {categories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {/* BigArena stock-sync upload is deliberately not shipped in Macedonia:
            its parser reads the Bulgarian fulfilment panel's Cyrillic column
            headers ("Свободна наличност", "Баркод"), and MK uses a different
            provider. Restore <BigArenaStockSync /> here if that ever changes. */}
        <span className="text-sm text-muted-foreground ml-auto">{t('wh.ofProducts', { shown: filtered.length, total: products.length })}</span>
      </div>

      <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colProduct')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colSku')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colCategory')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colSupplier')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colCost')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colPrice')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground min-w-[160px]">{t('wh.colStockLevel')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colStatus')}</th>
              {canRestock && <th className="px-4 py-3 text-right font-medium text-muted-foreground">{t('wh.colActions')}</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p: any) => {
              const isLowStock = p.stock_quantity < p.low_stock_threshold;
              const stockPercent = p.low_stock_threshold > 0 ? Math.min((p.stock_quantity / (p.low_stock_threshold * 3)) * 100, 100) : (p.stock_quantity > 0 ? 100 : 0);
              return (
                <tr key={p.id} className={cn("border-b last:border-0 hover:bg-muted/30 transition-colors", isLowStock && "bg-destructive/5")}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg", isLowStock ? "bg-destructive/10" : "bg-primary/10")}>
                        <Package className={cn("h-4 w-4", isLowStock ? "text-destructive" : "text-primary")} />
                      </div>
                      <div>
                        <p className="font-medium text-card-foreground">{p.name}</p>
                        <p className="text-xs text-muted-foreground">{p.description || ''}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{p.sku || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{p.category || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{p.suppliers?.name || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{Number(p.cost_price || 0).toFixed(2)}</td>
                  <td className="px-4 py-3 font-semibold text-primary">{Number(p.price).toFixed(2)}</td>
                  <td className="px-4 py-3 min-w-[160px]">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className={cn("font-semibold", p.stock_quantity <= 0 ? "text-destructive" : isLowStock ? "text-destructive" : "text-foreground")}>{p.stock_quantity}</span>
                        <span className="text-muted-foreground">{t('wh.minShort', { value: p.low_stock_threshold })}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div
                          className={cn("h-full rounded-full transition-all", p.stock_quantity <= 0 ? "bg-destructive" : isLowStock ? "bg-destructive" : "bg-primary")}
                          style={{ width: `${stockPercent}%` }}
                        />
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={p.is_active ? 'default' : 'secondary'}>{p.is_active ? t('wh.active') : t('wh.disabled')}</Badge>
                  </td>
                  {canRestock && (
                    <td className="px-4 py-3 text-right">
                      <Button variant="outline" size="sm" onClick={() => openRestock(p)}>
                        <ArrowUpCircle className="h-3.5 w-3.5 mr-1" /> {t('wh.restock')}
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={canRestock ? 9 : 8} className="p-0">
                  <EmptyState
                    icon={<Package className="h-5 w-5" />}
                    title={search || categoryFilter ? t('wh.noProductsMatch') : t('wh.noProducts')}
                    description={t('wh.tryAdjusting')}
                    size="sm"
                    className="border-0 bg-transparent hover:shadow-none"
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Restock Dialog */}
      <Dialog open={showRestock} onOpenChange={setShowRestock}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('wh.restockTitle', { name: restockProduct?.name })}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-muted-foreground">{t('wh.currentStock', { count: restockProduct?.stock_quantity })}</label>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{t('wh.qtyToAdd')}</label>
              <Input type="number" value={restockQty} onChange={e => setRestockQty(e.target.value)} min="1" placeholder={t('wh.enterQty')} autoFocus />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRestock(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleRestock} disabled={saving || !restockQty}>{saving ? t('wh.adding') : t('wh.addStock')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Stock Movements Tab ───────────────────────────────────────
function StockMovementsTab() {
  const { t } = useTranslation();
  const [movements, setMovements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');
  const [products, setProducts] = useState<any[]>([]);
  const [productFilter, setProductFilter] = useState('');

  useEffect(() => {
    apiGetProducts().then(setProducts).catch(() => {});
  }, []);

  const fetchMovements = () => {
    setLoading(true);
    apiGetStockMovements({
      product_id: productFilter || undefined,
      movement_type: typeFilter || undefined,
      limit: 200,
    }).then(setMovements).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { fetchMovements(); }, [typeFilter, productFilter]);

  const movementIcon = (type: string) => {
    if (type === 'restock') return <ArrowUpCircle className="h-4 w-4 text-emerald-600" />;
    if (type === 'order_deduction') return <ArrowDownCircle className="h-4 w-4 text-destructive" />;
    if (type === 'manual_adjust') return <RotateCcw className="h-4 w-4 text-muted-foreground" />;
    return <RotateCcw className="h-4 w-4 text-muted-foreground" />;
  };

  const movementLabel = (type: string) => {
    if (type === 'restock' || type === 'order_deduction' || type === 'manual_adjust' || type === 'deduction') return t('wh.mv.' + type);
    return type || t('common.unknown');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-48"><SelectValue placeholder={t('wh.allTypes')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('wh.allTypes')}</SelectItem>
            <SelectItem value="restock">{t('wh.mv.restock')}</SelectItem>
            <SelectItem value="order_deduction">{t('wh.mv.order_deduction')}</SelectItem>
            <SelectItem value="manual_adjust">{t('wh.mv.manual_adjust')}</SelectItem>
            <SelectItem value="order_return">{t('wh.mv.order_return')}</SelectItem>
            <SelectItem value="bigarena_sync">{t('wh.mv.bigarena_sync')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={productFilter} onValueChange={setProductFilter}>
          <SelectTrigger className="w-48"><SelectValue placeholder={t('wh.allProducts')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('wh.allProducts')}</SelectItem>
            {products.map((p: any) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground ml-auto">{t('wh.movementsCount', { count: movements.length })}</span>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colType')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colProduct')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colSku')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colChange')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colOldNew')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colUser')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colSupplier')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colInvoice')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colNotes')}</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('wh.colDate')}</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m: any) => (
                <tr key={m.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {movementIcon(m.movement_type || m.reason)}
                      <Badge variant="secondary" className="text-xs">{movementLabel(m.movement_type || m.reason)}</Badge>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-medium">{m.product_name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{m.product_sku || '—'}</td>
                  <td className="px-4 py-3">
                    <span className={cn("font-semibold", m.change_amount > 0 ? "text-emerald-600" : "text-destructive")}>
                      {m.change_amount > 0 ? '+' : ''}{m.change_amount}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{m.previous_stock} → {m.new_stock}</td>
                  <td className="px-4 py-3 text-muted-foreground">{m.user_name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{m.supplier_name || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{m.invoice_number || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs max-w-[150px] truncate">{m.notes || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{new Date(m.created_at).toLocaleString()}</td>
                </tr>
              ))}
              {movements.length === 0 && (
                <tr>
                  <td colSpan={10} className="p-0">
                    <EmptyState
                      icon={<History className="h-5 w-5" />}
                      title={t('wh.noMovements')}
                      description={t('wh.noMovementsDesc')}
                      size="sm"
                      className="border-0 bg-transparent hover:shadow-none"
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── History Tab (Историја) ────────────────────────────────────
// Recent real orders (confirmed/shipped/delivered/paid, last 14 days) so the
// warehouse worker can find one and fix a packing/address mistake. Edits go
// through OrderModal, whose save path re-resolves the MEX routing zone on a
// city change and keeps product/price locked once shipped.
function HistoryTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [modalOrder, setModalOrder] = useState<any>(null);

  const { data: orders = [], isLoading: loading } = useQuery<any[]>({
    queryKey: ['warehouse-incoming-orders', 'history'],
    queryFn: () => apiGetIncomingOrders({ from: subDays(new Date(), 14).toISOString() }),
    staleTime: 15_000,
  });

  const filtered = useMemo(() => {
    // Unconverted leads have no orders row — nothing to correct here.
    const rows = orders.filter((o: any) => !o.unconverted);
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((o: any) =>
      (o.customer_name || '').toLowerCase().includes(q) ||
      (o.customer_phone || '').includes(q) ||
      (o.display_id || '').toLowerCase().includes(q));
  }, [orders, search]);

  const statusVariant = (status: string) =>
    status === 'paid' ? 'default' : status === 'returned' ? 'destructive' : 'secondary';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder={t('wh.historySearchPh')} value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <span className="text-sm text-muted-foreground ml-auto">{t('wh.ordersTotal', { count: filtered.length })}</span>
      </div>
      <p className="text-xs text-muted-foreground">{t('wh.historyDesc')}</p>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState title={t('wh.noOrdersFound')} description={t('wh.noOrdersDesc')} size="md" />
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colId')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colCustomer')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colPhone')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs min-w-[220px]">{t('wh.colProduct')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colStatus')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colPackedAt')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colDate')}</th>
                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground text-xs">{t('wh.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o: any) => (
                <tr key={o.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-2.5 font-medium text-xs">{o.display_id}</td>
                  <td className="px-4 py-2.5 text-xs">{o.customer_name}</td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">{o.customer_phone || '—'}</td>
                  <td className="px-4 py-2.5 text-xs min-w-[220px] whitespace-normal leading-relaxed">
                    {o.order_items && o.order_items.length > 0
                      ? o.order_items.map((i: any, idx: number) => (
                        <span key={i.id || idx}>
                          {idx > 0 && <span className="text-muted-foreground">, </span>}
                          <span className="font-medium">{formatProductWithQuantity(i.product_name, i.quantity)}</span>
                        </span>
                      ))
                      : <span className="font-medium">{formatProductWithQuantity(o.product_name, o.quantity)}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={statusVariant(o.status)} className="text-[10px]">{t('status.' + o.status)}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {o.packed_at ? (
                      <>
                        <div className="text-emerald-700 font-medium">{format(new Date(o.packed_at), 'MMM d, HH:mm')}</div>
                        {o.packed_by_name && <div className="text-muted-foreground text-[10px]">{o.packed_by_name}</div>}
                      </>
                    ) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs">{format(new Date(o.created_at), 'MMM d, HH:mm')}</td>
                  <td className="px-4 py-2.5">
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setModalOrder(o)}>
                      <Edit className="h-3 w-3 mr-1" /> {t('common.edit')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <OrderModal
        open={!!modalOrder}
        onClose={(saved) => {
          setModalOrder(null);
          if (saved) queryClient.invalidateQueries({ queryKey: ['warehouse-incoming-orders'] });
        }}
        data={modalOrder ? orderToModalData(modalOrder) : null}
        contextType="order"
      />
    </div>
  );
}

// ─── Main Warehouse Page ───────────────────────────────────────
export default function WarehousePage() {
  const { t } = useTranslation();
  const { canAccessModule } = usePermissions();
  // Packing/History are the warehouse_incoming module — hidden from managers by
  // default, shown to warehouse + admin, governable from Settings → Role Permissions.
  const canIncoming = canAccessModule('warehouse_incoming');

  const [products, setProducts] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [statsLoaded, setStatsLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      apiGetProducts().then(setProducts).catch(() => {}),
      canIncoming ? apiGetIncomingOrders({}).then(setOrders).catch(() => {}) : Promise.resolve(),
    ]).finally(() => setStatsLoaded(true));
  }, []);

  const totalProducts = products.length;
  const lowStockCount = products.filter(p => p.stock_quantity < p.low_stock_threshold).length;
  const totalStockValue = products.reduce((sum, p) => sum + (p.stock_quantity * Number(p.price || 0)), 0);
  const pendingOrders = orders.filter(o => o.status === 'confirmed' || o.status === 'pending').length;

  const kpiCards = [
    { labelKey: 'wh.kpiTotalProducts', value: totalProducts, icon: Boxes, color: 'bg-primary/10 text-primary' },
    { labelKey: 'wh.kpiLowStock', value: lowStockCount, icon: TrendingDown, color: lowStockCount > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground' },
    { labelKey: 'wh.kpiStockValue', value: `$${totalStockValue.toLocaleString()}`, icon: DollarSign, color: 'bg-emerald-500/10 text-emerald-600' },
    ...(canIncoming ? [{ labelKey: 'wh.kpiPendingOrders', value: pendingOrders, icon: ShoppingCart, color: pendingOrders > 0 ? 'bg-amber-500/10 text-amber-600' : 'bg-muted text-muted-foreground' }] : []),
  ];

  return (
    <AppLayout title={t('nav.warehouse')}>
      <div className="space-y-6">
        {/* KPI Cards */}
        <div className={cn("grid gap-4", canIncoming ? "grid-cols-1 sm:grid-cols-2 md:grid-cols-4" : "grid-cols-1 sm:grid-cols-3")}>
          {kpiCards.map(card => (
            <Card key={card.labelKey} className="border-none shadow-sm">
              <CardContent className="flex items-center gap-3 p-4">
                <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl", card.color)}>
                  <card.icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{t(card.labelKey)}</p>
                  <p className="text-xl font-bold">{statsLoaded ? card.value : '—'}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* The worker's main job opens first when they hold the packing module */}
        <Tabs defaultValue={canIncoming ? 'packing' : 'inventory'} className="space-y-4">
          <TabsList>
            {canIncoming && (
              <TabsTrigger value="packing" className="gap-1.5">
                <ClipboardList className="h-3.5 w-3.5" /> {t('wh.tabPacking')}
              </TabsTrigger>
            )}
            <TabsTrigger value="inventory" className="gap-1.5">
              <Package className="h-3.5 w-3.5" /> {t('wh.tabInventory')}
            </TabsTrigger>
            <TabsTrigger value="movements" className="gap-1.5">
              <History className="h-3.5 w-3.5" /> {t('wh.tabMovements')}
            </TabsTrigger>
            {canIncoming && (
              <TabsTrigger value="history" className="gap-1.5">
                <Archive className="h-3.5 w-3.5" /> {t('wh.tabHistory')}
              </TabsTrigger>
            )}
          </TabsList>

          {canIncoming && (
            <TabsContent value="packing">
              <PackingTab />
            </TabsContent>
          )}

          <TabsContent value="inventory">
            <InventoryTab />
          </TabsContent>

          <TabsContent value="movements">
            <StockMovementsTab />
          </TabsContent>

          {canIncoming && (
            <TabsContent value="history">
              <HistoryTab />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </AppLayout>
  );
}
