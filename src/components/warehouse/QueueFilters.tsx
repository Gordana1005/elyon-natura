import { cn } from '@/lib/utils';
import { Chip, ChipGroup, DeptDash, LABEL, deptName } from '@/components/assigner/parts';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { WAREHOUSE_DEPARTMENTS, type QueueOrder } from '@/lib/warehouseApi';
import type { ReactNode } from 'react';

/**
 * Department chips (the Assigner's pattern: Сите + the six, multi-select, each with its
 * colour dash and its count) and the oldest / newest order. One row that scrolls
 * sideways on a phone (scrollbar hidden), wraps from sm up — the page never does.
 */
export function QueueFilters({
  departments, onDepartments, order, onOrder, byDepartment, hideWeb, right, f,
}: {
  departments: string[];
  onDepartments: (next: string[]) => void;
  order: QueueOrder;
  onOrder: (o: QueueOrder) => void;
  byDepartment?: Record<string, number>;
  hideWeb?: boolean;
  right?: ReactNode;
  f: InsightsFormat;
}) {
  const { t } = f;
  const all = WAREHOUSE_DEPARTMENTS.filter((d) => !(hideWeb && d === 'web'));
  const toggle = (d: string) =>
    onDepartments(departments.includes(d) ? departments.filter((x) => x !== d) : all.filter((x) => x === d || departments.includes(x)));
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card/80 px-3 py-2 shadow-sm">
      <div role="group" aria-label={t('warehousePage.filters.departments')} data-hscroll
        className="-mx-1 flex min-w-0 max-w-full flex-nowrap items-center gap-1.5 overflow-x-auto px-1 py-0.5 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <span className={cn(LABEL, 'mr-0.5')}>{t('warehousePage.filters.departments')}</span>
        <Chip on={departments.length === 0} onClick={() => onDepartments([])}>{t('warehousePage.filters.allDepartments')}</Chip>
        {all.map((d) => (
          <Chip key={d} on={departments.includes(d)} onClick={() => toggle(d)}>
            <DeptDash dept={d} />
            {deptName(t, d)}
            {byDepartment && <span className="tabular-nums text-muted-foreground">{f.int(byDepartment[d] ?? 0)}</span>}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ChipGroup label={t('warehousePage.filters.order')} value={order} onChange={onOrder}
          options={[{ value: 'oldest', label: t('warehousePage.filters.oldest') }, { value: 'newest', label: t('warehousePage.filters.newest') }]} />
        {right}
      </div>
    </div>
  );
}

/** « Претходна · 1–50 од 514 · Следна » — the queue is paged on the server. */
export function QueuePager({ offset, limit, total, onOffset, f }: {
  offset: number; limit: number; total: number; onOffset: (o: number) => void; f: InsightsFormat;
}) {
  const { t } = f;
  if (total <= limit && offset === 0) return null;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav className="flex flex-wrap items-center justify-center gap-2 text-xs" aria-label={t('warehousePage.pager.range', { from, to, total })}>
      <button type="button" className="min-h-9 rounded-md border bg-card px-3 font-medium hover:bg-muted disabled:opacity-50"
        disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - limit))}>{t('warehousePage.pager.prev')}</button>
      <span className="tabular-nums text-muted-foreground">{t('warehousePage.pager.range', { from: f.int(from), to: f.int(to), total: f.int(total) })}</span>
      <button type="button" className="min-h-9 rounded-md border bg-card px-3 font-medium hover:bg-muted disabled:opacity-50"
        disabled={to >= total} onClick={() => onOffset(offset + limit)}>{t('warehousePage.pager.next')}</button>
    </nav>
  );
}
