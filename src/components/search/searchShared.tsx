import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  User, Phone, ShoppingCart, Clock, MapPin, Cake, Mail, Truck, Package,
  ChevronDown, ChevronRight, CreditCard, Hash,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { formatDate } from '@/i18n/dates';
import { statusLabel } from '@/types';
import { formatMoney } from '@/lib/currency';
import { cleanNoteForDisplay } from '@/lib/notes';
import { cn } from '@/lib/utils';
import { formatOrderProducts } from '@/lib/monadonSubstitutes';
import { STATUS_TONE, deliveryLabel, fullAddress, orderTotal, deriveCustomerSummary } from '@/lib/searchFormat';

// Customer Info card — personal details from the most recent order plus lifetime
// stats aggregated across the result set. `action` renders top-right (e.g. the
// "Open in Calls & call" button in the topbar-search modal).
const SOLD_STATUSES = new Set(['confirmed', 'shipped', 'delivered', 'paid', 'returned']);
/** Who sold the order: the sold_* stamp (seller_name), else the confirmer on a real sale; nothing for a non-sale. */
function sellerOf(order: { status?: string | null; seller_name?: string | null; confirmed_by_name?: string | null }): string | null {
  if (order.seller_name) return order.seller_name;
  return order.status && SOLD_STATUSES.has(order.status) ? (order.confirmed_by_name || null) : null;
}

