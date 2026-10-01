import { supabase } from '@/integrations/supabase/client';
import { apiFetch, type OpenLead } from '@/lib/api';
import type { CallOutcomeKey } from '@/lib/callsWork/outcomes';

// /calls — the outcome IS the call log (plan Фаза 11, 01.10.2026). Server:
// supabase/functions/api/callsOutcome.ts + the thin routes in index.ts.

export interface RecordOutcomeBody {
  phone: string;
  outcome: CallOutcomeKey;
  reason?: string;
  note?: string;
  /** The open order the agent chose (after a 409 choose_order), or the order the form confirmed. */
  order_id?: string;
  /** The prediction list the customer was served from (never the Pendings sentinel). */
  list_id?: string;
  /** call_again: when to ring back (ISO). */
  callback_at?: string;
  /** When this attempt started — the tel: tap / copy / the customer shown (ISO). */
  started_at?: string;
}

export interface RecordOutcomeResult {
  ok: true;
  outcome: CallOutcomeKey;
  order_id: string | null;
  order_action: 'updated' | 'created' | 'none';
  product_name: string | null;
  call_log_id: string | null;
  member_marked: number;
  callback_at: string | null;
  warnings: string[];
  next: 'fetch';
}

/** A refused outcome. `code` = choose_order (pick from `leads`), order_not_open, order_moved,
 *  reason_required, … · `status` 404 = an api build without the route. */
export class CallOutcomeError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null, readonly leads: OpenLead[] = []) {
    super(message);
    this.name = 'CallOutcomeError';
  }
}

const API_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api`;

/**
 * POST /api/calls/outcome. Not apiFetch: a 409 carries the open orders to choose from,
 * and the deferred "no answer" is flushed with `keepalive` when the tab goes away.
 */
export async function apiRecordCallOutcome(body: RecordOutcomeBody, opts?: { keepalive?: boolean }): Promise<RecordOutcomeResult> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${API_BASE}/calls/outcome`, {
    method: 'POST',
    keepalive: !!opts?.keepalive,
    signal: opts?.keepalive ? undefined : AbortSignal.timeout(30_000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token || ''}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let parsed: { error?: string; code?: string; leads?: OpenLead[] } & Partial<RecordOutcomeResult> | null = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON (546 / 504) */ }
  if (!res.ok) {
    const leads = parsed?.leads;
    throw new CallOutcomeError(parsed?.error || `HTTP ${res.status}`, res.status, parsed?.code ?? null, Array.isArray(leads) ? leads : []);
  }
  return parsed as RecordOutcomeResult;
}

// ── "Мои" — my callbacks ────────────────────────────────────────────────────

export type CallbackDueState = 'due' | 'soon' | 'later';
export interface MyCallback {
  kind: 'order' | 'prediction';
  key: string;
  order_id: string | null;
  display_id: string | null;
  list_id: string | null;
  list_name: string | null;
  product_name: string | null;
  customer_phone: string;
  customer_name: string | null;
  due_at: string | null;
  due_state: CallbackDueState;
  call_again_since: string | null;
  last_call_at: string | null;
  last_call_outcome: string | null;
}
export interface MyCallbacks {
  generated_at: string;
  total: number;
  due: number;
  soon: number;
  items: MyCallback[];
}
export const apiGetMyCallbacks = (): Promise<MyCallbacks> => apiFetch('calls/call-again');

// ── The progress row ────────────────────────────────────────────────────────

export interface CallsProgress {
  day: string;
  /** My outcomes today (every /calls outcome writes one call row). */
  calls_today: number;
  /** The TV board's numbers (leaderboard_day_v2); null when the board is unavailable. */
  sales_today: number | null;
  worked_today: number | null;
  generated_at: string;
}
export const apiGetCallsProgress = (): Promise<CallsProgress> => apiFetch('calls/progress');

export const CALLS_QUERY_KEYS = {
  callbacks: (userId?: string) => ['calls-callbacks', userId] as const,
  progress: (userId?: string) => ['calls-progress', userId] as const,
};
