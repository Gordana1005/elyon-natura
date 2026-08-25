import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { apiErrorText } from '@/i18n/apiErrors';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  apiGetAssignmentSummary, apiUnassignAllForAgent,
  type AssignmentSummary, type AssignmentSummaryAgent,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ChevronRight, Loader2, UserX, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/EmptyState';
import { AgentPendingLeadsRow } from '@/components/assigner/AgentPendingLeadsRow';
import { AgentListMembersRow } from '@/components/assigner/AgentListMembersRow';

/** What a pending confirmation is about. `agent_id: 'all'` = every agent. */
interface PendingAction {
  agentId: 'all' | string;
  agentName: string;
  listIds?: string[];
  listName?: string;
  count: number;
  /** Assigned status=pending leads that will be freed alongside (0 for list-scoped calls). */
  pendings: number;
}

interface Props {
  /** Presence dots — the summary endpoint only knows about assignments. */
  onlineIds?: string[];
  /** Set by the page when an agent card / pendings chip is clicked: expand +
   *  scroll to that agent's row (and optionally auto-open its pendings). */
  focus?: { agentId: string; section?: 'pendings' } | null;
  onFocusHandled?: () => void;
}

/**
 * Cross-list mass unassign — the one-stop unassign surface. Every bulk button
 * here FULLY DETACHES (include_done): besides freeing not-yet-called clients
 * it also clears the agent stamp on already-called rows, so the (agent, list)
 * pair disappears from the agent's profile instead of lingering as an "empty"
 * list (operator decision 2026-07-28). Who-called-whom survives in call_logs
 * and the audit row; is_completed / last_call_* / sales credit are untouched.
 *
 * Each agent row expands to its lists and pending leads; each list expands to
 * the individual clients with a per-client unassign.
 */
