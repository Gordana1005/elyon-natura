/**
 * /warehouse (plan Фаза 9, owner 30.09.2026): the queue (GET /warehouse/queue),
 * "Испрати до MEX" (POST /warehouse/mex-push — the dry run first, always) and the
 * admin switch (GET / PATCH /warehouse/mex-push/settings). Same base URL and auth
 * as every other call (apiFetch). Money keys (…_eur / …_mkd, the payload's cod)
 * arrive only for business owners — the server strips them for everyone else.
 */
import { apiFetch } from './api';

export const WAREHOUSE_DEPARTMENTS = ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'] as const;
export type WarehouseDepartment = (typeof WAREHOUSE_DEPARTMENTS)[number];
export type WarehouseTab = 'send' | 'pack' | 'pack_stale';
export type QueueOrder = 'oldest' | 'newest';
export type MexAccount = 'bio_natural' | 'natura';
export const MEX_ACCOUNTS: MexAccount[] = ['bio_natural', 'natura'];

export interface QueueCounts {
  send: number;
  send_by_department: Record<string, number>;
  send_over_3d: number;
  send_no_address: number;
  send_no_zone: number;
  send_unconfirmed: number;
  pack: number;
  pack_by_department: Record<string, number>;
  pack_over_3d: number;
  pack_stale: number;
  active_products: number;
  stale_days: number;
}

export interface QueueItem { product_id?: string | null; product_name?: string | null; quantity?: number | null; brand_line?: string | null }

export interface PushWarning {
  code: 'unlinked_parcel' | 'collabbox_doc' | 'other_parcel' | 'sent_unconfirmed' | 'last_attempt_failed';
  blocking: boolean;
  tracking_id?: string;
  doc_number?: string;
  doc_at?: string;
  type?: string;
  order_display_id?: string;
  created_at?: string;
  mex_sent_at?: string;
  error?: string;
  at?: string;
  account?: string;
}

export interface AccountSuggestion {
  suggested: MexAccount | null;
  basis: 'product_line' | 'department' | 'none';
  reasons: string[];
  needs_pick: boolean;
  line_profiles: MexAccount[];
  department_profile: MexAccount | null;
  team_profile: MexAccount | null;
  open: boolean;
}

export interface SendRow {
  id: string;
  display_id: string;
  status: string;
  created_at: string;
  sale_at: string;
  department: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_city: string | null;
  postal_code: string | null;
  mex_city_id: number | null;
  mex_city_name: string | null;
  ship_after_date: string | null;
  price_eur?: number | null;
  product_name: string | null;
  quantity: number | null;
  items: QueueItem[];
  seller: string | null;
  seller_team: string | null;
  mex_sent_at: string | null;
  validation: { ok: boolean; missing: string[] };
  account: AccountSuggestion;
  warnings: PushWarning[];
  blockers: string[];
  no_parcel_days_left: number | null;
  zone: { id: number | null; name: string | null };
}

export interface PackRow {
  tracking_id: string;
  account: MexAccount;
  series: string | null;
  status_id: number;
  status_name: string | null;
  created_at: string | null;
  last_update_at: string | null;
  receiver_name: string | null;
  receiver_city: string | null;
  cod_mkd?: number | null;
  link_method: string | null;
  department: string;
  order_id: string | null;
  display_id: string | null;
  order_status: string | null;
  customer_name: string | null;
  mex_sent_at: string | null;
  items: QueueItem[];
}

export interface PushSwitch {
  enabled: boolean;
  accounts: Record<MexAccount, boolean>;
  max_per_send: number;
  auto_send_at: string | null;
  auto_send_scheduled: boolean;
  keys: Record<MexAccount, boolean>;
  can_push: boolean;
  can_toggle: boolean;
}

export interface QueueResponse<R> {
  tab: WarehouseTab;
  order: QueueOrder;
  limit: number;
  offset: number;
  total: number;
  counts: QueueCounts;
  rows: R[];
  push: PushSwitch;
  money: boolean;
  generated_at: string;
}

