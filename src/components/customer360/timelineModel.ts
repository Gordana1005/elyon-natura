// Customer 360 — pure helpers for the timeline tab (no React, unit-tested).
//
// The data contract is CustomerTimeline in src/lib/api.ts, built by
// public.customer_timeline (migration 20260939000100).
import type { CustomerTimeline, TimelineEvent, TimelineKind, TimelineParcel } from '@/lib/api';

/** Display order of the kind filter chips. */
export const TIMELINE_KINDS: TimelineKind[] = ['order', 'web_order', 'altercpa_lead', 'parcel', 'call', 'note', 'list'];

// DD.MM.YYYY HH:mm in Europe/Skopje, whatever the browser's own zone is — an
// agent on a laptop set to UTC must read the same clock as the office.
const SKOPJE_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Skopje',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

export function formatSkopje(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p: Record<string, string> = {};
  for (const part of SKOPJE_FMT.formatToParts(d)) p[part.type] = part.value;
  // Some engines print midnight as "24" with hour12:false.
  const hour = p.hour === '24' ? '00' : p.hour;
  const date = `${p.day}.${p.month}.${p.year}`;
  return withTime ? `${date} ${hour}:${p.minute}` : date;
}

/** Events of the selected kinds; an empty selection means everything. */
export function filterEvents(events: TimelineEvent[] | undefined, kinds: ReadonlySet<TimelineKind>): TimelineEvent[] {
  const list = events ?? [];
  return kinds.size === 0 ? list : list.filter((e) => kinds.has(e.kind));
}

/** Kind → how many events the customer has (the server's full count, not the capped page). */
export function kindCounts(tl: CustomerTimeline | undefined): Partial<Record<TimelineKind, number>> {
  if (tl?.kind_counts) return tl.kind_counts;
  const out: Partial<Record<TimelineKind, number>> = {};
  for (const e of tl?.events ?? []) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

/**
 * Source badge key under customer360.source.*. collabBox orders and MEX-only
 * parcels are named by their channel (Teleshop, Social, LEADS-OUT…), the
 * way the business talks about them.
 */
export function sourceKey(e: Pick<TimelineEvent, 'kind' | 'source' | 'source_detail'>): string | null {
  if (e.kind === 'web_order') return 'web';
  if (e.kind === 'altercpa_lead') return 'altercpa';
  const s = e.source;
  if (!s) return null;
  if (s === 'collabbox') {
    const d = e.source_detail;
    return d === 'teleshop' || d === 'social' || d === 'leads' || d === 'leads_out' ? d : 'collabbox';
  }
  const known = ['altercpa', 'elyon_crm', 'web', 'affiliate', 'legacy', 'teleshop', 'social', 'leads', 'leads_out', 'crm', 'other'];
  return known.includes(s) ? s : 'other';
}

export type Tone = 'green' | 'red' | 'blue' | 'amber' | 'gray' | 'teal' | 'pink';

export const TONE_CLASSES: Record<Tone, string> = {
  green: 'bg-emerald-600 text-white border-emerald-600',
  teal: 'bg-teal-500 text-white border-teal-500',
  red: 'bg-red-500 text-white border-red-500',
  pink: 'bg-pink-500 text-white border-pink-500',
  blue: 'bg-blue-500 text-white border-blue-500',
  amber: 'bg-amber-500 text-white border-amber-500',
  gray: 'bg-gray-500 text-white border-gray-500',
};

/** MEX status → tone. 2 Delivered, 7 Return to sender, 13 Rejected, 3 Problematic. */
export function parcelTone(p: Pick<TimelineParcel, 'status_id'>): Tone {
  switch (p.status_id) {
    case 2: return 'green';
    case 7: return 'pink';
    case 13: return 'red';
    case 3: case 9: return 'amber';
    default: return 'blue';
  }
}

/** web_order_outcome() bucket → tone (same meaning as the order status colours). */
export function webOutcomeTone(outcome: string | undefined): Tone {
  switch (outcome) {
    case 'delivered': return 'green';
    case 'returned': return 'pink';
    case 'cancelled': return 'red';
    case 'courier': return 'blue';
    case 'preparing': return 'teal';
    case 'awaiting': return 'amber';
    default: return 'gray'; // no_record, card_unpaid
  }
}

/** AlterCPA decision (altercpa_decision()) → tone. cancel_other is booked as confirmed (2026-08-11). */
export function decisionTone(decision: string | undefined): Tone {
  switch (decision) {
    case 'approved': case 'cancel_other': return 'teal';
    case 'cancelled': return 'red';
    case 'trashed': return 'gray';
    default: return 'amber'; // still open at AlterCPA
  }
}

/**
 * AlterCPA decision → customer360.decision.* leaf. `cancel_other` cannot be a
 * key as-is: i18next (and the plural test) read a trailing `_other` as the
 * plural form of `cancel`.
 */
export function decisionKey(decision: string | undefined): string {
  if (!decision) return 'open';
  return decision === 'cancel_other' ? 'cancelOther' : decision;
}

/** Seconds → "m:ss" (agent-reported handling time while VOIP is off). */
export function formatSeconds(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return '';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

/** A receiver name worth showing: it differs from the order's own name (case/space-insensitive). */
export function differentName(a: string | undefined, b: string | undefined): boolean {
  const n = (s: string | undefined) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
  return !!n(a) && !!n(b) && n(a) !== n(b);
}
