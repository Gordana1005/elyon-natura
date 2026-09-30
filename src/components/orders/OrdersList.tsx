import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreVertical, Truck, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { StatusBadge } from '@/components/StatusBadge';
import { ActiveViewChip } from '@/components/ActiveViewBadge';
import { sourceColorVar } from '@/components/insights/overview/palette';
import { departmentLabel } from '@/lib/orderSource';
import type { ActiveViewsByPhone } from '@/lib/api';
import { MEX_TONE_CLASS, mexBadge, orderValue, rowInstant, skopjeDayTime } from '@/lib/ordersList/rowModel';
import type { ApiOrder } from './types';

export interface RowAction { key: string; label: string; icon: LucideIcon; onClick: () => void; disabled?: boolean }

export interface OrdersListProps {
  orders: ApiOrder[];
  selected: ReadonlyMap<string, unknown>;
  onToggleSelect: (o: ApiOrder) => void;
  onToggleAll: () => void;
  onOpen: (o: ApiOrder) => void;
  expanded: ReadonlySet<string>;
  /** The expanded panel's content (address, reasons, calls). */
  renderDetails: (o: ApiOrder) => ReactNode;
  actions: (o: ApiOrder) => RowAction[];
  /** Product line + (cancel / trash / return) reason line. */
  productParts: (o: ApiOrder) => { product: string; reason: string | null };
  views: ActiveViewsByPhone;
  currentUserId?: string;
  dupCount: (phone: string) => number;
  onSearch: (text: string) => void;
}

const last8 = (p: string | null | undefined) => {
  const d = (p ?? '').replace(/\D/g, '');
  return d.length >= 8 ? d.slice(-8) : '';
};

/**
 * The orders: a table from md (columns join as the screen widens — products at
 * lg, department / seller and MEX at xl, the assignee at 2xl — so it never
 * scrolls sideways) and compact cards below md. A row or card opens the order;
 * the checkbox and the ⋮ menu do not.
 */
export function OrdersList(p: OrdersListProps) {
  const { t } = useTranslation();
  return (
    <>
      <OrdersTable {...p} />
      <ul className="space-y-2 md:hidden" aria-label={t('nav.orders')}>
        {p.orders.map((o) => <OrderCard key={o.id} o={o} {...p} />)}
      </ul>
    </>
  );
}

/** How many columns the table shows at the current width (md 6 · lg +products ·
 *  xl +department · 2xl +MEX +assigned) — the details row must span exactly
 *  these: a larger colSpan adds phantom columns that squeeze a fixed layout. */
const COL_QUERIES = ['(min-width: 1024px)', '(min-width: 1280px)', '(min-width: 1536px)'] as const;
function useVisibleCols(): number {
  const read = () => {
    if (typeof window === 'undefined' || !window.matchMedia) return 6;
    const [lg, xl, xxl] = COL_QUERIES.map((q) => window.matchMedia(q).matches);
    return 6 + (lg ? 1 : 0) + (xl ? 1 : 0) + (xxl ? 2 : 0);
  };
  const [cols, setCols] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mqs = COL_QUERIES.map((q) => window.matchMedia(q));
    const on = () => setCols(read());
    mqs.forEach((m) => m.addEventListener?.('change', on));
    return () => mqs.forEach((m) => m.removeEventListener?.('change', on));
  }, []);
  return cols;
}

