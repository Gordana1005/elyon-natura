import { useState, useEffect } from 'react';
import { apiErrorText } from '@/i18n/apiErrors';
import { X, Plus, Trash2, Loader2, ShoppingCart, Gift, Info, CalendarIcon, Cake, Truck, Save, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProductCombobox } from '@/components/ProductCombobox';
import { Calendar } from '@/components/ui/calendar';
import { format } from 'date-fns'; // machine 'yyyy-MM-dd' payloads only
import { useTranslation } from 'react-i18next';
import { formatDate } from '@/i18n/dates';
import { statusLabel } from '@/types';
import { cn } from '@/lib/utils';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/hooks/use-toast';
import { apiGetProducts, apiCreateOrder, apiGetCustomerPrefill, apiSaveCustomerProfile, apiMatchCourierOffice, apiGetOrder, apiUpdateCustomer, apiSyncOrderItems, apiUpdateOrderStatus, apiAddOrderNote, type CancellationReason, type TrashReason } from '@/lib/api';
import { formatProductWithQuantity, isLegacyPromoName } from '@/lib/utils';
// Order lines are STORED in EUR; the agent only ever sees and types denari.
// eurToDen/denToEur convert at the input boundary — never let a euro figure
// reach the screen.
import { formatMoney, eurToDen, denToEur } from '@/lib/currency';
import { DeliveryMethodPicker, type DeliveryValue } from '@/components/DeliveryMethodPicker';
import { CancellationReasonPicker } from '@/components/CancellationReasonPicker';
import { TrashReasonPicker } from '@/components/TrashReasonPicker';
import { cancelReasonRequiresNote } from '@/lib/cancellationReasons';
import { isTrashSelectionValid } from '@/lib/trashReasons';
import { composeHomeAddress, parseHomeAddress, looksLikeStructuredDetail, resolveDeliveryPrefill } from '@/lib/address';

type CreateStatus = 'confirmed' | 'call_again' | 'cancelled' | 'trashed' | 'pending';

interface ProductItem {
  product_id: string | null;
  product_name: string;
  quantity: number;
  price_per_unit: number;
}

/** Agent-facing default unit price for a product: the server-computed
 *  suggested_price (= max(cost×3, catalogue price, €15)); falls back to
 *  max(catalogue price, €15) so a line never defaults to €0. The agent can
 *  still edit it freely (up or down). Cost is never exposed to the client. */
const PRICE_FLOOR = 15;
const suggestedFor = (p: any): number =>
  Number(p?.suggested_price) || Math.max(Number(p?.price) || 0, PRICE_FLOOR);

interface CreateOrderModalProps {
  open: boolean;
  /** Called on close. `created` is true after a successful create; `outcome`
   *  is the chosen status so the caller (Calls page) can mark the queue
   *  member and advance to the next customer. */
  onClose: (created?: boolean, outcome?: CreateStatus, wasManual?: boolean) => void;
  /** Phone to lock + use for pre-fill lookups (e.g. when opened from a call). */
  prefillPhone?: string;
  prefillName?: string;
  /** Default status. Calls-page confirm flow → 'confirmed'. */
  defaultStatus?: CreateStatus;
  /** Hide the "What happened?" status picker — used when the outcome was
   *  already chosen upstream (e.g. Choose Answer → Confirmed). The order is
   *  always created with `defaultStatus`. */
  hideStatusPicker?: boolean;
  /** Header text override — e.g. "Confirm Order — +389..." */
  title?: string;
  /** Complete an EXISTING order instead of creating a new one (lead/pending
   *  confirm flow). Saving updates that order's fields + items in place and
   *  then flips its status — never a second order, so the affiliate sidecar
   *  and the DB postback triggers keep pointing at the same order id. */
  existingOrderId?: string;
}

// What the agent picks — mirrors the Order Editor's outcomes. Cancelled
// requires a structured reason (segment routing).
// Labels resolved at render via t(labelKey).
const STATUS_OPTIONS: { value: CreateStatus; labelKey: string; cls: string }[] = [
  { value: 'confirmed',  labelKey: 'status.confirmed',  cls: 'border-green-500/50 text-green-700 data-[on=true]:bg-green-600 data-[on=true]:text-white data-[on=true]:border-green-600' },
  { value: 'call_again', labelKey: 'status.call_again', cls: 'border-sky-500/50 text-sky-700 data-[on=true]:bg-sky-600 data-[on=true]:text-white data-[on=true]:border-sky-600' },
  { value: 'cancelled',  labelKey: 'status.cancelled',  cls: 'border-red-500/50 text-red-700 data-[on=true]:bg-red-600 data-[on=true]:text-white data-[on=true]:border-red-600' },
  { value: 'trashed',    labelKey: 'outcome.trash',     cls: 'border-gray-400/50 text-gray-600 data-[on=true]:bg-gray-600 data-[on=true]:text-white data-[on=true]:border-gray-600' },
  { value: 'pending',    labelKey: 'status.pending',    cls: 'border-amber-500/50 text-amber-700 data-[on=true]:bg-amber-500 data-[on=true]:text-white data-[on=true]:border-amber-500' },
];

