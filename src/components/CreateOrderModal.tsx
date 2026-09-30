import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns'; // machine 'yyyy-MM-dd' payloads only
import {
  CalendarIcon, ChevronDown, ChevronRight, Gift, MapPin, Save, ShoppingCart, Truck, UserRound, ListChecks,
} from 'lucide-react';
import { apiErrorText } from '@/i18n/apiErrors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { formatDate } from '@/i18n/dates';
import { statusLabel } from '@/types';
import { cn, formatProductWithQuantity } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { useMaxWidth } from '@/hooks/use-mobile';
import {
  apiGetProducts, apiCreateOrder, apiGetCustomerPrefill, apiSaveCustomerProfile, apiGetOrder, apiUpdateCustomer,
  apiSyncOrderItems, apiUpdateOrderStatus, apiAddOrderNote, type CancellationReason, type TrashReason,
} from '@/lib/api';
// Order lines are STORED in EUR; the agent only ever sees denari.
import { formatMoney } from '@/lib/currency';
import { CancellationReasonPicker } from '@/components/CancellationReasonPicker';
import { TrashReasonPicker } from '@/components/TrashReasonPicker';
import { cancelReasonRequiresNote } from '@/lib/cancellationReasons';
import { isTrashSelectionValid } from '@/lib/trashReasons';
import { composeHomeAddress, parseHomeAddress, looksLikeStructuredDetail, resolveDeliveryPrefill, looksLikeCourier } from '@/lib/address';
import { orderFormGaps, profilePatchFromForm, isOfficeDelivery, type OrderFormGap } from '@/lib/orderForm';
import { OrderFormShell, type ShellAction } from '@/components/order/OrderFormShell';
import { OrderProductLines, suggestedFor, linesTotalEur, type ProductLine } from '@/components/order/OrderProductLines';
import { CourierNoteField } from '@/components/order/CourierNoteField';
import { AddressFields } from '@/components/address/AddressFields';
import { MexPreview } from '@/components/address/MexPreview';
import { useAddressResolution, EMPTY_ADDRESS, type AddressDraft } from '@/components/address/useAddressResolution';

type CreateStatus = 'confirmed' | 'call_again' | 'cancelled' | 'trashed' | 'pending';

interface CreateOrderModalProps {
  open: boolean;
  /** Called on close. `created` is true after a successful save; `outcome` is the
   *  chosen status so the caller (Calls page) can mark the queue member and advance. */
  onClose: (created?: boolean, outcome?: CreateStatus, wasManual?: boolean) => void;
  /** Phone to lock + use for pre-fill lookups (opened from a call). */
  prefillPhone?: string;
  prefillName?: string;
  /** Default status. Calls-page confirm flow → 'confirmed'. */
  defaultStatus?: CreateStatus;
  /** Hide the "Исход" picker — the outcome was chosen upstream (/calls → confirmed). */
  hideStatusPicker?: boolean;
  /** Kept for callers; the header now reads "Потврди нарачка · ORD-…" / "Нова нарачка". */
  title?: string;
  /** Complete an EXISTING order instead of creating one (lead / pending confirm):
   *  fields + items in place, then the status flip — never a second order, so the
   *  affiliate sidecar and the DB postback triggers keep pointing at the same id. */
  existingOrderId?: string;
}

