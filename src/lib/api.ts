import { supabase } from '@/integrations/supabase/client';

const API_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/api`;

async function getHeaders() {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${session?.access_token || ''}`,
    'apikey': import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  };
}

async function apiFetch<T = any>(path: string, options?: RequestInit): Promise<T> {
  const headers = await getHeaders();
  const res = await fetch(`${API_BASE}/${path}`, {
    ...options,
    headers: { ...headers, ...options?.headers },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API error');
  return data;
}

// Auth
export const apiGetMe = () => apiFetch('me');

// VoIP — per-agent SIP credentials (the browser registers as ITS OWN extension).
// The secret is returned only for the logged-in user and held in memory only.
export interface VoipCredentials {
  extension: string;
  secret: string;
  ws_url: string;
  primary_caller_id: string;
  secondary_caller_id: string | null;
}
export const apiGetVoipCredentials = (): Promise<VoipCredentials> => apiFetch('voip/credentials');

// Recordings — listed from the PBX; audio streamed on demand via a short-lived
// signed URL (admins/managers only).
export interface RecordingItem {
  file: string;
  date: string | null;
  time: string | null;
  callerid: string | null;
  dialed: string | null;
  ext: string | null;
  uniqueid: string | null;
  size: number;
  mtime: number;
  // Enriched from the matching call log (may be null if no match):
  agent_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  outcome: string | null;
  call_at: string | null;
}
export const apiGetRecordings = (): Promise<{ recordings: RecordingItem[] }> => apiFetch('recordings');
export const apiGetRecordingAudioUrl = (file: string): Promise<{ url: string }> =>
  apiFetch(`recordings/audio?file=${encodeURIComponent(file)}`);

// Per-agent caller-ID (superadmin) — default +35924234100; assign any owned DID.
export interface VoipAgent { user_id: string; extension: string; primary_caller_id: string; full_name: string; email: string; }
export interface VoipDid { value: string; label: string; }
export const apiGetVoipAgents = (): Promise<{ agents: VoipAgent[]; dids: VoipDid[] }> => apiFetch('voip/agents');
export const apiSetAgentCallerId = (userId: string, caller_id: string) =>
  apiFetch(`voip/agents/${userId}/caller-id`, { method: 'PUT', body: JSON.stringify({ caller_id }) });

// ── VOIP / Telephony Health (superadmin) ──
// Live PBX/server status (disk, memory, lines in use vs the A1 trunk's channel
// cap, trunk up/down, fail2ban attacks, recordings) merged with today's call/
// recording/quality stats, plus incidents[] that drive the in-CRM alert banner.
// The cap is never hardcoded here — it comes from the PBX in `pbx.lines.max`.
export interface VoipIncident { level: 'critical' | 'warning'; code: string; message: string; }
export interface PbxLiveHealth {
  ok?: boolean;
  error?: string;
  ts?: number;
  disk?: { total: number; used: number; free: number; pct: number; rec_bytes?: number; rec_human?: string };
  mem?: { total: number; used: number; free: number; pct: number };
  load?: { '1': number; '5': number; '15': number };
  asterisk?: { running: boolean; uptime_seconds?: number };
  lines?: { active: number; max: number; channels?: Array<{ ext: string | null; dialed: string | null; duration: number; state: string }> };
  trunk?: { name: string; reachable: boolean; rtt_ms?: number | null };
  extensions?: Array<{ ext: string; registered: boolean }>;
  recordings_today?: { count: number; newest_mtime?: number; newest_age_seconds?: number };
  attacks?: { jail?: string; banned_count: number; banned_ips?: string[] };
  errors?: Array<{ src: string; line: string }>;
}
export interface VoipHealth {
  pbx: PbxLiveHealth;
  snapshot_age_seconds: number | null;
  today: {
    calls: number; answered: number; no_answer: number; outbound_minutes: number;
    recording_coverage_pct: number; answered_recorded: number; answered_unrecorded: number; one_way_audio: number;
  };
  incidents: VoipIncident[];
}
export const apiGetVoipHealth = (): Promise<VoipHealth> => apiFetch('voip/health');

export interface PbxSnapshot {
  captured_at: string; disk_pct: number | null; mem_pct: number | null; load1: number | null;
  active_lines: number | null; trunk_reachable: boolean | null; recordings_today: number | null;
  banned_ips: number | null; rec_bytes: number | null;
}
export const apiGetVoipHealthHistory = (range: '24h' | '7d' | '30d' = '24h'): Promise<{ snapshots: PbxSnapshot[] }> =>
  apiFetch(`voip/health/history?range=${range}`);

export interface RecordingGap {
  id: string; agent_id: string | null; agent_name: string | null; customer_phone: string | null;
  call_at: string | null; outcome: string | null; reason: string;
}
export const apiGetRecordingCoverage = (range: '24h' | '7d' | '30d' = '7d'): Promise<{
  answered: number; recorded: number; unrecorded: number; coverage_pct: number; gaps: RecordingGap[];
}> => apiFetch(`voip/recording-coverage?range=${range}`);

/** Current A1 billing cycle vs the contracted bundle. Estimated from our own
 *  call_logs, NOT from A1's invoice — see the caveat shown on the Minutes tab. */
export interface VoipMinutesCycle {
  start: string; end: string;
  days_total: number; days_elapsed: number; days_remaining: number;
  /** Which seconds column feeds `used_minutes`: 'talk' (what A1 bills) or 'total' (incl. ring). */
  metric: 'talk' | 'total';
  used_minutes: number; used_total_minutes: number; included_minutes: number;
  pct_used: number;
  /** Weekday-aware month-end forecast — weekends run far quieter than weekdays. */
  projected_minutes: number; projected_pct: number; projected_over_by: number;
  status: 'ok' | 'warn' | 'critical';
}
export const apiGetVoipMinutes = (range: '24h' | '7d' | '30d' = '7d', group: 'agent' | 'day' = 'day'): Promise<{
  total_minutes: number; talk_minutes: number; group: string;
  series: Array<{ key: string; minutes: number }>;
  cycle?: VoipMinutesCycle;
}> => apiFetch(`voip/minutes?range=${range}&group=${group}`);

// Missed (incoming) calls
export interface MissedCall {
  id: string;
  caller_number: string;
  did: string | null;
  occurred_at: string;
  status: 'new' | 'assigned' | 'called_back' | 'ignored';
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  linked_order_id: string | null;
  notes: string | null;
  customer_name: string | null;   // from the caller's last order, if any
  voicemail_file: string | null;     // set when the caller left a recorded message
  voicemail_seconds: number | null;  // approx message length
  // Who last contacted this caller — the agent who most recently CALLED the number
  // (call_logs), falling back to whoever handled their last order only if no call
  // exists — so a callback routes to the agent who already knows them.
  last_agent_name: string | null;
  last_agent_id: string | null;
  last_agent_at: string | null;
  last_agent_source: 'call' | 'order' | null;
  last_agent_detail: string | null;
}
export const apiGetMissedCalls = (status?: string): Promise<{ missed_calls: MissedCall[] }> =>
  apiFetch(`missed-calls${status ? `?status=${status}` : ''}`);
export const apiAssignMissedCall = (id: string, agent_id: string) =>
  apiFetch(`missed-calls/${id}/assign`, { method: 'POST', body: JSON.stringify({ agent_id }) });
export const apiBulkAssignMissedCalls = (ids: string[], agent_id: string) =>
  apiFetch('missed-calls/bulk-assign', { method: 'POST', body: JSON.stringify({ ids, agent_id }) });
export const apiGetMissedCallVoicemailUrl = (id: string): Promise<{ url: string }> =>
  apiFetch(`missed-calls/${id}/voicemail-url`);
export const apiSetMissedCallStatus = (id: string, status: string) =>
  apiFetch(`missed-calls/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) });

// Global search — matches orders + leads by phone (last-8 normalised), name, or
// order display_id. Powers the Search Prediction page and the topbar search.
export interface SearchPredictionResult {
  orders: any[];
  leads: any[];
  order_history: any[];
}
export const apiSearchPrediction = (q: string): Promise<SearchPredictionResult> =>
  apiFetch(`search-prediction?q=${encodeURIComponent(q)}`);

// Users
export const apiGetUsers = () => apiFetch('users');
export const apiGetAgents = () => apiFetch('users/agents');
export const apiCreateUser = (body: { email: string; password: string; full_name: string; role: string }) =>
  apiFetch('users/create', { method: 'POST', body: JSON.stringify(body) });
export const apiToggleUserActive = (userId: string) =>
  apiFetch(`users/${userId}/toggle-active`, { method: 'POST' });
export const apiUpdateUserRole = (userId: string, role: string) =>
  apiFetch(`users/${userId}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
export const apiSetUserRoles = (userId: string, roles: string[]) =>
  apiFetch(`users/${userId}/roles`, { method: 'PUT', body: JSON.stringify({ roles }) });
// Edit an existing user's identity (Superadmin only). Send only the fields that change.
export const apiUpdateUser = (
  userId: string,
  body: { full_name?: string; email?: string; password?: string },
) => apiFetch(`users/${userId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteUser = (userId: string) =>
  apiFetch(`users/${userId}`, { method: 'DELETE' });

// ── TV Leaderboard ───────────────────────────────────────────────────────────
// The public board is fetched WITHOUT auth (token in the URL), so apiGetLeaderboard
// bypasses apiFetch/getHeaders (which attach an empty Bearer). The admin config
// endpoints use the normal authenticated apiFetch (admin/manager only).
export interface LeaderboardRow {
  user_id: string;
  full_name: string;
  is_super: boolean;         // admin/manager — shown but earns €0
  rank: number;
  confirmed_count: number;
  packages: number;
  avg_order_value: number;   // EUR
  revenue: number;           // EUR — total confirmed revenue that day (prediction)
  target_pct: number;        // percent of the top revenue target (prediction)
  sold_rate: number;         // percent — sales ÷ clients called (pending)
  calls: number;
  bonus: number;             // EUR (per-package + milestone/target bonus)
  bonus_breakdown: Record<string, number>; // pending {package,volume,avg} | prediction {package,target}
}
export type LeaderboardMode = 'prediction' | 'pending';
export interface LeaderboardResponse {
  generated_at: string;
  mode: LeaderboardMode;
  day: string;               // YYYY-MM-DD (Europe/Skopje) being viewed
  today: string;             // YYYY-MM-DD (Europe/Skopje) now
  is_today: boolean;
  target: number;            // top revenue target (prediction); 0 for pending
  team_revenue: number;      // prediction: combined team revenue today (€)
  team_target_pct: number;   // prediction: team revenue as % of the top target
  team_target_bonus: number; // prediction: € bonus the team has unlocked so far
  agents: LeaderboardRow[];
}
export const apiGetLeaderboard = async (key: string, day?: string, mode?: LeaderboardMode): Promise<LeaderboardResponse> => {
  const qs = `key=${encodeURIComponent(key)}${day ? `&day=${encodeURIComponent(day)}` : ''}${mode ? `&mode=${mode}` : ''}`;
  const res = await fetch(`${API_BASE}/leaderboard?${qs}`, {
    headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Leaderboard error');
  return data as LeaderboardResponse;
};

export type LeaderboardMetric = 'confirmed_count' | 'avg_order_value' | 'conversion_rate' | 'revenue_target';
export interface LeaderboardTier { min: number; bonus: number }
export interface LeaderboardBonusRule { metric: LeaderboardMetric; tiers: LeaderboardTier[]; is_active: boolean }
export interface LeaderboardAccessToken { id: string; label: string | null; token: string; is_active: boolean; created_at: string }
export interface LeaderboardAdminConfig {
  mode: LeaderboardMode;
  roster_date: string;
  roster: string[];          // agent user_ids on today's board (for this mode)
  rules: LeaderboardBonusRule[];
  tokens: LeaderboardAccessToken[];
}
export const apiGetLeaderboardAdmin = (mode: LeaderboardMode): Promise<LeaderboardAdminConfig> =>
  apiFetch(`leaderboard/admin?mode=${mode}`);
export const apiSetLeaderboardRoster = (mode: LeaderboardMode, agent_ids: string[]) =>
  apiFetch('leaderboard/roster', { method: 'POST', body: JSON.stringify({ mode, agent_ids }) });
export const apiSetLeaderboardRule = (mode: LeaderboardMode, rule: LeaderboardBonusRule) =>
  apiFetch('leaderboard/rules', { method: 'POST', body: JSON.stringify({ mode, ...rule }) });
export const apiManageLeaderboardToken = (
  body: { action: 'create' | 'rotate' | 'revoke'; id?: string; label?: string },
): Promise<{ success: boolean; token?: LeaderboardAccessToken }> =>
  apiFetch('leaderboard/token', { method: 'POST', body: JSON.stringify(body) });

// Orders
export const apiGetOrders = (params?: { status?: string; search?: string; agent_id?: string; source?: string; ready_only?: boolean; lead_only?: boolean; from?: string; to?: string; price_min?: number; price_max?: number; page?: number; limit?: number }) => {
  const sp = new URLSearchParams();
  if (params?.status) sp.set('status', params.status);
  if (params?.search) sp.set('search', params.search);
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  if (params?.source) sp.set('source', params.source);
  if (params?.ready_only) sp.set('ready_only', '1');
  // Inbound leads only (altercpa | inbound_lead | opencart | opencart_abandoned).
  // Keeps agent-created `manual` work and the legacy `import` out of the
  // Pendings surfaces — same definition as public.is_lead_source().
  if (params?.lead_only) sp.set('lead_only', '1');
  if (params?.from) sp.set('from', params.from);
  if (params?.to) sp.set('to', params.to);
  if (params?.price_min != null) sp.set('price_min', String(params.price_min));
  if (params?.price_max != null) sp.set('price_max', String(params.price_max));
  if (params?.page) sp.set('page', String(params.page));
  if (params?.limit) sp.set('limit', String(params.limit));
  return apiFetch(`orders?${sp.toString()}`);
};
export const apiGetOrder = (id: string) => apiFetch(`orders/${id}`);

// Counts behind the "Pendings" queue entry on /calls. Always the caller's own
// book — the endpoint takes no agent_id.
export interface MyPendingsSummary {
  ready: number;        // callable right now
  open: number;         // incl. leads parked by a no-answer
  parked: number;       // open - ready
  talked_today: number; // leads I resolved today (Europe/Skopje)
}
export const apiGetMyPendingsSummary = (): Promise<MyPendingsSummary> =>
  apiFetch('my-pendings-summary');

// The customer's ONE open order, found with NO agent filter — this is what stops
// a lead being forked. RLS hides a colleague's row and the agent's own queue is
// scoped to them, so without this the Calls page could not find an existing lead
// and Confirm created a second order beside it.
export interface OpenLead {
  id: string;
  display_id: string;
  status: string;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  source_type: string | null;
  duplicated_from_display?: string | null;
}
// `leads` lists EVERY open order for the phone — a customer can have a pending
// lead AND a duplicate at once. `lead` is the newest, kept so older bundles still
// in a browser keep working. When leads.length > 1 the caller MUST let the agent
// choose, or the outcome lands on the wrong order.
export const apiGetOpenLead = (phone: string): Promise<{ lead: OpenLead | null; leads?: OpenLead[] }> =>
  apiFetch(`orders/open-lead?phone=${encodeURIComponent(phone)}`);

// Bulk trash / cancel WITH a reason (Orders page action bar). Deliberately
// separate from apiBulkStatusUpdate, which drives fulfilment states and writes
// no reason — rule 8: no order is junked without a reason, bulk paths included.
export interface BulkDispositionResult {
  success: boolean;
  updated: number;
  skipped: number;
  skipped_ids: string[];   // display_ids that were past confirm and left alone
}
export const apiBulkDisposition = (
  orderIds: string[],
  action: 'trashed' | 'cancelled',
  reason: string,
  reasonNotes?: string,
): Promise<BulkDispositionResult> =>
  apiFetch('orders/bulk-disposition', {
    method: 'POST',
    body: JSON.stringify({ order_ids: orderIds, action, reason, reason_notes: reasonNotes || undefined }),
  });

// Prediction-list call agains as a redistributable pool (Assigner tab). Leads
// are NOT here on purpose: a lead that didn't answer stays with its own agent.
export interface CallAgainMember {
  list_id: string;
  customer_phone: string;
  customer_name: string | null;
  call_again_since: string | null;
  last_call_at: string | null;
  last_call_outcome: string | null;
  in_call_again_until: string | null;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  lifetime_value: number | null;
  paid_count: number | null;
  avg_package_price: number | null;
  prediction_segment_lists?: { name: string; category: string } | null;
}
export const apiGetCallAgains = (params?: { page?: number; limit?: number; agent_id?: string }) => {
  const sp = new URLSearchParams();
  if (params?.page) sp.set('page', String(params.page));
  if (params?.limit) sp.set('limit', String(params.limit));
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  return apiFetch(`call-agains?${sp.toString()}`) as Promise<{
    members: CallAgainMember[]; total: number; page: number; limit: number;
  }>;
};
// Members span many lists, so the selection is (list_id, customer_phone) pairs.
// agent_id = null frees them back to the pool.
export const apiAssignCallAgains = (
  members: Array<{ list_id: string; customer_phone: string }>,
  agentId: string | null,
): Promise<{ success: boolean; assigned: number }> =>
  apiFetch('call-agains/assign', {
    method: 'POST',
    body: JSON.stringify({ members, agent_id: agentId }),
  });

export interface CreateOrderBody {
  product_id?: string | null;
  product_name: string;
  customer_name?: string;
  customer_phone?: string;
  customer_address?: string;
  customer_city?: string;
  postal_code?: string;
  street?: string;
  street_number?: string;
  quarter?: string;
  apartment?: string;
  floor?: string;
  block?: string;
  entry?: string;
  delivery_instructions?: string;
  gift_note?: string;
  delivery_type?: 'home' | 'speedy_office' | 'econt_office' | 'mex_office';
  home_courier?: 'speedy' | 'econt' | 'mex';
  courier_office_code?: string;
  courier_office_name?: string;
  courier_office_city?: string;
  birthday?: string | null;
  ship_after_date?: string | null;
  price?: number;
  quantity?: number;
  status?: 'pending' | 'confirmed' | 'call_again' | 'cancelled' | 'trashed';
  cancellation_reason?: CancellationReason;
  cancellation_reason_notes?: string;
  trash_reason?: TrashReason;
  trash_reason_notes?: string;
  notes?: string;
  items?: { product_id: string | null; product_name: string; quantity: number; price_per_unit: number }[];
}
export const apiCreateOrder = (body: CreateOrderBody) =>
  apiFetch('orders', { method: 'POST', body: JSON.stringify(body) });

// Duplicate an order (admin/manager only): server copies the order with the
// next sequential ORD number, status 'duplicated' + permanent link to source.
export const apiDuplicateOrder = (id: string) =>
  apiFetch(`orders/${id}/duplicate`, { method: 'POST' });

// Customer profile — per-phone customer info (birthday, address, delivery
// prefs, notes) saved independently of orders. Used to pre-fill the order
// modal and to "Save Info" during a call without creating an order.
export interface CustomerProfileBody {
  phone: string;
  customer_name?: string | null;
  birthday?: string | null;
  street?: string | null;
  street_number?: string | null;
  quarter?: string | null;
  apartment?: string | null;
  floor?: string | null;
  block?: string | null;
  entry?: string | null;
  city?: string | null;
  postal_code?: string | null;
  delivery_type?: string | null;
  home_courier?: string | null;
  courier_office_code?: string | null;
  courier_office_name?: string | null;
  courier_office_city?: string | null;
  delivery_instructions?: string | null;
  gift_note?: string | null;
  notes?: string | null;
}
export const apiGetCustomerProfile = (phone: string) =>
  apiFetch(`customer-profile?phone=${encodeURIComponent(phone)}`);
// One server-authorized bundle for the order modal prefill: saved profile +
// recent orders (with items), resolved across ALL agents so a front-line agent
// gets the customer's real name/address even when a prior order was taken by
// someone else (the RLS-scoped /orders search returns nothing for them).
export interface CustomerPrefill { profile: any | null; recent: any[]; }
export const apiGetCustomerPrefill = (phone: string): Promise<CustomerPrefill> =>
  apiFetch(`customer-prefill?phone=${encodeURIComponent(phone)}`);
export const apiSaveCustomerProfile = (body: CustomerProfileBody) =>
  apiFetch('customer-profile', { method: 'POST', body: JSON.stringify(body) });
// Notes-only save — upserts just the free-form customer note by phone without
// touching birthday/address/delivery prefs. Backs the Calls-page notes board.
export const apiSaveCustomerNotes = (phone: string, notes: string) =>
  apiFetch('customer-profile/notes', { method: 'POST', body: JSON.stringify({ phone, notes }) });

// Macedonian address autocomplete, served from mk_settlements / mk_streets
// (OpenStreetMap, ODbL). Settlements = cities, towns, villages and Skopje's
// districts. The query matches Cyrillic and Latin in either direction, so
// "Ѓорче", "Gjorce" and "Gorce" all reach Ѓорче Петров.
//
// `post_code` is what lets the form fill the postal code in automatically, and
// `mex_city_id` is null when MEX cannot route to the settlement at all.
export interface MkSettlement {
  id: string;
  name: string;
  name_lat: string | null;
  name_sq: string | null;
  post_code: string | null;
  region: string | null;
  municipality: string | null;
  kind: 'city' | 'town' | 'village' | 'city_district';
  mex_city_id: number | null;
}
export const apiSearchSettlements = (q: string): Promise<MkSettlement[]> =>
  apiFetch(`address/settlements?q=${encodeURIComponent(q)}`);
export const apiSearchStreets = (settlementId: string, q: string, kind?: 'street' | 'quarter'): Promise<string[]> =>
  apiFetch(`address/streets?settlement_id=${encodeURIComponent(settlementId)}&q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ''}`);
// Match a free-text courier address against the cached office list → ranked offices.
export interface MatchedOffice { office_code: string; name: string; city: string; address: string; score: number; }
export const apiMatchCourierOffice = (courier: 'speedy' | 'econt' | 'mex', q: string): Promise<MatchedOffice[]> =>
  apiFetch(`courier-offices/match?courier=${courier}&q=${encodeURIComponent(q)}`);

export interface UpdateCustomerBody {
  customer_name?: string;
  customer_phone?: string;
  customer_city?: string;
  customer_address?: string;
  postal_code?: string;
  street?: string;
  street_number?: string;
  quarter?: string;
  apartment?: string;
  floor?: string;
  block?: string;
  entry?: string;
  delivery_instructions?: string;
  gift_note?: string;
  delivery_type?: 'home' | 'speedy_office' | 'econt_office' | 'mex_office';
  home_courier?: 'speedy' | 'econt' | 'mex';
  courier_office_code?: string;
  courier_office_name?: string;
  courier_office_city?: string;
  birthday?: string | null;
  price?: number;
  quantity?: number;
  product_id?: string | null;
  product_name?: string;
  ship_after_date?: string | null;
}
export const apiUpdateCustomer = (orderId: string, body: UpdateCustomerBody) =>
  apiFetch(`orders/${orderId}/customer`, { method: 'PATCH', body: JSON.stringify(body) });

// Fix a customer's name / phone across EVERY one of their orders at once (matched
// by the current phone, last-8 normalised). Re-keys the prediction queue sources
// too. Returns the stored E.164 phone so the caller can re-point Dial at it.
export interface UpdateCustomerContactBody {
  phone: string;            // current phone (identifies the customer)
  customer_name?: string;   // new full name
  customer_phone?: string;  // new phone (stored as +389… E.164)
}
export const apiUpdateCustomerContact = (
  body: UpdateCustomerContactBody,
): Promise<{ ok: true; orders_updated: number; new_phone: string }> =>
  apiFetch('customers/update-contact', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateOrderStatus = (
  orderId: string,
  status: string,
  extras?: {
    cancellation_reason?: CancellationReason;
    cancellation_reason_notes?: string;
    trash_reason?: TrashReason;
    trash_reason_notes?: string;
    return_reason?: string;
    return_reason_notes?: string;
  },
) =>
  apiFetch(`orders/${orderId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status, ...(extras || {}) }),
  });

