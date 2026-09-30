import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Phone, UserX } from 'lucide-react';
import { SmartPagination } from '@/components/SmartPagination';
import { formatMoney } from '@/lib/currency';
import { formatDate } from '@/i18n/dates';
import { departmentLabel } from '@/lib/orderSource';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/EmptyState';
import { MobileCard, MobileCardField } from '@/components/ui/mobile-card';
import { CardHead, ResponsivePager } from './parts';

export interface SegmentMember {
  list_id: string;
  customer_phone: string;
  customer_name: string;
  product_name?: string | null;
  trigger_order_id?: string | null;
  /** Reason the customer's newest order was trashed (Trash List only). Keyed to
   *  the trashReason.* i18n labels; null on non-trash lists. */
  trigger_trash_reason?: string | null;
  trigger_event_at: string;
  trigger_price: number;
  last_paid_at?: string | null;
  paid_count: number;
  lifetime_value: number;
  avg_package_price?: number | null;   // NEW: first-class after priority migration (lifetime / paid_count)
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  assigned_at?: string | null;
  last_call_at: string | null;
  last_call_outcome: string | null;
  in_call_again_until?: string | null;
  is_completed: boolean;
  /** Server-enriched from call_logs (latest REAL call by last-8 phone match).
   *  The member-row stamp above only covers queue/no-answer flows — calls made
   *  via order confirmation or standalone dialing exist only in call_logs. */
  real_last_call_at?: string | null;
  real_last_call_outcome?: string | null;
  real_last_call_connection?: string | null;
  /** The buyer's department (the Assigner's lists by department); absent on older api builds. */
  department?: string | null;
}

/** Newer of member-row stamp vs latest real call_logs row. Outcome falls back
 *  to the connection state when the log outcome is missing or the neutral
 *  'answered'. Old API payloads (no real_* fields) degrade to the stamp. */
function effectiveLastCall(m: SegmentMember): { at: string | null; outcome: string | null } {
  const stampAt = m.last_call_at ? new Date(m.last_call_at).getTime() : 0;
  const realAt = m.real_last_call_at ? new Date(m.real_last_call_at).getTime() : 0;
  if (realAt > stampAt) {
    const outcome = (m.real_last_call_outcome && m.real_last_call_outcome !== 'answered')
      ? m.real_last_call_outcome
      : (m.real_last_call_connection || m.real_last_call_outcome || null);
    return { at: m.real_last_call_at ?? null, outcome };
  }
  return { at: m.last_call_at, outcome: m.last_call_outcome };
}

interface Props {
  members: SegmentMember[];
  /** Keys are customer_phone (within one list) — selection is per current list. */
  isSelected: (phone: string) => boolean;
  onToggle: (m: SegmentMember) => void;
  onToggleAll: () => void;
  allOnPageSelected: boolean;
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
  /** Compact paddings for the inline (Assigner) variant. */
  compact?: boolean;
  /** Optional: if provided, render a one-click unassign button per row (for the inspector "per-agent" view). */
  onUnassignSingle?: (m: SegmentMember) => void | Promise<void>;
  /** Hide selection checkboxes + row-click selection (read-only view, e.g. the
   *  informational "Trash List" which is never distributed). Defaults to true. */
  selectable?: boolean;
  /** Show the buyer-department column. Default: when any member carries one. */
  showDepartment?: boolean;
  /** Below this width the rows are cards (no sideways-scrolling table). The
   *  Assigner uses 'xl': its expanded list card is too narrow for 10 columns before that. */
  cardsBelow?: 'md' | 'xl' | '2xl';
}

