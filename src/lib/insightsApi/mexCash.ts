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
    accounts: MexAccount[];
    /** The newest MEX sweep (max mex_parcels.last_seen_at). */
    data_through: string | null;
  };
  days: MexCashDay[];
  total: Record<MexAccount, MexCashFigures>;
  /** The last 6 settlement periods up to today's, newest first (independent of the window). */
  halves: MexCashHalf[];
  now: Record<MexAccount, MexCashNow>;
}

export const apiGetInsightsMexCash = (p: { from: string; to: string }, signal?: AbortSignal): Promise<MexCashResponse> =>
  apiFetch(`insights/mex-cash?${new URLSearchParams({ from: p.from, to: p.to }).toString()}`, { signal });
