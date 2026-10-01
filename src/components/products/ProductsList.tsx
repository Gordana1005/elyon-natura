import { memo } from 'react';
import { Edit, History, Package, Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/currency';
import { lineOf, type BrandLine } from '@/lib/products/brandLines';
import { kindOf, type CatalogueRow, type ProductKind } from '@/lib/products/kinds';
import { useMinWidth } from '@/lib/products/useMinWidth';
import { LineChip } from './LineChip';
import { KindChip } from './KindChip';
import { VatChip } from './VatChip';
import type { VatRate } from '@/lib/products/vat';

/** A row of GET /api/products/catalogue. */
export type ProductRow = CatalogueRow;

/** Stable callbacks (the page keeps them in useCallback) so a memoised row re-renders only when ITS data changes. */
export interface RowHandlers {
  onToggleSelect: (id: string) => void;
  onSetLine: (p: ProductRow, line: BrandLine | null) => void;
  onSetKind: (p: ProductRow, kind: ProductKind | null) => void;
  onSetVat: (p: ProductRow, rate: VatRate | null) => void;
  onEdit: (p: ProductRow) => void;
  onToggleActive: (p: ProductRow) => void;
  onLogs: (p: ProductRow) => void;
}

export interface RowFlags {
  /** Cost is admins only (the api strips it for everyone else). */
  showCost: boolean;
  /** Edit / enable / disable: admins and managers. */
  canEdit: boolean;
  /** Set lines and kinds, select rows: admins + owners. */
  canSetLine: boolean;
  /** The VAT column (owners: the api sends the VAT columns to owners only, who also set it). */
  showVat: boolean;
}

export interface ProductsListProps extends RowFlags {
  /** The rows of the current page only. */
  rows: ProductRow[];
  selected: ReadonlySet<string>;
  /** Select (true) or unselect (false) every shown row. */
  onSelectShown: (on: boolean) => void;
  busyIds: ReadonlySet<string>;
  handlers: RowHandlers;
}

function StatusBadge({ active }: { active: boolean }) {
  const { t } = useTranslation();
  return (
    <Badge variant={active ? 'default' : 'secondary'} className="whitespace-nowrap">
      {active ? t('products.active') : t('products.disabled')}
    </Badge>
  );
}

/**
 * The catalogue page (Производи 2.0): a table from xl (sticky header and first
 * column, 13 px), one card per product below it (two columns from md). Only ONE
 * of the two is mounted. Rows show the name, SKU, kind, line, the VAT rate (owners
 * only, from Sigma), sale price in денари and the status — never a machine description.
 */
export function ProductsList(props: ProductsListProps) {
  const wide = useMinWidth(1280);
  return wide ? <ProductsTable {...props} /> : <ProductCards {...props} />;
}

function ProductsTable(p: ProductsListProps) {
  const { t } = useTranslation();
  const allOn = p.rows.length > 0 && p.rows.every((r) => p.selected.has(r.id));
  const someOn = !allOn && p.rows.some((r) => p.selected.has(r.id));
  const th = 'whitespace-nowrap px-2 py-2 text-left font-medium';
  return (
    <div className="relative max-h-[70vh] overflow-auto rounded-xl border bg-card shadow-sm">
      <table className="w-full text-[13px]">
        <caption className="sr-only">{t('nav.products')}</caption>
        <thead className="sticky top-0 z-20 bg-card text-[11px] text-muted-foreground shadow-[0_1px_0_hsl(var(--border))]">
          <tr>
            {p.canSetLine && (
              <th scope="col" className="w-9 py-2 pl-3">
                <Checkbox checked={allOn ? true : someOn ? 'indeterminate' : false}
                  onCheckedChange={(v) => p.onSelectShown(v === true)}
                  aria-label={t('products.bulk.selectAll')} />
              </th>
            )}
            <th scope="col" className={cn(th, 'sticky left-0 z-30 bg-card', !p.canSetLine && 'pl-3')}>{t('ordersPage.colProduct')}</th>
            <th scope="col" className={th}>{t('products.colKind')}</th>
            <th scope="col" className={th}>{t('products.colLine')}</th>
            {p.showVat && <th scope="col" className={th}>{t('products.colVat')}</th>}
            {p.showCost && <th scope="col" className={cn(th, 'text-right')}>{t('products.colCostPrice')}</th>}
            <th scope="col" className={cn(th, 'text-right')}>{t('products.colSellingPrice')}</th>
            <th scope="col" className={th}>{t('ordersPage.colStatus')}</th>
            <th scope="col" className="px-2 py-2 pr-3 text-right font-medium">{t('common.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <TableRow key={r.id} r={r} selected={p.selected.has(r.id)} busy={p.busyIds.has(r.id)}
              showCost={p.showCost} canEdit={p.canEdit} canSetLine={p.canSetLine} showVat={p.showVat} h={p.handlers} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RowProps extends RowFlags { r: ProductRow; selected: boolean; busy: boolean; h: RowHandlers }

const TableRow = memo(function TableRow({ r, selected, busy, showCost, canEdit, canSetLine, showVat, h }: RowProps) {
  const { t } = useTranslation();
  return (
    <tr data-product-row className={cn('border-t hover:bg-muted/30', selected && 'bg-muted/40')}>
      {canSetLine && (
        <td className="py-1.5 pl-3">
          <Checkbox checked={selected} onCheckedChange={() => h.onToggleSelect(r.id)}
            aria-label={t('products.bulk.selectRow', { name: r.name })} />
        </td>
      )}
      <th scope="row" className={cn('sticky left-0 z-10 w-full max-w-0 bg-card py-1.5 pr-2 text-left font-normal', !canSetLine && 'pl-3')}>
        <span className="flex min-w-[240px] items-center gap-2.5">
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <Package className="h-4 w-4 text-primary" />
          </span>
          <span className="min-w-0">
            <span className="block truncate font-medium text-card-foreground" title={r.name}>{r.name}</span>
            <span className="block truncate text-xs text-muted-foreground">{r.sku || '—'}</span>
          </span>
        </span>
      </th>
      <td className="px-2 py-1.5">
        <KindChip kind={kindOf(r)} name={r.name} editable={canSetLine} busy={busy} onPick={(k) => h.onSetKind(r, k)} />
      </td>
      <td className="px-2 py-1.5">
        <LineChip line={lineOf(r)} name={r.name} editable={canSetLine} busy={busy} onPick={(l) => h.onSetLine(r, l)} />
      </td>
      {showVat && (
        <td className="px-2 py-1.5">
          <VatChip p={r} editable={showVat} busy={busy} onPick={(v) => h.onSetVat(r, v)} />
        </td>
      )}
      {showCost && <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatMoney(r.cost_price || 0)}</td>}
      <td className="whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums text-primary">{formatMoney(r.price)}</td>
      <td className="px-2 py-1.5"><StatusBadge active={r.is_active} /></td>
      <td className="px-2 py-1 pr-3 text-right"><RowActions r={r} canEdit={canEdit} h={h} compact /></td>
    </tr>
  );
});

function ProductCards(p: ProductsListProps) {
  const { t } = useTranslation();
  return (
    <ul className="grid min-w-0 gap-3 md:grid-cols-2" aria-label={t('nav.products')}>
      {p.rows.map((r) => (
        <ProductCard key={r.id} r={r} selected={p.selected.has(r.id)} busy={p.busyIds.has(r.id)}
          showCost={p.showCost} canEdit={p.canEdit} canSetLine={p.canSetLine} showVat={p.showVat} h={p.handlers} />
      ))}
    </ul>
  );
}

const ProductCard = memo(function ProductCard({ r, selected, busy, showCost, canEdit, canSetLine, showVat, h }: RowProps) {
  const { t } = useTranslation();
  const fact = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
  return (
    <li data-product-row className={cn('min-w-0 space-y-3 rounded-xl border bg-card p-3 shadow-sm', selected && 'border-foreground/40 bg-muted/30')}>
      <div className="flex min-w-0 items-start gap-2.5">
        {canSetLine && (
          // A 36 px touch target around the 20 px box.
          <label className="-ml-1.5 -mt-1 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center">
            <Checkbox checked={selected} onCheckedChange={() => h.onToggleSelect(r.id)}
              aria-label={t('products.bulk.selectRow', { name: r.name })} className="h-5 w-5" />
          </label>
        )}
        <div className="min-w-0 flex-1">
          <p className="break-words font-medium leading-snug text-card-foreground">{r.name}</p>
          <p className="break-words text-xs text-muted-foreground">{r.sku || '—'}</p>
        </div>
        <StatusBadge active={r.is_active} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <KindChip kind={kindOf(r)} name={r.name} editable={canSetLine} busy={busy} onPick={(k) => h.onSetKind(r, k)} size="md" />
        <LineChip line={lineOf(r)} name={r.name} editable={canSetLine} busy={busy} onPick={(l) => h.onSetLine(r, l)} size="md" />
        {showVat && <VatChip p={r} editable={showVat} busy={busy} onPick={(v) => h.onSetVat(r, v)} size="md" />}
      </div>
      <dl className="grid grid-cols-2 gap-2 border-t pt-2">
        <div className="min-w-0">
          <dt className={fact}>{t('products.colSellingPrice')}</dt>
          <dd className="font-semibold tabular-nums text-primary">{formatMoney(r.price)}</dd>
        </div>
        {showCost && (
          <div className="min-w-0">
            <dt className={fact}>{t('products.colCostPrice')}</dt>
            <dd className="tabular-nums text-muted-foreground">{formatMoney(r.cost_price || 0)}</dd>
          </div>
        )}
      </dl>
      <div className="flex flex-wrap justify-end gap-2 border-t pt-2">
        <RowActions r={r} canEdit={canEdit} h={h} />
      </div>
    </li>
  );
});

function RowActions({ r, canEdit, h, compact }: { r: ProductRow; canEdit: boolean; h: RowHandlers; compact?: boolean }) {
  const { t } = useTranslation();
  if (compact) {
    return (
      <span className="inline-flex items-center justify-end gap-1">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => h.onLogs(r)}
          title={t('products.inventoryLogs')} aria-label={t('products.inventoryLogsOf', { name: r.name })}>
          <History className="h-4 w-4 text-muted-foreground" aria-hidden />
        </Button>
        {canEdit && (
          <>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => h.onEdit(r)}
              title={t('products.edit')} aria-label={t('products.editOf', { name: r.name })}>
              <Edit className="h-4 w-4 text-muted-foreground" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => h.onToggleActive(r)}
              title={r.is_active ? t('products.disable') : t('products.enable')}
              aria-label={r.is_active ? t('products.disable') : t('products.enable')}>
              <Power className={cn('h-4 w-4', r.is_active ? 'text-muted-foreground' : 'text-emerald-600')} aria-hidden />
            </Button>
          </>
        )}
      </span>
    );
  }
  return (
    <>
      <Button variant="outline" size="sm" className="h-9" onClick={() => h.onLogs(r)} aria-label={t('products.inventoryLogsOf', { name: r.name })}>
        <History className="mr-1.5 h-4 w-4" aria-hidden />{t('products.inventoryLogs')}
      </Button>
      {canEdit && (
        <>
          <Button variant="outline" size="sm" className="h-9" onClick={() => h.onEdit(r)} aria-label={t('products.editOf', { name: r.name })}>
            <Edit className="mr-1.5 h-4 w-4" aria-hidden />{t('products.edit')}
          </Button>
          <Button variant="outline" size="sm" className="h-9" onClick={() => h.onToggleActive(r)}>
            <Power className="mr-1.5 h-4 w-4" aria-hidden />{r.is_active ? t('products.disable') : t('products.enable')}
          </Button>
        </>
      )}
    </>
  );
}
