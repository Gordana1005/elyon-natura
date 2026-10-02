/**
 * /orders — the collabBox bookings beside the orders, and the 2-day collabBox
 * entry rule badge on a CRM sale (owner, Mile, 02.10.2026). Pure; bookings.test.ts.
 *
 * A booking = a collabBox order document whose MEX parcel does not exist yet:
 * a sale now (the Overview cohort and the TV board count it), an order only once
 * MEX creates the parcel. GET /orders/bookings answers them for the list's
 * period / department / seller / search; the other filters describe something a
 * booking does not have (a parcel status, an intake source, an assignee, a CRM
 * price, CPA provenance, an Insights drill), so with one of them on the section
 * is not shown — it would list rows the filter cannot have meant.
 */
import type { OrderBookingsParams } from '@/lib/api';
import type { OrderCollab } from '@/components/orders/types';
import type { ApiListParams, ListView, OrdersListState } from './listParams';

/** How many bookings the section shows before "Прикажи ги сите". */
export const BOOKINGS_PREVIEW_ROWS = 20;

/** When the nightly rule cancels (apply_collab_entry_rule: hour 21, at :20 Skopje). */
export const COLLAB_RULE_TIME = '21:20';

/** Does the bookings section belong to the list as it is filtered? */
export function bookingsApply(
  s: OrdersListState,
  view: ListView,
  ctx: { drill: boolean; isAgent: boolean },
): boolean {
  if (view !== 'orders' && view !== 'all') return false;
  if (ctx.drill) return false;
  if (s.mex.length && !s.mex.includes('no_parcel')) return false; // a booking has no parcel
  if (s.sources.length) return false;                              // nor an intake source_type
  if (s.agent) return false;                                       // nor an assignee
  if (!ctx.isAgent && s.mine === true) return false;               // "my orders" = assigned to me
  if (s.priceMin != null || s.priceMax != null) return false;      // nor a CRM price
  if (s.wm || s.offer || s.stream) return false;                   // nor CPA provenance
  return true;
}

/** The list's GET /orders params → the ones a booking answers to. */
export function toBookingsParams(p: ApiListParams): OrderBookingsParams {
  return {
    ...(p.day_from ? { day_from: p.day_from } : {}),
    ...(p.day_to ? { day_to: p.day_to } : {}),
    ...(p.dept ? { dept: p.dept } : {}),
    ...(p.seller ? { seller: p.seller } : {}),
    ...(p.search ? { search: p.search } : {}),
  };
}

/** YYYY-MM-DD → dd.MM ('' for anything else). */
export function ddMm(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '');
  return m ? `${m[3]}.${m[2]}` : '';
}

/** Whole calendar days from a to b (YYYY-MM-DD), or null. */
function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const x = Date.parse(`${a}T00:00:00Z`), y = Date.parse(`${b}T00:00:00Z`);
  return Number.isFinite(x) && Number.isFinite(y) ? Math.round((y - x) / 86_400_000) : null;
}

export type CollabBadgeModel =
  | { kind: 'in'; doc: string }
  /** cancelDay: dd.MM when the rule is in apply mode (else null — report mode cancels nothing);
   *  days: the rule's deadline in days (cancel_day − sale_day). */
  | { kind: 'missing'; cancelDay: string | null; days: number | null };

/** The badge a list row shows, or null (the field is absent on every other row). */
export function collabBadge(o: { collab?: OrderCollab | null }): CollabBadgeModel | null {
  const c = o.collab;
  if (!c) return null;
  if (c.doc) return { kind: 'in', doc: c.doc };
  return {
    kind: 'missing',
    cancelDay: c.mode === 'apply' ? ddMm(c.cancel_day) || null : null,
    days: daysBetween(c.sale_day, c.cancel_day),
  };
}

/** A confirmed CRM sale with no collabBox document and no parcel, whose seller is NOT on a line team
 *  (Менаџмент / none): its department is provisional until its booking / parcel decides. A line team's
 *  sale is never provisional — the seller's team decides (owner 02.10.2026, 20260947000400). */
export function isProvisionalDept(o: { collab?: OrderCollab | null; mex_tracking_id?: string | null }): boolean {
  return !!o.collab && !o.collab.doc && !o.mex_tracking_id && !o.collab.team_decides;
}
