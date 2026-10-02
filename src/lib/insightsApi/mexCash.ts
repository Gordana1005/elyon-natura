/**
 * GET /api/insights/mex-cash?from&to — Insights → Наплата (MEX) (owner 02.10.2026;
 * migration 20260947001300 insights_mex_cash; api module
 * supabase/functions/api/insightsMexCash.ts).
 *
 * What MEX collected on the DELIVERY day (mex_parcels.delivered_at, MEX 2) per
 * MEX account, the parcels it returned (MEX 7), its settlement periods (half-
 * months 1–15 / 16–end — the periods its fee invoices bill) and what it holds
 * right now. It is NOT money in our bank: MEX pays out later, in lumps, and no
 * payout date is in any data the CRM holds yet.
 *
 * Money keys (`*_mkd`, денари — MEX COD is already денари, render with
 * formatDenari, never convert) are owners only: an admin / manager gets the same
 * payload with every money key ABSENT (meta.money = false).
 *
 * Access levels (20260947001600): the whole tab = can_see_mex_cash (super_admin / owner /
 * finance). A dept_admin gets their own account only — meta.accounts = ['bio_natural'] (Тим
 * Маџари) or ['natura'] (Тим Центар), every block carrying only that account, meta.dept_scope set
 * and meta.account_note = 'natura_includes_web' when NATURA is shown (it also ships the web shop).
 */
import { apiFetch } from '@/lib/api';

export const MEX_ACCOUNTS = ['natura', 'bio_natural'] as const;
export type MexAccount = (typeof MEX_ACCOUNTS)[number];

export interface MexCashFigures {
  parcels: number;
  cod_mkd?: number;
  returned: number;
  returned_cod_mkd?: number;
}

export type MexCashDay = { d: string } & Record<MexAccount, MexCashFigures>;

export type MexCashHalf = { from: string; to: string; complete: boolean } & Record<MexAccount, { parcels: number; cod_mkd?: number }>;

export interface MexCashNow {
  courier: number;
  courier_cod_mkd?: number;
  label: number;
  label_cod_mkd?: number;
}

export interface MexCashResponse {
  meta: {
    from: string;
    to: string;
    partial: boolean;
    days: number;
    generated_at: string;
    money: boolean;
    today: string;
    /** The accounts this payload carries (absent on an older body = both). */
    accounts?: MexAccount[];
    /** A dept_admin's departments (access levels, 20260947001600). */
    dept_scope?: string[];
    /** 'natura_includes_web': NATURA also ships the web shop — its figures hold web parcels too. */
    account_note?: string | null;
    /** The newest MEX sweep (max mex_parcels.last_seen_at). */
    data_through: string | null;
  };
  days: MexCashDay[];
  total: Record<MexAccount, MexCashFigures>;
  /** The last 6 settlement periods up to today's, newest first (independent of the window). */
  halves: MexCashHalf[];
  now: Record<MexAccount, MexCashNow>;
}

/** The accounts to draw: meta.accounts in the fixed order (unknown keys dropped); none / an empty
 *  or unusable list = both. Pure. */
export function shownMexAccounts(meta: Pick<MexCashResponse['meta'], 'accounts'> | null | undefined): MexAccount[] {
  const list = Array.isArray(meta?.accounts) ? MEX_ACCOUNTS.filter((a) => meta!.accounts!.includes(a)) : [];
  return list.length ? list : [...MEX_ACCOUNTS];
}

/** Whether to say that NATURA also carries the web shop: NATURA is drawn and the api says so,
 *  or NATURA is the only account drawn. Pure. */
export function naturaIncludesWeb(meta: Pick<MexCashResponse['meta'], 'accounts' | 'account_note'> | null | undefined): boolean {
  const shown = shownMexAccounts(meta);
  if (!shown.includes('natura')) return false;
  return meta?.account_note === 'natura_includes_web' || (shown.length === 1);
}

export const apiGetInsightsMexCash = (p: { from: string; to: string }, signal?: AbortSignal): Promise<MexCashResponse> =>
  apiFetch(`insights/mex-cash?${new URLSearchParams({ from: p.from, to: p.to }).toString()}`, { signal });
