import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Phone, MapPin, Cake, Plus, ShoppingCart, Pencil, Check, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDate } from '@/i18n/dates';
import { LeadQualityBadge } from '@/components/CustomerIntelligencePanel';
import { useCustomerIntelligence } from '@/hooks/useCustomerIntelligence';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGetCustomerHistory, apiGetCustomerPrefill, apiUpdateCustomerContact } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { usePermissions } from '@/contexts/PermissionsContext';
import { formatMoney } from '@/lib/currency';
import { composeHomeAddress } from '@/lib/address';
import { CustomerHistoryTabs } from './CustomerHistoryTabs';
import { EmptyState } from '@/components/EmptyState';
import { CustomerNotesPanel } from './CustomerNotesPanel';
import { PersonalHoldBadge } from '@/components/PersonalHoldBadge';
import { PersonalListButton } from '@/components/calls/PersonalListButton';
import { ActiveViewBadge } from '@/components/ActiveViewBadge';
import { hoverLift } from '@/lib/design-utils';

interface Props {
  phone: string;
  onOpenOrder?: (orderId: string) => void;
  /** Triggers the "Create Order" workflow for the currently-shown customer.
   *  Used by the always-visible Create Order button — works whether the call
   *  is active, ended, or never started. */
  onCreateOrder?: () => void;
  /** Fired after the customer is claimed into the agent's Personal List — the
   *  Calls page uses it to advance to the next queue customer. */
  onClaimedToPersonalList?: (phone: string) => void;
  /** Fired after the customer's name/phone is edited here. Receives the new
   *  (E.164) phone so the page can re-point the active customer + Dial at it. */
  onCustomerUpdated?: (newPhone: string) => void;
  /** Calling controls + queue switcher, rendered by the page between the
   *  customer strip and the dossier. */
  toolbar?: ReactNode;
  /** Call action (the green Dial button) shown in the left column next to the
   *  Personal List button. */
  callAction?: ReactNode;
  /** Optional: avg package price for this customer (from prediction_segment_members when sourced from a prediction list queue).
   *  Displayed with dual EUR/LEV using the currency helpers (post redesign). Only shown in prediction call context. */
  avgPackagePrice?: number | null;
  /** Show the Call Scripts & Helpers panel below history (everyone on Calls). */
  showScripts?: boolean;
}

