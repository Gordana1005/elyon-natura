import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AppLayout } from '@/layouts/AppLayout';
import { StatusBadge } from '@/components/StatusBadge';
import { Loader2, ClipboardList } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
// Button removed - rows are clickable
import { apiGetOrders } from '@/lib/api';
import { formatProductWithQuantity } from '@/lib/utils';
import { formatMoney } from '@/lib/currency';
import { formatDayDmy } from '@/i18n/dates';
import { useAuth } from '@/contexts/AuthContext';
import { OrderModal, OrderModalData } from '@/components/OrderModal';
import { MobileCard, MobileCardHeader, MobileCardField } from '@/components/ui/mobile-card';

export default function AssignedPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOrder, setModalOrder] = useState<any>(null);

  const fetchOrders = () => {
    setLoading(true);
    apiGetOrders({ limit: 100 })
      .then((data) => setOrders(data.orders || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchOrders(); }, []);

  const myOrders = user?.isAdmin
    ? orders.filter(o => o.assigned_agent_id === user.id)
    : orders;

  function orderToModalData(order: any): OrderModalData {
    return {
      id: order.id,
      displayId: order.display_id,
      name: order.customer_name,
      telephone: order.customer_phone,
      address: order.customer_address,
      city: order.customer_city,
      postalCode: order.postal_code || '',
      product: order.product_name,
      status: order.status,
      notes: null,
      quantity: order.quantity,
      price: order.price,
      assigned_agent_id: order.assigned_agent_id,
      items: (order.order_items || []).map((i: any) => ({
        id: i.id, product_id: i.product_id, product_name: i.product_name,
        quantity: i.quantity, price_per_unit: i.price_per_unit, total_price: i.total_price,
      })),
    };
  }

  return (
    <AppLayout title={t('nav.assignedToMe')}>
      <p className="mb-4 text-sm text-muted-foreground">{t('assignedPage.nAssigned', { count: myOrders.length })}</p>

      {/* Desktop: table */}
      <div className="hidden md:block overflow-hidden rounded-xl border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : (
        <table className="w-full text-sm">
          <thead>
             <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colStatus')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colOrderId')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colCustomer')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colProduct')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colQty')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colTotalPrice')}</th>
              <th className="px-4 py-3 text-left font-medium text-muted-foreground">{t('ordersPage.colDate')}</th>
            </tr>
          </thead>
          <tbody>
            {myOrders.map(order => (
              <tr key={order.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => setModalOrder(order)}>
                <td className="px-4 py-3"><StatusBadge status={order.status} order={order} /></td>
                <td className="px-4 py-3 font-mono text-xs font-semibold">{order.display_id}</td>
                <td className="px-4 py-3">{order.customer_name}</td>
                <td className="px-4 py-3">
                  {order.order_items && order.order_items.length > 0
                    ? order.order_items.map((i: any) => formatProductWithQuantity(i.product_name, i.quantity)).join(', ')
                    : order.product_name || '—'}
                </td>
                <td className="px-4 py-3 text-center">{order.quantity || 1}</td>
                <td className="px-4 py-3 font-bold text-primary">{formatMoney(order.price)}</td>
                <td className="px-4 py-3 text-muted-foreground">{formatDayDmy(order.created_at)}</td>
              </tr>
            ))}
            {myOrders.length === 0 && (
              <tr>
                <td colSpan={7} className="p-0">
                  <EmptyState
                    icon={<ClipboardList className="h-5 w-5" />}
                    title={t('assignedPage.noAssigned')}
                    description={t('assignedPage.assignedAppear')}
                    size="sm"
                    className="border-0 bg-transparent hover:shadow-none"
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
        )}
      </div>

      {/* Mobile: cards */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : myOrders.length === 0 ? (
          <EmptyState icon={<ClipboardList className="h-5 w-5" />} title={t('assignedPage.noAssigned')} description={t('assignedPage.assignedAppear')} size="sm" />
        ) : myOrders.map(order => (
          <MobileCard key={order.id} onClick={() => setModalOrder(order)}>
            <MobileCardHeader
              title={order.customer_name}
              subtitle={order.customer_phone}
              badge={<StatusBadge status={order.status} order={order} />}
            />
            <MobileCardField label={t('ordersPage.colOrderId')} value={<span className="font-mono">{order.display_id}</span>} />
            <MobileCardField
              label={t('ordersPage.colProduct')}
              value={order.order_items && order.order_items.length > 0
                ? order.order_items.map((i: any) => formatProductWithQuantity(i.product_name, i.quantity)).join(', ')
                : order.product_name || '—'}
            />
            <MobileCardField label={t('ordersPage.colQty')} value={order.quantity || 1} />
            <MobileCardField label={t('createOrder.total')} value={<span className="font-bold text-primary">{formatMoney(order.price)}</span>} />
            <MobileCardField label={t('ordersPage.colDate')} value={formatDayDmy(order.created_at)} />
          </MobileCard>
        ))}
      </div>

      <OrderModal
        open={!!modalOrder}
        onClose={(saved) => {
          setModalOrder(null);
          if (saved) fetchOrders();
        }}
        data={modalOrder ? orderToModalData(modalOrder) : null}
        contextType="order"
        readOnly={!!(modalOrder && !(modalOrder as any).is_owned)}
      />
    </AppLayout>
  );
}
