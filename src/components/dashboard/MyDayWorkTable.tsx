import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ClipboardList, Phone } from 'lucide-react';
import { SmartPagination } from '@/components/SmartPagination';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/EmptyState';
import { StatusBadge } from '@/components/StatusBadge';
import { MobileCard, MobileCardActions, MobileCardField, MobileCardHeader } from '@/components/ui/mobile-card';
import { OrderModal, type OrderModalData } from '@/components/OrderModal';
import { formatDate } from '@/i18n/dates';
import { formatMoney } from '@/lib/currency';
import { formatProductWithQuantity } from '@/lib/utils';
import { apiGetMyDayWork, type DayWorkRow } from '@/lib/api';
import type { OrderStatus } from '@/types';
import { useNavigate } from 'react-router-dom';

function prettyPhone(p: string | null): string {
  const s = (p || '').trim();
  const m = s.match(/^(\+\d{3})(\d{2})(\d{3})(\d+)$/);
  return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : s || '—';
}

function productCell(o: DayWorkRow): string {
  if (o.order_items?.length) {
    return o.order_items.map((i) => formatProductWithQuantity(i.product_name, i.quantity)).join(', ');
  }
  return o.product_name || '—';
}

function toModalData(o: DayWorkRow): OrderModalData {
  return {
    id: o.id,
    displayId: o.display_id || undefined,
    name: o.customer_name || '',
    telephone: o.customer_phone || '',
    address: o.customer_address,
    city: o.customer_city,
    postalCode: o.postal_code,
    product: o.product_name,
    status: o.status,
    notes: o.notes ?? null,
    quantity: o.quantity ?? 1,
    price: Number(o.price || 0),
    assigned_agent_id: o.assigned_agent_id,
    ship_after_date: o.ship_after_date,
    items: (o.order_items || []).map((i, idx) => ({
      id: `${o.id}-${idx}`,
      product_id: null,
      product_name: i.product_name,
      quantity: i.quantity,
      price_per_unit: i.price_per_unit,
      total_price: i.total_price,
    })),
  };
}

