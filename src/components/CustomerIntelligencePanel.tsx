import { useState } from 'react';
import { CustomerIntelligence } from '@/hooks/useCustomerIntelligence';
import {
  User,
  ChevronDown, ChevronUp, Clock, Star, AlertTriangle, Shield, ShoppingBag,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { formatOrderProducts } from '@/lib/monadonSubstitutes';
import { formatSkopje } from '@/lib/skopjeTime';
import { formatDate } from '@/i18n/dates';
import { formatMoney } from '@/lib/currency';
import { STATUS_COLORS, statusLabel } from '@/types';

// Use the single canonical status palette (src/types/index.ts).
const STATUS_CHIP: Record<string, string> = { ...STATUS_COLORS };

interface Props {
  data: CustomerIntelligence | null;
  loading: boolean;
  compact?: boolean;
  /** Skip the Past Orders block — used by ClientProfileCard which already
   *  renders its own Orders History table. */
  hideOrdersHistory?: boolean;
}

/** The api's quality_reason is English text; this is the reader's language from the counts. */
export function qualityReasonText(t: (k: string, o?: Record<string, unknown>) => string, stats?: { paid_orders?: number; returned_orders?: number; total_orders?: number } | null): string | undefined {
  if (!stats) return undefined;
  return t('callsWork.quality.reason', { paid: stats.paid_orders ?? 0, returned: stats.returned_orders ?? 0, total: stats.total_orders ?? 0 });
}

export function LeadQualityBadge({ score, reason }: { score?: string; reason?: string }) {
  const { t } = useTranslation();
  if (!score) return null;
  // Labels in the reader's language (they were hard-coded HIGH / MEDIUM / RISK).
  const config = {
    HIGH: { icon: Star, className: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30', label: t('callsWork.quality.HIGH') },
    MEDIUM: { icon: Shield, className: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30', label: t('callsWork.quality.MEDIUM') },
    RISK: { icon: AlertTriangle, className: 'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30', label: t('callsWork.quality.RISK') },
  }[score] || { icon: Shield, className: 'bg-muted text-muted-foreground', label: score };

  const Icon = config.icon;
  return (
    <span title={reason} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider', config.className)} data-testid="lead-quality">
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}

export function CustomerIntelligencePanel({ data, loading, hideOrdersHistory = false }: Props) {
  const { t } = useTranslation();
  // Default open — the past-orders list is the most useful information here
  // and the original collapsed state was easy to miss.
  const [expanded, setExpanded] = useState(true);

  if (loading) {
    return (
      <div className="rounded-lg border border-dashed p-3 animate-pulse">
        <div className="h-3 bg-muted rounded w-1/3 mb-2" />
        <div className="h-3 bg-muted rounded w-2/3" />
      </div>
    );
  }

  if (!data?.found) return null;

  const stats = data.stats!;
  const lastOrder = data.last_order;

  return (
    <div className="rounded-lg border bg-card p-3 space-y-2">
      {/* Whole header + stats row toggles expand/collapse — clicking anywhere
          on the always-visible summary opens the past-orders list. */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full text-left space-y-2 cursor-pointer rounded-md hover:bg-muted/30 -m-1 p-1 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10">
              <User className="h-3 w-3 text-primary" />
            </div>
            <span className="text-xs font-semibold text-card-foreground">{t('intel.title')}</span>
            <LeadQualityBadge score={data.quality_score} reason={qualityReasonText(t, data.stats)} />
          </div>
          {expanded ? <ChevronUp className="h-3 w-3 text-muted-foreground" /> : <ChevronDown className="h-3 w-3 text-muted-foreground" />}
        </div>

        <div className="grid grid-cols-4 gap-2 text-center">
          <div>
            <div className="text-[10px] text-muted-foreground">{t('clientProfile.metricOrders')}</div>
            <div className="text-sm font-bold">{stats.total_orders}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">{t('clientProfile.metricPaid')}</div>
            <div className="text-sm font-bold text-emerald-600">{stats.paid_orders}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">{t('clientProfile.metricReturned')}</div>
            <div className="text-sm font-bold text-rose-600">{stats.returned_orders}</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground">{t('clientProfile.metricRevenue')}</div>
            <div className="text-sm font-bold text-primary leading-tight">{formatMoney(stats.lifetime_revenue)}</div>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="space-y-3 pt-1 border-t">
          {/* Past Orders — paid first, then everything else, with line items.
              Skipped when this panel renders inside ClientProfileCard since
              that component already shows an Orders History table below. */}
          {!hideOrdersHistory && (
            <OrdersHistorySection ordersHistory={data.orders_history || []} />
          )}

          {/* Timeline */}
          {data.timeline && data.timeline.length > 0 && (
            <div className="space-y-1">
              <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <Clock className="h-3 w-3" /> {t('intel.statusTimeline')}
              </h4>
              <div className="space-y-1 max-h-[150px] overflow-y-auto pr-1">
                {data.timeline.slice(0, 20).map((event, idx) => (
                  <TimelineEvent key={idx} event={event} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OrdersHistorySection({ ordersHistory }: { ordersHistory: NonNullable<CustomerIntelligence['orders_history']> }) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  if (!ordersHistory || ordersHistory.length === 0) return null;

  // Paid first, then the rest, all newest-first within each bucket
  const paid = ordersHistory.filter(o => o.status === 'paid');
  const others = ordersHistory.filter(o => o.status !== 'paid');
  const ordered = [...paid, ...others];
  const visible = showAll ? ordered : ordered.slice(0, 5);

  return (
    <div className="space-y-1">
      <h4 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
        <ShoppingBag className="h-3 w-3" /> {t('intel.pastOrders')}
        <span className="text-muted-foreground/70 normal-case font-normal">
          ({t('intel.paidCount', { count: paid.length })}{others.length > 0 ? ` · ${t('intel.otherCount', { count: others.length })}` : ''})
        </span>
      </h4>
      <div className="space-y-1 max-h-[260px] overflow-y-auto pr-1">
        {visible.map(order => (
          <PastOrderRow key={order.id} order={order} />
        ))}
      </div>
      {ordered.length > 5 && (
        <button
          onClick={() => setShowAll(s => !s)}
          className="text-[10px] text-primary hover:underline mt-1"
        >
          {showAll ? t('intel.showFewer') : t('intel.showAll', { count: ordered.length })}
        </button>
      )}
    </div>
  );
}

function PastOrderRow({ order }: { order: NonNullable<CustomerIntelligence['orders_history']>[number] }) {
  useTranslation(); // re-render status labels on language switch
  const itemsLabel = formatOrderProducts(order);
  const isPaid = order.status === 'paid';
  return (
    <div className={cn(
      'rounded border px-2 py-1.5 text-xs',
      isPaid ? 'bg-emerald-50/40 border-emerald-200/60 dark:bg-emerald-950/20 dark:border-emerald-800/40' : 'bg-card'
    )}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono text-[10px] font-semibold shrink-0">{order.display_id}</span>
          <span className={cn('text-[9px] px-1.5 py-0 rounded-full font-medium uppercase tracking-wide border', STATUS_CHIP[order.status] || 'bg-muted')}>
            {statusLabel(order.status)}
          </span>
        </div>
        <span className="text-right tabular-nums shrink-0 leading-tight">
          <span className="block font-bold">{formatMoney(order.price)}</span>
        </span>
      </div>
      <div className="mt-0.5 text-muted-foreground truncate">{itemsLabel}</div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground/80 mt-0.5">
        <span>{formatDate(order.date, 'dd MMM yyyy')}</span>
        {order.agent && <span>{order.agent}</span>}
      </div>
    </div>
  );
}

function TimelineEvent({ event }: { event: any }) {
  const { t } = useTranslation();
  const EMOJI: Record<string, string> = {
    lead_created: '📋',
    status_confirmed: '✅',
    status_shipped: '📦',
    status_delivered: '🚚',
    status_paid: '💰',
    status_returned: '↩️',
    status_call_again: '📞',
    status_take: '👋',
    status_pending: '⏳',
    status_trashed: '🗑️',
    status_cancelled: '❌',
  };
  const label = event.type === 'lead_created'
    ? `${EMOJI.lead_created} ${t('intel.leadCreated')}`
    : event.type.startsWith('status_')
      ? `${EMOJI[event.type] || '📌'} ${statusLabel(event.type.replace('status_', ''))}`
      : `📌 ${event.type.replace(/_/g, ' ')}`;

  return (
    <div className="flex items-start gap-2 text-xs">
      <span className="text-muted-foreground shrink-0 w-[70px]">
        {formatSkopje(event.date, 'dd/MM HH:mm')}
      </span>
      <span className="font-medium">{label}</span>
      {event.agent && <span className="text-muted-foreground ml-auto">{t('intel.byAgent', { agent: event.agent })}</span>}
    </div>
  );
}