/** Admin-only: manually correct the immutable sales credit (original confirmer) on an order. */
export const apiCorrectOrderAttribution = (orderId: string, body: { confirmed_by_agent_id: string | null }) =>
  apiFetch(`orders/${orderId}/attribution`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const apiAssignOrder = (orderId: string, agentId: string) =>
  apiFetch(`orders/${orderId}/assign`, { method: 'POST', body: JSON.stringify({ agent_id: agentId }) });
export const apiAddOrderNote = (orderId: string, text: string) =>
  apiFetch(`orders/${orderId}/notes`, { method: 'POST', body: JSON.stringify({ text }) });

// Order Items
export const apiSyncOrderItems = (orderId: string, items: { product_id?: string | null; product_name: string; quantity: number; price_per_unit: number }[]) =>
  apiFetch(`orders/${orderId}/items`, { method: 'PUT', body: JSON.stringify({ items }) });
export const apiAddOrderItem = (orderId: string, body: { product_id?: string; product_name: string; quantity: number; price_per_unit: number }) =>
  apiFetch(`orders/${orderId}/items`, { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateOrderItem = (itemId: string, body: any) =>
  apiFetch(`order-items/${itemId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteOrderItem = (itemId: string) =>
  apiFetch(`order-items/${itemId}`, { method: 'DELETE' });
export const apiGetOrderStats = (from?: string, to?: string) => {
  const sp = new URLSearchParams();
  if (from) sp.set('from', from);
  if (to) sp.set('to', to);
  return apiFetch(`orders/stats?${sp.toString()}`);
};
export const apiGetDashboardStats = (params?: { period?: string; date?: string; from?: string; to?: string; agent_id?: string }) => {
  const sp = new URLSearchParams();
  if (params?.period) sp.set('period', params.period);
  if (params?.date) sp.set('date', params.date); // single-day override (◀ ▶ browsing), past days only
  if (params?.from) sp.set('from', params.from); // custom range (period=custom)
  if (params?.to) sp.set('to', params.to);
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  return apiFetch(`dashboard-stats?${sp.toString()}`);
};

// ── My Orders (agent dashboard drill-down) ──
// Server-scoped to the calling agent (salesOwner attribution); only the four
// detail tabs exist — cancelled/trashed are count-only by design.
export type MyOrdersTab = 'confirmed' | 'shipped' | 'paid' | 'returned';
export interface MyOrderItem {
  product_name: string;
  quantity: number;
  price_per_unit: number;
  total_price: number;
}
export interface MyOrderRow {
  id: string;
  display_id: string | null;
  status: MyOrdersTab;
  price: number;
  quantity: number | null;
  product_name: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  created_at: string;
  confirmed_at: string | null;
  shipped_at: string | null;
  paid_at: string | null;
  returned_at: string | null;
  return_reason: string | null;
  order_items: MyOrderItem[];
}
export interface MyOrdersResponse {
  orders: MyOrderRow[];
  total: number;
  page: number;
  limit: number;
  counts: Record<MyOrdersTab, number>;
  tab: MyOrdersTab;
  period: string;
  from: string;
  to: string;
}
export const apiGetMyOrders = (params: {
  tab: MyOrdersTab; period: 'today' | 'month' | 'custom'; date?: string;
  from?: string; to?: string; page?: number; agent_id?: string;
}): Promise<MyOrdersResponse> => {
  const sp = new URLSearchParams({ tab: params.tab, period: params.period });
  if (params.date) sp.set('date', params.date);
  if (params.from) sp.set('from', params.from);
  if (params.to) sp.set('to', params.to);
  if (params.page) sp.set('page', String(params.page));
  if (params.agent_id) sp.set('agent_id', params.agent_id);
  return apiFetch(`my-orders?${sp.toString()}`);
};
export const apiGetCeoDashboardStats = (params?: { period?: string; agent_id?: string; from?: string; to?: string }) => {
  const sp = new URLSearchParams();
  if (params?.period) sp.set('period', params.period);
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  if (params?.from) sp.set('from', params.from);
  if (params?.to) sp.set('to', params.to);
  return apiFetch(`ceo-dashboard-stats?${sp.toString()}`);
};

// Products
export const apiGetProducts = () => apiFetch('products');
export const apiCreateProduct = (body: any) =>
  apiFetch('products', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateProduct = (id: string, body: any) =>
  apiFetch(`products/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiGetInventoryLogs = (productId: string) =>
  apiFetch(`products/${productId}/inventory-logs`);

// Suppliers
export const apiGetSuppliers = () => apiFetch('suppliers');
export const apiCreateSupplier = (body: { name: string; contact_info?: string; email?: string; phone?: string; address?: string }) =>
  apiFetch('suppliers', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateSupplier = (id: string, body: any) =>
  apiFetch(`suppliers/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteSupplier = (id: string) =>
  apiFetch(`suppliers/${id}`, { method: 'DELETE' });

// Restock & Stock Movements
export const apiRestock = (body: { product_id: string; quantity: number; supplier_name?: string; invoice_number?: string; notes?: string }) =>
  apiFetch('restock', { method: 'POST', body: JSON.stringify(body) });
export const apiGetStockMovements = (params?: { product_id?: string; movement_type?: string; limit?: number }) => {
  const sp = new URLSearchParams();
  if (params?.product_id) sp.set('product_id', params.product_id);
  if (params?.movement_type) sp.set('movement_type', params.movement_type);
  if (params?.limit) sp.set('limit', String(params.limit));
  return apiFetch(`stock-movements?${sp.toString()}`);
};

// Prediction Lists
export const apiGetPredictionLists = () => apiFetch('prediction-lists');
export const apiGetPredictionList = (id: string) => apiFetch(`prediction-lists/${id}`);
export const apiCreatePredictionList = (body: { name: string; entries: any[] }) =>
  apiFetch('prediction-lists', { method: 'POST', body: JSON.stringify(body) });
export const apiAssignLeads = (listId: string, agentId: string, leadIds: string[]) =>
  apiFetch(`prediction-lists/${listId}/assign`, { method: 'POST', body: JSON.stringify({ agent_id: agentId, lead_ids: leadIds }) });

// Bulk historical-order import (admin only). The page chunks large files and
// calls this once per chunk, summing the returned counts.
export interface ImportOrderRow {
  external_order_id?: string;
  order_date?: string;
  customer_name?: string;
  customer_phone: string;
  product_name?: string;
  quantity?: number;
  price?: number;
  status?: string;
  customer_city?: string;
  customer_address?: string;
  postal_code?: string;
  note?: string;
}
export interface ImportOrdersResult {
  success: boolean;
  total: number;
  created: number;
  duplicates: number;
  skipped_no_phone: number;
  failed: number;
}
export const apiImportOrders = (body: { source?: string; upsert_profiles?: boolean; rows: ImportOrderRow[] }): Promise<ImportOrdersResult> =>
  apiFetch('orders/import', { method: 'POST', body: JSON.stringify(body) });

// Prediction Leads
export const apiGetMyLeads = (params?: { search?: string }) => {
  const sp = new URLSearchParams();
  if (params?.search) sp.set('search', params.search);
  const qs = sp.toString();
  return apiFetch(`prediction-leads/my${qs ? `?${qs}` : ''}`);
};
export const apiUpdateLead = (id: string, body: { status?: string; notes?: string; address?: string; city?: string; telephone?: string; product?: string; quantity?: number; price?: number }) =>
  apiFetch(`prediction-leads/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiUnassignLeads = (leadIds: string[]) =>
  apiFetch('prediction-leads/unassign', { method: 'POST', body: JSON.stringify({ lead_ids: leadIds }) });
export const apiTakeLead = (leadId: string) =>
  apiFetch(`prediction-leads/${leadId}/take`, { method: 'POST' });

// Prediction Lead Items
export const apiAddLeadItem = (leadId: string, body: { product_id?: string; product_name: string; quantity: number; price_per_unit: number }) =>
  apiFetch(`prediction-leads/${leadId}/items`, { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateLeadItem = (itemId: string, body: any) =>
  apiFetch(`prediction-lead-items/${itemId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteLeadItem = (itemId: string) =>
  apiFetch(`prediction-lead-items/${itemId}`, { method: 'DELETE' });

// Phone duplicate check
export const apiCheckPhoneDuplicates = (phone: string, excludeOrderId?: string) =>
  apiFetch('check-phone-duplicates', { method: 'POST', body: JSON.stringify({ phone, exclude_order_id: excludeOrderId }) });

// Call Scripts
export interface CallScriptHelper {
  title: string;
  content: string;
  category?: string | null;
}
// Per-language variant of a script. Every field is optional — missing fields fall
// back to the Macedonian base columns at resolve time (see src/lib/callScripts.ts).
export interface CallScriptTranslation {
  title?: string;
  description?: string | null;
  script_text?: string;
  helpers?: CallScriptHelper[];
}
export interface CallScript {
  id: string;
  context_type: string;
  title: string;
  description: string | null;
  script_text: string;
  helpers?: CallScriptHelper[] | null;
  // Keyed by UI language code ('en' | 'sq'); 'bg' lives in the base columns above.
  translations?: Record<string, CallScriptTranslation> | null;
  updated_at: string;
  updated_by: string | null;
}

export const apiGetCallScript = (contextType: string): Promise<CallScript> =>
  apiFetch(`call-scripts/${contextType}`);
export const apiUpdateCallScript = (
  contextType: string,
  body: { script_text: string; translations?: Record<string, CallScriptTranslation> },
): Promise<CallScript> =>
  apiFetch(`call-scripts/${contextType}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiGetAllCallScripts = (): Promise<CallScript[]> =>
  apiFetch('call-scripts');
export const apiCreateProductScript = (body: { title: string; description?: string; script_text: string; helpers?: CallScriptHelper[]; translations?: Record<string, CallScriptTranslation> }): Promise<CallScript> =>
  apiFetch('call-scripts', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateProductScript = (id: string, body: { title?: string; description?: string; script_text?: string; helpers?: CallScriptHelper[]; translations?: Record<string, CallScriptTranslation> }): Promise<CallScript> =>
  apiFetch(`call-scripts/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteProductScript = (id: string): Promise<{ ok: boolean }> =>
  apiFetch(`call-scripts/${id}`, { method: 'DELETE' });

// Call Logs
export type CallOutcome =
  | 'no_answer' | 'interested' | 'not_interested' | 'wrong_number' | 'call_again'
  | 'confirmed' | 'cancelled' | 'trash'
  // Neutral "picked up, no order decision". Replaces the old auto-'interested'
  // on hangup; the real result is derived from the order's status.
  | 'answered';

export type CancellationReason =
  | 'no_money' | 'changed_mind' | 'wrong_product' | 'bought_elsewhere'
  | 'family_refused' | 'duplicate_order' | 'not_satisfied' | 'price_too_high'
  | 'still_using_product' | 'not_interested' | 'will_call_back' | 'other';

// Trash reasons. The pickable list + its order live in src/lib/trashReasons.ts
// (TRASH_REASON_VALUES); this union is just the type. 'not_reachable' is also
// written server-side by the 9-no-answer auto-trash, and 'duplicate_order' is
// the lead de-duplication reason (engine v3.7 keeps those out of the Trash
// List). Keep in sync with orders_trash_reason_check and the three zod enums in
// supabase/functions/api/index.ts.
export type TrashReason =
  | 'wrong_number' | 'wrong_person' | 'not_reachable' | 'rude' | 'uncooperative'
  | 'duplicate_order' | 'other';

export type ConnectionState = 'answered' | 'no_answer' | 'busy' | 'failed' | 'voicemail';

export interface LogCallBody {
  context_type: 'order' | 'prediction_lead' | 'standalone';
  context_id: string | null;
  outcome: CallOutcome | string;
  notes?: string;
  // Telemetry
  started_at?: string;
  connected_at?: string | null;
  ended_at?: string;
  customer_phone?: string;
  connection_state?: ConnectionState;
  // Structured cancel reason
  cancellation_reason?: CancellationReason;
  cancellation_reason_notes?: string;
}

export const apiLogCall = (body: LogCallBody) =>
  apiFetch('call-logs', { method: 'POST', body: JSON.stringify(body) });

// Mandatory answer per opened client: registering returns the STANDING obligation
// when the agent already owes one (the first unanswered client wins) — a mismatch
// is the signal to snap back to it. Released server-side by any outcome path.
export interface CallObligation {
  agent_id: string;
  customer_phone: string;
  customer_name: string | null;
  source: string;
  created_at: string;
}
export const apiRegisterCallObligation = (customer_phone: string, source?: string, customer_name?: string): Promise<{ obligation: CallObligation | null; exempt?: boolean }> =>
  apiFetch('call-obligations', { method: 'POST', body: JSON.stringify({ customer_phone, source, customer_name }) });
export const apiGetMyCallObligation = (): Promise<{ obligation: CallObligation | null; exempt?: boolean }> =>
  apiFetch('call-obligations/mine');

export const apiGetCallLogs = (contextType: string, contextId: string) =>
  apiFetch(`call-logs/${contextType}/${contextId}`);

// Customer history dossier (Calls page)
export interface CustomerHistoryCall {
  id: string;
  agent_id: string;
  agent_name: string;
  context_type: 'order' | 'prediction_lead';
  context_id: string;
  outcome: string;
  notes: string;
  created_at: string;
  started_at: string | null;
  connected_at: string | null;
  ended_at: string | null;
  ring_seconds: number | null;
  talk_seconds: number | null;
  total_seconds: number | null;
  customer_phone: string | null;
  connection_state: ConnectionState | null;
}
export interface CustomerHistoryResponse {
  orders: any[];
  calls: CustomerHistoryCall[];
}
export const apiGetCustomerHistory = (phone: string): Promise<CustomerHistoryResponse> =>
  apiFetch(`customers/${encodeURIComponent(phone)}/history`);

// Active call views (TAKE status, heartbeat-based 2-min timeout)
export interface ActiveCallView {
  id: string;
  agent_id: string;
  agent_name: string;
  customer_phone: string;
  opened_at: string;
  expires_at: string;
}
export const apiHeartbeatActiveView = (customer_phone: string): Promise<ActiveCallView> =>
  apiFetch('active-call-views/heartbeat', { method: 'POST', body: JSON.stringify({ customer_phone }) });
export const apiReleaseActiveView = (customer_phone: string): Promise<{ ok: true; reverted: number }> =>
  apiFetch(`active-call-views/by-phone/${encodeURIComponent(customer_phone)}`, { method: 'DELETE' });
export const apiLookupActiveView = (customer_phone: string): Promise<ActiveCallView | null> =>
  apiFetch(`active-call-views/lookup?phone=${encodeURIComponent(customer_phone)}`);

export const apiGetActiveCallViews = (): Promise<ActiveCallView[]> =>
  apiFetch('active-call-views');

// Call Again queue (customers awaiting follow-up call)
export interface CallAgainEntry {
  source_kind?: 'order' | 'prediction';   // where the row came from (order wins on dedupe)
  list_id: string;
  customer_phone: string;
  customer_name: string | null;
  last_call_at: string | null;
  last_call_outcome: string | null;
  in_call_again_until: string | null;
  // When this customer FIRST went unanswered — the operator's "waiting since",
  // anchored and never reset while it keeps ringing. Returned for both sources.
  call_again_since?: string | null;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  lifetime_value: number;
  paid_count: number | null;
  avg_package_price?: number | null;   // NEW - from prediction priority redesign
  trigger_event_at: string | null;
  prediction_segment_lists: { name: string; category: string } | null;
}
export const apiGetCallAgainQueue = (mine: boolean = true): Promise<CallAgainEntry[]> =>
  apiFetch(`call-again-queue?mine=${mine}`);

// Personal List
export interface PersonalHold {
  id: string;
  agent_id: string;
  agent_name: string;
  customer_phone: string;
  customer_name: string | null;
  reason: string;
  follow_up_by: string | null;
  claimed_at: string;
  expires_at: string;
  escalated_at: string | null;
  status: 'active' | 'released' | 'extended' | 'returned_to_pool';
}
export const apiCreatePersonalHold = (body: { customer_phone: string; customer_name?: string; reason: string; follow_up_by?: string }): Promise<PersonalHold> =>
  apiFetch('personal-list', { method: 'POST', body: JSON.stringify(body) });
export const apiGetMyPersonalHolds = (): Promise<PersonalHold[]> =>
  apiFetch('personal-list?mine=true');
// Admin/manager only: server returns every agent's active holds when no `mine` flag.
export const apiGetAllPersonalHolds = (): Promise<PersonalHold[]> =>
  apiFetch('personal-list');
export const apiLookupPersonalHold = (phone: string): Promise<PersonalHold | null> =>
  apiFetch(`personal-list/lookup?phone=${encodeURIComponent(phone)}`);
export const apiReleasePersonalHold = (id: string): Promise<{ ok: true }> =>
  apiFetch(`personal-list/${id}`, { method: 'DELETE' });
export const apiGetExpiringHolds = (): Promise<PersonalHold[]> =>
  apiFetch('personal-list/expiring');
export const apiGetExpiringHoldsCount = (): Promise<{ count: number }> =>
  apiFetch('personal-list/expiring-count');
export const apiExtendPersonalHold = (id: string, days: number): Promise<PersonalHold> =>
  apiFetch(`personal-list/${id}/extend`, { method: 'POST', body: JSON.stringify({ days }) });

// App settings (operator-tunable global knobs)
export interface AppSettings {
  personal_list_max_holds: number;
  /** Days after shipping before the owning agent is reminded to chase an unpaid delivery. */
  unpaid_chase_days: number;
  /** Age at which those daily reminders stop. */
  unpaid_chase_stop_days: number;
  /** Product of the Day — the motivational promo banner on /calls. */
  promo_of_the_day: PromoConfig;
  /** A1 minutes bundle — commercial terms, so operator-tunable. */
  voip_minutes_bundle: VoipMinutesBundle;
  [key: string]: any;
}
/** Mirrors VOIP_MINUTES_BUNDLE_DEFAULT in the edge function. */
export interface VoipMinutesBundle {
  included_minutes: number;
  /** Day of month the cycle resets — A1's invoice date, not necessarily the 1st. */
  billing_day: number;
  metric: 'talk' | 'total';
  warn_pct: number;
  critical_pct: number;
}
export const apiGetAppSettings = (): Promise<AppSettings> => apiFetch('app-settings');
export const apiUpdateAppSettings = (patch: Partial<AppSettings>): Promise<{ success: true }> =>
  apiFetch('app-settings', { method: 'PATCH', body: JSON.stringify(patch) });

// Product of the Day — operator-authored promo shown to agents on /calls.
// Display-only: no order is ever stamped and no payout is ever affected.
export interface PromoConfig {
  enabled: boolean;
  product_id: string | null;
  product_name: string;
  /** MINIMUM unit price the promo product must be sold at to count. */
  price_eur: number | null;
  /** Extra € the agent earns per qualifying ORDER (once, not per unit). */
  bonus_eur: number | null;
  /** YYYY-MM-DD — the banner hides itself after this Sofia day. Null = until switched off. */
  expires_on: string | null;
  note: string;
  /**
   * Optional hand-written wording per language ('bg' is the base, en/sq fall back
   * to it, and an empty entry falls back to the built-in translated default).
   * `short` is the desktop one-liner, `full` the mobile/tooltip sentence. Both
   * may use the {{product}} / {{price}} / {{bonus}} tokens.
   */
  custom_text?: Record<string, { short?: string; full?: string }>;
}
export type PromoStatus =
  | { active: false }
  | {
      active: true;
      product_name: string;
      price_eur: number;
      bonus_eur: number;
      note: string;
      /** Operator's own wording, if any — resolved against the viewer's language. */
      custom_text?: Record<string, { short?: string; full?: string }>;
      /** The CALLER's own qualifying orders today — never anyone else's. */
      my_orders_today: number;
      my_bonus_today: number;
    };
export const apiGetPromoOfTheDay = (): Promise<PromoStatus> => apiFetch('promo-of-the-day');

// Call History
export const apiGetCallHistory = (params?: { agent_id?: string; result?: string; source?: string; from?: string; to?: string; search?: string; page?: number; limit?: number }) => {
  const sp = new URLSearchParams();
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  if (params?.result) sp.set('result', params.result);
  if (params?.source) sp.set('source', params.source);
  if (params?.from) sp.set('from', params.from);
  if (params?.to) sp.set('to', params.to);
  if (params?.search) sp.set('search', params.search);
  if (params?.page) sp.set('page', String(params.page));
  if (params?.limit) sp.set('limit', String(params.limit));
  return apiFetch(`call-history?${sp.toString()}`);
};

// Order Calls — lazy inline "Calls" panel on /orders expanded rows. Order-id
// based (not phone) so it works even when the viewer's phone copy is
// privacy-masked; the server resolves the real number and matches last-8.
export interface OrderCall {
  id: string;
  agent_id: string;
  agent_name: string | null;
  context_type: 'order' | 'prediction_lead' | 'standalone';
  is_this_order: boolean;
  outcome: string | null;
  created_at: string;
  started_at: string | null;
  connected_at: string | null;
  talk_seconds: number | null;
  total_seconds: number | null;
  recording_file: string | null;
  recording_locked: boolean;
  listened_at: string | null;
  listened_by_name: string | null;
}
export const apiGetOrderCalls = (orderId: string): Promise<{ calls: OrderCall[] }> =>
  apiFetch(`orders/${orderId}/calls`);
// Team-wide "reviewed" mark — fired by the player after >=10s of real playback.
export const apiMarkCallListened = (callId: string): Promise<{ ok: true }> =>
  apiFetch(`call-logs/${callId}/listened`, { method: 'POST' });

// ── Agent Activity Timeline ──
export interface AgentActivityCall {
  id: string;
  started_at: string | null;
  connected_at: string | null;
  ended_at: string | null;
  connection_state: string | null;
  outcome: string | null;
  customer_phone: string | null;
  ring_seconds: number | null;
  talk_seconds: number | null;
}
export interface AgentActivityRow {
  user_id: string;
  full_name: string;
  shift_windows: { start: string; end: string }[];
  breaks: { start: string; end: string | null }[];
  calls: AgentActivityCall[];
  totals: {
    calls: number;
    answered: number;
    answer_rate: number;
    talk_seconds: number;
    ring_seconds: number;
    first_call: string | null;
    last_call: string | null;
  };
}
export interface AgentActivityResponse {
  date: string;
  tz: string;
  agents: AgentActivityRow[];
}
export const apiGetAgentActivity = (params?: { date?: string; agent_id?: string }) => {
  const sp = new URLSearchParams();
  if (params?.date) sp.set('date', params.date);
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  const qs = sp.toString();
  return apiFetch<AgentActivityResponse>(`agent-activity${qs ? `?${qs}` : ''}`);
};

// Agent performance — per-agent sales/financial table (Insights → Agents tab).
export interface AgentPerformanceRow {
  user_id: string;
  full_name: string;
  email: string;
  leads_assigned: number;
  total_confirmed: number;
  total_shipped: number;
  total_paid: number;
  total_returned: number;
  total_cancelled: number;
  total_trashed: number;
  conversion_rate: number;
  shipment_rate: number;
  collection_rate: number;
  return_rate: number;
  gross_revenue: number;
  paid_revenue: number;
  outstanding_revenue: number;
  returned_value: number;
  total_profit: number;
  net_contribution: number;
  avg_order_value: number;
  revenue_per_lead: number;
  profit_per_lead: number;
  is_special_agent?: boolean;
  /** Paid packages only (COD collected). */
  packages_sold?: number;
  /** Confirmed/shipped/delivered packages not yet paid. */
  packages_awaiting?: number;
  /** Units on returned orders. */
  packages_returned?: number;
  avg_per_package?: number;
  payout_earned?: number;
  date_basis?: 'paid_at' | 'created_at';
}
export const apiGetAgentPerformance = (params?: {
  from?: string; to?: string; search?: string; source?: string;
  status?: string; agent_id?: string; include_cancelled?: boolean; show_zero?: boolean;
  date_basis?: 'paid_at' | 'created_at';
}): Promise<AgentPerformanceRow[]> => {
  const sp = new URLSearchParams();
  if (params?.from) sp.set('from', params.from);
  if (params?.to) sp.set('to', params.to);
  if (params?.search) sp.set('search', params.search);
  if (params?.source) sp.set('source', params.source);
  if (params?.status) sp.set('status', params.status);
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  if (params?.include_cancelled) sp.set('include_cancelled', 'true');
  if (params?.show_zero) sp.set('show_zero', 'true');
  if (params?.date_basis) sp.set('date_basis', params.date_basis);
  const qs = sp.toString();
  return apiFetch<AgentPerformanceRow[]>(`agent-performance${qs ? `?${qs}` : ''}`);
};

// ── Agent payout settlements ──
export interface AgentPayoutSummaryRow {
  agent_user_id: string;
  full_name: string;
  email: string;
  packages_sold: number;
  packages_awaiting: number;
  packages_returned: number;
  payout_earned: number;
  payout_settled: number;
  payout_unpaid: number;
  last_paid_on: string | null;
  unsettled_orders: number;
}
export interface AgentPayoutSettlement {
  id: string;
  agent_user_id: string;
  agent_name?: string;
  period_from: string;
  period_to: string;
  packages_count: number;
  amount_eur: number;
  /** What the per-package engine calculated — may differ from amount_eur. */
  computed_amount_eur?: number | null;
  amount_source?: 'formula' | 'manual';
  override_reason?: string | null;
  paid_on: string;
  paid_by: string | null;
  method: string | null;
  notes: string | null;
  status: 'paid' | 'voided';
  voided_at?: string | null;
  void_reason?: string | null;
  created_at: string;
  updated_at?: string | null;
  items?: { order_id: string; display_id?: string | null; package_units: number; bonus_eur: number; paid_at?: string | null }[];
}
export interface AgentPayoutPreview {
  agent_user_id: string;
  full_name: string;
  period_from: string;
  period_to: string;
  packages_count: number;
  amount_eur: number;
  order_count: number;
  items: { order_id: string; display_id: string | null; package_units: number; bonus_eur: number; paid_at: string | null; price: number }[];
}
export const apiGetAgentPayoutSummary = (params?: { from?: string; to?: string; agent_id?: string }) => {
  const sp = new URLSearchParams();
  if (params?.from) sp.set('from', params.from);
  if (params?.to) sp.set('to', params.to);
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  const qs = sp.toString();
  return apiFetch<AgentPayoutSummaryRow[]>(`agent-payouts/summary${qs ? `?${qs}` : ''}`);
};
export const apiGetAgentPayouts = (params?: { agent_id?: string; status?: string }) => {
  const sp = new URLSearchParams();
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  if (params?.status) sp.set('status', params.status);
  const qs = sp.toString();
  return apiFetch<AgentPayoutSettlement[]>(`agent-payouts${qs ? `?${qs}` : ''}`);
};
export const apiGetAgentPayout = (id: string) =>
  apiFetch<AgentPayoutSettlement>(`agent-payouts/${id}`);
export const apiPreviewAgentPayout = (params: { agent_id: string; from?: string; to?: string }) => {
  const sp = new URLSearchParams();
  sp.set('agent_id', params.agent_id);
  if (params.from) sp.set('from', params.from);
  if (params.to) sp.set('to', params.to);
  return apiFetch<AgentPayoutPreview>(`agent-payouts/preview?${sp.toString()}`);
};
export const apiCreateAgentPayout = (body: {
  agent_id: string; from?: string; to?: string; paid_on?: string; method?: string; notes?: string;
  /** Omit to pay exactly what the engine calculated; set to override it. */
  amount_eur?: number; override_reason?: string;
}) => apiFetch<AgentPayoutSettlement>('agent-payouts', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateAgentPayout = (id: string, body: {
  amount_eur?: number; paid_on?: string; period_from?: string; period_to?: string;
  method?: string; notes?: string; override_reason?: string;
}) => apiFetch<AgentPayoutSettlement>(`agent-payouts/${id}`, {
  method: 'PATCH', body: JSON.stringify(body),
});
export const apiVoidAgentPayout = (id: string, reason?: string) =>
  apiFetch<AgentPayoutSettlement>(`agent-payouts/${id}/void`, {
    method: 'POST', body: JSON.stringify({ reason: reason || null }),
  });
export const apiGetAgentPayoutReport = (id: string) =>
  apiFetch<any>(`agent-payouts/${id}/report`);

// Warehouse
export const apiGetIncomingOrders = (params?: { agent_id?: string; from?: string; to?: string; product?: string; source?: string; status?: string }) => {
  const sp = new URLSearchParams();
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  if (params?.from) sp.set('from', params.from);
  if (params?.to) sp.set('to', params.to);
  if (params?.product) sp.set('product', params.product);
  if (params?.source) sp.set('source', params.source);
  if (params?.status) sp.set('status', params.status);
  return apiFetch(`warehouse/incoming-orders?${sp.toString()}`);
};
export const apiGetUserWarehouseItems = () => apiFetch('warehouse/user-items');
export const apiAssignWarehouseItem = (body: { user_id: string; product_id: string; quantity: number; notes?: string }) =>
  apiFetch('warehouse/user-items', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateWarehouseItem = (id: string, body: any) =>
  apiFetch(`warehouse/user-items/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteWarehouseItem = (id: string) =>
  apiFetch(`warehouse/user-items/${id}`, { method: 'DELETE' });
export const apiUpdateWarehouseOrder = (id: string, body: any) =>
  apiFetch(`warehouse/incoming-orders/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteWarehouseOrder = (id: string, source: string) =>
  apiFetch(`warehouse/incoming-orders/${id}?source=${source}`, { method: 'DELETE' });

export const apiGetShifts = (params?: { agent_id?: string; from?: string; to?: string }) => {
  const sp = new URLSearchParams();
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  if (params?.from) sp.set('from', params.from);
  if (params?.to) sp.set('to', params.to);
  return apiFetch(`shifts?${sp.toString()}`);
};
export const apiGetMyShifts = () => apiFetch('shifts/my');
// Breaks (pause during a shift). Start resolves the active shift server-side.
export const apiStartBreak = () => apiFetch('shifts/break/start', { method: 'POST', body: '{}' });
export const apiEndBreak = () => apiFetch('shifts/break/end', { method: 'POST', body: '{}' });
export const apiGetActiveBreak = () => apiFetch('shifts/break/active');
export const apiCreateShift = (body: { name: string; date: string; date_end?: string; start_time: string; end_time: string; agent_ids?: string[] }) =>
  apiFetch('shifts', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateShift = (id: string, body: any) =>
  apiFetch(`shifts/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteShift = (id: string) =>
  apiFetch(`shifts/${id}`, { method: 'DELETE' });
export const apiCheckShiftLogin = () => apiFetch('shifts/check-login');
export const apiLogShiftLogin = (body: { shift_id: string; shift_date: string; shift_start_time: string; shift_end_time: string }) =>
  apiFetch('shifts/login-log', { method: 'POST', body: JSON.stringify(body) });
export const apiLogShiftLogout = () =>
  apiFetch('shifts/logout-log', { method: 'PATCH', body: JSON.stringify({}) });
export const apiGetShiftStatistics = (params?: { from?: string; to?: string }) => {
  const sp = new URLSearchParams();
  if (params?.from) sp.set('from', params.from);
  if (params?.to) sp.set('to', params.to);
  return apiFetch(`shifts/statistics?${sp.toString()}`);
};
export const apiGetLoginActivity = (params?: { from?: string; to?: string; agent_id?: string; status?: string }) => {
  const sp = new URLSearchParams();
  if (params?.from) sp.set('from', params.from);
  if (params?.to) sp.set('to', params.to);
  if (params?.agent_id) sp.set('agent_id', params.agent_id);
  if (params?.status) sp.set('status', params.status);
  return apiFetch(`shifts/login-activity?${sp.toString()}`);
};

// Shift Templates
export const apiGetShiftTemplates = () => apiFetch('shift-templates');
export const apiCreateShiftTemplate = (body: { name: string; start_time: string; end_time: string }) =>
  apiFetch('shift-templates', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateShiftTemplate = (id: string, body: any) =>
  apiFetch(`shift-templates/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteShiftTemplate = (id: string) =>
  apiFetch(`shift-templates/${id}`, { method: 'DELETE' });
export const apiAssignTemplateWeek = (body: { template_id: string; agent_ids: string[]; week_start: string; days?: string[] }) =>
  apiFetch('shift-templates/assign-week', { method: 'POST', body: JSON.stringify(body) });

// Recent Activity
export const apiGetRecentActivity = (limit?: number) => {
  const sp = new URLSearchParams();
  if (limit) sp.set('limit', String(limit));
  return apiFetch(`recent-activity?${sp.toString()}`);
};

// Ads Campaigns
export const apiGetAdsCampaigns = (params?: { platform?: string; status?: string; search?: string }) => {
  const sp = new URLSearchParams();
  if (params?.platform) sp.set('platform', params.platform);
  if (params?.status) sp.set('status', params.status);
  if (params?.search) sp.set('search', params.search);
  return apiFetch(`ads-campaigns?${sp.toString()}`);
};
export const apiCreateAdsCampaign = (body: { campaign_name: string; platform: string; budget: number; notes?: string }) =>
  apiFetch('ads-campaigns', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateAdsCampaign = (id: string, body: any) =>
  apiFetch(`ads-campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteAdsCampaign = (id: string) =>
  apiFetch(`ads-campaigns/${id}`, { method: 'DELETE' });

// Inbound Leads (webhook)
export const apiGetInboundLeads = (status?: string) => {
  const sp = new URLSearchParams();
  if (status && status !== 'all') sp.set('status', status);
  return apiFetch(`inbound-leads?${sp.toString()}`);
};
export const apiUpdateInboundLead = (id: string, body: any) =>
  apiFetch(`inbound-leads/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteInboundLead = (id: string) =>
  apiFetch(`inbound-leads/${id}`, { method: 'DELETE' });

// Assigner
export const apiGetUnassignedPending = () => apiFetch('orders/unassigned-pending');
export const apiGetAssignedOrders = () => apiFetch('orders/assigned');
export const apiBulkAssignOrders = (orderIds: string[], agentId: string) =>
  apiFetch('orders/bulk-assign', { method: 'POST', body: JSON.stringify({ order_ids: orderIds, agent_id: agentId }) });
export const apiBulkUnassignOrders = (orderIds: string[]) =>
  apiFetch('orders/bulk-unassign', { method: 'POST', body: JSON.stringify({ order_ids: orderIds }) });
export const apiBulkStatusUpdate = (orderIds: string[], newStatus: string) =>
  apiFetch('orders/bulk-status-update', { method: 'POST', body: JSON.stringify({ order_ids: orderIds, new_status: newStatus }) });
export const apiBigArenaSync = (updates: Array<{ ref: string; rawStatus: string; targetStatus: 'paid' | 'returned' | 'cancelled' }>, meta?: { filename?: string; uploadedAt?: string }) =>
  apiFetch('orders/bigarena-sync', { method: 'POST', body: JSON.stringify({ updates, meta: meta || {} }) });
// BigArena "Fulfillment Panel" stock export → overwrite CRM stock_quantity.
// Rows are the parsed/merged output of src/lib/bigarenaStock.ts; the server
// re-matches them against the catalogue and never trusts a client product id.
export const apiBigArenaStockSync = (
  rows: Array<{ sku?: string | null; barcode?: string | null; name: string; free: number }>,
  meta?: { filename?: string },
) =>
  apiFetch('products/bigarena-stock-sync', { method: 'POST', body: JSON.stringify({ rows, meta: meta || {} }) });

export const apiGetOnlineAgents = () => apiFetch('agents/online');
// Presence heartbeat — pinged every ~45s while the app is open so the
// agents/online endpoint can tell who is actually here right now. Optionally
// carries the live softphone state (VoipContext reports every transition;
// the periodic beat includes it only while non-idle — see callStateBus).
export const apiPresenceHeartbeat = (opts?: { voip_state?: string }) =>
  apiFetch('presence/heartbeat', { method: 'POST', body: JSON.stringify(opts ?? {}) });

// Webhooks
export const apiGetWebhooks = () => apiFetch('webhooks');
export const apiCreateWebhook = (body: { product_name: string; description?: string }) =>
  apiFetch('webhooks', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateWebhook = (id: string, body: any) =>
  apiFetch(`webhooks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteWebhook = (id: string) =>
  apiFetch(`webhooks/${id}`, { method: 'DELETE' });

// Customer Intelligence
export const apiGetCustomerIntelligence = (phone: string) =>
  apiFetch(`customer-intelligence?phone=${encodeURIComponent(phone)}`);

// Management Insights
export interface InsightsResponse {
  meta: { from: string; to: string; granularity: 'day' | 'week' | 'month'; generated_at: string };
  overview: {
    revenue: number; paid_revenue: number; orders_total: number; sold_count: number; paid_count: number; aov: number;
    units_sold: number; return_rate: number; cancel_rate: number;
    returns_value: number; pipeline_value: number; returned_count: number; cancelled_count: number;
    trashed_count: number; leads_pending: number;
  };
  status_distribution: { status: string; count: number; value: number }[];
  revenue_trend: { bucket: string; revenue: number; orders: number }[];
  sales: {
    by_product: { product: string; units: number; revenue: number; orders: number }[];
    by_city: { city: string; orders: number; revenue: number }[];
    by_delivery: { delivery: string; orders: number; revenue: number }[];
    by_source: { source: string; orders: number; revenue: number }[];
  };
  agents: {
    name: string; orders: number; sold: number; paid: number; cancelled: number; returned: number; trashed: number;
    revenue: number; aov: number; units: number; avg_per_package: number; cancel_rate: number; return_rate: number;
    calls: number; answered: number; answer_rate: number; talk_seconds: number;
    payout_earned?: number;  // New for Pure Profit / special agent commissions
  }[];
  products_stock: {
    top_sellers: { product: string; units: number; revenue: number; orders: number }[];
    stock: { name: string; stock_quantity: number; low_stock_threshold: number; state: 'ok' | 'low' | 'out'; units_sold: number; days_of_cover: number | null; cost_price: number; price: number }[];
    low_stock: any[];
    out_of_stock: any[];
    movement: Record<string, number>;
  };
  returns: {
    rate: number; value_lost: number;
    by_reason: { reason: string; count: number }[];
    by_product: { product: string; count: number }[];
    by_city: { city: string; count: number }[];
  };
  cancellations: {
    total: number;
    trashed: number;
    by_reason: { reason: string; count: number }[];
    by_product: { product: string; count: number }[];
  };
  calls: {
    total: number; answered: number; answer_rate: number; talk_seconds: number;
    by_outcome: { outcome: string; count: number }[];
    per_agent: { name: string; calls: number; answered: number; answer_rate: number; talk_seconds: number }[];
  };
  profit: { has_costs: boolean; by_product: { product: string; revenue: number; cogs: number; profit: number; margin: number }[]; total_profit: number };

  // Pure Profit (actuals — money in vs money out)
  pure_profit?: {
    total_packages: number;
    avg_price_per_package: number;
    paid_orders?: number;           // distinct paid orders
    paid_packages?: number;         // total packages (units) across paid orders
    packages_per_order?: number;    // paid_packages / paid_orders
    by_product?: {                  // per-product breakdown on the paid basis
      product: string; packages: number; orders: number;
      unit_cost: number; unit_price: number;
      cogs: number; revenue: number; profit: number;
      net_revenue?: number;         // revenue excl. VAT
      net_profit?: number;          // net_revenue − cogs
    }[];
    cash_collected?: number;        // money in: cash actually collected (paid)
    vat?: number;                   // VAT included in collected cash (gross ÷ 6 at 20%)
    vat_rate?: number;              // e.g. 0.20
    cogs?: number;                  // product cost of what sold
    agent_commissions?: number;     // first-confirmer bonus (agents only)
    delivery_cost?: number;         // courier outbound on all shipped
    return_loss?: number;           // round-trip loss on every return
    cost_coverage?: number;         // share of sold packages with a known cost_price (0..1)
    products_missing_cost?: string[]; // products whose COGS counts €0 (no cost_price)
    gross_profit_from_cost: number; // back-compat alias (cash − cogs)
    special_agent_commissions: number; // back-compat alias of agent_commissions
    clear_profit: number;
  };

  // Margin Lab — realized price of every paid package + the floor each product
  // needs to net `target_profit_per_package`. Floor = 1.2·(target+cogs+deliver+commission).
  margin_lab?: {
    target_profit_per_package: number;
    vat_rate: number;
    blended_deliver_cost: number;   // default delivery/order for the bundle simulator
    commission_tiers: { max: number | null; bonus: number }[];
    realized: {
      packages: number;
      avg: number; median: number; p25: number; p75: number; min: number; max: number;
      net_profit_per_pkg: number;
    };
    by_product: {
      product: string; packages: number;
      cost_known: boolean; cogs_unit: number;
      avg_realized_price: number; avg_delivery_share: number;
      net_profit_per_pkg: number; clears_target: boolean;
      floor_price: number; uplift_pct: number | null;
    }[];
  };

  // Logistics spend by courier+service (which orders went by what).
  logistics?: {
    courier: string; service: string;
    delivered: number; returned: number;
    deliver_cost: number; return_cost: number; total_cost: number;
  }[];

  // Prediction Lists ROI — which list generated how much money. Order metrics are
  // exact (from the order's attribution snapshot); members is current membership.
  // returned/refund_value = money that came back (COD returns).
  prediction_lists?: {
    list_id: string;
    name: string;
    type: 'segment' | 'uploaded';
    category: string | null;
    orders: number;
    confirmed: number;
    paid: number;
    returned: number;
    cancelled: number;
    revenue: number;
    refund_value: number;
    net_revenue: number;
    bonus_paid: number;
    members: number;
    conversion_rate: number;
    return_rate: number;
  }[];
}
export const apiGetManagementInsights = (params?: { from?: string; to?: string; target?: number }): Promise<InsightsResponse> => {
  const sp = new URLSearchParams();
  if (params?.from) sp.set('from', params.from);
  if (params?.to) sp.set('to', params.to);
  if (params?.target != null) sp.set('target', String(params.target));
  return apiFetch(`management-insights?${sp.toString()}`);
};

// Courier rate card (logistics cost per courier+service — editable in Settings)
export interface CourierRate {
  id?: string;
  courier: 'speedy' | 'econt';
  service: 'door' | 'office';
  deliver_cost: number;
  return_cost: number;
  updated_at?: string;
}
export const apiGetCourierRates = (): Promise<CourierRate[]> => apiFetch('courier-rates');
export const apiUpdateCourierRates = (rates: Pick<CourierRate, 'courier' | 'service' | 'deliver_cost' | 'return_cost'>[]) =>
  apiFetch('courier-rates', { method: 'PATCH', body: JSON.stringify({ rates }) });

// ── Lead Distribution ──────────────────────────────────────────────────────
// The engine itself lives in Postgres (migration 20260921000000): the edge
// function only starts/stops it, previews it, and runs one manual drain.
export interface LeadDistCandidate {
  agent_id: string;
  full_name: string;
  open_leads: number;
  open_members: number;
  effective_load: number;
  is_online: boolean;
  has_capacity: boolean;
}
export interface LeadDistRun {
  ran_at: string;
  source: 'cron' | 'trigger' | 'manual';
  assigned: number;
  considered: number;
  skipped_reason: string | null;
}
export interface LeadDistConfig {
  id: string;
  strategy: 'round_robin' | 'load_balance' | 'priority';
  is_active: boolean;
  max_leads_per_agent: number;
  /** EUR — orders.price is stored in euro, never denars. See elyon-currency. */
  priority_threshold: number;
  respect_online: boolean;
  include_prediction_load: boolean;
  participating_roles: string[];
  working_hours_only: boolean;
  order_direction: 'newest' | 'oldest';
  last_run_at: string | null;
  last_run_assigned: number;
  waiting_leads: number;
  assigned_today: number;
  last_meaningful_run: LeadDistRun | null;
  candidates: LeadDistCandidate[];
}
export interface LeadDistResult {
  assigned: number;
  considered: number;
  skipped_reason: string | null;
  per_agent: Record<string, number>;
  agents: { agent_id: string; full_name: string; count: number }[];
  dry_run: boolean;
}
export interface LeadDistProductRule {
  product_id: string;
  name: string;
  is_active: boolean;
  agent_ids: string[];
}
export interface LeadDistParticipant {
  agent_id: string;
  full_name: string;
  roles: string[];
  is_participating: boolean;
}

export const apiGetLeadDistributionConfig = (): Promise<LeadDistConfig> => apiFetch('lead-distribution-config');
export const apiUpdateLeadDistributionConfig = (body: Partial<Pick<LeadDistConfig,
  'strategy' | 'is_active' | 'max_leads_per_agent' | 'priority_threshold' | 'respect_online' |
  'include_prediction_load' | 'participating_roles' | 'working_hours_only' | 'order_direction'>>) =>
  apiFetch('lead-distribution-config', { method: 'PATCH', body: JSON.stringify(body) });
/** dryRun previews the split without writing anything — loads are simulated as it goes. */
export const apiAutoAssignLeads = (opts?: { limit?: number; dryRun?: boolean }): Promise<LeadDistResult> =>
  apiFetch('lead-distribution/auto-assign', {
    method: 'POST',
    body: JSON.stringify({ limit: opts?.limit, dry_run: opts?.dryRun === true }),
  });
export const apiGetLeadRoutingRules = (): Promise<{ products: LeadDistProductRule[] }> =>
  apiFetch('lead-distribution/rules');
export const apiSetLeadRoutingRule = (productId: string, agentIds: string[]) =>
  apiFetch('lead-distribution/rules', {
    method: 'PUT',
    body: JSON.stringify({ product_id: productId, agent_ids: agentIds }),
  });
export const apiGetLeadDistParticipants = (): Promise<{ participating_roles: string[]; participants: LeadDistParticipant[] }> =>
  apiFetch('lead-distribution/participants');
export const apiSetLeadDistParticipant = (agentId: string, isParticipating: boolean) =>
  apiFetch('lead-distribution/participants', {
    method: 'PUT',
    body: JSON.stringify({ agent_id: agentId, is_participating: isParticipating }),
  });

// Operations Center
export const apiGetOperationsCenter = () => apiFetch('operations-center');

// Courier offices (Speedy / Econt picker)
export const apiGetCourierCities = (courier: 'speedy' | 'econt' | 'mex', q: string, limit = 15) => {
  const sp = new URLSearchParams({ courier, q, limit: String(limit) });
  return apiFetch<{ city: string; count: number }[]>(`courier-offices/cities?${sp.toString()}`);
};
export const apiGetCourierOffices = (courier: 'speedy' | 'econt' | 'mex', city: string) => {
  const sp = new URLSearchParams({ courier, city });
  return apiFetch<{ office_code: string; name: string; address: string; hours: string; lat: number | null; lng: number | null; post_code: string }[]>(`courier-offices?${sp.toString()}`);
};
export const apiGetCourierOfficeByCode = (courier: 'speedy' | 'econt' | 'mex', code: string) => {
  const sp = new URLSearchParams({ courier, code });
  return apiFetch<{ office_code: string; name: string; city: string; address: string; hours: string; post_code: string } | null>(`courier-offices/by-code?${sp.toString()}`);
};

// Segments (rule-driven prediction lists)
export const apiGetSegments = () => apiFetch('segments');
export const apiGetSegment = (id: string, params?: { page?: number; limit?: number; assigned?: string; completed?: string }) => {
  const sp = new URLSearchParams();
  if (params?.page) sp.set('page', String(params.page));
  if (params?.limit) sp.set('limit', String(params.limit));
  if (params?.assigned) sp.set('assigned', params.assigned);
  if (params?.completed) sp.set('completed', params.completed);
  const qs = sp.toString();
  return apiFetch(`segments/${id}${qs ? `?${qs}` : ''}`);
};
export const apiAssignSegmentMembers = (id: string, memberPhones: string[], agentId: string | null) =>
  apiFetch(`segments/${id}/assign`, { method: 'POST', body: JSON.stringify({ member_phones: memberPhones, agent_id: agentId }) });
/** Bulk-assign a prediction list across N agents. 1 agent_id = whole list to
 *  them; 2+ = members are shuffled then distributed round-robin so every member
 *  lands with exactly one agent. Default scope='unassigned' preserves whatever
 *  agents already had; scope='all' wipes + redistributes. Optional opts.limit
 *  (exact count) or opts.fraction (0–1, e.g. 0.5 for half) distribute only part
 *  of the eligible pool, sampled fairly after the shuffle. */
export const apiAutoAssignSegment = (
  id: string,
  agentIds: string[],
  scope: 'unassigned' | 'all' = 'unassigned',
  opts?: { limit?: number; fraction?: number },
) =>
  apiFetch(`segments/${id}/auto-assign`, {
    method: 'POST',
    body: JSON.stringify({ agent_ids: agentIds, scope, ...(opts || {}) }),
  });
/** Clear assignment for a whole list (scope='all') or just one agent's slice
 *  (scope=<agent_id>). */
export const apiBulkUnassignSegment = (id: string, scope: 'all' | string = 'all') =>
  apiFetch(`segments/${id}/bulk-unassign`, { method: 'POST', body: JSON.stringify({ scope }) });

// ── Assigner: cross-list assignment overview + mass unassign ──
export interface AssignmentSummaryList {
  list_id: string;
  list_name: string;
  display_order: number;
  is_active: boolean;
  assigned: number;
  open: number;
}
export interface AssignmentSummaryAgent {
  agent_id: string;
  full_name: string;
  assigned_total: number;
  open_total: number;
  pendings_total: number;
  lists: AssignmentSummaryList[];
}
export interface AssignmentSummary {
  agents: AssignmentSummaryAgent[];
  totals: { agents: number; assigned_total: number; open_total: number; pendings_total: number };
}
/** Who holds which prediction-list clients, per agent per list — one request
 *  instead of probing every list individually. Also carries each agent's count
 *  of assigned status=pending orders (leads). Admin/manager only. */
export const apiGetAssignmentSummary = (): Promise<AssignmentSummary> =>
  apiFetch('assigner/assignment-summary');
/** Free prediction-list clients from one agent across ALL lists at once
 *  ('all' = every agent). Optional listIds narrows it to a subset of lists.
 *  Default frees only NOT-yet-called members; includeDone ALSO clears the
 *  agent stamp on already-called rows so the list fully detaches from the
 *  agent's profile (call history and sales credit survive either way).
 *  includePendings also frees the agent's still-pending assigned leads
 *  (ignored server-side when listIds narrows the call — pendings are not
 *  list-scoped). */
export const apiUnassignAllForAgent = (
  agentId: 'all' | string,
  listIds?: string[],
  opts?: { includePendings?: boolean; includeDone?: boolean },
): Promise<{ unassigned: number; pendings_unassigned?: number; agent_id: string; per_agent: Record<string, number> }> =>
  apiFetch('assigner/unassign-all', {
    method: 'POST',
    body: JSON.stringify({
      agent_id: agentId,
      ...(listIds?.length ? { list_ids: listIds } : {}),
      ...(opts?.includePendings ? { include_pendings: true } : {}),
      ...(opts?.includeDone ? { include_done: true } : {}),
    }),
  });
export const apiUpdateSegment = (id: string, body: Record<string, any>) =>
  apiFetch(`segments/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiRecomputeSegments = () =>
  apiFetch('segments/recompute', { method: 'POST' });

// ── Prediction Engine config (no-code list builder) ──
export interface SegmentRecencyBand { label: string; max_days: number | null; holding_pen?: boolean; strip_assignment?: boolean; }
export interface SegmentValueBand { label: string; max_price: number | null; }
export interface SegmentFrequencyBand { label: string; min_count: number; }
export interface SegmentEngineConfig {
  recency_bands: SegmentRecencyBand[];
  value_bands: SegmentValueBand[];
  frequency_bands: SegmentFrequencyBand[];
  windows: { current_cancels_days: number; never_converted_recent_days: number };
  reorder: { enabled: boolean; default_days_of_supply_per_unit: number; buffer_days: number; list_name: string; aggregation?: 'longest' | 'earliest' };
}
export interface SegmentEngineConfigRow {
  id: string;
  version: number;
  config: SegmentEngineConfig;
  active_engine: 'v3_4' | 'v4';
  note: string;
  created_at: string;
}
export interface SegmentEngineDiffList {
  list_id: string; name: string; is_static: boolean; is_active: boolean; live: number; shadow: number;
}
export interface SegmentEngineDiff {
  lists: SegmentEngineDiffList[];
  drift: number;
  live_total: number;
  shadow_total: number;
}
export const apiGetSegmentEngineConfig = (): Promise<SegmentEngineConfigRow> =>
  apiFetch('segments/engine-config');
export const apiSaveSegmentEngineConfig = (
  config: SegmentEngineConfig,
  note?: string,
): Promise<{ version: number; diff: SegmentEngineDiff }> =>
  apiFetch('segments/engine-config', { method: 'PUT', body: JSON.stringify({ config, note }) });
export const apiGetSegmentEngineDiff = (): Promise<SegmentEngineDiff> =>
  apiFetch('segments/engine-diff');
export const apiCreateSegmentList = (body: {
  name: string; description?: string; category?: string; trigger_event?: string; is_static?: boolean; display_order?: number;
}) => apiFetch('segments', { method: 'POST', body: JSON.stringify(body) });
export const apiDeleteSegmentList = (id: string, hard = false) =>
  apiFetch(`segments/${id}${hard ? '?hard=true' : ''}`, { method: 'DELETE' });

// ── Engine controls (kill-switch + on-demand recompute) ──
export interface SegmentEngineControls {
  shadow_enabled: boolean;
  active_engine: 'v3_4' | 'v4';
  shadow_cron_active: boolean;
  shadow_cron_schedule: string | null;
  live_cron_active: boolean;
  live_cron_schedule: string | null;
}
export const apiGetSegmentEngineControls = (): Promise<SegmentEngineControls> =>
  apiFetch('segments/engine-controls');
export const apiSetShadowEngine = (enabled: boolean): Promise<{ shadow_enabled: boolean }> =>
  apiFetch('segments/shadow-engine', { method: 'POST', body: JSON.stringify({ enabled }) });
export const apiRecomputeShadow = (): Promise<{ recomputed_customers: number }> =>
  apiFetch('segments/recompute-shadow', { method: 'POST' });

export interface CooldownClient {
  phone: string;
  last_status: string;
  last_at: string;
  cooldown_until: string;
}
export const apiGetCooldownClients = (): Promise<{ clients: CooldownClient[]; total: number }> =>
  apiFetch('cooldown-clients');

// ── Affiliates admin (2026-07) ──
// View = admin/manager; all mutations are admin-only server-side. Managers
// receive affiliate rows WITHOUT api_key.
// Earned-at-confirmation (operator decision 2026-08-10): `approved` counts
// every lead whose order was EVER confirmed — sticky, a later cancel/trash/
// return keeps the payout. wait/cancelled/trashed are pre-confirm only;
// `paid` ⊆ approved feeds the informational Buyout rate; payout_earned is
// the € sum over approved.
export interface AffiliateStats {
  sent: number; wait: number; approved: number; paid: number;
  cancelled: number; trashed: number;
  payout_earned: number;
}
export interface AffiliateAdmin {
  id: string;
  user_id: string | null;
  code: string;
  name: string;
  contact: string | null;
  api_key?: string;
  status: 'active' | 'paused' | 'banned';
  postback_url: string | null;
  postback_enabled: boolean;
  postback_events: Record<string, boolean>;
  notes: string | null;
  created_at: string;
  updated_at: string;
  stats: AffiliateStats;
  postbacks: { pending: number; failed: number };
}
export const apiGetAffiliates = (): Promise<AffiliateAdmin[]> => apiFetch('affiliates');
export const apiCreateAffiliate = (body: {
  name: string; code: string; contact?: string; notes?: string;
  create_login?: { email: string; password: string };
}): Promise<AffiliateAdmin> =>
  apiFetch('affiliates', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateAffiliate = (id: string, body: Partial<{
  name: string; contact: string; notes: string; status: string;
  postback_url: string; postback_enabled: boolean; postback_events: Record<string, boolean>;
}>) => apiFetch(`affiliates/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiRotateAffiliateKey = (id: string): Promise<{ api_key: string }> =>
  apiFetch(`affiliates/${id}/rotate-key`, { method: 'POST' });
export interface AffiliateDayStat {
  date: string; sent: number; wait: number; approved: number; paid: number;
  cancelled: number; trashed: number;
}
/**
 * Staff-only stats payload. `statuses`, `tests` and `revenue` exist ONLY here —
 * the portal twin (apiGetAffiliatePortalStats) must never return them, because
 * internal funnel detail and test hygiene are not for webmasters.
 */
export interface AffiliateAdminStats {
  totals: AffiliateStats;
  days: AffiliateDayStat[];
  /** Raw CURRENT-status histogram over the affiliate's leads (staff-only). */
  statuses: Record<string, number>;
  tests: { test_leads: number; postback_tests: number };
  /** Selling side over the CONFIRMED pool (staff-only — never on the portal). */
  revenue: { confirmed_eur: number; avg_confirmed_eur: number };
  from: string;
  to: string;
}
export const apiGetAffiliateStats = (id: string, from?: string, to?: string):
  Promise<AffiliateAdminStats> => {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const s = qs.toString();
  return apiFetch(`affiliates/${id}/stats${s ? `?${s}` : ''}`);
};
/**
 * Staff view of one affiliate's leads: the portal row plus role-privacy-governed
 * customer PII and the CRM order linkage. `display_id` appears HERE ONLY — it is
 * banned from every route a partner can reach (see the elyon-affiliates skill).
 */
export type AffiliateAdminLead = Omit<AffiliatePortalLead, 'phone_masked'> & {
  customer_phone: string | null;
  order_id: string | null;
  display_id: string | null;
  order_status: string | null;
  confirmed_at: string | null;
};
export const apiGetAffiliateAdminLeads = (
  id: string,
  params: { page?: number; limit?: number; stage?: string; from?: string; to?: string },
): Promise<{ rows: AffiliateAdminLead[]; total: number; page: number; limit: number }> => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return apiFetch(`affiliates/${id}/leads${s ? `?${s}` : ''}`);
};
export interface OfferAdmin {
  id: string;
  product_id: string | null;
  name: string;
  geo: string;
  payout_eur: number;
  /** Customer price per package for this offer; null = inherit products.price. */
  price_eur: number | null;
  is_active: boolean;
  description: string | null;
  terms: string | null;
  created_at: string;
  updated_at: string;
  products?: { name: string; price: number } | null;
}
export const apiGetOffers = (): Promise<OfferAdmin[]> => apiFetch('offers');
export const apiCreateOffer = (body: {
  name: string; product_id?: string | null; geo?: string; payout_eur: number;
  price_eur?: number | null;
  description?: string; terms?: string; is_active?: boolean;
}): Promise<OfferAdmin> => apiFetch('offers', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateOffer = (id: string, body: Partial<{
  name: string; product_id: string | null; geo: string; payout_eur: number;
  price_eur: number | null;
  description: string; terms: string; is_active: boolean;
}>): Promise<OfferAdmin> => apiFetch(`offers/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export interface AffiliateOfferRow {
  id: string;
  affiliate_id: string;
  offer_id: string;
  status: 'approved' | 'paused';
  payout_override_eur: number | null;
  created_at: string;
  offers?: { id: string; name: string; geo: string; payout_eur: number; is_active: boolean } | null;
}
export const apiGetAffiliateOffers = (affiliateId: string): Promise<AffiliateOfferRow[]> =>
  apiFetch(`affiliates/${affiliateId}/offers`);
export const apiApproveAffiliateOffer = (affiliateId: string, body: {
  offer_id: string; payout_override_eur?: number | null;
}) => apiFetch(`affiliates/${affiliateId}/offers`, { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateAffiliateOffer = (id: string, body: {
  status?: 'approved' | 'paused'; payout_override_eur?: number | null;
}) => apiFetch(`affiliate-offers/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const apiDeleteAffiliateOffer = (id: string) =>
  apiFetch(`affiliate-offers/${id}`, { method: 'DELETE' });
export interface PostbackLogRow {
  id: string;
  affiliate_id: string;
  affiliate_lead_id: string | null;
  order_id: string | null;
  event: string;
  reason: string | null;
  status: 'pending' | 'delivered' | 'failed' | 'skipped';
  attempts: number;
  next_attempt_at: string;
  rendered_url: string | null;
  last_response_code: number | null;
  last_response_body: string | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
  affiliates?: { code: string; name: string } | null;
  affiliate_leads?: { ext_id: string | null; clickid: string | null } | null;
}
export const apiGetPostbackLog = (params: {
  affiliate_id?: string; status?: string; event?: string; page?: number; limit?: number;
}): Promise<{ rows: PostbackLogRow[]; total: number; page: number; limit: number }> => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return apiFetch(`affiliate-postbacks${s ? `?${s}` : ''}`);
};
export const apiRetryPostback = (id: string) =>
  apiFetch(`affiliate-postbacks/${id}/retry`, { method: 'POST' });
export const apiProcessPostbacks = (): Promise<{
  success: boolean; claimed: number; delivered: number; retried: number; failed: number; skipped: number;
}> => apiFetch('affiliate-postbacks/process-now', { method: 'POST' });

// ── Affiliate portal (self-scoped; 'affiliate' role) ──
export interface AffiliatePortalMe {
  id: string;
  code: string;
  name: string;
  contact: string | null;
  status: 'active' | 'paused' | 'banned';
  api_key: string;
  postback_url: string | null;
  postback_enabled: boolean;
  postback_events: Record<string, boolean>;
  created_at: string;
}
export const apiGetAffiliateMe = (): Promise<AffiliatePortalMe> => apiFetch('affiliate/me');
export interface AffiliatePortalOffer {
  offer_id: string;
  name: string;
  geo: string;
  payout_eur: number;
  description: string | null;
  terms: string | null;
  product_name: string | null;
}
export const apiGetAffiliatePortalOffers = (): Promise<AffiliatePortalOffer[]> =>
  apiFetch('affiliate/offers');
export const apiGetAffiliatePortalStats = (from?: string, to?: string):
  Promise<{ totals: AffiliateStats; days: AffiliateDayStat[]; from: string; to: string }> => {
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  const s = qs.toString();
  return apiFetch(`affiliate/stats${s ? `?${s}` : ''}`);
};
export interface AffiliatePortalLead {
  id: string;
  ext_id: string | null;
  clickid: string | null;
  sub1: string | null; sub2: string | null; sub3: string | null; sub4: string | null; sub5: string | null;
  offer_name: string | null;
  payout_eur: number;
  created_at: string;
  stage: string;
  reason: string | null;
  customer_name: string | null;
  phone_masked: string | null;
}
export const apiGetAffiliatePortalLeads = (
  params: { page?: number; limit?: number; stage?: string; from?: string; to?: string },
): Promise<{ rows: AffiliatePortalLead[]; total: number; page: number; limit: number }> => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return apiFetch(`affiliate/leads${s ? `?${s}` : ''}`);
};
export const apiUpdateAffiliatePostback = (body: {
  postback_url?: string; postback_enabled?: boolean; postback_events?: Record<string, boolean>;
}): Promise<{ postback_url: string | null; postback_enabled: boolean; postback_events: Record<string, boolean> }> =>
  apiFetch('affiliate/postback', { method: 'PATCH', body: JSON.stringify(body) });
export const apiRotateOwnAffiliateKey = (): Promise<{ api_key: string }> =>
  apiFetch('affiliate/rotate-key', { method: 'POST' });
export const apiTestAffiliatePostback = (): Promise<{
  status: string; rendered_url: string | null; last_response_code: number | null;
  last_response_body: string | null; last_error: string | null;
}> => apiFetch('affiliate/postback-test', { method: 'POST' });
export const apiChangeAffiliatePassword = (newPassword: string): Promise<{ success: boolean }> =>
  apiFetch('affiliate/change-password', { method: 'POST', body: JSON.stringify({ new_password: newPassword }) });

// ── AlterCPA bridge (admin) ──────────────────────────────────────────────────
// Read-only mirror of an AlterCPA account: leads keep arriving there, we pull
// them in. Nothing is ever sent back — see supabase/migrations/20260914000000.
export interface AlterCpaAccount {
  id: string;
  name: string;
  api_base: string;
  /** NAME of a Supabase function secret, never the token itself. */
  token_secret_name: string;
  /** True when that secret actually exists on the project. */
  token_present?: boolean;
  is_active: boolean;
  /** Geos whose leads become real orders. Everything else is mirror-only. */
  callable_geos: string[];
  status_mirror: 'off' | 'until_touched' | 'always';
  /** pending_only = only AlterCPA phase 1/2 become orders here. */
  import_scope: 'pending_only' | 'all';
  sync_from: string | null;
  last_synced_at: string | null;
  last_cursor_to: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
export const apiGetAlterCpaAccounts = (): Promise<AlterCpaAccount[]> =>
  apiFetch('altercpa/accounts');
export const apiCreateAlterCpaAccount = (body: {
  name: string; token_secret_name: string; api_base?: string;
  callable_geos?: string[]; status_mirror?: string; import_scope?: string;
  sync_from?: string | null; is_active?: boolean; notes?: string | null;
}): Promise<AlterCpaAccount> =>
  apiFetch('altercpa/accounts', { method: 'POST', body: JSON.stringify(body) });
export const apiUpdateAlterCpaAccount = (id: string, body: Partial<{
  name: string; api_base: string; token_secret_name: string;
  callable_geos: string[]; status_mirror: string; import_scope: string;
  sync_from: string | null; is_active: boolean; notes: string | null;
}>): Promise<AlterCpaAccount> =>
  apiFetch(`altercpa/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

export type AlterCpaSkipReason =
  | 'test_order' | 'no_phone' | 'geo_not_callable' | 'unmapped_offer' | 'no_fx_rate';

export interface AlterCpaLead {
  id: string;
  account_id: string;
  altercpa_id: string;
  order_id: string | null;
  geo: string | null;
  offer_name: string | null;
  offer_ext_id: string | null;
  product_id: string | null;
  webmaster: string | null;
  phase: number | null;
  status: number | null;
  reason: number | null;
  phase_seen_at: string | null;
  created_remote: string | null;
  /** Kept verbatim: these numbers are multi-country and are never rewritten. */
  phone_raw: string | null;
  /** Only set for a callable geo whose dialling rules we know; else null. */
  phone_e164: string | null;
  customer_name: string | null;
  city: string | null;
  price_raw: number | null;
  currency_raw: string | null;
  /** null when the currency has no known rate — never a guessed number. */
  price_eur: number | null;
  quantity: number;
  skip_reason: AlterCpaSkipReason | null;
  first_seen_at: string;
  last_seen_at: string;
  orders?: { display_id: string; status: string } | null;
}
export const apiGetAlterCpaLeads = (params: {
  account_id?: string; geo?: string; offer?: string; webmaster?: string;
  phase?: number; skip?: string; from?: string; to?: string; q?: string;
  page?: number; limit?: number;
}): Promise<{ rows: AlterCpaLead[]; total: number; page: number; limit: number }> => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return apiFetch(`altercpa/leads${s ? `?${s}` : ''}`);
};

export interface AlterCpaSummary {
  totals: {
    leads: number; mirrored: number; ledger_only: number;
    geos: number; offers: number; webmasters: number;
    approved: number; revenue_eur: number; priced: number; unpriced: number;
  };
  geos: Array<{ geo: string; leads: number; mirrored: number; approved: number; currencies: string[] | null; revenue_eur: number }>;
  offers: Array<{ geo: string; offer: string; leads: number; approved: number; mapped: boolean }>;
  webmasters: Array<{ webmaster: string; leads: number; approved: number; geos: number }>;
}
export const apiGetAlterCpaSummary = (params: { account_id?: string; from?: string; to?: string } = {}):
  Promise<AlterCpaSummary> => {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return apiFetch(`altercpa/summary${s ? `?${s}` : ''}`);
};

export interface AlterCpaOfferMapRow {
  id: string;
  account_id: string;
  geo: string;
  offer_name: string;
  product_id: string | null;
  offer_id: string | null;
  is_mapped: boolean;
  is_ignored: boolean;
  seen_count: number;
  first_seen_at: string;
  last_seen_at: string;
  mapped_by: string | null;
  mapped_at: string | null;
  notes: string | null;
  products?: { id: string; name: string; price: number; sku: string | null } | null;
}
export const apiGetAlterCpaOfferMap = (params: {
  account_id?: string; unmapped?: boolean; geo?: string;
} = {}): Promise<AlterCpaOfferMapRow[]> => {
  const qs = new URLSearchParams();
  if (params.account_id) qs.set('account_id', params.account_id);
  if (params.unmapped) qs.set('unmapped', '1');
  if (params.geo) qs.set('geo', params.geo);
  const s = qs.toString();
  return apiFetch(`altercpa/offer-map${s ? `?${s}` : ''}`);
};
export const apiUpdateAlterCpaOfferMap = (id: string, body: {
  product_id?: string | null; offer_id?: string | null;
  is_ignored?: boolean; notes?: string | null;
}): Promise<AlterCpaOfferMapRow> =>
  apiFetch(`altercpa/offer-map/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

export interface AlterCpaSyncRun {
  id: string;
  account_id: string | null;
  kind: string;
  window_from: string | null;
  window_to: string | null;
  fetched: number;
  ledger_new: number;
  ledger_updated: number;
  orders_created: number;
  orders_updated: number;
  skipped: Record<string, number>;
  status: 'running' | 'ok' | 'failed';
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  altercpa_accounts?: { name: string } | null;
}
export const apiGetAlterCpaRuns = (params: { account_id?: string; limit?: number } = {}):
  Promise<AlterCpaSyncRun[]> => {
  const qs = new URLSearchParams();
  if (params.account_id) qs.set('account_id', params.account_id);
  if (params.limit) qs.set('limit', String(params.limit));
  const s = qs.toString();
  return apiFetch(`altercpa/runs${s ? `?${s}` : ''}`);
};

/** Fire a sync by hand. `dry: true` writes nothing and returns a preview. */
export const apiRunAlterCpaSync = (body: {
  account?: string; kind?: 'rolling' | 'nightly' | 'weekly' | 'backfill' | 'manual' | 'status';
  from?: string; to?: string; dry?: boolean; limit?: number;
}): Promise<any> =>
  apiFetch('altercpa/sync', { method: 'POST', body: JSON.stringify(body) });
