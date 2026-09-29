// Customer 360 — "everything about this customer" as one timeline.
//
// Reads GET /api/customers/timeline (public.customer_timeline, migration
// 20260939000100). The server has already cut what this caller may not see:
// owner-only money keys are ABSENT for everyone else, so every money render
// below is guarded by "is the key there", never by a role check of our own.
import { useMemo, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { departmentLabel } from '@/lib/orderSource';
import {
  AlertTriangle, ChevronDown, ChevronRight, Copy, ExternalLink, Globe, ListChecks, Loader2,
  MapPin, Megaphone, PhoneCall, ShoppingBag, StickyNote, Truck, Wallet,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/StatusBadge';
import { useToast } from '@/hooks/use-toast';
import { apiGetCustomerTimeline } from '@/lib/api';
import type { CustomerTimeline as TimelineData, TimelineEvent, TimelineKind, TimelineParcel } from '@/lib/api';
import { apiErrorText } from '@/i18n/apiErrors';
import { formatDenari, formatMoney } from '@/lib/currency';
import { orderReasonText } from '@/lib/orderReason';
import { cleanNoteForDisplay } from '@/lib/notes';
import { predictionListLabel } from '@/lib/predictionListLabel';
import { formatProductWithQuantity, cn } from '@/lib/utils';
import type { OrderStatus } from '@/types';
import {
  TIMELINE_KINDS, TONE_CLASSES, decisionKey, decisionTone, differentName, filterEvents, formatSeconds, formatSkopje,
  kindCounts, parcelTone, sourceKey, webOutcomeTone, type Tone,
} from './timelineModel';

interface CustomerTimelineProps {
  phone: string;
  /** Fetch only once the tab is actually opened. */
  enabled: boolean;
  /** Opens an order in the host page's own order modal. Without it the id links to /orders?search=. */
  onOpenOrder?: (orderId: string, displayId: string) => void;
}

/** Refusals the api can answer with (customer360.ts parseTimelinePhone). */
const KNOWN_ERRORS = new Set(['phone_too_short', 'phone_corrupted']);

const KIND_ICON: Record<TimelineKind, typeof ShoppingBag> = {
  order: ShoppingBag,
  web_order: Globe,
  altercpa_lead: Megaphone,
  parcel: Truck,
  call: PhoneCall,
  note: StickyNote,
  list: ListChecks,
};

function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0 text-[11px] font-semibold leading-4',
        TONE_CLASSES[tone],
        title && 'cursor-help',
      )}
    >
      {children}
    </span>
  );
}

function SourceBadge({ e }: { e: Pick<TimelineEvent, 'kind' | 'source' | 'source_detail' | 'department'> }) {
  const { t } = useTranslation();
  // An order names its DEPARTMENT (the six, by collabBox folder / MEX profile); the stored
  // source vocabulary is only the fallback for an older api and for non-order events.
  const dept = e.kind === 'order' ? departmentLabel(t, e.department) : null;
  const key = sourceKey(e);
  if (!dept && !key) return null;
  return (
    <Badge variant="outline" className="px-1.5 py-0 text-[10px] font-medium">
      {dept || t(`customer360.source.${key}`)}
    </Badge>
  );
}

function When({ iso }: { iso?: string }) {
  if (!iso) return null;
  return <span className="tabular-nums">{formatSkopje(iso)}</span>;
}

function TrackingId({ id }: { id: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      toast({ title: t('customer360.trackingCopied') });
    } catch {
      toast({ title: t('customer360.copyFailed'), variant: 'destructive' });
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={t('customer360.copyTracking')}
      className="inline-flex items-center gap-1 rounded px-1 font-mono text-[11px] hover:bg-muted"
    >
      {id}
      <Copy className="h-3 w-3 text-muted-foreground" />
    </button>
  );
}

