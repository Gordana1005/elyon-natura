/**
 * /orders — what one row shows (pure; rowModel.test.ts).
 *
 * Value: the parcel COD when MEX has one (already денари), else the CRM price
 * (stored EUR, shown ×61.5) — CLAUDE.md "Money is a COHORT". Per-order value
 * is shown to everyone who sees the order; no totals on this page.
 * Date: each row by its own status's clock, the same one the day filter uses
 * (a sale → sold_at → confirmed_at → created_at; a cancel → cancelled_at; a
 * trash → trashed_at; an open lead → created_at), in Skopje time.
 */
import { formatDenari, formatMoney } from '@/lib/currency';
import { mexGroupOf, type MexGroupKey } from './listParams';

export interface ListOrderLike {
  status: string;
  price?: number | string | null;
  /** The value is withheld from this viewer (access levels, 20260947001600). */
  value_hidden?: boolean;
  mex_cod_mkd?: number | null;
  mex_status_id?: number | null;
  mex_tracking_id?: string | null;
  created_at: string;
  sold_at?: string | null;
  confirmed_at?: string | null;
  cancelled_at?: string | null;
  trashed_at?: string | null;
}

/** Grouped thousands the Macedonian way (1.400); '' for none. */
export const fmtCount = (n: number | null | undefined) =>
  n == null ? '' : new Intl.NumberFormat('de-DE').format(n);

const SALE = new Set(['confirmed', 'shipped', 'delivered', 'paid', 'returned']);

/** The value in денари, as text, and whether it is the parcel's COD. A withheld value (a
 *  dept_admin's row of another department: value_hidden, no price) is "—", never 0 ден. */
export function orderValue(o: Pick<ListOrderLike, 'price' | 'mex_cod_mkd' | 'value_hidden'>): { text: string; fromParcel: boolean; hidden?: boolean } {
  if (o.value_hidden === true) return { text: '—', fromParcel: false, hidden: true };
  if (o.mex_cod_mkd != null) return { text: formatDenari(o.mex_cod_mkd), fromParcel: true };
  return { text: formatMoney(o.price ?? 0), fromParcel: false };
}

/** The instant the row is dated by (see the header). */
export function rowInstant(o: ListOrderLike): string {
  if (SALE.has(o.status)) return o.sold_at || o.confirmed_at || o.created_at;
  if (o.status === 'cancelled') return o.cancelled_at || o.created_at;
  if (o.status === 'trashed') return o.trashed_at || o.created_at;
  return o.created_at;
}

const SKOPJE = 'Europe/Skopje';
const dayFmt = new Intl.DateTimeFormat('en-GB', { timeZone: SKOPJE, day: '2-digit', month: '2-digit', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: SKOPJE, hour: '2-digit', minute: '2-digit', hour12: false });

/** An instant as a Skopje day (dd.mm.yyyy) and time (HH:mm); '—' when missing. */
export function skopjeDayTime(iso: string | null | undefined): { day: string; time: string } {
  if (!iso) return { day: '—', time: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: '—', time: '' };
  return { day: dayFmt.format(d).replace(/\//g, '.'), time: timeFmt.format(d) };
}

export type MexTone = 'good' | 'courier' | 'label' | 'problem' | 'returned' | 'rejected' | 'none';

/** The MEX badge: its group, tone and the exact status id (null = no parcel). */
export function mexBadge(o: Pick<ListOrderLike, 'mex_status_id' | 'mex_tracking_id'>): { group: MexGroupKey | null; tone: MexTone; statusId: number | null } {
  const group = mexGroupOf(o.mex_status_id, o.mex_tracking_id);
  const id = o.mex_tracking_id ? (o.mex_status_id ?? null) : null;
  const tone: MexTone =
    group === 'delivered' ? 'good'
      : group === 'returned' ? 'returned'
        : group === 'rejected' ? 'rejected'
          : group === 'at_mex' ? 'label'
            : group === 'courier' ? (id === 3 || id === 9 ? 'problem' : 'courier')
              : 'none';
  return { group, tone, statusId: id };
}

/** Literal classes (Tailwind must see them): the cohort palette's meanings —
 *  paid emerald, with the courier indigo, a label lighter indigo, a problem
 *  amber, returned PINK, rejected red. Always beside a word, never alone. */
export const MEX_TONE_CLASS: Record<MexTone, string> = {
  good: 'border-emerald-600/30 bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  courier: 'border-indigo-600/30 bg-indigo-50 text-indigo-800 dark:bg-indigo-500/15 dark:text-indigo-300',
  label: 'border-indigo-400/40 bg-indigo-50/60 text-indigo-700 dark:bg-indigo-400/10 dark:text-indigo-300',
  problem: 'border-amber-500/40 bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
  returned: 'border-pink-500/40 bg-pink-50 text-pink-800 dark:bg-pink-500/15 dark:text-pink-300',
  rejected: 'border-red-500/40 bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  none: 'border-dashed text-muted-foreground',
};
