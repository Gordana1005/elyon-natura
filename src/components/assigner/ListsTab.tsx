import { useMemo, useState } from 'react';
import { Layers, Lock } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadError } from '@/components/insights/shared/LoadError';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { apiErrorText } from '@/i18n/apiErrors';
import type { AssignerBoardAgent, AssignerList, AssignerLists } from '@/lib/assignerApi';
import { ASSIGNER_LIST_GROUPS, listGroupLabel, listGroupOf, type AssignerListGroupKey } from '@/lib/assigner/listDescription';
import { ListCard, type BasketApi } from './ListCard';

/** The lists shown for the chosen departments: every list with a member there. */
export const visibleLists = (lists: AssignerList[]) => lists.filter((l) => l.total > 0);

/**
 * The Lists tab: every prediction list, grouped like Insights (new buyers, the
 * recency bands, cancels, returns, trash, other), counted for the chosen
 * departments (the BUYER's department — the customer's last purchase).
 */
export function ListsTab({
  data, loading, error, onRetry, departments, agents, targets, onTargetsChange, basket, f,
}: {
  data: AssignerLists | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  departments: string[];
  agents: AssignerBoardAgent[];
  targets: string[];
  onTargetsChange: (ids: string[]) => void;
  basket: BasketApi;
  f: InsightsFormat;
}) {
  const { t } = f;
  const [showEmpty, setShowEmpty] = useState(false);

  const groups = useMemo(() => {
    const lists = [...(data?.lists ?? [])].sort((a, b) => a.display_order - b.display_order || a.name.localeCompare(b.name));
    const shown = showEmpty ? lists : visibleLists(lists);
    const by = new Map<AssignerListGroupKey, AssignerList[]>();
    for (const l of shown) {
      const g = listGroupOf(l.name, l.category);
      by.set(g, [...(by.get(g) ?? []), l]);
    }
    return ASSIGNER_LIST_GROUPS.filter((g) => by.has(g)).map((g) => ({ key: g, lists: by.get(g)! }));
  }, [data, showEmpty]);

  // 403 members_restricted: a role without the member-privacy permission — say so, calmly.
  if (error && !data && error instanceof Error && error.message === 'members_restricted') {
    return <EmptyState icon={<Lock className="h-5 w-5" />} title={t('assigner.lists.restrictedTitle')} description={t('assigner.lists.restricted')} size="md" />;
  }
  if (error && !data) return <LoadError text={apiErrorText(error)} onRetry={onRetry} />;
  if (loading && !data) {
    return <div className="space-y-2" aria-busy>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="card" className="h-24" />)}</div>;
  }
  const all = data?.lists ?? [];
  if (all.length === 0) {
    return <EmptyState icon={<Layers className="h-5 w-5" />} title={t('assigner.noListsYet')} description={t('assigner.lists.noneDesc')} size="md" />;
  }
  const emptyCount = all.length - visibleLists(all).length;

  return (
    <div className="space-y-5">
      {groups.length === 0 && (
        <EmptyState icon={<Layers className="h-5 w-5" />} title={t('assigner.lists.noneInDepartments')} size="sm" />
      )}
      {groups.map((g) => {
        const toCall = g.lists.reduce((s, l) => s + l.distributable, 0);
        return (
          <section key={g.key} aria-labelledby={`assigner-group-${g.key}`} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-1">
              <h3 id={`assigner-group-${g.key}`} className="text-sm font-semibold">{listGroupLabel(t, g.key)}</h3>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t('assigner.lists.groupSummary', { lists: f.int(g.lists.length), n: f.int(toCall) })}
              </span>
            </div>
            <div className="space-y-2">
              {g.lists.map((l) => (
                <ListCard key={l.id} list={l} departments={departments} agents={agents}
                  targets={targets} onTargetsChange={onTargetsChange} basket={basket} f={f} />
              ))}
            </div>
          </section>
        );
      })}
      {emptyCount > 0 && (
        <button type="button" onClick={() => setShowEmpty((v) => !v)}
          className="rounded-sm px-1 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {showEmpty ? t('assigner.lists.hideEmpty') : t('assigner.lists.showEmpty', { n: f.int(emptyCount) })}
        </button>
      )}
    </div>
  );
}
