import { useState, useEffect, useMemo } from 'react';
import { apiErrorText } from '@/i18n/apiErrors';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/EmptyState';
import { AppLayout } from '@/layouts/AppLayout';
import {
  PredictionLeadStatus,
  PREDICTION_LEAD_STATUSES,
  predictionLeadLabel,
  PREDICTION_LEAD_COLORS,
} from '@/types';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/currency';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Check, X as XIcon, Phone, Search, CalendarIcon, Filter, Tag, HandMetal, MoreVertical, History, Copy } from 'lucide-react';
import { format } from 'date-fns';
import { formatDate } from '@/i18n/dates';
import { apiGetMyLeads, apiTakeLead } from '@/lib/api';
import { OrderModal, OrderModalData } from '@/components/OrderModal';
import { PhoneQualityBadge } from '@/components/PhoneQualityBadge';
import { CustomerHistoryDialog } from '@/components/CustomerHistoryDialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

interface LeadItem {
  id: string;
  lead_id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  price_per_unit: number;
  total_price: number;
}

interface LeadRow {
  id: string;
  name: string;
  telephone: string;
  address: string | null;
  city: string | null;
  product: string | null;
  status: PredictionLeadStatus;
  notes: string | null;
  quantity?: number;
  price?: number;
  created_at?: string;
  updated_at?: string;
  prediction_lists?: { name: string } | null;
  prediction_lead_items?: LeadItem[];
}

const STATUS_CHIP_COLORS: Record<PredictionLeadStatus, string> = { ...PREDICTION_LEAD_COLORS };

function calcRowTotal(qty: number, price: number): number {
  return Math.round(Math.max(1, qty) * Math.max(0, price) * 100) / 100;
}

function getLeadDisplayTotal(lead: LeadRow): number {
  const items = lead.prediction_lead_items || [];
  if (items.length > 0) {
    return items.reduce((sum, i) => sum + calcRowTotal(i.quantity, i.price_per_unit), 0);
  }
  // prediction_leads.price is the lead's TOTAL, like orders.price (the api copies
  // it straight into orders.price on conversion) — never × quantity.
  return Number(lead.price || 0);
}

function leadToModalData(lead: LeadRow): OrderModalData {
  return {
    id: lead.id,
    name: lead.name,
    telephone: lead.telephone,
    address: lead.address,
    city: lead.city,
    product: lead.product,
    status: lead.status,
    notes: lead.notes,
    quantity: lead.quantity,
    price: lead.price,
    items: (lead.prediction_lead_items || []).map(i => ({
      id: i.id,
      product_id: i.product_id,
      product_name: i.product_name,
      quantity: i.quantity,
      price_per_unit: i.price_per_unit,
      total_price: i.total_price,
    })),
  };
}

