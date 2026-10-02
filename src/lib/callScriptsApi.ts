/**
 * Targeted call scripts — the api client (contract docs/CALL-SCRIPTS.md, routes in
 * supabase/functions/api/index.ts "CALL SCRIPTS (targeted)").
 *
 * Not apiFetch: the editor needs the HTTP status and the error CODE (409 `stale` carries
 * `current_version`; 403 `forbidden` / `admin_only`; 404 from an older api build) — apiFetch keeps
 * only the message. Same pattern as CallOutcomeError in src/lib/callsWorkApi.ts.
 */
import { supabase } from '@/integrations/supabase/client';
import type {
  BulkOp, BulkResult, CallScriptsForCall, CallScriptsQuery, CoverageResponse, DeletedScript, DuplicateBody,
  DuplicateResult, LibraryQuery, PublishedIndexRow, ScriptGroup, ScriptPatch, ScriptSample, ScriptsLibrary,
  ScriptsMode, ScriptsModeInfo, ScriptVersion, TargetedScript,
} from './callScriptsTypes';

const API_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api`;
const TIMEOUT_MS = 60_000;

/** A refused / failed call-scripts request, with the server's status, code and body. */
export class CallScriptsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'CallScriptsError';
  }
  /** 409 stale: somebody saved a newer version; reload it before saving again. */
  get isStale() { return this.status === 409 && this.code === 'stale'; }
  get currentVersion(): number | null {
    const v = this.body?.current_version;
    return typeof v === 'number' ? v : null;
  }
}

export async function scriptsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(`${API_BASE}/${path}`, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token || ''}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      ...init?.headers,
    },
  });
  const text = await res.text().catch(() => '');
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON (546 / 504) */ }
  if (!res.ok) {
    const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    throw new CallScriptsError(
      typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`,
      res.status,
      typeof body?.code === 'string' ? body.code : null,
      body,
    );
  }
  return parsed as T;
}

const qs = (params: Record<string, string | number | boolean | null | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || v === false) continue;
    sp.set(k, v === true ? '1' : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const patch = (body: unknown): RequestInit => ({ method: 'PATCH', body: JSON.stringify(body) });
const enc = encodeURIComponent;

// ── Mode ────────────────────────────────────────────────────────────────────
export const apiGetScriptsMode = () => scriptsFetch<ScriptsModeInfo>('call-scripts/mode');
export const apiSetScriptsMode = (mode: ScriptsMode, note?: string) =>
  scriptsFetch<ScriptsModeInfo>('call-scripts/mode', patch({ mode, note }));

// ── Library ─────────────────────────────────────────────────────────────────
export const apiGetScriptsLibrary = (q: LibraryQuery = {}) =>
  scriptsFetch<ScriptsLibrary>(`call-scripts/library${qs({ status: q.status, group: q.group, product: q.product, q: q.q })}`);
export const apiGetPublishedScriptsIndex = () =>
  scriptsFetch<{ scripts: PublishedIndexRow[] }>('call-scripts/published-index');
export const apiGetTargetedScript = (id: string) =>
  scriptsFetch<TargetedScript>(`call-scripts/item/${enc(id)}`);

// ── Writes (admin, or a manager who can edit the call_scripts module) ───────
export const apiCreateTargetedScript = (body: { patch: ScriptPatch; note?: string }) =>
  scriptsFetch<{ script: TargetedScript }>('call-scripts/item', post(body));
export const apiSaveTargetedScript = (id: string, body: { expected_version: number; patch: ScriptPatch; note?: string }) =>
  scriptsFetch<{ script: TargetedScript }>(`call-scripts/item/${enc(id)}`, patch(body));
export const apiDuplicateTargetedScript = (id: string, body: DuplicateBody) =>
  scriptsFetch<DuplicateResult>(`call-scripts/item/${enc(id)}/duplicate`, post(body));
export const apiBulkTargetedScripts = (body: { ids: string[]; op: BulkOp; note?: string }) =>
  scriptsFetch<BulkResult>('call-scripts/bulk', post(body));

// ── History ─────────────────────────────────────────────────────────────────
export const apiGetScriptVersions = (id: string) =>
  scriptsFetch<{ versions: ScriptVersion[] }>(`call-scripts/item/${enc(id)}/versions`);
export const apiRestoreTargetedScript = (id: string, body: { version: number; note?: string }) =>
  scriptsFetch<{ script: TargetedScript }>(`call-scripts/item/${enc(id)}/restore`, post(body));
/** Admins only. */
export const apiDeleteTargetedScript = (id: string, note?: string) =>
  scriptsFetch<{ ok: true; version: number }>(`call-scripts/item/${enc(id)}${qs({ note })}`, { method: 'DELETE' });
/** Admins only. */
export const apiGetDeletedScripts = () =>
  scriptsFetch<{ deleted: DeletedScript[] }>('call-scripts/deleted');

// ── Coverage + tester ───────────────────────────────────────────────────────
export const apiGetScriptsCoverage = (q: { families?: boolean; assigned_only?: boolean } = {}) =>
  scriptsFetch<CoverageResponse>(`call-scripts/coverage${qs({ families: q.families === false ? '0' : '1', assigned_only: q.assigned_only ? '1' : '0' })}`);
export const apiGetScriptSamples = (q: { group?: ScriptGroup | null; product?: string | null }) =>
  scriptsFetch<{ samples: ScriptSample[] }>(`call-scripts/samples${qs({ group: q.group, product: q.product })}`);

// ── /calls ──────────────────────────────────────────────────────────────────
export const apiGetCallScriptsForCall = (q: CallScriptsQuery, signal?: AbortSignal) =>
  scriptsFetch<CallScriptsForCall>(
    `calls/scripts${qs({ phone: q.phone, source: q.source, order_id: q.order_id, list_id: q.list_id, include_drafts: q.include_drafts })}`,
    signal ? { signal } : undefined,
  );

export const CALL_SCRIPTS_QUERY_KEYS = {
  all: ['call-scripts'] as const,
  mode: () => ['call-scripts', 'mode'] as const,
  library: (q: LibraryQuery = {}) => ['call-scripts', 'library', q.status ?? null, q.group ?? null, q.product ?? null, q.q ?? null] as const,
  publishedIndex: () => ['call-scripts', 'published-index'] as const,
  item: (id: string) => ['call-scripts', 'item', id] as const,
  versions: (id: string) => ['call-scripts', 'versions', id] as const,
  deleted: () => ['call-scripts', 'deleted'] as const,
  coverage: (families = true, assignedOnly = false) => ['call-scripts', 'coverage', families, assignedOnly] as const,
  samples: (group: string | null, product: string | null) => ['call-scripts', 'samples', group, product] as const,
  forCall: (q: CallScriptsQuery) =>
    ['call-scripts', 'for-call', q.phone, q.source, q.order_id ?? null, q.list_id ?? null, !!q.include_drafts] as const,
};
