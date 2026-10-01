import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PhoneIncoming, PhoneOutgoing, Check, X, Loader2, UserCheck, Wand2, ChevronRight, User, Voicemail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatSkopje } from '@/lib/skopjeTime';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { useVoip } from '@/contexts/VoipContext';
import { useToast } from '@/hooks/use-toast';
import {
  apiGetMissedCalls, apiAssignMissedCall, apiBulkAssignMissedCalls,
  apiSetMissedCallStatus, apiGetAgents, apiGetMissedCallVoicemailUrl, type MissedCall,
} from '@/lib/api';
import { CustomerHistoryTabs } from '@/components/calls/CustomerHistoryTabs';
import { MobileCard, MobileCardHeader, MobileCardField, MobileCardActions } from '@/components/ui/mobile-card';
import { EmptyState } from '@/components/EmptyState';

const fmtVmLen = (s: number | null) => {
  const t = Math.max(0, Math.round(s || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

// Lazily fetches a short-lived signed URL for the caller's recorded message and
// plays it inline. Only mounted inside an expanded row, so it fetches on demand.
function VoicemailPlayer({ id, seconds }: { id: string; seconds: number | null }) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['missed-vm-url', id],
    queryFn: () => apiGetMissedCallVoicemailUrl(id),
    staleTime: 4 * 60 * 1000, // signed URL lives ~5 min
  });
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
        <Voicemail className="h-3.5 w-3.5" /> {t('missedCalls.voicemail')}{seconds ? ` · ${fmtVmLen(seconds)}` : ''}
      </div>
      {isLoading ? (
        <div className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('missedCalls.loadingRecording')}</div>
      ) : isError || !data?.url ? (
        <div className="text-sm text-muted-foreground">{t('missedCalls.recordingFailed')}</div>
      ) : (
        <audio controls preload="none" src={data.url} className="w-full h-9" />
      )}
    </div>
  );
}

// Labels live under missedCalls.status.* in the locale files.
const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  new: 'default',
  assigned: 'secondary',
  called_back: 'outline',
  ignored: 'destructive',
};

// "called · 04/06" or "order ORD-123 · 02/06" — how/when this caller was last contacted.
function lastContactSub(r: MissedCall, t: (k: string) => string): string {
  const how = r.last_agent_source === 'call' ? t('missedCalls.contactCalled')
    : `${t('missedCalls.contactOrder')}${r.last_agent_detail ? ` ${r.last_agent_detail}` : ''}`;
  const when = r.last_agent_at ? ` · ${formatSkopje(r.last_agent_at, 'dd/MM')}` : '';
  return how + when;
}

/**
 * The Missed Calls inbox. Shared by the standalone /missed-calls route. The API
 * scopes rows per role: admins/managers see all; an agent sees the ones assigned
 * to them plus unassigned calls from customers they own (they were the last agent
 * to call / handle that caller). Rows expand to the customer's full order + call history.
 * Assign controls (checkbox / per-row selector / bulk bar) are supervisor-only.
 */