function ParcelLine({ p, orderName }: { p: TimelineParcel; orderName?: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <Truck className="h-3 w-3 shrink-0 text-muted-foreground" />
      <TrackingId id={p.tracking_id} />
      {p.status_id != null && (
        <Pill tone={parcelTone(p)} title={p.status_name}>
          {t(`customer360.mexStatus.${p.status_id}`, { defaultValue: p.status_name ?? String(p.status_id) })}
        </Pill>
      )}
      {p.channel && <SourceBadge e={{ kind: 'parcel', source: p.channel }} />}
      {p.account && <span className="text-[10px] uppercase text-muted-foreground">{p.account.replace('_', ' ')}</span>}
      {p.cod_mkd != null && (
        <span className="font-semibold">{t('customer360.cod')}: {formatDenari(p.cod_mkd)}</span>
      )}
      {p.delivered_at && <span className="text-muted-foreground">{t('customer360.deliveredOn', { date: formatSkopje(p.delivered_at, false) })}</span>}
      {p.returned_at && <span className="text-muted-foreground">{t('customer360.returnedOn', { date: formatSkopje(p.returned_at, false) })}</span>}
      {p.receiver_name && differentName(p.receiver_name, orderName) && (
        <span className="text-muted-foreground">{t('customer360.receiver')}: {p.receiver_name}</span>
      )}
      {p.phone_match === false && (
        <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3" />{t('customer360.phoneMismatch')}
        </span>
      )}
    </div>
  );
}

function OrderRef({ id, displayId, onOpenOrder }: { id?: string; displayId?: string; onOpenOrder?: CustomerTimelineProps['onOpenOrder'] }) {
  const { t } = useTranslation();
  if (!displayId) return null;
  if (onOpenOrder && id) {
    return (
      <button type="button" onClick={() => onOpenOrder(id, displayId)} title={t('customer360.openOrder')}
        className="font-mono text-xs font-semibold text-primary hover:underline">
        {displayId}
      </button>
    );
  }
  return (
    <a href={`/orders?search=${encodeURIComponent(displayId)}`} target="_blank" rel="noopener noreferrer"
      title={t('customer360.openOrder')}
      className="inline-flex items-center gap-0.5 font-mono text-xs font-semibold text-primary hover:underline">
      {displayId}<ExternalLink className="h-3 w-3" />
    </a>
  );
}

function LeadLine({ e }: { e: NonNullable<TimelineEvent['lead']> }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <Megaphone className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="font-medium">{t('customer360.leadId', { id: e.altercpa_id })}</span>
      <Pill tone={decisionTone(e.decision)}>
        {t(`customer360.decision.${decisionKey(e.decision)}`, { defaultValue: e.decision ?? '' })}
      </Pill>
      {e.phase != null && <span className="text-muted-foreground">{t(`altercpa.phase_${e.phase}`, { defaultValue: String(e.phase) })}</span>}
      {e.decided_by && <span className="text-muted-foreground">{t('customer360.decidedBy', { name: e.decided_by })}</span>}
      {e.decided_at && <span className="text-muted-foreground"><When iso={e.decided_at} /></span>}
      {e.webmaster && <span className="text-muted-foreground">{t('customer360.webmaster', { id: e.webmaster })}</span>}
      {e.price_eur != null && <span className="font-semibold">{formatMoney(e.price_eur)}</span>}
    </div>
  );
}

function SystemNotes({ e }: { e: TimelineEvent }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const notes = e.system_notes ?? [];
  if (!e.system_notes_count) return null;
  return (
    <div className="text-xs">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-0.5 text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {t('customer360.systemNotes', { count: e.system_notes_count })}
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {notes.map((n, i) => (
            <div key={i} className="whitespace-pre-line rounded border bg-muted/30 px-2 py-1">
              <span className="text-muted-foreground"><When iso={n.at} /> · {n.who}</span>
              <div>{cleanNoteForDisplay(n.text)}</div>
            </div>
          ))}
          {e.system_notes_count > notes.length && (
            <p className="text-muted-foreground">{t('customer360.moreInHistory', { count: e.system_notes_count - notes.length })}</p>
          )}
        </div>
      )}
    </div>
  );
}

