import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ChevronRight, Eye, Loader2, PhoneOutgoing, UserCheck, UserX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { apiErrorText } from '@/i18n/apiErrors';
import { cn } from '@/lib/utils';
import { apiBulkUnassignSegment, apiGetSegment } from '@/lib/api';
import { ASSIGNER_DEPARTMENTS, UNKNOWN_DEPARTMENT, type AssignerBoardAgent, type AssignerList } from '@/lib/assignerApi';
import { listDescription } from '@/lib/assigner/listDescription';
import { listLabel } from '@/components/insights/lists/listModel';
import { BUCKET_TONE } from '@/components/insights/overview/palette';
import { StackedBar } from '@/components/insights/shared/StackedBar';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { SegmentMemberTable, type SegmentMember } from './SegmentMemberTable';
import { DistributeBar } from './DistributeBar';
import { DeptDash, deptName } from './parts';
import { invalidateAssigner } from './assignerQueries';

const PAGE_SIZE = 50;

/** The list's lifecycle bar: waiting to be shared → with an agent → done. The
 *  Overview's validated pipeline steps (awaiting · preparing) + delivered-green. */
export const LIST_TONE = {
  toCall: BUCKET_TONE.awaiting,
  withAgents: BUCKET_TONE.preparing,
  done: BUCKET_TONE.delivered,
} as const;

/** The cross-list basket, owned by the page so it survives a tab switch. */
export interface BasketApi {
  isIn: (listId: string, phone: string) => boolean;
  toggle: (listId: string, listName: string, m: SegmentMember) => void;
  setMany: (listId: string, listName: string, members: SegmentMember[], add: boolean) => void;
}

/** The three disjoint parts of a list for the chosen departments (they sum to its total). */
export function listParts(l: Pick<AssignerList, 'total' | 'distributable' | 'done'>) {
  const toCall = Math.max(0, l.distributable);
  const done = Math.max(0, Math.min(l.done, l.total - toCall));
  return { toCall, withAgents: Math.max(0, l.total - toCall - done), done };
}

/** Everything assigned in the WHOLE list, every department (what "Одземи ги сите" frees). */
export const wholeListAssigned = (l: AssignerList) => {
  const parts = Object.values(l.by_department ?? {});
  return parts.length ? parts.reduce((s, c) => s + c.assigned, 0) : l.assigned;
};

