import { CheckCircle2, Inbox, ListChecks, RotateCcw, Users } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Tile } from '@/components/insights/returns/RsBits';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import type { AssignerBoard, AssignerLists } from '@/lib/assignerApi';
import { daysSince } from '@/lib/assigner/board';

/**
 * The five numbers the manager decides on: what waits to be shared (pendings,
 * call-agains, list clients in the chosen departments), who is here, and what
 * was handled today. The Insights Tile look.
 */
export function AssignerKpis({
  board, lists, departments, now, f,
}: {
  board: AssignerBoard | undefined;
  lists: AssignerLists | undefined;
  departments: string[];
  now: number;
  f: InsightsFormat;
}) {
  const { t } = f;
  if (!board) {
    return (
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-busy>
        {Array.from({ length: 5 }, (_, i) => <li key={i}><Skeleton variant="card" className="h-[88px]" /></li>)}
      </ul>
    );
  }
  const tot = board.totals;
  const oldest = daysSince(tot.oldest_call_again_since, now);
  return (
    <section aria-label={t('assigner.kpi.title')}>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Tile icon={Inbox} label={t('assigner.kpi.pendings')} value={f.int(tot.pendings_unassigned)}
          sub={t('assigner.kpi.pendingsSub')} />
        <Tile icon={RotateCcw} label={t('assigner.kpi.callAgains')} value={f.int(tot.call_agains_unassigned)}
          alert={oldest != null && oldest >= 3 ? 'warning' : null}
          sub={oldest != null
            ? t('assigner.kpi.oldestWaits', { n: f.int(oldest) })
            : t('assigner.kpi.callAgainsSplit', { leads: f.int(tot.call_agains_unassigned_orders), lists: f.int(tot.call_agains_unassigned_members) })} />
        <Tile icon={ListChecks} label={t('assigner.kpi.lists')}
          value={lists ? f.int(lists.totals.distributable) : '—'}
          sub={departments.length ? t('assigner.kpi.listsSubSelected', { n: f.int(departments.length) }) : t('assigner.kpi.listsSubAll')} />
        <Tile icon={Users} label={t('assigner.kpi.online')}
          value={<>{f.int(tot.online)}<span className="text-base font-normal text-muted-foreground"> / {f.int(tot.agents)}</span></>}
          sub={t('assigner.kpi.inCall', { n: f.int(tot.in_call) })} />
        <Tile icon={CheckCircle2} label={t('assigner.kpi.worked')} value={f.int(tot.worked_today)}
          sub={t('assigner.kpi.workedSub')} />
      </ul>
    </section>
  );
}
