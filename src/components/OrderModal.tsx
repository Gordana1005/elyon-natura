import { useState, useEffect } from 'react';
import { apiErrorText } from '@/i18n/apiErrors';
import { useTranslation } from 'react-i18next';
import {
  Phone, FileText, Loader2, X, ChevronDown, ChevronUp, Save,
  Plus, Trash2, ShoppingCart, CalendarIcon, Shield, Check
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useCustomerIntelligence } from '@/hooks/useCustomerIntelligence';
import { CustomerIntelligencePanel } from '@/components/CustomerIntelligencePanel';
import { ProductRecommendations } from '@/components/ProductRecommendations';
import { ProductCombobox } from '@/components/ProductCombobox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cn, formatProductWithQuantity, isLegacyPromoName } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import {
  apiGetCallScript, apiUpdateCallScript, apiLogCall, apiGetCallLogs,
  apiUpdateLead, apiGetProducts, apiAddLeadItem, apiUpdateLeadItem, apiDeleteLeadItem,
  apiUpdateCustomer, apiUpdateOrderStatus, apiSyncOrderItems,
  apiGetOrder, apiCorrectOrderAttribution, apiGetAgents,
} from '@/lib/api';
// Order lines are STORED in EUR; the agent only ever sees and types denari.
// Convert at the input boundary — never let a euro figure reach the screen.
import { formatMoney, eurToDen, denToEur } from '@/lib/currency';
import { cleanNoteForDisplay } from '@/lib/notes';
import { DeliveryMethodPicker, type DeliveryValue } from '@/components/DeliveryMethodPicker';
import { resolveDeliveryPrefill, composeHomeAddress } from '@/lib/address';
import { CancellationReasonPicker } from '@/components/CancellationReasonPicker';
import { TrashReasonPicker } from '@/components/TrashReasonPicker';
import { cancelReasonRequiresNote } from '@/lib/cancellationReasons';
import { isTrashSelectionValid } from '@/lib/trashReasons';
import type { CancellationReason, TrashReason } from '@/lib/api';
import { format } from 'date-fns'; // machine 'yyyy-MM-dd' payloads only
import { formatDate } from '@/i18n/dates';

export type CallOutcome =
  | 'no_answer' | 'interested' | 'not_interested' | 'wrong_number' | 'call_again'
  // Calls-page outcome picker (rich taxonomy). Reason text lands in call_logs.notes.
  | 'confirmed' | 'cancelled' | 'trash'
  // Neutral "picked up, no decision" — logged automatically when a call is hung
  // up without an explicit outcome (see VoipContext).
  | 'answered';

// Labels resolved at render: t(`outcome.${value}`)
const OUTCOME_CONFIG: { value: CallOutcome; className: string }[] = [
  { value: 'call_again', className: 'border-blue-500/50 text-blue-700 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950' },
  { value: 'interested', className: 'border-emerald-500/50 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950' },
  { value: 'not_interested', className: 'border-rose-500/50 text-rose-700 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-950' },
  { value: 'cancelled', className: 'border-red-500/50 text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950' },
  { value: 'wrong_number', className: 'border-zinc-500/50 text-zinc-700 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-950' },
  { value: 'no_answer', className: 'border-amber-500/50 text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950' },
];

