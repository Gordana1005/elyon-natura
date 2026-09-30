import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiGetSegment, apiAssignSegmentMembers, type AssignmentSummaryList } from '@/lib/api';
import type { SegmentMember } from '@/components/assigner/SegmentMemberTable';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ChevronLeft, ChevronRight, Loader2, UserX } from 'lucide-react';
import { formatDate } from '@/i18n/dates';
import { cn } from '@/lib/utils';
import { listLabel } from '@/components/insights/lists/listModel';

const PAGE_SIZE = 50;

interface Props {
  agentId: string;
  list: AssignmentSummaryList;
  busy: boolean;
  /** Full-detach the whole (agent, list) pair — handled by the parent panel
   *  (routes through assigner/unassign-all with list_ids + include_done). */
  onUnassignList: () => void;
  onMutated: () => void;
}

/** Expandable list sub-row inside an agent's Unassign-tab card: lazy-loads the
 *  members of ONE list assigned to that agent (done ones included — they're
 *  what keeps a list stuck to a profile) with a per-client unassign. */
export function AgentListMembersRow({ agentId, list, busy, onUnassignList, onMutated }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<{ members: SegmentMember[]; total: number }>({
    queryKey: ['assigner-agent-list-members', agentId, list.list_id, page],
    queryFn: () => apiGetSegment(list.list_id, { page, limit: PAGE_SIZE, assigned: agentId }),
    enabled: expanded,
    retry: (failureCount, err) =>
      failureCount < 2 && !String((err as Error)?.message ?? '').includes('Forbidden'),
  });
  const members = data?.members ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // A privacy-gated manager (no show_segment_members) gets 403 here — they can
  // still bulk-detach, they just can't see the people.
  const restricted = !!error && String((error as Error)?.message ?? '').includes('Forbidden');

  // Unassigns shrink the result set — don't strand the pager past the end.
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const doneCount = Math.max(0, list.assigned - list.open);

  const unassignOne = async (m: SegmentMember) => {
    setRowBusy(m.customer_phone);
    try {
      await apiAssignSegmentMembers(list.list_id, [m.customer_phone], null);
      toast({ title: t('assigner.unassignedCustomer', { name: m.customer_name || m.customer_phone }) });
      onMutated();
    } catch (err) {
      toast({ title: t('assigner.unassignFailed'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 pl-5 sm:px-4 sm:pl-9">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          className="flex min-h-9 min-w-[10rem] flex-1 items-center gap-3 text-left"
          aria-label={expanded ? t('assigner.hideClients') : t('assigner.showClients')}
        >
          <ChevronRight className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0', expanded && 'rotate-90')} />
          <span className="min-w-0 flex-1 break-words text-sm sm:truncate" title={list.list_name}>{listLabel(t, list.list_name)}</span>
        </button>
        {list.open > 0 && (
          <span className="text-xs text-amber-700 dark:text-amber-400 shrink-0">
            {t('assigner.nToCall', { count: list.open.toLocaleString() })}
          </span>
        )}
        {doneCount > 0 && (
          <span className="text-xs text-muted-foreground shrink-0">
            {t('assigner.nDone', { count: doneCount.toLocaleString() })}
          </span>
        )}
        <Button
          size="sm" variant="ghost" className="h-9 gap-1.5 text-xs text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/40 shrink-0 sm:h-7"
          disabled={busy}
          onClick={onUnassignList}
        >
          <UserX className="h-3 w-3" /> {t('assigner.unassign')}
        </Button>
      </div>

      {expanded && (
        <div className="border-t bg-background/40">
          {isLoading ? (
            <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-primary" /></div>
          ) : restricted ? (
            <div className="px-4 py-3 pl-6 text-xs text-muted-foreground sm:pl-16">{t('assigner.membersRestricted')}</div>
          ) : members.length === 0 ? (
            <div className="px-4 py-3 pl-6 text-xs text-muted-foreground sm:pl-16">{t('assigner.noAssignmentsAnywhere')}</div>
          ) : (
            <>
              {members.map(m => (
                <div key={m.customer_phone} className="flex items-center gap-3 px-3 py-1.5 pl-6 sm:px-4 sm:pl-16 border-b last:border-0 border-border/50">
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-medium">{m.customer_name || '—'}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{m.customer_phone}</span>
                  </div>
                  {m.is_completed && (
                    <Badge variant="secondary" className="text-[10px] shrink-0">{t('assigner.doneBadge')}</Badge>
                  )}
                  <span className="text-[11px] text-muted-foreground shrink-0 hidden md:inline">
                    {m.assigned_at ? formatDate(m.assigned_at, 'd MMM, HH:mm') : '—'}
                  </span>
                  <Button
                    variant="ghost" size="icon"
                    className="h-9 w-9 shrink-0 text-rose-600 hover:bg-rose-100 hover:text-rose-700 sm:h-6 sm:w-6"
                    disabled={busy || rowBusy !== null}
                    onClick={() => unassignOne(m)}
                    title={t('assigner.unassign')}
                  >
                    {rowBusy === m.customer_phone ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserX className="h-3 w-3" />}
                  </Button>
                </div>
              ))}
              {totalPages > 1 && (
                <div className="flex items-center justify-end gap-2 px-4 py-2 pl-6 sm:pl-16">
                  <span className="text-[11px] text-muted-foreground">{page} / {totalPages}</span>
                  <Button variant="outline" size="icon" className="h-6 w-6" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                    <ChevronLeft className="h-3 w-3" />
                  </Button>
                  <Button variant="outline" size="icon" className="h-6 w-6" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
