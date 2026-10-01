import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, CircleSlash, Clock, Loader2, MapPinOff, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/EmptyState';
import { LoadError } from '@/components/insights/shared/LoadError';
import { DeptDash, deptName } from '@/components/assigner/parts';
import type { InsightsFormat } from '@/components/insights/shared/useInsightsFormat';
import { cn, formatProductWithQuantity } from '@/lib/utils';
import { formatMoney } from '@/lib/currency';
import { apiErrorText } from '@/i18n/apiErrors';
import { apiGetWarehouseQueue, type PushResult, type QueueOrder, type QueueResponse, type SendRow } from '@/lib/warehouseApi';
import { QueueFilters, QueuePager } from './QueueFilters';
import { MexPushDialog } from './MexPushDialog';
import { accountName, codeText, skopjeDate, warningText } from './warehouseText';

const PAGE = 50;

/**
 * Tab 1 — "Испрати до MEX": confirmed orders with no parcel, each checked exactly as the
 * push will check it. Tick → "Испрати до MEX (N)" → the dialog (dry run → confirm → send).
 * While app_settings.mex_push is off the button is disabled and says why; the /orders MEX
 * CSV stays the way to ship.
 */
export function SendTab({ f }: { f: InsightsFormat }) {
  const { t } = f;
  const qc = useQueryClient();
  const [departments, setDepartments] = useState<string[]>([]);
  const [order, setOrder] = useState<QueueOrder>('oldest');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Map<string, SendRow>>(new Map());
  const [dialog, setDialog] = useState(false);

  const q = useQuery<QueueResponse<SendRow>>({
    queryKey: ['warehouse-queue', 'send', departments, order, offset],
    queryFn: () => apiGetWarehouseQueue<SendRow>({ tab: 'send', departments, order, limit: PAGE, offset }),
    staleTime: 20_000,
    placeholderData: (prev) => prev,
  });
  useEffect(() => { setOffset(0); setSelected(new Map()); }, [departments, order]);

  const data = q.data;
  const push = data?.push;
  const max = push?.max_per_send ?? 50;
  const money = !!data?.money;
  const rows = data?.rows ?? [];
  const canPush = !!push?.can_push;
  const switchOn = !!push?.enabled;
  const selectable = (r: SendRow) => r.validation.ok;
  const pageSelectable = rows.filter(selectable);
  const allOnPage = pageSelectable.length > 0 && pageSelectable.every((r) => selected.has(r.id));

  const toggle = (r: SendRow) => setSelected((prev) => {
    const next = new Map(prev);
    if (next.has(r.id)) next.delete(r.id);
    else if (next.size < max) next.set(r.id, r);
    return next;
  });
  const togglePage = () => setSelected((prev) => {
    const next = new Map(prev);
    if (allOnPage) for (const r of pageSelectable) next.delete(r.id);
    else for (const r of pageSelectable) { if (next.size >= max) break; next.set(r.id, r); }
    return next;
  });

  const onDone = (results: PushResult[]) => {
    const settled = new Set(results.filter((r) => r.outcome === 'sent' || r.outcome === 'exists_linked').map((r) => r.order_id));
    setSelected((prev) => new Map([...prev].filter(([id]) => !settled.has(id))));
    void qc.invalidateQueries({ queryKey: ['warehouse-queue'] });
  };

  const selectedRows = useMemo(() => [...selected.values()], [selected]);
  const counts = data?.counts;

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('warehousePage.send.desc')}</p>
      {push && !switchOn && (
        <p role="status" className="flex items-start gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-xs text-muted-foreground" data-testid="mex-switch-off">
          <CircleSlash className="mt-px h-4 w-4 shrink-0" aria-hidden />{t('warehousePage.send.switchOff')}
        </p>
      )}
      {counts && counts.send_no_address > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <MapPinOff className="mt-px h-4 w-4 shrink-0" aria-hidden />{t('warehousePage.send.noAddressNote', { count: counts.send_no_address })}
        </p>
      )}

      <QueueFilters departments={departments} onDepartments={setDepartments} order={order} onOrder={setOrder}
        byDepartment={counts?.send_by_department} hideWeb f={f} />

      {/* The action bar: sticky on a phone so the button is always in reach. */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border bg-card/95 px-3 py-2 shadow-sm backdrop-blur">
        <span className="text-sm font-medium tabular-nums">{t('warehousePage.send.selected', { count: selected.size })}</span>
        {selected.size > 0 && (
          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setSelected(new Map())}>
            <X className="mr-1 h-3.5 w-3.5" aria-hidden />{t('warehousePage.send.clear')}
          </Button>
        )}
        <span className="text-[11px] text-muted-foreground">{t('warehousePage.send.max', { max })}</span>
        <Button className="ml-auto min-h-9" disabled={!canPush || !switchOn || selected.size === 0} onClick={() => setDialog(true)}
          title={!switchOn ? t('warehousePage.send.switchOff') : undefined}>
          <Send className="mr-1.5 h-4 w-4" aria-hidden />
          {selected.size > 0 ? t('warehousePage.send.button', { count: selected.size }) : t('warehousePage.send.buttonDisabled')}
        </Button>
      </div>

      {q.isError && !data ? (
        <LoadError text={apiErrorText(q.error)} onRetry={() => void q.refetch()} />
      ) : q.isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden /></div>
      ) : rows.length === 0 ? (
        <EmptyState title={departments.length ? t('warehousePage.send.emptyFiltered') : t('warehousePage.send.empty')} size="md" />
      ) : (
        <>
          {/* xl and up: the table (it needs ~1000 px) */}
          <div className="hidden overflow-x-auto rounded-xl border bg-card shadow-sm xl:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="w-10 px-3 py-2">
                    <Checkbox checked={allOnPage} onCheckedChange={togglePage} aria-label={t('warehousePage.send.selectPage')} disabled={!pageSelectable.length} />
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('warehousePage.send.col.order')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('warehousePage.send.col.customer')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('warehousePage.send.col.city')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('warehousePage.send.col.products')}</th>
                  {money && <th scope="col" className="px-2 py-2 text-right font-medium">{t('warehousePage.send.col.value')}</th>}
                  <th scope="col" className="px-2 py-2 font-medium">{t('warehousePage.send.col.profile')}</th>
                  <th scope="col" className="px-2 py-2 font-medium">{t('warehousePage.send.col.checks')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={cn('border-b align-top last:border-0', selected.has(r.id) && 'bg-primary/5')}>
                    <td className="px-3 py-2">
                      <Checkbox checked={selected.has(r.id)} disabled={!selectable(r)} onCheckedChange={() => toggle(r)}
                        aria-label={t('warehousePage.send.selectRow', { id: r.display_id })} />
                    </td>
                    <td className="px-2 py-2"><OrderCell r={r} f={f} /></td>
                    <td className="px-2 py-2">
                      <div className="font-medium">{r.customer_name || '—'}</div>
                      <div className="text-xs text-muted-foreground">{r.customer_phone || '—'}</div>
                    </td>
                    <td className="px-2 py-2"><CityCell r={r} f={f} /></td>
                    <td className="max-w-[16rem] px-2 py-2 text-xs"><Products r={r} /></td>
                    {money && <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums">{r.price_eur != null ? formatMoney(r.price_eur) : '—'}</td>}
                    <td className="px-2 py-2"><ProfileCell r={r} f={f} /></td>
                    <td className="px-2 py-2"><Checks r={r} f={f} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* below xl: cards */}
          <ul className="space-y-2 xl:hidden">
            {rows.map((r) => (
              <li key={r.id} className={cn('rounded-xl border bg-card p-3 shadow-sm', selected.has(r.id) && 'border-primary/50 bg-primary/5')}>
                <div className="flex items-start gap-3">
                  <Checkbox className="mt-1" checked={selected.has(r.id)} disabled={!selectable(r)} onCheckedChange={() => toggle(r)}
                    aria-label={t('warehousePage.send.selectRow', { id: r.display_id })} />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                      <OrderCell r={r} f={f} />
                      {money && r.price_eur != null && <span className="text-sm font-semibold tabular-nums">{formatMoney(r.price_eur)}</span>}
                    </div>
                    <div className="text-sm">
                      <span className="font-medium">{r.customer_name || '—'}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">{r.customer_phone}</span>
                    </div>
                    <CityCell r={r} f={f} />
                    <div className="text-xs"><Products r={r} /></div>
                    <ProfileCell r={r} f={f} labelled />
                    <Checks r={r} f={f} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <QueuePager offset={offset} limit={PAGE} total={data?.total ?? 0} onOffset={setOffset} f={f} />
        </>
      )}

      <MexPushDialog open={dialog} onOpenChange={setDialog} rows={selectedRows} push={push} money={money} onDone={onDone} f={f} />
    </div>
  );
}