export function ListCard({
  list, departments, agents, targets, onTargetsChange, basket, f,
}: {
  list: AssignerList;
  departments: string[];
  agents: AssignerBoardAgent[];
  targets: string[];
  onTargetsChange: (ids: string[]) => void;
  basket: BasketApi;
  f: InsightsFormat;
}) {
  const { t } = f;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const [assignedFilter, setAssignedFilter] = useState('all');
  const [completedFilter, setCompletedFilter] = useState('no');
  const [confirmUnassign, setConfirmUnassign] = useState(false);
  const [busy, setBusy] = useState(false);

  const label = listLabel(t, list.name);
  const desc = listDescription(t, list.name, list.description);
  const parts = listParts(list);
  const assignedAll = wholeListAssigned(list);
  const readOnly = !list.assignable;

  const { data, isLoading } = useQuery<{ members: SegmentMember[]; total: number }>({
    queryKey: ['segment', list.id, page, assignedFilter, completedFilter, departments.join(',')],
    queryFn: () => apiGetSegment(list.id, {
      page, limit: PAGE_SIZE,
      assigned: assignedFilter !== 'all' ? assignedFilter : undefined,
      completed: completedFilter !== 'all' ? completedFilter : undefined,
      departments,
    }),
    enabled: expanded,
  });
  const members = data?.members ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const allOnPageInBasket = members.length > 0 && members.every((m) => basket.isIn(list.id, m.customer_phone));

  const segText = (key: 'toCall' | 'withAgents' | 'done', n: number) =>
    `${t(`assigner.lists.part.${key}`)} · ${f.int(n)} (${f.share(n, list.total)})`;

  const unassignAll = async () => {
    setBusy(true);
    try {
      const res = await apiBulkUnassignSegment(list.id, 'all') as { unassigned?: number };
      toast({ title: t('assigner.nUnassigned', { count: res?.unassigned ?? 0 }) });
      invalidateAssigner(qc);
    } catch (err) {
      toast({ title: t('assigner.unassignFailed'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setBusy(false);
      setConfirmUnassign(false);
    }
  };

  const deptKeys = [...ASSIGNER_DEPARTMENTS, UNKNOWN_DEPARTMENT].filter((d) => (list.by_department?.[d]?.total ?? 0) > 0);
  const agentsByName = [...agents].sort((a, b) => a.full_name.localeCompare(b.full_name, 'mk'));

  return (
    <article className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="space-y-2 px-3 py-3 sm:px-4">
        <button type="button" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}
          className="flex w-full min-w-0 items-start gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-semibold" title={list.name}>{label}</span>
              {readOnly && (
                <Badge variant="secondary" className="gap-1 text-[10px]"><Eye className="h-3 w-3" aria-hidden />{t('assigner.lists.readOnlyBadge')}</Badge>
              )}
            </span>
            {desc && <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{desc}</span>}
          </span>
          <span className="shrink-0 text-right">
            <span className="block text-lg font-semibold leading-none tabular-nums">{f.int(parts.toCall)}</span>
            <span className="text-[11px] text-muted-foreground">{t('assigner.lists.toCallShort')}</span>
          </span>
        </button>

        <div className="pl-6">
          <StackedBar
            className="h-2"
            label={t('assigner.lists.barLabel', { list: label })}
            segments={[
              { key: 'toCall', weight: parts.toCall, tone: LIST_TONE.toCall, text: segText('toCall', parts.toCall) },
              { key: 'withAgents', weight: parts.withAgents, tone: LIST_TONE.withAgents, text: segText('withAgents', parts.withAgents) },
              { key: 'done', weight: parts.done, tone: LIST_TONE.done, text: segText('done', parts.done) },
            ]}
          />
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {([
                ['toCall', PhoneOutgoing, parts.toCall],
                ['withAgents', UserCheck, parts.withAgents],
                ['done', CheckCircle2, parts.done],
              ] as const).map(([key, Icon, n]) => (
                <li key={key} className={cn('inline-flex items-center gap-1', n === 0 && 'opacity-60')}>
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', LIST_TONE[key])} aria-hidden />
                  <Icon className="h-3 w-3 shrink-0" aria-hidden />
                  <span>{t(`assigner.lists.part.${key}`)}</span>
                  <span className="font-semibold tabular-nums text-foreground">{f.int(n)}</span>
                </li>
              ))}
            </ul>
            {deptKeys.length > 0 && (
              <ul data-hscroll aria-label={t('assigner.lists.byDepartment')}
                className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
                {deptKeys.map((d) => {
                  const c = list.by_department[d];
                  const dim = departments.length > 0 && !departments.includes(d);
                  return (
                    <li key={d}
                      title={t('assigner.lists.deptTip', {
                        dept: deptName(t, d), total: f.int(c.total), toCall: f.int(c.distributable),
                        assigned: f.int(c.assigned), done: f.int(c.done),
                      })}
                      className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-[10px]', dim && 'opacity-50')}>
                      <DeptDash dept={d} />
                      <span className="max-w-[9rem] truncate">{deptName(t, d)}</span>
                      <span className="font-semibold tabular-nums">{f.int(c.total)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 border-t bg-muted/20 p-3 sm:p-4">
          {readOnly ? (
            <p className="rounded-lg border border-dashed bg-card/60 px-3 py-2 text-xs text-muted-foreground">{t('assigner.lists.readOnly')}</p>
          ) : (
            <DistributeBar
              kind="list"
              listId={list.id}
              whatLabel={label}
              departments={departments}
              pool={list.distributable}
              poolWithAssigned={Math.max(0, list.total - parts.done)}
              agents={agents}
              targets={targets}
              onTargetsChange={onTargetsChange}
              allowRandom
              f={f}
            />
          )}
          {assignedAll > 0 && (
            <div className="flex justify-end">
              <Button size="sm" variant="outline" className="h-9 gap-1.5 text-rose-700 sm:h-8 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950/40"
                disabled={busy} onClick={() => setConfirmUnassign(true)}>
                <UserX className="h-3.5 w-3.5" aria-hidden /> {t('assigner.unassignAll', { count: f.int(assignedAll) })}
              </Button>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={assignedFilter} onValueChange={(v) => { setAssignedFilter(v); setPage(1); }}>
                <SelectTrigger className="h-9 w-[210px] max-w-full text-xs sm:h-8" aria-label={t('assigner.filterByAgent')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('segmentDetail.allMembers')}</SelectItem>
                  <SelectItem value="none">{t('segmentDetail.unassignedOnly')}</SelectItem>
                  {agentsByName.map((a) => <SelectItem key={a.user_id} value={a.user_id}>{t('segmentDetail.assignedTo', { name: a.full_name })}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={completedFilter} onValueChange={(v) => { setCompletedFilter(v); setPage(1); }}>
                <SelectTrigger className="h-9 w-[210px] max-w-full text-xs sm:h-8" aria-label={t('assigner.lists.stateFilter')}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('segmentDetail.anyState')}</SelectItem>
                  <SelectItem value="no">{t('segmentDetail.notYetCalled')}</SelectItem>
                  <SelectItem value="yes">{t('segmentDetail.alreadyCalled')}</SelectItem>
                </SelectContent>
              </Select>
              <span className="ml-auto text-xs text-muted-foreground">
                {t('assigner.lists.matching', { n: f.int(total) })}
                {!readOnly && <> · {t('assigner.lists.tickHint')}</>}
              </span>
            </div>
            {!isLoading && total === 0 && parts.done > 0 && completedFilter === 'no' && (assignedFilter === 'all' || assignedFilter === 'none') && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                <span>{t('assigner.hiddenDone', { count: f.int(parts.done) })}</span>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setCompletedFilter('all')}>{t('assigner.showAll')}</Button>
              </div>
            )}
            <SegmentMemberTable
              members={members}
              isSelected={(phone) => basket.isIn(list.id, phone)}
              onToggle={(m) => basket.toggle(list.id, list.name, m)}
              onToggleAll={() => basket.setMany(list.id, list.name, members, !allOnPageInBasket)}
              allOnPageSelected={allOnPageInBasket}
              page={page}
              totalPages={totalPages}
              onPageChange={setPage}
              loading={isLoading}
              compact
              selectable={!readOnly}
              cardsBelow="2xl"
            />
          </div>
        </div>
      )}

      <AlertDialog open={confirmUnassign} onOpenChange={(o) => { if (!o && !busy) setConfirmUnassign(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('assigner.lists.unassignAllTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('assigner.lists.unassignAllBody', { n: f.int(assignedAll), list: label })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={(e) => { e.preventDefault(); void unassignAll(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <UserX className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
              {t('assigner.confirmUnassignCta')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