export default function PredictionLeadsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalLead, setModalLead] = useState<LeadRow | null>(null);
  const [historyLead, setHistoryLead] = useState<{ phone: string; name: string } | null>(null);

  // Filter state
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedStatuses, setSelectedStatuses] = useState<PredictionLeadStatus[]>([]);
  const [selectedProduct, setSelectedProduct] = useState('all');
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const fetchLeads = () => {
    setLoading(true);
    setError(null);
    apiGetMyLeads(debouncedSearch ? { search: debouncedSearch } : undefined)
      .then((data) => setLeads(data || []))
      .catch((err) => setError(err.message || t('predLeads.failedLoad')))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchLeads(); }, [debouncedSearch]);

  const uniqueProducts = useMemo(() => {
    const prods = new Set<string>();
    leads.forEach(l => { if (l.product) prods.add(l.product); });
    return Array.from(prods).sort();
  }, [leads]);

  const filteredLeads = useMemo(() => {
    let result = leads;
    // Only client-side filter by search if not doing server-side search
    if (search.trim() && !debouncedSearch) {
      const s = search.toLowerCase();
      result = result.filter(l =>
        l.name.toLowerCase().includes(s) ||
        l.telephone.includes(s) ||
        l.city?.toLowerCase().includes(s)
      );
    }
    if (selectedStatuses.length > 0) {
      result = result.filter(l => selectedStatuses.includes(l.status));
    }
    if (selectedProduct !== 'all') {
      result = result.filter(l => l.product === selectedProduct);
    }
    if (dateFrom) {
      result = result.filter(l => l.created_at && new Date(l.created_at) >= dateFrom);
    }
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      result = result.filter(l => l.created_at && new Date(l.created_at) <= end);
    }
    return result;
  }, [leads, search, debouncedSearch, selectedStatuses, selectedProduct, dateFrom, dateTo]);

  const hasActiveFilters = search.trim() || selectedStatuses.length > 0 || selectedProduct !== 'all' || dateFrom || dateTo;

  // Duplicate phone detection
  const phoneCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const l of filteredLeads) {
      const p = l.telephone?.replace(/[^0-9+]/g, '');
      if (p && p.length >= 6) counts[p] = (counts[p] || 0) + 1;
    }
    return counts;
  }, [filteredLeads]);

  const getPhoneDupCount = (phone: string) => {
    const p = phone?.replace(/[^0-9+]/g, '');
    return p ? (phoneCounts[p] || 0) : 0;
  };

  const clearAllFilters = () => {
    setSearch('');
    setSelectedStatuses([]);
    setSelectedProduct('all');
    setDateFrom(undefined);
    setDateTo(undefined);
  };

  const toggleStatus = (status: PredictionLeadStatus) => {
    setSelectedStatuses(prev =>
      prev.includes(status) ? prev.filter(s => s !== status) : [...prev, status]
    );
  };

  if (loading) {
    return (
      <AppLayout title={t('nav.predictionLeads')}>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppLayout>
    );
  }

  if (error) {
    return (
      <AppLayout title={t('nav.predictionLeads')}>
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <p className="text-sm text-destructive">{error}</p>
          <Button variant="outline" size="sm" onClick={fetchLeads}>{t('common.retry')}</Button>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title={t('nav.predictionLeads')}>
      {/* Filter Bar */}
      <div className="sticky top-0 z-10 mb-4 space-y-3">
        <div className="rounded-xl border bg-card/80 backdrop-blur-sm p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder={t('predLeads.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 pl-8 text-sm rounded-lg bg-background"
              />
            </div>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg text-sm font-normal">
                  <Filter className="h-3.5 w-3.5" />
                  Status
                  {selectedStatuses.length > 0 && (
                    <span className="ml-1 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                      {selectedStatuses.length}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-2" align="start">
                <div className="space-y-1">
                  {PREDICTION_LEAD_STATUSES.map(s => (
                    <button
                      key={s}
                      onClick={() => toggleStatus(s)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
                        selectedStatuses.includes(s)
                          ? 'bg-primary/10 text-primary font-medium'
                          : 'hover:bg-muted text-foreground'
                      )}
                    >
                      <div className={cn(
                        'h-3.5 w-3.5 rounded border-2 flex items-center justify-center transition-colors',
                        selectedStatuses.includes(s) ? 'border-primary bg-primary' : 'border-muted-foreground/30'
                      )}>
                        {selectedStatuses.includes(s) && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                      </div>
                      <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium border', STATUS_CHIP_COLORS[s])}>
                        {predictionLeadLabel(s)}
                      </span>
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {uniqueProducts.length > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg text-sm font-normal">
                    <Tag className="h-3.5 w-3.5" />
                    {selectedProduct === 'all' ? t('predLeads.product') : selectedProduct}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-52 p-2" align="start">
                  <div className="space-y-0.5">
                    <button
                      onClick={() => setSelectedProduct('all')}
                      className={cn('flex w-full rounded-lg px-3 py-2 text-sm transition-colors', selectedProduct === 'all' ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted')}
                    >
                      {t('common.all')}
                    </button>
                    {uniqueProducts.map(p => (
                      <button key={p} onClick={() => setSelectedProduct(p)} className={cn('flex w-full rounded-lg px-3 py-2 text-sm transition-colors', selectedProduct === p ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-muted')}>
                        {p}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
            )}

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg text-sm font-normal">
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {dateFrom ? formatDate(dateFrom, 'MMM d') : t('ordersPage.from')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={dateFrom} onSelect={setDateFrom} className="p-3 pointer-events-auto" />
              </PopoverContent>
            </Popover>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-1.5 rounded-lg text-sm font-normal">
                  <CalendarIcon className="h-3.5 w-3.5" />
                  {dateTo ? formatDate(dateTo, 'MMM d') : t('ordersPage.to')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={dateTo} onSelect={setDateTo} className="p-3 pointer-events-auto" />
              </PopoverContent>
            </Popover>

            {hasActiveFilters && (
              <Button variant="ghost" size="sm" className="h-9 text-xs text-muted-foreground hover:text-foreground" onClick={clearAllFilters}>
                {t('ordersPage.clearAll')}
              </Button>
            )}

            <span className="ml-auto text-xs text-muted-foreground whitespace-nowrap">
              {t('predLeads.ofLeads', { shown: filteredLeads.length, total: leads.length })}
            </span>
          </div>
        </div>

        {hasActiveFilters && (
          <div className="flex flex-wrap items-center gap-1.5 px-1">
            {selectedStatuses.map(s => (
              <Badge key={s} variant="secondary" className={cn('gap-1 cursor-pointer border text-xs', STATUS_CHIP_COLORS[s])} onClick={() => toggleStatus(s)}>
                {predictionLeadLabel(s)}
                <XIcon className="h-3 w-3" />
              </Badge>
            ))}
            {selectedProduct !== 'all' && (
              <Badge variant="secondary" className="gap-1 cursor-pointer text-xs" onClick={() => setSelectedProduct('all')}>
                {selectedProduct}
                <XIcon className="h-3 w-3" />
              </Badge>
            )}
            {dateFrom && (
              <Badge variant="secondary" className="gap-1 cursor-pointer text-xs" onClick={() => setDateFrom(undefined)}>
                From: {format(dateFrom, 'MMM d')}
                <XIcon className="h-3 w-3" />
              </Badge>
            )}
            {dateTo && (
              <Badge variant="secondary" className="gap-1 cursor-pointer text-xs" onClick={() => setDateTo(undefined)}>
                To: {format(dateTo, 'MMM d')}
                <XIcon className="h-3 w-3" />
              </Badge>
            )}
            {search.trim() && (
              <Badge variant="secondary" className="gap-1 cursor-pointer text-xs" onClick={() => setSearch('')}>
                "{search}"
                <XIcon className="h-3 w-3" />
              </Badge>
            )}
          </div>
        )}
      </div>

      {/* Leads Table */}
      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colStatus')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('search.name')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('search.phone')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden sm:table-cell">{t('orderModal.city')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground hidden md:table-cell">{t('ordersPage.colProduct')}</th>
              <th className="px-4 py-3 text-right font-medium text-muted-foreground">{t('createOrder.total')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('common.actions')}</th>
              <th className="px-4 py-3 w-10"><span className="sr-only">{t('common.actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {filteredLeads.map(lead => {
              const items = lead.prediction_lead_items || [];
              const hasItems = items.length > 0;
              const displayTotal = getLeadDisplayTotal(lead);

                return (
                <tr key={lead.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold border', STATUS_CHIP_COLORS[lead.status])}>
                      {predictionLeadLabel(lead.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {lead.name}
                    {getPhoneDupCount(lead.telephone) > 1 && (
                      <Badge variant="destructive" className="ml-1.5 text-[9px] px-1 py-0 cursor-pointer" onClick={() => setSearch(lead.telephone)}>
                        {getPhoneDupCount(lead.telephone)}x
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                      {lead.telephone}
                      <PhoneQualityBadge phone={lead.telephone} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">{lead.city || '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                    {hasItems ? t('predLeads.productCount', { count: items.length }) : lead.product || '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-bold font-mono tabular-nums text-primary">
                    {formatMoney(displayTotal)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <Button
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        onClick={() => setModalLead(lead)}
                      >
                        <Phone className="h-3 w-3" />
                        {(lead as any).is_owned === false ? t('predLeads.view') : t('predLeads.open')}
                      </Button>
                      {(lead as any).is_owned !== false && lead.status === 'not_contacted' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1 text-xs"
                          onClick={async () => {
                            try {
                              await apiTakeLead(lead.id);
                              toast({ title: t('predLeads.orderTaken') });
                              fetchLeads();
                            } catch (err: any) {
                              toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
                            }
                          }}
                        >
                          <HandMetal className="h-3 w-3" />
                          Take
                        </Button>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => setHistoryLead({ phone: lead.telephone, name: lead.name })}>
                          <History className="h-3.5 w-3.5 mr-2" /> See History
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setSearch(lead.telephone)}>
                          <Copy className="h-3.5 w-3.5 mr-2" /> View Duplicates
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              );
            })}
            {filteredLeads.length === 0 && (
              <tr>
                <td colSpan={8} className="p-0">
                  <EmptyState
                    title={t('predLeads.noLeads')}
                    description={hasActiveFilters ? "Try clearing some filters." : "This prediction list is empty."}
                    size="sm"
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Order Modal */}
      <OrderModal
        open={!!modalLead}
        onClose={(saved) => {
          setModalLead(null);
          if (saved) fetchLeads();
        }}
        data={modalLead ? leadToModalData(modalLead) : null}
        contextType="prediction_lead"
        readOnly={!!(modalLead && (modalLead as any).is_owned === false)}
      />

      {/* Customer History Dialog */}
      <CustomerHistoryDialog
        open={!!historyLead}
        onClose={() => setHistoryLead(null)}
        customerPhone={historyLead?.phone || ''}
        customerName={historyLead?.name || ''}
      />
    </AppLayout>
  );
}