export function CreateOrderModal({
  open, onClose, prefillPhone, prefillName, defaultStatus = 'confirmed', hideStatusPicker, title, existingOrderId,
}: CreateOrderModalProps) {
  const { t } = useTranslation();
  const { toast } = useToast();

  // Customer
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  // Delivery method (Phase 6 — Speedy/Econt courier office picker, or home address)
  const [delivery, setDelivery] = useState<DeliveryValue>({
    delivery_type: 'home',
    street: '', street_number: '', quarter: '', apartment: '', floor: '', block: '', entry: '', city: '', postal_code: '',
    home_courier: 'mex',
    courier_office_code: '', courier_office_name: '', courier_office_city: '',
  });

  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [giftNote, setGiftNote] = useState('');
  const [shipAfterDate, setShipAfterDate] = useState<Date | undefined>();
  const [birthday, setBirthday] = useState<Date | undefined>();

  const [notes, setNotes] = useState('');
  const [status, setStatus] = useState<CreateStatus>(defaultStatus);
  const [cancellationReason, setCancellationReason] = useState<CancellationReason | null>(null);
  const [cancellationReasonNotes, setCancellationReasonNotes] = useState('');
  // Trash twin — no order may be junked without a reason, from any surface.
  const [trashReason, setTrashReason] = useState<TrashReason | null>(null);
  const [trashReasonNotes, setTrashReasonNotes] = useState('');
  const [items, setItems] = useState<ProductItem[]>([]);
  // Raw string while a line-total is being typed, so the input isn't reformatted
  // mid-keystroke (the .toFixed display only re-applies on blur).
  const [totalDraft, setTotalDraft] = useState<Record<number, string>>({});
  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefilling, setPrefilling] = useState(false);
  // Original courier address text from the customer's last order, shown as a
  // copy-friendly hint when we can't auto-pick the exact office from prose.
  const [deliveryHint, setDeliveryHint] = useState('');
  const [saving, setSaving] = useState(false);
  const [savingInfo, setSavingInfo] = useState(false);
  // Which order is being completed, shown in the header. Without it the modal
  // looked identical whether it was completing the pending lead, a duplicate, or
  // creating a new order — which is how the wrong order got confirmed.
  const [existingDisplayId, setExistingDisplayId] = useState<string | null>(null);
  const [existingIsDuplicate, setExistingIsDuplicate] = useState(false);

  // Manual mode: when true, the agent is creating a completely free-form order
  // (phone, name, address etc. are fully editable). Only relevant when the modal
  // was opened with a prefillPhone from the Calls page.
  const [isManualMode, setIsManualMode] = useState(false);

  // On open: reset, fetch products, optionally prefill from prior orders for this phone.
  useEffect(() => {
    if (!open) {
      setIsManualMode(false);
      return;
    }

    setName(prefillName || '');
    setPhone(prefillPhone || '');
    setDelivery({
      delivery_type: 'home',
      street: '', street_number: '', quarter: '', apartment: '', floor: '', block: '', entry: '', city: '', postal_code: '',
      home_courier: 'mex',
      courier_office_code: '', courier_office_name: '', courier_office_city: '',
    });
    setDeliveryInstructions(''); setGiftNote('');
    setShipAfterDate(undefined);
    setBirthday(undefined);
    setNotes('');
    setStatus(defaultStatus);
    setExistingDisplayId(null);
    setExistingIsDuplicate(false);
    setCancellationReason(null);
    setCancellationReasonNotes('');
    setDeliveryHint('');
    setItems([]);
    setLoading(true);

    // Fetch products + (when we have a phone) the saved profile and the
    // customer's recent orders together, so the default product line can be
    // the customer's PAST product rather than the first item in the catalogue.
    const phoneOk = !!prefillPhone && prefillPhone.replace(/\D/g, '').length >= 6;
    setPrefilling(phoneOk);
    Promise.all([
      apiGetProducts().catch(() => []),
      phoneOk ? apiGetCustomerPrefill(prefillPhone!).catch(() => ({ profile: null, recent: [] })) : Promise.resolve({ profile: null, recent: [] }),
      existingOrderId ? apiGetOrder(existingOrderId).catch(() => '__load_failed__') : Promise.resolve(null),
    ])
      .then(([prods, pre, existingOrder]: [any[], { profile: any; recent: any[] }, any]) => {
        // A requested existing order that fails to load must NOT fall through to a
        // blank create form — saving that would fork a second order beside the one
        // we were asked to complete. Surface the failure and close instead.
        if (existingOrderId && existingOrder === '__load_failed__') {
          toast({ title: t('createOrder.loadExistingFailed'), variant: 'destructive' });
          onClose();
          return;
        }
        const profile = pre?.profile || null;
        const recent = pre?.recent || [];
        setProducts(prods || []);

        // ── Default product line: customer's most recent REAL product ──
        // (skips the '—' placeholder rows cancel/trash records create). Falls
        // back to the first active catalogue product for brand-new customers.
        const realProduct = (() => {
          for (const o of recent || []) {
            const items = o.order_items || [];
            const it = items.find((i: any) => i.product_name);
            if (it) {
              const matchP = (prods || []).find((p: any) => p.id === it.product_id);
              // Prefer the official current catalogue name (warehouse name) over whatever was stored
              const cleanName = matchP?.name || it.product_name;
              return { product_id: it.product_id ?? null, product_name: cleanName, price: Number(it.price_per_unit) || suggestedFor(matchP) };
            }
            if (o.product_name && o.product_name !== '—') {
              const match = (prods || []).find((p: any) => p.name === o.product_name);
              if (match) {
                return { product_id: match.id, product_name: match.name, price: Number(o.price) || suggestedFor(match) };
              }
              // Dirty/legacy/non-catalogue name from website promo etc. — do not propagate it.
              // Agent will choose clean product(s) during the call. Default to first active instead.
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

        // ── Customer fields: profile wins, else most recent order ──
        const last = (recent || [])[0] || null;
        const pick = (p: any, l: any) => (p ?? null) || (l ?? null) || '';

        const nm = pick(profile?.customer_name, last?.customer_name);
        if (!prefillName && nm) setName(nm);

        // ── Smart delivery prefill — fill BOTH sides ──
        // A customer may have ordered to a home address on some orders and to
        // an Econt/Speedy office on others. We pre-fill BOTH the home fields
        // (from their most recent home order) AND the courier office (from
        // their most recent courier order), so the agent just picks the tab for
        // THIS order and the data is already there. The default tab is the most
        // recent order's type.
        const courierFromText = (s?: string): DeliveryValue['delivery_type'] | null => {
          if (!s) return null;
          if (/еконт|econt/i.test(s)) return 'econt_office';
          if (/спиди|speedy/i.test(s)) return 'speedy_office';
          return null;
        };
        const orderType = (o: any): DeliveryValue['delivery_type'] => {
          if (o?.delivery_type === 'speedy_office' || o?.delivery_type === 'econt_office') return o.delivery_type;
          return courierFromText(`${o?.customer_address || ''} ${o?.customer_city || ''}`) || 'home';
        };
        const homeSrc = (recent || []).find((o: any) => orderType(o) === 'home') || null;
        const courierSrc = (recent || []).find((o: any) => orderType(o) !== 'home') || null;
        const defaultType: DeliveryValue['delivery_type'] = last ? orderType(last)
          : (profile?.delivery_type as DeliveryValue['delivery_type']) || 'home';

        // Home side — profile first, else most recent home order. Never courier text.
        const hCityRaw = pick(profile?.city, homeSrc?.customer_city);
        const structuredStreet = pick(profile?.street, homeSrc?.street);
        // Legacy rows stored the whole address as one blob with empty structured
        // columns — sometimes in customer_address, sometimes crammed into the City
        // field (e.g. "жк Тракия, бл 183, вх Г, ет. 4, ап 12"). Detect the latter
        // and fold it into the blob we parse, so each part lands in its own field
        // instead of dumping the whole thing into City.
        const cityIsDetail = looksLikeStructuredDetail(hCityRaw);
        const hAddrRaw = homeSrc?.customer_address || '';
        const blobToParse = [hAddrRaw, cityIsDetail ? hCityRaw : ''].filter(Boolean).join(', ');
        // A clean (non-courier, non-blob) City value is kept as-is; otherwise we
        // rely on whatever the parser mines from the blob.
        const cityHint = (courierFromText(hCityRaw) || cityIsDetail) ? '' : hCityRaw;
        const parsed = (!structuredStreet && blobToParse && !courierFromText(blobToParse))
          ? parseHomeAddress(blobToParse, cityHint)
          : null;
        const homeVals = {
          street: structuredStreet || (parsed?.street ?? ''),
          street_number: pick(profile?.street_number, homeSrc?.street_number) || (parsed?.street_number ?? ''),
          quarter: pick(profile?.quarter, homeSrc?.quarter) || (parsed?.quarter ?? ''),
          apartment: pick(profile?.apartment, homeSrc?.apartment) || (parsed?.apartment ?? ''),
          floor: pick(profile?.floor, homeSrc?.floor) || (parsed?.floor ?? ''),
          block: pick(profile?.block, homeSrc?.block) || (parsed?.block ?? ''),
          entry: pick(profile?.entry, homeSrc?.entry) || (parsed?.entry ?? ''),
          city: cityHint || (parsed?.city ?? ''),
          postal_code: pick(profile?.postal_code, homeSrc?.postal_code) || (parsed?.postal_code ?? ''),
          // MEX is the Macedonian carrier and the default. A stored Bulgarian
          // courier is preserved verbatim so a legacy customer still shows the
          // one that really carried their order.
          home_courier: ((c) => (c === 'speedy' || c === 'econt' ? c : 'mex'))(
            pick(profile?.home_courier, homeSrc?.home_courier)
          ) as 'speedy' | 'econt' | 'mex',
        };

        // Courier side — profile (if courier) first, else most recent courier order.
        const profCourier = profile?.courier_office_code ? profile : null;
        const courierVals = {
          courier_office_code: pick(profCourier?.courier_office_code, courierSrc?.courier_office_code),
          courier_office_name: pick(profCourier?.courier_office_name, courierSrc?.courier_office_name),
          courier_office_city: pick(profCourier?.courier_office_city, courierSrc?.courier_office_city),
        };

        setDelivery({ delivery_type: defaultType, ...homeVals, ...courierVals });

        // If the courier order has no resolved office code, surface its original
        // text so the agent can pick it (and the matcher effect can auto-fill).
        if (courierSrc && !courierVals.courier_office_code) {
          const hintText = [courierSrc.customer_address, courierSrc.customer_city]
            .filter((t: any) => t && courierFromText(t))[0]
            || courierSrc.customer_address || courierSrc.customer_city || '';
          setDeliveryHint(hintText);
        }

        const di = pick(profile?.delivery_instructions, last?.delivery_instructions);
        if (di) setDeliveryInstructions(di);
        const gn = pick(profile?.gift_note, last?.gift_note);
        if (gn) setGiftNote(gn);
        if (profile?.notes) setNotes(profile.notes);

        const bday = profile?.birthday || last?.birthday;
        if (bday) {
          const d = new Date(bday + 'T00:00:00');
          if (!isNaN(d.getTime())) setBirthday(d);
        }

        // ── Existing-order overlay (lead/pending confirm flow) ──
        // The lead's own data wins over the generic profile prefill, but a
        // sparse webhook lead keeps the smart prefill for whatever it lacks.
        if (existingOrder) {
          setExistingDisplayId(existingOrder.display_id ?? null);
          setExistingIsDuplicate(!!existingOrder.duplicated_from);
          const parseDay = (s?: string | null) => {
            if (!s) return undefined;
            const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
            return isNaN(d.getTime()) ? undefined : d;
          };
          if (existingOrder.customer_name && existingOrder.customer_name !== '—') {
            setName(existingOrder.customer_name);
          }
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
          const hasDelivery = !!(existingOrder.customer_address || existingOrder.customer_city
            || existingOrder.street || existingOrder.courier_office_code);
          if (hasDelivery) setDelivery(resolveDeliveryPrefill(existingOrder));
          if (existingOrder.delivery_instructions) setDeliveryInstructions(existingOrder.delivery_instructions);
          if (existingOrder.gift_note) setGiftNote(existingOrder.gift_note);
          const sad = parseDay(existingOrder.ship_after_date);
          if (sad) setShipAfterDate(sad);
          const ob = parseDay(existingOrder.birthday);
          if (ob) setBirthday(ob);
        }
      })
      .catch(() => {})
      .finally(() => { setLoading(false); setPrefilling(false); });
  }, [open, prefillPhone, prefillName, defaultStatus, existingOrderId]);

  // When we have a free-text courier address but no resolved office, try to
  // match it against our cached office list and auto-fill the office (code +
  // name + city). The hint stays visible so the agent can verify/correct.
  useEffect(() => {
    if (!deliveryHint || delivery.courier_office_code) return;
    // Detect the courier from the hint text itself (not the active tab) so the
    // office fills even when Home is the default tab — courier-scoped match.
    const courier = /еконт|econt/i.test(deliveryHint) ? 'econt'
      : /спиди|speedy/i.test(deliveryHint) ? 'speedy' : null;
    if (!courier) return;
    let cancelled = false;
    apiMatchCourierOffice(courier, deliveryHint)
      .then(matches => {
        if (cancelled || !matches?.length) return;
        const best = matches[0];
        // Require ≥2 token hits so we don't auto-pick on a single weak match.
        if (best.score >= 2) {
          setDelivery(d => ({
            ...d,
            courier_office_code: best.office_code,
            courier_office_name: best.name,
            courier_office_city: best.city,
          }));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deliveryHint]);

  // Save customer info (birthday / address / delivery / notes) WITHOUT
  // creating an order. Upserts the per-phone customer_profiles row. Keeps the
  // modal open so the agent can keep editing or go on to create an order.
  const handleSaveInfo = async () => {
    if (savingInfo || saving) return;
    if (!phone.trim()) {
      toast({ title: t('createOrder.phoneRequired'), variant: 'destructive' });
      return;
    }
    setSavingInfo(true);
    try {
      await apiSaveCustomerProfile({
        phone: phone.trim(),
        customer_name: name.trim() || null,
        birthday: birthday ? format(birthday, 'yyyy-MM-dd') : null,
        street: delivery.street.trim() || null,
        street_number: delivery.street_number.trim() || null,
        quarter: delivery.quarter.trim() || null,
        apartment: delivery.apartment.trim() || null,
        floor: delivery.floor.trim() || null,
        block: delivery.block.trim() || null,
        entry: delivery.entry.trim() || null,
        city: delivery.city.trim() || null,
        postal_code: delivery.postal_code.trim() || null,
        delivery_type: delivery.delivery_type,
        home_courier: delivery.home_courier,
        courier_office_code: delivery.courier_office_code || null,
        courier_office_name: delivery.courier_office_name || null,
        courier_office_city: delivery.courier_office_city || null,
        delivery_instructions: deliveryInstructions.trim() || null,
        gift_note: giftNote.trim() || null,
        notes: notes.trim() || null,
      });
      toast({ title: t('createOrder.infoSaved'), description: t('createOrder.infoSavedDesc') });
    } catch (err: any) {
      toast({ title: t('createOrder.infoSaveFailed'), description: err?.message, variant: 'destructive' });
    } finally {
      setSavingInfo(false);
    }
  };

  const addItem = () => {
    const p = products.find(x => x.is_active) || products[0];
    if (!p) return;
    setItems(prev => [...prev, { product_id: p.id, product_name: p.name, quantity: 1, price_per_unit: suggestedFor(p) }]);
  };

  const updateItem = (idx: number, field: string, value: any) => {
    setItems(prev => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: value };
      return copy;
    });
  };

  const changeProduct = (idx: number, productId: string) => {
    const p = products.find(x => x.id === productId);
    if (!p) return;
    setItems(prev => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], product_id: productId, product_name: p.name, price_per_unit: suggestedFor(p) };
      return copy;
    });
  };

  const removeItem = (idx: number) => setItems(prev => prev.filter((_, i) => i !== idx));

  // Let the agent type the LINE TOTAL; back-fill per-unit = total / qty.
  // price_per_unit stays the stored source of truth so qty changes recompute.
  const setLineTotal = (idx: number, total: number) => {
    setItems(prev => {
      const copy = [...prev];
      const qty = Math.max(1, copy[idx].quantity);
      copy[idx] = { ...copy[idx], price_per_unit: Math.max(0, total) / qty };
      return copy;
    });
  };

  const totalPrice = items.reduce((s, i) => s + Math.max(1, i.quantity) * Math.max(0, i.price_per_unit), 0);

  // Concatenated address for legacy customer_address column. Kept in sync so
  // the existing Orders list (single-line) keeps showing something readable.
  // For courier-office orders this becomes the office summary instead.
  const composedAddress = delivery.delivery_type === 'home'
    ? composeHomeAddress(delivery)
    : `[${delivery.delivery_type === 'speedy_office' ? 'Speedy' : delivery.delivery_type === 'mex_office' ? 'MEX' : 'Econt'}] ${delivery.courier_office_city} — #${delivery.courier_office_code} ${delivery.courier_office_name}`.trim();

  const handleSave = async () => {
    if (saving) return;
    if (!name.trim()) {
      toast({ title: t('createOrder.nameRequired'), variant: 'destructive' });
      return;
    }
    if (!phone.trim()) {
      toast({ title: t('createOrder.phoneRequired'), variant: 'destructive' });
      return;
    }
    // Products are only mandatory when the customer actually ordered.
    // Cancelled / Trash / Call Again / Pending can be recorded without a sale.
    if (status === 'confirmed' && items.length === 0) {
      toast({ title: t('createOrder.addOneProduct'), variant: 'destructive' });
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

    setSaving(true);
    try {
      if (existingOrderId && !isManualMode) {
        // Lead/pending confirm: complete the EXISTING order in place — fields
        // first, then items, then the status flip (the status endpoint's
        // completeness gate expects the fields to already be there). The same
        // order id keeps the affiliate sidecar + postback triggers intact.
        // Phone is deliberately not sent: it's locked in this mode and the
        // stored E.164 value must never be overwritten with display text.
        await apiUpdateCustomer(existingOrderId, {
          customer_name: name.trim(),
          customer_address: composedAddress,
          customer_city: delivery.city.trim(),
          postal_code: delivery.postal_code.trim(),
          street: delivery.street.trim(),
          street_number: delivery.street_number.trim(),
          quarter: delivery.quarter.trim(),
          apartment: delivery.apartment.trim(),
          floor: delivery.floor.trim(),
          block: delivery.block.trim(),
          entry: delivery.entry.trim(),
          delivery_type: delivery.delivery_type,
          home_courier: delivery.home_courier,
          courier_office_code: delivery.courier_office_code,
          courier_office_name: delivery.courier_office_name,
          courier_office_city: delivery.courier_office_city,
          delivery_instructions: deliveryInstructions.trim(),
          gift_note: giftNote.trim(),
          birthday: birthday ? format(birthday, 'yyyy-MM-dd') : null,
          ship_after_date: shipAfterDate ? format(shipAfterDate, 'yyyy-MM-dd') : null,
          price: totalPrice,
          quantity: items.reduce((s, i) => s + i.quantity, 0),
          product_name: items.map(i => formatProductWithQuantity(i.product_name, i.quantity)).join(', ') || '—',
        });
        await apiSyncOrderItems(existingOrderId, items.map(i => ({
          product_id: i.product_id,
          product_name: i.product_name,
          quantity: Math.max(1, i.quantity),
          price_per_unit: Math.max(0, i.price_per_unit),
        })));
        if (notes.trim()) {
          try { await apiAddOrderNote(existingOrderId, notes.trim()); } catch { /* best effort */ }
        }
        if (status !== 'pending') {
          let extras: Record<string, string | undefined> | undefined;
          if (status === 'cancelled' && cancellationReason) {
            extras = {
              cancellation_reason: cancellationReason,
              cancellation_reason_notes: cancellationReasonNotes.trim() || undefined,
            };
          } else if (status === 'trashed' && trashReason) {
            extras = {
              trash_reason: trashReason,
              trash_reason_notes: trashReasonNotes.trim() || undefined,
            };
          }
          await apiUpdateOrderStatus(existingOrderId, status, extras);
        }
        toast({
          title: t('createOrder.orderCompleted'),
          description: t('createOrder.statusDesc', { status: statusLabel(status) }),
        });
        onClose(true, status, false);
        return;
      }

      await apiCreateOrder({
        product_name: items.map(i => formatProductWithQuantity(i.product_name, i.quantity)).join(', ') || '—',
        customer_name: name.trim(),
        customer_phone: phone.trim(),
        customer_address: composedAddress,
        customer_city: delivery.city.trim(),
        postal_code: delivery.postal_code.trim(),
        street: delivery.street.trim(),
        street_number: delivery.street_number.trim(),
        quarter: delivery.quarter.trim(),
        apartment: delivery.apartment.trim(),
        floor: delivery.floor.trim(),
        block: delivery.block.trim(),
        entry: delivery.entry.trim(),
        delivery_type: delivery.delivery_type,
        home_courier: delivery.home_courier,
        courier_office_code: delivery.courier_office_code,
        courier_office_name: delivery.courier_office_name,
        courier_office_city: delivery.courier_office_city,
        delivery_instructions: deliveryInstructions.trim(),
        gift_note: giftNote.trim(),
        birthday: birthday ? format(birthday, 'yyyy-MM-dd') : null,
        ship_after_date: shipAfterDate ? format(shipAfterDate, 'yyyy-MM-dd') : null,
        price: totalPrice,
        quantity: items.reduce((s, i) => s + i.quantity, 0),
        status,
        ...(status === 'cancelled' && cancellationReason ? {
          cancellation_reason: cancellationReason,
          cancellation_reason_notes: cancellationReasonNotes.trim() || undefined,
        } : {}),
        ...(status === 'trashed' && trashReason ? {
          trash_reason: trashReason,
          trash_reason_notes: trashReasonNotes.trim() || undefined,
        } : {}),
        notes: notes.trim() || undefined,
        items: items.map(i => ({
          product_id: i.product_id,
          product_name: i.product_name,
          quantity: Math.max(1, i.quantity),
          price_per_unit: Math.max(0, i.price_per_unit),
        })),
      });
      toast({
        title: t('createOrder.orderCreated'),
        description: status === 'pending' ? t('createOrder.managerReview') : t('createOrder.statusDesc', { status: statusLabel(status) }),
      });
      onClose(true, status, isManualMode);
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <>
      {/* Backdrop does NOT close on click — agents fill this in mid-call, so it
          must only close via the X or Cancel button (never a stray outside click). */}
      <div className="fixed inset-0 z-50 bg-black/60" />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className={cn(
          'relative w-full max-w-2xl bg-card border rounded-xl shadow-2xl flex flex-col max-h-[92vh] pointer-events-auto',
          'animate-in fade-in-0 zoom-in-95 duration-200'
        )}>
          <button onClick={() => onClose()} className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <X className="h-4 w-4" />
          </button>

          <div className="flex items-center gap-3 border-b px-5 py-3 pr-10">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 shrink-0">
              <ShoppingCart className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <h2 className="font-semibold text-card-foreground text-sm truncate">
                {isManualMode && prefillPhone
                  ? t('createOrder.manualOrderTitle')
                  : (title || t('createOrder.createNewOrder'))}
              </h2>
              {prefillPhone && !isManualMode && (
                <p className="text-xs font-mono text-primary">
                  {prefillPhone}
                  {existingDisplayId && (
                    <>
                      {' · '}
                      <span className="font-semibold">{existingDisplayId}</span>
                      {existingIsDuplicate && (
                        <span className="ml-1 rounded border border-indigo-200 bg-indigo-50 px-1 py-0.5 text-[9px] font-sans text-indigo-700 dark:border-indigo-500/30 dark:bg-indigo-500/15 dark:text-indigo-300">
                          {t('status.duplicated')}
                        </span>
                      )}
                    </>
                  )}
                  {prefilling && t('createOrder.loadingPrior')}
                </p>
              )}
              {isManualMode && (
                <p className="text-xs text-amber-700">{t('createOrder.manualModeDesc')}</p>
              )}
            </div>
          </div>

          {/* Manual Order toggle - only shown when opened from a call with a prefilled customer */}
          {prefillPhone && (
            <div className="mx-5 mt-3 mb-1 flex items-center justify-between rounded-lg border bg-amber-50/60 px-3 py-2 dark:bg-amber-500/10 dark:border-amber-500/30">
              <div className="text-sm">
                {isManualMode ? (
                  <span className="font-medium text-amber-800">{t('createOrder.creatingManual')}</span>
                ) : (
                  <span className="text-muted-foreground">{t('createOrder.creatingForCurrent')}</span>
                )}
              </div>
              <Button
                variant={isManualMode ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  if (!isManualMode) {
                    // Entering manual mode → clear everything for full freedom
                    setIsManualMode(true);
                    setName('');
                    setPhone('');
                    setDelivery({
                      delivery_type: 'home',
                      street: '', street_number: '', quarter: '', apartment: '', floor: '', block: '', entry: '', city: '', postal_code: '',
                      home_courier: 'mex',
                      courier_office_code: '', courier_office_name: '', courier_office_city: '',
                    });
                    setDeliveryInstructions('');
                    setGiftNote('');
                    setShipAfterDate(undefined);
                    setBirthday(undefined);
                    setNotes('');
                    setItems([]);
                    setStatus(defaultStatus);
                    setCancellationReason(null);
                    setCancellationReasonNotes('');
                  } else {
                    // Leaving manual mode → restore prefilled state
                    setIsManualMode(false);
                    setName(prefillName || '');
                    setPhone(prefillPhone || '');
                    // Re-trigger the normal prefill logic by forcing a re-run
                    // The existing useEffect will pick up the prefill values again on next render cycle
                    // For robustness we also reset delivery to trigger the prefill effect
                    setDelivery({
                      delivery_type: 'home',
                      street: '', street_number: '', quarter: '', apartment: '', floor: '', block: '', entry: '', city: '', postal_code: '',
                      home_courier: 'mex',
                      courier_office_code: '', courier_office_name: '', courier_office_city: '',
                    });
                  }
                }}
              >
                {isManualMode ? t('createOrder.backToCurrent') : t('createOrder.manualOrderBtn')}
              </Button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('orderModal.customerInfo')}</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">{t('createOrder.fullName')}</label>
                  <Input value={name} onChange={e => setName(e.target.value)} className="h-8 text-sm" placeholder={t('fields.customerName')} />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">{t('createOrder.phoneStar')}</label>
                  <Input 
                    value={phone} 
                    onChange={e => setPhone(e.target.value)} 
                    className="h-8 text-sm font-mono" 
                    placeholder="+389..." 
                    disabled={!!prefillPhone && !isManualMode} 
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-xs text-muted-foreground mb-1 flex items-center gap-1"><Cake className="h-3 w-3" /> {t('createOrder.birthday')}</label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className={cn("h-8 gap-1.5 text-sm w-full justify-start font-normal", !birthday && "text-muted-foreground")}>
                        <CalendarIcon className="h-3.5 w-3.5" />
                        {birthday ? formatDate(birthday, 'PPP') : t('createOrder.pickBirthday')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={birthday}
                        onSelect={setBirthday}
                        defaultMonth={birthday || new Date(1970, 0, 1)}
                        captionLayout="dropdown-buttons"
                        fromYear={1920}
                        toYear={new Date().getFullYear()}
                        className="p-3 pointer-events-auto"
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            </section>

            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Truck className="h-3 w-3" /> {t('createOrder.delivery')}
              </h3>
              {deliveryHint && (
                <div className="mb-2 rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 dark:border-blue-900 dark:bg-blue-950/30">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300">
                      {t('createOrder.prevCourier')}
                    </span>
                    <button
                      type="button"
                      onClick={() => navigator.clipboard?.writeText(deliveryHint)}
                      className="inline-flex items-center gap-1 text-[10px] text-blue-700 hover:underline dark:text-blue-300"
                      title={t('createOrder.copy')}
                    >
                      <Copy className="h-3 w-3" /> {t('createOrder.copy')}
                    </button>
                  </div>
                  <p className="mt-0.5 text-xs text-foreground/80 break-words select-all">{deliveryHint}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">{t('createOrder.hintHelp')}</p>
                </div>
              )}
              <DeliveryMethodPicker value={delivery} onChange={setDelivery} />
            </section>

            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Info className="h-3 w-3" /> {t('createOrder.additionalInfo')}
              </h3>
              <Textarea
                value={deliveryInstructions}
                onChange={e => setDeliveryInstructions(e.target.value)}
                className="text-sm min-h-[60px]"
                placeholder={t('createOrder.additionalPlaceholder')}
              />
            </section>

            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <ShoppingCart className="h-3 w-3" /> {t('orderModal.products')}
                </h3>
                <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={addItem} disabled={loading || products.length === 0}>
                  <Plus className="h-3 w-3" /> {t('createOrder.add')}
                </Button>
              </div>
              {loading ? (
                <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
              ) : items.length === 0 ? (
                <EmptyState
                  icon={<ShoppingCart className="h-4 w-4" />}
                  title={t('createOrder.noProducts')}
                  size="sm"
                  className="border-0 bg-transparent py-2 text-xs"
                />
              ) : (
                <div className="space-y-2">
                  {items.map((item, idx) => (
                    <div key={idx} className="rounded-lg border bg-muted/30 p-3 space-y-2.5">
                      {/* Wide product picker + remove */}
                      <div className="flex items-start gap-2">
                        <ProductCombobox
                          products={products}
                          value={item.product_id}
                          productName={item.product_name}
                          onChange={(id) => changeProduct(idx, id)}
                          className="flex-1"
                        />
                        <button
                          onClick={() => removeItem(idx)}
                          className="mt-1 shrink-0 p-1.5 text-muted-foreground hover:text-destructive transition-colors"
                          title={t('common.delete')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>

                      {/* Qty · Unit price · Line total */}
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">{t('createOrder.qty')}</label>
                          <Input
                            type="number" min={1} value={item.quantity}
                            onChange={e => updateItem(idx, 'quantity', Math.max(1, parseInt(e.target.value) || 1))}
                            className="h-8 text-sm text-center"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">{t('createOrder.unitEur')}</label>
                          <Input
                            type="number" min={0} step={1} value={eurToDen(item.price_per_unit)}
                            onChange={e => updateItem(idx, 'price_per_unit', denToEur(Math.max(0, parseFloat(e.target.value) || 0)))}
                            className="h-8 text-sm text-right tabular-nums"
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">{t('createOrder.total')}</label>
                          <div className="relative">
                            <Input
                              type="text" inputMode="numeric"
                              value={totalDraft[idx] ?? String(eurToDen(Math.max(1, item.quantity) * Math.max(0, item.price_per_unit)))}
                              onChange={e => { const v = e.target.value; setTotalDraft(d => ({ ...d, [idx]: v })); setLineTotal(idx, denToEur(parseFloat(v) || 0)); }}
                              onBlur={() => setTotalDraft(d => { const c = { ...d }; delete c[idx]; return c; })}
                              className="h-8 pr-9 text-sm text-right font-semibold text-primary tabular-nums"
                            />
                            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm text-primary">ден</span>
                          </div>
                        </div>
                      </div>

                      {isLegacyPromoName(item.product_name, item.product_id) && (
                        <span className="inline-block rounded border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300" title={t('createOrder.websiteTitle')}>
                          {t('createOrder.website')}
                        </span>
                      )}
                    </div>
                  ))}
                  {items.length > 0 && (
                    <div className="pt-1 text-[10px] text-muted-foreground">
                      {t('orderModal.lines')} {items.map((item, idx) => {
                        const isDirty = isLegacyPromoName(item.product_name, item.product_id);
                        return (
                          <span key={idx}>
                            {idx > 0 && ', '}
                            <span className={cn("font-medium", isDirty ? "text-amber-700" : "text-foreground")}>
                              {formatProductWithQuantity(item.product_name, item.quantity)}
                              {isDirty && <span className="text-[9px] align-super ml-0.5">⚠</span>}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </section>

            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Gift className="h-3 w-3" /> {t('orderModal.giftVoucher')}
              </h3>
              <Input
                value={giftNote}
                onChange={e => setGiftNote(e.target.value)}
                className="h-8 text-sm"
                placeholder={t('orderModal.giftPlaceholder')}
              />
            </section>

            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Truck className="h-3 w-3" /> {t('createOrder.shipAfterOptional')}
              </h3>
              <p className="text-[11px] text-muted-foreground mb-2">{t('createOrder.shipAfterHint')}</p>
              <div className="flex items-center gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className={cn("h-8 gap-1.5 text-sm flex-1 justify-start font-normal", !shipAfterDate && "text-muted-foreground")}>
                      <CalendarIcon className="h-3.5 w-3.5" />
                      {shipAfterDate ? formatDate(shipAfterDate, 'PPP') : t('createOrder.shipAsap')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={shipAfterDate}
                      onSelect={setShipAfterDate}
                      disabled={(d) => d < new Date(new Date().setHours(0, 0, 0, 0))}
                      className="p-3 pointer-events-auto"
                    />
                  </PopoverContent>
                </Popover>
                {shipAfterDate && (
                  <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setShipAfterDate(undefined)}>{t('common.clear')}</Button>
                )}
              </div>
            </section>

            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('orderModal.notes')}</h3>
              <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="text-sm" placeholder={t('createOrder.internalNotes')} />
            </section>

            {!hideStatusPicker && (
              <section>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('createOrder.whatHappened')}</h3>
                <div className="grid grid-cols-3 gap-2">
                  {STATUS_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      data-on={status === opt.value}
                      onClick={() => setStatus(opt.value)}
                      className={cn(
                        'rounded-lg border-2 px-2 py-2 text-xs font-medium transition-all',
                        status === opt.value ? opt.cls + ' ring-2 ring-primary/30 shadow-sm' : 'border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground',
                      )}
                    >
                      {t(opt.labelKey)}
                    </button>
                  ))}
                </div>
                {status === 'cancelled' && (
                  <div className="mt-3">
                    <CancellationReasonPicker
                      value={cancellationReason}
                      notes={cancellationReasonNotes}
                      onChange={setCancellationReason}
                      onNotesChange={setCancellationReasonNotes}
                    />
                  </div>
                )}
                {status === 'trashed' && (
                  <div className="mt-3">
                    <TrashReasonPicker
                      idPrefix="create-order-trash"
                      value={trashReason}
                      notes={trashReasonNotes}
                      onChange={setTrashReason}
                      onNotesChange={setTrashReasonNotes}
                    />
                  </div>
                )}
              </section>
            )}
          </div>

          <div className="flex items-center justify-between border-t px-5 py-3 bg-card rounded-b-xl">
            <div className="text-right leading-tight">
              <div className="text-sm font-bold text-primary">{formatMoney(totalPrice)}</div>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => onClose()}>{t('common.cancel')}</Button>
              <Button variant="outline" size="sm" onClick={handleSaveInfo} disabled={savingInfo || saving} title={t('createOrder.saveInfoTitle')}>
                {savingInfo ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                {t('createOrder.saveInfo')}
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving || savingInfo}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
                {existingOrderId && !isManualMode ? t('createOrder.saveAndConfirm') : t('common.createOrder')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
