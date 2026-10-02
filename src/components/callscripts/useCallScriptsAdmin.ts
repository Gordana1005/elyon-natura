/**
 * /call-scripts — react-query hooks over src/lib/callScriptsApi.ts (contract docs/CALL-SCRIPTS.md).
 *
 * Permissions come from GET /call-scripts/mode (can_write / can_delete / can_switch) — the server
 * decides. Until that answers (or on an older api build) the page falls back to the same rule the
 * api applies: write = admin, or a manager who may edit the call_scripts module; delete and the
 * mode switch = admins only.
 */
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/contexts/PermissionsContext';
import {
  CALL_SCRIPTS_QUERY_KEYS as KEYS, CallScriptsError,
  apiBulkTargetedScripts, apiCreateTargetedScript, apiDeleteTargetedScript, apiDuplicateTargetedScript,
  apiGetCallScriptsForCall, apiGetDeletedScripts, apiGetScriptSamples, apiGetScriptVersions, apiGetScriptsCoverage,
  apiGetScriptsLibrary, apiGetScriptsMode, apiGetTargetedScript, apiRestoreTargetedScript, apiSaveTargetedScript,
  apiSetScriptsMode,
} from '@/lib/callScriptsApi';
import type {
  BulkOp, CallScriptsQuery, DuplicateBody, ScriptGroup, ScriptPatch, ScriptsLibrary, ScriptsMode, TargetedScript,
} from '@/lib/callScriptsTypes';

export interface ScriptsPerms {
  canWrite: boolean;
  canDelete: boolean;
  canSwitch: boolean;
  mode: ScriptsMode | null;
  enabledForMe: boolean;
  /** The mode route answered (the flags are the server's). */
  fromServer: boolean;
  loading: boolean;
}

export function useScriptsPerms(): ScriptsPerms {
  const { user } = useAuth();
  const perms = usePermissions() as Partial<ReturnType<typeof usePermissions>> | undefined;
  const q = useQuery({ queryKey: KEYS.mode(), queryFn: apiGetScriptsMode, retry: false, staleTime: 60_000, enabled: !!user });
  const isAdmin = !!user?.isAdmin;
  const managerEdit = !!user?.isManager && (typeof perms?.canAction === 'function' ? perms.canAction('call_scripts', 'edit') : false);
  const d = q.data;
  return {
    canWrite: d ? !!d.can_write : isAdmin || managerEdit,
    canDelete: d ? !!d.can_delete : isAdmin,
    canSwitch: d ? !!d.can_switch : isAdmin,
    mode: d?.mode ?? null,
    enabledForMe: !!d?.enabled_for_me,
    fromServer: !!d,
    loading: q.isLoading,
  };
}

export function useScriptsLibrary(enabled = true) {
  return useQuery({
    queryKey: KEYS.library({ status: 'all' }),
    queryFn: () => apiGetScriptsLibrary({ status: 'all' }),
    staleTime: 30_000,
    enabled,
  });
}

/** One script — shown at once from the library, then refreshed. */
export function useScriptItem(id: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: KEYS.item(id ?? ''),
    queryFn: () => apiGetTargetedScript(id!),
    enabled: !!id,
    retry: (n, e) => !(e instanceof CallScriptsError && (e.status === 404 || e.status === 403)) && n < 1,
    initialData: () => qc.getQueryData<ScriptsLibrary>(KEYS.library({ status: 'all' }))?.scripts.find((s) => s.id === id),
    initialDataUpdatedAt: 0,
  });
}

export function useScriptVersions(id: string | null, enabled = true) {
  return useQuery({ queryKey: KEYS.versions(id ?? ''), queryFn: () => apiGetScriptVersions(id!), enabled: !!id && enabled });
}

export function useDeletedScripts(enabled: boolean) {
  return useQuery({ queryKey: KEYS.deleted(), queryFn: apiGetDeletedScripts, enabled, retry: false });
}

export function useScriptsCoverage(opts: { families: boolean; assignedOnly: boolean }, enabled = true) {
  return useQuery({
    queryKey: KEYS.coverage(opts.families, opts.assignedOnly),
    queryFn: () => apiGetScriptsCoverage({ families: opts.families, assigned_only: opts.assignedOnly }),
    staleTime: 60_000,
    retry: false,
    enabled,
  });
}

export function useScriptSamples(group: ScriptGroup | null, product: string | null, enabled = true) {
  return useQuery({
    queryKey: KEYS.samples(group, product),
    queryFn: () => apiGetScriptSamples({ group, product }),
    staleTime: 60_000,
    retry: false,
    enabled,
  });
}

export function useForCallTest(q: CallScriptsQuery | null) {
  return useQuery({
    queryKey: q ? KEYS.forCall(q) : ['call-scripts', 'for-call', 'none'],
    queryFn: ({ signal }) => apiGetCallScriptsForCall(q!, signal),
    enabled: !!q,
    retry: false,
  });
}

/** Every write; each one refreshes everything call-scripts (library, coverage, versions, mode). */
export function useScriptsWrites() {
  const qc = useQueryClient();
  const done = (script?: TargetedScript) => {
    if (script) qc.setQueryData(KEYS.item(script.id), script);
    return qc.invalidateQueries({ queryKey: KEYS.all });
  };
  const create = useMutation({
    mutationFn: (b: { patch: ScriptPatch; note?: string }) => apiCreateTargetedScript(b),
    onSuccess: (r) => done(r.script),
  });
  const save = useMutation({
    mutationFn: (b: { id: string; expected_version: number; patch: ScriptPatch; note?: string }) =>
      apiSaveTargetedScript(b.id, { expected_version: b.expected_version, patch: b.patch, note: b.note }),
    onSuccess: (r) => done(r.script),
  });
  const duplicate = useMutation({
    mutationFn: (b: { id: string } & DuplicateBody) => {
      const { id, ...body } = b;
      return apiDuplicateTargetedScript(id, body);
    },
    onSuccess: () => done(),
  });
  const bulk = useMutation({
    mutationFn: (b: { ids: string[]; op: BulkOp; note?: string }) => apiBulkTargetedScripts(b),
    onSuccess: () => done(),
  });
  const restore = useMutation({
    mutationFn: (b: { id: string; version: number; note?: string }) => apiRestoreTargetedScript(b.id, { version: b.version, note: b.note }),
    onSuccess: (r) => done(r.script),
  });
  const remove = useMutation({
    mutationFn: (b: { id: string; note?: string }) => apiDeleteTargetedScript(b.id, b.note),
    onSuccess: (_r, b) => { qc.removeQueries({ queryKey: KEYS.item(b.id) }); return done(); },
  });
  const setMode = useMutation({
    mutationFn: (b: { mode: ScriptsMode; note?: string }) => apiSetScriptsMode(b.mode, b.note),
    onSuccess: (r) => { qc.setQueryData(KEYS.mode(), r); return qc.invalidateQueries({ queryKey: KEYS.mode() }); },
  });
  return useMemo(() => ({ create, save, duplicate, bulk, restore, remove, setMode }),
    [create, save, duplicate, bulk, restore, remove, setMode]);
}

/** The products of the library, by id (names for chips, twins for the matcher). */
export function useProductIndex(library: ScriptsLibrary | undefined) {
  return useMemo(() => {
    const products = library?.products ?? [];
    const byId = new Map(products.map((p) => [p.id, p]));
    return { products, byId, name: (id: string) => byId.get(id)?.name };
  }, [library]);
}