export function SegmentMemberTable({
  members, isSelected, onToggle, onToggleAll, allOnPageSelected,
  page, totalPages, onPageChange, loading, compact, onUnassignSingle,
  selectable = true, showDepartment, cardsBelow = 'md',
}: Props) {
  const { t } = useTranslation();
  const pad = compact ? 'px-2 py-1.5' : 'px-3 py-2';
  // Only show the Product column when this list actually carries products
  // (e.g. the static "Cancelled Pendings" list). Rule-driven lists leave it null.
  const showProduct = members.some(m => m.product_name);
  // Only show the Reason column on the Trash List (members carry a trash reason).
  const showReason = members.some(m => m.trigger_trash_reason);
  const hasUnassign = !!onUnassignSingle;
  const showDept = showDepartment ?? members.some(m => m.department);
  const deptText = (d: string | null | undefined) => departmentLabel(t, d) ?? t('assigner.dept.unknown');
  const colCount = (showProduct ? 10 : 9) + (showReason ? 1 : 0) + (hasUnassign ? 1 : 0) + (showDept ? 1 : 0) - (selectable ? 0 : 1);
  return (
    <div className="space-y-2">
      {/* Desktop: table */}
      <div className={cn('hidden rounded-xl border bg-card overflow-x-auto', cardsBelow === '2xl' ? '2xl:block' : cardsBelow === 'xl' ? 'xl:block' : 'md:block')}>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-xs text-muted-foreground">
              {selectable && (
                <th className={cn(pad, 'w-8')}>
                  <Checkbox checked={allOnPageSelected} onCheckedChange={onToggleAll} aria-label={t('missedCalls.selectAll')} />
                </th>
              )}
              <th className={cn(pad, 'text-left font-medium')}>{t('ordersPage.colCustomer')}</th>
              <th className={cn(pad, 'text-left font-medium')}>{t('search.phone')}</th>
              {showProduct && <th className={cn(pad, 'text-left font-medium')}>{t('ordersPage.colProduct')}</th>}
              {showReason && <th className={cn(pad, 'text-left font-medium')}>{t('segTable.reason')}</th>}
              {showDept && <th className={cn(pad, 'text-left font-medium')}>{t('assigner.col.department')}</th>}
              <th className={cn(pad, 'text-right font-medium')}>{t('segTable.lastOrder')}</th>
              <th className={cn(pad, 'text-right font-medium')}>{t('search.totalOrders')}</th>
              <th className={cn(pad, 'text-right font-medium')}>{t('clientProfile.metricAvgPkg')}</th>
              <th className={cn(pad, 'text-right font-medium')}>{t('segTable.totalSpend')}</th>
              <th className={cn(pad, 'text-left font-medium')}>{t('predLists.colAssigned')}</th>
              <th className={cn(pad, 'text-left font-medium')}>{t('segTable.lastCall')}</th>
              {hasUnassign && <th className={cn(pad, 'w-10 text-center font-medium')}>{t('assigner.colAction')}</th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={colCount} className="text-center text-muted-foreground py-10">{t('common.loading')}</td></tr>
            ) : members.length === 0 ? (
              <tr>
                <td colSpan={colCount} className="p-0">
                  <EmptyState
                    icon={<Phone className="h-5 w-5" />}
                    title={t('segTable.noMembers')}
                    description={t('segTable.adjustFilters')}
                    size="sm"
                    className="border-0 bg-transparent hover:shadow-none py-8"
                  />
                </td>
              </tr>
            ) : members.map(m => {
              const sel = isSelected(m.customer_phone);
              return (
                <tr
                  key={m.customer_phone}
                  className={cn('border-b last:border-0 hover:bg-muted/30', selectable && 'cursor-pointer', sel && 'bg-primary/5')}
                  onClick={selectable ? () => onToggle(m) : undefined}
                >
                  {selectable && (
                    <td className={pad} onClick={e => e.stopPropagation()}>
                      <Checkbox checked={sel} onCheckedChange={() => onToggle(m)} />
                    </td>
                  )}
                  <td className={cn(pad, 'font-medium')}>
                    {m.customer_name || '—'}
                    {m.is_completed && <Badge variant="secondary" className="ml-2 text-[9px]">{t('segTable.done')}</Badge>}
                  </td>
                  <td className={cn(pad, 'font-mono text-xs')}>
                    <a href={`tel:${m.customer_phone}`} onClick={e => e.stopPropagation()} className="inline-flex items-center gap-1 text-primary hover:underline">
                      <Phone className="h-3 w-3" />{m.customer_phone}
                    </a>
                  </td>
                  {showProduct && (
                    <td className={cn(pad, 'text-xs max-w-[200px] truncate')} title={m.product_name || ''}>
                      {m.product_name || <span className="text-muted-foreground/40">—</span>}
                    </td>
                  )}
                  {showReason && (
                    <td className={cn(pad, 'text-xs')}>
                      {m.trigger_trash_reason ? (
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {t(`trashReason.${m.trigger_trash_reason}`, { defaultValue: m.trigger_trash_reason.replace(/_/g, ' ') })}
                        </Badge>
                      ) : <span className="text-muted-foreground/40">—</span>}
                    </td>
                  )}
                  {showDept && (
                    <td className={cn(pad, 'text-xs whitespace-nowrap')}>{deptText(m.department)}</td>
                  )}
                  <td className={cn(pad, 'text-right text-xs leading-tight')}>
                    <div className="font-mono font-semibold">{formatMoney(m.trigger_price)}</div>
                    <div className="text-[10px] text-muted-foreground">{m.trigger_event_at ? formatDate(m.trigger_event_at, 'dd MMM yy') : ''}</div>
                  </td>
                  <td className={cn(pad, 'text-right tabular-nums text-xs')}>{m.paid_count}</td>
                  <td className={cn(pad, 'text-right text-xs leading-tight')}>
                    {m.avg_package_price != null ? (
                      <>
                        <div className="font-semibold">{formatMoney(m.avg_package_price)}</div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className={cn(pad, 'text-right text-xs leading-tight')}>
                    <div className="font-semibold">{formatMoney(m.lifetime_value)}</div>
                  </td>
                  <td className={cn(pad, 'text-xs')}>
                    {m.assigned_agent_name ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary">
                          {m.assigned_agent_name.charAt(0).toUpperCase()}
                        </span>
                        {m.assigned_agent_name}
                      </span>
                    ) : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className={cn(pad, 'text-xs')}>
                    {(() => {
                      const lc = effectiveLastCall(m);
                      return lc.at ? (
                        <div className="leading-tight">
                          <div>{formatDate(lc.at, 'dd MMM HH:mm')}</div>
                          {lc.outcome && <div className="text-[10px] text-muted-foreground">{t(`outcome.${lc.outcome}`, { defaultValue: lc.outcome.replace(/_/g, ' ') })}</div>}
                        </div>
                      ) : <span className="text-muted-foreground">{t('segTable.never')}</span>;
                    })()}
                  </td>
                  {hasUnassign && (
                    <td className={cn(pad, 'text-center')} onClick={e => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-rose-600 hover:bg-rose-100 hover:text-rose-700"
                        onClick={() => onUnassignSingle?.(m)}
                        title={t('segTable.unassignTitle')}
                        disabled={!m.assigned_agent_id}
                      >
                        <UserX className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Cards — mobile */}
      <div className={cn('grid gap-2', cardsBelow === '2xl' ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:hidden' : cardsBelow === 'xl' ? 'grid-cols-1 sm:grid-cols-2 xl:hidden' : 'grid-cols-1 md:hidden')}>
        {loading ? (
          <div className="text-center text-muted-foreground py-10">{t('common.loading')}</div>
        ) : members.length === 0 ? (
          <EmptyState icon={<Phone className="h-5 w-5" />} title={t('segTable.noMembers')} description={t('segTable.adjustFilters')} size="sm" />
        ) : members.map(m => {
          const sel = isSelected(m.customer_phone);
          return (
            <MobileCard key={m.customer_phone} className={cn(sel && 'ring-1 ring-primary')} onClick={selectable ? () => onToggle(m) : undefined}>
              <div className="flex items-start gap-2">
                {selectable && <Checkbox className="mt-1 shrink-0" checked={sel} onCheckedChange={() => onToggle(m)} onClick={e => e.stopPropagation()} />}
                <CardHead
                  title={m.customer_name || '—'}
                  badges={<>
                    {m.is_completed && <Badge variant="secondary" className="text-[9px]">{t('segTable.done')}</Badge>}
                    {m.assigned_agent_name && <Badge variant="outline" className="max-w-full text-[10px] font-normal"><span className="truncate">{m.assigned_agent_name}</span></Badge>}
                  </>}
                  sub={<a href={`tel:${m.customer_phone}`} onClick={e => e.stopPropagation()} className="inline-flex min-h-6 items-center gap-1 text-primary hover:underline"><Phone className="h-3 w-3" />{m.customer_phone}</a>}
                />
              </div>
              {showProduct && <MobileCardField label={t('ordersPage.colProduct')} value={m.product_name || '—'} />}
              {showReason && (
                <MobileCardField
                  label={t('segTable.reason')}
                  value={m.trigger_trash_reason
                    ? t(`trashReason.${m.trigger_trash_reason}`, { defaultValue: m.trigger_trash_reason.replace(/_/g, ' ') })
                    : '—'}
                />
              )}
              <MobileCardField
                label={t('segTable.lastOrder')}
                value={<>{formatMoney(m.trigger_price)}{m.trigger_event_at ? <span className="text-muted-foreground font-normal"> · {formatDate(m.trigger_event_at, 'dd MMM yy')}</span> : null}</>}
              />
              {showDept && <MobileCardField label={t('assigner.col.department')} value={deptText(m.department)} />}
              <MobileCardField label={t('segTable.totalOrders')} value={m.paid_count} />
              <MobileCardField
                label={t('segTable.avgPerPkg')}
                value={m.avg_package_price != null
                  ? <>{formatMoney(m.avg_package_price)}</>
                  : '—'}
              />
              <MobileCardField
                label={t('segTable.totalSpend')}
                value={<>{formatMoney(m.lifetime_value)}</>}
              />
              <MobileCardField
                label={t('segTable.lastCall')}
                value={(() => {
                  const lc = effectiveLastCall(m);
                  return lc.at
                    ? `${formatDate(lc.at, 'dd MMM HH:mm')}${lc.outcome ? ' · ' + t(`outcome.${lc.outcome}`, { defaultValue: lc.outcome.replace(/_/g, ' ') }) : ''}`
                    : t('segTable.never');
                })()}
              />
              {hasUnassign && (
                <div className="pt-1">
                  <Button variant="outline" size="sm" className="w-full gap-1.5 text-rose-600" disabled={!m.assigned_agent_id} onClick={(e) => { e.stopPropagation(); onUnassignSingle?.(m); }}>
                    <UserX className="h-3.5 w-3.5" /> {t('assigner.unassign')}
                  </Button>
                </div>
              )}
            </MobileCard>
          );
        })}
      </div>

      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-between">
          <p className="hidden text-xs text-muted-foreground sm:block">{t('segmentDetail.pageOf', { page, totalPages })}</p>
          <ResponsivePager page={page} totalPages={totalPages} onPageChange={onPageChange} t={t}
            desktop={<SmartPagination page={page} totalPages={totalPages} onPageChange={onPageChange} />} />
        </div>
      )}
    </div>
  );
}