export function CustomerSummaryCard({ orders, action }: { orders: any[]; action?: ReactNode }) {
  const { t } = useTranslation();
  const summary = useMemo(() => deriveCustomerSummary(orders), [orders]);
  if (!summary) return null;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <User className="h-4 w-4" /> {t('search.customer')}
          </CardTitle>
          {action}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2 text-sm">
          <div className="flex items-start gap-2">
            <User className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('search.name')}</div>
              <div className="font-medium">{summary.name}</div>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Phone className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('search.phone')}</div>
              <div className="font-mono">{summary.phone}</div>
            </div>
          </div>
          {summary.email && (
            <div className="flex items-start gap-2">
              <Mail className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('search.email')}</div>
                <div className="truncate">{summary.email}</div>
              </div>
            </div>
          )}
          {summary.birthday && (
            <div className="flex items-start gap-2">
              <Cake className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('search.birthday')}</div>
                <div>{formatDate(new Date(summary.birthday + 'T00:00:00'), 'dd MMM yyyy')}</div>
              </div>
            </div>
          )}
          {summary.address && (
            <div className="flex items-start gap-2 md:col-span-2 lg:col-span-3">
              <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('search.lastDeliveryAddress')}</div>
                <div className="break-words">{summary.address}</div>
              </div>
            </div>
          )}
        </div>

        {/* Lifetime stats — both currencies because Customer Intelligence used
            to display them and agents are used to seeing both. */}
        <div className="grid grid-cols-3 gap-3 pt-3 border-t">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('search.totalOrders')}</div>
            <div className="text-lg font-semibold tabular-nums">{summary.totalOrders}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('search.paidOrders')}</div>
            <div className="text-lg font-semibold tabular-nums">{summary.paidCount}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('search.lifetimeRevenue')}</div>
            <div className="text-lg font-semibold tabular-nums leading-tight">{formatMoney(summary.lifetimeRevenue)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Expandable orders table — the gold-standard result table shared by the Search
// Prediction page and the topbar-search modal. Fetches every order_note for the
// matched orders in one shot and groups by order_id (provenance + agent notes).
export function OrdersResultTable({ orders, orderHistory }: { orders: any[]; orderHistory: any[] }) {
  const { t } = useTranslation();
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);

  const orderIds = useMemo(() => (orders || []).map(o => o.id).filter(Boolean), [orders]);
  const { data: notesByOrder } = useQuery<Record<string, { text: string; author_name: string | null; created_at: string }[]>>({
    queryKey: ['search-prediction-order-notes', orderIds.join(',')],
    queryFn: async () => {
      if (orderIds.length === 0) return {};
      const { data, error } = await supabase
        .from('order_notes')
        .select('order_id, text, author_name, created_at')
        .in('order_id', orderIds)
        .order('created_at', { ascending: false });
      if (error) throw error;
      const map: Record<string, { text: string; author_name: string | null; created_at: string }[]> = {};
      for (const n of (data || [])) {
        if (!map[n.order_id]) map[n.order_id] = [];
        map[n.order_id].push({ text: n.text, author_name: n.author_name, created_at: n.created_at });
      }
      return map;
    },
    enabled: orderIds.length > 0,
    staleTime: 30_000,
  });

  if (!orders || orders.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <ShoppingCart className="h-5 w-5" /> {t('search.ordersHeader', { count: orders.length })}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <TooltipProvider delayDuration={200}>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/30">
                  <th className="text-left py-2 px-3 font-medium w-[28px]"><span className="sr-only">{t('search.expand')}</span></th>
                  <th className="text-left py-2 px-2 font-medium">{t('search.colOrder')}</th>
                  <th className="text-left py-2 px-2 font-medium">{t('search.colProducts')}</th>
                  <th className="text-left py-2 px-2 font-medium">{t('search.colDelivery')}</th>
                  <th className="text-left py-2 px-2 font-medium">{t('search.colNotes')}</th>
                  <th className="text-right py-2 px-2 font-medium">{t('search.colTotal')}</th>
                  <th className="text-left py-2 px-2 font-medium">{t('search.colStatus')}</th>
                  <th className="text-left py-2 px-2 font-medium">{t('search.colSeller')}</th>
                  <th className="text-right py-2 px-3 font-medium">{t('search.colDate')}</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => {
                  const items = order.order_items || [];
                  const productLabel = formatOrderProducts(order);
                  const total = orderTotal(order);
                  const orderNotes = notesByOrder?.[order.id] || [];
                  const latestNote = orderNotes[0];
                  const latestNoteText = cleanNoteForDisplay(latestNote?.text);
                  const tooltipBody = orderNotes.length > 0
                    ? orderNotes.map((n, i) => {
                        const when = n.created_at ? format(new Date(n.created_at), 'dd MMM yyyy HH:mm') : '';
                        const author = n.author_name || t('search.system');
                        const cleaned = cleanNoteForDisplay(n.text);
                        return `[${i + 1}] ${author} · ${when}\n${cleaned}`;
                      }).join('\n\n')
                    : '';
                  const dl = deliveryLabel(order);
                  const isExpanded = expandedOrder === order.id;
                  const history = orderHistory.filter(h => h.order_id === order.id);

                  return (
                    <>
                      <tr
                        key={order.id}
                        className={cn(
                          'border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors',
                          isExpanded && 'bg-muted/40',
                        )}
                        onClick={() => setExpandedOrder(isExpanded ? null : order.id)}
                      >
                        <td className="py-2 px-3">
                          {isExpanded
                            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                        </td>
                        <td className="py-2 px-2">
                          <div className="font-mono font-semibold">{order.display_id || order.id.slice(0, 8)}</div>
                          {!order.is_owned && (
                            <span className="text-[9px] px-1 py-0 rounded bg-muted text-muted-foreground">{t('search.viewOnly')}</span>
                          )}
                        </td>
                        <td className="py-2 px-2 max-w-[220px] truncate" title={productLabel}>{productLabel}</td>
                        <td className="py-2 px-2 max-w-[180px]">
                          <div className="leading-tight">
                            <div className="truncate" title={dl.line1}>{dl.icon} {dl.line1}</div>
                            <div className="truncate text-[10px] text-muted-foreground" title={dl.line2}>{dl.line2}</div>
                          </div>
                        </td>
                        <td className="py-2 px-2 max-w-[260px]">
                          {latestNoteText ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="block truncate text-muted-foreground cursor-help">{latestNoteText}</span>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-[420px] whitespace-pre-wrap text-[11px]">
                                {tooltipBody}
                                {orderNotes.length > 1 && (
                                  <div className="mt-1.5 pt-1.5 border-t text-[10px] opacity-70">{t('search.notesTotal', { count: orderNotes.length })}</div>
                                )}
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                        <td className="py-2 px-2 text-right tabular-nums font-mono leading-tight">
                          <div className="font-bold">{formatMoney(total)}</div>
                        </td>
                        <td className="py-2 px-2">
                          <Badge className={cn('text-[10px] font-medium', STATUS_TONE[order.status] || 'bg-muted text-muted-foreground')}>
                            {order.status ? statusLabel(order.status) : '—'}
                          </Badge>
                        </td>
                        {/* WHO SOLD IT (owner 01.10.2026) — the write-once sold_* stamp via order_departments; a cancel /
                            trash / open lead was never sold, so it shows a dash, never "unassigned". */}
                        <td className="py-2 px-2 max-w-[140px] truncate" title={sellerOf(order) || undefined}>
                          {sellerOf(order) || <span className="text-muted-foreground/60">—</span>}
                        </td>
                        <td className="py-2 px-3 text-right text-muted-foreground whitespace-nowrap">
                          {format(new Date(order.created_at), 'dd/MM/yy HH:mm')}
                        </td>
                      </tr>

                      {/* Expanded detail row — full notes, items breakdown, history */}
                      {isExpanded && (
                        <tr key={`${order.id}-expanded`} className="border-b bg-muted/10">
                          <td colSpan={9} className="py-3 px-4">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {/* Left column: items + payment + delivery details */}
                              <div className="space-y-3">
                                {items.length > 0 && (
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                                      <Package className="h-3 w-3" /> {t('search.lineItems')}
                                    </div>
                                    <table className="w-full text-[11px]">
                                      <tbody>
                                        {items.map((it: any) => (
                                          <tr key={it.id} className="border-b last:border-0">
                                            <td className="py-1">{it.product_name}</td>
                                            <td className="py-1 text-right tabular-nums text-muted-foreground">×{it.quantity}</td>
                                            <td className="py-1 text-right tabular-nums">{formatMoney(it.price_per_unit)}</td>
                                            <td className="py-1 text-right tabular-nums font-semibold">{formatMoney(it.total_price)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}

                                <div className="grid grid-cols-2 gap-2 text-[11px]">
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                                      <CreditCard className="h-3 w-3" /> {t('search.payment')}
                                    </div>
                                    <div className="tabular-nums">
                                      <span className="font-semibold">{formatMoney(total)}</span>

                                    </div>
                                  </div>
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                                      <Hash className="h-3 w-3" /> {t('search.source')}
                                    </div>
                                    <div>{order.source_type === 'opencart' ? 'naturatherapy.mk'
                                      : order.source_type === 'opencart_abandoned' ? 'naturatherapy.mk (abandoned)'
                                      : order.source_type === 'inbound_lead' ? 'Webhook'
                                      : order.source_type === 'prediction_lead' ? 'Lead'
                                      : (order.source_type || 'manual')}</div>
                                  </div>
                                </div>

                                <div>
                                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                                    <Truck className="h-3 w-3" /> {t('search.delivery')}
                                  </div>
                                  <div className="text-[11px]">{fullAddress(order)}</div>
                                  {order.postal_code && (
                                    <div className="text-[10px] text-muted-foreground">{t('search.postal', { code: order.postal_code })}</div>
                                  )}
                                  {order.delivery_instructions && (
                                    <div className="text-[10px] text-muted-foreground italic mt-1">{t('search.instructions', { text: order.delivery_instructions })}</div>
                                  )}
                                  {order.gift_note && (
                                    <div className="text-[10px] text-muted-foreground italic">{t('search.giftNote', { text: order.gift_note })}</div>
                                  )}
                                </div>
                              </div>

                              {/* Right column: notes (full) + history */}
                              <div className="space-y-3">
                                {orderNotes.length > 0 && (
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{t('search.notesCount', { count: orderNotes.length })}</div>
                                    <div className="space-y-1.5 max-h-[200px] overflow-y-auto pr-1">
                                      {orderNotes.map((n, i) => (
                                        <div key={i} className="rounded border bg-background p-2 text-[11px]">
                                          <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-0.5">
                                            <span>{n.author_name || t('search.system')}</span>
                                            <span>{n.created_at ? format(new Date(n.created_at), 'dd/MM/yy HH:mm') : ''}</span>
                                          </div>
                                          <div className="whitespace-pre-wrap">{cleanNoteForDisplay(n.text)}</div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {history.length > 0 && (
                                  <div>
                                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                                      <Clock className="h-3 w-3" /> {t('search.statusHistory')}
                                    </div>
                                    <div className="space-y-1 max-h-[160px] overflow-y-auto pr-1">
                                      {history.map((h) => (
                                        <div key={h.id} className="text-[11px] flex items-center gap-2 flex-wrap">
                                          <span className="text-muted-foreground tabular-nums">{format(new Date(h.changed_at), 'dd/MM HH:mm')}</span>
                                          {h.from_status && (
                                            <>
                                              <span className={cn('px-1 rounded text-[10px]', STATUS_TONE[h.from_status] || 'bg-muted')}>{statusLabel(h.from_status)}</span>
                                              <span className="text-muted-foreground">→</span>
                                            </>
                                          )}
                                          <span className={cn('px-1 rounded text-[10px]', STATUS_TONE[h.to_status] || 'bg-muted')}>{statusLabel(h.to_status)}</span>
                                          {h.changed_by_name && (
                                            <span className="text-muted-foreground text-[10px]">{t('search.byName', { name: h.changed_by_name })}</span>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}
