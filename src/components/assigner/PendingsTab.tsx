import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Inbox, Loader2, UserPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { SmartPagination } from '@/components/SmartPagination';
import { MobileCard, MobileCardField } from '@/components/ui/mobile-card';
import { LoadError } from '@/components/insights/shared/LoadError';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import { apiBulkAssignOrders, type UnassignedPendingOrder } from '@/lib/api';
import type { AssignerBoardAgent } from '@/lib/assignerApi';
import { dealRoundRobin } from '@/lib/assigner/plan';
import { DistributeBar } from './DistributeBar';
import { CardHead, DeptDash, ResponsivePager, deptName } from './parts';
import { invalidateAssigner } from './assignerQueries';

const PAGE_SIZE = 50;

/** The pendings the tab shows: lead pendings (the api filters), in the chosen departments. */
export function pendingsInDepartments(rows: UnassignedPendingOrder[], departments: string[]) {
  if (!departments.length) return rows;
  return rows.filter((o) => o.department && departments.includes(o.department));
}

/**
 * The Pendings tab: the UNASSIGNED lead pendings (lead sources only), newest or
 * oldest first — the same order the DistributeBar deals in. Rows can also be
 * ticked and handed to the chosen agents directly.
 */
export function PendingsTab({
  rows, loading, error, onRetry, order, onOrderChange, departments, agents, targets, onTargetsChange, assignedTotal, f,
}: {
  rows: UnassignedPendingOrder[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  order: 'newest' | 'oldest';
  onOrderChange: (o: 'newest' | 'oldest') => void;
  departments: string[];
  agents: AssignerBoardAgent[];
  targets: string[];
  onTargetsChange: (ids: string[]) => void;
  /** Lead pendings already sitting with agents (the board's Σ). */
  assignedTotal: number;
  f: InsightsFormat;
}) {
  const { t } = f;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const shown = useMemo(() => pendingsInDepartments(rows ?? [], departments), [rows, departments]);
  const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const pageRows = shown.slice((Math.min(page, totalPages) - 1) * PAGE_SIZE, Math.min(page, totalPages) * PAGE_SIZE);
  const allOnPage = pageRows.length > 0 && pageRows.every((o) => picked.includes(o.id));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleAll = () => setPicked((p) => (allOnPage ? p.filter((id) => !pageRows.some((o) => o.id === id)) : [...new Set([...p, ...pageRows.map((o) => o.id)])]));
  const byId = new Map(agents.map((a) => [a.user_id, a]));

  const assignPicked = async () => {
    if (!picked.length || !targets.length) return;
    setBusy(true);
    try {
      const dealt = dealRoundRobin(picked, targets);
      const parts: string[] = [];
      let n = 0;
      for (const [agentId, ids] of dealt) {
        if (!ids.length) continue;
        const res = await apiBulkAssignOrders(ids, agentId) as { assigned?: number };
        const c = res?.assigned ?? ids.length;
        n += c;
        parts.push(`${byId.get(agentId)?.full_name ?? t('assigner.unknownAgent')} ${f.int(c)}`);
      }
      toast({ title: t('assigner.dist.doneTitle', { n: f.int(n) }), description: parts.join(' · ') || undefined });
      setPicked([]);
      invalidateAssigner(qc);
    } catch (err) {
      toast({ title: t('assigner.assignmentFailed'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  if (error && !rows) return <LoadError text={apiErrorText(error)} onRetry={onRetry} />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t('assigner.pendingsUnassignedCount', { count: f.int(shown.length) })}</span>
          {' · '}
          {t('assigner.pendingsAssignedCount', { count: f.int(assignedTotal) })}
          {departments.length > 0 && rows && shown.length !== rows.length && (
            <> · {t('assigner.pendingsTab.ofAll', { n: f.int(rows.length) })}</>
          )}
        </p>
        <span className="text-[11px] text-muted-foreground">{t('assigner.pendingsTab.orderHint')}</span>
      </div>

      <DistributeBar
        kind="pendings"
        whatLabel={t('assigner.tabs.pendings')}
        departments={departments}
        pool={rows ? shown.length : null}
        poolWithAssigned={rows ? shown.length + agents.reduce((s, a) => s + a.pendings_pending, 0) : null}
        agents={agents}
        targets={targets}
        onTargetsChange={onTargetsChange}
        order={order}
        onOrderChange={(o) => onOrderChange(o === 'oldest' ? 'oldest' : 'newest')}
        f={f}
      />

      {picked.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card/80 px-3 py-2 text-xs shadow-sm">
          <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">{t('assigner.nSelected', { count: picked.length })}</span>
          <span className="text-muted-foreground">
            {targets.length ? t('assigner.pendingsTab.toTargets', { agents: t('assigner.dist.agentsN', { count: targets.length }) }) : t('assigner.dist.pickAgents')}
          </span>
          <Button size="sm" className="ml-auto h-9 gap-1.5 sm:h-8" disabled={busy || targets.length === 0} onClick={() => void assignPicked()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <UserPlus className="h-3.5 w-3.5" aria-hidden />}
            {t('assigner.assignCount', { count: picked.length })}
          </Button>
          <Button size="sm" variant="ghost" className="h-9 sm:h-8" onClick={() => setPicked([])}>{t('common.clear')}</Button>
        </div>
      )}

      {loading && !rows ? (
        <div className="space-y-2" aria-busy>{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} variant="tableRow" />)}</div>
      ) : shown.length === 0 ? (
        <EmptyState icon={<Inbox className="h-5 w-5" />} title={t('assigner.noPendingToAssign')} description={t('assigner.allCaughtUp')} size="sm" />
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl border bg-card shadow-sm lg:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="w-10 px-3 py-2.5"><Checkbox checked={allOnPage} onCheckedChange={toggleAll} aria-label={t('assigner.selectAll')} /></th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('assigner.col.customer')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('assigner.col.phone')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('assigner.col.product')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('assigner.col.department')}</th>
                  <th className="px-3 py-2.5 text-left font-medium">{t('assigner.colReceived')}</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((o) => {
                  const on = picked.includes(o.id);
                  return (
                    <tr key={o.id} onClick={() => toggle(o.id)}
                      className={cn('cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/20', on && 'bg-primary/5')}>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={on} onCheckedChange={() => toggle(o.id)} aria-label={o.customer_name || o.customer_phone} />
                      </td>
                      <td className="px-3 py-2 font-medium">{o.customer_name || '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{o.customer_phone}</td>
                      <td className="px-3 py-2">{o.product_name ? <Badge variant="outline" className="text-xs font-normal">{o.product_name}</Badge> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-3 py-2 text-xs">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><DeptDash dept={o.department || 'unknown'} />{deptName(t, o.department)}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">{formatDate(o.created_at, 'd MMM, HH:mm')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:hidden">
            {pageRows.map((o) => {
              const on = picked.includes(o.id);
              return (
                <MobileCard key={o.id} className={cn(on && 'ring-1 ring-primary')} onClick={() => toggle(o.id)}>
                  <div className="flex items-start gap-2">
                    <Checkbox className="mt-1 shrink-0" checked={on} onCheckedChange={() => toggle(o.id)} onClick={(e) => e.stopPropagation()}
                      aria-label={o.customer_name || o.customer_phone} />
                    <CardHead title={o.customer_name || '—'} sub={o.customer_phone} />
                  </div>
                  <MobileCardField label={t('assigner.col.product')} value={o.product_name || '—'} />
                  <MobileCardField label={t('assigner.col.department')} value={deptName(t, o.department)} />
                  <MobileCardField label={t('assigner.colReceived')} value={formatDate(o.created_at, 'd MMM, HH:mm')} />
                </MobileCard>
              );
            })}
          </div>
          <ResponsivePager page={Math.min(page, totalPages)} totalPages={totalPages} onPageChange={setPage} t={t}
            desktop={<SmartPagination page={Math.min(page, totalPages)} totalPages={totalPages} onPageChange={setPage} />} />
        </>
      )}
    </div>
  );
}
