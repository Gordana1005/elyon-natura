import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Loader2, Package, UserPlus, UserX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SmartPagination } from '@/components/SmartPagination';
import { EmptyState } from '@/components/EmptyState';
import { MobileCard, MobileCardField } from '@/components/ui/mobile-card';
import { LoadError } from '@/components/insights/shared/LoadError';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { listLabel } from '@/components/insights/lists/listModel';
import { apiAssignCallAgains, type CallAgainMember } from '@/lib/api';
import type { AssignerBoard, AssignerBoardAgent } from '@/lib/assignerApi';
import { daysSince } from '@/lib/assigner/board';
import { dealRoundRobin } from '@/lib/assigner/plan';
import { apiErrorText } from '@/i18n/apiErrors';
import { toast } from '@/hooks/use-toast';
// MKD only — prices are stored in EUR and the denar is derived at display time
// from the frozen peg. No dual display in this market (see elyon-currency).
import { formatMoney } from '@/lib/currency';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import { DistributeBar } from './DistributeBar';
import { CardHead, DeptDash, ResponsivePager, deptName } from './parts';
import { CALL_AGAINS_PAGE_SIZE, callAgainsQuery, invalidateAssigner, type CallAgainsFilters } from './assignerQueries';

function SourceBadge({ kind }: { kind?: 'order' | 'prediction' }) {
  const { t } = useTranslation();
  const isLead = kind === 'order';
  return (
    <span className={cn(
      'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap',
      isLead
        ? 'border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300'
        : 'border-sky-200 bg-sky-100 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-300',
    )}>
      {isLead ? t('callAgainPage.sourcePendings') : t('callAgainPage.sourcePrediction')}
    </span>
  );
}

/** A lead row carries its PRODUCT where a member carries its list (the api's shape). */
function ListCell({ m }: { m: CallAgainMember }) {
  const { t } = useTranslation();
  const name = m.prediction_segment_lists?.name;
  if (!name) return <span className="text-muted-foreground/60">—</span>;
  if (m.source_kind === 'order') {
    return <span className="inline-flex items-center gap-1" title={t('assigner.callAgains.productTip')}><Package className="h-3 w-3 shrink-0" aria-hidden />{name}</span>;
  }
  return <span title={name}>{listLabel(t, name)}</span>;
}

const key = (m: { list_id: string; customer_phone: string }) => `${m.list_id}|${m.customer_phone}`;

/**
 * The Call-agains tab: pending `call_again` leads AND prediction no-answers,
 * one pool (callbacks are pool-owned — any agent opening one on /calls claims
 * it). Waiting since, the REAL last call, department and list; the
 * DistributeBar hands out N at a time, newest or oldest first, and warns when a
 * chosen agent is offline (the lead engine releases their call-again leads
 * after ~15 minutes).
 */