function Metric({ label, value, valueClass }: { label: string; value: number; valueClass?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-xl font-bold leading-tight ${valueClass ?? ''}`}>{value}</div>
    </div>
  );
}

export function ClientProfileCard({ phone, onOpenOrder, onCreateOrder, onClaimedToPersonalList, onCustomerUpdated, toolbar, callAction, avgPackagePrice, showScripts }: Props) {
  const { t } = useTranslation();
  const { data: intel, loading: intelLoading } = useCustomerIntelligence(phone);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { canAction } = usePermissions();
  const canEditCustomer = canAction('orders', 'edit');

  // Inline edit of the customer's name + phone. Saving rewrites EVERY order for
  // this customer (server-side, by last-8) and re-points Dial at the new number.
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [phoneDraft, setPhoneDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // Single fetch drives the header (name/address) and is reused by
  // CustomerHistoryTabs via the same query cache key. The tabs component
  // is also wired to this query so the data is fetched once.
  const { data: history } = useQuery({
    queryKey: ['customer-history', phone],
    queryFn: () => apiGetCustomerHistory(phone),
    enabled: !!phone && phone.replace(/\D/g, '').length >= 6,
    staleTime: 15_000,
  });

  // The saved profile is where the address backfill and every agent correction
  // land, cross-agent (admin-resolved server-side). Same bundle the order modal
  // prefills from, so what the agent reads here is what the form will offer.
  const { data: prefill } = useQuery({
    queryKey: ['customer-prefill', phone],
    queryFn: () => apiGetCustomerPrefill(phone),
    enabled: !!phone && phone.replace(/\D/g, '').length >= 6,
    staleTime: 60_000,
  });

  const orders = history?.orders ?? [];
  const customerName = intel?.customer_name
    || (orders[0] as any)?.customer_name
    || '';

  // Surface birthday + a friendly address: the saved profile wins (agents and
  // the backfill maintain it), the most recent order is the fallback for
  // customers whose profile has no address yet.
  const latestOrder: any = orders[0];
  const profile: any = prefill?.profile;
  const birthday = latestOrder?.birthday ? formatDate(new Date(latestOrder.birthday + 'T00:00:00'), 'dd MMM yyyy') : '';
  const addressLine = (() => {
    const fromProfile = profile
      ? [composeHomeAddress(profile), profile.city].filter(Boolean).join(', ')
      : '';
    if (fromProfile) return fromProfile;
    if (!latestOrder) return '';
    const parts = [composeHomeAddress(latestOrder), latestOrder.customer_city].filter(Boolean);
    if (parts.length === 0) return latestOrder.customer_address || '';
    return parts.join(', ');
  })();

  const stats = intel?.found ? intel.stats : undefined;
  const cooldown = intel?.cooldown || null;

  const beginEdit = () => {
    setNameDraft(customerName || '');
    setPhoneDraft(phone || '');
    setEditing(true);
  };

  const saveContact = async () => {
    const newName = nameDraft.trim();
    const newPhoneRaw = phoneDraft.trim();
    const nameChanged = newName !== (customerName || '').trim();
    const phoneChanged = newPhoneRaw.replace(/\D/g, '') !== (phone || '').replace(/\D/g, '');
    if (!nameChanged && !phoneChanged) { setEditing(false); return; }
    if (phoneChanged && newPhoneRaw.replace(/\D/g, '').length < 8) {
      toast({ title: t('validation.phoneTooShort'), description: t('validation.phoneTooShortDesc'), variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const resp = await apiUpdateCustomerContact({
        phone,
        ...(nameChanged ? { customer_name: newName } : {}),
        ...(phoneChanged ? { customer_phone: newPhoneRaw } : {}),
      });
      // Refresh the old phone's caches; if the number changed, warm the new one too.
      for (const p of [phone, resp.new_phone]) {
        qc.invalidateQueries({ queryKey: ['customer-history', p] });
        qc.invalidateQueries({ queryKey: ['customer-intelligence', p] });
        qc.invalidateQueries({ queryKey: ['calls-page-orders', p] });
      }
      toast({
        title: t('clientProfile.customerUpdated'),
        description: t('clientProfile.ordersUpdated', { count: resp.orders_updated })
          + (resp.new_phone !== phone ? ` ${t('clientProfile.dialingNew', { phone: resp.new_phone })}` : ''),
      });
      setEditing(false);
      onCustomerUpdated?.(resp.new_phone);
    } catch (e: any) {
      toast({ title: t('clientProfile.updateFailed'), description: e?.message || t('common.unknownError'), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Customer strip — three zones: info (left), metrics (center), notes (right). */}
      <div className={`rounded-2xl border border-border/60 bg-card grid grid-cols-1 lg:grid-cols-[1.2fr_0.9fr_1.4fr] lg:divide-x divide-border shadow-sm ${hoverLift}`}>
        {/* LEFT — who am I calling */}
        <div className="p-4 flex flex-col gap-3 min-w-0 border-b lg:border-b-0">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 shrink-0">
              <Phone className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              {editing ? (
                <div className="space-y-1.5">
                  <Input
                    autoFocus
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    placeholder={t('fields.customerName')}
                    className="h-8 text-sm font-semibold"
                    disabled={saving}
                  />
                  <Input
                    value={phoneDraft}
                    onChange={(e) => setPhoneDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveContact(); if (e.key === 'Escape') setEditing(false); }}
                    placeholder={t('fields.phonePlaceholder')}
                    inputMode="tel"
                    className="h-8 text-sm font-mono"
                    disabled={saving}
                  />
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" className="h-7 gap-1" onClick={saveContact} disabled={saving}>
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} {t('common.save')}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 gap-1" onClick={() => setEditing(false)} disabled={saving}>
                      <X className="h-3.5 w-3.5" /> {t('common.cancel')}
                    </Button>
                  </div>
                  <p className="text-[10px] text-muted-foreground leading-tight">
                    {t('clientProfile.editHint')}
                  </p>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-lg font-bold truncate">{customerName || t('clientProfile.unknownCustomer')}</span>
                    <PersonalHoldBadge phone={phone} />
                    <ActiveViewBadge phone={phone} />
                    {canEditCustomer && (
                      <button
                        type="button"
                        onClick={beginEdit}
                        title={t('clientProfile.editNamePhone')}
                        className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="font-mono text-sm text-muted-foreground mt-0.5">{phone}</div>
                </>
              )}
            </div>
          </div>

          <div className="space-y-1.5 text-xs text-muted-foreground">
            {addressLine && (
              <div className="flex items-start gap-1.5">
                <MapPin className="h-3.5 w-3.5 shrink-0 mt-px" />
                <span className="break-words">{addressLine}</span>
              </div>
            )}
            {birthday && (
              <div className="flex items-center gap-1.5">
                <Cake className="h-3.5 w-3.5 shrink-0" /> {birthday}
              </div>
            )}
            {!addressLine && !birthday && (
              <EmptyState
                icon={<MapPin className="h-3.5 w-3.5" />}
                title={t('clientProfile.noAddressBirthday')}
                size="sm"
                className="border-0 bg-transparent py-0 text-[11px] text-muted-foreground/70"
              />
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap mt-auto pt-1">
            <PersonalListButton phone={phone} customerName={customerName || undefined} onClaimed={onClaimedToPersonalList} />
            {callAction}
            {onCreateOrder && (
              <Button size="sm" onClick={onCreateOrder} className="gap-1.5 bg-emerald-600 hover:bg-emerald-700">
                <Plus className="h-3.5 w-3.5" />
                {t('common.createOrder')}
              </Button>
            )}
          </div>
        </div>

        {/* CENTER — the four metrics that used to live in the Customer Intelligence strip */}
        <div className="p-4 flex flex-col justify-center border-b lg:border-b-0">
          {intelLoading ? (
            <div className="grid grid-cols-2 gap-3 animate-pulse">
              {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-10 rounded bg-muted" />)}
            </div>
          ) : stats ? (
            <>
              {intel?.quality_score && (
                <div className="flex justify-center mb-3">
                  <LeadQualityBadge score={intel.quality_score} reason={intel.quality_reason} />
                </div>
              )}
              {cooldown?.is_in_cooldown && (
                <div className="mb-2 rounded-md bg-amber-50 border border-amber-200 px-2 py-1 text-[10px] text-amber-700 text-center dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-300">
                  {t('clientProfile.cooldownUntil', { date: formatDate(new Date(cooldown.until), 'dd MMM'), reason: cooldown.reason })}
                </div>
              )}
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-center">
                <Metric label={t('clientProfile.metricOrders')} value={stats.total_orders} />
                <Metric label={t('clientProfile.metricPaid')} value={stats.paid_orders} valueClass="text-emerald-600" />
                <Metric label={t('clientProfile.metricReturned')} value={stats.returned_orders} valueClass="text-rose-600" />
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('clientProfile.metricRevenue')}</div>
                  <div className="text-base font-bold text-primary leading-tight">{formatMoney(stats.lifetime_revenue)}</div>
                </div>
                {avgPackagePrice != null && (
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('clientProfile.metricAvgPkg')}</div>
                    <div className="text-base font-bold text-primary leading-tight">{formatMoney(avgPackagePrice)}</div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <EmptyState
              icon={<ShoppingCart className="h-3.5 w-3.5 text-amber-400" />}
              title={t('clientProfile.noOrderHistory')}
              size="sm"
              className="border-0 bg-transparent py-1 text-[11px]"
            />
          )}
        </div>

        {/* RIGHT — persistent "about this customer" notes */}
        <div className="p-4">
          <CustomerNotesPanel phone={phone} />
        </div>
      </div>

      {/* Calling controls + queue, supplied by the page. */}
      {toolbar}

      {/* Unified dossier — every order + every call attempt */}
      <CustomerHistoryTabs phone={phone} onOpenOrder={onOpenOrder} showScripts={showScripts} />
    </div>
  );
}
