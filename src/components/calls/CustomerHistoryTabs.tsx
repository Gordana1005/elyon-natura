import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
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
import { cancelReasonLabel } from '@/lib/cancellationReasons';
import { CallScriptsPanel } from './CallScriptsPanel';

interface Props {
  phone: string;
  onOpenOrder?: (orderId: string) => void;
  showScripts?: boolean;
}

// Return reasons live in src/i18n/locales/*.json under "returnReason.*".
const returnReasonLabel = (v: string): string => i18n.t(`returnReason.${v}`, { defaultValue: v });

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
    <div className="grid grid-cols-1 lg:grid-cols-[7fr_3fr] gap-3 items-start">
      {/* Left — History (every order status) */}
      <div className={`rounded-xl border border-border/60 bg-card p-3 ${hoverLift}`}>
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
            <OrdersTable orders={orders} onOpenOrder={onOpenOrder} />
          )}
        </div>
      </div>

      {/* Right — Calls log */}
      <div className={`rounded-xl border border-border/60 bg-card p-3 ${hoverLift}`}>
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
            <CallsTable calls={calls} />
          )}
        </div>
      </div>
    </div>

    {/* Scripts & Helpers panel — shown to everyone on Calls when enabled */}
    {showScripts && <CallScriptsPanel />}
    </div>
  );
}

function OrdersTable({ orders, onOpenOrder }: { orders: any[]; onOpenOrder?: (id: string) => void }) {
  const { t } = useTranslation();
  return (
    <TooltipProvider>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
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
              const items = o.order_items || [];
              const productLabel = formatOrderProducts(o);
              const total = items.reduce((s: number, i: any) => s + Number(i.total_price || 0), 0)
                || Number(o.price || 0) * Number(o.quantity || 1);
              const reasonLabel = o.cancellation_reason
                ? cancelReasonLabel(o.cancellation_reason)
                : o.return_reason
                  ? returnReasonLabel(o.return_reason)
                  : null;
              const reasonNotes = cleanNoteForDisplay(o.cancellation_reason_notes || o.return_reason_notes || '');
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
                    {reasonLabel ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-[11px] italic text-muted-foreground truncate cursor-help block">
                            {reasonLabel}{reasonNotes && ' — '}{reasonNotes && <span className="text-muted-foreground/70">{reasonNotes}</span>}
                          </span>
                        </TooltipTrigger>
                        {reasonNotes && (
                          <TooltipContent side="top" className="max-w-[420px] text-[11px]">
                            <div className="font-semibold">{reasonLabel}</div>
                            <div className="opacity-80 mt-0.5 whitespace-pre-wrap">{reasonNotes}</div>
                          </TooltipContent>
                        )}
                      </Tooltip>
                    ) : (
                      <span className="text-muted-foreground/30 text-[10px]">—</span>
                    )}
                  </td>
                  <td className="py-1.5 pl-3 text-[11px] whitespace-nowrap">
                    {o.assigned_agent_name
                      ? <span className="text-foreground">{o.assigned_agent_name}</span>
                      : <span className="text-muted-foreground/50">{t('customerHistory.unassigned')}</span>}
                  </td>
                  <td className="py-1.5 text-right text-muted-foreground text-[11px] whitespace-nowrap">
                    {o.created_at ? format(new Date(o.created_at), 'dd/MM/yy') : '—'}
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

function CallsTable({ calls }: { calls: CustomerHistoryCall[] }) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delayDuration={200}>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left py-1.5 font-medium">{t('customerHistory.colAgent')}</th>
            <th className="text-left py-1.5 font-medium pl-2">{t('customerHistory.colOutcome')}</th>
            <th className="text-right py-1.5 font-medium pl-2">{t('customerHistory.colLength')}</th>
            <th className="text-right py-1.5 font-medium pl-2">{t('customerHistory.colWhen')}</th>
          </tr>
        </thead>
        <tbody>
          {calls.slice(0, 100).map(c => {
            const isAnswered = c.connection_state === 'answered'
              || (c.connection_state == null && (c.connected_at != null || (c.talk_seconds ?? 0) > 0));
            const Icon = isAnswered ? Phone : PhoneOff;
            const dur = formatCallDuration(c);
            const when = c.started_at || c.created_at;
            const notes = cleanNoteForDisplay(c.notes || '');
            return (
              <Tooltip key={c.id}>
                <TooltipTrigger asChild>
                  <tr className="border-b last:border-0 hover:bg-muted/30 cursor-help align-top">
                    <td className="py-1.5 max-w-[110px]">
                      <span className="inline-flex items-center gap-1 min-w-0">
                        <Icon className={cn('h-3 w-3 shrink-0', isAnswered ? 'text-emerald-600' : 'text-muted-foreground')} />
                        <span className="truncate">{c.agent_name}</span>
                      </span>
                    </td>
                    <td className="py-1.5 pl-2">
                      <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap',
                        OUTCOME_TONE[c.outcome] || 'bg-muted text-muted-foreground')}>
                        {t(`outcome.${c.outcome}`, { defaultValue: c.outcome.replace(/_/g, ' ') })}
                      </span>
                    </td>
                    <td className="py-1.5 pl-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">{dur}</td>
                    <td className="py-1.5 pl-2 text-right text-muted-foreground whitespace-nowrap leading-tight">
                      {when ? (
                        <>
                          <div>{format(new Date(when), 'dd/MM/yy')}</div>
                          <div className="text-[9px] text-muted-foreground/70 tabular-nums">{format(new Date(when), 'HH:mm')}</div>
                        </>
                      ) : '—'}
                    </td>
                  </tr>
                </TooltipTrigger>
                <TooltipContent side="left" className="max-w-[320px] text-[11px]">
                  <div className="font-semibold">{c.agent_name} · {t(`outcome.${c.outcome}`, { defaultValue: c.outcome.replace(/_/g, ' ') })}</div>
                  <div className="opacity-80 mt-0.5">
                    {when ? formatDate(new Date(when), 'dd MMM yyyy HH:mm') : '—'} · {dur}
                  </div>
                  {notes && <div className="opacity-80 mt-1 whitespace-pre-wrap border-t pt-1">{notes}</div>}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </tbody>
      </table>
    </TooltipProvider>
  );
}