function OrderBody({ e, onOpenOrder }: { e: TimelineEvent; onOpenOrder?: CustomerTimelineProps['onOpenOrder'] }) {
  const { t } = useTranslation();
  const items = e.items?.length
    ? e.items.map((i) => formatProductWithQuantity(i.name, i.qty)).join(', ')
    : formatProductWithQuantity(e.title ?? '', e.quantity ?? 1);
  const reason = orderReasonText(e);
  const who = e.sold_by
    ? t('customer360.soldBy', { name: e.sold_by })
    : e.confirmed_by
      ? t('customer360.confirmedBy', { name: e.confirmed_by })
      : e.assigned_to ? t('customer360.assignedTo', { name: e.assigned_to }) : null;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <OrderRef id={e.refs?.order_id} displayId={e.refs?.display_id} onOpenOrder={onOpenOrder} />
        {e.status && <StatusBadge status={e.status as OrderStatus} order={e} />}
        <SourceBadge e={e} />
        {e.disposition && (
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]" title={t('customer360.dispositionHint')}>
            {t('customer360.disposition')}
          </Badge>
        )}
        {e.amount_eur != null && !e.disposition && (
          <span className="ml-auto text-sm font-bold text-primary">{formatMoney(e.amount_eur)}</span>
        )}
      </div>
      {items && <p className="text-sm">{items}</p>}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {who && <span>{who}</span>}
        {e.list && <span>{t('customer360.fromList', { name: e.list })}</span>}
        {e.city && <span className="inline-flex items-center gap-0.5"><MapPin className="h-3 w-3" />{e.city}</span>}
        {e.notes_count ? <span>{t('customer360.notesCount', { count: e.notes_count })}</span> : null}
      </div>
      {reason && (e.status === 'cancelled' || e.status === 'trashed' || e.status === 'returned') && (
        <p className="text-xs text-muted-foreground">{reason}</p>
      )}
      {e.lead && <LeadLine e={e.lead} />}
      {(e.parcels ?? []).map((p) => <ParcelLine key={p.tracking_id} p={p} orderName={e.customer_name} />)}
      <SystemNotes e={e} />
    </div>
  );
}

function WebOrderBody({ e }: { e: TimelineEvent }) {
  const { t } = useTranslation();
  const items = (e.items ?? [])
    .map((i) => `${formatProductWithQuantity(i.name, i.qty)}${i.gift ? ` (${t('customer360.gift')})` : ''}`)
    .join(', ');
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-xs font-semibold">{e.refs?.web_number ?? e.title}</span>
        {e.status && <Pill tone={webOutcomeTone(e.status)}>{t(`customer360.webOutcome.${e.status}`, { defaultValue: e.status })}</Pill>}
        <SourceBadge e={e} />
        {e.legacy && <span className="text-[10px] text-muted-foreground">OpenCart</span>}
        {e.amount_mkd != null && <span className="ml-auto text-sm font-bold text-primary">{formatDenari(e.amount_mkd)}</span>}
      </div>
      {items && <p className="text-sm">{items}</p>}
      {e.city && (
        <p className="inline-flex items-center gap-0.5 text-xs text-muted-foreground"><MapPin className="h-3 w-3" />{e.city}</p>
      )}
      {(e.parcels ?? []).map((p) => <ParcelLine key={p.tracking_id} p={p} />)}
    </div>
  );
}

function LeadBody({ e, onOpenOrder }: { e: TimelineEvent; onOpenOrder?: CustomerTimelineProps['onOpenOrder'] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium">{e.title || t('customer360.kind.altercpa_lead')}</span>
        <SourceBadge e={e} />
      </div>
      {e.lead && <LeadLine e={e.lead} />}
      <p className="text-xs text-muted-foreground">
        {e.refs?.display_id
          ? <>{t('customer360.leadOtherPhone')} <OrderRef id={e.refs.order_id} displayId={e.refs.display_id} onOpenOrder={onOpenOrder} /></>
          : t('customer360.leadNotImported')}
      </p>
    </div>
  );
}

function ParcelBody({ e, onOpenOrder }: { e: TimelineEvent; onOpenOrder?: CustomerTimelineProps['onOpenOrder'] }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1">
      {e.parcel && <ParcelLine p={e.parcel} />}
      <p className="text-xs text-muted-foreground">
        {e.linked_elsewhere && e.refs?.display_id
          ? <>{t('customer360.parcelOtherPhone')} <OrderRef id={e.refs.order_id} displayId={e.refs.display_id} onOpenOrder={onOpenOrder} /></>
          : <span title={t('customer360.mexOnlyHint')}>{t('customer360.mexOnly')}</span>}
        {e.parcel?.receiver_name && <> · {e.parcel.receiver_name}</>}
        {e.parcel?.receiver_city && <> · {e.parcel.receiver_city}</>}
      </p>
    </div>
  );
}

