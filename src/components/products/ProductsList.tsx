import { Edit, History, Package, Power } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { formatMoney } from '@/lib/currency';
import { lineOf, type BrandLine } from '@/lib/products/brandLines';
import { LineChip } from './LineChip';

/** A row of GET /api/products (products.* + the supplier + suggested_price). */
export interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  price: number;
  cost_price: number;
  sku: string | null;
  stock_quantity: number;
  low_stock_threshold: number;
  days_of_supply_per_unit?: number;
  is_active: boolean;
  category: string;
  supplier_id: string | null;
  suppliers?: { id: string; name: string } | null;
  /** 20260943001300 — absent on an older api (= not yet decided). */
  brand_line?: BrandLine | null;
}

export interface ProductsListProps {
  rows: ProductRow[];
  /** Cost is admins only (the api strips it for everyone else). */
  showCost: boolean;
  /** Edit / enable / disable: admins and managers. */
  canEdit: boolean;
  /** Set lines and select rows: admins + owners. */
  canSetLine: boolean;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  /** Select (true) or unselect (false) every shown row. */
  onSelectShown: (on: boolean) => void;
  busyIds: ReadonlySet<string>;
  onSetLine: (p: ProductRow, line: BrandLine | null) => void;
  onEdit: (p: ProductRow) => void;
  onToggleActive: (p: ProductRow) => void;
  onLogs: (p: ProductRow) => void;
}

