import i18n from '@/i18n';

export type OrderStatus =
  | 'pending' 
  | 'take' 
  | 'call_again' 
  | 'confirmed' 
  | 'shipped' 
  | 'delivered'
  | 'returned' 
  | 'paid' 
  | 'trashed'
  | 'cancelled'
  | 'duplicated';

export interface Order {
  id: string;
  product: string;
  productId: string;
  customerName: string;
  customerPhone: string;
  customerCity: string;
  customerAddress: string;
  postalCode: string;
  birthday: string | null;
  price: number;
  status: OrderStatus;
  assignedAgent: string | null;
  assignedAgentId: string | null;
  assignedAt: string | null;
  assignedBy: string | null;
  createdAt: string;
  notes: Note[];
  statusHistory: StatusChange[];
  sourceType?: string;
  sourceLeadId?: string | null;
}

export interface Note {
  id: string;
  text: string;
  author: string;
  createdAt: string;
}

export interface StatusChange {
  from: OrderStatus;
  to: OrderStatus;
  changedBy: string;
  changedAt: string;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'agent';
  isActive: boolean;
  lastLogin: string;
  totalProcessed: number;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  photo?: string;
  isActive: boolean;
}

// Status display labels live in src/i18n/locales/*.json under "status.*".
// Components rendering this must call useTranslation() so they re-render on
// language switch. Unknown/legacy values fall back to the raw value.
export const statusLabel = (s: OrderStatus | string): string =>
  i18n.t(`status.${s}`, { defaultValue: String(s) });

// ── Single source of truth for status pill colours ──
// One canonical, bold-but-pleasant palette used EVERYWHERE a status pill renders
// (table badges, filter chips/dropdown, dossiers, history). Soft tint + matching
// border; Paid is solid dark green to stand out as the money-in state. If you
// change a colour, change it here only.
// Solid filled pills (saturated bg + white text), matching border so it stays
// invisible wherever a border width is applied. One canonical set used everywhere.
export const STATUS_COLORS: Record<OrderStatus, string> = {
  pending: 'bg-amber-500 text-white border-amber-500',       // yellow / orange
  take: 'bg-purple-500 text-white border-purple-500',        // purple
  call_again: 'bg-sky-500 text-white border-sky-500',        // light blue
  confirmed: 'bg-green-500 text-white border-green-500',      // light green
  shipped: 'bg-blue-500 text-white border-blue-500',         // blue
  delivered: 'bg-teal-500 text-white border-teal-500',       // teal
  returned: 'bg-pink-500 text-white border-pink-500',        // pink
  paid: 'bg-emerald-600 text-white border-emerald-600',      // dark green
  trashed: 'bg-gray-500 text-white border-gray-500',         // gray
  cancelled: 'bg-red-500 text-white border-red-500',         // red
  duplicated: 'bg-indigo-500 text-white border-indigo-500',  // indigo — admin/manager-created copy awaiting settlement
};

export const AGENT_ALLOWED_STATUSES: OrderStatus[] = ['pending', 'take', 'call_again', 'confirmed'];
export const ALL_STATUSES: OrderStatus[] = ['pending', 'take', 'call_again', 'confirmed', 'shipped', 'delivered', 'returned', 'paid', 'trashed', 'cancelled'];

/** Statuses where product/price/quantity editing is locked */
export const LOCKED_STATUSES: OrderStatus[] = ['shipped', 'delivered', 'paid'];

/** Returns true if product, price, and quantity fields can be edited for this order status */
export function canEditOrder(status: OrderStatus | string): boolean {
  return !LOCKED_STATUSES.includes(status as OrderStatus);
}

// Prediction Lists
export type PredictionLeadStatus = 'not_contacted' | 'no_answer' | 'interested' | 'not_interested' | 'confirmed';

export const PREDICTION_LEAD_STATUSES: PredictionLeadStatus[] = ['not_contacted', 'no_answer', 'interested', 'not_interested', 'confirmed'];

// Labels in src/i18n/locales/*.json under "leadStatus.*" — same re-render
// contract as statusLabel above.
export const predictionLeadLabel = (s: PredictionLeadStatus | string): string =>
  i18n.t(`leadStatus.${s}`, { defaultValue: String(s) });

export const PREDICTION_LEAD_COLORS: Record<PredictionLeadStatus, string> = {
  not_contacted: 'bg-gray-400 text-white border-gray-400',
  no_answer: 'bg-amber-500 text-white border-amber-500',
  interested: 'bg-sky-500 text-white border-sky-500',
  not_interested: 'bg-rose-500 text-white border-rose-500',
  confirmed: 'bg-green-500 text-white border-green-500',         // light green, matches order Confirmed
};

export interface PredictionEntry {
  id: string;
  name: string;
  telephone: string;
  address: string;
  city: string;
  product: string;
  status: PredictionLeadStatus;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  notes: string;
}

export interface PredictionList {
  id: string;
  name: string;
  uploadedAt: string;
  totalRecords: number;
  assignedCount: number;
  entries: PredictionEntry[];
}