function CallBody({ e }: { e: TimelineEvent }) {
  const { t } = useTranslation();
  const secs = formatSeconds(e.seconds);
  return (
    <div className="space-y-0.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {e.status && <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">{t(`outcome.${e.status}`, { defaultValue: e.status })}</Badge>}
        {e.who && <span className="font-medium">{e.who}</span>}
        {secs && <span className="text-muted-foreground" title={t('customer360.callTimingHint')}>{t('customer360.duration', { duration: secs })}</span>}
        {e.refs?.display_id && <span className="font-mono text-muted-foreground">{e.refs.display_id}</span>}
      </div>
      {e.text && <p className="text-muted-foreground">{e.text}</p>}
    </div>
  );
}

function NoteBody({ e }: { e: TimelineEvent }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-0.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        {e.who && <span className="font-medium text-foreground">{e.who}</span>}
        {e.refs?.display_id && <span>{t('customer360.noteOn', { id: e.refs.display_id })}</span>}
      </div>
      <p className="whitespace-pre-line text-sm">{cleanNoteForDisplay(e.text)}</p>
    </div>
  );
}

function ListBody({ e }: { e: TimelineEvent }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-0.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium">{e.title}</span>
        {e.status && <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{t(`customer360.listStatus.${e.status}`, { defaultValue: e.status })}</Badge>}
      </div>
      <div className="flex flex-wrap gap-x-3 text-muted-foreground">
        <span>{t('customer360.listSince', { date: formatSkopje(e.at, false) })}</span>
        {e.who && <span>{t('customer360.assignedTo', { name: e.who })}</span>}
        {e.last_call_outcome && (
          <span>{t('customer360.lastCall', { outcome: t(`outcome.${e.last_call_outcome}`, { defaultValue: e.last_call_outcome }) })}</span>
        )}
      </div>
    </div>
  );
}

function EventBody({ e, onOpenOrder }: { e: TimelineEvent; onOpenOrder?: CustomerTimelineProps['onOpenOrder'] }) {
  switch (e.kind) {
    case 'order': return <OrderBody e={e} onOpenOrder={onOpenOrder} />;
    case 'web_order': return <WebOrderBody e={e} />;
    case 'altercpa_lead': return <LeadBody e={e} onOpenOrder={onOpenOrder} />;
    case 'parcel': return <ParcelBody e={e} onOpenOrder={onOpenOrder} />;
    case 'call': return <CallBody e={e} />;
    case 'note': return <NoteBody e={e} />;
    case 'list': return <ListBody e={e} />;
    default: return null;
  }
}

function Header({ tl }: { tl: TimelineData }) {
  const { t } = useTranslation();
  const c = tl.customer;
  const s = tl.summary;
  if (!c || !s) return null;
  const [mainName, ...otherNames] = c.names;
  const stat = (label: string, value: ReactNode, sub?: ReactNode) => (
    <div className="min-w-0 rounded-md border bg-card px-2 py-1">
      <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      {sub && <div className="truncate text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="text-sm">
        <span className="font-semibold">{mainName || t('historyDialog.noName')}</span>
        {otherNames.length > 0 && (
          <span className="text-xs text-muted-foreground"> · {t('customer360.alsoAs')} {otherNames.join(', ')}</span>
        )}
        <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
          {c.cities.length > 0 && <span className="inline-flex items-center gap-0.5"><MapPin className="h-3 w-3" />{c.cities.join(', ')}</span>}
          {c.first_seen && <span>{t('customer360.firstSeen')}: {formatSkopje(c.first_seen, false)}</span>}
          {c.last_seen && <span>{t('customer360.lastSeen')}: {formatSkopje(c.last_seen, false)}</span>}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {stat(t('customer360.kind.order'), s.sales,
          t('customer360.orderSplit', { delivered: s.delivered, returned: s.returned, cancelled: s.cancelled + s.trashed }))}
        {stat(t('customer360.kind.web_order'), s.web_orders, t('customer360.webSplit', { delivered: s.web_delivered }))}
        {stat(t('customer360.kind.altercpa_lead'), s.altercpa_leads)}
        {stat(t('customer360.kind.parcel'), s.parcels,
          t('customer360.parcelSplit', { delivered: s.parcels_delivered, returned: s.parcels_returned, mexOnly: s.parcels_mex_only }))}
      </div>
      {(s.lifetime_delivered_mkd != null || s.paid_orders_eur != null) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2 py-1 text-xs">
          <Wallet className="h-3.5 w-3.5 text-emerald-600" />
          {s.lifetime_delivered_mkd != null && (
            <span title={t('customer360.lifetimeCashHint')}>
              {t('customer360.lifetimeCash')}: <b className="tabular-nums">{formatDenari(s.lifetime_delivered_mkd)}</b>
            </span>
          )}
          {s.paid_orders_eur != null && (
            <span title={t('customer360.paidOrdersHint')}>
              {t('customer360.paidOrders')}: <b className="tabular-nums">{formatMoney(s.paid_orders_eur)}</b>
            </span>
          )}
        </div>
      )}
      {s.lists.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted-foreground">{t('customer360.listsNow')}:</span>
          {s.lists.map((l) => <Badge key={l} variant="outline" className="px-1.5 py-0 text-[10px]" title={l}>{predictionListLabel(l)}</Badge>)}
        </div>
      )}
    </div>
  );
}

