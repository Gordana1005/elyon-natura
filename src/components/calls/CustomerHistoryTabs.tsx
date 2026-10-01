import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { formatSkopje } from '@/lib/skopjeTime';
import i18n from '@/i18n';
import { formatDate } from '@/i18n/dates';
import { ShoppingCart, Phone, PhoneOff, PhoneCall } from 'lucide-react';
import { apiGetCustomerHistory, type CustomerHistoryCall } from '@/lib/api';
import { StatusBadge } from '@/components/StatusBadge';
import { OrderStatus } from '@/types';
import { formatMoney } from '@/lib/currency';
import { cleanNoteForDisplay } from '@/lib/notes';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatOrderProducts } from '@/lib/monadonSubstitutes';
import { EmptyState } from '@/components/EmptyState';
import { hoverLift } from '@/lib/design-utils';
import { orderReasonText } from '@/lib/orderReason';
import { callReasonFor } from '@/lib/callsWork/priorDecisions';
import { orderTotal } from '@/lib/searchFormat';
import { CallScriptsPanel } from './CallScriptsPanel';

interface Props {
  phone: string;
  onOpenOrder?: (orderId: string) => void;
  showScripts?: boolean;
}

// Call outcomes — shared words (confirmed/cancelled/trash/call_again) match the
// canonical status palette so the same word reads the same colour everywhere.
const OUTCOME_TONE: Record<string, string> = {
  confirmed: 'bg-[hsl(var(--success))] text-white border-[hsl(var(--success))]',
  cancelled: 'bg-destructive text-white border-destructive',
  trash: 'bg-muted-foreground text-white border-muted-foreground',
  call_again: 'bg-[hsl(var(--info))] text-white border-[hsl(var(--info))]',
  no_answer: 'bg-[hsl(var(--warning))] text-white border-[hsl(var(--warning))]',
  interested: 'bg-[hsl(var(--info))] text-white border-[hsl(var(--info))]',
  not_interested: 'bg-destructive text-white border-destructive',
  wrong_number: 'bg-muted-foreground text-white border-muted-foreground',
};

function formatCallDuration(call: CustomerHistoryCall): string {
  // No timestamps captured (legacy row) → just show "Logged"
  if (!call.started_at) return i18n.t('customerHistory.logged');
  if (call.connection_state === 'no_answer' || (!call.connected_at && call.ring_seconds != null)) {
    return i18n.t('customerHistory.ringSeconds', { seconds: call.total_seconds ?? call.ring_seconds ?? 0 });
  }
  if (call.talk_seconds != null) {
    const m = Math.floor(call.talk_seconds / 60);
    const s = call.talk_seconds % 60;
    return i18n.t('customerHistory.talkDuration', { duration: `${m}:${String(s).padStart(2, '0')}` });
  }
  return '—';
}

export function CustomerHistoryTabs({ phone, onOpenOrder, showScripts }: Props) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['customer-history', phone],
    queryFn: () => apiGetCustomerHistory(phone),
    enabled: !!phone && phone.replace(/\D/g, '').length >= 6,
    // Always refetch on open so a just-recorded cancel/trash shows immediately.
    staleTime: 0,
  });

  const orders = data?.orders ?? [];
  const calls = data?.calls ?? [];

  return (
    <div className="space-y-3">
    {/* minmax(0, …): a column may shrink below its content — nothing pushes past the page edge. */}
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,7fr)_minmax(0,3fr)] gap-3 items-start">
      {/* Left — History (every order status) */}
      <div className={`min-w-0 rounded-xl border border-border/60 bg-card p-3 ${hoverLift}`}>
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          <ShoppingCart className="h-3.5 w-3.5 text-amber-400" />
          {t('customerHistory.historyHeader')} <span className="font-normal normal-case">({orders.length})</span>
        </div>
        <div className="max-h-[440px] overflow-y-auto">
          {isLoading ? (
            <p className="text-xs text-muted-foreground p-4">{t('common.loading')}</p>
          ) : orders.length === 0 ? (
            <EmptyState
              icon={<Phone className="h-4 w-4 text-amber-400" />}
              title={t('customerHistory.noHistory')}
              size="sm"
              className="border-0 bg-transparent py-2 text-xs"
            />
          ) : (
            <>
              {/* Cards below xl (plan Фаза 11 — the 7-column table scrolled sideways at 390 px
                  and pushed the page wider than the screen up to 1280 px); the table from xl. */}
              <OrdersCards orders={orders} onOpenOrder={onOpenOrder} />
              <div className="hidden xl:block">
                <OrdersTable orders={orders} onOpenOrder={onOpenOrder} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right — Calls log */}
      <div className={`min-w-0 rounded-xl border border-border/60 bg-card p-3 ${hoverLift}`}>
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
          <PhoneCall className="h-3.5 w-3.5 text-teal-400" />
          {t('customerHistory.callsHeader')} <span className="font-normal normal-case">({calls.length})</span>
        </div>
        <div className="max-h-[440px] overflow-y-auto">
          {isLoading ? (
            <p className="text-xs text-muted-foreground p-4">{t('common.loading')}</p>
          ) : calls.length === 0 ? (
            <EmptyState
              icon={<PhoneCall className="h-4 w-4 text-teal-400" />}
              title={t('customerHistory.noCalls')}
              size="sm"
              className="border-0 bg-transparent py-2 text-xs"
            />
          ) : (
            // One compact list on every width (the narrow 3fr column never fit a 4-column table).
            <CallsCards calls={calls} orders={orders} />
          )}
        </div>
      </div>
    </div>

    {/* Scripts & Helpers panel — shown to everyone on Calls when enabled */}
    {showScripts && <CallScriptsPanel />}
    </div>
  );
}