export function BulkUnassignPanel({ onlineIds = [], focus, onFocusHandled }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [releaseCallAgains, setReleaseCallAgains] = useState(false);
  // Latched from `focus` (which the page clears right away) so the pendings
  // sub-row still knows to auto-open once its agent row renders expanded.
  const [pendingsAutoOpenFor, setPendingsAutoOpenFor] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const { data, isLoading } = useQuery<AssignmentSummary>({
    queryKey: ['assignment-summary'],
    queryFn: apiGetAssignmentSummary,
    refetchInterval: 30000,
  });

  const agents = data?.agents ?? [];
  const assignedTotal = data?.totals.assigned_total ?? 0;
  const pendingsTotal = data?.totals.pendings_total ?? 0;
  // Everything an agent still HOLDS counts — including done-only lists, which
  // are exactly the "empty list stuck to a profile" case this tab now fixes.
  const withLoad = agents.filter(a => a.assigned_total > 0 || (a.pendings_total ?? 0) > 0);

  const toggleExpanded = (id: string) =>
    setExpanded(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  // Agent-card / chip navigation from the page: expand + scroll to the row.
  useEffect(() => {
    if (!focus || isLoading) return;
    const hasRow = withLoad.some(a => a.agent_id === focus.agentId);
    if (hasRow) {
      setExpanded(prev => prev.includes(focus.agentId) ? prev : [...prev, focus.agentId]);
      if (focus.section === 'pendings') setPendingsAutoOpenFor(focus.agentId);
      // Let the row render before scrolling.
      requestAnimationFrame(() => {
        rowRefs.current.get(focus.agentId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, isLoading]);

  // Everything any unassign in this tab can move — panel, lists, queues, cards.
  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['assignment-summary'] });
    queryClient.invalidateQueries({ queryKey: ['segments'] });
    queryClient.invalidateQueries({ queryKey: ['segment'] });
    queryClient.invalidateQueries({ queryKey: ['online-agents'] });
    queryClient.invalidateQueries({ queryKey: ['my-queue-summary'] });
    queryClient.invalidateQueries({ queryKey: ['unassigned-pending'] });
    queryClient.invalidateQueries({ queryKey: ['assigner-agent-list-members'] });
    queryClient.invalidateQueries({ queryKey: ['assigner-agent-pendings'] });
  };

  const runUnassign = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      // Pendings ride along only on full-agent calls; list-scoped rows never
      // touch orders (the server also ignores the flag when list_ids is set).
      const res = await apiUnassignAllForAgent(pending.agentId, pending.listIds, {
        includePendings: !pending.listIds && pending.pendings > 0,
        includeCallAgains: !pending.listIds && releaseCallAgains,
        includeDone: true,
      });
      const freedPendings = res?.pendings_unassigned ?? 0;
      const freedCallAgains = res?.call_agains_unassigned ?? 0;
      toast({
        title: freedCallAgains > 0
          ? t('assigner.nClientsPendingsCallAgainsFreed', {
              count: res?.unassigned ?? 0,
              pendings: freedPendings,
              callAgains: freedCallAgains,
            })
          : freedPendings > 0
          ? t('assigner.nClientsAndPendingsFreed', { count: res?.unassigned ?? 0, pendings: freedPendings })
          : t('assigner.nClientsFreed', { count: res?.unassigned ?? 0 }),
      });
      setPending(null);
      setReleaseCallAgains(false);
      invalidateAll();
    } catch (err) {
      toast({ title: t('assigner.unassignFailed'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-3">
      {/* ── Header: the nuke ── */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3 shadow-sm">
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {t('assigner.heldByAgents', { count: assignedTotal.toLocaleString() })}
            {pendingsTotal > 0 && <> · {t('assigner.nPendings', { count: pendingsTotal.toLocaleString() })}</>}
          </div>
          <div className="text-xs text-muted-foreground">{t('assigner.unassignFullDetach')}</div>
        </div>
        <Button
          size="sm" variant="destructive" className="h-9 gap-1.5 ml-auto"
          disabled={(assignedTotal + pendingsTotal) === 0 || busy}
          onClick={() => setPending({ agentId: 'all', agentName: t('assigner.allAgents'), count: assignedTotal, pendings: pendingsTotal })}
        >
          <UserX className="h-3.5 w-3.5" />
          {t('assigner.unassignAllAgents', { count: (assignedTotal + pendingsTotal).toLocaleString() })}
        </Button>
      </div>

      {/* ── One row per agent holding clients ── */}
      {withLoad.length === 0 ? (
        <EmptyState
          icon={<Users className="h-5 w-5" />}
          title={t('assigner.noAssignmentsAnywhere')}
          description={t('assigner.noAssignmentsAnywhereDesc')}
          size="md"
        />
      ) : withLoad.map(agent => {
        const isOpen = expanded.includes(agent.agent_id);
        const online = onlineIds.includes(agent.agent_id);
        const doneHeld = Math.max(0, agent.assigned_total - agent.open_total);
        const heldLists = agent.lists.filter(l => l.assigned > 0);
        return (
          <div
            key={agent.agent_id}
            ref={el => { if (el) rowRefs.current.set(agent.agent_id, el); else rowRefs.current.delete(agent.agent_id); }}
            className="rounded-xl border bg-card shadow-sm overflow-hidden"
          >
            <div className="flex items-center gap-3 px-4 py-3">
              <button
                type="button"
                onClick={() => toggleExpanded(agent.agent_id)}
                className="flex flex-1 items-center gap-3 min-w-0 text-left"
              >
                <ChevronRight className={cn('h-4 w-4 text-muted-foreground transition-transform shrink-0', isOpen && 'rotate-90')} />
                <div className="relative shrink-0">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
                    {agent.full_name.charAt(0).toUpperCase()}
                  </div>
                  <div className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card', online ? 'bg-[hsl(var(--success))]' : 'bg-muted-foreground/40')} />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">{agent.full_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {heldLists.length > 0
                      ? t('assigner.acrossNLists', { count: heldLists.length })
                      : t('assigner.pendingLeadsRow')}
                  </div>
                </div>
              </button>
              <div className="flex items-center gap-2 shrink-0">
                {agent.open_total > 0 && (
                  <Badge className="text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/15">
                    {t('assigner.nToCall', { count: agent.open_total.toLocaleString() })}
                  </Badge>
                )}
                {agent.pendings_total > 0 && (
                  <Badge className="text-[10px] bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30 hover:bg-sky-500/15">
                    {t('assigner.nPendings', { count: agent.pendings_total.toLocaleString() })}
                  </Badge>
                )}
                {doneHeld > 0 && (
                  <Badge variant="secondary" className="text-[10px]">{t('assigner.nDone', { count: doneHeld.toLocaleString() })}</Badge>
                )}
                <Button
                  size="sm" variant="outline" className="h-8 gap-1.5 text-rose-700 hover:bg-rose-50"
                  disabled={busy}
                  onClick={() => setPending({ agentId: agent.agent_id, agentName: agent.full_name, count: agent.assigned_total, pendings: agent.pendings_total || 0 })}
                >
                  <UserX className="h-3.5 w-3.5" />
                  {t('assigner.unassignNToCall', { count: (agent.assigned_total + (agent.pendings_total || 0)).toLocaleString() })}
                </Button>
              </div>
            </div>

            {isOpen && (
              <div className="border-t bg-muted/20 divide-y">
                {agent.pendings_total > 0 && (
                  <AgentPendingLeadsRow
                    agentId={agent.agent_id}
                    count={agent.pendings_total}
                    busy={busy}
                    defaultOpen={pendingsAutoOpenFor === agent.agent_id}
                    onMutated={invalidateAll}
                  />
                )}
                {heldLists.map(list => (
                  <AgentListMembersRow
                    key={list.list_id}
                    agentId={agent.agent_id}
                    list={list}
                    busy={busy}
                    onUnassignList={() => setPending({
                      agentId: agent.agent_id,
                      agentName: agent.full_name,
                      listIds: [list.list_id],
                      listName: list.list_name,
                      count: list.assigned,
                      pendings: 0,
                    })}
                    onMutated={invalidateAll}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}

      <AlertDialog open={!!pending} onOpenChange={(open) => { if (!open && !busy) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('assigner.confirmUnassignTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.listName
                ? t('assigner.confirmUnassignList', { count: pending.count, name: pending.agentName, list: pending.listName })
                : pending?.agentId === 'all'
                ? t('assigner.confirmUnassignAll', { count: pending?.count ?? 0 })
                : t('assigner.confirmUnassignAgent', { count: pending?.count ?? 0, name: pending?.agentName })}
              {(pending?.pendings ?? 0) > 0 && (
                <> {t('assigner.confirmUnassignPendings', { count: pending?.pendings ?? 0 })}</>
              )}
              {' '}
              {t('assigner.unassignFullDetach')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!pending?.listIds && (
            <label className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
              <Checkbox
                checked={releaseCallAgains}
                onCheckedChange={(v) => setReleaseCallAgains(v === true)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">{t('assigner.releasePendingCallAgains')}</span>
                <span className="block text-xs text-muted-foreground">{t('assigner.releasePendingCallAgainsHint')}</span>
              </span>
            </label>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); runUnassign(); }}
              disabled={busy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserX className="h-3.5 w-3.5 mr-1.5" />}
              {t('assigner.confirmUnassignCta')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export type { AssignmentSummaryAgent };