export const apiGetWarehouseQueue = <R = SendRow | PackRow>(p: {
  tab: WarehouseTab; departments?: string[]; order?: QueueOrder; limit?: number; offset?: number;
}): Promise<QueueResponse<R>> => {
  const sp = new URLSearchParams({ tab: p.tab });
  if (p.departments?.length) sp.set('departments', p.departments.join(','));
  if (p.order) sp.set('order', p.order);
  if (p.limit) sp.set('limit', String(p.limit));
  if (p.offset) sp.set('offset', String(p.offset));
  return apiFetch(`warehouse/queue?${sp.toString()}`);
};

// ── POST /warehouse/mex-push ─────────────────────────────────────────────────

export interface AccountOverride { account: MexAccount; reason: string; double_ok?: boolean }

export interface MexPayload {
  tracking_id: string; sender_reference: string; first_name: string; last_name: string;
  receiver_phone: string; receiver_address?: string; receiver_city_id: number; cod: string; weight: number; instructions?: string;
}

export type PushOutcome = 'sent' | 'exists_linked' | 'skipped' | 'error' | 'unknown_outcome' | 'not_claimed' | 'deferred' | 'dry_run';

export interface PushResult {
  order_id: string;
  display_id: string | null;
  outcome: PushOutcome;
  account: MexAccount | null;
  tracking_id?: string | null;
  reason?: string | null;
  blockers?: string[];
  warnings?: PushWarning[];
  decision?: { account: MexAccount | null; basis: string; reasons: string[]; needs_pick: boolean };
  payload?: MexPayload | null;
  csv?: { ime: string; adresa: string; grad: string; telefon: string; otkup: string; opis: string; tezina: string };
}

export interface PushResponse {
  dry_run: boolean;
  results: PushResult[];
  stopped: string | null;
  settings: { enabled: boolean; accounts: Record<MexAccount, boolean> };
  keys: Record<MexAccount, boolean>;
  money: boolean;
}

export const apiMexPush = (body: { order_ids: string[]; account_overrides?: Record<string, AccountOverride>; dry_run: boolean }): Promise<PushResponse> =>
  apiFetch('warehouse/mex-push', { method: 'POST', body: JSON.stringify(body) });

// ── the switch ───────────────────────────────────────────────────────────────

export interface PushSettings {
  enabled: boolean;
  accounts: Record<MexAccount, boolean>;
  auto_send_at: string | null;
  max_per_send: number;
}
export interface PushSettingsResponse { settings: PushSettings; keys: Record<MexAccount, boolean>; auto_send_scheduled: boolean; can_toggle: boolean }

export const apiGetMexPushSettings = (): Promise<PushSettingsResponse> => apiFetch('warehouse/mex-push/settings');
export const apiPatchMexPushSettings = (patch: Partial<Pick<PushSettings, 'enabled' | 'max_per_send'>> & { accounts?: Partial<Record<MexAccount, boolean>> }): Promise<PushSettingsResponse> =>
  apiFetch('warehouse/mex-push/settings', { method: 'PATCH', body: JSON.stringify(patch) });

// ── stock movements, paged (GET /stock-movements?limit&offset) ────────────────

export interface StockMovement {
  id: string;
  product_id: string | null;
  product_name: string;
  product_sku: string;
  change_amount: number;
  previous_stock: number | null;
  new_stock: number | null;
  movement_type: string | null;
  reason: string | null;
  notes: string | null;
  user_name: string;
  supplier_name: string | null;
  invoice_number: string | null;
  tracking_id?: string | null;
  created_at: string;
}

export const apiGetStockMovementsPage = (p: { product_id?: string; movement_type?: string; limit: number; offset: number }): Promise<StockMovement[]> => {
  const sp = new URLSearchParams({ limit: String(p.limit), offset: String(p.offset) });
  if (p.product_id) sp.set('product_id', p.product_id);
  if (p.movement_type) sp.set('movement_type', p.movement_type);
  return apiFetch(`stock-movements?${sp.toString()}`);
};