/** The history below md: one card per order — every field the table shows, nothing scrolls sideways. */
function OrdersCards({ orders, onOpenOrder }: { orders: any[]; onOpenOrder?: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <ul className="space-y-1.5 xl:hidden" data-testid="history-cards">
      {orders.slice(0, 50).map((o) => {
        const productLabel = formatOrderProducts(o);
        // One reading for cancel / trash / return — reason + what the agent wrote (orderReasonText).
        const reason = orderReasonText(o);
        return (
          <li key={o.id}>
            <button
              type="button"
              onClick={() => onOpenOrder?.(o.id)}
              disabled={!onOpenOrder}
              title={onOpenOrder ? t('customerHistory.editStatusHint') : undefined}
              className="w-full min-w-0 rounded-lg border bg-card px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{o.display_id || o.id.slice(0, 8)}</span>
                {o.status
                  ? <StatusBadge status={o.status as OrderStatus} order={o} className="text-[10px]" />
                  : <span className="text-[10px] text-muted-foreground/40">—</span>}
              </div>
              <div className="mt-1 flex min-w-0 items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium" title={productLabel}>{productLabel}</span>
                <span className="shrink-0 font-mono font-bold tabular-nums">{formatMoney(orderTotal(o))}</span>
              </div>
              <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span className="min-w-0 truncate">{o.assigned_agent_name || t('customerHistory.unassigned')}</span>
                <span className="shrink-0 tabular-nums">{o.created_at ? formatSkopje(o.created_at, 'dd/MM/yy') : '—'}</span>
              </div>
              {reason && (
                <div className="mt-1 line-clamp-2 break-words text-[11px] italic text-muted-foreground" data-testid="history-reason">
                  {reason}
                </div>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The calls log: a compact list (agent · when · length, the outcome chip + its reason, the note) on every width. */
function CallsCards({ calls, orders }: { calls: CustomerHistoryCall[]; orders: any[] }) {
  const { t } = useTranslation();
  const ordersById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
  return (
    <ul className="divide-y" data-testid="history-call-cards">
      {calls.slice(0, 100).map((c) => {
        const isAnswered = c.connection_state === 'answered'
          || (c.connection_state == null && (c.connected_at != null || (c.talk_seconds ?? 0) > 0));
        const Icon = isAnswered ? Phone : PhoneOff;
        const when = c.started_at || c.created_at;
        const notes = cleanNoteForDisplay(c.notes || '');
        const reason = callReasonFor(c, ordersById);
        return (
          <li key={c.id} className="min-w-0 py-1.5 text-xs">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1">
                <Icon className={cn('h-3 w-3 shrink-0', isAnswered ? 'text-emerald-600' : 'text-muted-foreground')} />
                <span className="truncate">{c.agent_name}</span>
              </span>
              <span className="flex min-w-0 shrink items-center justify-end gap-1">
                {reason && (
                  <span className="min-w-0 truncate rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground" title={reason} data-testid="call-reason">
                    {reason}
                  </span>
                )}
                <span className={cn('shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium',
                  OUTCOME_TONE[c.outcome] || 'bg-muted text-muted-foreground')}>
                  {t(`outcome.${c.outcome}`, { defaultValue: c.outcome.replace(/_/g, ' ') })}
                </span>
              </span>
            </div>
            <div className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
              {when ? formatDate(when, 'dd.MM.yy HH:mm') : '—'} · {formatCallDuration(c)}
            </div>
            {notes && <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">{notes}</div>}
          </li>
        );
      })}
    </ul>
  );
}

function OrdersTable({ orders, onOpenOrder }: { orders: any[]; onOpenOrder?: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <TooltipProvider>
      <div>
        {/* Fixed layout: the columns share the card's width (product / reason / agent truncate,
            the full text in the tooltip) — the table can never be wider than its card. */}
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col className="w-[4.5rem]" />
            <col />
            <col className="w-[5.5rem]" />
            <col className="w-[7rem]" />
            <col />
            <col className="w-[8.5rem]" />
            <col className="w-[4.25rem]" />
          </colgroup>
          <thead>
            <tr className="border-b text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left py-1.5 font-medium">{t('customerHistory.colId')}</th>
              <th className="text-left py-1.5 font-medium">{t('customerHistory.colProducts')}</th>
              <th className="text-right py-1.5 font-medium pl-3">{t('customerHistory.colTotal')}</th>
              <th className="text-left py-1.5 font-medium pl-3">{t('customerHistory.colStatus')}</th>
              <th className="text-left py-1.5 font-medium pl-3">{t('customerHistory.colReason')}</th>
              <th className="text-left py-1.5 font-medium pl-3">{t('customerHistory.colAgent')}</th>
              <th className="text-right py-1.5 font-medium">{t('customerHistory.colDate')}</th>
            </tr>
          </thead>
          <tbody>
            {orders.slice(0, 50).map(o => {
              const productLabel = formatOrderProducts(o);
              // orders.price is the order TOTAL — never × quantity (orderTotal).
              const total = orderTotal(o);
              const reason = orderReasonText(o);
              return (
                <tr
                  key={o.id}
                  className="border-b last:border-0 hover:bg-muted/60 cursor-pointer transition-colors"
                  onClick={() => onOpenOrder?.(o.id)}
                >
                  <td className="py-1.5 font-mono text-[11px]">{o.display_id || o.id.slice(0, 8)}</td>
                  <td className="py-1.5 max-w-[220px] truncate" title={productLabel}>{productLabel}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums font-mono leading-tight">
                    <div className="font-bold">{formatMoney(total)}</div>
                  </td>
                  <td className="py-1.5 pl-3">
                    {/* The pill is a BUTTON, not decoration. An agent handed a
                        client by the manager needs a way to record what happened
                        on the order that already exists — without one they made a
                        second order instead, which is the fork bug. The row is
                        clickable too, but the status is what they reach for. */}
                    {o.status
                      ? (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); onOpenOrder?.(o.id); }}
                          disabled={!onOpenOrder}
                          title={onOpenOrder ? t('customerHistory.editStatusHint') : undefined}
                          className="rounded-full transition hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:opacity-100"
                        >
                          <StatusBadge status={o.status as OrderStatus} order={o} className="text-[10px]" />
                        </button>
                      )
                      : <span className="text-muted-foreground/40 text-[10px]">—</span>}
                  </td>
                  <td className="py-1.5 pl-3 max-w-[200px]">
                    {reason ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-[11px] italic text-muted-foreground truncate cursor-help block">
                            {reason}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-[420px] text-[11px] whitespace-pre-wrap">
                          {reason}
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      <span className="text-muted-foreground/30 text-[10px]">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pl-3 text-[11px] whitespace-nowrap truncate" title={o.assigned_agent_name || undefined}>
                    {o.assigned_agent_name
                      ? <span className="text-foreground">{o.assigned_agent_name}</span>
                      : <span className="text-muted-foreground/50">{t('customerHistory.unassigned')}</span>}
                  </td>
                  <td className="py-1.5 text-right text-muted-foreground text-[11px] whitespace-nowrap">
                    {o.created_at ? formatSkopje(o.created_at, 'dd/MM/yy') : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}