export function CallAgainsPanel({
  filters, onFiltersChange, departments, board, targets, onTargetsChange, f,
}: {
  filters: CallAgainsFilters;
  onFiltersChange: (next: CallAgainsFilters) => void;
  departments: string[];
  board: AssignerBoard | undefined;
  targets: string[];
  onTargetsChange: (ids: string[]) => void;
  f: InsightsFormat;
}) {
  const { t } = f;
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Map<string, CallAgainMember>>(new Map());
  const [busy, setBusy] = useState(false);
  const agents: AssignerBoardAgent[] = useMemo(() => board?.agents ?? [], [board]);
  const byId = useMemo(() => new Map(agents.map((a) => [a.user_id, a])), [agents]);

  const q = useQuery(callAgainsQuery(filters, departments, page));
  const members = q.data?.members ?? [];
  const total = q.data?.total ?? 0;
  const setFilters = (patch: Partial<CallAgainsFilters>) => { onFiltersChange({ ...filters, ...patch }); setPage(1); setSelected(new Map()); };

  // The local pool estimate for the preview (the dry run is the truth).
  const tot = board?.totals;
  const bySource = (s: CallAgainsFilters['source']) =>
    !tot ? null : s === 'order' ? tot.call_agains_unassigned_orders : s === 'prediction' ? tot.call_agains_unassigned_members : tot.call_agains_unassigned;
  const heldBySource = (s: CallAgainsFilters['source']) =>
    agents.reduce((sum, a) => sum + (s === 'order' ? a.call_agains_orders : s === 'prediction' ? a.call_agains_members : a.call_agains), 0);
  const pool = filters.agent === 'unassigned' && q.data ? total : departments.length ? null : bySource(filters.source);
  const poolWithAssigned = filters.agent === 'all' && q.data ? total
    : departments.length || !tot ? null : (bySource(filters.source) ?? 0) + heldBySource(filters.source);

  const allOnPage = members.length > 0 && members.every((m) => selected.has(key(m)));
  const toggleAll = () => setSelected((prev) => {
    const next = new Map(prev);
    if (allOnPage) members.forEach((m) => next.delete(key(m)));
    else members.forEach((m) => next.set(key(m), m));
    return next;
  });
  const toggleOne = (m: CallAgainMember) => setSelected((prev) => {
    const next = new Map(prev);
    if (next.has(key(m))) next.delete(key(m)); else next.set(key(m), m);
    return next;
  });

  const assignSelected = async (free: boolean) => {
    const picked = [...selected.values()].map((m) => ({ list_id: m.list_id, customer_phone: m.customer_phone }));
    if (!picked.length || (!free && !targets.length)) return;
    setBusy(true);
    try {
      if (free) {
        const res = await apiAssignCallAgains(picked, null);
        toast({ title: t('assigner.callAgainsFreed', { count: res.assigned }) });
      } else {
        const parts: string[] = [];
        let n = 0;
        for (const [agentId, rows] of dealRoundRobin(picked, targets)) {
          if (!rows.length) continue;
          const res = await apiAssignCallAgains(rows, agentId);
          n += res.assigned;
          parts.push(`${byId.get(agentId)?.full_name ?? t('assigner.unknownAgent')} ${f.int(res.assigned)}`);
        }
        toast({ title: t('assigner.callAgainsAssigned', { count: n }), description: parts.join(' · ') || undefined });
      }
      setSelected(new Map());
      invalidateAssigner(qc);
    } catch (err) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const waitText = (days: number) =>
    (days === 0 ? t('assigner.callAgains.waitingToday') : t('assigner.callAgains.waitingDays', { n: f.int(days) }));

  const agentOptions = useMemo(() => [...agents].sort((a, b) => a.full_name.localeCompare(b.full_name, 'mk')), [agents]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filters.source} onValueChange={(v) => setFilters({ source: v as CallAgainsFilters['source'] })}>
          <SelectTrigger className="h-9 w-[200px] text-sm" aria-label={t('callAgainPage.colSource')}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('callAgainPage.sourceAll')}</SelectItem>
            <SelectItem value="order">{t('callAgainPage.sourcePendings')}</SelectItem>
            <SelectItem value="prediction">{t('callAgainPage.sourcePrediction')}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.agent} onValueChange={(v) => setFilters({ agent: v })}>
          <SelectTrigger className="h-9 w-[220px] text-sm" aria-label={t('assigner.filterByAgent')}><SelectValue placeholder={t('assigner.filterByAgent')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="unassigned">{t('callAgainPage.unassignedOnly')}</SelectItem>
            <SelectItem value="all">{t('callAgainPage.allAgents')}</SelectItem>
            {agentOptions.map((a) => <SelectItem key={a.user_id} value={a.user_id}>{a.full_name}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-xs tabular-nums text-muted-foreground">{t('assigner.callAgainsWaiting', { count: f.int(total) })}</span>
      </div>

      <DistributeBar
        kind="call_agains"
        whatLabel={t('assigner.callAgainsTab')}
        departments={departments}
        pool={pool}
        poolWithAssigned={poolWithAssigned}
        agents={agents}
        targets={targets}
        onTargetsChange={onTargetsChange}
        source={filters.source}
        order={filters.order}
        onOrderChange={(o) => setFilters({ order: o === 'newest' ? 'newest' : 'oldest' })}
        warnOffline
        f={f}
      />

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card/80 px-3 py-2 text-xs shadow-sm">
          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">{t('assigner.nSelected', { count: selected.size })}</span>
          {targets.length === 0 && <span className="text-muted-foreground">{t('assigner.dist.pickAgents')}</span>}
          <Button size="sm" className="ml-auto h-9 gap-1.5 sm:h-8" disabled={busy || targets.length === 0} onClick={() => void assignSelected(false)}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <UserPlus className="h-3.5 w-3.5" aria-hidden />}
            {t('assigner.assignCount', { count: selected.size })}
          </Button>
          <Button size="sm" variant="outline" className="h-9 gap-1.5 sm:h-8" disabled={busy} onClick={() => void assignSelected(true)}>
            <UserX className="h-3.5 w-3.5" aria-hidden />{t('assigner.freeSelected')}
          </Button>
        </div>
      )}

      {q.error && !q.data ? (
        <LoadError text={apiErrorText(q.error)} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <div className="space-y-2" aria-busy>{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} variant="tableRow" />)}</div>
      ) : members.length === 0 ? (
        <EmptyState icon={<Clock className="h-5 w-5" />} title={t('assigner.noCallAgains')} description={t('assigner.callAgains.emptyDesc')} size="md" />
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm xl:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="w-10 px-3 py-2.5"><Checkbox checked={allOnPage} onCheckedChange={toggleAll} aria-label={t('assigner.selectAll')} /></th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('assigner.col.customer')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('callAgainPage.colSource')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('assigner.col.department')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('assigner.col.list')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('callAgainPage.colAgent')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('assigner.waitingSince')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('callAgainPage.colLastCalled')}</th>
                  <th className="px-3 py-2.5 text-right font-medium">{t('callAgainPage.colAvgPkg')}</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const days = daysSince(m.call_again_since);
                  const on = selected.has(key(m));
                  return (
                    <tr key={key(m)} onClick={() => toggleOne(m)}
                      className={cn('cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/20', on && 'bg-primary/5')}>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={on} onCheckedChange={() => toggleOne(m)} aria-label={m.customer_name || m.customer_phone} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{m.customer_name || '—'}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{m.customer_phone}</div>
                      </td>
                      <td className="px-3 py-2"><SourceBadge kind={m.source_kind} /></td>
                      <td className="px-3 py-2 text-[12px]">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><DeptDash dept={m.department || 'unknown'} />{deptName(t, m.department)}</span>
                      </td>
                      <td className="max-w-[16rem] px-3 py-2 text-[12px] text-muted-foreground"><ListCell m={m} /></td>
                      <td className="px-3 py-2 text-[12px]">
                        {m.assigned_agent_name || <span className="text-muted-foreground/60">{t('assigner.unassignedLabel')}</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2">
                        {m.call_again_since ? (
                          <>
                            <div className="text-[12px]">{formatDate(m.call_again_since, 'd MMM')}</div>
                            {days != null && (
                              <div className={cn('text-[10px]', days >= 3 ? 'font-medium text-destructive' : 'text-muted-foreground')}>
                                {waitText(days)}
                              </div>
                            )}
                          </>
                        ) : <span className="text-muted-foreground/50">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-[11px] text-muted-foreground">
                        {m.last_call_at ? (
                          <>
                            <div>{formatDate(m.last_call_at, 'd MMM HH:mm')}</div>
                            {m.last_call_outcome && <div className="text-[10px]">{t(`outcome.${m.last_call_outcome}`, { defaultValue: t('common.unknown') })}</div>}
                          </>
                        ) : t('segTable.never')}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                        {m.avg_package_price != null ? <span className="font-semibold">{formatMoney(m.avg_package_price)}</span> : <span className="text-muted-foreground">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:hidden">
            {members.map((m) => {
              const days = daysSince(m.call_again_since);
              const on = selected.has(key(m));
              return (
                <MobileCard key={key(m)} className={cn(on && 'ring-1 ring-primary')} onClick={() => toggleOne(m)}>
                  <div className="flex items-start gap-2">
                    <Checkbox className="mt-1 shrink-0" checked={on} onCheckedChange={() => toggleOne(m)} onClick={(e) => e.stopPropagation()}
                      aria-label={m.customer_name || m.customer_phone} />
                    <div className="min-w-0 flex-1">
                      <CardHead title={m.customer_name || m.customer_phone} sub={m.customer_phone} badges={<SourceBadge kind={m.source_kind} />} />
                      <MobileCardField label={t('assigner.col.department')} value={deptName(t, m.department)} />
                      <MobileCardField label={t('assigner.col.list')} value={<ListCell m={m} />} />
                      <MobileCardField label={t('callAgainPage.colAgent')} value={m.assigned_agent_name || t('assigner.unassignedLabel')} />
                      <MobileCardField
                        label={t('assigner.waitingSince')}
                        value={m.call_again_since
                          ? `${formatDate(m.call_again_since, 'd MMM')}${days != null ? ` · ${waitText(days)}` : ''}`
                          : '—'}
                      />
                      <MobileCardField label={t('callAgainPage.colLastCalled')} value={m.last_call_at ? formatDate(m.last_call_at, 'd MMM HH:mm') : t('segTable.never')} />
                    </div>
                  </div>
                </MobileCard>
              );
            })}
          </div>

          <ResponsivePager page={page} totalPages={Math.max(1, Math.ceil(total / CALL_AGAINS_PAGE_SIZE))} onPageChange={setPage} t={t}
            desktop={<SmartPagination page={page} totalPages={Math.max(1, Math.ceil(total / CALL_AGAINS_PAGE_SIZE))} onPageChange={setPage} />} />
        </>
      )}
    </div>
  );
}