function OrderCell({ r, f }: { r: SendRow; f: InsightsFormat }) {
  const { t } = f;
  return (
    <div className="min-w-0">
      <div className="whitespace-nowrap font-semibold">{r.display_id}</div>
      <div className="flex items-center gap-1 text-[11px] font-medium">
        <DeptDash dept={r.department} /><span className="min-w-0">{deptName(t, r.department)}</span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {t('warehousePage.send.sold', { date: skopjeDate(r.sale_at) })}
        {r.seller ? ` · ${t('warehousePage.send.seller', { name: r.seller })}` : ''}
      </div>
    </div>
  );
}

function CityCell({ r, f }: { r: SendRow; f: InsightsFormat }) {
  const { t } = f;
  return (
    <div className="text-xs">
      <div>{r.customer_city || '—'}{r.postal_code ? ` ${r.postal_code}` : ''}</div>
      {r.zone.name
        ? <div className="text-muted-foreground">{r.zone.name}</div>
        : <div className="font-medium text-red-600 dark:text-red-400">{t('warehousePage.send.noZone')}</div>}
    </div>
  );
}

function Products({ r }: { r: SendRow }) {
  const items = r.items?.length ? r.items : [{ product_name: r.product_name, quantity: r.quantity }];
  return (
    <span className="break-words">
      {items.map((i, idx) => (
        <span key={idx}>{idx > 0 && ', '}{formatProductWithQuantity(i.product_name ?? '—', i.quantity ?? 1)}</span>
      ))}
    </span>
  );
}