// "Исход" — mirrors the Order Editor's outcomes. Cancelled / trash need a reason.
const STATUS_OPTIONS: { value: CreateStatus; labelKey: string; cls: string }[] = [
  { value: 'confirmed',  labelKey: 'status.confirmed',  cls: 'border-green-500/50 text-green-700 data-[on=true]:bg-green-600 data-[on=true]:text-white data-[on=true]:border-green-600' },
  { value: 'call_again', labelKey: 'status.call_again', cls: 'border-sky-500/50 text-sky-700 data-[on=true]:bg-sky-600 data-[on=true]:text-white data-[on=true]:border-sky-600' },
  { value: 'cancelled',  labelKey: 'status.cancelled',  cls: 'border-red-500/50 text-red-700 data-[on=true]:bg-red-600 data-[on=true]:text-white data-[on=true]:border-red-600' },
  { value: 'trashed',    labelKey: 'outcome.trash',     cls: 'border-gray-400/50 text-gray-600 data-[on=true]:bg-gray-600 data-[on=true]:text-white data-[on=true]:border-gray-600' },
  { value: 'pending',    labelKey: 'status.pending',    cls: 'border-amber-500/50 text-amber-700 data-[on=true]:bg-amber-500 data-[on=true]:text-white data-[on=true]:border-amber-500' },
];

function Section({ icon, title, children, gap, collapsible, open, onToggle }: {
  icon: ReactNode; title: string; children: ReactNode; gap?: string;
  collapsible?: boolean; open?: boolean; onToggle?: () => void;
}) {
  const head = (
    <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {collapsible && (open ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />)}
      {icon} {title}
    </span>
  );
  return (
    <section className="min-w-0 rounded-xl border bg-card p-3 md:p-4" data-gap={gap}>
      {collapsible ? (
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-h-9 w-full items-center text-left">{head}</button>
      ) : <h3 className="mb-3">{head}</h3>}
      {(!collapsible || open) && <div className={cn(collapsible && 'mt-2')}>{children}</div>}
    </section>
  );
}

const GAP_KEY: Record<OrderFormGap, string> = {
  name: 'orderForm.gap.name', phone: 'orderForm.gap.phone', products: 'orderForm.gap.products',
  settlement: 'orderForm.gap.settlement', district: 'orderForm.gap.district', street: 'orderForm.gap.street',
  office: 'orderForm.gap.office',
};