function OrdersTable(p: OrdersListProps) {
  const { t } = useTranslation();
  const cols = useVisibleCols();
  const all = p.orders.length > 0 && p.orders.every((o) => p.selected.has(o.id));
  const some = p.orders.some((o) => p.selected.has(o.id));
  const th = 'px-2 py-2 text-left align-bottom font-medium';
  // table-fixed: the fixed columns take their width, customer + products share
  // the rest, and nothing can push the table past its card (long names wrap,
  // long tracking ids break). Columns join as the screen widens.
  return (
    <div className="hidden min-w-0 overflow-hidden rounded-xl border bg-card shadow-sm md:block">
      <table className="w-full table-fixed text-[13px]">
        <caption className="sr-only">{t('nav.orders')}</caption>
        <thead className="bg-muted/40 text-[11px] text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="w-10 py-2 pl-3 pr-1 align-bottom">
              <Checkbox checked={all ? true : some ? 'indeterminate' : false} onCheckedChange={p.onToggleAll} aria-label={t('ordersPage.selectAllOrders')} />
            </th>
            <th scope="col" className={cn(th, 'w-[124px]')}>{t('ordersList.col.order')}</th>
            <th scope="col" className={th}>{t('ordersList.col.customer')}</th>
            <th scope="col" className={cn(th, 'hidden lg:table-cell')}>{t('ordersList.col.products')}</th>
            <th scope="col" className={cn(th, 'w-[96px] text-right')}>{t('ordersList.col.value')}</th>
            <th scope="col" className={cn(th, 'hidden w-[156px] xl:table-cell')}>{t('ordersList.col.department')}</th>
            <th scope="col" className={cn(th, 'w-[140px]')}>{t('ordersList.col.status')}</th>
            <th scope="col" className={cn(th, 'hidden w-[176px] 2xl:table-cell')}>{t('ordersList.col.mex')}</th>
            <th scope="col" className={cn(th, 'hidden w-[136px] 2xl:table-cell')}>{t('ordersList.col.assigned')}</th>
            <th scope="col" className="w-12 py-2 pr-2"><span className="sr-only">{t('common.actions')}</span></th>
          </tr>
        </thead>
        <tbody>
          {p.orders.map((o) => {
            const open = p.expanded.has(o.id);
            const { product, reason } = p.productParts(o);
            return (
              <Fragment key={o.id}>
                <tr className={cn('cursor-pointer border-b align-top transition-colors last:border-0 hover:bg-muted/30', p.selected.has(o.id) && 'bg-primary/5')}
                  onClick={() => p.onOpen(o)} data-testid="order-row">
                  <td className="py-2.5 pl-3 pr-1" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={p.selected.has(o.id)} onCheckedChange={() => p.onToggleSelect(o)}
                      aria-label={t('ordersPage.selectOrderForExport', { id: o.display_id })} />
                  </td>
                  <td className="px-2 py-2.5">
                    <OrderIdCell o={o} p={p} />
                    <div className="mt-1 xl:hidden"><DeptLine o={o} /></div>
                  </td>
                  <td className="min-w-0 px-2 py-2.5">
                    <CustomerCell o={o} p={p} />
                    <div className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground lg:hidden">{product}</div>
                  </td>
                  <td className="hidden px-2 py-2.5 lg:table-cell">
                    <div className="line-clamp-3 break-words">{product}</div>
                    {reason && <div className="mt-0.5 line-clamp-2 break-words text-xs leading-snug text-muted-foreground">{reason}</div>}
                  </td>
                  <td className="px-2 py-2.5 text-right"><ValueCell o={o} /></td>
                  <td className="hidden px-2 py-2.5 xl:table-cell">
                    <DeptLine o={o} />
                    <SellerLine o={o} />
                    <div className="2xl:hidden"><AssignedLine o={o} /></div>
                  </td>
                  <td className="px-2 py-2.5">
                    <StatusBadge status={o.status} order={o} className="max-w-full whitespace-normal" />
                    <div className="mt-1 2xl:hidden"><MexBadge o={o} withTracking /></div>
                  </td>
                  <td className="hidden px-2 py-2.5 2xl:table-cell"><MexBadge o={o} withTracking /></td>
                  <td className="hidden break-words px-2 py-2.5 text-xs 2xl:table-cell">{o.assigned_agent_name || <span className="text-muted-foreground">{t('ordersList.unassigned')}</span>}</td>
                  <td className="py-2 pr-2" onClick={(e) => e.stopPropagation()}><RowMenu o={o} actions={p.actions(o)} /></td>
                </tr>
                {open && (
                  <tr className="border-b bg-muted/30">
                    <td colSpan={cols} className="p-0">{p.renderDetails(o)}</td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function OrderCard({ o, ...p }: OrdersListProps & { o: ApiOrder }) {
  const { t } = useTranslation();
  const { product } = p.productParts(o);
  const when = skopjeDayTime(rowInstant(o));
  const open = p.expanded.has(o.id);
  return (
    <li
      className={cn('min-w-0 cursor-pointer rounded-xl border bg-card p-3 shadow-sm transition-colors active:bg-muted/40', p.selected.has(o.id) && 'border-primary/50 bg-primary/5')}
      onClick={() => p.onOpen(o)}
      data-testid="order-card"
    >
      {/* head: select · status + department · ⋮ — the body below uses the full width */}
      <div className="flex min-w-0 items-center gap-2">
        <div className="-m-2 p-2" onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={p.selected.has(o.id)} onCheckedChange={() => p.onToggleSelect(o)}
            aria-label={t('ordersPage.selectOrderForExport', { id: o.display_id })} className="h-5 w-5" />
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <StatusBadge status={o.status} order={o} />
          <DeptLine o={o} compact />
        </div>
        <div className="-my-1.5 -mr-1.5" onClick={(e) => e.stopPropagation()}><RowMenu o={o} actions={p.actions(o)} /></div>
      </div>
      <div className="mt-1.5 min-w-0 space-y-1">
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <button type="button" className="min-w-0 break-words text-left text-sm font-semibold leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(e) => { e.stopPropagation(); p.onOpen(o); }} aria-label={t('ordersList.openOrder', { id: o.display_id })}>
              {o.customer_name || '—'}
            </button>
            <span className="shrink-0 text-sm font-semibold tabular-nums"><ValueCell o={o} bare /></span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="font-mono">{o.customer_phone}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{o.display_id}</span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{when.day.slice(0, 5)} {when.time}</span>
          </div>
          {product && product !== '—' && <div className="line-clamp-1 break-words text-xs">{product}</div>}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <MexBadge o={o} withTracking inline />
            <ViewAndDup o={o} p={p} />
          </div>
      </div>
      {open && <div className="mt-2 border-t pt-2" onClick={(e) => e.stopPropagation()}>{p.renderDetails(o)}</div>}
    </li>
  );
}

// ── cells ───────────────────────────────────────────────────────────────────

function OrderIdCell({ o, p }: { o: ApiOrder; p: OrdersListProps }) {
  const { t } = useTranslation();
  const when = skopjeDayTime(rowInstant(o));
  return (
    <div className="min-w-0">
      <button type="button" className="rounded-sm font-mono text-xs font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(e) => { e.stopPropagation(); p.onOpen(o); }} aria-label={t('ordersList.openOrder', { id: o.display_id })}>
        {o.display_id}
      </button>
      <div className="flex flex-wrap gap-x-1 text-[11px] tabular-nums text-muted-foreground">
        <span>{when.day}</span><span className="text-muted-foreground/70">{when.time}</span>
      </div>
      {o.duplicated_from && (
        <button type="button" className="mt-0.5 block max-w-full break-words rounded border border-indigo-400 px-1 text-left text-[10px] leading-tight text-indigo-600 dark:text-indigo-400"
          onClick={(e) => { e.stopPropagation(); if (o.duplicated_from_display) p.onSearch(o.duplicated_from_display); }}>
          {t('ordersPage.duplicateOf', { id: o.duplicated_from_display || '?' })}
        </button>
      )}
    </div>
  );
}

function CustomerCell({ o, p }: { o: ApiOrder; p: OrdersListProps }) {
  return (
    <div className="min-w-0">
      <div className="break-words font-medium leading-snug">{o.customer_name || '—'}</div>
      <div className="break-all font-mono text-[11px] text-muted-foreground">{o.customer_phone}</div>
      <div className="mt-0.5 flex flex-wrap gap-1 empty:hidden"><ViewAndDup o={o} p={p} /></div>
    </div>
  );
}

function ViewAndDup({ o, p }: { o: ApiOrder; p: OrdersListProps }) {
  const { t } = useTranslation();
  const n = p.dupCount(o.customer_phone);
  const view = p.views[last8(o.customer_phone)];
  return (
    <>
      {n > 1 && (
        <button type="button" className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground"
          title={t('ordersPage.viewDuplicates')}
          onClick={(e) => { e.stopPropagation(); p.onSearch(o.customer_phone); }}>
          {n}×
        </button>
      )}
      {view && view.agent_id !== p.currentUserId && <ActiveViewChip view={view} />}
    </>
  );
}

function ValueCell({ o, bare }: { o: ApiOrder; bare?: boolean }) {
  const { t } = useTranslation();
  const v = orderValue(o);
  return (
    <span className={cn('tabular-nums', !bare && 'font-semibold')} title={v.fromParcel ? t('ordersList.value.cod') : t('ordersList.value.price')}>
      {v.text}
    </span>
  );
}

export function DeptLine({ o, compact }: { o: Pick<ApiOrder, 'department'>; compact?: boolean }) {
  const { t } = useTranslation();
  const label = departmentLabel(t, o.department);
  if (!label) return null;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-xs', compact ? 'rounded-full border px-2 py-0.5' : '')}>
      <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: sourceColorVar(o.department!) }} aria-hidden />
      <span className="min-w-0 break-words leading-tight">{label}</span>
    </span>
  );
}

function SellerLine({ o }: { o: ApiOrder }) {
  const { t } = useTranslation();
  const seller = o.seller_name || o.confirmed_by_name || null;
  return (
    <div className="mt-0.5 break-words text-xs text-muted-foreground" title={t('ordersPage.confirmedByTitle')}>
      {seller ? t('ordersList.seller.chip', { name: seller }) : t('ordersList.noSeller')}
    </div>
  );
}

function AssignedLine({ o }: { o: ApiOrder }) {
  const { t } = useTranslation();
  return (
    <div className="break-words text-[11px] text-muted-foreground">
      {o.assigned_agent_name ? t('ordersList.agent.chip', { name: o.assigned_agent_name }) : t('ordersList.unassigned')}
    </div>
  );
}

/** The parcel as MEX sees it: status (a word + a tone) and the tracking id —
 *  under the badge, or beside it (`inline`, the phone card). */
export function MexBadge({ o, withTracking, inline }: { o: ApiOrder; withTracking?: boolean; inline?: boolean }) {
  const { t } = useTranslation();
  const b = mexBadge(o);
  if (b.group === 'no_parcel') {
    return <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]', MEX_TONE_CLASS.none)}>{t('ordersList.mex.noParcelShort')}</span>;
  }
  const name = b.statusId != null
    ? t(`customer360.mexStatus.${b.statusId}`, { defaultValue: t('ordersList.mex.unknown', { id: b.statusId }) })
    : t('ordersList.mex.unknown', { id: '?' });
  return (
    <span className={cn('inline-flex min-w-0 max-w-full gap-0.5', inline ? 'flex-wrap items-center gap-x-1.5' : 'flex-col items-start')}>
      <span className={cn('inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-tight', MEX_TONE_CLASS[b.tone])}
        title={t('ordersList.mex.title', { status: name })}>
        <Truck className="h-3 w-3 shrink-0" aria-hidden />
        <span className="break-words">{name}</span>
      </span>
      {withTracking && o.mex_tracking_id && (
        <span className="break-all font-mono text-[10px] leading-tight text-muted-foreground">{o.mex_tracking_id}</span>
      )}
    </span>
  );
}

function RowMenu({ o, actions }: { o: ApiOrder; actions: RowAction[] }) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9 md:h-8 md:w-8" aria-label={t('ordersList.rowActions', { id: o.display_id })}>
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {actions.map((a) => (
          <DropdownMenuItem key={a.key} disabled={a.disabled} onClick={a.onClick}>
            <a.icon className="mr-2 h-3.5 w-3.5" /> {a.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
