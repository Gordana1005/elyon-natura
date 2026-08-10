import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Loader2, Phone, MapPin, Package, ChevronDown, ChevronUp, User, ArrowRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { StatusBadge } from '@/components/StatusBadge';
import { useTranslation } from 'react-i18next';
import { formatDate } from '@/i18n/dates';
import { OrderStatus, statusLabel } from '@/types';
import { formatOrderProducts } from '@/lib/monadonSubstitutes';

interface CustomerHistoryDialogProps {
  open: boolean;
  onClose: () => void;
  customerPhone: string;
  customerName: string;
}

interface HistoryEntry {
  id: string;
  from_status: string | null;
  to_status: string;
  changed_by_name: string | null;
  changed_at: string;
}

interface OrderNote {
  id: string;
  text: string;
  author_name: string;
  created_at: string;
}

interface HistoryOrder {
  id: string;
  display_id: string;
  customer_name: string;
  customer_phone: string;
  customer_city: string;
  product_name: string;
  source_type?: string | null;
  price: number;
  status: string;
  created_at: string;
  assigned_agent_name: string | null;
}

interface HistoryLead {
  id: string;
  name: string;
  telephone: string;
  product: string | null;
  status: string;
  created_at: string;
  assigned_agent_name: string | null;
}

export function CustomerHistoryDialog({ open, onClose, customerPhone, customerName }: CustomerHistoryDialogProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState<HistoryOrder[]>([]);
  const [leads, setLeads] = useState<HistoryLead[]>([]);
  const [orderHistories, setOrderHistories] = useState<Record<string, HistoryEntry[]>>({});
  const [orderNotes, setOrderNotes] = useState<Record<string, OrderNote[]>>({});
  const [expandedOrders, setExpandedOrders] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open || !customerPhone) return;
    setLoading(true);
    setExpandedOrders(new Set());

    const normalizedPhone = customerPhone.replace(/[^0-9+]/g, '');
    if (normalizedPhone.length < 6) {
      setLoading(false);
      return;
    }

    // Suffix match, not `%last8%`: a substring can pull in a DIFFERENT customer
    // whose number merely contains these 8 digits, and this dossier is what the
    // agent reads before deciding how to handle the person on the line.
    const last8 = normalizedPhone.slice(-8);

    Promise.all([
      supabase
        .from('orders')
        .select('id, display_id, customer_name, customer_phone, customer_city, product_name, source_type, price, status, created_at, assigned_agent_name')
        .ilike('customer_phone', `%${last8}`)
        .order('created_at', { ascending: false })
        .limit(50),
      supabase
        .from('prediction_leads')
        .select('id, name, telephone, product, status, created_at, assigned_agent_name')
        .ilike('telephone', `%${last8}`)
        .order('created_at', { ascending: false })
        .limit(50),
    ]).then(async ([ordersRes, leadsRes]) => {
      const fetchedOrders = (ordersRes.data || []) as HistoryOrder[];
      setOrders(fetchedOrders);
      setLeads((leadsRes.data || []) as HistoryLead[]);

      // Fetch history and notes for all orders
      if (fetchedOrders.length > 0) {
        const orderIds = fetchedOrders.map(o => o.id);
        const [historyRes, notesRes] = await Promise.all([
          supabase
            .from('order_history')
            .select('id, order_id, from_status, to_status, changed_by_name, changed_at')
            .in('order_id', orderIds)
            .order('changed_at', { ascending: true }),
          supabase
            .from('order_notes')
            .select('id, order_id, text, author_name, created_at')
            .in('order_id', orderIds)
            .order('created_at', { ascending: true }),
        ]);

        const histories: Record<string, HistoryEntry[]> = {};
        for (const h of (historyRes.data || [])) {
          const oid = (h as any).order_id;
          if (!histories[oid]) histories[oid] = [];
          histories[oid].push(h as HistoryEntry);
        }
        setOrderHistories(histories);

        const notes: Record<string, OrderNote[]> = {};
        for (const n of (notesRes.data || [])) {
          const oid = (n as any).order_id;
          if (!notes[oid]) notes[oid] = [];
          notes[oid].push(n as OrderNote);
        }
        setOrderNotes(notes);
      }
    }).finally(() => setLoading(false));
  }, [open, customerPhone]);

  const toggleExpand = (id: string) => {
    setExpandedOrders(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const totalOrders = orders.length;
  const totalLeads = leads.length;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{t('historyDialog.title')}</DialogTitle>
          <div className="flex items-center gap-3 text-sm text-muted-foreground pt-1">
            <span className="font-medium text-foreground">{customerName || t('common.unknown')}</span>
            <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{customerPhone}</span>
          </div>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="overflow-y-auto space-y-4 flex-1">
            <div className="flex gap-3">
              <Badge variant="secondary" className="text-xs">{t('historyDialog.nOrders', { count: totalOrders })}</Badge>
              <Badge variant="outline" className="text-xs">{t('historyDialog.nLeads', { count: totalLeads })}</Badge>
            </div>

            {/* Orders with expandable history */}
            {orders.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-2">{t('historyDialog.ordersHeader')}</h3>
                <div className="space-y-2">
                  {orders.map(o => {
                    const isExpanded = expandedOrders.has(o.id);
                    const history = orderHistories[o.id] || [];
                    const notes = orderNotes[o.id] || [];
                    const hasDetails = history.length > 0 || notes.length > 0;

                    return (
                      <div key={o.id} className="rounded-lg border bg-card overflow-hidden">
                        {/* Order header */}
                        <button
                          className="w-full px-3 py-2 text-sm flex items-center justify-between gap-2 hover:bg-muted/30 transition-colors text-left"
                          onClick={() => hasDetails && toggleExpand(o.id)}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs font-semibold">{o.display_id}</span>
                              <StatusBadge status={o.status as OrderStatus} order={o} />
                              {o.assigned_agent_name && (
                                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                  <User className="h-2.5 w-2.5" />{o.assigned_agent_name}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                              <span className="flex items-center gap-1"><Package className="h-3 w-3" />{formatOrderProducts(o)}</span>
                              {o.customer_city && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{o.customer_city}</span>}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <div className="text-right">
                              <p className="font-bold text-primary text-sm">{Number(o.price).toFixed(2)}</p>
                              <p className="text-[10px] text-muted-foreground">{formatDate(new Date(o.created_at), 'MMM d, yyyy')}</p>
                            </div>
                            {hasDetails && (
                              isExpanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            )}
                          </div>
                        </button>

                        {/* Expanded timeline */}
                        {isExpanded && (
                          <div className="border-t px-3 py-2 bg-muted/10 space-y-2">
                            {history.length > 0 && (
                              <div>
                                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">{t('intel.statusTimeline')}</p>
                                <div className="space-y-1">
                                  {history.map(h => (
                                    <div key={h.id} className="flex items-center gap-2 text-xs">
                                      <span className="text-muted-foreground w-28 shrink-0">{formatDate(new Date(h.changed_at), 'MMM d, HH:mm')}</span>
                                      <div className="flex items-center gap-1">
                                        {h.from_status && (
                                          <>
                                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">{statusLabel(h.from_status)}</Badge>
                                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                                          </>
                                        )}
                                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{statusLabel(h.to_status)}</Badge>
                                      </div>
                                      {h.changed_by_name && (
                                        <span className="text-muted-foreground flex items-center gap-0.5 ml-auto">
                                          <User className="h-2.5 w-2.5" />{h.changed_by_name}
                                        </span>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {notes.length > 0 && (
                              <div>
                                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1">{t('orderModal.notes')}</p>
                                <div className="space-y-1">
                                  {notes.map(n => (
                                    <div key={n.id} className="text-xs bg-card rounded px-2 py-1 border">
                                      <span className="text-muted-foreground">{formatDate(new Date(n.created_at), 'MMM d, HH:mm')}</span>
                                      <span className="mx-1">·</span>
                                      <span className="font-medium">{n.author_name}</span>
                                      <span className="mx-1">·</span>
                                      <span>{n.text}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {history.length === 0 && notes.length === 0 && (
                              <p className="text-xs text-muted-foreground">{t('historyDialog.noActivity')}</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Leads */}
            {leads.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-2">{t('nav.predictionLeads')}</h3>
                <div className="space-y-1.5">
                  {leads.map(l => (
                    <div key={l.id} className="rounded-lg border bg-card px-3 py-2 text-sm flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{l.name || t('historyDialog.noName')}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                          <Badge variant="outline" className="text-[10px]">{l.status}</Badge>
                          {l.product && <span>{l.product}</span>}
                          {l.assigned_agent_name && (
                            <span className="flex items-center gap-0.5"><User className="h-2.5 w-2.5" />{l.assigned_agent_name}</span>
                          )}
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground shrink-0">{formatDate(new Date(l.created_at), 'MMM d, yyyy')}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {totalOrders === 0 && totalLeads === 0 && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                {t('historyDialog.noHistory')}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