export function CreateOrderModal({
  open, onClose, prefillPhone, prefillName, defaultStatus = 'confirmed', hideStatusPicker, existingOrderId,
}: CreateOrderModalProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const narrow = useMaxWidth(1023);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState<AddressDraft>(EMPTY_ADDRESS);
  const resolution = useAddressResolution(address, setAddress);
  const [courierNote, setCourierNote] = useState('');
  const [prevCourierNote, setPrevCourierNote] = useState<string | null>(null);
  const [internalNote, setInternalNote] = useState('');
  const [profileNote, setProfileNote] = useState<string | null>(null);
  const [legacyGift, setLegacyGift] = useState('');
  const [shipAfterDate, setShipAfterDate] = useState<Date | undefined>();
  const [moreOpen, setMoreOpen] = useState(false);
  const [status, setStatus] = useState<CreateStatus>(defaultStatus);
  const [cancellationReason, setCancellationReason] = useState<CancellationReason | null>(null);
  const [cancellationReasonNotes, setCancellationReasonNotes] = useState('');
  const [trashReason, setTrashReason] = useState<TrashReason | null>(null);
  const [trashReasonNotes, setTrashReasonNotes] = useState('');
  const [items, setItems] = useState<ProductLine[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefilling, setPrefilling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingInfo, setSavingInfo] = useState(false);
  const [showGaps, setShowGaps] = useState(false);
  // Which order is being completed — shown in the header, so the agent always
  // knows whether this is the pending lead, a duplicate, or a new order.
  const [existingDisplayId, setExistingDisplayId] = useState<string | null>(null);
  const [existingIsDuplicate, setExistingIsDuplicate] = useState(false);
  // The parcel is already at MEX — the address is a fact at the courier.
  const [addressLocked, setAddressLocked] = useState(false);
  // "Друг клиент": a completely free-form order (any phone, empty fields).
  const [isManualMode, setIsManualMode] = useState(false);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const loadSeq = useRef(0);
  const productsRef = useRef<any[]>([]);
  productsRef.current = products;

  const resetFields = useCallback(() => {
    setName(''); setPhone('');
    setAddress(EMPTY_ADDRESS);
    setCourierNote(''); setPrevCourierNote(null); setInternalNote(''); setProfileNote(null); setLegacyGift('');
    setShipAfterDate(undefined); setMoreOpen(false);
    setStatus(defaultStatus);
    setCancellationReason(null); setCancellationReasonNotes('');
    setTrashReason(null); setTrashReasonNotes('');
    setExistingDisplayId(null); setExistingIsDuplicate(false); setAddressLocked(false);
    setShowGaps(false);
    setItems([]);
  }, [defaultStatus]);

  /**
   * Fill the form for the current customer: products, the saved profile + recent
   * orders (resolved server-side across ALL agents), and — when completing a lead —
   * that order's own data on top. Re-run when "Друг клиент" is switched back off
   * (the old modal cleared the fields and never refilled them).
   */
  const load = useCallback(async () => {
    const my = ++loadSeq.current;
    resetFields();
    setName(prefillName || '');
    setPhone(prefillPhone || '');
    setLoading(true);
    const phoneOk = !!prefillPhone && prefillPhone.replace(/\D/g, '').length >= 6;
    setPrefilling(phoneOk);
    try {
      const [prods, pre, existingOrder] = await Promise.all([
        productsRef.current.length ? Promise.resolve(productsRef.current) : apiGetProducts().catch(() => []),
        phoneOk ? apiGetCustomerPrefill(prefillPhone!).catch(() => ({ profile: null, recent: [] })) : Promise.resolve({ profile: null, recent: [] }),
        existingOrderId ? apiGetOrder(existingOrderId).catch(() => '__load_failed__') : Promise.resolve(null),
      ]) as [any[], { profile: any; recent: any[] }, any];
      if (my !== loadSeq.current) return;
      // A requested order that fails to load must NOT fall through to a blank
      // create form — saving that would fork a second order beside it.
      if (existingOrderId && existingOrder === '__load_failed__') {
        toast({ title: t('createOrder.loadExistingFailed'), variant: 'destructive' });
        onCloseRef.current();
        return;
      }
      const profile = pre?.profile || null;
      const recent: any[] = pre?.recent || [];
      setProducts(prods || []);

      // Default line: the customer's most recent REAL product (skips the '—'
      // placeholder rows), else the first active catalogue product.
      const realProduct = (() => {
        for (const o of recent) {
          const it = (o.order_items || []).find((i: any) => i.product_name);
          if (it) {
            const matchP = (prods || []).find((p: any) => p.id === it.product_id);
            return { product_id: it.product_id ?? null, product_name: matchP?.name || it.product_name, price: Number(it.price_per_unit) || suggestedFor(matchP) };
          }
          if (o.product_name && o.product_name !== '—') {
            const match = (prods || []).find((p: any) => p.name === o.product_name);
            if (match) return { product_id: match.id, product_name: match.name, price: Number(o.price) || suggestedFor(match) };
          }
        }
        return null;
      })();
      if (realProduct) {
        setItems([{ product_id: realProduct.product_id, product_name: realProduct.product_name, quantity: 1, price_per_unit: realProduct.price }]);
      } else {
        const first = (prods || []).find((x: any) => x.is_active) || prods?.[0];
        if (first) setItems([{ product_id: first.id, product_name: first.name, quantity: 1, price_per_unit: suggestedFor(first) }]);
      }

      const last = recent[0] || null;
      const pick = (p: any, l: any) => (p ?? null) || (l ?? null) || '';
      const nm = pick(profile?.customer_name, last?.customer_name);
      if (!prefillName && nm) setName(nm);

      // Address: the profile first, else the most recent HOME order. A new order
      // is always a home delivery — MEX has no pickup points.
      const isHome = (o: any) => !isOfficeDelivery(o?.delivery_type)
        && !looksLikeCourier(`${o?.customer_address || ''} ${o?.customer_city || ''}`);
      const homeSrc = recent.find(isHome) || null;
      const hCityRaw = pick(profile?.city, homeSrc?.customer_city);
      const structuredStreet = pick(profile?.street, homeSrc?.street);
      // Legacy rows kept the whole address in one blob, sometimes in City.
      const cityIsDetail = looksLikeStructuredDetail(hCityRaw);
      const blobToParse = [homeSrc?.customer_address || '', cityIsDetail ? hCityRaw : ''].filter(Boolean).join(', ');
      const cityHint = (looksLikeCourier(hCityRaw) || cityIsDetail) ? '' : hCityRaw;
      const parsed = (!structuredStreet && blobToParse && !looksLikeCourier(blobToParse)) ? parseHomeAddress(blobToParse, cityHint) : null;
      let draft: AddressDraft = {
        ...EMPTY_ADDRESS,
        street: structuredStreet || (parsed?.street ?? ''),
        street_number: pick(profile?.street_number, homeSrc?.street_number) || (parsed?.street_number ?? ''),
        quarter: pick(profile?.quarter, homeSrc?.quarter) || (parsed?.quarter ?? ''),
        apartment: pick(profile?.apartment, homeSrc?.apartment) || (parsed?.apartment ?? ''),
        floor: pick(profile?.floor, homeSrc?.floor) || (parsed?.floor ?? ''),
        block: pick(profile?.block, homeSrc?.block) || (parsed?.block ?? ''),
        entry: pick(profile?.entry, homeSrc?.entry) || (parsed?.entry ?? ''),
        city: cityHint || (parsed?.city ?? ''),
        postal_code: pick(profile?.postal_code, homeSrc?.postal_code) || (parsed?.postal_code ?? ''),
        settlement_id: (profile?.city ? profile?.settlement_id : homeSrc?.settlement_id) || null,
      };

      // "За курирот" starts EMPTY; the previous instruction is a one-tap chip.
      setPrevCourierNote(pick(profile?.delivery_instructions, last?.delivery_instructions) || null);
      // The customer's profile note is shown read-only, never copied into the order.
      setProfileNote(profile?.notes || null);

      // Completing an existing lead: its own data wins over the generic prefill.
      if (existingOrder) {
        setExistingDisplayId(existingOrder.display_id ?? null);
        setExistingIsDuplicate(!!existingOrder.duplicated_from);
        setAddressLocked(!!existingOrder.mex_tracking_id);
        if (existingOrder.customer_name && existingOrder.customer_name !== '—') setName(existingOrder.customer_name);
        const orderItems = (existingOrder.order_items || []).filter((i: any) => i.product_name && i.product_name !== '—');
        if (orderItems.length > 0) {
          setItems(orderItems.map((i: any) => {
            const match = (prods || []).find((p: any) => p.id === i.product_id);
            return {
              product_id: i.product_id ?? null,
              product_name: match?.name || i.product_name,
              quantity: Math.max(1, Number(i.quantity) || 1),
              price_per_unit: Math.max(0, Number(i.price_per_unit) || 0),
            };
          }));
        }
        const hasDelivery = !!(existingOrder.customer_address || existingOrder.customer_city || existingOrder.street || existingOrder.courier_office_code);
        if (hasDelivery) draft = { ...resolveDeliveryPrefill(existingOrder), settlement_id: existingOrder.settlement_id || null };
        if (existingOrder.delivery_instructions) setCourierNote(existingOrder.delivery_instructions);
        if (existingOrder.gift_note) setLegacyGift(existingOrder.gift_note);
        const sad = existingOrder.ship_after_date ? new Date(`${String(existingOrder.ship_after_date).slice(0, 10)}T00:00:00`) : undefined;
        if (sad && !isNaN(sad.getTime())) { setShipAfterDate(sad); setMoreOpen(true); }
        if (existingOrder.gift_note) setMoreOpen(true);
      }
      void resolution.hydrate(draft);
    } finally {
      if (my === loadSeq.current) { setLoading(false); setPrefilling(false); }
    }
    // resolution.hydrate is stable; t/toast are stable enough for a one-shot load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillPhone, prefillName, existingOrderId, resetFields]);

  useEffect(() => {
    if (!open) { setIsManualMode(false); loadSeq.current++; return; }
    void load();
  }, [open, load]);

  const totalPrice = linesTotalEur(items);
  const office = isOfficeDelivery(address.delivery_type);
  const composedAddress = office
    ? `[${address.delivery_type === 'speedy_office' ? 'Speedy' : address.delivery_type === 'mex_office' ? 'MEX' : 'Econt'}] ${address.courier_office_city} — #${address.courier_office_code} ${address.courier_office_name}`.trim()
    : composeHomeAddress(address);

  const gaps = orderFormGaps({
    status, name, phone, itemCount: items.length, address,
    zone: resolution.zone ? { requires_district: resolution.zone.requires_district, district_id: resolution.zone.district_id } : null,
  });
  const visibleGaps = showGaps ? gaps : [];

  const scrollToGap = (gap: OrderFormGap) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="order-form-shell"] [data-gap="${gap}"]`);
    if (!el) return;
    el.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    const focusable = el.matches('button, input, textarea') ? el : el.querySelector<HTMLElement>('button, input, textarea');
    focusable?.focus?.({ preventScroll: true });
  };

  const profilePatch = () => profilePatchFromForm({
    phone, name,
    address: { ...address, city: address.city, postal_code: address.postal_code },
  });

  // "Зачувај го клиентот" — FILL-ONLY on the server: a blank never overwrites.
  const handleSaveInfo = async () => {
    if (savingInfo || saving) return;
    if (!phone.trim()) {
      toast({ title: t('createOrder.phoneRequired'), variant: 'destructive' });
      return;
    }
    setSavingInfo(true);
    try {
      await apiSaveCustomerProfile(profilePatch());
      toast({ title: t('createOrder.infoSaved'), description: t('createOrder.infoSavedDesc') });
    } catch (err: any) {
      toast({ title: t('createOrder.infoSaveFailed'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setSavingInfo(false);
    }
  };

  const handleSave = async () => {
    if (saving) return;
    if (gaps.length) {
      setShowGaps(true);
      scrollToGap(gaps[0]);
      return;
    }
    if (status === 'cancelled' && !cancellationReason) {
      toast({ title: t('orderModal.cancelReasonRequired'), description: t('orderModal.cancelReasonRequiredDesc'), variant: 'destructive' });
      return;
    }
    if (status === 'cancelled' && cancelReasonRequiresNote(cancellationReason) && !cancellationReasonNotes.trim()) {
      toast({ title: t('orderModal.cancelNoteRequired'), description: t('orderModal.cancelNoteRequiredDesc'), variant: 'destructive' });
      return;
    }
    if (status === 'trashed' && !trashReason) {
      toast({ title: t('orderModal.trashReasonRequired'), description: t('orderModal.trashReasonRequiredDesc'), variant: 'destructive' });
      return;
    }
    if (status === 'trashed' && !isTrashSelectionValid(trashReason, trashReasonNotes)) {
      toast({ title: t('orderModal.trashNoteRequired'), description: t('orderModal.trashNoteRequiredDesc'), variant: 'destructive' });
      return;
    }

    const addressFields = {
      customer_address: composedAddress,
      customer_city: address.city.trim(),
      postal_code: address.postal_code.trim(),
      street: address.street.trim(),
      street_number: address.street_number.trim(),
      quarter: address.quarter.trim(),
      apartment: address.apartment.trim(),
      floor: address.floor.trim(),
      block: address.block.trim(),
      entry: address.entry.trim(),
      settlement_id: address.settlement_id,
      delivery_type: address.delivery_type,
      home_courier: address.home_courier,
      courier_office_code: address.courier_office_code,
      courier_office_name: address.courier_office_name,
      courier_office_city: address.courier_office_city,
    };
    const lines = items.map((i) => ({
      product_id: i.product_id,
      product_name: i.product_name,
      quantity: Math.max(1, i.quantity),
      price_per_unit: Math.max(0, i.price_per_unit),
    }));
    const productName = items.map((i) => formatProductWithQuantity(i.product_name, i.quantity)).join(', ') || '—';
    const quantity = items.reduce((s, i) => s + i.quantity, 0);
    const shipAfter = shipAfterDate ? format(shipAfterDate, 'yyyy-MM-dd') : null;
    // Confirming also remembers the customer — fill-only, never blocking.
    const mergeProfile = () => {
      if (status === 'confirmed' && phone.trim()) void apiSaveCustomerProfile(profilePatch()).catch(() => {});
    };

    setSaving(true);
    try {
      if (existingOrderId && !isManualMode) {
        // Complete the EXISTING order in place: fields, items, then the status flip
        // (the status endpoint's completeness gate expects the fields first). The
        // phone is locked here and never sent — the stored E.164 stays.
        await apiUpdateCustomer(existingOrderId, {
          customer_name: name.trim(),
          ...(addressLocked ? {} : addressFields),
          delivery_instructions: courierNote.trim(),
          ship_after_date: shipAfter,
          price: totalPrice,
          quantity,
          product_name: productName,
        });
        await apiSyncOrderItems(existingOrderId, lines);
        if (internalNote.trim()) {
          try { await apiAddOrderNote(existingOrderId, internalNote.trim()); } catch { /* best effort */ }
        }
        if (status !== 'pending') {
          let extras: Record<string, string | undefined> | undefined;
          if (status === 'cancelled' && cancellationReason) {
            extras = { cancellation_reason: cancellationReason, cancellation_reason_notes: cancellationReasonNotes.trim() || undefined };
          } else if (status === 'trashed' && trashReason) {
            extras = { trash_reason: trashReason, trash_reason_notes: trashReasonNotes.trim() || undefined };
          }
          await apiUpdateOrderStatus(existingOrderId, status, extras);
        }
        mergeProfile();
        toast({ title: t('createOrder.orderCompleted'), description: t('createOrder.statusDesc', { status: statusLabel(status) }) });
        onClose(true, status, false);
        return;
      }

      await apiCreateOrder({
        product_name: productName,
        customer_name: name.trim(),
        customer_phone: phone.trim(),
        ...addressFields,
        delivery_instructions: courierNote.trim(),
        ship_after_date: shipAfter,
        price: totalPrice,
        quantity,
        status,
        ...(status === 'cancelled' && cancellationReason ? {
          cancellation_reason: cancellationReason,
          cancellation_reason_notes: cancellationReasonNotes.trim() || undefined,
        } : {}),
        ...(status === 'trashed' && trashReason ? {
          trash_reason: trashReason,
          trash_reason_notes: trashReasonNotes.trim() || undefined,
        } : {}),
        notes: internalNote.trim() || undefined,
        items: lines,
      });
      mergeProfile();
      toast({
        title: t('createOrder.orderCreated'),
        description: status === 'pending' ? t('createOrder.managerReview') : t('createOrder.statusDesc', { status: statusLabel(status) }),
      });
      onClose(true, status, isManualMode);
    } catch (err: any) {
      // Includes the anti-fork 409: "This customer already has an open lead …".
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const toggleManual = () => {
    if (!isManualMode) {
      loadSeq.current++;
      resetFields();
      setIsManualMode(true);
    } else {
      setIsManualMode(false);
      void load();
    }
  };

  const phoneLocked = !!prefillPhone && !isManualMode;
  const title = existingOrderId && !isManualMode
    ? (existingDisplayId ? t('orderForm.titleConfirm', { id: existingDisplayId }) : t('orderForm.titleConfirmPlain'))
    : t('orderForm.titleNew');

  const subtitle = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {phoneLocked && <span className="font-mono text-primary">{prefillPhone}</span>}
      {existingIsDuplicate && !isManualMode && (
        <span className="rounded border border-indigo-200 bg-indigo-50 px-1 py-0.5 text-[10px] text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300">
          {t('status.duplicated')}
        </span>
      )}
      {prefilling && <span>{t('orderForm.loadingPrior')}</span>}
      {isManualMode && <span className="text-amber-700 dark:text-amber-300">{t('orderForm.otherCustomerHint')}</span>}
    </span>
  );

  const headerExtra = (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('orderForm.namePlaceholder')}
        aria-label={t('orderForm.namePlaceholder')}
        data-gap="name"
        aria-invalid={visibleGaps.includes('name') || undefined}
        className={cn('h-11 min-w-0 flex-1 text-base md:h-9 md:text-sm', visibleGaps.includes('name') && 'border-destructive')}
      />
      {!phoneLocked && (
        <Input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+389…"
          aria-label={t('orderForm.phonePlaceholder')}
          data-gap="phone"
          inputMode="tel"
          className={cn('h-11 min-w-0 font-mono text-base sm:w-44 md:h-9 md:text-sm', visibleGaps.includes('phone') && 'border-destructive')}
        />
      )}
      {prefillPhone && (
        <Button type="button" variant={isManualMode ? 'default' : 'outline'} size="sm" onClick={toggleManual} className="h-11 shrink-0 gap-1.5 md:h-9">
          <UserRound className="h-3.5 w-3.5" aria-hidden />
          {isManualMode ? t('orderForm.backToCustomer') : t('orderForm.otherCustomer')}
        </Button>
      )}
    </div>
  );

  const mexDraft = useMemo(() => ({
    display_id: existingDisplayId ?? '',
    customer_name: name,
    customer_phone: phone,
    ...address,
    customer_address: composedAddress,
    customer_city: address.city,
    mex_city_name: resolution.zone?.mex_city_name ?? '',
    delivery_instructions: courierNote,
    price: totalPrice,
  }), [existingDisplayId, name, phone, address, composedAddress, resolution.zone?.mex_city_name, courierNote, totalPrice]);

  const productsSec = (
    <Section key="products" icon={<ShoppingCart className="h-3.5 w-3.5" aria-hidden />} title={t('orderForm.section.products')}>
      <OrderProductLines items={items} onChange={setItems} products={products} loading={loading} invalid={visibleGaps.includes('products')} />
    </Section>
  );
  const addressSec = (
    <Section key="address" icon={<MapPin className="h-3.5 w-3.5" aria-hidden />} title={t('orderForm.section.address')}>
      <div className="space-y-3">
        <AddressFields value={address} onChange={setAddress} resolution={resolution} gaps={visibleGaps} locked={addressLocked} />
        {!office && !addressLocked && <MexPreview draft={mexDraft} />}
      </div>
    </Section>
  );
  const courierSec = (
    <Section key="courier" icon={<Truck className="h-3.5 w-3.5" aria-hidden />} title={t('orderForm.section.courier')}>
      <CourierNoteField
        value={courierNote}
        onChange={setCourierNote}
        previous={prevCourierNote}
        internalNote={internalNote}
        onInternalNoteChange={setInternalNote}
        profileNote={profileNote}
      />
    </Section>
  );
  const moreSec = (
    <Section key="more" icon={<CalendarIcon className="h-3.5 w-3.5" aria-hidden />} title={t('orderForm.section.more')} collapsible open={moreOpen} onToggle={() => setMoreOpen((o) => !o)}>
      <div className="space-y-3">
        <div className="space-y-1">
          <span className="block text-xs font-medium text-muted-foreground">{t('createOrder.shipAfterOptional')}</span>
          <p className="text-[11px] text-muted-foreground">{t('createOrder.shipAfterHint')}</p>
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className={cn('h-11 flex-1 justify-start gap-1.5 font-normal md:h-9', !shipAfterDate && 'text-muted-foreground')}>
                  <CalendarIcon className="h-3.5 w-3.5" aria-hidden />
                  {shipAfterDate ? formatDate(shipAfterDate, 'PPP') : t('createOrder.shipAsap')}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={shipAfterDate}
                  onSelect={setShipAfterDate}
                  disabled={(d) => d < new Date(new Date().setHours(0, 0, 0, 0))}
                  className="pointer-events-auto p-3"
                />
              </PopoverContent>
            </Popover>
            {shipAfterDate && (
              <Button variant="ghost" size="sm" className="h-11 md:h-9" onClick={() => setShipAfterDate(undefined)}>{t('common.clear')}</Button>
            )}
          </div>
        </div>
        {legacyGift && (
          <div className="flex items-start gap-1.5 rounded-md border bg-muted/30 px-2.5 py-1.5 text-xs" data-testid="legacy-gift">
            <Gift className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 break-words"><span className="text-muted-foreground">{t('orderForm.giftReadOnly')}:</span> {legacyGift}</span>
          </div>
        )}
      </div>
    </Section>
  );
  const outcomeSec = hideStatusPicker ? null : (
    <Section key="outcome" icon={<ListChecks className="h-3.5 w-3.5" aria-hidden />} title={t('orderForm.section.outcome')}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            data-on={status === opt.value}
            onClick={() => setStatus(opt.value)}
            className={cn(
              'min-h-11 rounded-lg border-2 px-2 py-2 text-sm font-medium transition-all md:min-h-9 md:text-xs',
              status === opt.value ? `${opt.cls} shadow-sm ring-2 ring-primary/30` : 'border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground',
            )}
          >
            {t(opt.labelKey)}
          </button>
        ))}
      </div>
      {status === 'cancelled' && (
        <div className="mt-3">
          <CancellationReasonPicker value={cancellationReason} notes={cancellationReasonNotes} onChange={setCancellationReason} onNotesChange={setCancellationReasonNotes} />
        </div>
      )}
      {status === 'trashed' && (
        <div className="mt-3">
          <TrashReasonPicker idPrefix="create-order-trash" value={trashReason} notes={trashReasonNotes} onChange={setTrashReason} onNotesChange={setTrashReasonNotes} />
        </div>
      )}
    </Section>
  );

  const secondary: ShellAction[] = [
    { key: 'cancel', label: t('common.cancel'), onClick: () => onClose() },
    { key: 'save-customer', label: t('orderForm.saveCustomer'), onClick: handleSaveInfo, icon: <Save className="mr-1.5 h-3.5 w-3.5" aria-hidden />, disabled: savingInfo || saving, loading: savingInfo },
  ];
  const primaryLabel = status === 'confirmed' ? t('orderForm.confirm') : t('orderForm.save');

  const notice = visibleGaps.length > 0 ? (
    <span className="text-red-700 dark:text-red-300" role="alert" data-testid="order-form-missing">
      {t('orderForm.missing', { list: visibleGaps.map((g) => t(GAP_KEY[g])).join(', ') })}
    </span>
  ) : null;

  return (
    <OrderFormShell
      open={open}
      onClose={() => onClose()}
      title={title}
      subtitle={subtitle}
      headerExtra={headerExtra}
      total={formatMoney(totalPrice)}
      primary={{ key: 'primary', label: primaryLabel, onClick: handleSave, disabled: saving || savingInfo || loading, loading: saving }}
      secondary={secondary}
      notice={notice}
      wide
    >
      {narrow ? (
        <div className="space-y-3">{productsSec}{addressSec}{courierSec}{moreSec}{outcomeSec}</div>
      ) : (
        <div className="grid grid-cols-2 items-start gap-4">
          <div className="min-w-0 space-y-4">{productsSec}{courierSec}{moreSec}</div>
          <div className="min-w-0 space-y-4">{addressSec}{outcomeSec}</div>
        </div>
      )}
    </OrderFormShell>
  );
}
