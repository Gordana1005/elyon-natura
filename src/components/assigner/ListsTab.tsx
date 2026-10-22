import { useMemo, useState, type ReactNode } from 'react';
import { Layers, Lock, PackageSearch, X } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { LoadError } from '@/components/insights/shared/LoadError';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { apiErrorText } from '@/i18n/apiErrors';
import { cn } from '@/lib/utils';
import type { ProductIndexRow } from '@/lib/callScriptsTypes';
import {
  productFilterOn, type AssignerBoardAgent, type AssignerList, type AssignerLists, type AssignerProductFilter, type ProductScope,
} from '@/lib/assignerApi';
import { pickedNames, ProductFilterButton } from '@/components/products/ProductMultiPick';
import { ASSIGNER_LIST_GROUPS, listGroupLabel, listGroupOf, type AssignerListGroupKey } from '@/lib/assigner/listDescription';
import { ListCard, type BasketApi } from './ListCard';

/** The lists shown for the chosen departments: every list with a member there. */
export const visibleLists = (lists: AssignerList[]) => lists.filter((l) => l.total > 0);

const SCOPES: ProductScope[] = ['ever', 'last'];

/** Производ: [Urofix ▾] · Купил некогаш | Во последната нарачка · ✕ (owner 22.10.2026). */
function ProductFilterBar({ catalogue, value, onChange, matching, f }: {
  catalogue: ProductIndexRow[];
  value: AssignerProductFilter | null;
  onChange: (v: AssignerProductFilter | null) => void;
  /** Customers in the lists the filter keeps (null = not loaded yet). */
  matching: number | null;
  f: InsightsFormat;
}) {
  const { t } = f;
  const on = productFilterOn(value);
  const scope = value?.scope ?? 'ever';
  const names = on ? pickedNames(value.ids, catalogue).map((p) => p.name) : [];
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2 shadow-sm" data-testid="assigner-product-filter">
      <ProductFilterButton products={catalogue} value={value?.ids ?? []}
        onChange={(ids) => onChange(ids.length ? { ids, scope } : null)} />
      {on && (
        <div role="radiogroup" aria-label={t('assigner.products.scopeLabel')} className="inline-flex max-w-full rounded-lg bg-muted p-0.5">
          {SCOPES.map((sc) => (
            <button key={sc} type="button" role="radio" aria-checked={scope === sc} title={t(`assigner.products.${sc}Hint`)}
              onClick={() => onChange({ ids: value.ids, scope: sc })} data-testid={`product-scope-${sc}`}
              className={cn(
                'min-h-8 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-7',
                scope === sc ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}>
              {t(`assigner.products.${sc}`)}
            </button>
          ))}
        </div>
      )}
      {on ? (
        <>
          <span className="min-w-0 text-xs text-muted-foreground" title={names.join(', ')}>
            {matching == null ? '…' : t('assigner.products.matching', { n: f.int(matching) })}
          </span>
          <button type="button" onClick={() => onChange(null)}
            className="ml-auto inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className="h-3.5 w-3.5" aria-hidden />{t('assigner.products.clear')}
          </button>
        </>
      ) : (
        <span className="min-w-0 text-xs text-muted-foreground">{t('assigner.products.hint')}</span>
      )}
    </div>
  );
}

/**
 * The Lists tab: every prediction list, grouped like Insights (new buyers, the
 * recency bands, cancels, returns, trash, other), counted for the chosen
 * departments (the BUYER's department — the customer's last purchase) and, when
 * a product is picked, for the customers who bought it.
 */
export function ListsTab({
  data, loading, error, onRetry, departments, products, onProductsChange, catalogue, agents, targets, onTargetsChange, basket, f,
}: {
  data: AssignerLists | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  departments: string[];
  products: AssignerProductFilter | null;
  onProductsChange: (v: AssignerProductFilter | null) => void;
  catalogue: ProductIndexRow[];
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
  const filtered = productFilterOn(products);
  const bar = (
    <ProductFilterBar catalogue={catalogue} value={products} onChange={onProductsChange} f={f}
      matching={data && !loading ? data.totals.total : null} />
  );
  const withBar = (body: ReactNode) => <div className="space-y-4">{bar}{body}</div>;
  if (error && !data) return withBar(<LoadError text={apiErrorText(error)} onRetry={onRetry} />);
  if (loading && !data) {
    return withBar(<div className="space-y-2" aria-busy>{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} variant="card" className="h-24" />)}</div>);
  }
  const all = data?.lists ?? [];
  if (all.length === 0) {
    return withBar(filtered
      ? <EmptyState icon={<PackageSearch className="h-5 w-5" />} title={t('assigner.products.noneTitle')} description={t('assigner.products.noneDesc')} size="md" />
      : <EmptyState icon={<Layers className="h-5 w-5" />} title={t('assigner.noListsYet')} description={t('assigner.lists.noneDesc')} size="md" />);
  }
  const emptyCount = all.length - visibleLists(all).length;

  return (
    <div className="space-y-5">
      {bar}
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
                <ListCard key={l.id} list={l} departments={departments} products={products} agents={agents}
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