export function MyDayWorkTable(
  { period, date, from, to }: { period: 'today' | 'month' | 'custom'; date: string; from?: string; to?: string },
) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<DayWorkRow | null>(null);
  useEffect(() => { setPage(1); }, [period, date, from, to]);

  const rangeReady = period !== 'custom' || (!!from && !!to);
  const { data, isLoading } = useQuery({
    queryKey: ['my-day-work', period, date, from, to, page],
    queryFn: () => apiGetMyDayWork({ period, date, from, to, page }),
    enabled: rangeReady,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

  const rows = data?.orders || [];
  const totals = data?.totals;
  const limit = data?.limit || 20;
  const totalPages = Math.max(1, Math.ceil((data?.total || 0) / limit));

  return (
    <>
    <Card className="border-none shadow-sm mb-6">
      <CardHeader className="pb-2 space-y-1">
        <CardTitle className="text-sm font-semibold text-card-foreground flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-primary" /> {t('dashboard.dayWorkTitle')}
        </CardTitle>
        <p className="text-xs text-muted-foreground">{t('dashboard.dayWorkCaption')}</p>
        {totals && totals.n > 0 && (
          <p className="text-xs tabular-nums text-muted-foreground">
            {t('dashboard.dayWorkSummary', {
              n: totals.n,
              confirmed: totals.confirmed_n,
              confirmedMoney: formatMoney(Number(totals.confirmed_sum || 0)),
              cancelled: totals.cancelled_n,
              trashed: totals.trashed_n,
              callAgain: totals.call_again_n,
            })}
          </p>
        )}
      </CardHeader>
      <CardContent className="px-3 sm:px-6">
        {isLoading ? (
          <div className="space-y-2 py-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="h-5 w-5" />}
            title={t('dashboard.dayWorkEmpty')}
            size="sm"
            className="border-0 bg-transparent py-8"
          />
        ) : (
          <>
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left py-2 font-medium">{t('ordersPage.colStatus')}</th>
                    <th className="text-left py-2 font-medium">{t('ordersPage.colOrderId')}</th>
                    <th className="text-left py-2 font-medium">{t('ordersPage.colCustomer')}</th>
                    <th className="text-left py-2 font-medium">{t('ordersPage.colProduct')}</th>
                    <th className="text-right py-2 font-medium">{t('ordersPage.colTotalPrice')}</th>
                    <th className="text-left py-2 font-medium pl-4">{t('dashboard.colDisposition')}</th>
                    <th className="text-right py-2 font-medium pr-2">{t('dashboard.colAction')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr
                      key={o.id}
                      className="border-b last:border-0 hover:bg-muted/30 cursor-pointer"
                      onClick={() => setModal(o)}
                    >
                      <td className="py-2.5 align-top"><StatusBadge status={o.status as OrderStatus} order={o} /></td>
                      <td className="py-2.5 align-top font-mono text-xs font-semibold">{o.display_id || '—'}</td>
                      <td className="py-2.5 align-top">
                        <div className="font-medium">{o.customer_name || '—'}</div>
                        <div className="text-[11px] font-mono text-muted-foreground">{prettyPhone(o.customer_phone)}</div>
                        {(o.customer_city || o.customer_address) && (
                          <div className="text-[11px] text-muted-foreground mt-0.5 max-w-[220px] truncate">
                            {[o.customer_city, o.customer_address].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 align-top text-[12px] max-w-[260px]">{productCell(o)}</td>
                      <td className="py-2.5 align-top text-right tabular-nums font-mono font-semibold">
                        {formatMoney(Number(o.price || 0))}
                      </td>
                      <td className="py-2.5 align-top text-[11px] text-muted-foreground whitespace-nowrap pl-4">
                        <div>{formatDate(o.last_changed_at, 'dd MMM HH:mm')}</div>
                        <div className="text-[10px]">{t(`status.${o.last_to_status}`, { defaultValue: o.last_to_status })}</div>
                      </td>
                      <td className="py-2.5 align-top text-right pr-2" onClick={(e) => e.stopPropagation()}>
                        <Button
                          size="sm" variant="outline" className="h-7 text-[11px] gap-1"
                          disabled={!o.customer_phone}
                          onClick={() => navigate(`/calls?phone=${encodeURIComponent(o.customer_phone || '')}`)}
                        >
                          <Phone className="h-3 w-3" /> {t('dashboard.callNow')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="md:hidden space-y-2">
              {rows.map((o) => (
                <MobileCard key={o.id} onClick={() => setModal(o)}>
                  <MobileCardHeader
                    title={o.customer_name || '—'}
                    subtitle={prettyPhone(o.customer_phone)}
                    badge={<StatusBadge status={o.status as OrderStatus} order={o} />}
                  />
                  <MobileCardField label={t('ordersPage.colOrderId')} value={<span className="font-mono">{o.display_id || '—'}</span>} />
                  <MobileCardField label={t('ordersPage.colProduct')} value={productCell(o)} />
                  <MobileCardField label={t('ordersPage.colTotalPrice')} value={formatMoney(Number(o.price || 0))} />
                  <MobileCardField
                    label={t('dashboard.colDisposition')}
                    value={formatDate(o.last_changed_at, 'dd MMM HH:mm')}
                  />
                  <MobileCardActions>
                    <Button
                      size="sm" variant="outline" className="gap-1"
                      disabled={!o.customer_phone}
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/calls?phone=${encodeURIComponent(o.customer_phone || '')}`);
                      }}
                    >
                      <Phone className="h-3.5 w-3.5" /> {t('dashboard.callNow')}
                    </Button>
                  </MobileCardActions>
                </MobileCard>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between pt-3">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {t('dashboard.pageOf', { page: data?.page || page, totalPages })}
                </span>
                <SmartPagination page={page} totalPages={totalPages} onPageChange={setPage} />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>

    <OrderModal
      open={!!modal}
      onClose={() => setModal(null)}
      data={modal ? toModalData(modal) : null}
      contextType="order"
    />
    </>
  );
}