export function CustomerTimeline({ phone, enabled, onOpenOrder }: CustomerTimelineProps) {
  const { t } = useTranslation();
  const phone8 = (phone || '').replace(/\D/g, '').slice(-8);
  const valid = phone8.length === 8;
  const q = useQuery({
    queryKey: ['customer-timeline', phone8],
    queryFn: () => apiGetCustomerTimeline(phone),
    enabled: enabled && valid,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
  const [kinds, setKinds] = useState<Set<TimelineKind>>(new Set());
  const counts = useMemo(() => kindCounts(q.data), [q.data]);
  const events = useMemo(() => filterEvents(q.data?.events, kinds), [q.data, kinds]);

  if (!valid) return <p className="py-8 text-center text-sm text-muted-foreground">{t('customer360.phoneTooShort')}</p>;
  if (q.isPending) {
    return <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  }
  if (q.isError || !q.data?.ok) {
    const code = q.isError ? (q.error instanceof Error ? q.error.message : '') : (q.data?.error ?? '');
    const msg = KNOWN_ERRORS.has(code)
      ? t(`customer360.error.${code}`)
      : q.isError ? apiErrorText(q.error) : t('customer360.loadFailed');
    return (
      <div className="space-y-2 py-8 text-center text-sm">
        <p className="text-destructive">{t('customer360.loadFailed')}</p>
        <p className="text-xs text-muted-foreground">{msg}</p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>{t('common.retry')}</Button>
      </div>
    );
  }

  const tl = q.data;
  const toggle = (k: TimelineKind) => setKinds((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  return (
    <div className={cn('space-y-3', q.isFetching && 'opacity-70 transition-opacity')}>
      <Header tl={tl} />

      <div className="flex flex-wrap gap-1">
        <button type="button" onClick={() => setKinds(new Set())}
          className={cn('rounded-full border px-2 py-0.5 text-xs', kinds.size === 0 ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>
          {t('customer360.allKinds')} ({tl.total_events ?? 0})
        </button>
        {TIMELINE_KINDS.filter((k) => (counts[k] ?? 0) > 0).map((k) => {
          const Icon = KIND_ICON[k];
          return (
            <button key={k} type="button" onClick={() => toggle(k)}
              className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                kinds.has(k) ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>
              <Icon className="h-3 w-3" />{t(`customer360.kind.${k}`)} ({counts[k]})
            </button>
          );
        })}
      </div>

      {tl.truncated && (
        <p className="text-xs text-muted-foreground">
          {t('customer360.truncated', { shown: tl.events?.length ?? 0, total: tl.total_events ?? 0 })}
        </p>
      )}

      {events.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t('customer360.empty')}</p>
      ) : (
        <ol className="relative ml-3 border-l border-border">
          {events.map((e) => {
            const Icon = KIND_ICON[e.kind] ?? StickyNote;
            return (
              <li key={e.key} className="mb-3 ml-5">
                <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full bg-background ring-2 ring-border">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
                <div className="mb-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <When iso={e.at} />
                  <span>· {t(`customer360.kindOne.${e.kind}`)}</span>
                </div>
                <div className="rounded-lg border bg-card px-3 py-2">
                  <EventBody e={e} onOpenOrder={onOpenOrder} />
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