export function MissedCallsPanel() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isAdminOrManager = user?.isAdmin || user?.isManager;
  const { startCall } = useVoip();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // Deep-link target: a missed-call notification can drop us here with ?phone=…
  // so we land on that exact caller's row instead of hunting through the list.
  const focusPhone = searchParams.get('phone');
  const focusKey = focusPhone ? focusPhone.replace(/\D/g, '').slice(-8) : null;
  const [statusFilter, setStatusFilter] = useState<string>('open');
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bulkAgent, setBulkAgent] = useState<string>('');
  const [bulkBusy, setBulkBusy] = useState(false);

  const apiStatus = statusFilter === 'open' || statusFilter === 'all' ? undefined : statusFilter;
  const { data, isLoading } = useQuery({
    queryKey: ['missed-calls', statusFilter],
    queryFn: () => apiGetMissedCalls(apiStatus),
    refetchInterval: 30000,
  });
  const { data: agentsData } = useQuery({ queryKey: ['agents'], queryFn: apiGetAgents, enabled: !!isAdminOrManager });

  let rows: MissedCall[] = data?.missed_calls || [];
  if (statusFilter === 'open') rows = rows.filter((r) => r.status === 'new' || r.status === 'assigned');

  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const selectedVisible = useMemo(() => visibleIds.filter((id) => selected.has(id)), [visibleIds, selected]);
  const allSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;

  const toggleSel = (id: string) =>
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () =>
    setSelected((prev) => (visibleIds.every((id) => prev.has(id)) ? new Set() : new Set(visibleIds)));
  const clearSelection = () => setSelected(new Set());
  const toggleExpand = (id: string) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // Expand the first row once on first load so it's obvious rows expand. The
  // agent can still collapse it (and we never re-open it after that).
  const didAutoExpand = useRef(false);
  useEffect(() => {
    if (didAutoExpand.current || rows.length === 0) return;
    didAutoExpand.current = true;
    if (focusPhone) return; // a deep-link focus handles its own expansion below
    setExpanded(new Set([rows[0].id]));
  }, [rows, focusPhone]);

  // ── Deep-link focus (?phone=…) ───────────────────────────────────────────
  // Surface the targeted caller regardless of status, then expand + scroll to
  // their row once the data loads so the operator lands right on it.
  useEffect(() => {
    if (focusPhone) setStatusFilter('all');
  }, [focusPhone]);

  const focusedId = useMemo(
    () => (focusKey ? rows.find((r) => r.caller_number.replace(/\D/g, '').slice(-8) === focusKey)?.id ?? null : null),
    [rows, focusKey],
  );

  useEffect(() => {
    if (focusedId) setExpanded((prev) => (prev.has(focusedId) ? prev : new Set(prev).add(focusedId)));
  }, [focusedId]);

  useEffect(() => {
    if (!focusedId) return;
    const el = [document.getElementById(`mc-row-${focusedId}`), document.getElementById(`mc-card-${focusedId}`)]
      .find((e) => e && e.getClientRects().length > 0);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focusedId]);

  const clearFocus = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('phone');
    setSearchParams(next, { replace: true });
  };

  const act = async (fn: () => Promise<any>, id: string) => {
    setBusy(id);
    try { await fn(); qc.invalidateQueries({ queryKey: ['missed-calls'] }); }
    catch (e: any) { toast({ title: t('missedCalls.failed'), description: e?.message || 'error', variant: 'destructive' }); }
    finally { setBusy(null); }
  };

  const callBack = async (number: string, id: string) => {
    startCall(number, null);
    await act(() => apiSetMissedCallStatus(id, 'called_back'), id);
    toast({ title: t('missedCalls.callingBack'), description: number });
  };

  const bulkAssignToAgent = async () => {
    if (!bulkAgent || selectedVisible.length === 0) return;
    setBulkBusy(true);
    try {
      await apiBulkAssignMissedCalls(selectedVisible, bulkAgent);
      qc.invalidateQueries({ queryKey: ['missed-calls'] });
      const name = (agentsData || []).find((a: any) => a.user_id === bulkAgent)?.full_name || 'agent';
      toast({ title: t('missedCalls.assignedToast'), description: t('missedCalls.bulkAssigned', { count: selectedVisible.length, name }) });
      clearSelection();
    } catch (e: any) {
      toast({ title: t('missedCalls.failed'), description: e?.message || 'error', variant: 'destructive' });
    } finally { setBulkBusy(false); }
  };

  const autoAssignToLast = async () => {
    const byAgent = new Map<string, string[]>();
    let skipped = 0;
    for (const r of rows) {
      if (!selected.has(r.id)) continue;
      if (!r.last_agent_id) { skipped++; continue; }
      const arr = byAgent.get(r.last_agent_id) || [];
      arr.push(r.id); byAgent.set(r.last_agent_id, arr);
    }
    if (byAgent.size === 0) {
      toast({ title: t('missedCalls.nothingToAutoAssign'), description: t('missedCalls.noKnownLastAgent'), variant: 'destructive' });
      return;
    }
    setBulkBusy(true);
    try {
      let assigned = 0;
      for (const [agentId, ids] of byAgent) { await apiBulkAssignMissedCalls(ids, agentId); assigned += ids.length; }
      qc.invalidateQueries({ queryKey: ['missed-calls'] });
      toast({ title: t('missedCalls.autoAssigned'), description: t('missedCalls.routedToLast', { count: assigned }) + (skipped ? t('missedCalls.skippedSuffix', { count: skipped }) : '') });
      clearSelection();
    } catch (e: any) {
      toast({ title: t('missedCalls.failed'), description: e?.message || 'error', variant: 'destructive' });
    } finally { setBulkBusy(false); }
  };

  // checkbox + caller + when + last-contacted + status (+ assigned) + actions
  const colCount = isAdminOrManager ? 7 : 5;

  return (
    <div className="space-y-4">
      {focusPhone && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <span className="flex items-center gap-2 min-w-0">
            <PhoneIncoming className="h-4 w-4 text-primary shrink-0" />
            <span className="truncate">
              {t('missedCalls.showingFrom')} <span className="font-mono font-medium">{focusPhone}</span>
              {!isLoading && focusedId === null && <span className="text-muted-foreground"> · {t('missedCalls.notInList')}</span>}
            </span>
          </span>
          <Button size="sm" variant="ghost" className="h-7 shrink-0" onClick={clearFocus}>{t('missedCalls.clear')}</Button>
        </div>
      )}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-muted-foreground">
          {isAdminOrManager ? t('missedCalls.introAdmin') : t('missedCalls.introAgent')}
        </p>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); clearSelection(); }}>
          <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="open">{t('missedCalls.filterOpen')}</SelectItem>
            <SelectItem value="new">{t('missedCalls.status.new')}</SelectItem>
            <SelectItem value="assigned">{t('missedCalls.status.assigned')}</SelectItem>
            <SelectItem value="called_back">{t('missedCalls.status.called_back')}</SelectItem>
            <SelectItem value="ignored">{t('missedCalls.status.ignored')}</SelectItem>
            <SelectItem value="all">{t('common.all')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isAdminOrManager && selectedVisible.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap rounded-lg border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium">{t('missedCalls.nSelected', { count: selectedVisible.length })}</span>
          <div className="flex items-center gap-2">
            <Select value={bulkAgent} onValueChange={setBulkAgent}>
              <SelectTrigger className="w-[180px] h-8"><SelectValue placeholder={t('missedCalls.assignAllTo')} /></SelectTrigger>
              <SelectContent>
                {(agentsData || []).map((a: any) => <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" className="h-8" disabled={!bulkAgent || bulkBusy} onClick={bulkAssignToAgent}>
              {bulkBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserCheck className="h-3.5 w-3.5" />} {t('missedCalls.assignBtn')}
            </Button>
          </div>
          <Button size="sm" variant="outline" className="h-8 gap-1.5" disabled={bulkBusy} onClick={autoAssignToLast}
            title={t('missedCalls.autoAssignTitle')}>
            <Wand2 className="h-3.5 w-3.5" /> {t('missedCalls.autoAssignBtn')}
          </Button>
          <Button size="sm" variant="ghost" className="h-8" disabled={bulkBusy} onClick={clearSelection}>{t('missedCalls.clear')}</Button>
        </div>
      )}

      {/* Desktop: table */}
      <div className="hidden md:block rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              {isAdminOrManager && (
                <TableHead className="w-10">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label={t('missedCalls.selectAll')} />
                </TableHead>
              )}
              <TableHead>{t('missedCalls.colCaller')}</TableHead>
              <TableHead className="whitespace-nowrap">{t('missedCalls.colWhen')}</TableHead>
              <TableHead>{t('missedCalls.colLastContactedBy')}</TableHead>
              <TableHead>{t('missedCalls.colStatus')}</TableHead>
              {isAdminOrManager && <TableHead>{t('missedCalls.colAssignedTo')}</TableHead>}
              <TableHead className="text-right pr-4">{t('common.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={colCount} className="text-center py-8 text-muted-foreground">{t('common.loading')}</TableCell></TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={colCount} className="p-0">
                  <EmptyState icon={<PhoneIncoming className="h-5 w-5" />} title={t('missedCalls.noMissedCalls')} description={t('missedCalls.noMissedCallsDesc')} size="sm" className="border-0 bg-transparent hover:shadow-none" />
                </TableCell>
              </TableRow>
            ) : rows.map((r) => {
              const isExpanded = expanded.has(r.id);
              return (
                <Fragment key={r.id}>
                  <TableRow
                    id={`mc-row-${r.id}`}
                    data-state={selected.has(r.id) ? 'selected' : undefined}
                    onClick={() => toggleExpand(r.id)}
                    className={cn('cursor-pointer group/row', isExpanded && 'bg-muted/30', focusedId === r.id && 'bg-primary/10 hover:bg-primary/10')}
                  >
                    {isAdminOrManager && (
                      <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggleSel(r.id)} aria-label={t('missedCalls.selectRow')} />
                      </TableCell>
                    )}
                    {/* Caller: chevron + name + phone (+ which DID was dialed). Row toggles. */}
                    <TableCell>
                      <div className="flex items-start gap-1.5 text-left">
                        <ChevronRight className={cn('h-4 w-4 mt-0.5 shrink-0 text-muted-foreground transition-transform group-hover/row:text-foreground', isExpanded && 'rotate-90')} />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium truncate group-hover/row:text-primary">
                            {r.customer_name || t('missedCalls.unknownCaller')}
                          </span>
                          <span className="block font-mono text-xs text-muted-foreground">
                            {r.caller_number}{r.did ? <span className="opacity-70"> → {r.did}</span> : null}
                          </span>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap text-muted-foreground">{formatSkopje(r.occurred_at, 'dd/MM HH:mm')}</TableCell>
                    {/* Last contacted by — admins can click to route the call to them */}
                    <TableCell className="text-sm">
                      {r.last_agent_name ? (
                        isAdminOrManager ? (
                          <button
                            type="button"
                            disabled={busy === r.id || !r.last_agent_id || r.assigned_agent_id === r.last_agent_id}
                            onClick={(e) => { e.stopPropagation(); r.last_agent_id && act(() => apiAssignMissedCall(r.id, r.last_agent_id!), r.id); }}
                            className="text-left group disabled:cursor-default"
                            title={r.last_agent_id ? t('missedCalls.assignToTitle', { name: r.last_agent_name }) : undefined}
                          >
                            <span className="font-medium text-foreground group-enabled:group-hover:text-primary group-enabled:group-hover:underline underline-offset-2">{r.last_agent_name}</span>
                            <span className="block text-[11px] text-muted-foreground">{lastContactSub(r, t)}</span>
                          </button>
                        ) : (
                          <span>
                            <span className="font-medium text-foreground">{r.last_agent_name}</span>
                            <span className="block text-[11px] text-muted-foreground">{lastContactSub(r, t)}</span>
                          </span>
                        )
                      ) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant={STATUS_VARIANTS[r.status] || 'outline'}>{t(`missedCalls.status.${r.status}`, { defaultValue: r.status })}</Badge>
                        {r.voicemail_file && (
                          <Badge variant="outline" className="gap-1 border-primary/40 text-primary" title={t('missedCalls.voicemailLeft')}>
                            <Voicemail className="h-3 w-3" /> {fmtVmLen(r.voicemail_seconds)}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    {isAdminOrManager && (
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <Select value={r.assigned_agent_id || ''} onValueChange={(v) => act(() => apiAssignMissedCall(r.id, v), r.id)} disabled={busy === r.id}>
                          <SelectTrigger className="w-[160px] h-8"><SelectValue placeholder={t('missedCalls.assignAgentPlaceholder')} /></SelectTrigger>
                          <SelectContent>
                            {(agentsData || []).map((a: any) => <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    )}
                    <TableCell className="text-right pr-4" onClick={(e) => e.stopPropagation()}>
                      <div className="inline-flex gap-1.5">
                        <Button size="sm" className="h-7 gap-1.5" onClick={() => callBack(r.caller_number, r.id)} disabled={busy === r.id}>
                          <PhoneOutgoing className="h-3 w-3" /> {t('missedCalls.callBack')}
                        </Button>
                        {r.status !== 'called_back' && (
                          <Button size="sm" variant="outline" className="h-7" title={t('missedCalls.markCalledBack')} onClick={() => act(() => apiSetMissedCallStatus(r.id, 'called_back'), r.id)} disabled={busy === r.id}>
                            <Check className="h-3 w-3" />
                          </Button>
                        )}
                        {r.status !== 'ignored' && (
                          <Button size="sm" variant="ghost" className="h-7" title={t('missedCalls.ignore')} onClick={() => act(() => apiSetMissedCallStatus(r.id, 'ignored'), r.id)} disabled={busy === r.id}>
                            <X className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>

                  {isExpanded && (
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell colSpan={colCount} className="p-0">
                        <div className="border-l-2 border-primary/60 px-4 py-4 space-y-3">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 shrink-0">
                              <User className="h-3.5 w-3.5 text-primary" />
                            </span>
                            <span className="font-semibold">{r.customer_name || t('missedCalls.unknownCaller')}</span>
                            <span className="font-mono text-xs text-muted-foreground">{r.caller_number}</span>
                          </div>
                          {r.voicemail_file && <VoicemailPlayer id={r.id} seconds={r.voicemail_seconds} />}
                          <CustomerHistoryTabs phone={r.caller_number} />
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Mobile: cards */}
      <div className="md:hidden space-y-2">
        {isLoading ? (
          <div className="text-center py-8 text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<PhoneIncoming className="h-5 w-5" />} title={t('missedCalls.noMissedCalls')} description={t('missedCalls.noMissedCallsDesc')} size="sm" />
        ) : rows.map((r) => {
          const isExpanded = expanded.has(r.id);
          return (
            <MobileCard key={r.id} id={`mc-card-${r.id}`} className={cn(selected.has(r.id) && 'ring-1 ring-primary', focusedId === r.id && 'ring-2 ring-primary bg-primary/5')}>
              <div className="flex items-start gap-2">
                {isAdminOrManager && (
                  <Checkbox className="mt-1 shrink-0" checked={selected.has(r.id)} onCheckedChange={() => toggleSel(r.id)} aria-label={t('missedCalls.selectRow')} />
                )}
                <div className="min-w-0 flex-1">
                  <MobileCardHeader
                    title={r.customer_name || t('missedCalls.unknownCaller')}
                    subtitle={<>{r.caller_number}{r.did ? <span className="opacity-70"> → {r.did}</span> : null}</>}
                    badge={
                      <div className="flex flex-col items-end gap-1">
                        <Badge variant={STATUS_VARIANTS[r.status] || 'outline'}>{t(`missedCalls.status.${r.status}`, { defaultValue: r.status })}</Badge>
                        {r.voicemail_file && (
                          <Badge variant="outline" className="gap-1 border-primary/40 text-primary">
                            <Voicemail className="h-3 w-3" /> {fmtVmLen(r.voicemail_seconds)}
                          </Badge>
                        )}
                      </div>
                    }
                  />
                </div>
              </div>
              <MobileCardField label={t('missedCalls.colWhen')} value={formatSkopje(r.occurred_at, 'dd/MM HH:mm')} />
              <MobileCardField
                label={t('missedCalls.colLastContactedBy')}
                value={r.last_agent_name
                  ? <span>{r.last_agent_name}<span className="block text-[11px] text-muted-foreground">{lastContactSub(r, t)}</span></span>
                  : '—'}
              />
              {isAdminOrManager && (
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-muted-foreground shrink-0">{t('missedCalls.assignedLabel')}</span>
                  <Select value={r.assigned_agent_id || ''} onValueChange={(v) => act(() => apiAssignMissedCall(r.id, v), r.id)} disabled={busy === r.id}>
                    <SelectTrigger className="h-8 w-[150px]"><SelectValue placeholder={t('missedCalls.assignAgentPlaceholder')} /></SelectTrigger>
                    <SelectContent>
                      {(agentsData || []).map((a: any) => <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <MobileCardActions>
                <Button size="sm" className="gap-1.5" onClick={() => callBack(r.caller_number, r.id)} disabled={busy === r.id}>
                  <PhoneOutgoing className="h-3.5 w-3.5" /> {t('missedCalls.callBack')}
                </Button>
                {r.status !== 'called_back' && (
                  <Button size="sm" variant="outline" title={t('missedCalls.markCalledBack')} onClick={() => act(() => apiSetMissedCallStatus(r.id, 'called_back'), r.id)} disabled={busy === r.id}>
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                )}
                {r.status !== 'ignored' && (
                  <Button size="sm" variant="ghost" title={t('missedCalls.ignore')} onClick={() => act(() => apiSetMissedCallStatus(r.id, 'ignored'), r.id)} disabled={busy === r.id}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </MobileCardActions>
              <Button variant="ghost" size="sm" className="w-full justify-center text-xs text-muted-foreground" onClick={() => toggleExpand(r.id)}>
                <ChevronRight className={cn('h-3.5 w-3.5 mr-1 transition-transform', isExpanded && 'rotate-90')} />
                {isExpanded ? t('missedCalls.hideHistory') : t('missedCalls.historyVoicemail')}
              </Button>
              {isExpanded && (
                <div className="border-t pt-3 space-y-3">
                  {r.voicemail_file && <VoicemailPlayer id={r.id} seconds={r.voicemail_seconds} />}
                  <CustomerHistoryTabs phone={r.caller_number} />
                </div>
              )}
            </MobileCard>
          );
        })}
      </div>
    </div>
  );
}
