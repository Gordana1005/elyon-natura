/**
 * The /calls side of the targeted call scripts (contract docs/CALL-SCRIPTS.md, workstream C).
 *
 *   useCallScriptsMode()        GET /call-scripts/mode — is the dock on for ME (on; preview for an
 *                               admin / manager)? Anything else, an error or an older api build
 *                               included, keeps today's CallScriptsPanel.
 *   useCallScriptsForCall()     GET /calls/scripts — the best script for the client on screen + up
 *                               to 4 alternatives, the context (group, product, last purchase) and
 *                               the privacy-filtered variables. One cache entry per phone × source ×
 *                               order × list, so the desktop dock and the phone sheet share it.
 */
import { useQuery } from '@tanstack/react-query';
import {
  apiGetCallScriptsForCall, apiGetScriptsMode, apiGetTargetedScript, CALL_SCRIPTS_QUERY_KEYS,
} from '@/lib/callScriptsApi';

/** What /calls is working on — the server turns it into a group and products. */
export interface CallScriptCtx {
  source: 'lead' | 'prediction' | 'manual';
  /** The open lead on screen (lead), or a hint (manual: a callback's order). */
  orderId?: string | null;
  /** The prediction list on screen (prediction), or a hint (manual: a callback's list). Never '__pendings__'. */
  listId?: string | null;
}

export const SCRIPTS_STALE_MS = 5 * 60_000;

/** The last 8 digits — the key the whole CRM matches a phone by. */
export const phone8 = (phone: string | null | undefined) => String(phone ?? '').replace(/\D/g, '').slice(-8);

export const callScriptsForCallKey = (phone: string, ctx: CallScriptCtx) =>
  ['calls-scripts', phone8(phone), ctx.source, ctx.orderId ?? null, ctx.listId ?? null] as const;

export function useCallScriptsMode() {
  return useQuery({
    queryKey: CALL_SCRIPTS_QUERY_KEYS.mode(),
    queryFn: apiGetScriptsMode,
    staleTime: SCRIPTS_STALE_MS,
    retry: false,
  });
}

/** True only when the server says the dock is on for this user (never while loading / on an error). */
export function useScriptDockEnabled(): boolean {
  return useCallScriptsMode().data?.enabled_for_me === true;
}

export function useCallScriptsForCall(phone: string, ctx: CallScriptCtx, enabled = true) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return useQuery({
    queryKey: callScriptsForCallKey(phone, ctx),
    queryFn: ({ signal }) => apiGetCallScriptsForCall({
      phone,
      source: ctx.source,
      order_id: ctx.orderId ?? null,
      list_id: ctx.listId ?? null,
    }, signal),
    enabled: enabled && digits.length >= 6,
    staleTime: SCRIPTS_STALE_MS,
    retry: 1,
  });
}

/** A script the agent picked by hand from the search (published only for agents — the api checks). */
export function usePickedScript(id: string | null) {
  return useQuery({
    queryKey: CALL_SCRIPTS_QUERY_KEYS.item(id ?? ''),
    queryFn: () => apiGetTargetedScript(id!),
    enabled: !!id,
    staleTime: SCRIPTS_STALE_MS,
    retry: false,
  });
}