function StockBadge({ qty, threshold }: { qty: number; threshold: number }) {
  const { t } = useTranslation();
  if (qty <= 0) return <Badge variant="destructive">{t('products.outOfStock')}</Badge>;
  if (qty < threshold) return <Badge variant="destructive">{qty}</Badge>;
  if (qty === threshold) return <Badge className="bg-accent text-accent-foreground border-accent">{qty}</Badge>;
  return <Badge className="bg-primary text-primary-foreground">{qty}</Badge>;
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
 * The catalogue: a table from xl (sticky header and first column, 13 px), one
 * card per product below it (two columns from md). Below xl the sidebar leaves
 * too little room for nine columns, and the page must never scroll sideways.
 * Both carry the same facts and controls.
 */
export function ProductsList(props: ProductsListProps) {
  const { t } = useTranslation();
  return (
    <>
      <ProductsTable {...props} />
      <ul className="grid min-w-0 gap-3 md:grid-cols-2 xl:hidden" aria-label={t('nav.products')}>
        {props.rows.map((p) => <ProductCard key={p.id} p={p} {...props} />)}
      </ul>
    </>
  );
}

function ProductsTable(p: ProductsListProps) {
  const { t } = useTranslation();
  const allOn = p.rows.length > 0 && p.rows.every((r) => p.selected.has(r.id));
  const someOn = !allOn && p.rows.some((r) => p.selected.has(r.id));
  const th = 'whitespace-nowrap px-2 py-2 text-left font-medium';
  return (
    <div className="relative hidden max-h-[70vh] overflow-auto rounded-xl border bg-card shadow-sm xl:block">
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
            <th scope="col" className={th}>{t('products.colLine')}</th>
            {p.showCost && <th scope="col" className={cn(th, 'text-right')}>{t('products.colCostPrice')}</th>}
            <th scope="col" className={cn(th, 'text-right')}>{t('products.colSellingPrice')}</th>
            <th scope="col" className={th}>{t('products.colStock')}</th>
            <th scope="col" className={th}>{t('ordersPage.colStatus')}</th>
            <th scope="col" className="px-2 py-2 pr-3 text-right font-medium">{t('common.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <tr key={r.id} className={cn('border-t hover:bg-muted/30', p.selected.has(r.id) && 'bg-muted/40')}>
              {p.canSetLine && (
                <td className="py-1.5 pl-3">
                  <Checkbox checked={p.selected.has(r.id)} onCheckedChange={() => p.onToggleSelect(r.id)}
                    aria-label={t('products.bulk.selectRow', { name: r.name })} />
                </td>
              )}
              <th scope="row" className={cn('sticky left-0 z-10 w-full max-w-0 bg-card py-1.5 pr-2 text-left font-normal', !p.canSetLine && 'pl-3')}>
                {/* name, then SKU · category · supplier · description — one line each, the rest in the title */}
                <span className="flex min-w-[220px] items-center gap-2.5">
                  <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Package className="h-4 w-4 text-primary" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-card-foreground" title={r.name}>{r.name}</span>
                    <ProductFacts r={r} className="block truncate text-xs text-muted-foreground" />
                  </span>
                </span>
              </th>
              <td className="px-2 py-1.5">
                <LineChip line={lineOf(r)} name={r.name} editable={p.canSetLine} busy={p.busyIds.has(r.id)}
                  onPick={(l) => p.onSetLine(r, l)} />
              </td>
              {p.showCost &&<td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatMoney(r.cost_price || 0)}</td>}
              <td className="whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums text-primary">{formatMoney(r.price)}</td>
              <td className="px-2 py-1.5"><StockBadge qty={r.stock_quantity} threshold={r.low_stock_threshold} /></td>
              <td className="px-2 py-1.5"><StatusBadge active={r.is_active} /></td>
              <td className="px-2 py-1 pr-3 text-right"><RowActions r={r} {...p} compact /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** SKU · category · supplier · description on one line (the table's second line). */
function ProductFacts({ r, className }: { r: ProductRow; className?: string }) {
  const { t } = useTranslation();
  const text = [r.sku, r.category, r.suppliers?.name, r.description].filter(Boolean).join(' · ') || t('products.noDescription');
  return <span className={className} title={text}>{text}</span>;
}

function ProductCard({ p: r, ...p }: ProductsListProps & { p: ProductRow }) {
  const { t } = useTranslation();
  const fact = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
  return (
    <li className={cn('min-w-0 space-y-3 rounded-xl border bg-card p-3 shadow-sm', p.selected.has(r.id) && 'border-foreground/40 bg-muted/30')}>
      <div className="flex min-w-0 items-start gap-2.5">
        {p.canSetLine && (
          // A 36 px touch target around the 20 px box (a click on the label toggles it).
          <label className="-ml-1.5 -mt-1 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center">
            <Checkbox checked={p.selected.has(r.id)} onCheckedChange={() => p.onToggleSelect(r.id)}
              aria-label={t('products.bulk.selectRow', { name: r.name })} className="h-5 w-5" />
          </label>
        )}
        <div className="min-w-0 flex-1">
          <p className="break-words font-medium leading-snug text-card-foreground">{r.name}</p>
          <p className="break-words text-xs text-muted-foreground">
            {[r.sku, r.category].filter(Boolean).join(' · ') || '—'}
          </p>
          {r.description && <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">{r.description}</p>}
        </div>
        <StatusBadge active={r.is_active} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className={fact}>{t('products.colLine')}</span>
        <LineChip line={lineOf(r)} name={r.name} editable={p.canSetLine} busy={p.busyIds.has(r.id)}
          onPick={(l) => p.onSetLine(r, l)} size="md" />
      </div>
      <dl className="grid grid-cols-2 gap-2 border-t pt-2 sm:grid-cols-4">
        <div className="min-w-0">
          <dt className={fact}>{t('products.colSellingPrice')}</dt>
          <dd className="font-semibold tabular-nums text-primary">{formatMoney(r.price)}</dd>
        </div>
        {p.showCost && (
          <div className="min-w-0">
            <dt className={fact}>{t('products.colCostPrice')}</dt>
            <dd className="tabular-nums text-muted-foreground">{formatMoney(r.cost_price || 0)}</dd>
          </div>
        )}
        <div className="min-w-0">
          <dt className={fact}>{t('products.colStock')}</dt>
          <dd><StockBadge qty={r.stock_quantity} threshold={r.low_stock_threshold} /></dd>
        </div>
        <div className="min-w-0">
          <dt className={fact}>{t('products.colSupplier')}</dt>
          <dd className="truncate text-xs text-muted-foreground" title={r.suppliers?.name || undefined}>{r.suppliers?.name || '—'}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap justify-end gap-2 border-t pt-2">
        <RowActions r={r} {...p} />
      </div>
    </li>
  );
}

function RowActions({ r, canEdit, onEdit, onToggleActive, onLogs, compact }: ProductsListProps & { r: ProductRow; compact?: boolean }) {
  const { t } = useTranslation();
  if (compact) {
    return (
      <span className="inline-flex items-center justify-end gap-1">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onLogs(r)}
          title={t('products.inventoryLogs')} aria-label={t('products.inventoryLogsOf', { name: r.name })}>
          <History className="h-4 w-4 text-muted-foreground" aria-hidden />
        </Button>
        {canEdit && (
          <>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onEdit(r)}
              title={t('products.edit')} aria-label={t('products.editOf', { name: r.name })}>
              <Edit className="h-4 w-4 text-muted-foreground" aria-hidden />
            </Button>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => onToggleActive(r)}
              title={r.is_active ? t('products.disable') : t('products.enable')}
              aria-label={r.is_active ? t('products.disable') : t('products.enable')}>
              <Power className={cn('h-4 w-4', r.is_active ? 'text-muted-foreground' : 'text-emerald-600')} aria-hidden />
            </Button>
          </>
        )}
      </span>
    );
  }
  // A card: 36 px buttons with words (touch).
  return (
    <>
      <Button variant="outline" size="sm" className="h-9" onClick={() => onLogs(r)} aria-label={t('products.inventoryLogsOf', { name: r.name })}>
        <History className="mr-1.5 h-4 w-4" aria-hidden />{t('products.inventoryLogs')}
      </Button>
      {canEdit && (
        <>
          <Button variant="outline" size="sm" className="h-9" onClick={() => onEdit(r)} aria-label={t('products.editOf', { name: r.name })}>
            <Edit className="mr-1.5 h-4 w-4" aria-hidden />{t('products.edit')}
          </Button>
          <Button variant="outline" size="sm" className="h-9" onClick={() => onToggleActive(r)}>
            <Power className="mr-1.5 h-4 w-4" aria-hidden />{r.is_active ? t('products.disable') : t('products.enable')}
          </Button>
        </>
      )}
    </>
  );
}