// Modal-specific lead-status labels (Taken/Contacted/…) live under
// leadStatusModal.* — resolved at render: t(`leadStatusModal.${value}`)
const LEAD_STATUS_OPTIONS = [
  { value: 'not_contacted', labelKey: 'leadStatusModal.not_contacted', color: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30' },
  { value: 'no_answer', labelKey: 'leadStatusModal.no_answer', color: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30' },
  { value: 'interested', labelKey: 'leadStatusModal.interested', color: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30' },
  { value: 'confirmed', labelKey: 'leadStatusModal.confirmed', color: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/30' },
  { value: 'not_interested', labelKey: 'leadStatusModal.not_interested', color: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30' },
];

// Order-status picker — colours kept in sync with the canonical STATUS_COLORS
// palette in src/types/index.ts (Confirmed light green, Paid dark green, etc.).
// Labels come from the shared status.* keys.
const ORDER_STATUS_OPTIONS = [
  { value: 'pending', labelKey: 'status.pending', color: 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30' },
  { value: 'take', labelKey: 'status.take', color: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-500/15 dark:text-purple-300 dark:border-purple-500/30' },
  { value: 'call_again', labelKey: 'status.call_again', color: 'bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30' },
  { value: 'confirmed', labelKey: 'status.confirmed', color: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-500/15 dark:text-green-300 dark:border-green-500/30' },
  { value: 'shipped', labelKey: 'status.shipped', color: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30' },
  { value: 'delivered', labelKey: 'status.delivered', color: 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-500/15 dark:text-teal-300 dark:border-teal-500/30' },
  { value: 'returned', labelKey: 'status.returned', color: 'bg-pink-100 text-pink-800 border-pink-200 dark:bg-pink-500/15 dark:text-pink-300 dark:border-pink-500/30' },
  { value: 'paid', labelKey: 'status.paid', color: 'bg-emerald-600 text-white border-emerald-700' },
  { value: 'trashed', labelKey: 'status.trashed', color: 'bg-gray-200 text-gray-700 border-gray-300 dark:bg-gray-500/20 dark:text-gray-300 dark:border-gray-500/30' },
  { value: 'cancelled', labelKey: 'status.cancelled', color: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30' },
];

// Shown only while the order actually IS a duplicate, so the Select can render its
// current value; the backend rejects setting any order TO 'duplicated', so it is
// never offered on other orders. Without this the trigger rendered blank and a save
// that didn't re-pick a status silently skipped the status PATCH.
const DUPLICATED_STATUS_OPTION = {
  value: 'duplicated',
  labelKey: 'status.duplicated',
  color: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/30',
};

interface ItemLocal {
  id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  price_per_unit: number;
  total_price: number;
  _isNew?: boolean;
  _deleted?: boolean;
}

/** Universal data shape that both lead and order can provide */
export interface OrderModalData {
  id: string;
  name: string;
  telephone: string;
  address: string | null;
  city: string | null;
  postalCode?: string | null;
  product: string | null;
  status: string;
  notes: string | null;
  quantity?: number;
  price?: number;
  displayId?: string;
  items?: ItemLocal[];
  assigned_agent_id?: string | null;
  ship_after_date?: string | null;
}

export type OrderModalContextType = 'prediction_lead' | 'order';

interface OrderModalProps {
  open: boolean;
  onClose: (saved?: boolean) => void;
  data: OrderModalData | null;
  contextType: OrderModalContextType;
  readOnly?: boolean;
}

function calcRowTotal(qty: number, price: number): number {
  return Math.round(Math.max(1, qty) * Math.max(0, price) * 100) / 100;
}

export function OrderModal({ open, onClose, data, contextType, readOnly = false }: OrderModalProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.isAdmin || user?.isManager;
  const isLead = contextType === 'prediction_lead';
  const statusOptions = isLead
    ? LEAD_STATUS_OPTIONS
    : (data?.status === 'duplicated' ? [DUPLICATED_STATUS_OPTION, ...ORDER_STATUS_OPTIONS] : ORDER_STATUS_OPTIONS);
  // Agents work OPEN orders only — a pending lead or an unsettled duplicate.
  // Anything already settled (confirmed / shipped / paid / cancelled / …) is
  // read-only for them: tapping a Paid or Cancelled pill in the customer's history
  // opens the order to LOOK at, never to rewrite (operator rule 2026-08-13). The
  // server enforces the same rule; this keeps the UI honest instead of letting
  // them fill in a form that will 403 on save.
  const OPEN_ORDER_STATES = ['pending', 'take', 'call_again', 'duplicated'];
  const settledForAgent = !isLead && !isAdmin
    && !!data?.status && !OPEN_ORDER_STATES.includes(data.status);
  const isEditable = !readOnly && !settledForAgent;

  // Script
  const [script, setScript] = useState('');
  const [editingScript, setEditingScript] = useState(false);
  const [editedScript, setEditedScript] = useState('');
  const [showScript, setShowScript] = useState(false);
  const [loadingScript, setLoadingScript] = useState(true);
  const [callLogs, setCallLogs] = useState<any[]>([]);
  const [orderNotes, setOrderNotes] = useState<any[]>([]);
  const [assignedAgentName, setAssignedAgentName] = useState<string>('');
  const [fullOrderData, setFullOrderData] = useState<any>(null);

  // Admin attribution correction state
  const [agents, setAgents] = useState<any[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [attrPopoverOpen, setAttrPopoverOpen] = useState(false);
  const [selectedNewAgentId, setSelectedNewAgentId] = useState<string | null>(null);
  const [showAttrConfirm, setShowAttrConfirm] = useState(false);

  // Form state
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [customerCity, setCustomerCity] = useState('');
  const [postalCode, setPostalCode] = useState('');
  // Delivery method (Phase 6 — replaces the standalone street/apartment/...
  // fields with a unified picker that also handles courier-office choices).
  const [delivery, setDelivery] = useState<DeliveryValue>({
    delivery_type: 'home',
    street: '', street_number: '', quarter: '', apartment: '', floor: '', block: '', entry: '', city: '', postal_code: '',
    home_courier: 'mex',
    courier_office_code: '', courier_office_name: '', courier_office_city: '',
  });
  const [deliveryInstructions, setDeliveryInstructions] = useState('');
  const [giftNote, setGiftNote] = useState('');
  const [callNotes, setCallNotes] = useState('');
  const [selectedOutcome, setSelectedOutcome] = useState<CallOutcome | null>(null);
  const [cancellationReason, setCancellationReason] = useState<CancellationReason | null>(null);
  const [cancellationReasonNotes, setCancellationReasonNotes] = useState('');
  // Trash reason twin. Seeded from the full order fetch below so reopening an
  // already-trashed order shows (and can correct) the reason that was recorded.
  const [trashReason, setTrashReason] = useState<TrashReason | null>(null);
  const [trashReasonNotes, setTrashReasonNotes] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [followUpDate, setFollowUpDate] = useState<Date | undefined>();
  const [shipAfterDate, setShipAfterDate] = useState<Date | undefined>();

  // Products
  const [items, setItems] = useState<ItemLocal[]>([]);
  // Raw string while a line-total is being typed (avoids mid-keystroke reformat).
  const [totalDraft, setTotalDraft] = useState<Record<number, string>>({});
  const [productsList, setProductsList] = useState<any[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);

  // Payment
  const [amountPaid, setAmountPaid] = useState(0);

  // Saving
  const [saving, setSaving] = useState(false);

  // Customer Intelligence
  const { data: customerIntel, loading: intelLoading } = useCustomerIntelligence(customerPhone);
  useEffect(() => {
    if (!open || !data) return;

    setCustomerName(data.name || '');
    setCustomerPhone(data.telephone || '');
    setCustomerAddress(data.address || '');
    setCustomerCity(data.city || '');
    setPostalCode(data.postalCode || '');
    // Granular address + delivery type populated from the apiGetOrder fetch below.
    setDelivery({
      delivery_type: 'home',
      street: '', street_number: '', quarter: '', apartment: '', floor: '', block: '', entry: '',
      city: data.city || '', postal_code: data.postalCode || '',
      home_courier: 'mex',
      courier_office_code: '', courier_office_name: '', courier_office_city: '',
    });
    setDeliveryInstructions('');
    setGiftNote('');
    setCallNotes(data.notes || '');
    setSelectedOutcome(null);
    setSelectedStatus(data.status || (isLead ? 'not_contacted' : 'pending'));
    // Cleared here, repopulated from `fullOrder` once the fetch lands.
    setCancellationReason(null);
    setCancellationReasonNotes('');
    setTrashReason(null);
    setTrashReasonNotes('');
    setFollowUpDate(undefined);
    setShipAfterDate(data.ship_after_date ? new Date(data.ship_after_date + 'T00:00:00') : undefined);
    setShowScript(false);
    setEditingScript(false);
    setAmountPaid(0);
    setItems([]);

    setLoadingScript(true);
    setLoadingProducts(true);

    // For orders, always fetch full order with items from backend to avoid stale/missing items
    const fetchOrderData = !isLead
      ? apiGetOrder(data.id).catch(() => null)
      : Promise.resolve(null);

    Promise.all([
      apiGetCallScript(contextType).catch(() => null),
      apiGetCallLogs(contextType, data.id).catch(() => []),
      apiGetProducts().catch(() => []),
      fetchOrderData,
    ])
      .then(([scriptData, logs, products, fullOrder]) => {
        setScript(scriptData?.script_text || '');
        setCallLogs(logs || []);
        setProductsList(products || []);
        setOrderNotes(fullOrder?.notes || []);
        setAssignedAgentName(fullOrder?.assigned_agent_name || '');
        setFullOrderData(fullOrder || null);
        // Phase 3 granular fields + Phase 6 delivery method, populated from
        // the full order fetch. Leads don't have them. Uses the shared
        // resolver so courier-office orders open on the courier tab and the
        // office string never lands in Home Address → City.
        if (!isLead && fullOrder) {
          setDelivery(resolveDeliveryPrefill(fullOrder));
          setDeliveryInstructions(fullOrder.delivery_instructions || '');
          setGiftNote(fullOrder.gift_note || '');
          // Pre-select the reasons already on the order (GET /orders/:id is a
          // select("*")), so an admin reopening a handled order sees WHY it was
          // cancelled/trashed and can correct it without changing the status.
          setCancellationReason((fullOrder.cancellation_reason as CancellationReason) || null);
          setCancellationReasonNotes(fullOrder.cancellation_reason_notes || '');
          setTrashReason((fullOrder.trash_reason as TrashReason) || null);
          setTrashReasonNotes(fullOrder.trash_reason_notes || '');
        }
        setLoadingProducts(false);

        // Determine items: for orders use fetched order_items, for leads use passed data
        let resolvedItems: ItemLocal[] = [];
        if (!isLead && fullOrder?.order_items?.length > 0) {
          resolvedItems = fullOrder.order_items.map((i: any) => ({
            id: i.id,
            product_id: i.product_id,
            product_name: i.product_name,
            quantity: i.quantity,
            price_per_unit: Number(i.price_per_unit),
            total_price: Number(i.total_price),
          }));
        } else if (data.items && data.items.length > 0) {
          resolvedItems = data.items.map(i => ({ ...i }));
        } else if (data.product) {
          // Legacy fallback: only use if no items exist at all
          resolvedItems = [{
            id: '__legacy__',
            product_id: null,
            product_name: data.product || '',
            quantity: data.quantity || 1,
            price_per_unit: data.price || 0,
            total_price: calcRowTotal(data.quantity || 1, data.price || 0),
          }];
        }

        // Reconcile to the official warehouse / catalogue name whenever we have a product_id.
        // This ensures that even if the order originally came from OpenCart with "Prostatol 3 + Palmetto..."
        // or any other dirty name, as soon as you open it in the modal you see the clean name
        // that is used in the warehouse (e.g. "Простатол Комплекс").
        const productsArr = products || [];
        resolvedItems = resolvedItems.map((item: any) => {
          if (item.product_id) {
            const match = productsArr.find((p: any) => p.id === item.product_id);
            if (match?.name) {
              return { ...item, product_name: match.name };
            }
          }
          return item;
        });

        setItems(resolvedItems);
      })
      .catch(() => { setLoadingProducts(false); })
      .finally(() => setLoadingScript(false));
  }, [open, data, contextType]);

  // The 'wrong_number' outcome forces status=trashed server-side, so seed the
  // trash picker with the matching reason. It stays overridable — a lead that
  // turns out to be a duplicate can be re-tagged before saving.
  useEffect(() => {
    if (selectedOutcome === 'wrong_number' && !trashReason) setTrashReason('wrong_number');
  }, [selectedOutcome, trashReason]);

  // Load agents for admin attribution picker (only when needed)
  useEffect(() => {
    if (isAdmin && open && !isLead) {
      setAgentsLoading(true);
      apiGetAgents()
        .then((list: any[]) => setAgents(list || []))
        .catch(() => setAgents([]))
        .finally(() => setAgentsLoading(false));
    }
  }, [isAdmin, open, isLead]);

  // Computed totals
  const activeItems = items.filter(i => !i._deleted);
  const subtotal = activeItems.reduce((sum, i) => sum + calcRowTotal(i.quantity, i.price_per_unit), 0);
  const finalTotal = Math.round(subtotal * 100) / 100;
  const remainingBalance = Math.max(0, Math.round((finalTotal - amountPaid) * 100) / 100);

  // Product helpers
  const addProductRow = () => {
    const defaultProduct = productsList.find(p => p.is_active) || productsList[0];
    if (!defaultProduct) return;
    setItems(prev => [...prev, {
      id: `_new_${Date.now()}`,
      product_id: defaultProduct.id,
      product_name: defaultProduct.name,
      quantity: 1,
      price_per_unit: Number(defaultProduct.price) || 0,
      total_price: Number(defaultProduct.price) || 0,
      _isNew: true,
    }]);
  };

  const updateItem = (idx: number, field: string, value: any) => {
    setItems(prev => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: value };
      copy[idx].total_price = calcRowTotal(copy[idx].quantity, copy[idx].price_per_unit);
      return copy;
    });
  };

  // Let the user type the LINE TOTAL; back-fill per-unit = total / qty.
  const setLineTotal = (idx: number, total: number) => {
    setItems(prev => {
      const copy = [...prev];
      const qty = Math.max(1, copy[idx].quantity);
      const ppu = Math.max(0, total) / qty;
      copy[idx] = { ...copy[idx], price_per_unit: ppu, total_price: calcRowTotal(qty, ppu) };
      return copy;
    });
  };

  const changeItemProduct = (idx: number, productId: string) => {
    const product = productsList.find(p => p.id === productId);
    if (!product) return;
    setItems(prev => {
      const copy = [...prev];
      copy[idx] = {
        ...copy[idx],
        product_id: productId,
        product_name: product.name,
        price_per_unit: Number(product.price) || 0,
        total_price: calcRowTotal(copy[idx].quantity, Number(product.price) || 0),
      };
      return copy;
    });
  };

  const removeItem = (idx: number) => {
    setItems(prev => {
      const copy = [...prev];
      if (copy[idx]._isNew || copy[idx].id === '__legacy__') {
        copy.splice(idx, 1);
      } else {
        copy[idx] = { ...copy[idx], _deleted: true };
      }
      return copy;
    });
  };

  const personalizedScript = script
    .replace(/\[Customer Name\]/g, customerName || '___')
    .replace(/\[Product\]/g, activeItems.length > 0 ? formatProductWithQuantity(activeItems[0].product_name, activeItems[0].quantity) : '___')
    .replace(/\[Order ID\]/g, data?.displayId || data?.id?.slice(0, 8) || '___');

  // ── SAVE ──
  const handleSave = async () => {
    if (!data || saving) return; // prevent double-submit
    // Admins/managers manage orders without making the call — they only need
    // to pick an outcome if they actually did. For agents (or anyone editing a
    // lead) an outcome is still required — EXCEPT when confirming an order
    // (operator rule 2026-08-13): "confirmed" speaks for itself, no extra outcome
    // click. Cancel/trash still demand an outcome + reason.
    const isConfirmSave = !isLead && selectedStatus === 'confirmed';
    const outcomeRequired = (isLead || !isAdmin) && !isConfirmSave;
    if (outcomeRequired && !selectedOutcome) {
      toast({ title: t('orderModal.selectOutcome'), description: t('orderModal.selectOutcomeDesc'), variant: 'destructive' });
      return;
    }
    if (selectedOutcome === 'call_again' && !followUpDate) {
      toast({ title: t('orderModal.followUpRequired'), description: t('orderModal.followUpRequiredDesc'), variant: 'destructive' });
      return;
    }
    const needsCancelReason = !isLead
      && (selectedOutcome === 'cancelled'
          || (selectedStatus === 'cancelled' && data?.status !== 'cancelled'));
    if (needsCancelReason && !cancellationReason) {
      toast({ title: t('orderModal.cancelReasonRequired'), description: t('orderModal.cancelReasonRequiredDesc'), variant: 'destructive' });
      return;
    }
    if (needsCancelReason && cancelReasonRequiresNote(cancellationReason) && !cancellationReasonNotes.trim()) {
      toast({ title: t('orderModal.cancelNoteRequired'), description: t('orderModal.cancelNoteRequiredDesc'), variant: 'destructive' });
      return;
    }
    // Trash twin: demanded whenever the order is heading to (or already sits in)
    // trashed, so no order can be junked without saying why — the whole point of
    // the Trash List's Reason column.
    const needsTrashReason = !isLead
      && (selectedOutcome === 'wrong_number' || selectedStatus === 'trashed');
    if (needsTrashReason && !trashReason) {
      toast({ title: t('orderModal.trashReasonRequired'), description: t('orderModal.trashReasonRequiredDesc'), variant: 'destructive' });
      return;
    }
    if (needsTrashReason && !isTrashSelectionValid(trashReason, trashReasonNotes)) {
      toast({ title: t('orderModal.trashNoteRequired'), description: t('orderModal.trashNoteRequiredDesc'), variant: 'destructive' });
      return;
    }
    // Validate required fields for confirm status
    if (['confirmed', 'shipped'].includes(selectedStatus)) {
      if (!customerName.trim() || !customerPhone.trim()) {
        toast({ title: t('orderModal.namePhoneRequired'), description: t('orderModal.namePhoneRequiredDesc'), variant: 'destructive' });
        return;
      }
      if (activeItems.length === 0) {
        toast({ title: t('orderModal.productsRequired'), description: t('orderModal.productsRequiredDesc'), variant: 'destructive' });
        return;
      }
    }

    setSaving(true);
    try {
      // 1. Log call — only when an outcome was actually selected. Admin/manager
      // edits without an outcome skip this and just update the order itself.
      if (selectedOutcome) {
        await apiLogCall({
          context_type: contextType,
          context_id: data.id,
          outcome: selectedOutcome,
          notes: callNotes.trim(),
          customer_phone: customerPhone || undefined,
          ...(selectedOutcome === 'cancelled' && cancellationReason ? {
            cancellation_reason: cancellationReason,
            cancellation_reason_notes: cancellationReasonNotes.trim() || undefined,
          } : {}),
          ...(selectedOutcome === 'wrong_number' && trashReason ? {
            trash_reason: trashReason,
          } : {}),
        });
      }

      // 2. Update entity fields + sync products
      const lockedStatuses = ['shipped', 'delivered', 'paid'];
      if (isLead) {
        await apiUpdateLead(data.id, {
          status: selectedStatus,
          notes: callNotes.trim(),
          address: customerAddress,
          city: customerCity,
          telephone: customerPhone,
        });
        // Lead: individual item operations
        for (const item of items) {
          const isLegacy = item.id === '__legacy__';
          const isNew = item._isNew || isLegacy;
          if (item._deleted && !isNew) {
            await apiDeleteLeadItem(item.id);
          } else if (isNew && !item._deleted) {
            await apiAddLeadItem(data.id, {
              product_id: item.product_id || undefined,
              product_name: item.product_name,
              quantity: item.quantity,
              price_per_unit: item.price_per_unit,
            });
          } else if (!isNew && !item._deleted) {
            await apiUpdateLeadItem(item.id, {
              product_id: item.product_id,
              product_name: item.product_name,
              quantity: item.quantity,
              price_per_unit: item.price_per_unit,
            });
          }
        }
      } else {
        // Order: update customer info first. Composed customer_address kept
        // in sync so the Orders list (single-line column) keeps showing
        // something readable.
        const composedAddress = delivery.delivery_type === 'home'
          ? composeHomeAddress(delivery)
          : `[${delivery.delivery_type === 'speedy_office' ? 'Speedy' : delivery.delivery_type === 'mex_office' ? 'MEX' : 'Econt'}] ${delivery.courier_office_city} — #${delivery.courier_office_code} ${delivery.courier_office_name}`.trim();
        await apiUpdateCustomer(data.id, {
          customer_name: customerName.trim(),
          customer_phone: customerPhone.trim(),
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
          ship_after_date: shipAfterDate ? format(shipAfterDate, 'yyyy-MM-dd') : null,
        });
        // Sync items only if order is NOT in a locked status AND not transitioning TO locked
        const isCurrentlyLocked = lockedStatuses.includes(data.status);
        const isTransitioningToLocked = lockedStatuses.includes(selectedStatus);
        if (!isCurrentlyLocked && !isTransitioningToLocked) {
          await apiSyncOrderItems(data.id, activeItems.map(i => ({
            product_id: i.product_id,
            product_name: i.product_name,
            quantity: i.quantity,
            price_per_unit: i.price_per_unit,
          })));
        }
        // Change status last (after customer fields are saved). Pass through
        // the structured reason fields when the admin is flipping the order
        // to cancelled — the backend will record them on the order so the
        // segment trigger moves the customer to the right Cancelled mirror.
        // A reason-only edit (status unchanged, reason corrected) must save too —
        // that is the whole point of being able to fix "why" on an order that
        // was already cancelled or trashed. The backend skips the order_history
        // row when from_status === to_status, so this adds no timeline noise.
        const reasonChanged =
          (selectedStatus === 'cancelled' && (
            cancellationReason !== (fullOrderData?.cancellation_reason ?? null)
            || cancellationReasonNotes.trim() !== (fullOrderData?.cancellation_reason_notes ?? '').trim()))
          || (selectedStatus === 'trashed' && (
            trashReason !== (fullOrderData?.trash_reason ?? null)
            || trashReasonNotes.trim() !== (fullOrderData?.trash_reason_notes ?? '').trim()));

        if (selectedStatus !== data.status || reasonChanged) {
          let extras: Record<string, string | undefined> | undefined;
          if (selectedStatus === 'cancelled' && cancellationReason) {
            extras = {
              cancellation_reason: cancellationReason,
              cancellation_reason_notes: cancellationReasonNotes.trim() || undefined,
            };
          } else if (selectedStatus === 'trashed' && trashReason) {
            extras = {
              trash_reason: trashReason,
              trash_reason_notes: trashReasonNotes.trim() || undefined,
            };
          }
          await apiUpdateOrderStatus(data.id, selectedStatus, extras);
        }
      }

      toast({ title: t('orderModal.savedOk') });
      onClose(true);
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleSaveScript = async () => {
    try {
      await apiUpdateCallScript(contextType, editedScript);
      setScript(editedScript);
      setEditingScript(false);
      toast({ title: t('orderModal.scriptUpdated') });
    } catch (err: any) {
      toast({ title: t('common.error'), description: apiErrorText(err), variant: 'destructive' });
    }
  };

  if (!open || !data) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/60" onClick={() => onClose()} />

      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className={cn(
          'relative w-full max-w-2xl bg-card border rounded-xl shadow-2xl flex flex-col max-h-[92vh] pointer-events-auto',
          'animate-in fade-in-0 zoom-in-95 duration-200'
        )}>
          {/* Close */}
          <button
            onClick={() => onClose()}
            className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>

          {/* Header */}
          <div className="flex items-center gap-3 border-b px-5 py-3 pr-10">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 shrink-0">
              <Phone className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-card-foreground text-sm truncate">
                 {t('orderModal.title')} {data.displayId ? `— ${data.displayId}` : ''}
                 {readOnly && <span className="text-xs font-normal text-muted-foreground ml-2">{t('orderModal.viewOnly')}</span>}
               </h2>
              <div className="flex items-center gap-2 flex-wrap">
                <a href={`tel:${customerPhone}`} className="text-xs font-mono text-primary hover:underline">
                  {customerPhone}
                </a>
                {assignedAgentName && (
                  <span className="text-[10px] text-muted-foreground inline-flex items-center gap-1">
                    <span className="text-muted-foreground/50">·</span>
                    <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary/10 text-[8px] font-bold text-primary">
                      {assignedAgentName.charAt(0).toUpperCase()}
                    </span>
                    {assignedAgentName}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
            {/* A) Customer Info */}
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('orderModal.customerInfo')}</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">{t('orderModal.name')}</label>
                  <Input value={customerName} onChange={e => setCustomerName(e.target.value)} className="h-8 text-sm" disabled={!isEditable} />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1 block">{t('orderModal.phone')}</label>
                  <Input value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} className="h-8 text-sm font-mono" disabled={!isEditable} />
                </div>
              </div>

              {/* Delivery method picker (Phase 6) — handles home address fields
                  AND courier-office selection in one component. */}
              {!isLead && (
                <div className="mt-3">
                  <DeliveryMethodPicker value={delivery} onChange={setDelivery} disabled={!isEditable} />
                </div>
              )}

              {/* For leads, keep the legacy single-line address (no granular picker) */}
              {isLead && (
                <div className="grid grid-cols-2 gap-3 mt-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">{t('orderModal.address')}</label>
                    <Input value={customerAddress} onChange={e => setCustomerAddress(e.target.value)} className="h-8 text-sm" disabled={!isEditable} />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1 block">{t('orderModal.city')}</label>
                    <Input value={customerCity} onChange={e => setCustomerCity(e.target.value)} className="h-8 text-sm" disabled={!isEditable} />
                  </div>
                </div>
              )}

              {/* Delivery instructions + gift (orders only) */}
              {!isLead && (
                <div className="grid grid-cols-1 gap-2 mt-3">
                  <div>
                    <label className="text-[10px] text-muted-foreground mb-0.5 block uppercase tracking-wide">{t('orderModal.deliveryInfo')}</label>
                    <Textarea value={deliveryInstructions} onChange={e => setDeliveryInstructions(e.target.value)} className="text-sm min-h-[44px]" placeholder={t('orderModal.deliveryPlaceholder')} disabled={!isEditable} />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground mb-0.5 block uppercase tracking-wide">{t('orderModal.giftVoucher')}</label>
                    <Input value={giftNote} onChange={e => setGiftNote(e.target.value)} className="h-8 text-sm" placeholder={t('orderModal.giftPlaceholder')} disabled={!isEditable} />
                  </div>
                </div>
              )}
            </section>

            {/* Immutable Sales Credit (confirmed_by) — shown for all roles so everyone sees who originally made the sale */}
            {!isLead && fullOrderData && (fullOrderData.confirmed_by_name || fullOrderData.assigned_agent_name) && (
              <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs flex items-center gap-2">
                <span className="font-semibold text-muted-foreground">{t('orderModal.confirmedBy')}</span>
                <span className="font-medium">{fullOrderData.confirmed_by_name || fullOrderData.assigned_agent_name}</span>
                {fullOrderData.confirmed_at && (
                  <span className="text-muted-foreground">({new Date(fullOrderData.confirmed_at).toLocaleDateString()})</span>
                )}
                <span className="ml-auto text-[10px] text-muted-foreground" title={t('orderModal.immutableTitle')}>
                  {t('orderModal.immutable')}
                </span>
              </div>
            )}

            {/* Customer Intelligence */}
            <CustomerIntelligencePanel data={customerIntel} loading={intelLoading} />

            {/* Admin-only: Change Original Sales Credit (Confirmed By) */}
            {isAdmin && !isLead && (
              <div className="mt-3 rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-sm font-semibold flex items-center gap-2">
                      <Shield className="h-4 w-4 text-amber-600" />
                      {t('orderModal.salesCredit')}
                    </div>
                    <div className="text-[11px] text-muted-foreground">{t('orderModal.salesCreditDesc')}</div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm">
                    <span className="text-muted-foreground">{t('orderModal.current')}</span>{' '}
                    <span className="font-medium">{fullOrderData?.confirmed_by_name || t('orderModal.noneLegacy')}</span>
                  </div>

                  <Popover open={attrPopoverOpen} onOpenChange={setAttrPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-2">
                        {t('orderModal.changeCreditedAgent')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[320px] p-0" align="end">
                      <Command>
                        <CommandInput placeholder={t('orderModal.searchAgents')} />
                        <CommandList>
                          <CommandEmpty>{t('orderModal.noAgentsFound')}</CommandEmpty>
                          <CommandGroup>
                            {agents.map((agent: any) => (
                              <CommandItem
                                key={agent.user_id}
                                onSelect={() => {
                                  setSelectedNewAgentId(agent.user_id);
                                  setAttrPopoverOpen(false);
                                }}
                                className="cursor-pointer"
                              >
                                <div className="flex items-center gap-2 w-full">
                                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary shrink-0">
                                    {(agent.full_name || 'A').charAt(0).toUpperCase()}
                                  </div>
                                  <span>{agent.full_name}</span>
                                  {selectedNewAgentId === agent.user_id && <Check className="ml-auto h-4 w-4" />}
                                </div>
                              </CommandItem>
                            ))}
                            {agents.length === 0 && agentsLoading && (
                              <div className="p-2 text-sm text-muted-foreground">{t('orderModal.loadingAgents')}</div>
                            )}
                          </CommandGroup>
                        </CommandList>
                      </Command>

                      {selectedNewAgentId && (
                        <div className="border-t p-3 bg-muted/50">
                          <div className="text-xs text-muted-foreground mb-2">{t('orderModal.newCreditWillBe')}</div>
                          <div className="font-medium text-sm mb-3">
                            {agents.find((a: any) => a.user_id === selectedNewAgentId)?.full_name || t('orderModal.selectedAgent')}
                          </div>
                          <Button
                            size="sm"
                            className="w-full"
                            variant="default"
                            onClick={() => setShowAttrConfirm(true)}
                          >
                            {t('orderModal.confirmCreditChange')}
                          </Button>
                        </div>
                      )}
                    </PopoverContent>
                  </Popover>
                </div>

                {fullOrderData?.confirmed_by_name && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2 h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      setSelectedNewAgentId(null);
                      setShowAttrConfirm(true);
                    }}
                  >
                    {t('orderModal.clearSalesCredit')}
                  </Button>
                )}
              </div>
            )}

            {/* Attribution Change Confirmation Dialog */}
            <AlertDialog open={showAttrConfirm} onOpenChange={setShowAttrConfirm}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('orderModal.attrDialogTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('orderModal.attrDialogDesc')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={async () => {
                      try {
                        await apiCorrectOrderAttribution(data!.id, {
                          confirmed_by_agent_id: selectedNewAgentId,
                        });
                        toast({
                          title: t('orderModal.creditUpdated'),
                          description: selectedNewAgentId
                            ? t('orderModal.creditChangedDesc')
                            : t('orderModal.creditClearedDesc'),
                        });
                        setShowAttrConfirm(false);
                        setAttrPopoverOpen(false);
                        setSelectedNewAgentId(null);
                        onClose(true);
                      } catch (e: any) {
                        toast({ title: t('orderModal.updateFailed'), description: apiErrorText(e), variant: 'destructive' });
                      }
                    }}
                    className="bg-destructive hover:bg-destructive/90"
                  >
                    {t('orderModal.yesChangeCredit')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            {/* B) Call Outcome */}
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('orderModal.callOutcome')}</h3>
              <div className="grid grid-cols-3 gap-2">
                {OUTCOME_CONFIG.map(({ value, className }) => (
                  <button
                    key={value}
                    onClick={() => isEditable && setSelectedOutcome(value)}
                    disabled={!isEditable}
                    className={cn(
                      'rounded-lg border-2 px-2 py-2 text-xs font-medium transition-all',
                      selectedOutcome === value
                        ? className + ' ring-2 ring-primary/40 shadow-sm'
                        : 'border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground',
                      !isEditable && 'opacity-50 cursor-not-allowed'
                    )}
                  >
                    {t(`outcome.${value}`)}
                  </button>
                ))}
              </div>
            </section>

            {/* Cancellation reason — required when outcome=cancelled OR when
                an admin manually flips the order's status to cancelled.
                Skipped for leads (lead status has its own taxonomy). */}
            {!isLead && (selectedOutcome === 'cancelled' || selectedStatus === 'cancelled') && (
              <section>
                <CancellationReasonPicker
                  value={cancellationReason}
                  notes={cancellationReasonNotes}
                  onChange={setCancellationReason}
                  onNotesChange={setCancellationReasonNotes}
                  disabled={!isEditable}
                />
              </section>
            )}

            {/* Follow-up date */}
            {selectedOutcome === 'call_again' && (
              <section>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('orderModal.followUpDate')}</h3>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 text-sm w-full justify-start font-normal">
                      <CalendarIcon className="h-3.5 w-3.5" />
                      {followUpDate ? formatDate(followUpDate, 'PPP') : t('orderModal.selectDate')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={followUpDate}
                      onSelect={setFollowUpDate}
                      disabled={(date) => date < new Date()}
                      className="p-3 pointer-events-auto"
                    />
                  </PopoverContent>
                </Popover>
              </section>
            )}

            {/* C) Status Dropdown */}
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('orderModal.statusLabel')}</h3>
              <Select value={selectedStatus} onValueChange={setSelectedStatus} disabled={!isEditable}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map(opt => (
                    <SelectItem key={opt.value} value={opt.value}>
                      <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', opt.color)}>
                        {t(opt.labelKey)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </section>

            {/* Trash reason — the twin of the cancellation picker above. Shown
                whenever the order is being (or already is) trashed, so an admin
                can both record a reason from /orders and correct one later
                without touching the status. The 'wrong_number' outcome also
                lands here (it forces status=trashed server-side) pre-selected
                on Wrong number, still overridable. */}
            {!isLead && (selectedStatus === 'trashed' || selectedOutcome === 'wrong_number') && (
              <section>
                <TrashReasonPicker
                  idPrefix="order-modal-trash"
                  value={trashReason}
                  notes={trashReasonNotes}
                  onChange={setTrashReason}
                  onNotesChange={setTrashReasonNotes}
                  disabled={!isEditable}
                />
              </section>
            )}

            {/* Ship After Date (only for orders, visible when confirmed) */}
            {!isLead && ['confirmed', 'take', 'call_again', 'pending'].includes(selectedStatus) && (
              <section>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('orderModal.shipAfter')}</h3>
                <p className="text-xs text-muted-foreground mb-2">{t('orderModal.shipAfterDesc')}</p>
                <div className="flex items-center gap-2">
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className={cn("h-8 gap-1.5 text-sm flex-1 justify-start font-normal", !shipAfterDate && "text-muted-foreground")} disabled={!isEditable}>
                        <CalendarIcon className="h-3.5 w-3.5" />
                        {shipAfterDate ? formatDate(shipAfterDate, 'PPP') : t('orderModal.noDelayedShipment')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={shipAfterDate}
                        onSelect={setShipAfterDate}
                        disabled={(date) => date < new Date()}
                        className="p-3 pointer-events-auto"
                      />
                    </PopoverContent>
                  </Popover>
                  {shipAfterDate && isEditable && (
                    <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={() => setShipAfterDate(undefined)}>
                      {t('common.clear')}
                    </Button>
                  )}
                </div>
                {shipAfterDate && (
                  <div className="mt-2 flex items-center gap-1.5">
                    <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30 text-[10px]">
                      {t('orderModal.delayedBadge', { date: formatDate(shipAfterDate, 'MMM d, yyyy') })}
                    </Badge>
                  </div>
                )}
              </section>
            )}

            {/* D) Products */}
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <ShoppingCart className="h-3 w-3" /> {t('orderModal.products')}
              </h3>
              <div className="space-y-2">
                {items.map((item, idx) => {
                  if (item._deleted) return null;
                  return (
                    <div key={item.id} className="rounded-lg border bg-muted/30 p-3 space-y-2.5">
                      {/* Wide product picker + remove */}
                      <div className="flex items-start gap-2">
                        <ProductCombobox
                          products={productsList}
                          value={item.product_id}
                          productName={item.product_name}
                          onChange={(id) => isEditable && changeItemProduct(idx, id)}
                          disabled={!isEditable}
                          className="flex-1"
                        />
                        {isEditable && (
                          <button
                            onClick={() => removeItem(idx)}
                            className="mt-1 shrink-0 p-1.5 text-muted-foreground hover:text-destructive transition-colors"
                            title={t('common.delete')}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>

                      {/* Qty · Unit price · Line total */}
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">{t('orderModal.colQty')}</label>
                          <Input
                            type="number" min={1} value={item.quantity}
                            onChange={e => updateItem(idx, 'quantity', Math.max(1, parseInt(e.target.value) || 1))}
                            className="h-8 text-sm text-center"
                            disabled={!isEditable}
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">{t('orderModal.colPrice')}</label>
                          <Input
                            type="number" min={0} step="1" value={eurToDen(item.price_per_unit)}
                            onChange={e => updateItem(idx, 'price_per_unit', denToEur(Math.max(0, parseFloat(e.target.value) || 0)))}
                            className="h-8 text-sm text-right tabular-nums"
                            disabled={!isEditable}
                          />
                        </div>
                        <div>
                          <label className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground">{t('orderModal.colTotal')}</label>
                          <div className="relative">
                            <Input
                              type="text" inputMode="numeric"
                              value={totalDraft[idx] ?? String(eurToDen(calcRowTotal(item.quantity, item.price_per_unit)))}
                              onChange={e => { const v = e.target.value; setTotalDraft(d => ({ ...d, [idx]: v })); setLineTotal(idx, denToEur(parseFloat(v) || 0)); }}
                              onBlur={() => setTotalDraft(d => { const c = { ...d }; delete c[idx]; return c; })}
                              className="h-8 pr-9 text-sm text-right font-semibold text-primary tabular-nums"
                              disabled={!isEditable}
                            />
                            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-sm text-primary">ден</span>
                          </div>
                        </div>
                      </div>

                      {isLegacyPromoName(item.product_name, item.product_id) && (
                        <div className="text-[10px] text-amber-700 dark:text-amber-300" title={t('orderModal.promoWarningTitle')}>
                          {t('orderModal.promoWarning')}
                        </div>
                      )}
                    </div>
                  );
                })}

                {isEditable && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addProductRow}
                    disabled={loadingProducts || productsList.length === 0}
                    className="w-full gap-1.5 text-xs border-dashed h-7"
                  >
                    <Plus className="h-3 w-3" />
                    {t('orderModal.addProduct')}
                  </Button>
                )}

                {activeItems.length > 0 && (
                  <div className="pt-1 text-[10px] text-muted-foreground">
                    {t('orderModal.lines')} {activeItems.map((i, idx) => {
                      const isDirty = isLegacyPromoName(i.product_name, i.product_id);
                      return (
                        <span key={idx}>
                          {idx > 0 && ', '}
                          <span className={cn("font-medium", isDirty ? "text-amber-700 dark:text-amber-300" : "text-foreground")}>
                            {formatProductWithQuantity(i.product_name, i.quantity)}
                            {isDirty && <span className="text-[9px] align-super ml-0.5">⚠</span>}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Product Recommendations */}
              {isEditable && customerIntel?.recommendations && (
                <ProductRecommendations
                  recommendations={customerIntel.recommendations}
                  currentProductNames={activeItems.map(i => i.product_name)}
                  onAdd={(productId, productName) => {
                    const product = productsList.find(p => p.id === productId);
                    setItems(prev => [...prev, {
                      id: `_new_${Date.now()}`,
                      product_id: productId,
                      product_name: productName,
                      quantity: 1,
                      price_per_unit: product ? Number(product.price) || 0 : 0,
                      total_price: product ? Number(product.price) || 0 : 0,
                      _isNew: true,
                    }]);
                  }}
                  disabled={loadingProducts}
                />
              )}
            </section>

            {/* E) Payment Summary */}
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('orderModal.paymentSummary')}</h3>
              <div className="rounded-lg border bg-card p-3 space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>{t('orderModal.subtotal', { count: activeItems.length })}</span>
                  <span className="font-mono tabular-nums text-right leading-tight">
                    <span className="block">{formatMoney(subtotal)}</span>
                  </span>
                </div>

                <div className="border-t border-dashed pt-2 flex justify-between text-sm font-bold">
                  <span>{t('orderModal.finalTotal')}</span>
                  <span className="text-primary font-mono tabular-nums text-right leading-tight">
                    <span className="block text-base">{formatMoney(finalTotal)}</span>
                  </span>
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <span className="text-xs text-muted-foreground shrink-0">{t('orderModal.amountPaid')}</span>
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={amountPaid}
                    onChange={e => setAmountPaid(Math.max(0, parseFloat(e.target.value) || 0))}
                    className="h-7 w-28 text-xs text-right ml-auto"
                  />
                </div>
                {amountPaid > 0 && (
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">{t('orderModal.remainingBalance')}</span>
                    <span className={cn('font-mono tabular-nums font-medium text-right leading-tight', remainingBalance > 0 ? 'text-destructive' : 'text-emerald-600')}>
                      <span className="block">{formatMoney(remainingBalance)}</span>
                    </span>
                  </div>
                )}
              </div>
            </section>

            {/* Notes */}
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('orderModal.notes')}</h3>
              <Textarea
                value={callNotes}
                onChange={e => setCallNotes(e.target.value)}
                placeholder={t('orderModal.addNotes')}
                className="min-h-[60px] text-sm"
                disabled={!isEditable}
              />
            </section>

            {/* Script Toggle */}
            <section>
              <button
                onClick={() => setShowScript(!showScript)}
                className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
              >
                <FileText className="h-3.5 w-3.5" />
                {showScript ? t('orderModal.hideScript') : t('orderModal.showScript')}
                {showScript ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </button>
              {showScript && (
                <div className="mt-2">
                  {loadingScript ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : editingScript ? (
                    <div className="space-y-2">
                      <Textarea value={editedScript} onChange={e => setEditedScript(e.target.value)} className="min-h-[120px] text-sm" />
                      <div className="flex gap-2">
                        <Button size="sm" onClick={handleSaveScript}>{t('orderModal.saveScript')}</Button>
                        <Button size="sm" variant="outline" onClick={() => setEditingScript(false)}>{t('common.cancel')}</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap leading-relaxed max-h-[150px] overflow-y-auto">
                      {personalizedScript || t('orderModal.noScript')}
                      {isAdmin && (
                        <button onClick={() => { setEditedScript(script); setEditingScript(true); }} className="block mt-2 text-xs text-primary hover:underline">
                          {t('orderModal.editScript')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Previous Calls */}
            {callLogs.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{t('orderModal.previousCalls')}</h3>
                <div className="space-y-1 max-h-[100px] overflow-y-auto">
                  {callLogs.slice(0, 5).map((log: any) => (
                    <div key={log.id} className="rounded bg-muted/30 border p-2 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-medium">{t(`outcome.${log.outcome}`, { defaultValue: log.outcome.replace(/_/g, ' ') })}</span>
                        <span className="text-muted-foreground">{new Date(log.created_at).toLocaleString()}</span>
                      </div>
                      {log.notes && <p className="mt-0.5 text-muted-foreground">{log.notes}</p>}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Order Notes — historical context attached to this order
                (Bulgarian comments, source channel, original LEV from imports, etc.) */}
            {orderNotes.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <FileText className="h-3 w-3" /> {t('orderModal.orderNotes')}
                  <span className="text-muted-foreground font-normal normal-case">({orderNotes.length})</span>
                </h3>
                <div className="space-y-1 max-h-[140px] overflow-y-auto">
                  {orderNotes.map((n: any) => (
                    <div key={n.id} className="rounded bg-amber-50/50 border border-amber-200/60 p-2 text-xs dark:bg-amber-950/20 dark:border-amber-800/40">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="font-medium text-[10px] uppercase tracking-wide text-amber-800 dark:text-amber-300">
                          {n.author_name || t('orderModal.system')}
                        </span>
                        <span className="text-muted-foreground text-[10px]">{new Date(n.created_at).toLocaleDateString()}</span>
                      </div>
                      <p className="text-muted-foreground whitespace-pre-wrap break-words">{cleanNoteForDisplay(n.text)}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* Footer */}
          <div className="border-t px-5 py-3 flex items-center justify-end gap-2 bg-card rounded-b-xl">
            <Button variant="outline" size="sm" onClick={() => onClose()}>
              {readOnly ? t('common.close') : t('common.cancel')}
            </Button>
            {isEditable && (
              <Button
                size="sm"
                onClick={handleSave}
                disabled={saving || ((isLead || !isAdmin) && !selectedOutcome && !(!isLead && selectedStatus === 'confirmed'))}
                className="gap-1.5"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {t('common.save')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