function ProfileCell({ r, f, labelled }: { r: SendRow; f: InsightsFormat; labelled?: boolean }) {
  const { t } = f;
  const a = r.account;
  const reasonText = (code: string) => {
    const other = code === 'department_disagrees' ? a.department_profile : code === 'team_disagrees' ? a.team_profile : null;
    return t(`warehousePage.profile.reason.${code}`, { account: accountName(other) });
  };
  return (
    <div className="min-w-[9rem] space-y-0.5 text-xs">
      <div className="flex flex-wrap items-center gap-1">
        <span className={cn('whitespace-nowrap rounded-md border px-1.5 py-0.5 font-semibold',
          a.suggested === 'bio_natural' ? 'border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300'
            : a.suggested === 'natura' ? 'border-sky-300 text-sky-800 dark:border-sky-800 dark:text-sky-300' : 'text-muted-foreground')}>
          {a.suggested ? (labelled ? t('warehousePage.profile.label', { account: accountName(a.suggested) }) : accountName(a.suggested)) : t('warehousePage.profile.pick')}
        </span>
        {a.needs_pick && a.reasons[0] !== 'web_order' && (
          <span className="whitespace-nowrap rounded-md bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">
            {t('warehousePage.profile.needsPick')}
          </span>
        )}
      </div>
      <div className="leading-snug text-muted-foreground">
        {a.suggested && <>{t(`warehousePage.profile.basis.${a.basis}`)}{a.reasons.length > 0 && ' · '}</>}
        {a.reasons.length > 0 && <span className="text-amber-800 dark:text-amber-300">{a.reasons.map(reasonText).join(' · ')}</span>}
      </div>
    </div>
  );
}

function Checks({ r, f }: { r: SendRow; f: InsightsFormat }) {
  const { t } = f;
  const days = r.no_parcel_days_left;
  return (
    <div className="space-y-1 text-xs">
      {r.validation.ok ? (
        <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />{t('warehousePage.check.ok')}
        </span>
      ) : (
        <span className="inline-flex items-start gap-1 font-medium text-red-700 dark:text-red-400">
          <CircleSlash className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('warehousePage.check.missing', { list: r.validation.missing.map((c) => c === 'ship_later' ? `${codeText(t, c)} (${skopjeDate(r.ship_after_date)})` : codeText(t, c)).join(', ') })}
        </span>
      )}
      {r.warnings.map((w, i) => (
        <div key={i} className={cn('flex gap-1', w.blocking ? 'font-medium text-amber-800 dark:text-amber-300' : 'text-muted-foreground')}>
          <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />{warningText(t, w)}
        </div>
      ))}
      {days != null && (
        <div className={cn('flex gap-1', days <= 3 ? 'font-medium text-red-700 dark:text-red-400' : 'text-muted-foreground')} title={t('warehousePage.npr.hint')}>
          <Clock className="mt-px h-3 w-3 shrink-0" aria-hidden />
          {days <= 0 ? t('warehousePage.npr.today') : t('warehousePage.npr.left', { count: days })}
        </div>
      )}
    </div>
  );
}
