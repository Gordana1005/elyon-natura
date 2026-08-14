import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";

// ============================================================
// INPUT VALIDATION SCHEMAS
// ============================================================

const createUserSchema = z.object({
  email: z.string().trim().email("Invalid email format").max(255),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  full_name: z.string().trim().min(1, "Name is required").max(200),
  roles: z.array(z.enum(["admin", "manager", "agent", "pending_agent", "prediction_agent", "warehouse", "ads_admin", "affiliate"])).min(1).optional(),
  role: z.string().optional(),
});

// Edit an existing user's identity fields. Every field is optional so the
// caller can change just the name, just the password, etc. Password, when
// present, must clear the same 8-char policy as creation.
const updateUserSchema = z.object({
  email: z.string().trim().email("Invalid email format").max(255).optional(),
  full_name: z.string().trim().min(1, "Name is required").max(200).optional(),
  password: z.string().min(8, "Password must be at least 8 characters").max(128).optional(),
}).refine(
  (b) => b.email !== undefined || b.full_name !== undefined || b.password !== undefined,
  { message: "Nothing to update" },
);

const createOrderItemSchema = z.object({
  product_id: z.string().uuid().nullable().optional(),
  product_name: z.string().trim().min(1).max(200),
  quantity: z.number().int().min(1).max(100000),
  price_per_unit: z.number().min(0).max(10000000),
});

const createOrderSchema = z.object({
  product_id: z.string().uuid().nullable().optional(),
  product_name: z.string().trim().min(1, "Product name is required").max(200),
  customer_name: z.string().max(200).optional().default(""),
  customer_phone: z.string().max(30).optional().default(""),
  customer_city: z.string().max(200).optional().default(""),
  customer_address: z.string().max(500).optional().default(""),
  postal_code: z.string().max(20).optional().default(""),
  // Granular address (Phase 3) — supplements customer_address rather than
  // replacing it; existing rows keep their single-line addresses untouched.
  street: z.string().max(300).optional().default(""),
  street_number: z.string().max(20).optional().default(""),
  quarter: z.string().max(200).optional().default(""),
  apartment: z.string().max(50).optional().default(""),
  floor: z.string().max(20).optional().default(""),
  block: z.string().max(100).optional().default(""),
  entry: z.string().max(50).optional().default(""),
  delivery_instructions: z.string().max(1000).optional().default(""),
  gift_note: z.string().max(500).optional().default(""),
  // Structured delivery method (Phase 6 — courier office picker)
  delivery_type: z.enum(["home", "speedy_office", "econt_office", "mex_office"]).optional().default("home"),
  home_courier: z.enum(["speedy", "econt", "mex"]).optional(),
  courier_office_code: z.string().max(50).optional().default(""),
  courier_office_name: z.string().max(300).optional().default(""),
  courier_office_city: z.string().max(200).optional().default(""),
  birthday: z.string().nullable().optional().default(null),
  ship_after_date: z.string().nullable().optional().default(null),
  price: z.number().min(0).max(10000000).optional().default(0),
  quantity: z.number().int().min(1).max(100000).optional().default(1),
  // Status the agent picks when creating the order from a call. Beyond the
  // "soft commit" trio we now allow cancelled/trashed so the agent can record
  // the call outcome directly (no separate order edit needed).
  status: z.enum(["pending", "confirmed", "call_again", "cancelled", "trashed"]).optional(),
  // Required when status is 'cancelled' — moves the customer into the right
  // Cancelled mirror segment.
  cancellation_reason: z.enum([
    "no_money", "changed_mind", "wrong_product", "bought_elsewhere",
    "family_refused", "duplicate_order", "price_too_high", "not_satisfied",
    "still_using_product", "not_interested", "will_call_back", "other",
  ]).optional(),
  cancellation_reason_notes: z.string().max(1000).optional(),
  // Structured trash reason — stored only when status is 'trashed' (see the
  // insert below). Mirrors src/lib/trashReasons.ts (TRASH_REASON_VALUES), the
  // single source of truth for all three pickers.
  // 'not_reachable' doubles as the server auto-trash reason (9 no-answers) and
  // is now also manually selectable ("Unreachable").
  // 'duplicate_order' = lead de-duplication; the customer stays callable.
  trash_reason: z.enum([
    "wrong_number", "wrong_person", "not_reachable", "rude", "uncooperative",
    "duplicate_order", "other",
  ]).optional(),
  trash_reason_notes: z.string().max(1000).optional(),
  items: z.array(createOrderItemSchema).optional(),
  notes: z.string().max(2000).optional(),
});

const updateCustomerSchema = z.object({
  customer_name: z.string().max(200).optional(),
  customer_phone: z.string().max(30).optional(),
  customer_city: z.string().max(200).optional(),
  customer_address: z.string().max(500).optional(),
  postal_code: z.string().max(20).optional(),
  street: z.string().max(300).optional(),
  street_number: z.string().max(20).optional(),
  quarter: z.string().max(200).optional(),
  apartment: z.string().max(50).optional(),
  floor: z.string().max(20).optional(),
  block: z.string().max(100).optional(),
  entry: z.string().max(50).optional(),
  delivery_instructions: z.string().max(1000).optional(),
  gift_note: z.string().max(500).optional(),
  delivery_type: z.enum(["home", "speedy_office", "econt_office", "mex_office"]).optional(),
  home_courier: z.enum(["speedy", "econt", "mex"]).optional(),
  courier_office_code: z.string().max(50).optional(),
  courier_office_name: z.string().max(300).optional(),
  courier_office_city: z.string().max(200).optional(),
  birthday: z.string().nullable().optional(),
  price: z.number().min(0).max(10000000).optional(),
  quantity: z.number().int().min(1).max(100000).optional(),
  product_id: z.string().uuid().nullable().optional(),
  product_name: z.string().max(200).optional(),
  ship_after_date: z.string().nullable().optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(["pending", "take", "call_again", "confirmed", "shipped", "delivered", "returned", "paid", "trashed", "cancelled"]),
  // Optional structured reason — required when status is being changed to
  // 'cancelled' so the customer lands in the right Cancelled mirror list.
  cancellation_reason: z.enum([
    "no_money", "changed_mind", "wrong_product", "bought_elsewhere",
    "family_refused", "duplicate_order", "price_too_high", "not_satisfied",
    "still_using_product", "not_interested", "will_call_back", "other",
  ]).optional(),
  cancellation_reason_notes: z.string().max(1000).optional(),
  // Structured trash reason — stored when status is 'trashed'. Also accepted on
  // a no-op status PATCH so an admin can correct the reason on an order that is
  // already trashed (the Order Editor's reason-only save).
  // 'not_reachable' is both the auto-trash reason and a manual "Unreachable" pick.
  // 'duplicate_order' = lead de-duplication; the customer stays callable.
  trash_reason: z.enum([
    "wrong_number", "wrong_person", "not_reachable", "rude", "uncooperative",
    "duplicate_order", "other",
  ]).optional(),
  trash_reason_notes: z.string().max(1000).optional(),
  return_reason: z.enum([
    "not_picked_up", "refused_at_door", "undeliverable_address",
    "damaged_in_transit", "wrong_item_shipped", "changed_mind_after_ship", "other",
  ]).optional(),
  return_reason_notes: z.string().max(1000).optional(),
});

// Bulk trash / cancel with a structured reason (Orders page action bar).
// Deliberately NOT folded into bulk-status-update: that endpoint moves orders
// through the fulfilment states (shipped/paid/returned) and writes no reason at
// all, which is how reasonless rows used to appear. Dispositions always say why.
const bulkDispositionSchema = z.object({
  order_ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["trashed", "cancelled"]),
  reason: z.string().min(1).max(64),
  reason_notes: z.string().max(1000).optional(),
});

// A "real order" = a lead the customer confirmed (and anything downstream of
// confirm). Pending leads, no-answer/call-again, trashed and cancelled rows
// are NOT orders. This is the single source of truth reused by the order
// write-paths (confirmed_by attribution) and the analytics endpoints.
const REAL_ORDER_STATUSES = ["confirmed", "shipped", "delivered", "paid", "returned"];

// A lead is work that ARRIVED from outside — the AlterCPA feed, a landing page
// webhook, or the website. Everything else on `orders` is agent-created
// (`manual`, including every record produced while working a prediction list),
// the historical bulk import (`import`), or another company's legacy revenue
// (`monadon_legacy`).
//
// This is what "Pendings" means: the agent's inbound queue. A prediction-list
// customer who didn't answer belongs to the prediction queue's own cooldown and
// the Call Again page — surfacing their `call_again` order under Pendings mixes
// two different sales motions and buries the leads that pay the partner.
//
// ⚠ MACEDONIA: the lead value is `altercpa`, NOT Bulgaria's `affiliate`, and the
// bulk import is `import`, NOT `monadon_legacy`. Verified against this database
// 2026-08-10. `import` must never be listed here — it is 80k rows of legacy
// history and would flood every agent's queue. Mirrored by public.is_lead_source()
// in 20260917000000_pendings_are_leads_only.sql; change both together.
const LEAD_SOURCE_TYPES = ["altercpa", "inbound_lead", "opencart", "opencart_abandoned"];

// How many Call-Again rows /call-again-queue pulls per source. The page filters
// by agent and by source in the browser, so this has to cover the whole working
// set or a filtered view silently under-reports.
const CALL_AGAIN_FETCH_CAP = 2000;

// BigArena action-button labels that appear in every pending order's row and
// contain отказ/върни — strip them before any keyword check so they aren't
// mis-read as the order's status. Mirror of the frontend list in
// src/components/BigArenaStatusSync.tsx (keep both in sync).
const BIGARENA_ACTION_LABELS = [
  'принудително отказване', 'върни обратно за повторна обработка',
  'създай поръчка за замяна', 'клонирай поръчка', 'маркирай като изчерпана наличност',
  'промени наложен платеж', 'придвижи за приоритетно изпълнение', 'генерирай пратка',
  'прегенерирай пратка', 'история на статусите', 'добави инфо за куриер',
];
function stripBigArenaActions(s: string): string {
  let out = (s || '').toLowerCase();
  for (const a of BIGARENA_ACTION_LABELS) out = out.split(a).join(' ');
  return out;
}

// BigArena → CRM status mapping. Precise + safe: only genuine terminal statuses
// move an order. Pending / in-movement / processing → null (no change). NOTE:
// the sync endpoint trusts the client's already-mapped target; this mirrors the
// frontend (src/components/BigArenaStatusSync.tsx) for any future server use.
function mapBigArenaStatus(rawStatus: string, fullRowText: string = ""): 'paid' | 'returned' | 'cancelled' | null {
  const s = stripBigArenaActions(`${rawStatus || ''} ${fullRowText || ''}`);

  // Paid — client physically accepted the parcel / merchant got paid.
  if (
    s.includes('приета от клиент') || s.includes('приет от клиент') ||
    s.includes('доставен') || s.includes('доставена') ||
    /дата на изплащане/.test(s) || s.includes('платен')
  ) return 'paid';

  // Cancelled — Отменена / Анулирана (cancelled at warehouse, never shipped → no stock restore).
  if (s.includes('отменен') || s.includes('анулиран')) return 'cancelled';

  // Returned — shipped parcel that came back / was refused / failed delivery.
  // "Неуспешна доставка" counts; a single "неуспешен опит" (attempt) does not.
  if (
    s.includes('върнат') || s.includes('върната') ||
    s.includes('отказана') || s.includes('отказан от клиент') ||
    s.includes('неуспешна доставка') ||
    s.includes('не е потърсена') || s.includes('return')
  ) return 'returned';

  return null;
}

const createProductSchema = z.object({
  name: z.string().trim().min(1, "Product name is required").max(200),
  description: z.string().max(2000).optional().default(""),
  price: z.number().min(0).max(10000000).optional().default(0),
  cost_price: z.number().min(0).max(10000000).optional().default(0),
  sku: z.string().max(50).nullable().optional().default(null),
  stock_quantity: z.number().int().min(0).max(1000000).optional().default(0),
  low_stock_threshold: z.number().int().min(0).max(100000).optional().default(5),
  photo_url: z.string().url().max(2000).nullable().optional().default(null),
  is_active: z.boolean().optional().default(true),
  category: z.string().max(200).optional().default(""),
  supplier_id: z.string().uuid().nullable().optional().default(null),
});

// BigArena "Fulfillment Panel" stock export. `free` = "Свободна наличност" (units
// NOT reserved for orders already being packed) — the client parses and merges
// shared-barcode rows; the server still re-matches every row itself.
const bigArenaStockSyncSchema = z.object({
  rows: z.array(z.object({
    sku: z.string().max(50).nullable().optional().default(null),
    barcode: z.string().max(50).nullable().optional().default(null),
    name: z.string().trim().min(1).max(300),
    free: z.number().int().min(0).max(1000000),
  })).min(1, "rows[] required").max(500, "Too many rows (max 500 per upload)"),
  meta: z.object({
    filename: z.string().max(160).optional().default("bigarena-stock-upload"),
  }).optional().default({}),
});

const createSupplierSchema = z.object({
  name: z.string().trim().min(1, "Supplier name is required").max(200),
  contact_info: z.string().max(500).optional().default(""),
  email: z.string().max(255).optional().default(""),
  phone: z.string().max(30).optional().default(""),
  address: z.string().max(500).optional().default(""),
});

const restockSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(1000000),
  supplier_name: z.string().max(200).optional().default(""),
  invoice_number: z.string().max(100).optional().default(""),
  notes: z.string().max(1000).optional().default(""),
});

const createCampaignSchema = z.object({
  campaign_name: z.string().trim().min(1, "Campaign name is required").max(200),
  platform: z.string().max(50).optional().default("meta"),
  budget: z.number().min(0).max(100000000).optional().default(0),
  notes: z.string().max(5000).optional().default(""),
});

const createShiftSchema = z.object({
  name: z.string().trim().min(1, "Shift name is required").max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format"),
  date_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Invalid time format"),
  end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Invalid time format"),
  agent_ids: z.array(z.string().uuid()).optional(),
});

const callLogSchema = z.object({
  context_type: z.enum(["order", "prediction_lead", "standalone"]),
  context_id: z.string().uuid().nullable().optional(),
  outcome: z.string().min(1).max(100),
  notes: z.string().max(5000).optional().default(""),
  // Telemetry — every dial logs start/connect/end so durations are real,
  // not synthesised. All optional so old clients don't break.
  started_at: z.string().datetime().optional(),
  connected_at: z.string().datetime().nullable().optional(),
  ended_at: z.string().datetime().optional(),
  customer_phone: z.string().max(30).optional(),
  connection_state: z.enum(["answered", "no_answer", "busy", "failed", "voicemail"]).optional(),
  // Structured cancel reason — required by UI when outcome=cancelled but the
  // server validates the combination explicitly so we can return a helpful
  // 400 instead of a Zod error.
  cancellation_reason: z.enum([
    "no_money", "changed_mind", "wrong_product", "bought_elsewhere",
    "family_refused", "duplicate_order", "price_too_high", "not_satisfied",
    "still_using_product", "not_interested", "will_call_back", "other",
  ]).optional(),
  cancellation_reason_notes: z.string().max(1000).optional(),
  // Structured trash reason for an in-call 'trash' outcome. The 'wrong_number'
  // outcome defaults to "wrong_number" server-side but an explicit pick wins
  // (see applyOutcomeToOrder).
  // 'not_reachable' = the manual "Unreachable" pick (also the auto-trash reason).
  // 'duplicate_order' = lead de-duplication; the customer stays callable.
  trash_reason: z.enum([
    "wrong_number", "wrong_person", "not_reachable", "rude", "uncooperative",
    "duplicate_order", "other",
  ]).optional(),
});

const personalListCreateSchema = z.object({
  customer_phone: z.string().trim().min(4).max(30),
  customer_name: z.string().max(200).optional(),
  reason: z.string().trim().min(1, "Reason is required").max(1000),
  follow_up_by: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "follow_up_by must be YYYY-MM-DD").optional(),
});

const personalListExtendSchema = z.object({
  days: z.number().int().min(1).max(60),
});

// Bulk customer-contact correction. Fixes a wrong / duplicated number or name
// across EVERY order for the customer (identified by the current phone, last-8
// normalised) so the call card + Dial are correct everywhere. At least one of
// customer_name / customer_phone must be supplied.
const updateCustomerContactSchema = z.object({
  phone: z.string().trim().min(4, "Current phone is required").max(40),
  customer_name: z.string().trim().max(200).optional(),
  customer_phone: z.string().trim().max(40).optional(),
});

const predictionListSchema = z.object({
  name: z.string().trim().min(1, "List name is required").max(200),
  entries: z.array(z.object({
    name: z.string().max(200).optional().default(""),
    telephone: z.string().max(30).optional().default(""),
    address: z.string().max(500).optional().default(""),
    city: z.string().max(200).optional().default(""),
    product: z.string().max(200).optional().default(""),
  })).min(1, "No entries provided"),
});

// Bulk historical-order import (admin-only). One row = one past order. Money is
// already EUR (Macedonia), phones get normalized to +389, products matched by name
// against the catalogue. Dedupe is by (external_source, external_order_id) so an
// admin can re-upload the same file safely. The front-end chunks large files and
// calls this repeatedly, aggregating the returned counts.
const orderImportRowSchema = z.object({
  external_order_id: z.string().trim().max(120).optional().default(""),
  order_date: z.string().trim().max(40).optional().default(""),
  customer_name: z.string().trim().max(200).optional().default(""),
  customer_phone: z.string().trim().max(40),
  product_name: z.string().trim().max(300).optional().default(""),
  quantity: z.coerce.number().int().min(1).max(100000).optional().default(1),
  price: z.coerce.number().min(0).max(10000000).optional().default(0),
  status: z.enum([
    "pending", "confirmed", "shipped", "delivered", "paid",
    "cancelled", "returned", "trashed", "call_again",
  ]).optional().default("paid"),
  customer_city: z.string().max(200).optional().default(""),
  customer_address: z.string().max(600).optional().default(""),
  postal_code: z.string().max(30).optional().default(""),
  note: z.string().max(2000).optional().default(""),
});

const orderImportSchema = z.object({
  source: z.string().trim().max(120).optional().default("import"),
  upsert_profiles: z.boolean().optional().default(true),
  rows: z.array(orderImportRowSchema).min(1, "No rows provided").max(1000),
});

// Parse an import date cell into an ISO timestamp (anchored to noon UTC so the
// calendar day is stable across timezones). Accepts ISO (yyyy-mm-dd[...]) and the
// common dd.mm.yyyy / dd/mm/yyyy / dd-mm-yyyy forms (2-digit years → 20xx). When
// the day/month are ambiguous it assumes day-first but swaps if the first number
// can only be a month-overflowing day. Returns null when unparseable.
function isoFromYMD(y: number, mo: number, d: number): string | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00Z`;
}
function parseImportDate(raw: string): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return isoFromYMD(Number(m[1]), Number(m[2]), Number(m[3]));
  m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
  if (m) {
    let d = Number(m[1]);
    let mo = Number(m[2]);
    let y = Number(m[3].length === 2 ? "20" + m[3] : m[3]);
    if (mo > 12 && d <= 12) { const t = d; d = mo; mo = t; }
    return isoFromYMD(y, mo, d);
  }
  return null;
}

const inboundLeadSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  phone: z.string().trim().min(1, "Phone is required").max(30),
  status: z.string().max(50).optional().default("pending"),
  source: z.string().max(100).optional().default("landing_page"),
});

// Inbound order from an external storefront (naturatherapy.mk / OpenCart) pushed
// by the elyon_crm_bridge OCMOD. Carries the full order so the CRM has clear data
// about what product, what happened, and where it came from. Monetary values are
// in `currency` (EUR or MKD); the CRM stores EUR.
const opencartItemSchema = z.object({
  name: z.string().trim().min(1).max(400),
  sku: z.string().max(120).optional().default(""),
  quantity: z.coerce.number().int().min(1).max(100000).optional().default(1),
  price: z.coerce.number().min(0).optional().default(0), // per-unit, in `currency`
});

const opencartOrderSchema = z.object({
  // OpenCart order_id — stable external key for idempotent upserts.
  order_id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  // "order" = a real placed order (→ Pending in the Assigner);
  // "abandoned" = an incomplete checkout (→ saved as a lead).
  mode: z.enum(["order", "abandoned"]).optional().default("order"),
  status_label: z.string().max(160).optional().default(""), // OpenCart status name, e.g. "Pending"
  customer_name: z.string().trim().max(400).optional().default(""),
  first_name: z.string().max(200).optional().default(""),
  last_name: z.string().max(200).optional().default(""),
  phone: z.string().trim().max(40).optional().default(""),
  email: z.string().max(254).optional().default(""),
  city: z.string().max(200).optional().default(""),
  address: z.string().max(600).optional().default(""),
  postal_code: z.string().max(30).optional().default(""),
  comment: z.string().max(4000).optional().default(""),
  total: z.coerce.number().optional(),
  currency: z.string().max(10).optional().default("EUR"),   // EUR or MKD only — anything else is rejected 400 (see toEur below)
  source: z.string().max(120).optional().default("naturatherapy.mk"),
  date_added: z.string().max(40).optional().default(""),
  items: z.array(opencartItemSchema).optional().default([]),
});

// ── Affiliate/CPA intake (public, api-key-authed) ────────────────────────────
// Field names and error codes mirror AlterCPA Moe so webmasters can point an
// existing integration at us. Everything is optional at the schema level on
// purpose: the handler answers with the specific CPA error code the trackers
// expect (nooffer / nophone / duplicate / …) instead of a generic zod message.
// Numeric-or-string unions absorb trackers that send numbers for ids/subs.
const cpaLeadSchema = z.object({
  key: z.union([z.string(), z.number()]).optional(),
  offer: z.union([z.string(), z.number()]).optional(),
  id: z.union([z.string(), z.number()]).optional(),      // their lead id ('auto' → none)
  ext_id: z.union([z.string(), z.number()]).optional(),  // alias of id
  phone: z.union([z.string(), z.number()]).optional(),
  name: z.string().max(200).optional(),
  email: z.string().max(254).optional(),
  ip: z.string().max(64).optional(),
  ua: z.string().max(512).optional(),
  country: z.string().max(8).optional(),
  wm: z.union([z.string(), z.number()]).optional(),      // sub-source → sub1 fallback
  // UTM (AlterCPA short names) — recorded in the provenance note only.
  us: z.string().max(300).optional(),
  uc: z.string().max(300).optional(),
  un: z.string().max(300).optional(),
  ut: z.string().max(300).optional(),
  um: z.string().max(300).optional(),
  sub1: z.union([z.string(), z.number()]).optional(),
  sub2: z.union([z.string(), z.number()]).optional(),
  sub3: z.union([z.string(), z.number()]).optional(),
  sub4: z.union([z.string(), z.number()]).optional(),
  sub5: z.union([z.string(), z.number()]).optional(),
  clickid: z.string().max(300).optional(),
  cuid: z.string().max(300).optional(),
  fbclid: z.string().max(300).optional(),
  gclid: z.string().max(300).optional(),
  ttclid: z.string().max(300).optional(),
  address: z.string().max(600).optional(),
  city: z.string().max(200).optional(),
  postal_code: z.string().max(30).optional(),
  quantity: z.coerce.number().int().min(1).max(10).optional(),
}).passthrough();

// CRM order_status → affiliate-visible stage. MUST stay in sync with the SQL
// twin public.affiliate_stage() (migration 20260801000200) — the DB trigger
// uses that one to decide when a postback fires; this one renders API replies.
//
// SCOPE (2026-08-10): this map is LOGISTICS truth and now renders ONLY the
// postback payloads and the partner S2S GET /cpa/leads reply. Every PAYMENT
// surface — the portal, both stats endpoints, the staff lead lists and the
// admin Dashboard tab — goes through the helpers below instead. Changing one
// must never change the other.
const CPA_STAGE: Record<string, string> = {
  pending: "wait", take: "wait", call_again: "wait",
  confirmed: "hold", shipped: "hold", delivered: "hold",
  paid: "approve", cancelled: "cancel", trashed: "trash", returned: "return",
};

// PAYMENT truth (operator decision 2026-08-10): affiliate payout is earned the
// moment an order is first CONFIRMED and is never reversed — later cancel/
// trash/return is our loss, not the webmaster's. "Ever confirmed" is read off
// orders.confirmed_at (stamped once on the first flip into a real status); the
// REAL_ORDER_STATUSES check covers historical rows from before bulk flips
// stamped it. Postbacks deliberately still follow CPA_STAGE — the network
// panel keeps logistics statuses while the portal carries the money truth.
const AFFILIATE_WAIT_STATUSES = ["pending", "take", "call_again"];
type AffiliateOrderLite = { status?: string | null; confirmed_at?: string | null } | null | undefined;
function affiliateEarned(o: AffiliateOrderLite): boolean {
  return !!o && (o.confirmed_at != null || REAL_ORDER_STATUSES.includes(o.status || ""));
}
function affiliateDisplayStage(o: AffiliateOrderLite): "wait" | "hold" | "cancel" | "trash" {
  if (affiliateEarned(o)) return "hold"; // rendered as "Approved" — sticky
  if (o?.status === "cancelled") return "cancel";
  if (o?.status === "trashed") return "trash";
  return "wait"; // pending/take/call_again + duplicated/unknown fallback
}
// Stage filter for lead lists (portal + admin). Embedded-column filters work
// because both routes join orders!inner(...). 'approve'/'return' are legacy
// aliases from pre-2026-08 SPAs — drop them next release.
function applyAffiliateStageFilter(q: any, stage: string) {
  const s = stage === "approve" || stage === "return" ? "hold" : stage;
  if (s === "hold") return q.or(`confirmed_at.not.is.null,status.in.(${REAL_ORDER_STATUSES.join(",")})`, { referencedTable: "orders" });
  if (s === "wait") return q.is("orders.confirmed_at", null).in("orders.status", AFFILIATE_WAIT_STATUSES);
  if (s === "cancel") return q.is("orders.confirmed_at", null).eq("orders.status", "cancelled");
  if (s === "trash") return q.is("orders.confirmed_at", null).eq("orders.status", "trashed");
  return q;
}

// Business errors are HTTP 200 with {status:"error", error:<code>} — the
// AlterCPA convention affiliate trackers parse. HTTP errors stay for transport
// problems only (malformed JSON, rate-limited infrastructure abuse, 500s).
function cpaError(code: string, extra: Record<string, unknown> = {}) {
  return json({ status: "error", error: code, ...extra });
}

// Intake phone-dedupe window (hours). 0 disables. Admin-tunable via
// app_settings, same pattern as the personal-list cap.
const AFFILIATE_DEDUPE_DEFAULT_HOURS = 24;
async function getAffiliateDedupeWindowHours(client: any): Promise<number> {
  try {
    const { data } = await client
      .from("app_settings").select("value")
      .eq("key", "affiliate_dedupe_window_hours").maybeSingle();
    const n = Number(data?.value);
    if (Number.isFinite(n) && n >= 0 && n <= 720) return Math.floor(n);
  } catch (_) { /* fall through to default */ }
  return AFFILIATE_DEDUPE_DEFAULT_HOURS;
}

// ── Affiliate admin (authed) schemas ─────────────────────────────────────────
const createAffiliateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  // Short stable slug — lands in orders.external_source ('affiliate:<code>')
  // and is never renamed once leads exist.
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,30}$/, "Code must be 2-30 chars: a-z, 0-9, dash"),
  contact: z.string().max(300).optional().default(""),
  notes: z.string().max(2000).optional().default(""),
  create_login: z.object({
    email: z.string().trim().email("Invalid email format").max(255),
    password: z.string().min(8, "Password must be at least 8 characters").max(128),
  }).optional(),
});
const updateAffiliateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  contact: z.string().max(300).optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(["active", "paused", "banned"]).optional(),
  postback_url: z.string().max(1000).optional(),
  postback_enabled: z.boolean().optional(),
  postback_events: z.record(z.boolean()).optional(),
  // 'altercpa' = build the advertiser-API query ourselves (numeric statuses,
  // accept=1, numeric cancel reasons) instead of rendering the partner's
  // macros. Admin-only: NOT exposed on the affiliate's self-service route.
  postback_format: z.enum(["generic", "altercpa"]).optional(),
  altercpa_reason_map: z.record(z.number().int().min(1).max(99)).nullable().optional(),
});
// ── AlterCPA bridge (admin surfaces) ────────────────────────────────────────
// token_secret_name is the NAME of a function secret, never a token: a merchant
// token can read every order in the account, so it must not travel through a
// JSON body or land in a table.
const GEO_RE = /^[A-Za-z]{2}$/;
const altercpaAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  api_base: z.string().trim().url().max(300).optional(),
  token_secret_name: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,63}$/, "Must be an ENV-style name, e.g. ALTERCPA_TOKEN_MAIN"),
  callable_geos: z.array(z.string().trim().regex(GEO_RE, "Use 2-letter country codes")).max(60).optional(),
  status_mirror: z.enum(["off", "until_touched", "always"]).optional(),
  import_scope: z.enum(["pending_only", "all"]).optional(),
  sync_from: z.string().trim().max(10).nullable().optional(),
  is_active: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const altercpaAccountPatchSchema = altercpaAccountSchema.partial();
const altercpaOfferMapPatchSchema = z.object({
  product_id: z.string().uuid().nullable().optional(),
  offer_id: z.string().uuid().nullable().optional(),
  is_ignored: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
const altercpaSyncSchema = z.object({
  account: z.string().trim().max(120).optional(),
  kind: z.enum(["rolling", "nightly", "weekly", "backfill", "manual", "status"]).optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  dry: z.boolean().optional(),
  // status only: cap on open-order candidates per run (catch-up uses slices).
  limit: z.number().int().min(1).max(2000).optional(),
});

const offerCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  product_id: z.string().uuid().nullable().optional(),
  // MK, not the upstream Bulgarian default: this deployment is Macedonia, and
  // offers.geo already defaults to 'MK' in the schema (20260801000100). The two
  // disagreeing meant every offer created through the UI was stamped BG.
  geo: z.string().trim().max(10).optional().default("MK"),
  payout_eur: z.number().min(0).max(100000),
  // Customer price per package; null/omitted = inherit the product's price.
  price_eur: z.number().min(0).max(100000).nullable().optional(),
  description: z.string().max(2000).optional().default(""),
  terms: z.string().max(2000).optional().default(""),
  is_active: z.boolean().optional().default(true),
});
const offerUpdateSchema = offerCreateSchema.partial();
const approveAffiliateOfferSchema = z.object({
  offer_id: z.string().uuid(),
  payout_override_eur: z.number().min(0).max(100000).nullable().optional(),
});
const updateAffiliateOfferSchema = z.object({
  status: z.enum(["approved", "paused"]).optional(),
  payout_override_eur: z.number().min(0).max(100000).nullable().optional(),
});
// Portal self-service: ONLY the postback trio — never name/code/status/payout.
const affiliateSelfPostbackSchema = z.object({
  postback_url: z.string().max(1000).optional(),
  postback_enabled: z.boolean().optional(),
  postback_events: z.record(z.boolean()).optional(),
});
const affiliatePasswordSchema = z.object({
  new_password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

const warehouseItemSchema = z.object({
  user_id: z.string().uuid("Invalid user ID"),
  product_id: z.string().uuid("Invalid product ID"),
  quantity: z.number().int().min(1).max(100000).optional().default(1),
  notes: z.string().max(1000).optional().default(""),
});

function parseBody<T>(schema: z.ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const msg = result.error.errors.map(e => e.message).join("; ");
    throw new ValidationError(msg);
  }
  return result.data;
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// Cross-script / website-name product aliases the fuzzy matcher can't bridge —
// typically a Latin/English storefront name vs the Cyrillic catalogue name.
// Maps a normalised (lowercased) name → catalogue SKU. Keep in sync with
// PRODUCT_NAME_ALIASES in src/lib/utils.ts (the fulfilment-export safety net).
const OPENCART_NAME_ALIASES: Record<string, string> = {
  "matcha collagen": "NT0145",               // МАЧА с КОЛАГЕН 175 гр
  "neuro active": "5310416001160",           // НЕВРО АКТИВ - 60капсули
  "prostatol": "NT0004",                     // Простатол Комплекс
  "creatine monohydrate": "NT0103",          // CREATINE powder 200 gr. (beats the free-Tribulus fuzzy hit)
  "diet shake с вкус на шоколад": "NT0100",  // Diet shake chocolate 500g
};

// Storefront bundle/promo line names → real catalogue components, so "Brain 4"
// never lands in the CRM as a fake product. Matched on the normalised
// (lowercased, whitespace-collapsed) line name. Component qty multiplies by the
// line's own quantity. Keep in sync with scripts/backfill-bundle-order-items.mjs,
// which embeds the same map for the historical rewrite.
const OPENCART_BUNDLES: Record<string, { sku: string; qty: number }[]> = {
  "brain 4": [{ sku: "NT0063", qty: 4 }],                                              // 4× Brain active (30cps)
  "brain 2": [{ sku: "NT0063", qty: 2 }],
  "prostatol 4": [{ sku: "NT0004", qty: 4 }],                                          // 4× Простатол Комплекс
  "prostatol 3 + palmetto 1": [{ sku: "NT0004", qty: 3 }, { sku: "NT0055", qty: 1 }],  // 3× Простатол Комплекс + 1× SAW Palmetto
  "diabetol 4": [{ sku: "NT0002", qty: 4 }],                                           // 4× Диабетол Форте
  "curcumactiv 2+1snail": [{ sku: "NT0057", qty: 2 }, { sku: "NT0025", qty: 1 }],      // 2× Curcumactiv (500ml) + 1× Snail Complex
  "creatine monohydrate (1+1) + tribulus terrestris безплатно": [{ sku: "NT0103", qty: 2 }, { sku: "NT0097", qty: 1 }],
  "slim complex + 2x slim fiber - натурални хапчета за отслабване": [{ sku: "NT0053", qty: 1 }, { sku: "NT0054", qty: 2 }],
};
const normBundleKey = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
const matchBundle = (rawName: string) => OPENCART_BUNDLES[normBundleKey(rawName)] ?? null;

// Split one bundle line's money across its expanded components: weight by the
// catalogue retail price (fallback: package count), round to cents, and put the
// rounding remainder on the first line so the components sum EXACTLY to the
// bundle line's total — orders.price is never recomputed.
function allocateBundlePrice(
  lineTotal: number,
  comps: { compQty: number; cataloguePrice: number }[],
): { total_price: number; price_per_unit: number }[] {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const weights = comps.map((c) => (c.cataloguePrice > 0 ? c.cataloguePrice * c.compQty : c.compQty));
  const wSum = weights.reduce((s, w) => s + w, 0) || 1;
  const totals = comps.map((_c, i) => r2(lineTotal * (weights[i] / wSum)));
  const drift = r2(lineTotal - totals.reduce((s, t) => s + t, 0));
  totals[0] = r2(totals[0] + drift);
  return comps.map((c, i) => ({
    total_price: totals[i],
    price_per_unit: c.compQty > 0 ? r2(totals[i] / c.compQty) : 0,
  }));
}

// Resolve a storefront line-item name to a CRM product id, used when sku/barcode
// and exact name all miss. Curated aliases first (so combos like "Creatine +
// Tribulus free" pick the main product, not the bonus), then the longest
// catalogue name that is a substring of the order name (or vice-versa) — longest
// wins to avoid short-token false hits. Returns null when nothing matches.
function resolveCatalogueProductId(
  rawName: string,
  catalogue: { id: string; name: string | null; sku: string | null }[],
): string | null {
  const key = (rawName || "").toLowerCase().trim();
  if (!key) return null;
  for (const alias in OPENCART_NAME_ALIASES) {
    if (key.includes(alias)) {
      const p = catalogue.find((c) => c.sku === OPENCART_NAME_ALIASES[alias]);
      if (p) return p.id;
    }
  }
  let best: { id: string; len: number } | null = null;
  for (const c of catalogue) {
    const n = (c.name || "").toLowerCase().trim();
    if (!n) continue;
    if (key.includes(n) || n.includes(key)) {
      if (!best || n.length > best.len) best = { id: c.id, len: n.length };
    }
  }
  return best ? best.id : null;
}

// ── Outcome → order-status mapping ──
// Single source of truth: every call outcome that should change the order
// status is mapped here. Returning null means this helper makes no status
// move (e.g. no_answer is handled by the dedicated no-answer block in POST
// /call-logs, which flips the existing order to 'call_again' and opens the
// 3-day Call-Again window — never via this table).
//
// `from` lists every status the order is allowed to be IN before the flip.
// If the order is past these, applyOutcomeToOrder rejects with 409 — e.g.
// you can't "Cancel" something already shipped (warehouse Returned flow
// owns post-shipment refunds).
type OutcomeRule = { to: string; from: string[] };
const OUTCOME_TO_STATUS: Record<string, OutcomeRule | null> = {
  confirmed:      { to: "confirmed", from: ["pending", "take", "call_again", "duplicated"] },
  cancelled:      { to: "cancelled", from: ["pending", "take", "call_again", "duplicated", "confirmed"] },
  trash:          { to: "trashed",   from: ["pending", "take", "call_again", "duplicated"] },
  wrong_number:   { to: "trashed",   from: ["pending", "take", "call_again", "duplicated"] },
  call_again:     { to: "call_again", from: ["pending", "take", "call_again", "duplicated", "confirmed"] },
  no_answer:      null,
  interested:     null,
  not_interested: null,
};

interface ApplyOutcomeArgs {
  orderId: string;
  outcome: string;
  agentId: string;
  cancellationReason?: string;
  cancellationReasonNotes?: string;
  trashReason?: string;
  // Claim an unassigned order for the acting agent. The CALLER decides based on
  // roles — an admin/manager settling someone's order should not become its owner.
  claimIfUnassigned?: boolean;
}

interface ApplyOutcomeResult {
  ok: boolean;
  status?: number;
  error?: string;
  newStatus?: string;
  oldStatus?: string;
}

/**
 * Apply a call outcome to an order — flips order.status, records who/why,
 * and lets the prediction-segments trigger move the customer to the right
 * downstream list automatically. Used by POST /api/call-logs and shared by
 * any future endpoint that wants the same atomic outcome→status semantics.
 */
async function applyOutcomeToOrder(
  client: any,
  { orderId, outcome, agentId, cancellationReason, cancellationReasonNotes, trashReason, claimIfUnassigned }: ApplyOutcomeArgs,
): Promise<ApplyOutcomeResult> {
  const rule = OUTCOME_TO_STATUS[outcome];
  if (rule === null || rule === undefined) return { ok: true };

  const { data: order, error: fetchErr } = await client
    .from("orders").select("id, status, call_again_since, assigned_agent_id").eq("id", orderId).single();
  if (fetchErr || !order) {
    return { ok: false, status: 404, error: "Order not found" };
  }

  // Idempotent: re-logging a call against an order already in the target
  // status is fine — just don't repeat the side-effects (no toast worth, no
  // column overwrites). Lets managers re-record an outcome for an
  // already-cancelled order without a 409.
  if (order.status === rule.to) {
    return { ok: true, oldStatus: order.status, newStatus: rule.to };
  }

  if (!rule.from.includes(order.status)) {
    return {
      ok: false,
      status: 409,
      error: outcome === "cancelled" && ["shipped", "delivered", "paid", "returned"].includes(order.status)
        ? `This order is already ${order.status}. To refund it, open the order in the Orders list and change the status to Returned (warehouse handles post-shipment refunds).`
        : `Cannot move order from '${order.status}' to '${rule.to}' via outcome '${outcome}'`,
    };
  }

  // Cancellation reason is required only when the helper is actually moving
  // the order INTO 'cancelled' — not when it's already there.
  if (outcome === "cancelled" && !cancellationReason) {
    return { ok: false, status: 400, error: "cancellation_reason is required when outcome is cancelled" };
  }

  const update: Record<string, any> = { status: rule.to };
  // Keep the Call-Again 3-day window in sync with the status:
  //   → into call_again: anchor the window to the first entry (COALESCE).
  //   → out of call_again (confirmed/cancelled/trashed/…): close the window so
  //     the client leaves the Call Again page and isn't held by a cooldown.
  if (rule.to === "call_again") {
    update.call_again_since = order.call_again_since ?? new Date().toISOString();
  } else {
    update.call_again_since = null;
    update.next_call_after = null;
  }
  if (outcome === "cancelled") {
    update.cancellation_reason = cancellationReason;
    update.cancellation_reason_notes = cancellationReasonNotes ?? null;
    update.cancelled_at = new Date().toISOString();
    update.cancelled_by_agent_id = agentId;
  }
  // Capture WHY it was trashed. A plain 'trash' carries the reason the agent
  // picked; the 'wrong_number' outcome falls back to "wrong_number" but an
  // EXPLICIT pick still wins — the Order Editor lets an admin choose the outcome
  // Wrong Number and then correct the reason (e.g. to duplicate_order). Only set
  // when actually moving INTO trashed (guarded by rule.to), never overwriting.
  if (rule.to === "trashed") {
    update.trash_reason = outcome === "wrong_number"
      ? (trashReason ?? "wrong_number")
      : (trashReason ?? null);
  }

  // Claim-on-action: settling an unassigned open order (including a duplicate an
  // admin created for follow-up) makes the acting agent its owner, so workload
  // counts and the "Handled By" columns stay coherent. The assignment triple
  // (id / name / at) always moves as ONE — never set the id alone.
  if (claimIfUnassigned && !order.assigned_agent_id && agentId) {
    const { data: prof } = await client
      .from("profiles").select("full_name").eq("user_id", agentId).maybeSingle();
    update.assigned_agent_id = agentId;
    update.assigned_agent_name = prof?.full_name ?? null;
    update.assigned_at = new Date().toISOString();
  }

  const { error: updErr } = await client.from("orders").update(update).eq("id", orderId);
  if (updErr) return { ok: false, status: 500, error: updErr.message };

  return { ok: true, oldStatus: order.status, newStatus: rule.to };
}

// Mandatory answer per opened client (operator rule 2026-08-13): opening a client
// on /calls stores an obligation row; recording ANY outcome for that customer
// releases it. Called from every path that counts as "leaving a mark": call logs
// (including no_answer), order status changes, cancel/trash record creation, and
// Personal List claims. Last-8 phone match, same convention as the rest of the file.
//
// Deliberately forgiving: a missing table or a failed read leaves `ob` undefined
// and the helper no-ops. Never make this throw — it runs on four hot write paths,
// and a broken obligation lookup must not break order creation.
async function clearCallObligation(client: any, agentId: string, phone: string | null | undefined) {
  const digits = String(phone || "").replace(/\D/g, "");
  const last8 = digits.length >= 8 ? digits.slice(-8) : "";
  if (!last8) return;
  const { data: ob } = await client
    .from("agent_call_obligations")
    .select("customer_phone")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (!ob) return;
  const obLast8 = String(ob.customer_phone || "").replace(/\D/g, "").slice(-8);
  if (obLast8 === last8) {
    await client.from("agent_call_obligations").delete().eq("agent_id", agentId);
  }
}

// CORS headers — origin is set per-request in the serve wrapper below.
const corsHeaders = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-webhook-signature",
};

// Browser-call origins allowed to use this function. Server-to-server
// callers (e.g. webhook senders without an Origin header) bypass CORS
// entirely and are gated by the HMAC signature instead.
const ALLOWED_ORIGINS = [
  // TODO(mk): add the real Macedonian production domain once one is registered.
  // The former placeholders (elyon-mk.com / www.elyon-mk.com) were removed on
  // 2026-08-04: we do not own that domain, so listing it meant whoever registers
  // it gets a credentialed cross-origin channel to this API.
  "https://elyon-natura.vercel.app",
  "https://elyon-macedonia.vercel.app", // legacy project alias, still resolves and is in use
  "http://localhost:8080",
  "http://localhost:5173",
  "http://localhost:3000",
];

// Vercel preview deploys: elyon-natura-<hash>-gordanas-projects-a53c0208.vercel.app
const PREVIEW_ORIGIN = /^https:\/\/elyon-natura-[a-z0-9-]+-gordanas-projects-a53c0208\.vercel\.app$/;

function pickAllowedOrigin(origin: string): string | null {
  if (!origin) return null;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (PREVIEW_ORIGIN.test(origin)) return origin;
  return null;
}

// ── Agent commission: per-package on every PAID order ───────────────────
// Full spec lives in the elyon-agent-commissions skill. Operator rule (2026-06-04,
// clarified): the bonus is paid PER PACKAGE on every PAID order, credited to the
// confirming agent — regardless of source (prediction list, pending, or manual).
// The ONLY gate is status = paid.
//   • Per PACKAGE, tiered by that line's unit price: <25€→1€, 25–35€→2€, ≥35€→3€.
//   • EVERY package earns — quantity multiplies; there is NO minimum package count.
//   • No prediction-list / role gate. (prediction_list_id still drives the separate
//     "which list made the money" analytics, but NOT the bonus.)
// Both /api/agent-performance and /api/management-insights MUST use these helpers
// so the two payout numbers can never diverge.
function packageBonusRate(unitPrice: number): number {
  if (unitPrice >= 35) return 3;
  if (unitPrice > 25) return 2;
  return 1;
}

// Per-package bonus for ONE order (0 unless PAID). Legacy rows with no order_items
// fall back to price/units as the unit price.
function orderPackageBonus(o: any): number {
  if (!o || o.status !== "paid") return 0;
  const items = o.order_items || [];
  if (items.length > 0) {
    let total = 0;
    for (const it of items) {
      total += packageBonusRate(Number(it.price_per_unit || 0)) * Number(it.quantity || 0);
    }
    return total;
  }
  const units = Number(o.quantity || 0) || 1;
  const unit = Number(o.price || 0) / Math.max(1, units);
  return packageBonusRate(unit) * units;
}

// Sum of per-package bonuses across a set of orders (paid ones only contribute).
function calcAgentBonus(ordersForAgent: any[]): number {
  if (!ordersForAgent?.length) return 0;
  let total = 0;
  for (const o of ordersForAgent) total += orderPackageBonus(o);
  return Math.round(total * 100) / 100;
}

// ── Package unit helpers (single source of truth for "packages sold" etc.) ──
// "Sold" = paid only (COD collected). Awaiting = pipeline not yet paid.
// Returned packages are counted separately from returned order counts.
// See elyon-agent-commissions skill + agent earnings plan (2026-07).
function unitsOf(o: any): number {
  const its = o?.order_items || [];
  if (its.length > 0) {
    return its.reduce((s: number, it: any) => s + Number(it.quantity || 0), 0);
  }
  return Number(o?.quantity || 0) || 1;
}

function packagesSoldOf(orders: any[]): number {
  if (!orders?.length) return 0;
  let n = 0;
  for (const o of orders) {
    if (o?.status === "paid") n += unitsOf(o);
  }
  return n;
}

function packagesAwaitingOf(orders: any[]): number {
  if (!orders?.length) return 0;
  let n = 0;
  for (const o of orders) {
    if (["confirmed", "shipped", "delivered"].includes(o?.status)) n += unitsOf(o);
  }
  return n;
}

function packagesReturnedOf(orders: any[]): number {
  if (!orders?.length) return 0;
  let n = 0;
  for (const o of orders) {
    if (o?.status === "returned") n += unitsOf(o);
  }
  return n;
}

function paidRevenueOf(orders: any[]): number {
  if (!orders?.length) return 0;
  let s = 0;
  for (const o of orders) {
    if (o?.status === "paid") s += Number(o.price || 0);
  }
  return Math.round(s * 100) / 100;
}

/** Event timestamp for payroll/earnings windows: paid_at, else created_at. */
function orderPaidEventAt(o: any): string | null {
  return o?.paid_at || o?.created_at || null;
}

/** True when the order's payment event falls in [from, to] (ISO strings). */
function inPaidWindow(o: any, from: string | null, to: string | null): boolean {
  if (!from && !to) return true;
  const at = orderPaidEventAt(o);
  if (!at) return false;
  if (from && at < from) return false;
  if (to && at > to) return false;
  return true;
}

// ── Sales attribution: ONE owner per order = the first agent who confirmed ──
// Credit (sale + bonus) belongs to confirmed_by_*, falling back to the assignee
// only for legacy rows that never recorded a confirmer. A super-admin editing &
// re-confirming an order never overwrites confirmed_by_* (see the status PATCH
// guard), so the first agent keeps the credit. See elyon-agent-commissions.
function salesOwnerId(o: any): string | null {
  return o?.confirmed_by_agent_id ?? o?.assigned_agent_id ?? null;
}

// Merge operator-name variants ("Елена Т." / "Елена Т" → "Елена"); blank → Unknown.
// Shared so every name-attributed report groups operators identically.
function normAgentName(raw: any): string {
  let n = String(raw || "").trim().replace(/\s+/g, " ");
  if (!n) return "Unknown operator";
  n = n.replace(/\s+\p{L}\.?$/u, "").trim(); // strip a trailing single-letter initial
  return n || "Unknown operator";
}
function salesOwnerName(o: any): string | null {
  return o?.confirmed_by_name ?? o?.assigned_agent_name ?? null;
}

// ── Cross-script operator identity (2026-08-14) ─────────────────────────────
// One human, three spellings. The imported AlterCPA history writes the operator
// in Latin AND Cyrillic while the CRM profile uses a third transliteration, so
// "Sashka Simonovska" (the account), "Saska Simonovska" (5.792 orders) and
// "Сашка Симоновска" (523) were three separate owners in every name-attributed
// report. 25 people were split this way, ~32.5k orders stranded on halves whose
// account read zero.
//
// normAgentName() alone cannot fix this — it compares strings, and these strings
// genuinely differ. So attribution keys on a SCRIPT-FOLDED identity instead:
// Cyrillic → bare Latin, Latin digraphs → the same bare letters, diacritics
// stripped. Both spellings converge on "saska simonovska" and merge.
//
// Operator ruling, 2026-08-14: merge the same name across scripts, and ONLY
// that. Different surnames stay different people even when the given name
// matches — `Teodora Kostovska` ≠ `Teodora Krstevska`, `Zhaklina Bogatinova`
// ≠ `Zaklina Denik` (both confirmed by the operator). The fold honours this by
// construction: it never merges names that differ by more than transliteration,
// which is why it also leaves genuinely uncertain pairs alone (`Nina` vs
// `Nina Nedelkovska`, `Verica Kostova` vs `Verica Kostovska`). Those need a
// human decision — do NOT loosen the fold to sweep them in.
//
// Lossy on purpose (ц/ч→c, ж/з→z, ш/с→s) because that is the only way "Sashka"
// and "Saska" meet. scripts/audit-agent-identity-merge.mjs prints every group
// this produces; run it before touching the tables below.
const AGENT_CYR_TO_LAT: Record<string, string> = {
  "а":"a","б":"b","в":"v","г":"g","д":"d","ѓ":"g","е":"e","ж":"z","з":"z",
  "ѕ":"d","и":"i","ј":"j","к":"k","л":"l","љ":"l","м":"m","н":"n","њ":"n",
  "о":"o","п":"p","р":"r","с":"s","т":"t","ќ":"k","у":"u","ф":"f","х":"h",
  "ц":"c","ч":"c","џ":"d","ш":"s",
  // Bulgarian/Serbian strays inherited from the fork and from border spellings.
  "й":"j","щ":"st","ъ":"a","ь":"j","ю":"u","я":"a","ы":"i","э":"e","ё":"e",
  "ђ":"d","ћ":"c","ѐ":"e","ѝ":"i",
};
// Longest first — "dzh" would otherwise be eaten by "dz".
const AGENT_LATIN_DIGRAPHS: Array<[string, string]> = [
  ["dzh","d"], ["zh","z"], ["sh","s"], ["ch","c"], ["dz","d"],
  ["gj","g"], ["kj","k"], ["lj","l"], ["nj","n"], ["ts","c"],
];

/** Folded identity for an operator name; "" when there is no usable name. */
function agentIdentityKey(raw: any): string {
  const n = normAgentName(raw);
  if (n === "Unknown operator") return "";
  let out = n.toLowerCase().split("").map((c) => AGENT_CYR_TO_LAT[c] ?? c).join("");
  // Combining marks as escapes, never literals — they are invisible in an editor
  // and this repo has a history of escape-mangling in checked-in files.
  out = out.normalize("NFD").replace(/[̀-ͯ]/g, "");   // č→c, š→s, ž→z
  out = out.replace(/ç/g, "c").replace(/đ/g, "d").replace(/ø/g, "o");
  for (const [from, to] of AGENT_LATIN_DIGRAPHS) out = out.split(from).join(to);
  return out.replace(/[^a-z]+/g, " ").trim();
}

/** identity key → user_id, for folding a name-only order onto a real account. */
function buildAgentIdentityIndex(profiles: Array<{ user_id: string; full_name: string }> | null) {
  const idByIdentity: Record<string, string> = {};
  for (const p of profiles || []) {
    const k = agentIdentityKey(p.full_name);
    if (k) idByIdentity[k] = p.user_id;
  }
  return idByIdentity;
}

// ONE owner per order: the account id when the order carries one, otherwise the
// operator's folded name. `name:<key>` is opaque and is what report filters pass
// back as `agent_id` — it is never written to a row and never grants anything.
function agentOwnerKey(o: any, idByIdentity: Record<string, string>): string | null {
  const id = salesOwnerId(o);
  if (id) return id;
  const k = agentIdentityKey(salesOwnerName(o));
  if (!k) return null;
  return idByIdentity[k] ?? `name:${k}`;
}
// PostgREST translation of salesOwnerId(): a row is owned by `uid` when the
// confirmer is uid, OR no confirmer was ever recorded and the assignee is uid.
// The uid is interpolated into an .or() filter string, so callers MUST pass a
// UUID_RE-validated value (JWT sub or a validated agent_id param) — never raw
// user input.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function salesOwnerOrFilter(uid: string): string {
  return `confirmed_by_agent_id.eq.${uid},and(confirmed_by_agent_id.is.null,assigned_agent_id.eq.${uid})`;
}

// Release every order a take-lock view is holding, restoring what was there
// BEFORE the take. The single shared implementation for both release paths (the
// heartbeat's "one customer per agent" sweep and the explicit DELETE) — they
// used to carry two copies of the same buggy update.
//
// `taken_from_agent` records the prior assignee per taken order, which may be
// NULL (the order was unassigned) or a COLLEAGUE — an agent who lands on a
// client takes their open lead too, and it must go back to its owner afterwards.
// A view row written before this deploy has no array at all; those read as NULL
// and revert to unassigned, matching the old behaviour for the ~2 min they can
// still exist.
//
// The revert matches on (id, status='take') and NOT on the assignee: a taken
// colleague's lead still carries THEIR id, so requiring the caller's would leave
// it stuck in `take` forever. Only ids this very view recorded are touched, and
// an order already in `take` is never a take candidate, so two agents can't
// collide over one order.
async function revertTakenOrders(
  adminClient: any,
  view: { taken_order_ids?: string[] | null; taken_from_status?: string[] | null; taken_from_agent?: (string | null)[] | null },
  _agentId: string,
): Promise<number> {
  const ids = view.taken_order_ids || [];
  const froms = view.taken_from_status || [];
  const priors = view.taken_from_agent || [];
  let reverted = 0;

  // Resolve the owners' names once — the stamp must never be a different
  // agent's name glued to this id ("phantom owner" in reverse).
  const ownerIds = [...new Set(priors.filter((p): p is string => !!p))];
  const nameById = new Map<string, string | null>();
  if (ownerIds.length) {
    const { data: profs } = await adminClient
      .from("profiles").select("user_id, full_name").in("user_id", ownerIds);
    for (const p of profs || []) nameById.set(p.user_id, p.full_name ?? null);
  }

  for (let i = 0; i < ids.length; i++) {
    const priorAgent = priors[i] ?? null;
    const update: Record<string, any> = { status: froms[i] };
    if (priorAgent) {
      // Give it back exactly as it was (assigned_at was never overwritten).
      update.assigned_agent_id = priorAgent;
      update.assigned_agent_name = nameById.get(priorAgent) ?? null;
    } else {
      // The take claimed an unassigned order. Release the whole triple —
      // never leave a name behind without an id ("phantom owner").
      update.assigned_agent_id = null;
      update.assigned_agent_name = null;
      update.assigned_at = null;
    }
    const { error, count } = await adminClient
      .from("orders")
      .update(update, { count: "exact" })
      .eq("id", ids[i])
      .eq("status", "take");
    if (!error && (count ?? 0) > 0) reverted++;
  }
  return reverted;
}

// Resolve an optional custom [from,to] date range (both YYYY-MM-DD) into a UTC
// window for the agent-dashboard "Custom" period. Returns null unless BOTH
// bounds are valid. `to` is clamped to today (no future); when the window ends
// today the upper bound is extended to `now` so the current partial day counts.
// Shared by /api/dashboard-stats and /api/my-orders so they agree.
function customRangeWindow(
  fromRaw: string | null, toRaw: string | null, todayStr: string, now: Date,
): { fromDate: string; toDate: string } | null {
  const ok = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!ok(fromRaw) || !ok(toRaw)) return null;
  let from = fromRaw;
  const to = toRaw > todayStr ? todayStr : toRaw;
  if (from > to) from = to; // guard against reversed bounds → single day
  return {
    fromDate: from + "T00:00:00Z",
    toDate: to === todayStr ? now.toISOString() : to + "T23:59:59Z",
  };
}

// ── TV leaderboard: SEPARATE daily gamification layer ────────────────────────
// This is NOT the paid per-package commission above. It is a CONFIRMED-gated
// daily game that drives the wall-screen board (see migration
// 20260703000000_leaderboard.sql). NEVER reuse calcAgentBonus() here — that one
// is paid-gated and would return 0. Per metric, the bonus = the single HIGHEST
// tier whose `min` <= the agent's value (not a cumulative sum); a negative tier
// bonus is a penalty. Total daily bonus = sum across active metrics.
function tierBonus(value: number, tiers: any[]): number {
  if (!Array.isArray(tiers)) return 0;
  let bonus = 0;
  let bestMin = -Infinity;
  for (const t of tiers) {
    const min = Number(t?.min ?? 0);
    if (value >= min && min >= bestMin) { bestMin = min; bonus = Number(t?.bonus ?? 0); }
  }
  return bonus;
}

function calcLeaderboardBonus(
  stats: { confirmed_count: number; avg_order_value: number; answer_rate: number },
  rules: Record<string, { tiers: any[]; is_active: boolean }>,
): { total: number; breakdown: Record<string, number> } {
  const breakdown: Record<string, number> = {};
  let total = 0;
  for (const [metric, value] of Object.entries(stats)) {
    const rule = rules[metric];
    if (!rule || !rule.is_active) { breakdown[metric] = 0; continue; }
    const b = tierBonus(Number(value) || 0, rule.tiers);
    breakdown[metric] = b;
    total += b;
  }
  return { total: Math.round(total * 100) / 100, breakdown };
}

// Europe/Skopje day boundary as a UTC ISO instant (DST-correct). The board's
// "today" must reset at Skopje midnight, not the edge function's server-local day.
function skopjeDayStart(now = new Date()): { startISO: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Skopje",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(now);
  const v = (t: string) => parts.find((p) => p.type === t)!.value;
  const n = (t: string) => Number(v(t));
  const day = `${v("year")}-${v("month")}-${v("day")}`;
  // Interpret the Skopje wall-clock as if it were UTC, diff against the real
  // instant to get the current offset, then apply it to Skopje midnight.
  const wallAsUTC = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  const offsetMs = wallAsUTC - now.getTime();
  const skopjeMidnightUTC = Date.UTC(n("year"), n("month") - 1, n("day"), 0, 0, 0);
  return { startISO: new Date(skopjeMidnightUTC - offsetMs).toISOString(), day };
}

// UTC instant of Europe/Skopje 00:00 for an arbitrary YYYY-MM-DD (DST-correct via a
// noon probe — Skopje is +2 in winter, +3 in summer).
function skopjeMidnight(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Skopje", hour: "2-digit", hour12: false }).formatToParts(probe).find((p) => p.type === "hour")!.value);
  const offsetHours = hour - 12;
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0) - offsetHours * 3600 * 1000).toISOString();
}

// [start, end) UTC window for a Skopje calendar day (defaults to today).
function skopjeDayRange(dayParam?: string): { day: string; today: string; startISO: string; endISO: string } {
  const today = skopjeDayStart().day;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayParam || "") ? (dayParam as string) : today;
  const [y, m, d] = day.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { day, today, startISO: skopjeMidnight(day), endISO: skopjeMidnight(next) };
}

// Inclusive end instant of a Skopje calendar day ('YYYY-MM-DD' → 23:59:59 local
// as a UTC ISO). Date-range filters compare with `<=`; naked date strings were
// read as UTC by ::timestamptz, shifting every day boundary to 02:00 local
// (found 2026-08-11: the Insights tile said 8 sold while the list showed 12).
function skopjeRangeEnd(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return new Date(Date.parse(skopjeMidnight(next)) - 1000).toISOString();
}
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Fire-and-forget Realtime broadcast so the TV reacts within ~1s when an agent
// confirms. Best-effort: the board also polls, so a failed broadcast is harmless.
async function broadcastLeaderboard(event: string, payload: Record<string, any>): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ topic: "tv-leaderboard", event, payload }] }),
    });
  } catch (_e) { /* never block the request on the broadcast */ }
}

// ── Customer PII redaction (Access & Privacy role flags; see elyon-security) ──
// Masking is applied to API RESPONSES only — all phone search/matching runs
// server-side on the UNMASKED DB columns first, so lookups are unaffected.
// maskName → "Иван П." (first name + surname initials); maskPhone keeps last 3.
// City is intentionally never masked.
const PII_ADDRESS_FIELDS = [
  "customer_address", "address", "street", "street_number", "quarter",
  "apartment", "floor", "block", "entry", "postal_code",
  "courier_office_code", "courier_office_name",
];
function maskPhoneValue(v: any): string {
  const d = String(v ?? "").replace(/\D/g, "");
  if (!d) return "";
  return d.length <= 3 ? "•".repeat(d.length) : "•".repeat(d.length - 3) + d.slice(-3);
}
function maskNameValue(v: any): string {
  const parts = String(v ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return parts[0] + " " + parts.slice(1).map((s) => (s[0] || "") + ".").join(" ");
}
type PiiFlags = { name: boolean; phone: boolean; addr: boolean };
// Redacts a customer-bearing object (order / call row / profile). The bare `name`
// field (prediction leads) is masked only when maskLeadName is set, so we never
// touch unrelated `name` fields (products, lists, agents).
function redactCustomer<T extends Record<string, any>>(obj: T | null | undefined, f: PiiFlags, maskLeadName = false): T | null | undefined {
  if (!obj || typeof obj !== "object") return obj;
  const x: any = { ...obj };
  if (!f.name) {
    if (x.customer_name != null) x.customer_name = maskNameValue(x.customer_name);
    if (maskLeadName && x.name != null) x.name = maskNameValue(x.name);
  }
  if (!f.phone) {
    for (const k of ["customer_phone", "telephone", "caller_number"]) if (x[k] != null) x[k] = maskPhoneValue(x[k]);
  }
  if (!f.addr) {
    for (const k of PII_ADDRESS_FIELDS) if (x[k] != null) x[k] = "•••";
  }
  return x;
}
function redactCustomerList<T extends Record<string, any>>(arr: T[] | null | undefined, f: PiiFlags, maskLeadName = false): T[] {
  return (arr || []).map((o) => redactCustomer(o, f, maskLeadName)!);
}

// ── Cost of goods for one order ──
// unitCost(productId, productName) lets each caller resolve cost by whichever key
// it has (agent-performance keys by product_id, management-insights by name).
// Legacy rows with no order_items fall back to the order's own product/quantity.
function orderCOGS(o: any, unitCost: (productId: any, productName: any) => number): number {
  const items = o?.order_items || [];
  if (items.length > 0) {
    let c = 0;
    for (const it of items) c += unitCost(it.product_id, it.product_name) * (Number(it.quantity) || 1);
    return c;
  }
  return unitCost(o?.product_id, o?.product_name) * (Number(o?.quantity || 0) || 1);
}

// ── Logistics (courier) cost ──
// Every package is < 1 kg, so one flat rate per courier+service. Calibrated from
// the BigArena fee ledger and stored in the editable courier_rates table.
// Deliver = all-in outbound; Return = full round-trip loss (we pay both legs).
const BLENDED_DELIVER_COST = 3.5;  // fallback when the courier wasn't recorded
const BLENDED_RETURN_COST = 6.0;

// Macedonian standard VAT rate (18%; upstream Bulgaria uses 20%). All stored
// prices are GROSS (VAT-inclusive), so the VAT owed on collected cash =
// gross − gross / (1 + VAT_RATE).
// TODO(mk): CONFIRM WITH THE ACCOUNTANT. Food supplements may fall under the
// preferential 5%/10% band, which would make 18% wrong for this catalogue. This
// single constant feeds every pure-profit and net-revenue figure in the system.
const VAT_RATE = 0.18;
type CourierRate = { deliver: number; return_: number };
type RateMap = Record<string, CourierRate>;
const rateKey = (courier: string, service: string) => `${courier}_${service}`;

// Map an order's structured delivery fields to (courier, service). null = unknown.
function resolveCourierService(o: any): { courier: string; service: string } | null {
  const dt = o?.delivery_type;
  if (dt === "speedy_office") return { courier: "speedy", service: "office" };
  if (dt === "econt_office") return { courier: "econt", service: "office" };
  if (dt === "mex_office") return { courier: "mex", service: "office" };
  // 'home' (or legacy/empty) = door delivery; courier from home_courier.
  const hc = o?.home_courier;
  if (hc === "speedy" || hc === "econt" || hc === "mex") return { courier: hc, service: "door" };
  return null;
}

// Modeled courier cost for one order, by its terminal status (each order falls in
// exactly one bucket, so the outbound leg is never double-charged):
//   shipped / delivered / paid → deliver rate
//   returned                   → return rate (round-trip)
//   anything not yet shipped   → 0
function orderLogisticsCost(o: any, rates: RateMap, fallback: CourierRate): number {
  const st = o?.status;
  const shipped = st === "shipped" || st === "delivered" || st === "paid";
  const returned = st === "returned";
  if (!shipped && !returned) return 0;
  const cs = resolveCourierService(o);
  const rate = (cs && rates[rateKey(cs.courier, cs.service)]) || fallback;
  return returned ? rate.return_ : rate.deliver;
}

// Load the editable rate card into a lookup + a blended fallback for unknowns.
async function loadCourierRates(adminClient: any): Promise<{ rates: RateMap; fallback: CourierRate }> {
  const rates: RateMap = {};
  try {
    const { data } = await adminClient.from("courier_rates").select("courier,service,deliver_cost,return_cost");
    for (const r of data || []) {
      rates[rateKey(r.courier, r.service)] = { deliver: Number(r.deliver_cost || 0), return_: Number(r.return_cost || 0) };
    }
  } catch (_e) { /* table missing → pure fallback */ }
  return { rates, fallback: { deliver: BLENDED_DELIVER_COST, return_: BLENDED_RETURN_COST } };
}

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization");

    // Admin client for privileged operations
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // Office deliveries: the order's postal_code must be the courier office's
    // own post code (the one Econt/Speedy assign), so the fulfilment CSV carries
    // a postal_code for offices just like it does for home addresses. Returns
    // the office post code, or null for home deliveries / unknown offices.
    const resolveOfficePostCode = async (
      deliveryType: string | null | undefined,
      officeCode: string | null | undefined,
    ): Promise<string | null> => {
      if (deliveryType !== "speedy_office" && deliveryType !== "econt_office" && deliveryType !== "mex_office") return null;
      if (!officeCode) return null;
      const courier = deliveryType === "speedy_office" ? "speedy" : deliveryType === "mex_office" ? "mex" : "econt";
      const { data } = await adminClient
        .from("courier_offices")
        .select("post_code")
        .eq("courier", courier)
        .eq("office_code", officeCode)
        .maybeSingle();
      return data?.post_code ? String(data.post_code) : null;
    };

    // Resolve the customer's settlement to the MEX delivery zone that will
    // route the parcel. add_shipment.php has no postcode field and treats
    // receiver_address as free text, so receiver_city_id is the ONLY value that
    // decides where the box physically goes.
    //
    // Resolved SERVER-SIDE from the stored city name, never taken from the
    // client — a stale browser tab must not be able to inject a zone id.
    // Returns null when the settlement is unknown or genuinely unroutable; the
    // order still saves, and the push path rejects it later with a clear
    // reason. We never guess a zone: MEX has no cancellation endpoint.
    const resolveMexCity = async (
      cityRaw: string | null | undefined,
    ): Promise<{ id: number | null; name: string | null }> => {
      const city = String(cityRaw || "").trim();
      if (!city) return { id: null, name: null };
      // The picker stores "Кадино, општ. Скопје"; match on the settlement part
      // and drop any гр./с. marker.
      const base = city.split(",")[0].replace(/^s*(гр.?|с.?|село|град)s*/i, "").trim();
      const norm = normalizeMkGeo(base);
      if (norm.length < 2) return { id: null, name: null };
      const { data } = await adminClient
        .from("mk_settlements")
        .select("mex_city_id, mex_cities(city_name)")
        .eq("name_norm", norm)
        .not("mex_city_id", "is", null)
        .limit(1)
        .maybeSingle();
      if (!data?.mex_city_id) return { id: null, name: null };
      const zone = (data as { mex_cities?: { city_name?: string } }).mex_cities;
      return { id: data.mex_city_id as number, name: zone?.city_name ?? null };
    };

    // Snapshot which prediction list a customer was in AT ORDER TIME. Rule-driven
    // segment membership is dynamic (recomputed on every order change), so we must
    // capture it now — it can't be reconstructed later. Matches by last-8 digits
    // (the CRM phone-normalisation canon). Returns nulls when the customer is in no
    // list (the common case for manual / site orders). Never throws — attribution
    // must never block order creation. See migration 20260623000000 and the
    // elyon-agent-commissions skill for why both analytics and bonuses depend on it.
    // Precedence: an explicit uploaded campaign wins over a background segment, so
    // campaign ROI is measured against the list the operator deliberately built.
    const resolvePredictionAttribution = async (
      phone: string | null | undefined,
    ): Promise<{ id: string; type: "segment" | "uploaded"; name: string; category: string | null } | null> => {
      const last8 = String(phone || "").replace(/\D/g, "").slice(-8);
      if (last8.length < 8) return null;
      try {
        // Uploaded campaign list (most recent matching lead) — highest precedence.
        const { data: lead } = await adminClient
          .from("prediction_leads")
          .select("list_id, prediction_lists(name)")
          .ilike("telephone", `%${last8}`)
          .not("list_id", "is", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (lead?.list_id) {
          const name = (lead as any).prediction_lists?.name ?? "Uploaded list";
          return { id: lead.list_id, type: "uploaded", name, category: null };
        }
        // Rule-driven segment (a customer is in at most one — exclusive membership).
        const { data: member } = await adminClient
          .from("prediction_segment_members")
          .select("list_id, prediction_segment_lists(name, category)")
          .ilike("customer_phone", `%${last8}`)
          .limit(1)
          .maybeSingle();
        if (member?.list_id) {
          const lst = (member as any).prediction_segment_lists;
          return { id: member.list_id, type: "segment", name: lst?.name ?? "Segment", category: lst?.category ?? null };
        }
      } catch (_e) {
        // Attribution is best-effort; a lookup failure must not fail the order.
      }
      return null;
    };

    // Best-known customer name for a phone, resolved with the elevated client so it
    // works regardless of who is creating the order. An agent recording a cancel/
    // trash call-outcome only sees their OWN orders via RLS, so the original named
    // purchase (made by someone else) is invisible to them and the name arrives
    // blank — leaving nameless cancelled rows on /orders. We look it up here from
    // any order sharing the phone, then fall back to the prediction segment member.
    // Matches by last-8 digits (the CRM phone-normalisation canon). Never throws.
    const resolveKnownCustomerName = async (
      phone: string | null | undefined,
    ): Promise<string | null> => {
      const last8 = String(phone || "").replace(/\D/g, "").slice(-8);
      if (last8.length < 8) return null;
      try {
        const { data: ord } = await adminClient
          .from("orders")
          .select("customer_name")
          .ilike("customer_phone", `%${last8}`)
          .not("customer_name", "is", null)
          .neq("customer_name", "")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (ord?.customer_name?.trim()) return ord.customer_name.trim();

        const { data: member } = await adminClient
          .from("prediction_segment_members")
          .select("customer_name")
          .ilike("customer_phone", `%${last8}`)
          .not("customer_name", "is", null)
          .neq("customer_name", "")
          .limit(1)
          .maybeSingle();
        if (member?.customer_name?.trim()) return member.customer_name.trim();
      } catch (_e) {
        // Best-effort; never block order creation on a name lookup.
      }
      return null;
    };

    // User client for RLS-respecting operations
    const supabase = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader || "" } },
    });

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
    const segments = path.split("/");

    // ── PUBLIC WEBHOOK (HMAC-signed, no Supabase auth) ──
    // Legacy generic webhook
    if (req.method === "POST" && path === "webhook/leads") {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`legacy:${ip}`)) {
        return json({ error: "Rate limit exceeded" }, 429);
      }
      const rawBody = await req.text();
      if (!(await verifyWebhookSignature(req, rawBody))) {
        return json({ error: "Invalid or missing signature" }, 401);
      }
      let body;
      try { body = parseBody(inboundLeadSchema, JSON.parse(rawBody)); } catch (e: any) { return json({ error: e.message }, 400); }
      const { data: lead, error } = await adminClient
        .from("inbound_leads")
        .insert({ name: body.name, phone: body.phone, status: "pending", source: body.source })
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Auto-create order for this lead
      const { data: order } = await adminClient
        .from("orders")
        .insert({
          product_name: "From Landing Page",
          customer_name: body.name,
          customer_phone: body.phone,
          status: "pending",
          source_type: "inbound_lead",
          inbound_lead_id: lead.id,
        })
        .select("id, display_id")
        .single();

      return json({ success: true, id: lead.id, order_id: order?.id });
    }

    // PBX missed-call webhook (HMAC-signed). Logs an inbound call (caller + DID
    // + time) as a missed call so an agent can be assigned to call back.
    if (req.method === "POST" && path === "webhook/missed-call") {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`missed-call:${ip}`)) {
        return json({ error: "Rate limit exceeded" }, 429);
      }
      const rawBody = await req.text();
      if (!(await verifyWebhookSignature(req, rawBody))) {
        return json({ error: "Invalid or missing signature" }, 401);
      }
      let body: any;
      try { body = JSON.parse(rawBody); } catch { return json({ error: "bad json" }, 400); }
      const caller = String(body.caller_number || "").trim();
      const did = String(body.did || "").trim() || null;
      const uniqueid = String(body.uniqueid || "").trim() || null;
      if (!caller) return json({ error: "caller_number required" }, 400);
      const norm = caller.replace(/\D/g, "").slice(-8); // last-8 match (matches CRM phone-normalisation)
      let linkedOrderId: string | null = null;
      if (norm) {
        const { data: ord } = await adminClient
          .from("orders").select("id").ilike("customer_phone", `%${norm}`)
          .order("created_at", { ascending: false }).limit(1).maybeSingle();
        linkedOrderId = ord?.id || null;
      }
      const { error } = await adminClient
        .from("missed_calls")
        .upsert({ caller_number: caller, did, uniqueid, linked_order_id: linkedOrderId, linked_phone_norm: norm || null, status: "new" },
          { onConflict: "uniqueid", ignoreDuplicates: true });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // PBX voicemail webhook (HMAC-signed). The caller left a recorded message; the
    // PBX posts its file path so we stamp it onto the matching missed_calls row.
    // The audio lives under the monitor dir and is streamed via elyon-rec.php.
    if (req.method === "POST" && path === "webhook/missed-call-vm") {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`missed-call-vm:${ip}`)) {
        return json({ error: "Rate limit exceeded" }, 429);
      }
      const rawBody = await req.text();
      if (!(await verifyWebhookSignature(req, rawBody))) {
        return json({ error: "Invalid or missing signature" }, 401);
      }
      let body: any;
      try { body = JSON.parse(rawBody); } catch { return json({ error: "bad json" }, 400); }
      const uniqueid = String(body.uniqueid || "").trim();
      const file = String(body.file || "").trim();
      const seconds = Math.max(0, Math.round(Number(body.seconds) || 0));
      if (!uniqueid) return json({ error: "uniqueid required" }, 400);
      // Same path shape elyon-rec.php / the audio endpoint enforce.
      if (!/^\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._+\-]+\.wav$/.test(file)) return json({ error: "bad file" }, 400);
      const { error } = await adminClient
        .from("missed_calls")
        .update({ voicemail_file: file, voicemail_seconds: seconds })
        .eq("uniqueid", uniqueid);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // ===== PBX health webhook (HMAC-signed). A VPS cron POSTs the box's health
    // (disk/memory/load/lines/trunk/recordings/fail2ban) every few minutes so the
    // CRM keeps trend history + can alert even when nobody has the dashboard open.
    if (req.method === "POST" && path === "webhook/pbx-health") {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`pbx-health:${ip}`)) {
        return json({ error: "Rate limit exceeded" }, 429);
      }
      const rawBody = await req.text();
      if (!(await verifyWebhookSignature(req, rawBody))) {
        return json({ error: "Invalid or missing signature" }, 401);
      }
      let h: any;
      try { h = JSON.parse(rawBody); } catch { return json({ error: "bad json" }, 400); }
      const num = (v: any) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
      const { error } = await adminClient.from("pbx_health_snapshots").insert({
        captured_at: new Date().toISOString(),
        pbx_reachable: h?.ok !== false,
        disk_pct: num(h?.disk?.pct),
        rec_bytes: num(h?.disk?.rec_bytes),
        mem_pct: num(h?.mem?.pct),
        load1: num(h?.load?.["1"]),
        asterisk_up: h?.asterisk?.running === true,
        active_lines: num(h?.lines?.active),
        max_lines: num(h?.lines?.max) ?? TRUNK_MAX_LINES_FALLBACK,
        trunk_reachable: h?.trunk?.reachable === true,
        trunk_rtt_ms: num(h?.trunk?.rtt_ms),
        recordings_today: num(h?.recordings_today?.count),
        newest_rec_age_s: num(h?.recordings_today?.newest_age_seconds),
        banned_ips: num(h?.attacks?.banned_count),
        raw: h,
      });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // ===== Call-quality webhook (HMAC-signed). The Asterisk hangup hook posts the
    // hangup cause + RTP stats per call, so problems like one-way audio ("the agent
    // couldn't hear the client") become visible instead of silent. Upsert by uniqueid.
    if (req.method === "POST" && path === "webhook/call-quality") {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`call-quality:${ip}`)) {
        return json({ error: "Rate limit exceeded" }, 429);
      }
      const rawBody = await req.text();
      if (!(await verifyWebhookSignature(req, rawBody))) {
        return json({ error: "Invalid or missing signature" }, 401);
      }
      let b: any;
      try { b = JSON.parse(rawBody); } catch { return json({ error: "bad json" }, 400); }
      const uniqueid = String(b.uniqueid || "").trim();
      if (!uniqueid) return json({ error: "uniqueid required" }, 400);
      const num = (v: any) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
      const rx = num(b.rxcount), tx = num(b.txcount);
      const loss = num(b.packet_loss_pct);
      // One-way audio: media sent but nothing received back, or heavy loss.
      const oneWay = (tx !== null && tx > 0 && rx === 0) || (loss !== null && loss >= 30);
      // Best-effort link to the call_logs row (same phone last-8, nearest time).
      let callLogId: string | null = null;
      const last8 = String(b.dialed || "").replace(/\D/g, "").slice(-8);
      if (last8) {
        const { data: cl } = await adminClient
          .from("call_logs").select("id,started_at,connected_at")
          .ilike("customer_phone", `%${last8}`)
          .order("created_at", { ascending: false }).limit(5);
        const tMs = b.occurred_at ? new Date(b.occurred_at).getTime() : Date.now();
        let best: any = null, bestDiff = 30 * 60 * 1000;
        for (const c of cl || []) {
          const cMs = new Date(c.connected_at || c.started_at || 0).getTime();
          const d = Math.abs(cMs - tMs);
          if (d <= bestDiff) { bestDiff = d; best = c; }
        }
        callLogId = best?.id || null;
      }
      const { error } = await adminClient.from("call_quality").upsert({
        uniqueid,
        call_log_id: callLogId,
        extension: String(b.extension || "").trim() || null,
        direction: String(b.direction || "").trim() || null,
        dialed: String(b.dialed || "").trim() || null,
        hangup_cause: num(b.hangup_cause),
        hangup_cause_txt: String(b.hangup_cause_txt || "").trim() || null,
        jitter_ms: num(b.jitter_ms),
        packet_loss_pct: loss,
        rtt_ms: num(b.rtt_ms),
        rxcount: rx, txcount: tx,
        one_way_audio: oneWay,
        occurred_at: b.occurred_at || null,
      }, { onConflict: "uniqueid" });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // ===== Recording webhook (HMAC-signed). The Asterisk hangup hook posts one
    // row per call keyed by the Asterisk uniqueid — the permanent, deterministic
    // anchor for recording↔call linkage. We upsert it into call_recordings and
    // stamp recording_uniqueid/recording_file onto the matching call_logs row, so
    // the link is stable forever (no re-derivation, no swaps). Idempotent on
    // uniqueid: re-posting the same call just re-affirms the same link.
    if (req.method === "POST" && path === "webhook/recording") {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`recording:${ip}`)) {
        return json({ error: "Rate limit exceeded" }, 429);
      }
      const rawBody = await req.text();
      if (!(await verifyWebhookSignature(req, rawBody))) {
        return json({ error: "Invalid or missing signature" }, 401);
      }
      let b: any;
      try { b = JSON.parse(rawBody); } catch { return json({ error: "bad json" }, 400); }
      const uniqueid = String(b.uniqueid || "").trim();
      if (!uniqueid) return json({ error: "uniqueid required" }, 400);
      const num = (v: any) => (v === null || v === undefined || v === "" || isNaN(Number(v)) ? null : Number(v));
      const ext = String(b.ext || b.extension || "").trim() || null;
      const file = String(b.file || "").trim() || null;
      const dialedLast8 = String(b.dialed || "").replace(/\D/g, "").slice(-8) || null;
      const startEpoch = num(b.start_epoch ?? b.start);
      const endEpoch = num(b.end_epoch ?? b.end);
      const startedAt = startEpoch ? new Date(startEpoch * 1000).toISOString() : (b.started_at || null);
      const endedAt = endEpoch ? new Date(endEpoch * 1000).toISOString() : (b.ended_at || null);
      const duration = num(b.duration_seconds) ?? ((startEpoch && endEpoch) ? Math.max(0, endEpoch - startEpoch) : null);

      // Resolve the agent behind the extension.
      let agentId: string | null = null;
      if (ext) {
        const { data: te } = await adminClient.from("telephony_extensions").select("user_id").eq("extension", ext).maybeSingle();
        agentId = te?.user_id || null;
      }

      // Deterministically link to a call_logs row: same last-8 phone, near in time,
      // matched one-to-one by the shared matcher (end-anchored / interval-overlap).
      let callLogId: string | null = null;
      if (dialedLast8 && (endEpoch || startEpoch)) {
        const anchorMs = (endEpoch || startEpoch)! * 1000;
        const winStart = new Date(anchorMs - 2 * 24 * 3600 * 1000).toISOString();
        const winEnd = new Date(anchorMs + 1 * 24 * 3600 * 1000).toISOString();
        const { data: cands } = await adminClient
          .from("call_logs")
          .select("id,agent_id,customer_phone,started_at,connected_at,ended_at,created_at")
          .ilike("customer_phone", `%${dialedLast8}`)
          .gte("created_at", winStart).lte("created_at", winEnd)
          .limit(50);
        const rec: RecLite = { file: file || undefined, dialed: dialedLast8 || undefined, ext: ext || undefined, mtime: endEpoch || undefined, start: startEpoch || undefined, uniqueid };
        const extMap = ext && agentId ? { [ext]: agentId } : {};
        const matched = matchRecordingsToCalls([rec], (cands || []) as CallLite[], extMap);
        // matched is call.id -> rec; with a single rec there is at most one entry.
        callLogId = matched.size ? [...matched.keys()][0] : null;
      }

      // Persist the recording index row (authority for this uniqueid).
      const { error: recErr } = await adminClient.from("call_recordings").upsert({
        uniqueid,
        ext,
        dialed_last8: dialedLast8,
        started_at: startedAt,
        ended_at: endedAt,
        duration_seconds: duration,
        file,
        size: num(b.size),
        agent_id: agentId,
        call_log_id: callLogId,
      }, { onConflict: "uniqueid" });
      if (recErr) return json({ error: sanitizeDbError(recErr) }, 400);

      // Stamp the link onto the call_logs row. Move the uniqueid off any stale
      // holder first so the unique index is never violated (idempotent re-link).
      if (callLogId && file) {
        await adminClient.from("call_logs")
          .update({ recording_uniqueid: null, recording_file: null })
          .eq("recording_uniqueid", uniqueid).neq("id", callLogId);
        await adminClient.from("call_logs")
          .update({ recording_uniqueid: uniqueid, recording_file: file })
          .eq("id", callLogId);
      }
      return json({ success: true, linked: !!callLogId });
    }

    // Dynamic webhook by slug: POST /api/webhook/:slug
    // ("opencart" is a reserved slug handled by the OpenCart order bridge below.)
    if (req.method === "POST" && segments[0] === "webhook" && segments.length === 2 && segments[1] !== "leads" && segments[1] !== "opencart") {
      const slug = segments[1];
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`slug:${slug}`) || !checkWebhookRateLimit(`ip:${ip}`)) {
        return json({ error: "Rate limit exceeded" }, 429);
      }
      // Signature FIRST, slug lookup second. The other order let an unsigned
      // caller tell a live slug (404) from a disabled one (403) from a real one
      // (401), which maps the product catalogue and the live landing pages. The
      // secret is global over the raw body and slug-independent, so verifying
      // first costs nothing and makes every unauthenticated response identical.
      const rawBody = await req.text();
      if (!(await verifyWebhookSignature(req, rawBody))) {
        return json({ error: "Invalid or missing signature" }, 401);
      }

      const { data: webhook } = await adminClient
        .from("webhooks")
        .select("id, product_name, status, total_leads")
        .eq("slug", slug)
        .single();
      if (!webhook) return json({ error: "Webhook not found" }, 404);
      if (webhook.status !== "active") return json({ error: "Webhook is disabled" }, 403);

      let body;
      try { body = parseBody(inboundLeadSchema, JSON.parse(rawBody)); } catch (e: any) { return json({ error: e.message }, 400); }

      const { data: lead, error } = await adminClient
        .from("inbound_leads")
        .insert({
          name: body.name,
          phone: body.phone,
          status: "pending",
          source: body.source || "webhook",
          webhook_id: webhook.id,
          product_name: webhook.product_name,
        })
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Increment total_leads
      await adminClient.from("webhooks").update({ total_leads: (webhook.total_leads || 0) + 1 }).eq("id", webhook.id);

      // Auto-create order for this lead
      const { data: order } = await adminClient
        .from("orders")
        .insert({
          product_name: webhook.product_name,
          customer_name: body.name,
          customer_phone: body.phone,
          status: "pending",
          source_type: "inbound_lead",
          inbound_lead_id: lead.id,
        })
        .select("id, display_id")
        .single();

      return json({ success: true, id: lead.id, order_id: order?.id, product: webhook.product_name });
    }

    // ── OPENCART ORDER BRIDGE (HMAC-signed, no Supabase auth) ──
    // POST /api/webhook/opencart — the elyon_crm_bridge OCMOD on naturatherapy.mk
    // pushes every placed order here (and, optionally, qualified abandoned carts).
    // Idempotent: deduped on (external_source, external_order_id) so the live
    // event, the historical import, and status upgrades all upsert one CRM row.
    if (req.method === "POST" && segments[0] === "webhook" && segments.length === 2 && segments[1] === "opencart") {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`opencart:${ip}`)) {
        return json({ error: "Rate limit exceeded" }, 429);
      }
      const rawBody = await req.text();
      if (!(await verifyWebhookSignature(req, rawBody))) {
        return json({ error: "Invalid or missing signature" }, 401);
      }
      let body;
      try { body = parseBody(opencartOrderSchema, JSON.parse(rawBody)); } catch (e: any) { return json({ error: e.message }, 400); }

      const externalSource = (body.source || "naturatherapy.mk").trim();
      const isAbandoned = body.mode === "abandoned";

      // ── Customer name + phone ──
      const fullName = (body.customer_name
        || `${body.first_name || ""} ${body.last_name || ""}`.trim()).trim();
      const phone = normalizeMkPhone(body.phone);

      // Abandoned carts are only kept as leads when we have a real lead: a full
      // name (first + last) AND a complete phone number. Junk is dropped quietly.
      if (isAbandoned) {
        const hasFullName = fullName.split(/\s+/).filter(Boolean).length >= 2;
        const hasFullPhone = !!phone && phone.replace(/\D/g, "").length >= 11; // +389 + ~8 digits (Macedonia). TODO(mk): verify threshold
        if (!hasFullName || !hasFullPhone) {
          return json({ success: true, skipped: "abandoned cart missing full name or phone" });
        }
      }
      if (!phone) return json({ error: "Phone is required" }, 400);

      // ── Money: store EUR. ──
      // Explicit whitelist, and a hard 400 on anything else.
      //
      // The upstream version converted only "BGN" and passed EVERY OTHER
      // currency through 1:1. A Macedonian storefront sending currency:"MKD"
      // would therefore have had a 1,845 ден order stored as a €1,845 order —
      // ~61x too high. That single row then lands in the top commission tier,
      // sits in the wrong prediction value band forever, and inflates revenue,
      // VAT and pure profit. It fails silently, permanently, and per order.
      // Never default-passthrough an unrecognised currency.
      const MKD_PER_EUR = 61.5;   // must match src/lib/currency.ts (frozen)
      const FX: Record<string, number> = { EUR: 1, MKD: 1 / MKD_PER_EUR };
      const curCode = (body.currency || "EUR").toUpperCase();
      if (!(curCode in FX)) {
        return json({ error: `Unsupported currency '${curCode}'. Send EUR or MKD.` }, 400);
      }
      const toEur = (v: number) => Math.round(v * FX[curCode] * 100) / 100;

      // ── Match line items to the CRM catalogue (by sku/barcode, then name) ──
      const rawItems = body.items || [];
      // Catalogue snapshot for the alias/fuzzy fallback when sku/barcode/exact-name miss.
      const { data: catalogueRows } = await adminClient.from("products").select("id, name, sku, price");
      const catalogue = catalogueRows || [];
      const matchedItems: { product_id: string | null; product_name: string; quantity: number; price_per_unit: number; total_price: number }[] = [];
      for (const it of rawItems) {
        // Storefront bundles ("Brain 4", "Prostatol 3 + Palmetto 1") become one
        // line per real catalogue component, so reports/commissions/stock all see
        // true products. Only when EVERY component SKU resolves — otherwise the
        // line falls through to the normal single-line path unchanged.
        const bundle = it.name ? matchBundle(it.name) : null;
        if (bundle) {
          const comps = bundle.map((b) => ({ ...b, product: catalogue.find((c: any) => c.sku === b.sku) }));
          if (comps.every((c) => c.product)) {
            const lineQty = Number(it.quantity) || 1;
            const lineTotal = Math.round(lineQty * (toEur(Number(it.price) || 0)) * 100) / 100;
            const expanded = comps.map((c) => ({ ...c, compQty: c.qty * lineQty, cataloguePrice: Number(c.product!.price) || 0 }));
            const money = allocateBundlePrice(lineTotal, expanded);
            expanded.forEach((c, i) => matchedItems.push({
              product_id: c.product!.id,
              product_name: c.product!.name || "",
              quantity: c.compQty,
              price_per_unit: money[i].price_per_unit,
              total_price: money[i].total_price,
            }));
            continue;
          }
        }
        // Leading-multiplier marketing names: "3X Curcumactiv (500ml) - сироп…"
        // is 3 packages of one product. Strip the prefix, resolve the base name,
        // multiply the quantity and divide the per-package price so the line
        // total is unchanged. (x / Cyrillic х / ×, case-insensitive.)
        const multi = it.name ? String(it.name).trim().match(/^(\d{1,2})\s*[xх×]\s+(.+)$/i) : null;
        if (multi) {
          const baseKey = multi[2].toLowerCase().trim();
          const exact = catalogue.find((c: any) => (c.name || "").toLowerCase().trim() === baseKey);
          const resolvedId = exact ? exact.id : resolveCatalogueProductId(multi[2], catalogue);
          const prod = exact || (resolvedId ? catalogue.find((c: any) => c.id === resolvedId) : null);
          if (prod) {
            const mult = parseInt(multi[1], 10);
            const lineQty = Number(it.quantity) || 1;
            const lineTotal = Math.round(lineQty * (toEur(Number(it.price) || 0)) * 100) / 100;
            const q = mult * lineQty;
            matchedItems.push({
              product_id: prod.id,
              product_name: prod.name || "",
              quantity: q,
              price_per_unit: Math.round((lineTotal / q) * 100) / 100,
              total_price: lineTotal,
            });
            continue;
          }
        }
        let productId: string | null = null;
        const sku = (it.sku || "").trim();
        if (sku) {
          const { data: bySku } = await adminClient
            .from("products").select("id").eq("sku", sku).limit(1).maybeSingle();
          if (bySku) productId = bySku.id;
          if (!productId) {
            const { data: byBarcode } = await adminClient
              .from("products").select("id").eq("barcode", sku).limit(1).maybeSingle();
            if (byBarcode) productId = byBarcode.id;
          }
        }
        if (!productId && it.name) {
          const { data: byName } = await adminClient
            .from("products").select("id").ilike("name", it.name.trim()).limit(1).maybeSingle();
          if (byName) productId = byName.id;
        }
        // Last resort: alias + fuzzy catalogue match (Cyrillic vs English names,
        // promo suffixes). Keeps Site orders linked so stock decrements on ship.
        if (!productId && it.name) {
          productId = resolveCatalogueProductId(it.name, catalogue);
        }
        const ppu = toEur(Number(it.price) || 0);
        const qty = Number(it.quantity) || 1;

        // Prefer the official warehouse/catalogue name when we successfully matched
        // a product. Keeps one name per product everywhere (insights group by name,
        // so "Curcumactiv" vs "Curcumactiv (500ml)" would otherwise split rows).
        let displayName = it.name.trim();
        if (productId) {
          const cat = catalogue.find((c: any) => c.id === productId);
          if (cat?.name) displayName = cat.name;
        }

        matchedItems.push({
          product_id: productId,
          product_name: displayName,
          quantity: qty,
          price_per_unit: ppu,
          total_price: Math.round(qty * ppu * 100) / 100,
        });
      }

      const computedTotal = matchedItems.reduce((s, i) => s + i.total_price, 0);
      const totalPrice = body.total != null ? toEur(Number(body.total)) : computedTotal;
      const totalQty = matchedItems.reduce((s, i) => s + i.quantity, 0) || 1;
      const productSummary = matchedItems.length
        ? matchedItems.map((i) => i.product_name).join(", ")
        : (isAbandoned ? "Abandoned cart" : "From naturatherapy.mk");

      // source_type drives the UI badge: 'opencart' = a real Site order,
      // 'opencart_abandoned' = an abandoned-cart lead.
      const sourceType = isAbandoned ? "opencart_abandoned" : "opencart";

      const orderRow: Record<string, any> = {
        product_name: productSummary,
        customer_name: fullName || "—",
        customer_phone: phone,
        customer_city: body.city || "",
        customer_address: body.address || "",
        postal_code: body.postal_code || "",
        price: totalPrice,
        quantity: totalQty,
        status: "pending",
        source_type: sourceType,
        external_source: externalSource,
        external_order_id: body.order_id,
        // Keep unassigned so it surfaces in the Assigner for distribution.
        assigned_agent_id: null,
        assigned_agent_name: null,
        assigned_at: null,
      };

      // ── Upsert on the external ref (idempotent) ──
      const { data: existing } = await adminClient
        .from("orders")
        .select("id")
        .eq("external_source", externalSource)
        .eq("external_order_id", body.order_id)
        .maybeSingle();

      let orderId: string;
      let wasNew = false;
      let didWrite = false; // inserted, or refreshed an untouched pending
      if (existing) {
        // Don't clobber an order an agent has already worked: only refresh while
        // it's still an untouched pending. An abandoned→order upgrade still flows
        // through here and flips source_type/product/total.
        const { data: cur } = await adminClient
          .from("orders").select("status, assigned_agent_id").eq("id", existing.id).maybeSingle();
        if (cur && cur.status === "pending" && !cur.assigned_agent_id) {
          await adminClient.from("orders").update(orderRow).eq("id", existing.id);
          await adminClient.from("order_items").delete().eq("order_id", existing.id);
          didWrite = true;
        }
        orderId = existing.id;
      } else {
        const { data: order, error: orderErr } = await adminClient
          .from("orders").insert(orderRow).select("id, display_id").single();
        if (orderErr) return json({ error: sanitizeDbError(orderErr) }, 400);
        orderId = order.id;
        wasNew = true;
        didWrite = true;
      }

      // ── Line items + provenance, only when we actually (re)wrote the order ──
      if (didWrite) {
        if (matchedItems.length) {
          await adminClient.from("order_items").insert(
            matchedItems.map((i) => ({ ...i, order_id: orderId })),
          );
        }

        // Replace the System provenance note so it always reflects the CURRENT
        // state — an abandoned cart that later completes loses its "abandoned"
        // note and gains the real status. Agent-written notes are left intact.
        const noteBits = [
          `Imported from ${externalSource} (OpenCart order #${body.order_id})`,
          isAbandoned ? "ABANDONED CART — checkout not completed" : (body.status_label ? `Status: ${body.status_label}` : ""),
          body.email ? `Email: ${body.email}` : "",
          body.date_added ? `Order date: ${body.date_added}` : "",
          body.comment ? `Customer comment: ${body.comment}` : "",
        ].filter(Boolean);
        await adminClient
          .from("order_notes")
          .delete()
          .eq("order_id", orderId)
          .eq("author_name", "System")
          .ilike("text", "Imported from %");
        await adminClient.from("order_notes").insert({
          order_id: orderId,
          text: noteBits.join("\n"),
          author_id: null,
          author_name: "System",
        });
      }

      if (wasNew) {
        await adminClient.from("order_history").insert({
          order_id: orderId,
          to_status: "pending",
          changed_by: null,
          changed_by_name: "System (naturatherapy.mk)",
        });
      }

      return json({ success: true, order_id: orderId, created: wasNew, mode: body.mode });
    }

    // ── PUBLIC AFFILIATE/CPA INTAKE (api-key-authed, no Supabase auth) ──
    // AlterCPA-Moe-compatible lead submission. Auth = the affiliate's api_key
    // (body `key`, `?key=`, or `X-Api-Key` header) — no HMAC by design, keys
    // are per-affiliate, rotatable, and pausable/bannable. The lead lands as a
    // normal unassigned pending order (source_type='affiliate') plus its
    // tracking sidecar in affiliate_leads; the 'lead' postback is enqueued
    // here in TS because the sidecar is written after the order row (the DB
    // trigger only covers status CHANGES — see migration 20260801000200).
    if (req.method === "POST" && segments[0] === "cpa" && segments[1] === "lead" && segments.length === 2) {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`cpa:ip:${ip}`)) return cpaError("traffic");

      let body: z.infer<typeof cpaLeadSchema>;
      try {
        body = parseBody(cpaLeadSchema, await req.json());
      } catch (e: any) {
        return json({ error: e?.message || "Invalid JSON body" }, 400);
      }
      // Trackers send numbers and strings interchangeably — normalize once.
      const s = (v: unknown, max = 300) => (v == null ? "" : String(v).trim().slice(0, max));

      const key = s(body.key, 200)
        || (url.searchParams.get("key") || "").trim()
        || (req.headers.get("x-api-key") || "").trim();
      if (!key) return cpaError("security");
      if (!checkWebhookRateLimit(`cpa:key:${key.slice(0, 80)}`)) return cpaError("traffic");

      const { data: aff } = await adminClient
        .from("affiliates")
        .select("id, code, name, status")
        .eq("api_key", key)
        .maybeSingle();
      if (!aff) return cpaError("security");
      if (aff.status === "banned") return cpaError("ban");
      if (aff.status !== "active") return cpaError("security");

      const offerRef = s(body.offer, 200);
      if (!offerRef) return cpaError("nooffer");
      const offerBase = adminClient
        .from("offers")
        .select("id, product_id, name, geo, payout_eur, price_eur, is_active");
      const { data: offer } = await (UUID_RE.test(offerRef)
        ? offerBase.eq("id", offerRef)
        : offerBase.eq("name", offerRef)
      ).maybeSingle();
      if (!offer || !offer.is_active) return cpaError("offer");

      const { data: approval } = await adminClient
        .from("affiliate_offers")
        .select("id, status, payout_override_eur")
        .eq("affiliate_id", aff.id)
        .eq("offer_id", offer.id)
        .maybeSingle();
      if (!approval || approval.status !== "approved") return cpaError("offer");

      const phone = normalizeMkPhone(s(body.phone, 40));
      if (!phone) return cpaError("nophone");

      // Their lead id = idempotency key; 'auto' (AlterCPA convention) → none.
      const extRaw = s(body.ext_id ?? body.id, 190);
      const extId = extRaw && extRaw.toLowerCase() !== "auto" ? extRaw : null;
      if (extId) {
        const { data: dupe } = await adminClient
          .from("affiliate_leads")
          .select("id, order_id")
          .eq("affiliate_id", aff.id)
          .eq("ext_id", extId)
          .maybeSingle();
        if (dupe) {
          // Echo OUR opaque lead ref, never orders.display_id. ORD-xxxxx comes
          // from one global sequence shared by every order in the CRM, so two
          // of them hand a partner an exact order-volume odometer.
          return cpaError("duplicate", { id: dupe.id, uid: extId });
        }
      }

      // Phone dedupe: last-8 match against ALL recent orders regardless of
      // source (call-center semantics — the customer is already in the
      // pipeline, whoever sent them). Window is admin-tunable; 0 disables.
      const windowH = await getAffiliateDedupeWindowHours(adminClient);
      if (windowH > 0) {
        const last8 = phone.replace(/\D/g, "").slice(-8);
        const cutoff = new Date(Date.now() - windowH * 3_600_000).toISOString();
        const { data: dupeOrder } = await adminClient
          .from("orders")
          .select("id")
          .ilike("customer_phone", `%${last8}`)
          .gte("created_at", cutoff)
          // Internal duplicates are OUR bookkeeping and must never affect
          // intake: the copy is inserted with created_at = now(), so without
          // this filter pressing Duplicate on an old order silently rejects
          // that customer's genuine new affiliate lead for the whole window.
          .is("duplicated_from", null)
          .limit(1)
          .maybeSingle();
        // Deliberately NO id in this reply — the matched order can belong to
        // any channel (prediction list, walk-in, another affiliate). Telling
        // the sender which order it was would leak our order book.
        if (dupeOrder) return cpaError("duplicate", { uid: extId });
      }

      const qty = body.quantity ?? 1;
      let product: any = null;
      if (offer.product_id) {
        const { data } = await adminClient
          .from("products").select("id, name, price").eq("id", offer.product_id).maybeSingle();
        product = data;
      }
      // Customer price PER PACKAGE. The offer's own price wins so an affiliate
      // channel can sell at the price its landing page advertises without
      // repricing the product for the call centre; NULL inherits the product.
      const unitPrice = Number(offer.price_eur ?? product?.price ?? 0) || 0;
      // Affiliate commission — FLAT per paid order, never multiplied by qty:
      // agents upsell to 2-3 packages and the partner still earns exactly this.
      const payout = Math.round(Number(approval.payout_override_eur ?? offer.payout_eur ?? 0) * 100) / 100;
      // Always set the external ref so the partial-unique index
      // (external_source, external_order_id) backstops ext_id races.
      const externalOrderId = extId ?? crypto.randomUUID();

      const { data: order, error: orderErr } = await adminClient
        .from("orders")
        .insert({
          product_id: product?.id ?? null,
          product_name: product?.name ?? offer.name,
          customer_name: s(body.name, 200) || "—",
          customer_phone: phone,
          customer_city: s(body.city, 200),
          customer_address: s(body.address, 600),
          postal_code: s(body.postal_code, 30),
          price: Math.round(unitPrice * qty * 100) / 100,
          quantity: qty,
          status: "pending",
          source_type: "affiliate",
          external_source: `affiliate:${aff.code}`,
          external_order_id: externalOrderId,
          // Keep unassigned so it surfaces in the Assigner for distribution.
          assigned_agent_id: null,
          assigned_agent_name: null,
          assigned_at: null,
        })
        .select("id, display_id")
        .single();
      if (orderErr || !order) {
        if ((orderErr as any)?.code === "23505") return cpaError("duplicate", { uid: extId });
        console.error("cpa/lead: order insert failed:", (orderErr as any)?.code);
        return cpaError("db");
      }

      const subs = [s(body.sub1) || s(body.wm), s(body.sub2), s(body.sub3), s(body.sub4), s(body.sub5)];
      const clickid = s(body.clickid) || s(body.cuid) || s(body.fbclid) || s(body.gclid) || s(body.ttclid);
      const { data: leadRow, error: leadErr } = await adminClient
        .from("affiliate_leads")
        .insert({
          affiliate_id: aff.id,
          offer_id: offer.id,
          order_id: order.id,
          ext_id: extId,
          clickid: clickid || null,
          sub1: subs[0] || null,
          sub2: subs[1] || null,
          sub3: subs[2] || null,
          sub4: subs[3] || null,
          sub5: subs[4] || null,
          ip: s(body.ip, 64) || ip,
          ua: s(body.ua, 512) || (req.headers.get("user-agent") || "").slice(0, 512) || null,
          country: s(body.country, 8).toUpperCase() || null,
          payout_eur_snapshot: payout,
        })
        .select("id")
        .single();
      if (leadErr || !leadRow) {
        // Never leave an affiliate order without its tracking sidecar — the
        // portal/stats/postbacks would all be blind to it.
        await adminClient.from("orders").delete().eq("id", order.id);
        if ((leadErr as any)?.code === "23505") return cpaError("duplicate", { uid: extId });
        console.error("cpa/lead: sidecar insert failed:", (leadErr as any)?.code);
        return cpaError("db");
      }

      // Line item keeps stock/commission math consistent (opencart precedent).
      await adminClient.from("order_items").insert({
        order_id: order.id,
        product_id: product?.id ?? null,
        product_name: product?.name ?? offer.name,
        quantity: qty,
        price_per_unit: unitPrice,
        total_price: Math.round(unitPrice * qty * 100) / 100,
      });

      const utm: Array<[string, string]> = [
        ["source", s(body.us)], ["campaign", s(body.uc)], ["medium", s(body.um)],
        ["content", s(body.un)], ["term", s(body.ut)],
      ];
      const noteBits = [
        `Affiliate lead from ${aff.name} (${aff.code})`,
        `Offer: ${offer.name}${offer.geo ? ` [${offer.geo}]` : ""}`,
        extId ? `Ext ID: ${extId}` : "",
        clickid ? `Click ID: ${clickid}` : "",
        subs.some(Boolean)
          ? `Subs: ${subs.map((v, i) => (v ? `sub${i + 1}=${v}` : "")).filter(Boolean).join(" ")}`
          : "",
        utm.some(([, v]) => v)
          ? `UTM: ${utm.map(([k, v]) => (v ? `${k}=${v}` : "")).filter(Boolean).join(" ")}`
          : "",
        s(body.email, 254) ? `Email: ${s(body.email, 254)}` : "",
      ].filter(Boolean);
      await adminClient.from("order_notes").insert({
        order_id: order.id,
        text: noteBits.join("\n"),
        author_id: null,
        author_name: "System",
      });
      await adminClient.from("order_history").insert({
        order_id: order.id,
        to_status: "pending",
        changed_by: null,
        changed_by_name: `System (affiliate:${aff.code})`,
      });

      // Enqueue the 'lead' postback (best-effort; delivery honors the
      // affiliate's postback_enabled/postback_events at drain time).
      const { error: pbErr } = await adminClient.from("affiliate_postbacks").insert({
        affiliate_id: aff.id,
        affiliate_lead_id: leadRow.id,
        order_id: order.id,
        event: "lead",
      });
      if (pbErr) console.error("cpa/lead: postback enqueue failed:", pbErr.code);

      // Ping every super-admin that an affiliate lead just landed (best-effort;
      // never blocks intake). Same audience as the order-paid oversight ping.
      try {
        const { data: adminRows } = await adminClient
          .from("user_roles").select("user_id").eq("role", "admin");
        await notifyUsers(adminClient, (adminRows || []).map((r: any) => r.user_id), {
          type: "affiliate_lead",
          title: "New affiliate lead",
          message: `${order.display_id} from ${aff.name} (${aff.code}) — ${offer.name}. ${s(body.name, 120) || "—"} · ${phone}`,
          link: "/assigner",
        });
      } catch (_) { /* notifications must never fail the intake */ }

      // Deliver the 'lead' event in seconds; the cron sweep is the guarantee.
      nudgePostbackDrain(adminClient);

      // `id` is our OPAQUE lead ref (affiliate_leads.id — already the row key
      // the portal shows them), never orders.display_id. AlterCPA stores
      // whatever we return as the lead's external id, so a UUID is fine.
      return json({ status: "ok", id: leadRow.id, uid: extId ?? leadRow.id });
    }

    // Status check: GET /api/cpa/leads?key=…&ids=a,b,c (≤50 ids — your ext_ids
    // and/or our ORD-xxxxx display ids, mixed freely). Returns the affiliate
    // stage only: no customer data, no internal statuses, no agent identities.
    if (req.method === "GET" && segments[0] === "cpa" && segments[1] === "leads" && segments.length === 2) {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`cpa:ip:${ip}`)) return cpaError("traffic");
      const key = (url.searchParams.get("key") || "").trim()
        || (req.headers.get("x-api-key") || "").trim();
      if (!key) return cpaError("security");
      if (!checkWebhookRateLimit(`cpa:key:${key.slice(0, 80)}`)) return cpaError("traffic");

      const { data: aff } = await adminClient
        .from("affiliates").select("id, status").eq("api_key", key).maybeSingle();
      if (!aff) return cpaError("security");
      if (aff.status === "banned") return cpaError("ban");
      if (aff.status !== "active") return cpaError("security");

      const ids = (url.searchParams.get("ids") || "")
        .split(",").map((v) => v.trim()).filter(Boolean).slice(0, 50);
      if (!ids.length) return cpaError("noid");

      // Match by their ext_id…
      const { data: byExt } = await adminClient
        .from("affiliate_leads")
        .select("id, ext_id, order_id, created_at")
        .eq("affiliate_id", aff.id)
        .in("ext_id", ids);
      // …and by the opaque lead ref we handed back at intake. Our ORD-xxxxx
      // display ids are deliberately NOT accepted here: resolving one would
      // confirm the mapping between our order numbering and their lead, which
      // is exactly what dropping display_id from the responses prevents.
      const refIds = ids.filter((v) => UUID_RE.test(v));
      let byRef: any[] = [];
      if (refIds.length) {
        const { data } = await adminClient
          .from("affiliate_leads")
          .select("id, ext_id, order_id, created_at")
          .eq("affiliate_id", aff.id)
          .in("id", refIds);
        byRef = data || [];
      }
      const leadById = new Map<string, any>();
      for (const l of [...(byExt || []), ...byRef]) leadById.set(l.id, l);
      if (!leadById.size) return json({ status: "ok", leads: [] });

      const orderIds = [...leadById.values()].map((l) => l.order_id).filter(Boolean);
      const { data: leadOrders } = await adminClient
        .from("orders")
        .select("id, status, cancellation_reason, return_reason, trash_reason")
        .in("id", orderIds);
      const orderById = new Map((leadOrders || []).map((o: any) => [o.id, o]));

      const out = [...leadById.values()].map((l) => {
        const o = orderById.get(l.order_id);
        const stage = o ? (CPA_STAGE[o.status] || "wait") : "wait";
        const reason = o && ["cancel", "trash", "return"].includes(stage)
          ? (o.cancellation_reason || o.return_reason || o.trash_reason || null)
          : null;
        return {
          id: l.id,                    // our opaque lead ref, never ORD-xxxxx
          uid: l.ext_id ?? l.id,
          stage,
          reason,
          created_at: l.created_at,
        };
      });
      return json({ status: "ok", leads: out });
    }

    // Drain worker: POST /api/cpa/postbacks/process — poked every minute by
    // pg_cron→pg_net (migration 20260801000300) and by the admin "Process now"
    // button. Gated by POSTBACK_DRAIN_SECRET, fail-closed like WEBHOOK_SECRET.
    // Loops in batches until the queue has nothing due or ~25s elapsed.
    if (req.method === "POST" && segments[0] === "cpa" && segments[1] === "postbacks"
        && segments[2] === "process" && segments.length === 3) {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`cpa:drain:${ip}`, 30)) return json({ error: "Rate limit exceeded" }, 429);
      const drainSecret = Deno.env.get("POSTBACK_DRAIN_SECRET");
      if (!drainSecret) {
        console.error("POSTBACK_DRAIN_SECRET not set — REJECTING drain request (fail-closed)");
        return json({ error: "Unauthorized" }, 401);
      }
      if ((req.headers.get("x-postback-secret") || "") !== drainSecret) {
        return json({ error: "Unauthorized" }, 401);
      }

      const started = Date.now();
      const totals = { claimed: 0, delivered: 0, retried: 0, failed: 0, skipped: 0 };
      while (Date.now() - started < 25_000) {
        const r = await drainAffiliatePostbacks(adminClient, 20);
        totals.claimed += r.claimed;
        totals.delivered += r.delivered;
        totals.retried += r.retried;
        totals.failed += r.failed;
        totals.skipped += r.skipped;
        if (r.claimed === 0) break;
      }
      return json({ success: true, ...totals });
    }

    // ── PUBLIC TV LEADERBOARD (token-gated, no Supabase auth) ──
    // Aggregates-only, no PII. Drives the always-on wall screen. The token is
    // validated server-side BEFORE the auth gate so a wall TV needs no login.
    // Returns today's (Europe/Skopje) per-agent confirmed count, AVG order value,
    // answer rate, and the computed daily game bonus + rank.
    if (req.method === "GET" && path === "leaderboard") {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
      if (!checkWebhookRateLimit(`leaderboard:${ip}`)) return json({ error: "Rate limit exceeded" }, 429);
      const key = url.searchParams.get("key") || "";
      if (!key) return json({ error: "Unauthorized" }, 401);
      const { data: tok } = await adminClient
        .from("leaderboard_access_tokens")
        .select("id").eq("token", key).eq("is_active", true).maybeSingle();
      if (!tok) return json({ error: "Unauthorized" }, 401);

      // ?mode=prediction|pending. Two different sales motions, different bonuses.
      // Default = prediction (the live motion today; pendings aren't flowing yet).
      const mode = url.searchParams.get("mode") === "pending" ? "pending" : "prediction";
      // ?day=YYYY-MM-DD lets the TV page browse previous days; default = today (Skopje).
      const { day, today, startISO, endISO } = skopjeDayRange(url.searchParams.get("day") || "");
      const isToday = day === today;

      // Roster + bonus rules are per-mode. Roster (if set) is an exact whitelist.
      const { data: rosterRows } = await adminClient
        .from("leaderboard_roster").select("agent_id").eq("roster_date", day).eq("mode", mode);
      const rosterIds = new Set((rosterRows || []).map((r: any) => r.agent_id));

      // Eligible call-agents; admins/managers are shown but never earn.
      const { data: agentRoleRows } = await adminClient
        .from("user_roles").select("user_id").in("role", ["agent", "pending_agent", "prediction_agent", "inbound_agent"]);
      const agentRoleIds = new Set((agentRoleRows || []).map((r: any) => r.user_id));
      const { data: superRoles } = await adminClient
        .from("user_roles").select("user_id").in("role", ["admin", "manager"]);
      const superIds = new Set((superRoles || []).map((r: any) => r.user_id));

      const { data: ruleRows } = await adminClient
        .from("leaderboard_bonus_rules").select("metric,tiers,is_active").eq("mode", mode);
      const rules: Record<string, { tiers: any[]; is_active: boolean }> = {};
      for (const r of ruleRows || []) rules[r.metric] = { tiers: r.tiers || [], is_active: !!r.is_active };

      // Orders confirmed that day, scoped to the mode's source:
      //  • prediction = cold lists (prediction_list_id set OR source_type=prediction_lead)
      //  • pending    = warm inbound orders the customer placed (inbound_lead / opencart)
      let oq = adminClient.from("orders")
        .select("id,status,price,quantity,confirmed_by_agent_id,confirmed_by_name,assigned_agent_id,assigned_agent_name,confirmed_at,order_items(price_per_unit,quantity)")
        .gte("confirmed_at", startISO).lt("confirmed_at", endISO)
        .in("status", REAL_ORDER_STATUSES);
      oq = mode === "prediction"
        ? oq.or("prediction_list_id.not.is.null,source_type.eq.prediction_lead")
        : oq.in("source_type", ["inbound_lead", "opencart"]);
      const { data: orders } = await oq;

      // Calls scoped to the motion via context_type.
      const { data: calls } = await adminClient
        .from("call_logs").select("agent_id")
        .gte("created_at", startISO).lt("created_at", endISO)
        .eq("context_type", mode === "prediction" ? "prediction_lead" : "order");

      const { data: logins } = await adminClient
        .from("shift_login_logs").select("user_id").eq("shift_date", day);

      const activeIds = new Set<string>();
      for (const o of orders || []) { const id = salesOwnerId(o); if (id) activeIds.add(id); }
      for (const c of calls || []) { if (c.agent_id) activeIds.add(c.agent_id); }
      for (const l of logins || []) { if (l.user_id) activeIds.add(l.user_id); }

      let displayIds: string[];
      if (rosterIds.size > 0) displayIds = [...rosterIds];
      else displayIds = [...activeIds].filter((id) => agentRoleIds.has(id) || superIds.has(id));
      const display = new Set(displayIds);

      const nameById: Record<string, string> = {};
      if (displayIds.length) {
        const { data: profs } = await adminClient.from("profiles").select("user_id,full_name").in("user_id", displayIds);
        for (const p of profs || []) nameById[p.user_id] = p.full_name;
      }

      type Agg = { user_id: string; full_name: string; confirmed_count: number; total_price: number; packages: number; package_bonus: number; calls: number };
      const agg: Record<string, Agg> = {};
      for (const id of displayIds) agg[id] = { user_id: id, full_name: nameById[id] || "Agent", confirmed_count: 0, total_price: 0, packages: 0, package_bonus: 0, calls: 0 };

      for (const o of orders || []) {
        const id = salesOwnerId(o);
        if (!id || !display.has(id)) continue;
        const a = agg[id];
        if (a.full_name === "Agent") a.full_name = salesOwnerName(o) || a.full_name;
        if (o.status === "returned") continue; // returns reverse themselves
        a.confirmed_count++;
        a.total_price += Number(o.price || 0);
        const its = o.order_items || [];
        a.packages += its.length ? its.reduce((s: number, it: any) => s + Number(it.quantity || 0), 0) : (Number(o.quantity || 0) || 1);
        a.package_bonus += its.length
          ? its.reduce((s: number, it: any) => s + packageBonusRate(Number(it.price_per_unit || 0)) * Number(it.quantity || 0), 0)
          : packageBonusRate(Number(o.price || 0) / Math.max(1, Number(o.quantity || 0) || 1)) * (Number(o.quantity || 0) || 1);
      }
      for (const c of calls || []) { const id = c.agent_id; if (id && display.has(id)) agg[id].calls++; }

      const tiersFor = (m: string) => (rules[m]?.is_active ? rules[m].tiers : []);
      const targetTiers = tiersFor("revenue_target");
      const topTarget = targetTiers.reduce((mx: number, t: any) => Math.max(mx, Number(t?.min) || 0), 0);

      // PREDICTION targets are a TEAM total per day (not per-agent). Compute the
      // team's combined revenue (non-super agents) once; the team-tier bonus is
      // shared — every active agent earns it when the TEAM reaches a target.
      let teamRevenueRaw = 0;
      for (const a of Object.values(agg)) if (!superIds.has(a.user_id)) teamRevenueRaw += a.total_price;
      const teamRevenue = Math.round(teamRevenueRaw * 100) / 100;
      const teamTargetBonus = mode === "prediction" ? tierBonus(teamRevenue, targetTiers) : 0;
      const teamTargetPct = topTarget > 0 ? Math.round((teamRevenue / topTarget) * 1000) / 10 : 0;

      const agents = Object.values(agg).map((a) => {
        const confirmed = a.confirmed_count; // net of returns
        const avg = confirmed > 0 ? Math.round((a.total_price / confirmed) * 100) / 100 : 0;
        const revenue = Math.round(a.total_price * 100) / 100;
        const soldRate = a.calls > 0 ? Math.round((confirmed / a.calls) * 1000) / 10 : 0;
        const pkg = Math.round(a.package_bonus * 100) / 100; // already reversed for returns
        const isSuper = superIds.has(a.user_id);
        let total = 0; let breakdown: Record<string, number>;
        if (mode === "prediction") {
          // Cold lists: per-package + a SHARED team-target bonus (the team total
          // reaching €1500/€2500/€4000). No conversion/avg bonus on cold calls.
          total = isSuper ? 0 : Math.round((pkg + teamTargetBonus) * 100) / 100;
          breakdown = isSuper ? { package: 0, target: 0 } : { package: pkg, target: teamTargetBonus };
        } else {
          // Warm pendings: per-package + confirmed milestones + avg (10+ orders gate).
          const volume = tierBonus(confirmed, tiersFor("confirmed_count"));
          const avgBonus = confirmed >= 10 ? tierBonus(avg, tiersFor("avg_order_value")) : 0;
          total = isSuper ? 0 : Math.round((pkg + volume + avgBonus) * 100) / 100;
          breakdown = isSuper ? { package: 0, volume: 0, avg: 0 } : { package: pkg, volume, avg: avgBonus };
        }
        return {
          user_id: a.user_id, full_name: a.full_name, is_super: isSuper,
          confirmed_count: confirmed, packages: a.packages,
          avg_order_value: avg, revenue, target_pct: teamTargetPct, sold_rate: soldRate, calls: a.calls,
          bonus: total, bonus_breakdown: breakdown,
        };
      });
      if (mode === "prediction") agents.sort((x, y) => y.revenue - x.revenue || y.bonus - x.bonus);
      else agents.sort((x, y) => y.bonus - x.bonus || y.confirmed_count - x.confirmed_count || y.avg_order_value - x.avg_order_value);
      const ranked = agents.map((a, i) => ({ ...a, rank: i + 1 }));

      return json({
        generated_at: new Date().toISOString(), mode, day, today, is_today: isToday,
        target: topTarget, team_revenue: teamRevenue, team_target_pct: teamTargetPct, team_target_bonus: teamTargetBonus,
        agents: ranked,
      });
    }

    // Verify auth using getClaims for signing-keys compatibility
    const token = (authHeader || "").replace("Bearer ", "");
    if (!token) {
      return json({ error: "Unauthorized" }, 401);
    }
    const { data: claimsData, error: authError } = await supabase.auth.getClaims(token);
    if (authError || !claimsData?.claims) {
      return json({ error: "Unauthorized" }, 401);
    }
    const user = { id: claimsData.claims.sub as string, email: (claimsData.claims.email as string) || "" };

    // Get user roles (support multiple roles)
    const { data: roleRows } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    const roles = (roleRows || []).map((r: any) => r.role);
    const isAdmin = roles.includes("admin");
    const isManager = roles.includes("manager");
    const isAgent = roles.includes("agent") || roles.includes("pending_agent") || roles.includes("prediction_agent") || roles.includes("inbound_agent");
    const isWarehouse = roles.includes("warehouse");
    const isAdsAdmin = roles.includes("ads_admin");
    const isAdminOrManager = isAdmin || isManager;
    const isInboundAgent = roles.includes("inbound_agent");
    const isAffiliate = roles.includes("affiliate");
    const isDualRole = isAdmin && isAgent;

    // HARD WALL for external identities: a login whose ONLY role is
    // 'affiliate' is a partner, not staff — it may touch nothing but the
    // affiliate portal surface (plus GET /me). Without this, generic
    // authenticated list routes (products, call-scripts, …) would answer an
    // affiliate login with internal data.
    const hasInternalRole = roles.some((r: string) => r !== "affiliate");
    if (isAffiliate && !hasInternalRole && segments[0] !== "affiliate" && path !== "me") {
      return json({ error: "Forbidden" }, 403);
    }

    // The edge function now ENFORCES the same role_permissions + role_privacy that
    // the Settings UI writes (it used to be frontend-only). Admin-first, fail-safe
    // deny. Two tiny indexed lookups, same cost profile as the user_roles fetch.
    const [rpRes, privRes] = await Promise.all([
      adminClient.from("role_permissions").select("module_key, can_view, can_edit").in("role", roles.length ? roles : ["__none__"]),
      adminClient.from("role_privacy").select("show_customer_phone, show_customer_name, show_customer_address, show_order_history, show_segment_members, can_hear_recordings, can_hear_own_recordings").in("role", roles.length ? roles : ["__none__"]),
    ]);
    const rpRows = rpRes.data || [];
    const privRows = privRes.data || [];
    const canViewModule = (m: string) => isAdmin || rpRows.some((r: any) => r.module_key === m && r.can_view);
    const canEditModule = (m: string) => isAdmin || rpRows.some((r: any) => r.module_key === m && r.can_edit);
    // Operational roles keep their existing order-write access (RLS scopes them);
    // managers/ads_admin are read-only unless the orders.can_edit toggle is on.
    const canMutateOrders = isAdmin || isAgent || isWarehouse || canEditModule("orders");
    // Ownership guard shared by the order-mutating routes that write via adminClient
    // (RLS-bypassing). Open orders — including 'duplicated' since 2026-08-13 — are
    // workable by any agent (operator rules 2026-08-10/13); anything past confirm
    // stays locked to its assignee. Returns true when the caller must be blocked.
    //
    // This REPLACES the implicit gate those routes used to get from RLS: an agent's
    // RLS only matches orders assigned to them, which silently hid every unassigned
    // duplicate and made the modal save fail with "Operation failed".
    const OPEN_ORDER_STATES = ["pending", "take", "call_again", "duplicated"];
    const orderOwnershipBlocked = (order: { status: string; assigned_agent_id: string | null }) =>
      !isAdminOrManager && !isWarehouse
      && !OPEN_ORDER_STATES.includes(order.status)
      && !!order.assigned_agent_id && order.assigned_agent_id !== user.id;
    const privCan = (flag: string) => isAdmin || privRows.some((r: any) => r[flag] === true);
    const piiFlags: PiiFlags = { name: privCan("show_customer_name"), phone: privCan("show_customer_phone"), addr: privCan("show_customer_address") };
    const showOrderHistory = privCan("show_order_history");
    const showSegmentMembers = privCan("show_segment_members");
    const canHearRecordings = privCan("can_hear_recordings");          // hear ALL recordings (admin/manager/inbound_agent)
    const canHearOwnRecordings = privCan("can_hear_own_recordings");   // hear ONLY recordings attached to your own calls

    // ============================================================
    // ROUTING
    // ============================================================

    // ── ALTERCPA BRIDGE ──────────────────────────────────────────────
    // Read-only mirror of an AlterCPA account. Leads keep arriving there; this
    // pulls them in so the CRM is one place. Nothing is ever sent back — see
    // migration 20260914000000.
    //
    // Same split as the affiliates admin below: view = admin/manager,
    // mutations = admin only. The account row carries the NAME of a function
    // secret, never a token, so there is no credential to mask here.

    if (req.method === "GET" && path === "altercpa/accounts") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { data, error } = await adminClient
        .from("altercpa_accounts").select("*").order("name");
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Tell the operator whether each account's secret is actually present.
      // "Configured but the secret was never set" is the single most likely
      // reason for a bridge that reports success and imports nothing.
      const out = (data || []).map((a: any) => ({
        ...a,
        token_present: !!Deno.env.get(a.token_secret_name),
      }));
      return json(out);
    }

    if (req.method === "POST" && path === "altercpa/accounts") {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      let body: z.infer<typeof altercpaAccountSchema>;
      try { body = parseBody(altercpaAccountSchema, await req.json()); }
      catch (e: any) { return json({ error: e.message }, 400); }
      const { data, error } = await adminClient.from("altercpa_accounts").insert({
        name: body.name,
        api_base: body.api_base ?? "https://api.cpa.moe",
        token_secret_name: body.token_secret_name,
        callable_geos: (body.callable_geos ?? ["MK"]).map((g) => g.toUpperCase()),
        status_mirror: body.status_mirror ?? "off",
        import_scope: body.import_scope ?? "pending_only",
        sync_from: body.sync_from ?? null,
        is_active: body.is_active ?? true,
        notes: body.notes ?? null,
      }).select("*").single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // GET /api/altercpa/daily-rates?from&to — the 30% guarantee tracker.
    //
    // Every Macedonian lead an affiliate sent, bucketed by ARRIVAL day
    // (00:00-00:00 Europe/Skopje), against how many ever got confirmed. The
    // denominator deliberately includes trashed, cancelled, unmapped and
    // never-promoted leads: the affiliate sent them, so they count.
    //
    // Rows with offer_name = null are the AFFILIATE TOTAL for that day — the
    // number the deal is judged on. Rows with an offer_name are the per-offer
    // split, for diagnosis only: 20 of the 31 affiliate x offer pairs get under
    // 12 leads a WEEK, so judging at that grain would alarm off two leads.
    if (req.method === "GET" && segments[0] === "altercpa" && segments[1] === "daily-rates" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const qp = url.searchParams;
      const today = new Date();
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
      const to = DATE_RE.test(qp.get("to") || "") ? qp.get("to")! : iso(today);
      const defFrom = new Date(today); defFrom.setDate(defFrom.getDate() - 13);
      let from = DATE_RE.test(qp.get("from") || "") ? qp.get("from")! : iso(defFrom);
      // Cap the span: this scans the ledger and the sticky-confirm lookup is
      // per lead. 92 days is the same ceiling the BG original uses.
      if ((Date.parse(to) - Date.parse(from)) / 86400000 > 92) {
        const capped = new Date(Date.parse(to) - 92 * 86400000);
        from = iso(capped);
      }

      const [ratesRes, settingsRes] = await Promise.all([
        adminClient.rpc("altercpa_daily_rates", { _from: from, _to: to }),
        adminClient.from("app_settings").select("key, value")
          .in("key", ["altercpa_rate_target_pct", "altercpa_rate_milestone_step",
                      "altercpa_rate_min_cohort", "altercpa_rate_settle_days", "altercpa_rate_geo"]),
      ]);
      if (ratesRes.error) return json({ error: sanitizeDbError(ratesRes.error) }, 400);

      const setting = (k: string, d: any) => {
        const row = (settingsRes.data || []).find((s: any) => s.key === k);
        return row?.value ?? d;
      };
      const rows = (ratesRes.data || []) as any[];
      return json({
        from, to,
        target_pct: Number(setting("altercpa_rate_target_pct", 30)),
        milestone_step: Number(setting("altercpa_rate_milestone_step", 10)),
        min_cohort: Number(setting("altercpa_rate_min_cohort", 20)),
        settle_days: Number(setting("altercpa_rate_settle_days", 3)),
        geo: String(setting("altercpa_rate_geo", "MK")).replace(/"/g, ""),
        totals: rows.filter((r) => r.offer_name === null),
        by_offer: rows.filter((r) => r.offer_name !== null),
      });
    }

    if (req.method === "PATCH" && segments[0] === "altercpa" && segments[1] === "accounts" && segments.length === 3) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      let body: z.infer<typeof altercpaAccountPatchSchema>;
      try { body = parseBody(altercpaAccountPatchSchema, await req.json()); }
      catch (e: any) { return json({ error: e.message }, 400); }
      const update: Record<string, unknown> = {};
      for (const k of ["name", "api_base", "token_secret_name", "status_mirror", "import_scope", "sync_from", "is_active", "notes"] as const) {
        if (body[k] !== undefined) update[k] = body[k];
      }
      if (body.callable_geos !== undefined) {
        update.callable_geos = body.callable_geos.map((g) => g.toUpperCase());
      }
      if (!Object.keys(update).length) return json({ error: "Nothing to update" }, 400);
      const { data, error } = await adminClient
        .from("altercpa_accounts").update(update).eq("id", segments[2]).select("*").single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // The mirror. This is the multi-country report: every geo, every offer,
    // every webmaster — including the traffic we deliberately do not call.
    if (req.method === "GET" && path.startsWith("altercpa/leads")) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const p = url.searchParams;
      const limit = Math.min(Math.max(Number(p.get("limit")) || 50, 1), 200);
      const page = Math.max(Number(p.get("page")) || 1, 1);

      let q = adminClient
        .from("altercpa_leads")
        .select("*, orders(display_id, status)", { count: "exact" });

      if (p.get("account_id")) q = q.eq("account_id", p.get("account_id"));
      if (p.get("geo")) q = q.eq("geo", (p.get("geo") || "").toUpperCase());
      if (p.get("offer")) q = q.eq("offer_name", p.get("offer"));
      if (p.get("webmaster")) q = q.eq("webmaster", p.get("webmaster"));
      if (p.get("phase")) q = q.eq("phase", Number(p.get("phase")));
      // 'mirrored' and 'none' are the two the operator actually asks for:
      // "what did we NOT take" and "what did we take".
      const skip = p.get("skip");
      if (skip === "none") q = q.is("skip_reason", null);
      else if (skip) q = q.eq("skip_reason", skip);
      if (p.get("from")) q = q.gte("created_remote", p.get("from"));
      if (p.get("to")) q = q.lte("created_remote", p.get("to"));
      const search = (p.get("q") || "").trim();
      if (search) {
        const digits = search.replace(/\D/g, "");
        // Last-8 on the RAW phone: these numbers are multi-country and were
        // never normalized, so a prefix match would find nothing.
        if (digits.length >= 6) q = q.ilike("phone_raw", `%${digits.slice(-8)}%`);
        else q = q.ilike("customer_name", `%${search}%`);
      }

      const { data, error, count } = await q
        .order("created_remote", { ascending: false, nullsFirst: false })
        .range((page - 1) * limit, page * limit - 1);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ rows: data || [], total: count ?? 0, page, limit });
    }

    // Rollups for the mirror header — by geo, by offer, by webmaster. Done as
    // an RPC because 80k+ rows must not be pulled into the function to be
    // counted.
    if (req.method === "GET" && path.startsWith("altercpa/summary")) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { data, error } = await adminClient.rpc("altercpa_summary", {
        _account_id: url.searchParams.get("account_id") || null,
        _from: url.searchParams.get("from") || null,
        _to: url.searchParams.get("to") || null,
      });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data ?? { geos: [], offers: [], webmasters: [], totals: {} });
    }

    // The offer→product queue. Everything AlterCPA has ever sent us, with the
    // ones still awaiting a product first — those are the actionable ones.
    if (req.method === "GET" && path.startsWith("altercpa/offer-map")) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let q = adminClient
        .from("altercpa_offer_map")
        .select("*, products(id, name, price, sku)");
      if (url.searchParams.get("account_id")) q = q.eq("account_id", url.searchParams.get("account_id"));
      if (url.searchParams.get("unmapped") === "1") q = q.is("product_id", null).eq("is_ignored", false);
      if (url.searchParams.get("geo")) q = q.eq("geo", (url.searchParams.get("geo") || "").toUpperCase());
      const { data, error } = await q
        .order("is_mapped", { ascending: true })
        .order("seen_count", { ascending: false });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    if (req.method === "PATCH" && segments[0] === "altercpa" && segments[1] === "offer-map" && segments.length === 3) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      let body: z.infer<typeof altercpaOfferMapPatchSchema>;
      try { body = parseBody(altercpaOfferMapPatchSchema, await req.json()); }
      catch (e: any) { return json({ error: e.message }, 400); }
      const update: Record<string, unknown> = {};
      if (body.product_id !== undefined) {
        update.product_id = body.product_id;
        update.mapped_by = user.id;
        update.mapped_at = new Date().toISOString();
      }
      if (body.offer_id !== undefined) update.offer_id = body.offer_id;
      if (body.is_ignored !== undefined) update.is_ignored = body.is_ignored;
      if (body.notes !== undefined) update.notes = body.notes;
      if (!Object.keys(update).length) return json({ error: "Nothing to update" }, 400);

      const { data, error } = await adminClient
        .from("altercpa_offer_map").update(update).eq("id", segments[2])
        .select("*, products(id, name, price, sku)").single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Newly mapped: link the leads already sitting in the ledger for it, so
      // mapping an offer does not silently apply "from now on" only. The ORDERS
      // are deliberately NOT created retroactively here — that can be thousands
      // of rows and belongs in an explicit backfill the operator triggers.
      if (body.product_id) {
        await adminClient
          .from("altercpa_leads")
          .update({ product_id: body.product_id })
          .eq("account_id", (data as any).account_id)
          .eq("geo", (data as any).geo)
          .ilike("offer_name", (data as any).offer_name)
          .is("product_id", null);
      }
      return json(data);
    }

    if (req.method === "GET" && path.startsWith("altercpa/runs")) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let q = adminClient.from("altercpa_sync_runs").select("*, altercpa_accounts(name)");
      if (url.searchParams.get("account_id")) q = q.eq("account_id", url.searchParams.get("account_id"));
      const { data, error } = await q
        .order("started_at", { ascending: false })
        .limit(Math.min(Number(url.searchParams.get("limit")) || 50, 200));
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    // Fire a sync by hand: the dry run, and backfills.
    if (req.method === "POST" && path === "altercpa/sync") {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      if (!checkUserRateLimit(user.id, "altercpa.sync", 20)) return json({ error: "Too many requests" }, 429);
      let body: z.infer<typeof altercpaSyncSchema>;
      try { body = parseBody(altercpaSyncSchema, await req.json()); }
      catch (e: any) { return json({ error: e.message }, 400); }

      const secret = Deno.env.get("ALTERCPA_SYNC_SECRET");
      if (!secret) return json({ error: "ALTERCPA_SYNC_SECRET is not set on this project" }, 503);

      // A backfill can run for minutes; the browser must not hold the request
      // open that long. Dry runs are bounded and worth waiting for.
      const timeoutMs = body.dry ? 60_000 : 300_000;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/altercpa-sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-altercpa-sync-secret": secret },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        return json(await res.json(), res.ok ? 200 : 502);
      } catch (e: any) {
        return json({ error: e?.name === "AbortError" ? "Sync is still running — check the Runs tab" : String(e?.message || e) }, 504);
      } finally {
        clearTimeout(timer);
      }
    }

    // ── AFFILIATES ADMIN ─────────────────────────────────────────────
    // View = admin/manager; ALL mutations = admin-only (operator decision
    // 2026-07-09: managers are read-only here — keys, payouts and offers are
    // money/credential surfaces). The public intake lives at /cpa/* above the
    // auth gate; the affiliate's own portal endpoints arrive in Increment 5.

    // List affiliates + per-affiliate lead/payout rollups + postback health.
    if (req.method === "GET" && path === "affiliates") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { data: affs, error } = await adminClient
        .from("affiliates")
        .select("id, user_id, code, name, contact, api_key, status, postback_url, postback_enabled, postback_events, postback_format, notes, created_at, updated_at")
        .order("created_at", { ascending: false });
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      const { data: leadRows } = await adminClient
        .from("affiliate_leads")
        .select("affiliate_id, payout_eur_snapshot, orders(status, confirmed_at)");
      const blankStats = () =>
        ({ sent: 0, wait: 0, approved: 0, paid: 0, cancelled: 0, trashed: 0, payout_earned: 0 });
      const agg = new Map<string, any>();
      for (const l of (leadRows || []) as any[]) {
        const a = agg.get(l.affiliate_id) || blankStats();
        a.sent++;
        const o = l.orders;
        const p = Number(l.payout_eur_snapshot) || 0;
        // Earned first and unconditionally: once confirmed, a later cancel or
        // trash must not move the lead back into a pre-confirm bucket.
        if (affiliateEarned(o)) {
          a.approved++;
          a.payout_earned += p;
          if (o?.status === "paid") a.paid++;
        } else if (o && AFFILIATE_WAIT_STATUSES.includes(o.status)) a.wait++;
        else if (o?.status === "cancelled") a.cancelled++;
        else if (o?.status === "trashed") a.trashed++;
        agg.set(l.affiliate_id, a);
      }
      const { data: pbRows } = await adminClient
        .from("affiliate_postbacks").select("affiliate_id, status").in("status", ["pending", "failed"]);
      const pbAgg = new Map<string, { pending: number; failed: number }>();
      for (const r of (pbRows || []) as any[]) {
        const x = pbAgg.get(r.affiliate_id) || { pending: 0, failed: 0 };
        if (r.status === "pending") x.pending++;
        if (r.status === "failed") x.failed++;
        pbAgg.set(r.affiliate_id, x);
      }
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const out = (affs || []).map((a: any) => {
        const s = agg.get(a.id) || blankStats();
        s.payout_earned = round2(s.payout_earned);
        return {
          ...a,
          // Managers see the program, never the credentials.
          api_key: isAdmin ? a.api_key : undefined,
          // hold/payout_hold are transitional zeros so an SPA bundle from
          // before this deploy renders €0.00 instead of NaN. Drop next release.
          stats: { ...s, hold: 0, payout_hold: 0 },
          postbacks: pbAgg.get(a.id) || { pending: 0, failed: 0 },
        };
      });
      return json(out);
    }

    // Create affiliate (+ optional portal login with the 'affiliate' role).
    if (req.method === "POST" && path === "affiliates") {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      if (!checkUserRateLimit(user.id, "affiliates.create", 10)) return json({ error: "Too many requests" }, 429);
      let body;
      try { body = parseBody(createAffiliateSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const apiKey = "aff_" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");

      let linkedUserId: string | null = null;
      if (body.create_login) {
        const { data: created, error: cuErr } = await adminClient.auth.admin.createUser({
          email: body.create_login.email,
          password: body.create_login.password,
          email_confirm: true,
        });
        if (cuErr || !created?.user) return json({ error: cuErr ? sanitizeDbError(cuErr) : "Could not create login" }, 400);
        linkedUserId = created.user.id;
        const { error: roleErr } = await adminClient.from("user_roles")
          .insert({ user_id: linkedUserId, role: "affiliate" });
        if (roleErr) {
          await adminClient.auth.admin.deleteUser(linkedUserId);
          return json({ error: sanitizeDbError(roleErr) }, 400);
        }
        // profiles row is auto-created by handle_new_user(); stamp the display name.
        await adminClient.from("profiles").update({ full_name: body.name }).eq("user_id", linkedUserId);
      }

      const { data: aff, error } = await adminClient.from("affiliates").insert({
        name: body.name,
        code: body.code,
        contact: body.contact || null,
        notes: body.notes || null,
        api_key: apiKey,
        user_id: linkedUserId,
      }).select().single();
      if (error) {
        // Don't leave an orphan login if the affiliate row failed (dup code etc.).
        if (linkedUserId) await adminClient.auth.admin.deleteUser(linkedUserId);
        return json({ error: sanitizeDbError(error) }, 400);
      }
      await audit(adminClient, user.id, user.email, "affiliate.create", {
        target_type: "affiliate", target_id: aff.id,
        payload: { code: body.code, with_login: !!body.create_login },
      });
      return json(aff);
    }

    // Update affiliate fields / status / postback config.
    if (req.method === "PATCH" && segments[0] === "affiliates" && segments.length === 2 && UUID_RE.test(segments[1])) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      if (!checkUserRateLimit(user.id, "affiliates.update", 30)) return json({ error: "Too many requests" }, 429);
      let body;
      try { body = parseBody(updateAffiliateSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      if (body.postback_url && !isSafePostbackUrl(body.postback_url)) {
        return json({ error: "Postback URL must be a public http(s) address" }, 400);
      }
      const update: Record<string, unknown> = {};
      for (
        const k of [
          "name", "contact", "notes", "status", "postback_url", "postback_enabled",
          "postback_events", "postback_format", "altercpa_reason_map",
        ] as const
      ) {
        if (body[k] !== undefined) update[k] = body[k];
      }
      if (!Object.keys(update).length) return json({ error: "Nothing to update" }, 400);
      const { data: aff, error } = await adminClient.from("affiliates")
        .update(update).eq("id", segments[1]).select().single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      await audit(adminClient, user.id, user.email, "affiliate.update", {
        target_type: "affiliate", target_id: segments[1], payload: { fields: Object.keys(update) },
      });
      return json(aff);
    }

    // Rotate the S2S api key. Returned once; old key dies immediately.
    if (req.method === "POST" && segments[0] === "affiliates" && segments[2] === "rotate-key" && segments.length === 3) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      if (!checkUserRateLimit(user.id, "affiliates.rotate", 10)) return json({ error: "Too many requests" }, 429);
      if (!UUID_RE.test(segments[1])) return json({ error: "Invalid id" }, 400);
      const apiKey = "aff_" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      const { error } = await adminClient.from("affiliates")
        .update({ api_key: apiKey }).eq("id", segments[1]);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      await audit(adminClient, user.id, user.email, "affiliate.rotate_key", {
        target_type: "affiliate", target_id: segments[1],
      });
      return json({ api_key: apiKey });
    }

    // Per-affiliate stats: totals + per-day series in [from, to] (default 30d).
    if (req.method === "GET" && segments[0] === "affiliates" && segments[2] === "stats" && segments.length === 3) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      if (!UUID_RE.test(segments[1])) return json({ error: "Invalid id" }, 400);
      const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
      const from = url.searchParams.get("from") ||
        new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
      const { data: rows, error } = await adminClient
        .from("affiliate_leads")
        .select("created_at, payout_eur_snapshot, orders(status, confirmed_at, customer_name, price)")
        .eq("affiliate_id", segments[1])
        .gte("created_at", `${from}T00:00:00Z`)
        .lte("created_at", `${to}T23:59:59Z`);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      const totals = { sent: 0, wait: 0, approved: 0, paid: 0, cancelled: 0, trashed: 0, payout_earned: 0 };
      const days = new Map<string, any>();
      // Staff-only super-metrics: raw CURRENT-status funnel + test counters.
      // These never go on the portal twin (GET /affiliate/stats) — internal
      // funnel detail (call_again load, test hygiene) is not for webmasters.
      const statuses: Record<string, number> = {};
      const TEST_NAME_RE = /test|тест/i; // heuristic: no test-lead flag exists in the schema
      let testLeads = 0;
      // Selling side (staff-only): what the CONFIRMED orders were sold for —
      // orders.price is the order total the agent settled at confirm (incl.
      // upsold quantities), so avg = confirmed revenue / confirmed count.
      let approvedRevenue = 0;
      for (const l of (rows || []) as any[]) {
        const day = String(l.created_at).slice(0, 10);
        const d = days.get(day) || { date: day, sent: 0, wait: 0, approved: 0, paid: 0, cancelled: 0, trashed: 0 };
        d.sent++; totals.sent++;
        const o = l.orders;
        const p = Number(l.payout_eur_snapshot) || 0;
        if (o?.status) statuses[o.status] = (statuses[o.status] || 0) + 1;
        if (o?.customer_name && TEST_NAME_RE.test(String(o.customer_name))) testLeads++;
        if (affiliateEarned(o)) {
          d.approved++; totals.approved++; totals.payout_earned += p;
          approvedRevenue += Number(o?.price) || 0;
          if (o?.status === "paid") { d.paid++; totals.paid++; }
        } else if (o && AFFILIATE_WAIT_STATUSES.includes(o.status)) { d.wait++; totals.wait++; }
        else if (o?.status === "cancelled") { d.cancelled++; totals.cancelled++; }
        else if (o?.status === "trashed") { d.trashed++; totals.trashed++; }
        days.set(day, d);
      }
      totals.payout_earned = Math.round(totals.payout_earned * 100) / 100;
      const { count: postbackTests } = await adminClient
        .from("affiliate_postbacks")
        .select("id", { count: "exact", head: true })
        .eq("affiliate_id", segments[1])
        .eq("event", "test")
        .gte("created_at", `${from}T00:00:00Z`)
        .lte("created_at", `${to}T23:59:59Z`);
      return json({
        // hold/payout_hold are transitional zeros for pre-deploy SPA bundles —
        // drop next release.
        totals: { ...totals, hold: 0, payout_hold: 0 },
        days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
        statuses,
        tests: { test_leads: testLeads, postback_tests: postbackTests || 0 },
        revenue: {
          confirmed_eur: Math.round(approvedRevenue * 100) / 100,
          avg_confirmed_eur: totals.approved > 0 ? Math.round((approvedRevenue / totals.approved) * 100) / 100 : 0,
        },
        from,
        to,
      });
    }

    // GET /affiliates/:id/leads?page&limit&stage&from&to — staff view of one
    // affiliate's leads: same display-stage semantics as the portal, plus
    // role-privacy-governed customer PII, the CRM order linkage (display_id +
    // real status + confirmed_at) and an optional date range. STAFF-ONLY
    // fields — never copy this select into affiliate/* or /cpa/* routes
    // (orders.display_id is banned anywhere a partner can see it).
    if (req.method === "GET" && segments[0] === "affiliates" && segments[2] === "leads" && segments.length === 3) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      if (!UUID_RE.test(segments[1])) return json({ error: "Invalid id" }, 400);
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));
      const stageFilter = url.searchParams.get("stage") || "";
      const fromDay = url.searchParams.get("from");
      const toDay = url.searchParams.get("to");
      const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
      let q = adminClient
        .from("affiliate_leads")
        .select("id, ext_id, clickid, sub1, sub2, sub3, sub4, sub5, payout_eur_snapshot, created_at, order_id, offers(name), orders!inner(status, confirmed_at, display_id, customer_name, customer_phone, cancellation_reason, trash_reason)", { count: "exact" })
        .eq("affiliate_id", segments[1])
        .order("created_at", { ascending: false })
        .range((page - 1) * limit, page * limit - 1);
      if (fromDay && DAY_RE.test(fromDay)) q = q.gte("created_at", `${fromDay}T00:00:00Z`);
      if (toDay && DAY_RE.test(toDay)) q = q.lte("created_at", `${toDay}T23:59:59Z`);
      q = applyAffiliateStageFilter(q, stageFilter);
      const { data, error, count } = await q;
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      const rows = (data || []).map((l: any) => {
        const stage = affiliateDisplayStage(l.orders);
        const red = redactCustomer(l.orders, piiFlags);
        return {
          id: l.id,
          ext_id: l.ext_id,
          clickid: l.clickid,
          sub1: l.sub1, sub2: l.sub2, sub3: l.sub3, sub4: l.sub4, sub5: l.sub5,
          offer_name: l.offers?.name ?? null,
          payout_eur: Number(l.payout_eur_snapshot) || 0,
          created_at: l.created_at,
          stage,
          reason: ["cancel", "trash"].includes(stage)
            ? (l.orders?.cancellation_reason || l.orders?.trash_reason || null)
            : null,
          customer_name: red?.customer_name ?? null,
          customer_phone: red?.customer_phone ?? null,
          order_id: l.order_id ?? null,
          display_id: l.orders?.display_id ?? null,
          order_status: l.orders?.status ?? null,
          confirmed_at: l.orders?.confirmed_at ?? null,
        };
      });
      return json({ rows, total: count || 0, page, limit });
    }

    // Approvals for one affiliate (offers embed for display).
    if (req.method === "GET" && segments[0] === "affiliates" && segments[2] === "offers" && segments.length === 3) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      if (!UUID_RE.test(segments[1])) return json({ error: "Invalid id" }, 400);
      const { data, error } = await adminClient
        .from("affiliate_offers")
        .select("id, affiliate_id, offer_id, status, payout_override_eur, created_at, offers(id, name, geo, payout_eur, is_active)")
        .eq("affiliate_id", segments[1])
        .order("created_at", { ascending: false });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    // Approve an offer for an affiliate (upsert; optional payout override).
    if (req.method === "POST" && segments[0] === "affiliates" && segments[2] === "offers" && segments.length === 3) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      if (!checkUserRateLimit(user.id, "affiliates.approve", 30)) return json({ error: "Too many requests" }, 429);
      if (!UUID_RE.test(segments[1])) return json({ error: "Invalid id" }, 400);
      let body;
      try { body = parseBody(approveAffiliateOfferSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const { data, error } = await adminClient.from("affiliate_offers").upsert({
        affiliate_id: segments[1],
        offer_id: body.offer_id,
        status: "approved",
        payout_override_eur: body.payout_override_eur ?? null,
      }, { onConflict: "affiliate_id,offer_id" }).select().single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      await audit(adminClient, user.id, user.email, "affiliate.offer_approve", {
        target_type: "affiliate", target_id: segments[1], payload: { offer_id: body.offer_id },
      });
      return json(data);
    }

    // Pause / edit override on an approval.
    if (req.method === "PATCH" && segments[0] === "affiliate-offers" && segments.length === 2 && UUID_RE.test(segments[1])) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      let body;
      try { body = parseBody(updateAffiliateOfferSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const update: Record<string, unknown> = {};
      if (body.status !== undefined) update.status = body.status;
      if (body.payout_override_eur !== undefined) update.payout_override_eur = body.payout_override_eur;
      if (!Object.keys(update).length) return json({ error: "Nothing to update" }, 400);
      const { data, error } = await adminClient.from("affiliate_offers")
        .update(update).eq("id", segments[1]).select().single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      await audit(adminClient, user.id, user.email, "affiliate.offer_update", {
        target_type: "affiliate_offer", target_id: segments[1], payload: update,
      });
      return json(data);
    }

    // Revoke an approval entirely (affiliate loses the offer).
    if (req.method === "DELETE" && segments[0] === "affiliate-offers" && segments.length === 2 && UUID_RE.test(segments[1])) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      const { error } = await adminClient.from("affiliate_offers").delete().eq("id", segments[1]);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      await audit(adminClient, user.id, user.email, "affiliate.offer_revoke", {
        target_type: "affiliate_offer", target_id: segments[1],
      });
      return json({ success: true });
    }

    // Offers catalogue (admin view; product embed for the picker/labels).
    if (req.method === "GET" && path === "offers") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { data, error } = await adminClient
        .from("offers")
        .select("id, product_id, name, geo, payout_eur, price_eur, is_active, description, terms, created_at, updated_at, products(name, price)")
        .order("created_at", { ascending: false });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    // Create / edit offers. No DELETE — retire with is_active=false (leads
    // keep referencing historical offers).
    if (req.method === "POST" && path === "offers") {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      if (!checkUserRateLimit(user.id, "offers.create", 20)) return json({ error: "Too many requests" }, 429);
      let body;
      try { body = parseBody(offerCreateSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const { data, error } = await adminClient.from("offers").insert({
        name: body.name,
        product_id: body.product_id ?? null,
        geo: (body.geo || "MK").toUpperCase(),
        payout_eur: body.payout_eur,
        price_eur: body.price_eur ?? null,
        description: body.description || null,
        terms: body.terms || null,
        is_active: body.is_active,
      }).select("*, products(name, price)").single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      await audit(adminClient, user.id, user.email, "offer.create", {
        target_type: "offer", target_id: data.id, payload: { name: body.name, payout_eur: body.payout_eur },
      });
      return json(data);
    }

    if (req.method === "PATCH" && segments[0] === "offers" && segments.length === 2 && UUID_RE.test(segments[1])) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      if (!checkUserRateLimit(user.id, "offers.update", 30)) return json({ error: "Too many requests" }, 429);
      let body;
      try { body = parseBody(offerUpdateSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const update: Record<string, unknown> = {};
      for (const k of ["name", "product_id", "geo", "payout_eur", "price_eur", "description", "terms", "is_active"] as const) {
        if (body[k] !== undefined) update[k] = body[k];
      }
      if (!Object.keys(update).length) return json({ error: "Nothing to update" }, 400);
      const { data, error } = await adminClient.from("offers")
        .update(update).eq("id", segments[1]).select("*, products(name, price)").single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      await audit(adminClient, user.id, user.email, "offer.update", {
        target_type: "offer", target_id: segments[1], payload: { fields: Object.keys(update) },
      });
      return json(data);
    }

    // Postback delivery log (paginated, filterable).
    if (req.method === "GET" && path === "affiliate-postbacks") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));
      let q = adminClient
        .from("affiliate_postbacks")
        // last_response_body is REQUIRED here: partners answer HTTP 200 with
        // the real verdict in the body, so without it the log shows a green
        // "delivered" for calls the partner actually rejected.
        .select("id, affiliate_id, affiliate_lead_id, order_id, event, reason, status, attempts, next_attempt_at, rendered_url, last_response_code, last_response_body, last_error, created_at, delivered_at, affiliates(code, name), affiliate_leads(ext_id, clickid)", { count: "exact" })
        .order("created_at", { ascending: false })
        .range((page - 1) * limit, page * limit - 1);
      const fAff = url.searchParams.get("affiliate_id");
      const fStatus = url.searchParams.get("status");
      const fEvent = url.searchParams.get("event");
      if (fAff && UUID_RE.test(fAff)) q = q.eq("affiliate_id", fAff);
      if (fStatus && ["pending", "delivered", "failed", "skipped"].includes(fStatus)) q = q.eq("status", fStatus);
      if (fEvent && ["lead", "hold", "approve", "cancel", "trash", "return", "test"].includes(fEvent)) q = q.eq("event", fEvent);
      const { data, error, count } = await q;
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ rows: data || [], total: count || 0, page, limit });
    }

    // Re-queue one postback (any state) and nudge delivery.
    if (req.method === "POST" && segments[0] === "affiliate-postbacks" && segments[2] === "retry" && segments.length === 3) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      if (!UUID_RE.test(segments[1])) return json({ error: "Invalid id" }, 400);
      const { error } = await adminClient.from("affiliate_postbacks").update({
        status: "pending", attempts: 0, next_attempt_at: new Date().toISOString(), last_error: null,
      }).eq("id", segments[1]);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      await audit(adminClient, user.id, user.email, "postback.retry", {
        target_type: "affiliate_postback", target_id: segments[1],
      });
      nudgePostbackDrain(adminClient);
      return json({ success: true });
    }

    // Manual "Process now" — drains inline and returns counters.
    if (req.method === "POST" && path === "affiliate-postbacks/process-now") {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      if (!checkUserRateLimit(user.id, "postbacks.process", 10)) return json({ error: "Too many requests" }, 429);
      const started = Date.now();
      const totals = { claimed: 0, delivered: 0, retried: 0, failed: 0, skipped: 0 };
      while (Date.now() - started < 15_000) {
        const r = await drainAffiliatePostbacks(adminClient, 20);
        totals.claimed += r.claimed;
        totals.delivered += r.delivered;
        totals.retried += r.retried;
        totals.failed += r.failed;
        totals.skipped += r.skipped;
        if (r.claimed === 0) break;
      }
      return json({ success: true, ...totals });
    }

    // ── AFFILIATE PORTAL (self-scoped) ───────────────────────────────
    // The webmaster's own view. Gate = the 'affiliate' role + a linked
    // affiliates row resolved from user.id server-side — NEVER from client
    // input. Admins may also hit these for support (they see their own linked
    // row, or 404). Exposes ONLY: own config, approved offers, own lead stages
    // (customer phone masked to last 4 — operator decision 2026-07-09), and
    // the postback trio. No agent identities, no internal statuses, no PII.
    if (segments[0] === "affiliate") {
      if (!isAffiliate && !isAdmin) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "affiliate.portal", 60)) return json({ error: "Too many requests" }, 429);
      const { data: myAff } = await adminClient
        .from("affiliates")
        .select("id, code, name, contact, status, api_key, postback_url, postback_enabled, postback_events, created_at")
        .eq("user_id", user.id)
        .maybeSingle();
      if (!myAff) return json({ error: "No affiliate account linked to this login" }, 404);

      // GET /affiliate/me — own config incl. the S2S key (it's their credential).
      if (req.method === "GET" && path === "affiliate/me") {
        return json(myAff);
      }

      // GET /affiliate/offers — approved + active offers with effective payout.
      if (req.method === "GET" && path === "affiliate/offers") {
        const { data: approvals, error } = await adminClient
          .from("affiliate_offers")
          .select("offer_id, status, payout_override_eur, offers(id, name, geo, payout_eur, description, terms, is_active, products(name))")
          .eq("affiliate_id", myAff.id)
          .eq("status", "approved");
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        const out = (approvals || [])
          .filter((a: any) => a.offers?.is_active)
          .map((a: any) => ({
            offer_id: a.offer_id,
            name: a.offers.name,
            geo: a.offers.geo,
            payout_eur: Number(a.payout_override_eur ?? a.offers.payout_eur) || 0,
            description: a.offers.description,
            terms: a.offers.terms,
            product_name: a.offers.products?.name ?? null,
          }));
        return json(out);
      }

      // GET /affiliate/stats?from&to — own totals + per-day series (default 30d).
      if (req.method === "GET" && path === "affiliate/stats") {
        const to = url.searchParams.get("to") || new Date().toISOString().slice(0, 10);
        const from = url.searchParams.get("from") ||
          new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
        const { data: rows, error } = await adminClient
          .from("affiliate_leads")
          .select("created_at, payout_eur_snapshot, orders(status, confirmed_at)")
          .eq("affiliate_id", myAff.id)
          .gte("created_at", `${from}T00:00:00Z`)
          .lte("created_at", `${to}T23:59:59Z`);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        const totals = { sent: 0, wait: 0, approved: 0, paid: 0, cancelled: 0, trashed: 0, payout_earned: 0 };
        const days = new Map<string, any>();
        for (const l of (rows || []) as any[]) {
          const day = String(l.created_at).slice(0, 10);
          const d = days.get(day) || { date: day, sent: 0, wait: 0, approved: 0, paid: 0, cancelled: 0, trashed: 0 };
          d.sent++; totals.sent++;
          const o = l.orders;
          const p = Number(l.payout_eur_snapshot) || 0;
          if (affiliateEarned(o)) {
            d.approved++; totals.approved++; totals.payout_earned += p;
            if (o?.status === "paid") { d.paid++; totals.paid++; }
          } else if (o && AFFILIATE_WAIT_STATUSES.includes(o.status)) { d.wait++; totals.wait++; }
          else if (o?.status === "cancelled") { d.cancelled++; totals.cancelled++; }
          else if (o?.status === "trashed") { d.trashed++; totals.trashed++; }
          days.set(day, d);
        }
        totals.payout_earned = Math.round(totals.payout_earned * 100) / 100;
        // No statuses/tests/revenue here — those are staff-only (see the admin
        // twin). hold/payout_hold are transitional zeros; drop next release.
        return json({
          totals: { ...totals, hold: 0, payout_hold: 0 },
          days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
          from,
          to,
        });
      }

      // GET /affiliate/leads?page&limit&stage&from&to — own leads, phone masked.
      // Stage here is PAYMENT truth (hold = "Approved", sticky), not CPA_STAGE.
      if (req.method === "GET" && path === "affiliate/leads") {
        const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 30));
        const stageFilter = url.searchParams.get("stage") || "";
        const fromDay = url.searchParams.get("from");
        const toDay = url.searchParams.get("to");
        const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
        let q = adminClient
          .from("affiliate_leads")
          .select("id, ext_id, clickid, sub1, sub2, sub3, sub4, sub5, payout_eur_snapshot, created_at, offers(name), orders!inner(status, confirmed_at, customer_name, customer_phone, cancellation_reason, trash_reason)", { count: "exact" })
          .eq("affiliate_id", myAff.id)
          .order("created_at", { ascending: false })
          .range((page - 1) * limit, page * limit - 1);
        if (fromDay && DAY_RE.test(fromDay)) q = q.gte("created_at", `${fromDay}T00:00:00Z`);
        if (toDay && DAY_RE.test(toDay)) q = q.lte("created_at", `${toDay}T23:59:59Z`);
        q = applyAffiliateStageFilter(q, stageFilter);
        const { data, error, count } = await q;
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        const rows = (data || []).map((l: any) => {
          const stage = affiliateDisplayStage(l.orders);
          const phone = String(l.orders?.customer_phone || "");
          return {
            id: l.id,
            ext_id: l.ext_id,
            clickid: l.clickid,
            sub1: l.sub1, sub2: l.sub2, sub3: l.sub3, sub4: l.sub4, sub5: l.sub5,
            offer_name: l.offers?.name ?? null,
            payout_eur: Number(l.payout_eur_snapshot) || 0,
            created_at: l.created_at,
            stage,
            // Only pre-confirm kills carry a reason. A return no longer has
            // one to show here: the payout was already earned, so from the
            // partner's side nothing was lost and there is nothing to explain.
            reason: ["cancel", "trash"].includes(stage)
              ? (l.orders?.cancellation_reason || l.orders?.trash_reason || null)
              : null,
            customer_name: l.orders?.customer_name ?? null,
            phone_masked: phone ? `••••${phone.replace(/\D/g, "").slice(-4)}` : null,
          };
        });
        return json({ rows, total: count || 0, page, limit });
      }

      // PATCH /affiliate/postback — self-service postback config only.
      if (req.method === "PATCH" && path === "affiliate/postback") {
        if (!checkUserRateLimit(user.id, "affiliate.postback", 10)) return json({ error: "Too many requests" }, 429);
        let body;
        try { body = parseBody(affiliateSelfPostbackSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
        if (body.postback_url && !isSafePostbackUrl(body.postback_url)) {
          return json({ error: "Postback URL must be a public http(s) address" }, 400);
        }
        const update: Record<string, unknown> = {};
        if (body.postback_url !== undefined) update.postback_url = body.postback_url || null;
        if (body.postback_enabled !== undefined) update.postback_enabled = body.postback_enabled;
        if (body.postback_events !== undefined) update.postback_events = body.postback_events;
        if (!Object.keys(update).length) return json({ error: "Nothing to update" }, 400);
        const { data, error } = await adminClient.from("affiliates")
          .update(update).eq("id", myAff.id)
          .select("postback_url, postback_enabled, postback_events").single();
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        await audit(adminClient, user.id, user.email, "affiliate.self_postback_update", {
          target_type: "affiliate", target_id: myAff.id, payload: { fields: Object.keys(update) },
        });
        return json(data);
      }

      // POST /affiliate/rotate-key — self-service key rotation.
      if (req.method === "POST" && path === "affiliate/rotate-key") {
        if (!checkUserRateLimit(user.id, "affiliate.rotate", 5)) return json({ error: "Too many requests" }, 429);
        const apiKey = "aff_" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map((b) => b.toString(16).padStart(2, "0")).join("");
        const { error } = await adminClient.from("affiliates")
          .update({ api_key: apiKey }).eq("id", myAff.id);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        await audit(adminClient, user.id, user.email, "affiliate.self_rotate_key", {
          target_type: "affiliate", target_id: myAff.id,
        });
        return json({ api_key: apiKey });
      }

      // POST /affiliate/postback-test — fire a 'test' event at their URL now
      // (bypasses postback_enabled so they can test BEFORE going live).
      if (req.method === "POST" && path === "affiliate/postback-test") {
        if (!checkUserRateLimit(user.id, "affiliate.pbtest", 10)) return json({ error: "Too many requests" }, 429);
        if (!myAff.postback_url) return json({ error: "Set a postback URL first" }, 400);
        // Attach the newest lead for realistic macros; synthetic values otherwise.
        const { data: lastLead } = await adminClient
          .from("affiliate_leads").select("id, order_id")
          .eq("affiliate_id", myAff.id)
          .order("created_at", { ascending: false })
          .limit(1).maybeSingle();
        const { data: row, error: insErr } = await adminClient
          .from("affiliate_postbacks")
          .insert({
            affiliate_id: myAff.id,
            affiliate_lead_id: lastLead?.id ?? null,
            order_id: lastLead?.order_id ?? null,
            event: "test",
          })
          .select("id").single();
        if (insErr || !row) return json({ error: insErr ? sanitizeDbError(insErr) : "Could not enqueue test" }, 400);
        // Drain until our row settles (it may not be in the first claim batch).
        for (let i = 0; i < 3; i++) {
          await drainAffiliatePostbacks(adminClient, 20);
          const { data: check } = await adminClient
            .from("affiliate_postbacks")
            .select("status").eq("id", row.id).maybeSingle();
          if (check && check.status !== "pending") break;
        }
        const { data: result } = await adminClient
          .from("affiliate_postbacks")
          .select("status, rendered_url, last_response_code, last_response_body, last_error")
          .eq("id", row.id).maybeSingle();
        return json(result || { status: "pending" });
      }

      // POST /affiliate/change-password — self-service password change for the
      // logged-in affiliate. Updates their own auth user; no CRM access widens.
      if (req.method === "POST" && path === "affiliate/change-password") {
        if (!checkUserRateLimit(user.id, "affiliate.password", 5)) return json({ error: "Too many requests" }, 429);
        let body;
        try { body = parseBody(affiliatePasswordSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
        const { error } = await adminClient.auth.admin.updateUserById(user.id, { password: body.new_password });
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        await audit(adminClient, user.id, user.email, "affiliate.change_password", {
          target_type: "affiliate", target_id: myAff.id,
        });
        return json({ success: true });
      }

      return json({ error: "Not found" }, 404);
    }

    // ── TV LEADERBOARD ADMIN (roster / bonus rules / access tokens) ──
    // Admin/manager only. The public board is the separate token-gated
    // GET /api/leaderboard handler above (before the auth gate).
    if (path === "leaderboard/admin" && req.method === "GET") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const mode = url.searchParams.get("mode") === "pending" ? "pending" : "prediction";
      const { day } = skopjeDayStart();
      const [rosterRes, rulesRes, tokRes] = await Promise.all([
        adminClient.from("leaderboard_roster").select("agent_id").eq("roster_date", day).eq("mode", mode),
        adminClient.from("leaderboard_bonus_rules").select("metric,tiers,is_active").eq("mode", mode).order("metric"),
        adminClient.from("leaderboard_access_tokens").select("id,label,token,is_active,created_at").order("created_at", { ascending: false }),
      ]);
      return json({
        mode, roster_date: day,
        roster: (rosterRes.data || []).map((r: any) => r.agent_id),
        rules: rulesRes.data || [],
        tokens: tokRes.data || [],
      });
    }

    if (path === "leaderboard/roster" && req.method === "POST") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let body: any; try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const mode = body?.mode === "pending" ? "pending" : "prediction";
      const ids: string[] = Array.isArray(body?.agent_ids) ? body.agent_ids.filter((x: any) => typeof x === "string") : [];
      const { day } = skopjeDayStart();
      await adminClient.from("leaderboard_roster").delete().eq("roster_date", day).eq("mode", mode);
      if (ids.length) {
        const rows = ids.map((agent_id) => ({ roster_date: day, mode, agent_id, added_by: user.id }));
        const { error } = await adminClient.from("leaderboard_roster").insert(rows);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
      }
      return json({ success: true, roster_date: day, mode, roster: ids });
    }

    if (path === "leaderboard/rules" && req.method === "POST") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let body: any; try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const mode = body?.mode === "pending" ? "pending" : "prediction";
      const metric = String(body?.metric || "");
      if (!["confirmed_count", "avg_order_value", "conversion_rate", "revenue_target"].includes(metric)) return json({ error: "Invalid metric" }, 400);
      const tiers = Array.isArray(body?.tiers)
        ? body.tiers.map((t: any) => ({ min: Number(t?.min) || 0, bonus: Number(t?.bonus) || 0 }))
        : [];
      const is_active = body?.is_active !== false;
      const { error } = await adminClient.from("leaderboard_bonus_rules")
        .upsert({ metric, mode, tiers, is_active, updated_at: new Date().toISOString(), updated_by: user.id }, { onConflict: "mode,metric" });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    if (path === "leaderboard/token" && req.method === "POST") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let body: any; try { body = await req.json(); } catch { body = {}; }
      const action = String(body?.action || "create");
      if (action === "revoke") {
        const id = String(body?.id || "");
        if (!id) return json({ error: "id required" }, 400);
        await adminClient.from("leaderboard_access_tokens").update({ is_active: false }).eq("id", id);
        return json({ success: true });
      }
      if (action === "rotate") {
        await adminClient.from("leaderboard_access_tokens").update({ is_active: false }).eq("is_active", true);
      }
      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      const label = (typeof body?.label === "string" && body.label.trim()) ? body.label.trim().slice(0, 80) : "TV";
      const { data, error } = await adminClient.from("leaderboard_access_tokens")
        .insert({ token, label, is_active: true, created_by: user.id })
        .select("id,label,token,is_active,created_at").single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true, token: data });
    }

    // GET /api/voip/credentials — returns ONLY the caller's OWN SIP extension +
    // secret (never anyone else's). Auto-assigns the lowest free pool extension
    // on first use. This replaces the shared, hardcoded extension/secret that
    // used to ship in the JS bundle, and lets every account register as its own
    // line. SIP extensions are cheap and plentiful; what is capped is the number
    // of SIMULTANEOUS calls, by the A1 trunk's channel limit (see VOIP Health →
    // Lines & Trunk for the live value — never hardcode it here).
    if (req.method === "GET" && path === "voip/credentials") {
      let { data: mine } = await adminClient
        .from("telephony_extensions")
        .select("extension, sip_secret, primary_caller_id, secondary_caller_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!mine) {
        // Atomically claim the lowest free pool extension. The `.is(user_id,null)`
        // guard on UPDATE makes concurrent claims safe (loser retries).
        for (let attempt = 0; attempt < 8 && !mine; attempt++) {
          const { data: free } = await adminClient
            .from("telephony_extensions")
            .select("extension")
            .is("user_id", null)
            .order("extension", { ascending: true })
            .limit(1)
            .maybeSingle();
          if (!free) break; // pool exhausted
          const { data: claimed } = await adminClient
            .from("telephony_extensions")
            .update({ user_id: user.id, label: user.email || "agent" })
            .eq("extension", free.extension)
            .is("user_id", null)
            .select("extension, sip_secret, primary_caller_id, secondary_caller_id")
            .maybeSingle();
          if (claimed) mine = claimed;
        }
      }

      if (!mine) {
        return json({ error: "No phone extension available — ask an admin to add more lines." }, 409);
      }

      return json({
        extension: mine.extension,
        secret: mine.sip_secret,
        ws_url: "wss://pbx.elyoncall.com/ws",
        // Main green Dial uses primary (default the .100 local for everyone).
        primary_caller_id: mine.primary_caller_id || "+35924234100",
        // Topbar "Dial new number" uses secondary — an owned MOBILE by default so
        // ad-hoc outreach shows a mobile, not the office line. Per-agent override
        // wins when set; otherwise this global mobile default applies.
        secondary_caller_id: mine.secondary_caller_id || "+359882040529",
      });
    }

    // ===== Recordings (admin/manager only) — list + on-demand signed stream URLs.
    // Audio streams straight from the PBX recordings service via a short-lived
    // HMAC-signed URL (no byte-proxying through the function). The HMAC secret is
    // shared with /etc/asterisk/elyon-rec.key (env REC_SHARED_SECRET).
    const recSign = async (payload: string, exp: number): Promise<string> => {
      const secret = Deno.env.get("REC_SHARED_SECRET") || "";
      const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const b = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${payload}|${exp}`)));
      return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
    };
    const REC_HOST = "https://pbx.elyoncall.com/elyon-rec.php";

    // True iff `file` is provably one of THIS user's own recordings — used to gate
    // the own-scoped agent path (can_hear_own_recordings) without ever exposing
    // another agent's audio. Anything not provably theirs → false (fail-closed).
    //
    // PRIMARY signal is the recording's EXTENSION: every MixMonitor filename is
    // out-<HHMMSS>-<ext>-<cid>-to-<dialed>-<uniqueid>.wav, and ext ↔ agent is 1:1
    // (telephony_extensions.user_id UNIQUE). This is the ground truth that the
    // call was made on the agent's own line, and — crucially — it works for the
    // common same-day case where the recording hasn't been anchored into
    // call_recordings / call_logs yet (recording_file still NULL; the row is
    // matched live at read-time). The anchored DB authorities are kept as
    // fallbacks for any non-standard filename.
    const agentOwnsRecording = async (file: string, userId: string): Promise<boolean> => {
      if (!file) return false;
      const base = (file.split("/").pop() || "");
      const extMatch = base.match(/^out-\d{6}-(\d+)-/);
      const ext = extMatch ? extMatch[1] : null;
      if (ext) {
        const { data: te } = await adminClient.from("telephony_extensions").select("user_id").eq("extension", ext).maybeSingle();
        if (te?.user_id === userId) return true;
      }
      const [recRes, logRes] = await Promise.all([
        adminClient.from("call_recordings").select("agent_id").eq("file", file),
        adminClient.from("call_logs").select("id").eq("recording_file", file).eq("agent_id", userId).limit(1),
      ]);
      if ((recRes.data || []).some((r: any) => r.agent_id === userId)) return true;
      if ((logRes.data || []).length > 0) return true;
      return false;
    };

    // GET /api/recordings — list recordings, ENRICHED with the matching call log
    // (agent name, customer name, outcome, exact call time). The PBX filename only
    // has the dialed number + time; we match it to a call_logs row by dialed number
    // (last 8 digits) + nearest call time (±20 min).
    if (req.method === "GET" && path === "recordings") {
      if (!canHearRecordings && !canHearOwnRecordings) return json({ error: "Forbidden" }, 403);
      const exp = Math.floor(Date.now() / 1000) + 120;
      const sig = await recSign("list", exp);
      let recordings: any[] = [];
      try {
        const r = await fetch(`${REC_HOST}?mode=list&exp=${exp}&sig=${sig}`);
        if (!r.ok) return json({ error: "Recordings service error" }, 502);
        recordings = await r.json();
      } catch (_e) {
        return json({ error: "Recordings service unavailable" }, 502);
      }

      // Own-scoped agents (can_hear_own_recordings, NOT hear-all): keep only
      // recordings made on their own extension(s) before enrichment. The audio
      // endpoint re-verifies ownership before signing any URL — this is just so
      // an own-scoped caller never even sees another agent's recording metadata.
      if (!canHearRecordings) {
        const { data: myExts } = await adminClient.from("telephony_extensions").select("extension").eq("user_id", user.id);
        const mine = new Set((myExts || []).map((x: any) => x.extension).filter(Boolean));
        recordings = recordings.filter((r: any) => r.ext && mine.has(r.ext));
      }

      const since = new Date(Date.now() - 95 * 24 * 3600 * 1000).toISOString();
      const { data: logs } = await adminClient
        .from("call_logs")
        .select("id,agent_id,customer_phone,started_at,connected_at,ended_at,context_type,context_id,outcome")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(8000);
      // Agent behind each recording extension (keeps two agents who called the
      // same number apart in the deterministic matcher).
      const recExts = [...new Set(recordings.map((r: any) => r.ext).filter(Boolean))];
      const extToAgent: Record<string, string> = {};
      if (recExts.length) {
        const { data: te } = await adminClient.from("telephony_extensions").select("extension,user_id").in("extension", recExts);
        for (const x of te || []) if (x.extension && x.user_id) extToAgent[x.extension] = x.user_id;
      }
      // Deterministic one-to-one matching (end-anchored / interval-overlap) — the
      // same matcher Call History uses, so no long-call misses or swaps here either.
      const callToRec = matchRecordingsToCalls(recordings as RecLite[], (logs || []) as CallLite[], extToAgent);
      const logById = new Map<string, any>((logs || []).map((l: any) => [l.id, l] as [string, any]));
      const recFileToLog = new Map<string, any>();
      for (const [callId, rec] of callToRec) if (rec.file) recFileToLog.set(rec.file, logById.get(callId) || null);
      const matches = recordings.map((rec: any) => ({ rec, log: rec.file ? (recFileToLog.get(rec.file) || null) : null }));
      const agentIds = [...new Set(matches.filter((m) => m.log).map((m) => m.log.agent_id))];
      const orderIds = [...new Set(matches.filter((m) => m.log?.context_type === "order").map((m) => m.log.context_id))];
      const leadIds = [...new Set(matches.filter((m) => m.log?.context_type === "prediction_lead").map((m) => m.log.context_id))];
      const agentMap: Record<string, string> = {};
      if (agentIds.length) { const { data: p } = await adminClient.from("profiles").select("user_id,full_name").in("user_id", agentIds); for (const x of p || []) agentMap[x.user_id] = x.full_name; }
      const orderMap: Record<string, any> = {};
      if (orderIds.length) { const { data: o } = await adminClient.from("orders").select("id,customer_name,customer_phone").in("id", orderIds); for (const x of o || []) orderMap[x.id] = x; }
      const leadMap: Record<string, any> = {};
      if (leadIds.length) { const { data: l2 } = await adminClient.from("prediction_leads").select("id,name,telephone").in("id", leadIds); for (const x of l2 || []) leadMap[x.id] = x; }
      const enriched = matches.map(({ rec, log }) => {
        let agent_name: string | null = null, customer_name: string | null = null, customer_phone: string | null = null, outcome: string | null = null, call_at: string | null = null;
        if (log) {
          agent_name = agentMap[log.agent_id] || null;
          outcome = log.outcome || null;
          call_at = log.connected_at || log.started_at || null;
          if (log.context_type === "order") { const o = orderMap[log.context_id]; customer_name = o?.customer_name || null; customer_phone = o?.customer_phone || log.customer_phone || null; }
          else if (log.context_type === "prediction_lead") { const l3 = leadMap[log.context_id]; customer_name = l3?.name || null; customer_phone = l3?.telephone || log.customer_phone || null; }
          else { customer_phone = log.customer_phone || null; }
        }
        return { ...rec, agent_name, customer_name, customer_phone, outcome, call_at };
      });
      return json({ recordings: enriched });
    }

    // GET /api/recordings/audio?file=YYYY/MM/DD/x.wav — short-lived signed URL the
    // browser uses directly (play/download). Audio never passes through the function.
    if (req.method === "GET" && path === "recordings/audio") {
      if (!canHearRecordings && !canHearOwnRecordings) return json({ error: "Forbidden" }, 403);
      const file = url.searchParams.get("file") || "";
      if (!/^\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._+\-]+\.wav$/.test(file)) return json({ error: "bad file" }, 400);
      // Own-scoped agents may only obtain a URL for a recording attached to one of
      // THEIR OWN calls. This is the hard boundary — the PBX signs whatever this
      // endpoint authorizes, so a crafted/guessed foreign file path is denied here.
      if (!canHearRecordings && !(await agentOwnsRecording(file, user.id))) return json({ error: "Forbidden" }, 403);
      const exp = Math.floor(Date.now() / 1000) + 300;
      const sig = await recSign(file, exp);
      return json({ url: `${REC_HOST}?file=${encodeURIComponent(file)}&exp=${exp}&sig=${sig}` });
    }

    // ============================================================
    // VOIP / TELEPHONY HEALTH (superadmin only)
    // The PBX/VPS has no presence in the CRM today; these endpoints give the
    // superadmin live server + line + trunk + recording + call-quality visibility,
    // trends, and an incidents[] feed for the in-CRM alert banner.
    // ============================================================
    const HEALTH_HOST = "https://pbx.elyoncall.com/elyon-health.php";

    // Pull the PBX's live health JSON (HMAC-signed; same scheme as recordings).
    const fetchPbxHealth = async (): Promise<any> => {
      const exp = Math.floor(Date.now() / 1000) + 60;
      const sig = await recSign("health", exp);
      try {
        const r = await fetch(`${HEALTH_HOST}?mode=health&exp=${exp}&sig=${sig}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return { ok: false, error: `pbx ${r.status}` };
        return await r.json();
      } catch (_e) {
        return { ok: false, error: "unreachable" };
      }
    };

    // Recording filenames carry only the dialed number + time; match to call_logs
    // by last-8 digits within ±20 min (the same rule Call History uses). Files
    // under 2 KB are failed/empty recordings — drop them.
    const fetchRecordingsList = async (): Promise<any[]> => {
      const exp = Math.floor(Date.now() / 1000) + 120;
      const sig = await recSign("list", exp);
      try {
        const r = await fetch(`${REC_HOST}?mode=list&exp=${exp}&sig=${sig}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) return [];
        const arr = await r.json();
        return Array.isArray(arr) ? arr.filter((x: any) => (x.size || 0) > 2000) : [];
      } catch (_e) { return []; }
    };

    // PostgREST caps a single response at db-max-rows (1000 on Supabase), so a
    // plain .limit(5000)/.limit(20000) SILENTLY returns 1000 rows — at ~1,000
    // calls/day that quietly under-reported every VOIP figure on this page.
    // Page with .range() instead. Same workaround as scripts/backfill-recordings.mjs.
    // maxRows is a runaway guard, not a business limit.
    const fetchAllRows = async (build: (from: number, to: number) => any, maxRows = 60000): Promise<any[]> => {
      const out: any[] = [];
      for (let off = 0; off < maxRows; off += 1000) {
        const { data, error } = await build(off, off + 999);
        if (error || !data?.length) break;
        out.push(...data);
        if (data.length < 1000) break;
      }
      return out;
    };

    // GET /api/voip/health — live PBX pull + today's DB-derived call/recording/
    // quality stats + computed incidents[] (drives the page AND the alert banner).
    if (req.method === "GET" && path === "voip/health") {
      if (!isAdmin) return json({ error: "Forbidden" }, 403);
      const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
      const sinceIso = dayStart.toISOString();

      const [pbx, recs, logsRes, qualRes, lastSnapRes, cycle] = await Promise.all([
        fetchPbxHealth(),
        fetchRecordingsList(),
        fetchAllRows((f, t) => adminClient.from("call_logs")
          .select("id,customer_phone,started_at,connected_at,ended_at,connection_state,total_seconds,outcome")
          .gte("created_at", sinceIso).order("created_at", { ascending: false }).range(f, t)),
        fetchAllRows((f, t) => adminClient.from("call_quality")
          .select("one_way_audio,packet_loss_pct,hangup_cause")
          .gte("captured_at", sinceIso).order("captured_at", { ascending: false }).range(f, t)),
        adminClient.from("pbx_health_snapshots").select("captured_at").order("captured_at", { ascending: false }).limit(1).maybeSingle(),
        computeVoipCycle(adminClient),
      ]);
      const logs = logsRes || [];
      const quals = qualRes || [];

      const answered = logs.filter((l: any) => l.connection_state === "answered" || l.connected_at);
      const outboundSeconds = logs.reduce((s: number, l: any) => s + (l.total_seconds || 0), 0);

      // Recording coverage: answered calls today with NO matched recording. Uses
      // the same deterministic one-to-one matcher as Call History, so long calls
      // are no longer mislabelled "unrecorded".
      const matchedToday = matchRecordingsToCalls(recs as RecLite[], answered as CallLite[]);
      const answeredCount = answered.length;
      const recordedCount = answered.filter((l: any) => matchedToday.has(l.id)).length;
      const coveragePct = answeredCount ? Math.round((recordedCount / answeredCount) * 100) : 100;
      const oneWayToday = quals.filter((q: any) => q.one_way_audio).length;

      // Incidents (thresholds) → banner + Issues tab.
      const incidents: { level: "critical" | "warning"; code: string; message: string }[] = [];
      if (pbx?.ok === false) incidents.push({ level: "critical", code: "pbx_unreachable", message: "PBX health endpoint unreachable" });
      if (pbx?.trunk && pbx.trunk.reachable === false) incidents.push({ level: "critical", code: "trunk_down", message: "A1 trunk unreachable — outbound calling is down" });
      const diskPct = Number(pbx?.disk?.pct);
      if (!isNaN(diskPct) && diskPct >= 85) incidents.push({ level: diskPct >= 92 ? "critical" : "warning", code: "disk_high", message: `Disk ${diskPct}% full` });
      const memPct = Number(pbx?.mem?.pct);
      if (!isNaN(memPct) && memPct >= 92) incidents.push({ level: "warning", code: "mem_high", message: `Memory ${memPct}% used` });
      if (pbx?.asterisk && pbx.asterisk.running === false) incidents.push({ level: "critical", code: "asterisk_down", message: "Asterisk is not running" });
      const newestAge = Number(pbx?.recordings_today?.newest_age_seconds);
      const hr = new Date().getHours();
      if (!isNaN(newestAge) && hr >= 9 && hr < 19 && newestAge > 3 * 3600) incidents.push({ level: "warning", code: "recordings_stalled", message: "No new recording in 3h during working hours" });
      const banned = Number(pbx?.attacks?.banned_count);
      if (!isNaN(banned) && banned >= 10) incidents.push({ level: "warning", code: "attacks", message: `${banned} IPs currently banned (fail2ban)` });
      if (answeredCount >= 10 && coveragePct < 80) incidents.push({ level: "warning", code: "low_coverage", message: `Only ${coveragePct}% of answered calls recorded today` });
      if (oneWayToday > 0) incidents.push({ level: "warning", code: "one_way_audio", message: `${oneWayToday} call(s) with one-way audio today` });
      // A1 minutes bundle. Blowing through the allowance unnoticed is the leading
      // theory for the 2026-07-02 / 07-08 outbound bars, so this warns early
      // rather than after the carrier cuts us off.
      if (cycle && cycle.included_minutes > 0) {
        if (cycle.status === "critical") {
          incidents.push({
            level: "critical", code: "minutes_quota_critical",
            message: cycle.projected_pct >= 100 && cycle.pct_used < 100
              ? `A1 minutes: ${cycle.used_minutes}/${cycle.included_minutes} used — projected ${cycle.projected_minutes} by cycle end (over by ${cycle.projected_over_by})`
              : `A1 minutes: ${cycle.used_minutes}/${cycle.included_minutes} used (${cycle.pct_used}%) this billing cycle`,
          });
        } else if (cycle.status === "warn") {
          incidents.push({
            level: "warning", code: "minutes_quota_warn",
            message: `A1 minutes: ${cycle.used_minutes}/${cycle.included_minutes} used (${cycle.pct_used}%) this billing cycle`,
          });
        }
      }

      return json({
        pbx,
        snapshot_age_seconds: lastSnapRes.data ? Math.round((Date.now() - new Date(lastSnapRes.data.captured_at).getTime()) / 1000) : null,
        today: {
          calls: logs.length,
          answered: answeredCount,
          no_answer: logs.filter((l: any) => l.connection_state === "no_answer").length,
          outbound_minutes: Math.round(outboundSeconds / 60),
          recording_coverage_pct: coveragePct,
          answered_recorded: recordedCount,
          answered_unrecorded: answeredCount - recordedCount,
          one_way_audio: oneWayToday,
        },
        incidents,
      });
    }

    // GET /api/voip/health/history?range=24h|7d|30d — trend series from snapshots.
    if (req.method === "GET" && path === "voip/health/history") {
      if (!isAdmin) return json({ error: "Forbidden" }, 403);
      const range = url.searchParams.get("range") || "24h";
      const hours = range === "30d" ? 720 : range === "7d" ? 168 : 24;
      const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      // 30d = 14,400 snapshots at one per 3 min — well past the 1000-row cap.
      const data = await fetchAllRows((f, t) => adminClient
        .from("pbx_health_snapshots")
        .select("captured_at,disk_pct,mem_pct,load1,active_lines,max_lines,trunk_reachable,recordings_today,banned_ips,rec_bytes")
        .gte("captured_at", since).order("captured_at", { ascending: true }).range(f, t));
      return json({ snapshots: data });
    }

    // GET /api/voip/recording-coverage?range=7d — the GAP LIST: answered calls
    // with NO recording, each tagged with the likely reason. Answers "why are
    // some calls not recorded".
    if (req.method === "GET" && path === "voip/recording-coverage") {
      if (!isAdmin) return json({ error: "Forbidden" }, 403);
      const range = url.searchParams.get("range") || "7d";
      const days = range === "30d" ? 30 : range === "24h" ? 1 : 7;
      const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
      const [recs, logs] = await Promise.all([
        fetchRecordingsList(),
        fetchAllRows((f, t) => adminClient.from("call_logs")
          .select("id,agent_id,customer_phone,started_at,connected_at,ended_at,connection_state,outcome")
          .gte("created_at", since).order("created_at", { ascending: false }).range(f, t)),
      ]);
      const byPhone: Record<string, any[]> = {};
      for (const r of recs) {
        const p = String(r.dialed || "").replace(/\D/g, "").slice(-8);
        if (p) (byPhone[p] = byPhone[p] || []).push(r);
      }
      const answered = logs.filter((l: any) => l.connection_state === "answered" || l.connected_at);
      // Deterministic one-to-one matcher decides "recorded"; byPhone is only used
      // to classify WHY an unmatched call has no recording.
      const matchedGap = matchRecordingsToCalls(recs as RecLite[], answered as CallLite[]);
      const gaps: any[] = [];
      let recorded = 0;
      for (const l of answered) {
        if (matchedGap.has(l.id)) { recorded++; continue; }
        const p = String(l.customer_phone || "").replace(/\D/g, "").slice(-8);
        const cands = (p && byPhone[p]) || [];
        let reason = "no_recording_on_pbx";
        if (!p) reason = "unmatchable_phone";
        else if (cands.length) reason = "outside_time_window"; // a recording for this number exists but didn't match this call
        gaps.push({ id: l.id, agent_id: l.agent_id, customer_phone: l.customer_phone, call_at: l.connected_at || l.started_at, outcome: l.outcome, reason });
      }
      const agentIds = [...new Set(gaps.map((g) => g.agent_id).filter(Boolean))];
      const amap: Record<string, string> = {};
      if (agentIds.length) { const { data } = await adminClient.from("profiles").select("user_id,full_name").in("user_id", agentIds); for (const a of data || []) amap[a.user_id] = a.full_name; }
      for (const g of gaps) g.agent_name = amap[g.agent_id] || null;
      return json({
        answered: answered.length, recorded, unrecorded: gaps.length,
        coverage_pct: answered.length ? Math.round((recorded / answered.length) * 100) : 100,
        gaps: gaps.slice(0, 200),
      });
    }

    // GET /api/voip/minutes?range=7d&group=agent|day — outbound minutes from our
    // own call telemetry. NOT invoice-grade: A1 bills answered time per-second
    // after the first 60s, and mobile destinations may sit outside the bundle.
    // `cycle` always covers the CURRENT billing cycle regardless of `range`
    // (range only drives the charts) so the quota gauge can't be misread.
    if (req.method === "GET" && path === "voip/minutes") {
      if (!isAdmin) return json({ error: "Forbidden" }, 403);
      const range = url.searchParams.get("range") || "7d";
      const group = url.searchParams.get("group") || "day";
      const days = range === "30d" ? 30 : range === "24h" ? 1 : 7;
      const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

      const [cycle, rows] = await Promise.all([
        computeVoipCycle(adminClient),
        fetchAllRows((f, t) => adminClient.from("call_logs")
          .select("agent_id,total_seconds,talk_seconds,started_at,connected_at")
          .gte("created_at", since).order("created_at", { ascending: false }).range(f, t)),
      ]);
      const totalSeconds = rows.reduce((s: number, l: any) => s + (l.total_seconds || 0), 0);
      const talkSeconds = rows.reduce((s: number, l: any) => s + (l.talk_seconds || 0), 0);

      const buckets: Record<string, number> = {};
      if (group === "agent") {
        for (const l of rows) { const k = l.agent_id || "unknown"; buckets[k] = (buckets[k] || 0) + (l.total_seconds || 0); }
        const ids = Object.keys(buckets).filter((k) => k !== "unknown");
        const amap: Record<string, string> = {};
        if (ids.length) { const { data } = await adminClient.from("profiles").select("user_id,full_name").in("user_id", ids); for (const a of data || []) amap[a.user_id] = a.full_name; }
        const series = Object.entries(buckets).map(([k, v]) => ({ key: amap[k] || k, minutes: Math.round(v / 60) })).sort((a, b) => b.minutes - a.minutes);
        return json({ total_minutes: Math.round(totalSeconds / 60), talk_minutes: Math.round(talkSeconds / 60), group, series, cycle });
      }
      for (const l of rows) { const d = (l.started_at || l.connected_at || "").slice(0, 10) || "unknown"; buckets[d] = (buckets[d] || 0) + (l.total_seconds || 0); }
      const series = Object.entries(buckets).map(([k, v]) => ({ key: k, minutes: Math.round(v / 60) })).sort((a, b) => a.key.localeCompare(b.key));
      return json({ total_minutes: Math.round(totalSeconds / 60), talk_minutes: Math.round(talkSeconds / 60), group: "day", series, cycle });
    }

    // ===== Per-agent caller-ID (superadmin) — default +35924234100 for everyone;
    // admins can assign any owned DID to an agent. Stored in telephony_extensions;
    // a 2-min PBX sync applies it (predial hook presents it, whitelisted).
    // TODO(mk): these are the BULGARIAN A1 trunk's Sofia DIDs, inherited from the
    // upstream system. Macedonian telephony is deferred (Phase 2) and there is no
    // MK carrier yet, so they are left intact but MUST be replaced with real MK
    // numbers before the softphone is enabled. They are not live config today —
    // VITE_USE_REAL_VOIP is false.
    const OWNED_DIDS: { value: string; label: string }[] = [
      { value: "+35924234100", label: "02 423 4100 — Sofia (default)" },
      { value: "+35924232487", label: "02 423 2487 — Sofia" },
      { value: "+35924236423", label: "02 423 6423 — Sofia" },
      { value: "+35924236975", label: "02 423 6975 — Sofia" },
      { value: "+35924237082", label: "02 423 7082 — Sofia" },
      { value: "+35924238192", label: "02 423 8192 — Sofia" },
      { value: "+35924238345", label: "02 423 8345 — Sofia" },
      { value: "+35924238863", label: "02 423 8863 — Sofia" },
      { value: "+35924239172", label: "02 423 9172 — Sofia" },
      { value: "+35924239675", label: "02 423 9675 — Sofia" },
      { value: "+359882040529", label: "088 204 0529 — mobile" },
      { value: "+359882240572", label: "088 224 0572 — mobile" },
      { value: "+359882255198", label: "088 225 5198 — mobile" },
      { value: "+359882257053", label: "088 225 7053 — mobile" },
      { value: "+359882265270", label: "088 226 5270 — mobile" },
      { value: "+359882447210", label: "088 244 7210 — mobile" },
      { value: "+359882471250", label: "088 247 1250 — mobile" },
      { value: "+359882522057", label: "088 252 2057 — mobile" },
      { value: "+359882526629", label: "088 252 6629 — mobile" },
      { value: "+359882646781", label: "088 264 6781 — mobile" },
    ];

    // GET /api/voip/agents — list agents with an assigned extension + their caller-ID + DID options.
    if (req.method === "GET" && path === "voip/agents") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { data: exts } = await adminClient
        .from("telephony_extensions")
        .select("extension,user_id,primary_caller_id,label")
        .not("user_id", "is", null)
        .order("extension");
      const userIds = (exts || []).map((e: any) => e.user_id);
      const { data: profs } = await adminClient
        .from("profiles")
        .select("user_id,full_name,email")
        .in("user_id", userIds.length ? userIds : ["00000000-0000-0000-0000-000000000000"]);
      const pmap: Record<string, any> = {};
      (profs || []).forEach((p: any) => { pmap[p.user_id] = p; });
      const agents = (exts || []).map((e: any) => ({
        user_id: e.user_id,
        extension: e.extension,
        primary_caller_id: e.primary_caller_id,
        full_name: pmap[e.user_id]?.full_name || e.label || "—",
        email: pmap[e.user_id]?.email || "",
      }));
      return json({ agents, dids: OWNED_DIDS });
    }

    // PUT /api/voip/agents/:userId/caller-id — superadmin sets an agent's outbound caller-ID.
    if (req.method === "PUT" && segments[0] === "voip" && segments[1] === "agents" && segments[3] === "caller-id") {
      if (!isAdmin) return json({ error: "Forbidden" }, 403);
      const targetUser = segments[2];
      let body: any; try { body = await req.json(); } catch { body = {}; }
      const cid = String(body.caller_id || "").trim();
      if (!OWNED_DIDS.some((d) => d.value === cid)) return json({ error: "Caller ID must be one of the owned numbers" }, 400);
      const { data: updated, error } = await adminClient
        .from("telephony_extensions")
        .update({ primary_caller_id: cid })
        .eq("user_id", targetUser)
        .select("extension")
        .maybeSingle();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      if (!updated) return json({ error: "Agent has no telephony extension assigned" }, 404);
      await audit(adminClient, user.id, user.email, "voip.caller_id.set", { target_type: "user", target_id: targetUser, payload: { extension: updated.extension, caller_id: cid } });
      return json({ success: true });
    }

    // GET /api/missed-calls — admin/manager: all; agent: calls assigned to them
    // PLUS unassigned calls from customers they own (they're the last agent to have
    // called / handled that caller's order). Enriched with "who contacted this caller
    // last" (a previous call OR the agent who handled their last order) so missed
    // calls land with the agent who already has the relationship. The agent filter is
    // applied AFTER enrichment because it depends on last_agent_id (see below).
    // Matching is by last-8 digits (phone canon).
    if (req.method === "GET" && path === "missed-calls") {
      let q = adminClient.from("missed_calls").select("*").order("occurred_at", { ascending: false }).limit(300);
      const statusF = url.searchParams.get("status");
      if (statusF) q = q.eq("status", statusF);
      const { data, error } = await q;
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      const missed = data || [];

      const last8 = (p: any) => String(p || "").replace(/\D/g, "").slice(-8);
      const norms = new Set(missed.map((m: any) => m.linked_phone_norm || last8(m.caller_number)).filter(Boolean));

      // Most recent agent-initiated CALL to each caller (call_logs is bounded at the
      // current scale; the (customer_phone, started_at DESC) index keeps it cheap).
      const callByNorm: Record<string, { agent_id: string; at: string; outcome: string | null }> = {};
      if (norms.size) {
        const { data: logs } = await adminClient
          .from("call_logs")
          .select("agent_id, customer_phone, started_at, outcome")
          .not("customer_phone", "is", null)
          .not("agent_id", "is", null)
          .order("started_at", { ascending: false })
          .limit(5000);
        for (const l of logs || []) {
          const n = last8(l.customer_phone);
          if (!n || !norms.has(n) || callByNorm[n]) continue; // desc order → first seen is latest
          callByNorm[n] = { agent_id: l.agent_id, at: l.started_at, outcome: l.outcome ?? null };
        }
      }
      const callAgentIds = new Set(Object.values(callByNorm).map((v) => v.agent_id));
      const nameById: Record<string, string> = {};
      if (callAgentIds.size) {
        const { data: profs } = await adminClient.from("profiles").select("user_id, full_name").in("user_id", [...callAgentIds]);
        for (const p of profs || []) nameById[p.user_id] = p.full_name;
      }

      // The caller's last order (via the already-linked order) — used as the
      // FALLBACK agent + to show the customer's name.
      const orderIds = [...new Set(missed.map((m: any) => m.linked_order_id).filter(Boolean))];
      const orderById: Record<string, any> = {};
      if (orderIds.length) {
        const { data: ords } = await adminClient
          .from("orders")
          .select("id, customer_name, confirmed_by_agent_id, confirmed_by_name, assigned_agent_id, assigned_agent_name, created_at, display_id")
          .in("id", orderIds);
        for (const o of ords || []) orderById[o.id] = o;
      }

      const enriched = missed.map((m: any) => {
        const n = m.linked_phone_norm || last8(m.caller_number);
        const call = callByNorm[n];
        const ord = m.linked_order_id ? orderById[m.linked_order_id] : null;
        const callAgentName = call ? (nameById[call.agent_id] || null) : null;

        let last_agent_name: string | null = null, last_agent_id: string | null = null,
          last_agent_at: string | null = null, last_agent_source: string | null = null,
          last_agent_detail: string | null = null;
        // Call-log FIRST: whoever last *called* this number owns the relationship,
        // even if someone else placed the last order. Only fall back to the order
        // when there is no call at all.
        if (callAgentName) {
          last_agent_name = callAgentName; last_agent_id = call!.agent_id; last_agent_at = call!.at;
          last_agent_source = "call"; last_agent_detail = call!.outcome;
        } else if (ord && (ord.confirmed_by_name || ord.assigned_agent_name)) {
          last_agent_name = ord.confirmed_by_name || ord.assigned_agent_name;
          last_agent_id = ord.confirmed_by_agent_id || ord.assigned_agent_id || null;
          last_agent_at = ord.created_at || null;
          last_agent_source = "order"; last_agent_detail = ord.display_id || null;
        }
        return {
          ...m,
          customer_name: ord?.customer_name || null,
          last_agent_name, last_agent_id, last_agent_at, last_agent_source, last_agent_detail,
        };
      });

      // Agents see calls assigned to them, plus unassigned calls from customers they
      // own (last_agent_id === them). Calls assigned to someone else stay hidden.
      // Admins/managers see everything.
      const visible = isAdminOrManager
        ? enriched
        : enriched.filter((m: any) =>
            m.assigned_agent_id === user.id ||
            (!m.assigned_agent_id && m.last_agent_id === user.id));
      return json({ missed_calls: redactCustomerList(visible, piiFlags) });
    }

    // POST /api/missed-calls/bulk-assign — assign many at once to one agent.
    if (req.method === "POST" && path === "missed-calls/bulk-assign") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let b: any; try { b = await req.json(); } catch { b = {}; }
      const ids = Array.isArray(b.ids) ? b.ids.filter((x: any) => typeof x === "string") : [];
      const agentId = String(b.agent_id || "");
      if (!ids.length || !agentId) return json({ error: "ids[] and agent_id required" }, 400);
      const { data: prof } = await adminClient.from("profiles").select("full_name").eq("user_id", agentId).maybeSingle();
      const { error } = await adminClient.from("missed_calls")
        .update({ assigned_agent_id: agentId, assigned_agent_name: prof?.full_name || null, status: "assigned" })
        .in("id", ids);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true, count: ids.length });
    }

    // POST /api/missed-calls/:id/assign — admin/manager assign to an agent.
    if (req.method === "POST" && segments[0] === "missed-calls" && segments[2] === "assign") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const id = segments[1];
      let b: any; try { b = await req.json(); } catch { b = {}; }
      const agentId = String(b.agent_id || "");
      if (!agentId) return json({ error: "agent_id required" }, 400);
      const { data: prof } = await adminClient.from("profiles").select("full_name").eq("user_id", agentId).maybeSingle();
      const { error } = await adminClient.from("missed_calls")
        .update({ assigned_agent_id: agentId, assigned_agent_name: prof?.full_name || null, status: "assigned" })
        .eq("id", id);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // POST /api/missed-calls/:id/status — set status (admin/manager any; agent only their own).
    if (req.method === "POST" && segments[0] === "missed-calls" && segments[2] === "status") {
      const id = segments[1];
      let b: any; try { b = await req.json(); } catch { b = {}; }
      const status = String(b.status || "");
      if (!["new", "assigned", "called_back", "ignored"].includes(status)) return json({ error: "bad status" }, 400);
      let q = adminClient.from("missed_calls").update({ status }).eq("id", id);
      if (!isAdminOrManager) q = q.eq("assigned_agent_id", user.id);
      const { error } = await q;
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // GET /api/missed-calls/:id/voicemail-url — short-lived signed URL for the
    // caller's recorded message. Admin/manager any; an agent only for a call
    // assigned to them. Reuses the elyon-rec.php signing (same as call recordings).
    if (req.method === "GET" && segments[0] === "missed-calls" && segments[2] === "voicemail-url") {
      const id = segments[1];
      const { data: mc } = await adminClient
        .from("missed_calls").select("voicemail_file, assigned_agent_id").eq("id", id).maybeSingle();
      if (!mc) return json({ error: "not found" }, 404);
      if (!canHearRecordings && mc.assigned_agent_id !== user.id) return json({ error: "Forbidden" }, 403);
      const file = String(mc.voicemail_file || "");
      if (!/^\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9._+\-]+\.wav$/.test(file)) return json({ error: "no voicemail" }, 404);
      const exp = Math.floor(Date.now() / 1000) + 300;
      const sig = await recSign(file, exp);
      return json({ url: `${REC_HOST}?file=${encodeURIComponent(file)}&exp=${exp}&sig=${sig}` });
    }

    // POST /api/users/create (admin only)
    if (req.method === "POST" && path === "users/create") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "users.create", 10)) return json({ error: "Rate limit exceeded — try again in a minute" }, 429);
      let body;
      try { body = parseBody(createUserSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const { email, password, full_name } = body;
      const rolesToAssign: string[] = body.roles || (body.role ? [body.role] : []);

      if (rolesToAssign.length === 0) {
        return json({ error: "At least one role is required" }, 400);
      }
      const validRoles = ["admin", "manager", "agent", "pending_agent", "prediction_agent", "warehouse", "ads_admin", "affiliate"];
      if (rolesToAssign.some((r: string) => !validRoles.includes(r))) {
        return json({ error: `Roles must be one of: ${validRoles.join(", ")}` }, 400);
      }
      // Managers can only create pending_agent and prediction_agent
      if (isManager && !isAdmin) {
        const allowedForManager = ["pending_agent", "prediction_agent"];
        if (rolesToAssign.some((r: string) => !allowedForManager.includes(r))) {
          return json({ error: "Managers can only create Pending Agent or Prediction Agent users" }, 400);
        }
      }

      const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name },
      });
      if (createErr) return json({ error: sanitizeDbError(createErr) }, 400);

      // Assign all roles
      for (const r of rolesToAssign) {
        await adminClient.from("user_roles").insert({ user_id: newUser.user.id, role: r });
      }

      await audit(adminClient, user.id, user.email, "user.create", {
        target_type: "user",
        target_id: newUser.user.id,
        target_name: email,
        payload: { full_name, roles: rolesToAssign },
      });
      return json({ success: true, user_id: newUser.user.id });
    }

    // PATCH /api/users/:id (admin only - edit name / email / password)
    if (req.method === "PATCH" && segments[0] === "users" && segments.length === 2) {
      // Identity edits (email/password) are Superadmin-only; managers can't reset logins.
      if (!isAdmin) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "users.update", 20)) return json({ error: "Rate limit exceeded — try again in a minute" }, 429);
      const userId = segments[1];
      let body;
      try { body = parseBody(updateUserSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }

      // Make sure the target exists (and capture the old email for the audit trail).
      const { data: target } = await adminClient
        .from("profiles")
        .select("full_name, email")
        .eq("user_id", userId)
        .single();
      if (!target) return json({ error: "User not found" }, 404);

      // 1) auth.users — email and/or password
      const authPatch: Record<string, unknown> = {};
      if (body.email !== undefined) { authPatch.email = body.email; authPatch.email_confirm = true; }
      if (body.password !== undefined) authPatch.password = body.password;
      if (Object.keys(authPatch).length > 0) {
        const { error: authErr } = await adminClient.auth.admin.updateUserById(userId, authPatch);
        if (authErr) return json({ error: sanitizeDbError(authErr) }, 400);
      }

      // 2) profiles — keep display name / email in sync with auth
      const profPatch: Record<string, unknown> = {};
      if (body.full_name !== undefined) profPatch.full_name = body.full_name;
      if (body.email !== undefined) profPatch.email = body.email;
      if (Object.keys(profPatch).length > 0) {
        const { error: profErr } = await adminClient.from("profiles").update(profPatch).eq("user_id", userId);
        if (profErr) return json({ error: sanitizeDbError(profErr) }, 400);
      }

      // 3) Denormalized copies of the display name: segment member rows are live
      //    work queues (always resync); orders only while OPEN — closed orders
      //    keep the historical name they were worked under.
      if (body.full_name !== undefined && body.full_name !== target.full_name) {
        await adminClient
          .from("prediction_segment_members")
          .update({ assigned_agent_name: body.full_name })
          .eq("assigned_agent_id", userId);
        await adminClient
          .from("orders")
          .update({ assigned_agent_name: body.full_name })
          .eq("assigned_agent_id", userId)
          .in("status", ["pending", "take", "call_again"]);
      }

      await audit(adminClient, user.id, user.email, "user.update", {
        target_type: "user",
        target_id: userId,
        target_name: body.full_name || target.full_name || target.email || null,
        // Never log the password itself — just note whether it was changed.
        payload: {
          full_name: body.full_name,
          email: body.email,
          password_changed: body.password !== undefined,
        },
      });
      return json({ success: true });
    }

    // PUT /api/users/:id/roles (admin only - set roles array)
    if (req.method === "PUT" && segments[0] === "users" && segments[2] === "roles") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const userId = segments[1];
      const body = await req.json();
      const { roles: newRoles } = body;

      if (!newRoles || !Array.isArray(newRoles) || newRoles.length === 0) {
        return json({ error: "At least one role is required" }, 400);
      }
      const validRoles = ["admin", "manager", "agent", "pending_agent", "prediction_agent", "warehouse", "ads_admin", "affiliate"];
      if (newRoles.some((r: string) => !validRoles.includes(r))) {
        return json({ error: `Roles must be one of: ${validRoles.join(", ")}` }, 400);
      }
      // Managers can only set agent-level roles
      if (isManager && !isAdmin) {
        const allowedForManager = ["pending_agent", "prediction_agent"];
        if (newRoles.some((r: string) => !allowedForManager.includes(r))) {
          return json({ error: "Managers can only assign Pending Agent or Prediction Agent roles" }, 400);
        }
      }
      // Prevent admin from changing own roles
      if (userId === user.id) {
        return json({ error: "Cannot change your own roles" }, 400);
      }

      // Delete existing roles and insert new ones.
      // Upsert because the admin_grant_all_roles trigger may already have
      // inserted some of these rows (when 'admin' is in newRoles, the trigger
      // backfills every other role for that user).
      await adminClient.from("user_roles").delete().eq("user_id", userId);
      for (const r of newRoles) {
        await adminClient
          .from("user_roles")
          .upsert({ user_id: userId, role: r }, { onConflict: "user_id,role" });
      }

      await audit(adminClient, user.id, user.email, "user.set_roles", {
        target_type: "user",
        target_id: userId,
        payload: { roles: newRoles },
      });
      return json({ success: true, roles: newRoles });
    }

    // PATCH /api/users/:id/role (legacy - admin only)
    // ADMIN ONLY: this endpoint can set 'admin' and replaces ALL of a user's
    // roles with one. A manager must never reach it (they'd self-promote a
    // created account to admin). Managers assign their permitted agent roles
    // through PUT /users/:id/roles, which enforces its own allowlist.
    if (req.method === "PATCH" && segments[0] === "users" && segments[2] === "role") {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      const userId = segments[1];
      const body = await req.json();
      const { role: newRole } = body;
      if (!newRole || !["admin", "agent", "warehouse"].includes(newRole)) {
        return json({ error: "Role must be admin or agent" }, 400);
      }
      if (userId === user.id) {
        return json({ error: "Cannot change your own role" }, 400);
      }
      // Replace all roles with the single one (legacy behavior)
      await adminClient.from("user_roles").delete().eq("user_id", userId);
      await adminClient.from("user_roles").insert({ user_id: userId, role: newRole });
      await audit(adminClient, user.id, user.email, "user.set_role_legacy", {
        target_type: "user",
        target_id: userId,
        payload: { role: newRole },
      });
      return json({ success: true });
    }

    // POST /api/users/:id/toggle-active (admin, or manager on a non-privileged target)
    if (req.method === "POST" && segments[0] === "users" && segments[2] === "toggle-active") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const userId = segments[1];
      // Prevent admin from suspending themselves
      if (userId === user.id) {
        return json({ error: "Cannot suspend yourself" }, 400);
      }
      // A manager may manage AGENT accounts but must never suspend an admin or
      // another manager. Only admins can act on privileged targets.
      if (!isAdmin && await targetHasPrivilegedRole(adminClient, userId)) {
        return json({ error: "Forbidden — only an admin can manage this account" }, 403);
      }
      const { data: profile } = await adminClient
        .from("profiles")
        .select("is_active")
        .eq("user_id", userId)
        .single();
      if (!profile) return json({ error: "User not found" }, 404);

      await adminClient
        .from("profiles")
        .update({ is_active: !profile.is_active })
        .eq("user_id", userId);

      await audit(adminClient, user.id, user.email, "user.toggle_active", {
        target_type: "user",
        target_id: userId,
        payload: { is_active: !profile.is_active },
      });
      return json({ success: true, is_active: !profile.is_active });
    }

    // DELETE /api/users/:id (admin, or manager on a non-privileged target)
    if (req.method === "DELETE" && segments[0] === "users" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "users.delete", 10)) return json({ error: "Rate limit exceeded — try again in a minute" }, 429);
      const userId = segments[1];
      // Prevent admin from deleting themselves
      if (userId === user.id) {
        return json({ error: "Cannot delete yourself" }, 400);
      }
      // A manager may remove AGENT accounts but must never delete an admin or
      // another manager. Only admins can act on privileged targets.
      if (!isAdmin && await targetHasPrivilegedRole(adminClient, userId)) {
        return json({ error: "Forbidden — only an admin can manage this account" }, 403);
      }
      // Capture name before deletion so the audit row is human-readable.
      const { data: deletedProfile } = await adminClient
        .from("profiles")
        .select("full_name, email")
        .eq("user_id", userId)
        .single();

      // Delete role, profile, then auth user
      await adminClient.from("user_roles").delete().eq("user_id", userId);
      await adminClient.from("profiles").delete().eq("user_id", userId);
      const { error: delErr } = await adminClient.auth.admin.deleteUser(userId);
      if (delErr) return json({ error: sanitizeDbError(delErr) }, 400);

      await audit(adminClient, user.id, user.email, "user.delete", {
        target_type: "user",
        target_id: userId,
        target_name: deletedProfile?.full_name || deletedProfile?.email || null,
      });
      return json({ success: true });
    }

    // GET /api/users (admin only)
    if (req.method === "GET" && path === "users") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      const { data: users } = await adminClient
        .from("profiles")
        .select("*")
        .order("created_at", { ascending: false });

      // Get all roles in one query (multiple roles per user)
      const userIds = (users || []).map((u: any) => u.user_id);
      const { data: allRoles } = await adminClient
        .from("user_roles")
        .select("user_id, role")
        .in("user_id", userIds.length > 0 ? userIds : ["__none__"]);

      const roleMap: Record<string, string[]> = {};
      for (const r of allRoles || []) {
        if (!roleMap[r.user_id]) roleMap[r.user_id] = [];
        roleMap[r.user_id].push(r.role);
      }

      // Get stats for each user
      const enriched = await Promise.all(
        (users || []).map(async (u: any) => {
          const { count: ordersProcessed } = await adminClient
            .from("orders")
            .select("id", { count: "exact", head: true })
            .eq("assigned_agent_id", u.user_id);

          const { count: leadsProcessed } = await adminClient
            .from("prediction_leads")
            .select("id", { count: "exact", head: true })
            .eq("assigned_agent_id", u.user_id);

          const userRoles = roleMap[u.user_id] || ["agent"];
          return {
            ...u,
            roles: userRoles,
            role: userRoles.includes("admin") ? "admin" : userRoles[0] || "agent", // legacy compat
            orders_processed: ordersProcessed || 0,
            leads_processed: leadsProcessed || 0,
          };
        })
      );

      return json(enriched);
    }

    // GET /api/users/agents (list active assignable users - agents and admins)
    // ?include_historic=1 additionally returns the name-only operators from the
    // imported history (see below) — for REPORT filters only, never assignment.
    if (req.method === "GET" && path === "users/agents") {
      const includeHistoric = url.searchParams.get("include_historic") === "1";
      const { data: allUsers } = await adminClient
        .from("profiles")
        .select("user_id, full_name, email")
        .eq("is_active", true);

      // Get all roles for active users
      const userIds = (allUsers || []).map((u: any) => u.user_id);
      const { data: allRoles } = await adminClient
        .from("user_roles")
        .select("user_id, role")
        .in("user_id", userIds.length > 0 ? userIds : ["__none__"]);

      const roleMap: Record<string, string[]> = {};
      for (const r of allRoles || []) {
        if (!roleMap[r.user_id]) roleMap[r.user_id] = [];
        roleMap[r.user_id].push(r.role);
      }

      // Filter to users with agent OR admin role (assignable users)
      const assignableUsers = (allUsers || [])
        .filter((u: any) => {
          const roles = roleMap[u.user_id] || [];
          return roles.includes("agent") || roles.includes("pending_agent") || roles.includes("prediction_agent") || roles.includes("admin");
        })
        .map((u: any) => ({
          ...u,
          roles: roleMap[u.user_id] || [],
        }));

      if (!includeHistoric) return json(assignableUsers);

      // ── Historic (name-only) operators ───────────────────────────────────
      // The imported AlterCPA history records WHO sold each order as a name and
      // never a user id — 26 operators who never had a CRM login. Reports that
      // credit those orders (/api/agent-performance) therefore show "virtual"
      // rows keyed `name:<normalised>`. Their filter dropdown read profiles
      // alone, so 64 of the 70 owners in the Agents table could not be selected.
      //
      // Only report filters ask for these. They are NOT assignable — there is no
      // account to assign to — so every assignment surface keeps the default
      // (profiles-only) list. `is_virtual` lets the UI say so out loud.
      //
      // Keys come from the SAME agentIdentityKey()/buildAgentIdentityIndex() pair
      // that agent-performance groups its rows with, so a dropdown option can
      // never drift into matching zero rows.
      if (!isAdminOrManager) return json(assignableUsers);

      const { data: operatorNames, error: opNameErr } = await adminClient.rpc("order_operator_names");
      if (opNameErr) {
        // A missing/failed RPC must not blank the dropdown — degrade to accounts.
        console.error("order_operator_names failed:", opNameErr.message);
        return json(assignableUsers);
      }

      // Fold every spelling of a name onto one identity, and onto a real account
      // when one exists — so "Сашка Симоновска" and "Saska Simonovska" are not
      // two more options beside the "Sashka Simonovska" who already owns them.
      const idByIdentity = buildAgentIdentityIndex(allUsers as any);

      // key → { orders, variants }. The display name is the spelling the most
      // orders actually use, so the operator recognises the option they pick.
      const historicByKey: Record<string, { orders: number; variants: Record<string, number> }> = {};
      for (const row of operatorNames || []) {
        const key = agentIdentityKey(row.operator_name);
        if (!key) continue;
        if (idByIdentity[key]) continue;   // already listed as a real account
        const n = Number(row.order_count || 0);
        const bucket = (historicByKey[key] ??= { orders: 0, variants: {} });
        bucket.orders += n;
        const label = normAgentName(row.operator_name);
        bucket.variants[label] = (bucket.variants[label] || 0) + n;
      }

      const historic = Object.entries(historicByKey)
        .sort((a, b) => b[1].orders - a[1].orders)
        .map(([key, v]) => ({
          user_id: `name:${key}`,
          full_name: Object.entries(v.variants).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
          email: "",
          roles: [] as string[],
          is_virtual: true,
          order_count: v.orders,
        }));

      return json([...assignableUsers, ...historic]);
    }

    // POST /api/orders (create order — admin/manager/agent)
    if (req.method === "POST" && path === "orders") {
      if (!canMutateOrders) return json({ error: "Forbidden" }, 403);
      let body;
      try { body = parseBody(createOrderSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }

      // Determine status: agents can only set confirmed or call_again
      const status = body.status || "pending";
      // If agent (not admin), auto-assign to self
      const { data: agentProfile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
      const agentName = agentProfile?.full_name || user.email;

      const assignToSelf = !isAdminOrManager;
      const assignedAgentId = assignToSelf ? user.id : null;
      const assignedAgentName = assignToSelf ? agentName : null;

      // ── ANTI-FORK GUARD (2026-08-10) ────────────────────────────────────────
      // A customer who already has a live lead must have THAT order completed —
      // never a second one created beside it. Reaching a customer on the second
      // call (their lead sitting in 'call_again') used to produce a brand-new
      // source_type='manual' order: the AlterCPA lead stayed stuck in call_again
      // forever and the sale was invisible on the lead it came from. BG saw 24
      // such pairs in two days before this guard existed.
      //
      // The Calls page resolves the lead before opening the modal; this is the
      // server-side backstop that makes forking impossible from ANY surface.
      // Scope: leads nobody owns or the caller's own (admins/managers see all) —
      // a colleague's lead must not block an unrelated record.
      //
      // NO EXEMPTION for cancelled/trashed, deliberately. /calls creates a
      // synthetic closing row when a customer has no order at all — but if an
      // open lead DOES exist and the agent cancels, letting the synthetic row
      // through is precisely the orphaned-outcome bug: the cancel lands on a
      // throwaway record while the real lead sits open forever. The frontend
      // resolves the lead first (resolveOpenLeadId), so the synthetic path is
      // only reached when there genuinely is nothing to complete.
      if (body.customer_phone) {
        const fdigits = String(body.customer_phone).replace(/\D/g, "");
        const flast8 = fdigits.length >= 8 ? fdigits.slice(-8) : "";
        if (flast8) {
          let leadQ = adminClient
            .from("orders")
            .select("id, display_id, status, assigned_agent_name")
            .ilike("customer_phone", `%${flast8}`)
            .in("status", ["pending", "take", "call_again", "duplicated"])
            .order("created_at", { ascending: false })
            .limit(1);
          // Unassigned leads block too. BG's first version scoped agents to their
          // OWN leads, reasoning that the take lock would have claimed anything
          // they were working — but a lead left with assigned_agent_id NULL by
          // the old take-lock bug slipped straight through and was forked within
          // hours of the deploy. A lead nobody owns is still a lead. Opening the
          // customer on /calls claims it, and the modal then completes it in
          // place; this 409 is what sends them there.
          if (!isAdminOrManager) {
            leadQ = leadQ.or(`assigned_agent_id.is.null,assigned_agent_id.eq.${user.id}`);
          }
          const { data: openLead } = await leadQ.maybeSingle();
          if (openLead) {
            const owner = openLead.assigned_agent_name
              ? ` It belongs to ${openLead.assigned_agent_name}.`
              : "";
            return json({
              error: `This customer already has an open lead (${openLead.display_id}, ${openLead.status}).${owner} Open the customer on the Calls page and complete that order — do not create a second one.`,
              code: "open_lead_exists",
              existing_order_id: openLead.id,
              existing_display_id: openLead.display_id,
              existing_status: openLead.status,
            }, 409);
          }
        }
      }

      // Calculate total from items if provided
      const hasItems = body.items && body.items.length > 0;
      let totalPrice = body.price || 0;
      let totalQty = body.quantity || 1;
      let productSummary = body.product_name;

      if (hasItems) {
        totalPrice = body.items.reduce((s: number, i: any) => s + (i.quantity * i.price_per_unit), 0);
        totalQty = body.items.reduce((s: number, i: any) => s + i.quantity, 0);
        // Build nice "Name xN" summary for the denormalized field
        productSummary = body.items
          .map((i: any) => (i.quantity > 1 ? `${i.product_name} x${i.quantity}` : i.product_name))
          .join(", ");
      }

      // Office orders take the courier office's own post code; home orders keep
      // whatever the agent entered from the settlement picker.
      const officePostCode = await resolveOfficePostCode(body.delivery_type ?? "home", body.courier_office_code);
      const resolvedPostalCode = officePostCode ?? body.postal_code;

      // Stamp the MEX routing zone so the order can be handed to the courier.
      const mexZone = await resolveMexCity(body.customer_city);

      // Snapshot the prediction list the customer was in (drives list-ROI
      // analytics + per-package agent bonuses). Stamped for ALL statuses so a
      // cancelled prediction order still counts toward that list's cancels.
      const predictionAttr = await resolvePredictionAttribution(body.customer_phone);

      // Backfill a blank name from any order/segment sharing the phone. Stops
      // cancel/trash call-outcome records (where the agent couldn't see the
      // original named order via RLS) from landing nameless on /orders.
      let resolvedCustomerName = body.customer_name;
      if ((!resolvedCustomerName || !resolvedCustomerName.trim()) && body.customer_phone) {
        resolvedCustomerName = (await resolveKnownCustomerName(body.customer_phone)) || resolvedCustomerName;
      }

      const { data: order, error: orderErr } = await adminClient
        .from("orders")
        .insert({
          product_id: body.product_id,
          product_name: productSummary,
          customer_name: resolvedCustomerName,
          customer_phone: body.customer_phone,
          customer_city: body.customer_city,
          customer_address: body.customer_address,
          postal_code: resolvedPostalCode,
          mex_city_id: mexZone.id,
          mex_city_name: mexZone.name,
          street: body.street ?? "",
          street_number: body.street_number ?? "",
          quarter: body.quarter ?? "",
          apartment: body.apartment ?? "",
          floor: body.floor ?? "",
          block: body.block ?? "",
          entry: body.entry ?? "",
          delivery_instructions: body.delivery_instructions ?? "",
          gift_note: body.gift_note ?? "",
          delivery_type: body.delivery_type ?? "home",
          home_courier: body.home_courier ?? null,
          courier_office_code: body.courier_office_code ?? "",
          courier_office_name: body.courier_office_name ?? "",
          courier_office_city: body.courier_office_city ?? "",
          birthday: body.birthday,
          ship_after_date: body.ship_after_date ?? null,
          price: totalPrice,
          quantity: totalQty,
          status,
          // Store the structured cancel reason on the order when the agent
          // creates it as cancelled, so the segment trigger can route the
          // customer to the right Cancelled mirror list.
          cancellation_reason: status === "cancelled" ? (body.cancellation_reason ?? null) : null,
          cancellation_reason_notes: status === "cancelled" ? (body.cancellation_reason_notes ?? null) : null,
          // Synthetic cancelled records (logged from the Calls page) are created
          // straight as 'cancelled' — stamp WHEN and WHO so reports/exports have a
          // real cancellation timestamp + attribution (the BEFORE trigger also
          // guarantees cancelled_at, this keeps the agent and is explicit here).
          cancelled_at: status === "cancelled" ? new Date().toISOString() : null,
          cancelled_by_agent_id: status === "cancelled" ? user.id : null,
          // Symmetric with the cancel reason above: store the structured trash
          // reason when the agent records the call outcome directly as 'trashed'.
          trash_reason: status === "trashed" ? (body.trash_reason ?? null) : null,
          trash_reason_notes: status === "trashed" ? (body.trash_reason_notes ?? null) : null,
          source_type: "manual",
          prediction_list_id: predictionAttr?.id ?? null,
          prediction_list_type: predictionAttr?.type ?? null,
          prediction_list_name: predictionAttr?.name ?? null,
          prediction_list_category: predictionAttr?.category ?? null,
          assigned_agent_id: assignedAgentId,
          assigned_agent_name: assignedAgentName,
          assigned_at: assignToSelf ? new Date().toISOString() : null,
          // Credit the confirmer (the real creator, even an admin) so analytics
          // attribute the order correctly and never to "Unknown operator".
          confirmed_by_agent_id: REAL_ORDER_STATUSES.includes(status) ? user.id : null,
          confirmed_by_name: REAL_ORDER_STATUSES.includes(status) ? agentName : null,
          confirmed_at: REAL_ORDER_STATUSES.includes(status) ? new Date().toISOString() : null,
        })
        .select()
        .single();

      if (orderErr) return json({ error: sanitizeDbError(orderErr) }, 400);

      // TV leaderboard: nudge the wall screen the instant an order is confirmed.
      if (REAL_ORDER_STATUSES.includes(status)) {
        await broadcastLeaderboard("confirmed", { agent_id: user.id, order_id: order.id });
      }

      // Insert order items
      if (hasItems) {
        const orderItems = body.items.map((i: any) => ({
          order_id: order.id,
          product_id: i.product_id || null,
          product_name: i.product_name,
          quantity: i.quantity,
          price_per_unit: i.price_per_unit,
          total_price: Math.round(i.quantity * i.price_per_unit * 100) / 100,
        }));
        await adminClient.from("order_items").insert(orderItems);
      }

      // Add notes if provided
      if (body.notes && body.notes.trim()) {
        await adminClient.from("order_notes").insert({
          order_id: order.id,
          text: body.notes.trim(),
          author_id: user.id,
          author_name: agentName,
        });
      }

      // Log creation in order history
      await adminClient.from("order_history").insert({
        order_id: order.id,
        to_status: status,
        changed_by: user.id,
        changed_by_name: agentName,
      });
      // Add source note — but only for real sales orders.
      // For synthetic cancelled/trashed records created from the Calls page
      // (to log the outcome + reason), we don't want to pollute the notes
      // with "Manual Order Created". The actual reason is already recorded
      // via cancellation_reason_notes / notes.
      if (!["cancelled", "trashed"].includes(status)) {
        await adminClient.from("order_notes").insert({
          order_id: order.id,
          text: "Manual Order Created",
          author_id: user.id,
          author_name: "System",
        });
      }

      // Creating any order for this customer — a real sale or a synthetic
      // cancel/trash record — is "leaving a mark": release the obligation.
      await clearCallObligation(adminClient, user.id, order.customer_phone);

      return json(order);
    }

    // POST /api/orders/import (bulk historical-order import — admin only)
    // Turns a CSV/Excel of real past orders into real `orders` rows (+ one
    // order_items line + a provenance order_note each), exactly like the
    // import-cpa-xlsx.mjs script but adapted for Macedonia: money is already EUR,
    // phones normalize to +389, no lev peg, no transliteration. Importing these
    // also feeds the segments engine (it recomputes from order history), which is
    // the whole point — it backfills the prediction lists. Optionally upserts
    // customer_profiles so future calls to the number pre-fill name + address.
    if (req.method === "POST" && path === "orders/import") {
      if (!isAdmin) return json({ error: "Forbidden" }, 403);
      let body;
      try { body = parseBody(orderImportSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }

      const externalSource = (body.source || "import").trim();
      const upsertProfiles = body.upsert_profiles !== false;
      const nowIso = new Date().toISOString();

      // Catalogue snapshot — match products in memory by name, then sku (some
      // sheets put a code in the product column). Unmatched rows still import
      // with product_id null, keeping the raw text in product_name.
      const { data: catRows } = await adminClient.from("products").select("id, name, sku");
      const catalogue = catRows || [];
      const byName = new Map(
        catalogue.filter((c: any) => c.name).map((c: any) => [String(c.name).toLowerCase().trim(), c]),
      );
      const bySku = new Map(
        catalogue.filter((c: any) => c.sku).map((c: any) => [String(c.sku).toLowerCase().trim(), c]),
      );

      type Prepared = {
        row: any; phone: string; productId: string | null; productName: string;
        createdAt: string | null; status: string; extId: string;
      };
      const prepared: Prepared[] = [];
      let skippedNoPhone = 0;
      for (const r of body.rows) {
        const phone = normalizeMkPhone(r.customer_phone || "");
        if (!phone) { skippedNoPhone++; continue; }
        const key = (r.product_name || "").toLowerCase().trim();
        const prod = key ? (byName.get(key) || bySku.get(key) || null) : null;
        prepared.push({
          row: r,
          phone,
          productId: prod ? prod.id : null,
          productName: prod ? prod.name : ((r.product_name || "").trim() || "—"),
          createdAt: parseImportDate(r.order_date),
          status: r.status || "paid",
          extId: (r.external_order_id || "").trim(),
        });
      }

      // Dedupe against already-imported orders (one query) AND within this batch,
      // both keyed on external_order_id. Rows without an order number can't be
      // deduped, so they always insert.
      const extIds = [...new Set(prepared.map((p) => p.extId).filter(Boolean))];
      const existingExt = new Set<string>();
      if (extIds.length) {
        const { data: ex } = await adminClient
          .from("orders")
          .select("external_order_id")
          .eq("external_source", externalSource)
          .in("external_order_id", extIds);
        for (const e of (ex || [])) existingExt.add(String(e.external_order_id));
      }

      const toInsert: Prepared[] = [];
      const seenExt = new Set<string>();
      let duplicates = 0;
      for (const p of prepared) {
        if (p.extId) {
          if (existingExt.has(p.extId) || seenExt.has(p.extId)) { duplicates++; continue; }
          seenExt.add(p.extId);
        }
        toInsert.push(p);
      }

      const orderRows = toInsert.map((p) => {
        const real = REAL_ORDER_STATUSES.includes(p.status);
        const created = p.createdAt || nowIso;
        return {
          product_id: p.productId,
          product_name: p.productName,
          customer_name: (p.row.customer_name || "").trim() || "—",
          customer_phone: p.phone,
          customer_city: p.row.customer_city || "",
          customer_address: p.row.customer_address || "",
          postal_code: p.row.postal_code || "",
          price: Number(p.row.price) || 0,
          quantity: Number(p.row.quantity) || 1,
          status: p.status,
          source_type: "import",
          external_source: externalSource,
          external_order_id: p.extId || null,
          created_at: created,
          // Historical orders have no live agent — stamp a text confirmer only so
          // analytics don't attribute them to a real person, but real-sale
          // statuses still carry a confirmed_at for time-series reports.
          confirmed_at: real ? created : null,
          confirmed_by_name: real ? "Import" : null,
        };
      });

      // Batch insert; on failure fall back to per-row so one bad row can't sink
      // the batch. Postgres returns rows in insertion order, so index i maps back
      // to toInsert[i] (same convention as import-cpa-xlsx.mjs).
      const insertedIdx: { id: string; i: number }[] = [];
      let failed = 0;
      if (orderRows.length) {
        const { data, error } = await adminClient.from("orders").insert(orderRows).select("id");
        if (!error && data) {
          data.forEach((o: any, i: number) => insertedIdx.push({ id: o.id, i }));
        } else {
          for (let i = 0; i < orderRows.length; i++) {
            const { data: one, error: e1 } = await adminClient.from("orders").insert([orderRows[i]]).select("id");
            if (e1 || !one?.[0]) { failed++; continue; }
            insertedIdx.push({ id: one[0].id, i });
          }
        }
      }

      // Line items + provenance note for every successfully inserted order.
      if (insertedIdx.length) {
        const itemRows = insertedIdx.map(({ id, i }) => {
          const p = toInsert[i];
          const qty = Number(p.row.quantity) || 1;
          const price = Number(p.row.price) || 0;
          return {
            order_id: id,
            product_id: p.productId,
            product_name: p.productName,
            quantity: qty,
            price_per_unit: Math.round((price / qty) * 100) / 100,
            total_price: price,
          };
        });
        const { error: itemErr } = await adminClient.from("order_items").insert(itemRows);
        if (itemErr) console.warn("orders/import: order_items insert warning:", itemErr.message);

        const noteRows = insertedIdx.map(({ id, i }) => {
          const p = toInsert[i];
          const bits = [
            `Imported from "${externalSource}"${p.extId ? ` (order #${p.extId})` : ""}`,
            p.row.order_date ? `Original date: ${p.row.order_date}` : "",
            (!p.createdAt && p.row.order_date) ? "(date could not be parsed — placed at import time)" : "",
            p.row.note ? `Note: ${p.row.note}` : "",
          ].filter(Boolean);
          return { order_id: id, text: bits.join("\n"), author_id: null, author_name: "System (Order Import)" };
        });
        const { error: noteErr } = await adminClient.from("order_notes").insert(noteRows);
        if (noteErr) console.warn("orders/import: order_notes insert warning:", noteErr.message);
      }

      // Customer profiles — upsert per phone so future calls pre-fill. Only write
      // fields we actually have (never blank out an existing profile), and dedupe
      // by phone keeping the last seen values. Per-row upsert avoids the
      // bulk-upsert null-clobber on heterogeneous columns.
      if (upsertProfiles && insertedIdx.length) {
        const profileByPhone = new Map<string, Record<string, any>>();
        for (const { i } of insertedIdx) {
          const p = toInsert[i];
          const prof = profileByPhone.get(p.phone) || { phone: p.phone };
          if ((p.row.customer_name || "").trim()) prof.customer_name = p.row.customer_name.trim();
          if ((p.row.customer_city || "").trim()) prof.city = p.row.customer_city.trim();
          if ((p.row.customer_address || "").trim()) prof.street = p.row.customer_address.trim();
          if ((p.row.postal_code || "").trim()) prof.postal_code = p.row.postal_code.trim();
          prof.updated_by = user.id;
          prof.updated_at = nowIso;
          profileByPhone.set(p.phone, prof);
        }
        for (const prof of profileByPhone.values()) {
          const { error: profErr } = await adminClient
            .from("customer_profiles")
            .upsert(prof, { onConflict: "phone" });
          if (profErr) { console.warn("orders/import: profile upsert warning:", profErr.message); break; }
        }
      }

      return json({
        success: true,
        total: body.rows.length,
        created: insertedIdx.length,
        duplicates,
        skipped_no_phone: skippedNoPhone,
        failed,
      });
    }

    // GET /api/orders
    if (req.method === "GET" && path === "orders") {
      const status = url.searchParams.get("status");
      const search = url.searchParams.get("search");
      const agentId = url.searchParams.get("agent_id");
      const source = url.searchParams.get("source");
      // Calling-bucket only: skip orders parked by a recent no-answer
      // (next_call_after still in the future). The admin Orders list never
      // sets this, so parked pendings still show there.
      const readyOnly = url.searchParams.get("ready_only") === "1";
      // Inbound leads only — the /calls Pendings queue and the Assigner's
      // per-agent lead rows. Keeps agent-created `manual` work (everything
      // produced while working a prediction list) and the legacy `import` out of
      // the lead surfaces. Same definition as public.is_lead_source().
      const leadOnly = url.searchParams.get("lead_only") === "1";
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const priceMin = url.searchParams.get("price_min");
      const priceMax = url.searchParams.get("price_max");
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "20");

      // Only admins/managers may use the elevated client. Agents are always
      // restricted by RLS — search must not bypass row-level access controls.
      const isGlobalSearch = false;
      const client = isAdminOrManager ? adminClient : supabase;

      // An exact COUNT(*) over 80k rows is a full scan on EVERY request — every
      // page turn, every filter change, every keystroke in the search box. When
      // nothing is filtered, nobody is reading that total to the unit ("80,360"
      // vs "~80,300" changes no decision), so use the planner's estimate. As
      // soon as a filter narrows the set the number starts mattering and the
      // set is small, so go exact.
      const isFiltered = Boolean(
        (status && status !== "all") || (agentId && agentId !== "all") ||
        (source && source !== "all") || from || to || priceMin || priceMax ||
        search || readyOnly || leadOnly,
      );
      let query = client
        .from("orders")
        .select("*, order_items(id, product_id, product_name, quantity, price_per_unit, total_price)",
                { count: isFiltered ? "exact" : "estimated" })
        .order("created_at", { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

      if (status && status !== "all") {
        // Supports a single status or a comma-separated list (multi-select filter).
        const statuses = status.split(",").map((s) => s.trim()).filter(Boolean);
        if (statuses.length > 1) query = query.in("status", statuses);
        else if (statuses.length === 1) query = query.eq("status", statuses[0]);
      }
      if (agentId && agentId !== "all") query = query.eq("assigned_agent_id", agentId);
      if (source && source !== "all") query = query.eq("source_type", source);
      if (leadOnly) query = query.in("source_type", LEAD_SOURCE_TYPES);
      if (from) query = query.gte("created_at", from);
      if (to) query = query.lte("created_at", to);
      if (priceMin) {
        const n = Number(priceMin);
        if (Number.isFinite(n)) query = query.gte("price", n);
      }
      if (priceMax) {
        const n = Number(priceMax);
        if (Number.isFinite(n)) query = query.lte("price", n);
      }
      if (search) {
        const s = sanitizeSearch(search);
        if (s) query = query.or(`display_id.ilike.%${s}%,customer_name.ilike.%${s}%,customer_phone.ilike.%${s}%,product_name.ilike.%${s}%`);
      }
      if (readyOnly) {
        const nowIso = new Date().toISOString();
        query = query.or(`next_call_after.is.null,next_call_after.lte.${nowIso}`);
      }
      // Agents work duplicates since 2026-08-13 (operator decision): admins and
      // managers create them, agents follow up and settle them, so agents must
      // see them here too. `duplicated_from` is PERMANENT, so a filter here would
      // hide an agent's own settled duplicates from their tabs forever.

      const { data: orders, count, error } = await query;
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Who last acted on each order (confirmed / cancelled / call_again / …).
      // Every order has at least its creation row in order_history, so this is
      // always populated. Drives the Orders list "Handled By" column.
      const pageOrderIds = (orders || []).map((o: any) => o.id);
      const lastActionBy: Record<string, string> = {};
      if (pageOrderIds.length) {
        const { data: hist } = await adminClient
          .from("order_history")
          .select("order_id, changed_by_name, changed_at")
          .in("order_id", pageOrderIds)
          .order("changed_at", { ascending: false });
        for (const h of hist || []) {
          if (!lastActionBy[h.order_id] && h.changed_by_name) lastActionBy[h.order_id] = h.changed_by_name;
        }
      }

      // Add is_owned flag for agents
      const enrichedOrders = (orders || []).map((o: any) => ({
        ...o,
        is_owned: isAdminOrManager || o.assigned_agent_id === user.id,
        last_action_by: lastActionBy[o.id] || o.assigned_agent_name || null,
      }));

      return json({ orders: redactCustomerList(enrichedOrders, piiFlags), total: count, page, limit });
    }

    // GET /api/my-pendings-summary — counts for the "Pendings" queue entry on
    // /calls. ALWAYS scoped to the caller (auth.uid()); there is deliberately no
    // agent_id parameter, so this can never be used to read someone else's book.
    //
    //   ready        — assigned to me, still in the lead lifecycle, callable now
    //                  (same next_call_after predicate as ?ready_only=1 above)
    //   open         — assigned to me, still in the lead lifecycle, incl. parks
    //   parked       — open - ready
    //
    // "Lead lifecycle" = pending | take | call_again, and the source must be an
    // inbound one (LEAD_SOURCE_TYPES) — identical to the ?lead_only=1 query the
    // /calls queue runs, so the badge can never disagree with the queue.
    // Counting 'pending' alone made a lead vanish from the badge after its first
    // no-answer even though the agent still had to call it back; counting every
    // source dragged prediction-list work in.
    //   talked_today — leads assigned to me that I moved OUT of the pending
    //                  lifecycle today (Europe/Skopje), from order_history.
    //
    // Kept in the edge function rather than a PostgREST-readable view/RPC on
    // purpose: affiliates hold real Supabase logins, so nothing new may become
    // readable to `authenticated`. The affiliate hard wall above already 403s
    // external partners on every path but `me`.
    if (req.method === "GET" && path === "my-pendings-summary") {
      const nowIso = new Date().toISOString();

      const LEAD_LIFECYCLE = ["pending", "take", "call_again"];

      const openQ = adminClient
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("assigned_agent_id", user.id)
        .in("status", LEAD_LIFECYCLE)
        .in("source_type", LEAD_SOURCE_TYPES);

      const readyQ = adminClient
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("assigned_agent_id", user.id)
        .in("status", LEAD_LIFECYCLE)
        .in("source_type", LEAD_SOURCE_TYPES)
        .or(`next_call_after.is.null,next_call_after.lte.${nowIso}`);

      const [{ count: openCount }, { count: readyCount }] = await Promise.all([openQ, readyQ]);

      // "Talked" = a lead of mine left `pending`/`take` today by my hand. Counted
      // from order_history (distinct orders) so a lead I touched twice counts once.
      const { startISO } = skopjeDayStart();
      const { data: touched } = await adminClient
        .from("order_history")
        .select("order_id, orders!inner(assigned_agent_id)")
        .eq("changed_by", user.id)
        .gte("changed_at", startISO)
        .in("to_status", ["confirmed", "cancelled", "trashed", "call_again"])
        .eq("orders.assigned_agent_id", user.id)
        .limit(2000);

      const open = openCount ?? 0;
      const ready = readyCount ?? 0;
      return json({
        ready,
        open,
        parked: Math.max(0, open - ready),
        talked_today: new Set((touched || []).map((r: any) => r.order_id)).size,
      });
    }

    // GET /api/orders/open-lead?phone=... — the customer's open orders.
    //
    // Whoever is on the customer must be able to close out the order that
    // already exists, whoever it was assigned to (operator rule, 2026-08-10).
    // The agent's own queue is deliberately scoped to them, and RLS hides a
    // colleague's row, so without this the Calls page could not find the lead
    // and Confirm fell through to creating a second order — THE FORK BUG. This
    // endpoint is the anti-fork lookup every disposition on /calls runs first.
    //
    // Narrow on purpose: keyed by phone (the agent is already looking at that
    // customer), open states only, and it returns just enough to target the
    // order — never the customer record. Affiliates are 403'd by the hard wall.
    // Suffix match, never `%last8%`: a substring could return a DIFFERENT
    // customer's order and the disposition would land on the wrong person.
    if (req.method === "GET" && path === "orders/open-lead") {
      const raw = (url.searchParams.get("phone") || "").trim();
      const digits = raw.replace(/\D/g, "");
      const last8 = digits.length >= 8 ? digits.slice(-8) : "";
      if (!last8) return json({ lead: null, leads: [] });
      // ALL open orders, newest first. Since duplicates became workable a customer
      // can legitimately have several open orders at once (a pending lead AND a
      // duplicate), so the caller must let the agent PICK when there is more than
      // one — BG confirmed the WRONG order because the flow silently took the
      // queue row (2026-08-12). `lead` stays for older bundles still in a browser.
      const { data: leads } = await adminClient
        .from("orders")
        .select("id, display_id, status, assigned_agent_id, assigned_agent_name, source_type, duplicated_from_display, created_at")
        .ilike("customer_phone", `%${last8}`)
        .in("status", ["pending", "take", "call_again", "duplicated"])
        .order("created_at", { ascending: false })
        .limit(5);
      return json({ lead: leads?.[0] ?? null, leads: leads ?? [] });
    }

    // GET /api/orders/unassigned-pending (admin only - for assigner)
    if (req.method === "GET" && path === "orders/unassigned-pending") {
      if (!canViewModule("assigner")) return json({ error: "Forbidden" }, 403);
      // Paginated: PostgREST silently caps an unpaginated select at 1000 rows,
      // which would understate the Pendings tab + its count. Columns narrowed
      // to what the assigner renders (UnassignedOrder interface).
      const all: any[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await adminClient
          .from("orders")
          .select("id, display_id, customer_name, customer_phone, product_name, source_type, created_at")
          .eq("status", "pending")
          .is("assigned_agent_id", null)
          .order("created_at", { ascending: false })
          .range(from, from + 999);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < 1000) break;
      }
      return json(all);
    }

    // GET /api/orders/assigned (admin only - all assigned orders for assigner)
    if (req.method === "GET" && path === "orders/assigned") {
      if (!canViewModule("assigner")) return json({ error: "Forbidden" }, 403);
      const { data: orders, error } = await adminClient
        .from("orders")
        .select("*")
        .not("assigned_agent_id", "is", null)
        .order("assigned_at", { ascending: false });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(orders || []);
    }

    // POST /api/orders/bulk-unassign (admin only)
    if (req.method === "POST" && path === "orders/bulk-unassign") {
      if (!canViewModule("assigner")) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "orders.bulk", 20)) return json({ error: "Rate limit exceeded — try again in a minute" }, 429);
      const body = await req.json();
      const { order_ids } = body;
      if (!order_ids?.length) return json({ error: "order_ids required" }, 400);

      const { error: updateErr } = await adminClient
        .from("orders")
        .update({
          assigned_agent_id: null,
          assigned_agent_name: null,
          assigned_at: null,
          assigned_by: null,
        })
        .in("id", order_ids);
      if (updateErr) return json({ error: sanitizeDbError(updateErr) }, 400);

      await audit(adminClient, user.id, user.email, "order.bulk_unassign", {
        target_type: "order",
        target_name: `${order_ids.length} orders`,
        payload: { order_ids, count: order_ids.length },
      });
      return json({ success: true, unassigned: order_ids.length });
    }

    // POST /api/orders/bulk-assign (admin only)
    if (req.method === "POST" && path === "orders/bulk-assign") {
      if (!canViewModule("assigner")) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "orders.bulk", 20)) return json({ error: "Rate limit exceeded — try again in a minute" }, 429);
      const body = await req.json();
      const { order_ids, agent_id } = body;
      if (!order_ids?.length || !agent_id) return json({ error: "order_ids and agent_id required" }, 400);

      const { data: agentProfile } = await adminClient
        .from("profiles")
        .select("full_name")
        .eq("user_id", agent_id)
        .single();
      if (!agentProfile) return json({ error: "Agent not found" }, 404);

      const { data: adminProfile } = await adminClient
        .from("profiles")
        .select("full_name")
        .eq("user_id", user.id)
        .single();

      const { error: updateErr } = await adminClient
        .from("orders")
        .update({
          assigned_agent_id: agent_id,
          assigned_agent_name: agentProfile.full_name,
          assigned_at: new Date().toISOString(),
          assigned_by: adminProfile?.full_name || "Admin",
        })
        .in("id", order_ids);
      if (updateErr) return json({ error: sanitizeDbError(updateErr) }, 400);

      await audit(adminClient, user.id, user.email, "order.bulk_assign", {
        target_type: "order",
        target_name: `${order_ids.length} orders → ${agentProfile.full_name}`,
        payload: { order_ids, agent_id, agent_name: agentProfile.full_name, count: order_ids.length },
      });

      // One summary ping to the agent (not one per order).
      if (agent_id !== user.id) {
        await notifyUsers(adminClient, [agent_id], {
          type: "assignment",
          title: "New orders assigned to you",
          message: `${order_ids.length} order${order_ids.length === 1 ? "" : "s"} assigned to you — open Assigned to Me.`,
          link: "/assigned",
        });
      }

      return json({ success: true, assigned: order_ids.length });
    }

    // POST /api/presence/heartbeat — any authenticated user pings this every
    // ~45s while the app is open. Bumps profiles.last_seen_at so agents/online
    // can tell who is actually here right now. Optional body { voip_state }
    // also records the softphone state (VoipContext posts every transition;
    // the 45s beat carries it only while non-idle so a second idle tab never
    // clobbers the calling tab's state).
    if (req.method === "POST" && path === "presence/heartbeat") {
      let hb: any = {};
      try { hb = await req.json(); } catch { /* legacy empty-body beats */ }
      const VOIP_STATES = ["idle", "dialing", "in_call", "wrapping", "ending"];
      const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
      if (typeof hb?.voip_state === "string" && VOIP_STATES.includes(hb.voip_state)) {
        patch.voip_state = hb.voip_state;
        patch.voip_state_at = new Date().toISOString();
      }
      await adminClient
        .from("profiles")
        .update(patch)
        .eq("user_id", user.id);
      return json({ ok: true });
    }

    // GET /api/agents/online (admin only - active agents with load info)
    if (req.method === "GET" && path === "agents/online") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      // An agent is "online" if they pinged the heartbeat in the last 2 min.
      const ONLINE_WINDOW_MS = 2 * 60 * 1000;
      // Browser-reported call state goes stale after ~4 missed 45s beats —
      // a crashed tab must not show "in call" forever.
      const CALL_STALE_MS = 3 * 60 * 1000;

      // Get active users with agent or admin role
      const { data: allUsers } = await adminClient
        .from("profiles")
        .select("user_id, full_name, email, last_seen_at, voip_state, voip_state_at")
        .eq("is_active", true);

      const userIds = (allUsers || []).map((u: any) => u.user_id);
      const { data: allRoles } = await adminClient
        .from("user_roles")
        .select("user_id, role")
        .in("user_id", userIds.length > 0 ? userIds : ["__none__"]);

      const roleMap: Record<string, string[]> = {};
      for (const r of allRoles || []) {
        if (!roleMap[r.user_id]) roleMap[r.user_id] = [];
        roleMap[r.user_id].push(r.role);
      }

      const agents = (allUsers || []).filter((u: any) => {
        const roles = roleMap[u.user_id] || [];
        return roles.includes("agent") || roles.includes("pending_agent") || roles.includes("prediction_agent") || roles.includes("admin");
      });

      // Per-agent workload in ONE aggregate RPC: open orders (pending|take|
      // call_again — same semantics as the old inline tally, which was an
      // unbounded select at risk of the 1000-row cap) + prediction-member
      // loads for the assigner agents panel.
      const agentIds = agents.map((a: any) => a.user_id);
      type Workload = { orders_open: number; members_assigned: number; members_open: number; members_parked: number };
      const workload: Record<string, Workload> = {};
      const { data: loads } = await adminClient.rpc("agent_workloads");
      for (const r of loads || []) {
        workload[r.agent_id] = {
          orders_open: r.orders_open || 0,
          members_assigned: r.members_assigned || 0,
          members_open: r.members_open || 0,
          members_parked: r.members_parked || 0,
        };
      }

      // Check TODAY's shifts only. The previous query forgot to filter on
      // shifts.date, so it surfaced shift times from any day. The !inner join
      // + .eq("shifts.date", today) restricts to assignments whose shift is
      // today.
      const today = new Date().toISOString().split("T")[0];
      const { data: todayShifts } = await adminClient
        .from("shift_assignments")
        .select("user_id, shifts!inner(start_time, end_time, date)")
        .in("user_id", agentIds.length > 0 ? agentIds : ["__none__"])
        .eq("shifts.date", today);

      const shiftMap: Record<string, any> = {};
      for (const sa of todayShifts || []) {
        shiftMap[sa.user_id] = sa.shifts;
      }

      const nowMs = Date.now();
      const result = agents.map((a: any) => {
        const lastSeen = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
        const isOnline = lastSeen > 0 && (nowMs - lastSeen) < ONLINE_WINDOW_MS;
        const stateAt = a.voip_state_at ? new Date(a.voip_state_at).getTime() : 0;
        const inCall = isOnline &&
          (a.voip_state === "dialing" || a.voip_state === "in_call") &&
          stateAt > 0 && (nowMs - stateAt) < CALL_STALE_MS;
        const w = workload[a.user_id];
        return {
          user_id: a.user_id,
          full_name: a.full_name,
          email: a.email,
          roles: roleMap[a.user_id] || [],
          active_leads: w?.orders_open ?? 0, // kept for backward compat (= orders_open)
          orders_open: w?.orders_open ?? 0,
          members_assigned: w?.members_assigned ?? 0,
          members_open: w?.members_open ?? 0,
          members_parked: w?.members_parked ?? 0,
          shift: shiftMap[a.user_id] || null,
          last_seen_at: a.last_seen_at || null,
          is_online: isOnline,
          in_call: inCall,
          voip_state: inCall ? a.voip_state : "idle",
        };
      });

      return json(result);
    }
    // POST /api/orders/bulk-disposition — bulk trash / cancel WITH A REASON.
    //
    // Rule 8 (2026-08-10): no order is junked without a reason, bulk paths
    // included. The Orders page previously offered no way to clear a batch of
    // dead leads at all, so operators either left them rotting in the queue or
    // reached for bulk-status-update, which writes no reason and leaves the
    // cancel insights unusable.
    //
    // ⚠ MACEDONIA: BG's version ends by nudging the affiliate postback drain.
    // That is deliberately ABSENT here. This project mirrors AlterCPA one-way —
    // we poll them, nothing goes back automatically (.grok/skills/
    // elyon-altercpa-bridge, decision #3). `affiliates`, `affiliate_leads` and
    // `affiliate_postbacks` are all empty and tg_enqueue_affiliate_postback
    // reads affiliate_leads, so there is nothing to drain. Do not "restore" the
    // nudge — it would open an AUTOMATIC outbound channel this market does not
    // have. The only outbound path is the manual, per-order
    // POST /orders/:id/altercpa-push button (2026-08-14) — a separate,
    // operator-triggered route that must never be called from bulk paths.
    if (req.method === "POST" && path === "orders/bulk-disposition") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "orders.bulk", 20)) {
        return json({ error: "Rate limit exceeded — try again in a minute" }, 429);
      }
      let body;
      try { body = parseBody(bulkDispositionSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const { order_ids, action, reason } = body;
      const reasonNotes = (body.reason_notes || "").trim();

      // Mirrors the CHECK constraints on orders.trash_reason (7 values, see
      // 20260913000000_trash_reason_duplicate_order.sql) and
      // orders.cancellation_reason. Keep in sync with src/lib/trashReasons.ts
      // and src/lib/cancellationReasons.ts.
      const VALID_TRASH = ["wrong_number", "wrong_person", "not_reachable", "rude", "uncooperative", "duplicate_order", "other"];
      const VALID_CANCEL = [
        "no_money", "changed_mind", "wrong_product", "bought_elsewhere",
        "family_refused", "duplicate_order", "price_too_high", "not_satisfied",
        "still_using_product", "not_interested", "will_call_back", "other",
      ];
      const allowed = action === "trashed" ? VALID_TRASH : VALID_CANCEL;
      if (!allowed.includes(reason)) {
        return json({ error: `reason must be one of: ${allowed.join(", ")}` }, 400);
      }
      if (reason === "other" && !reasonNotes) {
        return json({ error: "A note is required when the reason is 'other'" }, 400);
      }

      // Anything already shipped is owned by the warehouse Returned flow; a
      // disposition must not rewrite fulfilment history. Skipped rows are
      // REPORTED back, never silently dropped.
      const DISPOSABLE = ["pending", "take", "call_again", "duplicated", "confirmed"];
      const { data: rows, error: fetchErr } = await adminClient
        .from("orders")
        .select("id, display_id, status, source_type, inbound_lead_id")
        .in("id", order_ids);
      if (fetchErr) return json({ error: sanitizeDbError(fetchErr) }, 400);

      const targets = (rows || []).filter((o: any) => DISPOSABLE.includes(o.status) && o.status !== action);
      const skipped = (rows || []).filter((o: any) => !targets.some((t: any) => t.id === o.id));
      if (targets.length === 0) {
        return json({ success: true, updated: 0, skipped: skipped.length, skipped_ids: skipped.map((o: any) => o.display_id) });
      }

      const nowIso = new Date().toISOString();
      const update: Record<string, any> = { status: action, updated_at: nowIso };
      if (action === "trashed") {
        update.trash_reason = reason;
        update.trash_reason_notes = reasonNotes || null;
      } else {
        update.cancellation_reason = reason;
        update.cancellation_reason_notes = reasonNotes || null;
        update.cancelled_at = nowIso;
        update.cancelled_by_agent_id = user.id;
      }
      // trashed_at / cancelled_at are also guaranteed by BEFORE triggers; the
      // explicit values above just keep the attribution columns beside them.
      const { error: updErr } = await adminClient
        .from("orders")
        .update(update)
        .in("id", targets.map((o: any) => o.id));
      if (updErr) return json({ error: sanitizeDbError(updErr) }, 400);

      const { data: actor } = await adminClient
        .from("profiles").select("full_name").eq("user_id", user.id).maybeSingle();
      const actorName = actor?.full_name || user.email;

      await adminClient.from("order_history").insert(
        targets.map((o: any) => ({
          order_id: o.id,
          from_status: o.status,
          to_status: action,
          changed_by: user.id,
          changed_by_name: actorName,
        })),
      );

      // Linked inbound leads follow the order (both dispositions are a rejection).
      // Empty in this project today — the webhook intake has no live traffic —
      // but the column exists and the day it does, the sidecar must not drift.
      const inboundIds = targets.map((o: any) => o.inbound_lead_id).filter(Boolean);
      if (inboundIds.length) {
        await adminClient.from("inbound_leads").update({ status: "rejected" }).in("id", inboundIds);
      }

      await audit(adminClient, user.id, user.email, "order.bulk_disposition", {
        target_type: "order",
        target_name: `${targets.length} orders → ${action} (${reason})`,
        payload: {
          action, reason,
          reason_notes: reasonNotes || null,
          count: targets.length,
          order_ids: targets.map((o: any) => o.id),
          skipped_ids: skipped.map((o: any) => o.display_id),
        },
      });

      return json({
        success: true,
        updated: targets.length,
        skipped: skipped.length,
        skipped_ids: skipped.map((o: any) => o.display_id),
      });
    }

    // POST /api/orders/bulk-status-update (admin/manager/warehouse)
    if (req.method === "POST" && path === "orders/bulk-status-update") {
      if (!(isAdmin || isWarehouse || canEditModule("orders"))) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "orders.bulk", 20)) return json({ error: "Rate limit exceeded — try again in a minute" }, 429);
      const body = await req.json();
      const { order_ids, new_status } = body;
      if (!order_ids?.length || !new_status) return json({ error: "order_ids and new_status required" }, 400);

      const validStatuses = ["shipped", "paid", "cancelled", "returned"];
      if (!validStatuses.includes(new_status)) return json({ error: `Status must be one of: ${validStatuses.join(", ")}` }, 400);

      // Fetch current orders to apply safety rules
      const { data: currentOrders, error: fetchErr } = await adminClient
        .from("orders")
        .select("id, status, display_id")
        .in("id", order_ids);
      if (fetchErr) return json({ error: sanitizeDbError(fetchErr) }, 400);

      const skipped: string[] = [];
      const toUpdate: string[] = [];

      for (const order of currentOrders || []) {
        // Safety: don't update cancelled orders to paid
        if (order.status === "cancelled" && new_status === "paid") {
          skipped.push(order.display_id);
          continue;
        }
        // Paid only allowed from shipped or confirmed
        if (new_status === "paid" && !["shipped", "confirmed"].includes(order.status)) {
          skipped.push(order.display_id);
          continue;
        }
        // Don't update already-same-status
        if (order.status === new_status) {
          skipped.push(order.display_id);
          continue;
        }
        toUpdate.push(order.id);
      }

      if (toUpdate.length > 0) {
        // Stock deduction when bulk-setting to "shipped"
        if (new_status === "shipped") {
          // Walk a SNAPSHOT. The stock check below drops orders out of toUpdate,
          // and splicing the very array a for...of is walking makes the iterator
          // skip the next element — so an order could be marked shipped with its
          // stock never deducted. Collect the rejects and remove them after.
          const stockBlocked = new Set<string>();
          for (const oid of [...toUpdate]) {
            const prev = (currentOrders || []).find((o: any) => o.id === oid);
            if (prev?.status === "shipped") continue; // already shipped
            
            const { data: orderItems } = await adminClient.from("order_items").select("*").eq("order_id", oid);
            if (orderItems && orderItems.length > 0) {
              // Multi-product stock check
              let stockOk = true;
              for (const item of orderItems) {
                if (!item.product_id) continue;
                const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", item.product_id).single();
                if (product && product.stock_quantity < item.quantity) {
                  skipped.push(prev?.display_id || oid);
                  stockOk = false;
                  break;
                }
              }
              if (!stockOk) {
                stockBlocked.add(oid);   // removed from toUpdate after the loop
                continue;
              }
              // Deduct stock
              for (const item of orderItems) {
                if (!item.product_id) continue;
                const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", item.product_id).single();
                if (product) {
                  const newQty = product.stock_quantity - item.quantity;
                  await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", item.product_id);
                  await adminClient.from("inventory_logs").insert({
                    product_id: item.product_id,
                    change_amount: -item.quantity,
                    previous_stock: product.stock_quantity,
                    new_stock: newQty,
                    reason: "order_deduction",
                    movement_type: "order_deduction",
                    user_id: user.id,
                    notes: `Bulk shipped — ${item.product_name}`,
                  });
                }
              }
            } else {
              // Legacy single-product: check order's product_id
              const { data: fullOrder } = await adminClient.from("orders").select("product_id, quantity, display_id").eq("id", oid).single();
              if (fullOrder?.product_id) {
                const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", fullOrder.product_id).single();
                const orderQty = fullOrder.quantity || 1;
                if (product && product.stock_quantity < orderQty) {
                  skipped.push(prev?.display_id || oid);
                  stockBlocked.add(oid);   // removed from toUpdate after the loop
                  continue;
                }
                if (product) {
                  const newQty = product.stock_quantity - orderQty;
                  await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", fullOrder.product_id);
                  await adminClient.from("inventory_logs").insert({
                    product_id: fullOrder.product_id,
                    change_amount: -orderQty,
                    previous_stock: product.stock_quantity,
                    new_stock: newQty,
                    reason: "order_deduction",
                    movement_type: "order_deduction",
                    user_id: user.id,
                    notes: `Bulk shipped — ${fullOrder.display_id}`,
                  });
                }
              }
            }
          }
          // Drop everything that failed its stock check, now that the walk is done.
          for (const oid of stockBlocked) {
            const idx = toUpdate.indexOf(oid);
            if (idx > -1) toUpdate.splice(idx, 1);
          }
        }

        // Stock return when bulk-setting to "returned"
        if (new_status === "returned") {
          for (const oid of toUpdate) {
            const prev = (currentOrders || []).find((o: any) => o.id === oid);
            if (prev?.status === "returned") continue; // already returned

            const { data: orderItems } = await adminClient.from("order_items").select("*").eq("order_id", oid);
            if (orderItems && orderItems.length > 0) {
              for (const item of orderItems) {
                if (!item.product_id) continue;
                const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", item.product_id).single();
                if (product) {
                  const newQty = product.stock_quantity + item.quantity;
                  await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", item.product_id);
                  await adminClient.from("inventory_logs").insert({
                    product_id: item.product_id,
                    change_amount: item.quantity,
                    previous_stock: product.stock_quantity,
                    new_stock: newQty,
                    reason: "order_return",
                    movement_type: "order_return",
                    user_id: user.id,
                    notes: `Bulk returned — ${item.product_name} x${item.quantity}`,
                  });
                }
              }
            } else {
              const { data: fullOrder } = await adminClient.from("orders").select("product_id, quantity, display_id, product_name").eq("id", oid).single();
              if (fullOrder?.product_id) {
                const orderQty = fullOrder.quantity || 1;
                const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", fullOrder.product_id).single();
                if (product) {
                  const newQty = product.stock_quantity + orderQty;
                  await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", fullOrder.product_id);
                  await adminClient.from("inventory_logs").insert({
                    product_id: fullOrder.product_id,
                    change_amount: orderQty,
                    previous_stock: product.stock_quantity,
                    new_stock: newQty,
                    reason: "order_return",
                    movement_type: "order_return",
                    user_id: user.id,
                    notes: `Bulk returned — ${fullOrder.display_id}`,
                  });
                }
              }
            }
          }
        }

        if (toUpdate.length > 0) {
          const { error: updateErr } = await adminClient
            .from("orders")
            .update({ status: new_status, updated_at: new Date().toISOString() })
            .in("id", toUpdate);
          if (updateErr) return json({ error: sanitizeDbError(updateErr) }, 400);

          // Log in order_history
          const { data: adminProfile } = await adminClient
            .from("profiles")
            .select("full_name")
            .eq("user_id", user.id)
            .single();

          // Bulk-confirming credits the confirmer, but never overwrites an
          // existing one (the .is(null) guard) — so a CSV flip to shipped/paid
          // leaves the original confirmer intact.
          // The *only* way to change confirmed_by after it is set is the
          // privileged POST /orders/:id/attribution endpoint (admin-only).
          //
          // The gate is REAL_ORDER_STATUSES, not === "confirmed": bulk only
          // accepts shipped/paid/cancelled/returned, so the old equality check
          // was dead code and an order bulk-shipped straight out of pending
          // never got its confirmed_at stamp. Since 2026-08-10 that stamp is
          // what earns the affiliate their payout, so the hole had to close.
          // Already-stamped orders are untouched (the .is(null) guard) and
          // postbacks are unaffected — this writes no status.
          if (REAL_ORDER_STATUSES.includes(new_status)) {
            await adminClient
              .from("orders")
              .update({
                confirmed_by_agent_id: user.id,
                confirmed_by_name: adminProfile?.full_name || "System",
                confirmed_at: new Date().toISOString(),
              })
              .in("id", toUpdate)
              .is("confirmed_by_name", null);
            // TV leaderboard: bulk confirm changes today's counts — refresh the
            // board (no per-agent celebration for bulk operations).
            await broadcastLeaderboard("refresh", { bulk: true });
          }

          const historyRows = toUpdate.map(oid => {
            const prev = (currentOrders || []).find((o: any) => o.id === oid);
            return {
              order_id: oid,
              from_status: prev?.status || null,
              to_status: new_status,
              changed_by: user.id,
              changed_by_name: adminProfile?.full_name || "System",
            };
          });
          await adminClient.from("order_history").insert(historyRows);
        }
      }

      await audit(adminClient, user.id, user.email, "order.bulk_status_update", {
        target_type: "order",
        target_name: `${toUpdate.length} → ${new_status}`,
        payload: { new_status, updated_ids: toUpdate, skipped_ids: skipped, count: toUpdate.length },
      });
      return json({ success: true, updated: toUpdate.length, skipped: skipped.length, skipped_ids: skipped });
    }

    // POST /api/orders/bigarena-sync — daily upload of BigArena tracking export (CSV/XLSX)
    // Client sends clean parsed array (never raw file) after preview. Ref = numeric part of display_id.
    // Only transitions *shipped* (or delivered) orders to paid/returned. Full audit + provenance notes.
    if (req.method === "POST" && path === "orders/bigarena-sync") {
      if (!isAdminOrManager && !isWarehouse) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "orders.bigarena-sync", 8)) return json({ error: "Rate limit exceeded — try again in a minute" }, 429);

      const body = await req.json();
      const updates = Array.isArray(body?.updates) ? body.updates : [];
      const meta = body?.meta || {};
      if (updates.length === 0) return json({ error: "updates[] required" }, 400);
      if (updates.length > 1000) return json({ error: "Too many rows (max 1000 per upload)" }, 400);

      const filename = (meta.filename || 'bigarena-upload').toString().slice(0, 120);

      // Normalize refs (keep only digits, match the fulfilment CSV export convention)
      const work = updates.map((u: any) => ({
        ref: String(u.ref || '').replace(/\D/g, ''),
        rawStatus: String(u.rawStatus || ''),
        target: (u.targetStatus === 'paid' || u.targetStatus === 'returned' || u.targetStatus === 'cancelled') ? u.targetStatus : null,
      })).filter(w => w.ref && w.target);

      if (work.length === 0) return json({ success: true, updated: { paid: 0, returned: 0 }, skipped: [], note: 'No valid ref+target after normalization' });

      const uniqueRefs = [...new Set(work.map(w => w.ref))];

      // Batch candidate fetch (ilike on display_id is safe for small batches; we filter exact numeric in JS)
      const orClauses = uniqueRefs.map(r => `display_id.ilike.%${r}%`).join(',');
      const { data: candidates, error: candErr } = await adminClient
        .from("orders")
        .select("id, display_id, status, customer_name")
        .or(orClauses);
      if (candErr) return json({ error: sanitizeDbError(candErr) }, 400);

      // Exact numeric match + only eligible current statuses
      const refToOrder: Record<string, any> = {};
      for (const o of (candidates || [])) {
        const num = String(o.display_id || '').replace(/\D/g, '');
        if (uniqueRefs.includes(num) && (o.status === 'shipped' || o.status === 'delivered')) {
          refToOrder[num] = o; // last wins if weird dupes (should not happen)
        }
      }

      const toPaidIds: string[] = [];
      const toReturnedIds: string[] = [];
      const toCancelledIds: string[] = [];
      const skipped: any[] = [];
      const matchedRefs: string[] = [];

      for (const w of work) {
        const order = refToOrder[w.ref];
        if (!order) {
          skipped.push({ ref: w.ref, reason: 'not_found_or_not_shipped' });
          continue;
        }
        if (order.status === w.target) {
          skipped.push({ ref: w.ref, display_id: order.display_id, reason: 'already_' + w.target });
          continue;
        }
        matchedRefs.push(w.ref);
        if (w.target === 'paid') toPaidIds.push(order.id);
        else if (w.target === 'cancelled') toCancelledIds.push(order.id);
        else toReturnedIds.push(order.id);
      }

      const updated: { paid: number; returned: number; cancelled: number } = { paid: 0, returned: 0, cancelled: 0 };

      // Helper to write a provenance note (non-fatal)
      const addProvenanceNote = async (orderId: string, ref: string, raw: string, toStatus: string) => {
        try {
          await adminClient.from("order_notes").insert({
            order_id: orderId,
            text: `BigArena sync (${filename}): "${raw}" → ${toStatus} (ref ${ref})`,
            author_id: user.id,
            author_name: "BigArena Sync",
          });
        } catch (e) { /* best effort */ }
      };

      // Process PAID group (no stock impact, just status + history)
      if (toPaidIds.length > 0) {
        const { error: upErr } = await adminClient
          .from("orders")
          .update({ status: 'paid', updated_at: new Date().toISOString() })
          .in("id", toPaidIds);
        if (upErr) return json({ error: sanitizeDbError(upErr) }, 400);

        const { data: prof } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
        const actorName = prof?.full_name || "System";

        const hist = toPaidIds.map(id => {
          const o = Object.values(refToOrder).find((x: any) => x.id === id);
          return { order_id: id, from_status: o?.status || 'shipped', to_status: 'paid', changed_by: user.id, changed_by_name: actorName };
        });
        await adminClient.from("order_history").insert(hist);

        // Provenance notes + count
        for (const id of toPaidIds) {
          const o = Object.values(refToOrder).find((x: any) => x.id === id) as any;
          const w = work.find(ww => refToOrder[ww.ref]?.id === id);
          if (o && w) await addProvenanceNote(id, w.ref, w.rawStatus, 'paid');
        }
        updated.paid = toPaidIds.length;
      }

      // Process RETURNED group (full stock restore + logs, exactly like bulk)
      if (toReturnedIds.length > 0) {
        for (const oid of toReturnedIds) {
          const { data: orderItems } = await adminClient.from("order_items").select("*").eq("order_id", oid);
          if (orderItems && orderItems.length > 0) {
            for (const item of orderItems) {
              if (!item.product_id) continue;
              const { data: prod } = await adminClient.from("products").select("stock_quantity, name").eq("id", item.product_id).single();
              if (prod) {
                const newQty = (prod.stock_quantity || 0) + (item.quantity || 1);
                await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", item.product_id);
                await adminClient.from("inventory_logs").insert({
                  product_id: item.product_id,
                  change_amount: item.quantity || 1,
                  previous_stock: prod.stock_quantity,
                  new_stock: newQty,
                  reason: "order_return",
                  movement_type: "order_return",
                  user_id: user.id,
                  notes: `BigArena sync returned — ${item.product_name} x${item.quantity}`,
                });
              }
            }
          } else {
            // Legacy single-product path
            const { data: full } = await adminClient.from("orders").select("product_id, quantity, display_id, product_name").eq("id", oid).single();
            if (full?.product_id) {
              const qty = full.quantity || 1;
              const { data: prod } = await adminClient.from("products").select("stock_quantity, name").eq("id", full.product_id).single();
              if (prod) {
                const newQty = (prod.stock_quantity || 0) + qty;
                await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", full.product_id);
                await adminClient.from("inventory_logs").insert({
                  product_id: full.product_id,
                  change_amount: qty,
                  previous_stock: prod.stock_quantity,
                  new_stock: newQty,
                  reason: "order_return",
                  movement_type: "order_return",
                  user_id: user.id,
                  notes: `BigArena sync returned — ${full.display_id}`,
                });
              }
            }
          }
        }

        const { error: upErr } = await adminClient
          .from("orders")
          .update({ status: 'returned', updated_at: new Date().toISOString(), returned_at: new Date().toISOString() })
          .in("id", toReturnedIds);
        if (upErr) return json({ error: sanitizeDbError(upErr) }, 400);

        const { data: prof } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
        const actorName = prof?.full_name || "System";

        const hist = toReturnedIds.map(id => {
          const o = Object.values(refToOrder).find((x: any) => x.id === id);
          return { order_id: id, from_status: o?.status || 'shipped', to_status: 'returned', changed_by: user.id, changed_by_name: actorName };
        });
        await adminClient.from("order_history").insert(hist);

        for (const id of toReturnedIds) {
          const o = Object.values(refToOrder).find((x: any) => x.id === id) as any;
          const w = work.find(ww => refToOrder[ww.ref]?.id === id);
          if (o && w) await addProvenanceNote(id, w.ref, w.rawStatus, 'returned');
        }
        updated.returned = toReturnedIds.length;
      }

      // Process CANCELLED group (BigArena "Отменена"/"Анулирана" — cancelled at the
      // warehouse, never went out → NO stock restore, just status + history + note).
      if (toCancelledIds.length > 0) {
        const { error: upErr } = await adminClient
          .from("orders")
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .in("id", toCancelledIds);
        if (upErr) return json({ error: sanitizeDbError(upErr) }, 400);

        const { data: prof } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
        const actorName = prof?.full_name || "System";

        const hist = toCancelledIds.map(id => {
          const o = Object.values(refToOrder).find((x: any) => x.id === id);
          return { order_id: id, from_status: o?.status || 'shipped', to_status: 'cancelled', changed_by: user.id, changed_by_name: actorName };
        });
        await adminClient.from("order_history").insert(hist);

        for (const id of toCancelledIds) {
          const o = Object.values(refToOrder).find((x: any) => x.id === id) as any;
          const w = work.find(ww => refToOrder[ww.ref]?.id === id);
          if (o && w) await addProvenanceNote(id, w.ref, w.rawStatus, 'cancelled');
        }
        updated.cancelled = toCancelledIds.length;
      }

      await audit(adminClient, user.id, user.email, "order.bigarena_status_sync", {
        target_type: "order",
        target_name: `${filename} (${matchedRefs.length} matched)`,
        payload: {
          filename,
          updated,
          skipped_count: skipped.length,
          matched_refs: matchedRefs,
          total_submitted: updates.length,
        },
      });

      return json({
        success: true,
        updated,
        skipped,
        matched: matchedRefs.length,
        unmatchedRefs: uniqueRefs.filter(r => !matchedRefs.includes(r)),
      });
    }

    // GET /api/orders/:id
    const reservedOrderPaths = ["stats", "assigned", "unassigned-pending", "open-lead", "bulk-assign", "bulk-unassign", "bulk-status-update", "bulk-disposition", "bigarena-sync"];
    if (req.method === "GET" && segments[0] === "orders" && segments.length === 2 && !reservedOrderPaths.includes(segments[1])) {
      const orderId = segments[1];
      let { data: order, error } = await supabase
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .single();

      // RLS scopes an agent to their own orders. That is right for real orders,
      // but it also hid a colleague's OPEN LEAD — so an agent handed a client by
      // the manager could not open the call_again to resolve it, and created a
      // second order instead (the fork bug, again). Fall back to the elevated
      // client for OPEN LEADS ONLY, matching the PATCH exemption below.
      // Anything past confirm stays invisible.
      //
      // `hasInternalRole` is belt-and-braces: the affiliate hard wall at the top
      // of this handler already 403s a pure-affiliate login long before it can
      // reach any order route. But affiliates hold REAL Supabase logins in this
      // project, and this is the one place we deliberately step around RLS — so
      // the staff check is stated HERE rather than inferred from a guard 3000
      // lines away (elyon-security golden rule 3: when unsure, assume not).
      if ((error || !order) && !isAdminOrManager && hasInternalRole) {
        const { data: openLead } = await adminClient
          .from("orders")
          .select("*")
          .eq("id", orderId)
          .in("status", ["pending", "take", "call_again", "duplicated"])
          .maybeSingle();
        if (openLead) { order = openLead; error = null; }
      }
      if (error || !order) return json({ error: "Order not found" }, 404);

      // Get order items
      const { data: orderItems } = await adminClient
        .from("order_items")
        .select("*")
        .eq("order_id", orderId)
        .order("created_at", { ascending: true });

      // Get history and notes
      const { data: history } = await supabase
        .from("order_history")
        .select("*")
        .eq("order_id", orderId)
        .order("changed_at", { ascending: false });

      const { data: notes } = await supabase
        .from("order_notes")
        .select("*")
        .eq("order_id", orderId)
        .order("created_at", { ascending: false });

      // Check phone duplicates
      const { data: dupes } = await adminClient.rpc("check_phone_duplicates", {
        _phone: order.customer_phone,
        _exclude_order_id: order.id,
      });

      // Mask customer identity per role; hide the status timeline + duplicate-order
      // lookups when the role can't see order history (e.g. investor managers).
      return json({
        ...redactCustomer(order, piiFlags),
        order_items: orderItems || [],
        history: showOrderHistory ? history : [],
        notes,
        phone_duplicates: showOrderHistory ? dupes : [],
      });
    }

    // GET /api/orders/:id/calls — lazy "Calls" panel on /orders expanded rows.
    // Order-id based (NOT phone based): the caller's copy of the phone may be
    // privacy-masked, so the server resolves the real number. The order lookup
    // uses the SAME client scope as GET /api/orders, so it doubles as the
    // access check (RLS -> 404 for rows the viewer can't see). Returns ALL
    // calls to the customer's number (order/lead/standalone), last-8 matched.
    // Deliberately DB-only — no live PBX list — so expanding a row stays cheap.
    if (req.method === "GET" && segments[0] === "orders" && segments.length === 3 && segments[2] === "calls") {
      if (!canHearRecordings && !canHearOwnRecordings) return json({ error: "Forbidden" }, 403);
      const orderId = segments[1];
      const oClient = isAdminOrManager ? adminClient : supabase;
      const { data: ord, error: oErr } = await oClient
        .from("orders")
        .select("id, customer_phone")
        .eq("id", orderId)
        .single();
      if (oErr || !ord) return json({ error: "Order not found" }, 404);

      const digits = String(ord.customer_phone || "").replace(/\D/g, "");
      const last8 = digits.length >= 8 ? digits.slice(-8) : "";
      if (!last8) return json({ calls: [] });

      const { data: logs, error: cErr } = await adminClient
        .from("call_logs")
        .select("id, agent_id, context_type, context_id, outcome, created_at, started_at, connected_at, talk_seconds, total_seconds, recording_file, listened_at, listened_by")
        .ilike("customer_phone", `%${last8}%`)
        .order("created_at", { ascending: false })
        .limit(25);
      if (cErr) return json({ error: sanitizeDbError(cErr) }, 400);
      const calls = logs || [];

      // Pick up recordings the hangup webhook anchored in call_recordings but
      // not (yet) onto call_logs.recording_file. Two DB-only passes, no PBX call:
      //  (1) direct call_log_id link (the webhook did link it, just didn't stamp
      //      recording_file), then
      //  (2) match by dialed_last8 + time-overlap — this is the common case: the
      //      recording IS in call_recordings but its call_log_id is NULL (the
      //      webhook captured the file but never linked the row), which is why
      //      Call History (live PBX matcher) shows Play here and the DB doesn't.
      if (calls.some((c: any) => !c.recording_file)) {
        const missingIds = calls.filter((c: any) => !c.recording_file).map((c: any) => c.id);
        const { data: recs } = await adminClient
          .from("call_recordings")
          .select("uniqueid, ext, file, call_log_id, started_at, ended_at")
          .eq("dialed_last8", last8);
        const recRows = recs || [];
        // (1) direct link
        const byLog = new Map(recRows.filter((r: any) => r.call_log_id).map((r: any) => [r.call_log_id, r.file]));
        for (const c of calls) if (!c.recording_file && byLog.has(c.id)) c.recording_file = byLog.get(c.id);
        // (2) overlap match for whatever is still unlinked
        const stillMissing = calls.filter((c: any) => !c.recording_file && missingIds.includes(c.id));
        if (stillMissing.length) {
          const linkedFiles = new Set(calls.filter((c: any) => c.recording_file).map((c: any) => c.recording_file));
          const candidates: RecLite[] = recRows
            .filter((r: any) => r.file && !linkedFiles.has(r.file))
            .map((r: any) => ({
              file: r.file,
              dialed: last8,
              ext: r.ext,
              uniqueid: r.uniqueid,
              start: r.started_at ? Math.floor(new Date(r.started_at).getTime() / 1000) : undefined,
              mtime: r.ended_at ? Math.floor(new Date(r.ended_at).getTime() / 1000) : undefined,
            }));
          if (candidates.length) {
            const exts = [...new Set(candidates.map((r) => r.ext).filter(Boolean))] as string[];
            const extToAgent: Record<string, string> = {};
            if (exts.length) {
              const { data: te } = await adminClient.from("telephony_extensions").select("extension,user_id").in("extension", exts);
              for (const x of te || []) if (x.extension && x.user_id) extToAgent[x.extension] = x.user_id;
            }
            const matched = matchRecordingsToCalls(candidates, stillMissing as CallLite[], extToAgent);
            for (const c of stillMissing) { const rec = matched.get(c.id); if (rec?.file) c.recording_file = rec.file; }
          }
        }
      }

      // (3) Real-time parity with Call History: for any row STILL unlinked whose
      // recording could plausibly still be on the PBX (within the ~30-day purge
      // window), fall back to the LIVE recording list — the same best-effort,
      // short-timeout pattern Call History uses. This only fires in the brief
      // window before the hangup webhook has written call_recordings; once that
      // (or a backfill) lands it's a no-op. On ANY PBX error we silently keep the
      // DB results, so this can never slow down or break the panel.
      const PBX_RETENTION_MS = 30 * 24 * 3600 * 1000;
      const liveNeed = calls.filter((c: any) => !c.recording_file
        && (Date.now() - new Date(c.created_at).getTime()) < PBX_RETENTION_MS
        && (c.connected_at || (c.talk_seconds ?? 0) > 0));
      if (liveNeed.length) {
        try {
          const recExp = Math.floor(Date.now() / 1000) + 120;
          const recSig = await recSign("list", recExp);
          const ctrl = new AbortController();
          const tm = setTimeout(() => ctrl.abort(), 5000);
          let pbx: any[] = [];
          try {
            const rr = await fetch(`${REC_HOST}?mode=list&exp=${recExp}&sig=${recSig}`, { signal: ctrl.signal });
            if (rr.ok) pbx = await rr.json();
          } finally { clearTimeout(tm); }
          if (Array.isArray(pbx) && pbx.length) {
            const linkedFiles = new Set(calls.filter((c: any) => c.recording_file).map((c: any) => c.recording_file));
            const cands: RecLite[] = pbx
              .filter((r: any) => (r.size || 0) > 2000 && r.file && !linkedFiles.has(r.file)
                && String(r.dialed || "").replace(/\D/g, "").slice(-8) === last8)
              .map((r: any) => ({ file: r.file, dialed: r.dialed, ext: r.ext, uniqueid: r.uniqueid, mtime: r.mtime, start: r.start }));
            if (cands.length) {
              const exts = [...new Set(cands.map((r) => r.ext).filter(Boolean))] as string[];
              const extToAgent: Record<string, string> = {};
              if (exts.length) {
                const { data: te } = await adminClient.from("telephony_extensions").select("extension,user_id").in("extension", exts);
                for (const x of te || []) if (x.extension && x.user_id) extToAgent[x.extension] = x.user_id;
              }
              const matched = matchRecordingsToCalls(cands, liveNeed as CallLite[], extToAgent);
              for (const c of liveNeed) { const rec = matched.get(c.id); if (rec?.file) c.recording_file = rec.file; }
            }
          }
        } catch (_e) { /* best-effort: keep DB results on any PBX error/timeout */ }
      }

      const nameIds = [...new Set(calls.flatMap((c: any) => [c.agent_id, c.listened_by]).filter(Boolean))];
      const nameMap: Record<string, string> = {};
      if (nameIds.length) {
        const { data: profs } = await adminClient.from("profiles").select("user_id, full_name").in("user_id", nameIds);
        for (const p of profs || []) nameMap[p.user_id] = p.full_name;
      }

      // Per-row recording scoping: hear-all keeps every file; own-only keeps
      // only its own. recording_locked = a file exists but THIS viewer may not
      // play it (so the UI can say "restricted", not falsely "expired").
      // The raw customer_phone is intentionally NOT returned (PII masking).
      return json({
        calls: calls.map((c: any) => {
          const own = c.agent_id === user.id;
          const allowed = canHearRecordings || (canHearOwnRecordings && own);
          return {
            id: c.id,
            agent_id: c.agent_id,
            agent_name: nameMap[c.agent_id] || null,
            context_type: c.context_type,
            is_this_order: c.context_type === "order" && c.context_id === orderId,
            outcome: c.outcome,
            created_at: c.created_at,
            started_at: c.started_at,
            connected_at: c.connected_at,
            talk_seconds: c.talk_seconds,
            total_seconds: c.total_seconds,
            recording_file: allowed ? c.recording_file : null,
            recording_locked: !!c.recording_file && !allowed,
            listened_at: c.listened_at,
            listened_by_name: c.listened_by ? (nameMap[c.listened_by] || null) : null,
          };
        }),
      });
    }

    // PATCH /api/orders/:id/customer (update editable fields)
    if (req.method === "PATCH" && segments[0] === "orders" && segments[2] === "customer") {
      if (!canMutateOrders) return json({ error: "Forbidden" }, 403);
      const orderId = segments[1];
      let body;
      try { body = parseBody(updateCustomerSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }

      // Check if order is in a locked status for product/price edits
      const hasProductFields = body.price !== undefined || body.quantity !== undefined || body.product_id !== undefined || body.product_name !== undefined;
      // Fetched via adminClient: an agent's RLS only matches orders assigned to
      // them, which silently hid every unassigned open order (including each fresh
      // duplicate) and made the modal save fail with "Operation failed". The
      // explicit ownership guard below is the real gate now.
      const { data: currentOrder } = await adminClient
        .from("orders")
        .select("status, assigned_agent_id, delivery_type, courier_office_code")
        .eq("id", orderId)
        .single();
      if (!currentOrder) return json({ error: "Order not found" }, 404);
      if (orderOwnershipBlocked(currentOrder)) {
        return json({ error: "Forbidden — this order is assigned to another agent" }, 403);
      }

      if (hasProductFields) {
        const lockedStatuses = ["shipped", "delivered", "paid"];
        if (lockedStatuses.includes(currentOrder.status)) {
          return json({ error: "Product and price locked because order is Shipped, Delivered, or Paid." }, 400);
        }
      }

      const updates: Record<string, any> = {};
      if (body.customer_name !== undefined) updates.customer_name = body.customer_name;
      if (body.customer_phone !== undefined) updates.customer_phone = body.customer_phone;
      if (body.customer_city !== undefined) updates.customer_city = body.customer_city;
      if (body.customer_address !== undefined) updates.customer_address = body.customer_address;
      if (body.postal_code !== undefined) updates.postal_code = body.postal_code;
      if (body.street !== undefined) updates.street = body.street;
      if (body.street_number !== undefined) updates.street_number = body.street_number;
      if (body.quarter !== undefined) updates.quarter = body.quarter;
      if (body.apartment !== undefined) updates.apartment = body.apartment;
      if (body.floor !== undefined) updates.floor = body.floor;
      if (body.block !== undefined) updates.block = body.block;
      if (body.entry !== undefined) updates.entry = body.entry;
      if (body.delivery_instructions !== undefined) updates.delivery_instructions = body.delivery_instructions;
      if (body.gift_note !== undefined) updates.gift_note = body.gift_note;
      if (body.delivery_type !== undefined) updates.delivery_type = body.delivery_type;
      if (body.home_courier !== undefined) updates.home_courier = body.home_courier;
      if (body.courier_office_code !== undefined) updates.courier_office_code = body.courier_office_code;
      if (body.courier_office_name !== undefined) updates.courier_office_name = body.courier_office_name;
      if (body.courier_office_city !== undefined) updates.courier_office_city = body.courier_office_city;
      if (body.birthday !== undefined) updates.birthday = body.birthday;
      if (body.price !== undefined) updates.price = body.price;
      if (body.quantity !== undefined) updates.quantity = body.quantity;
      if (body.product_id !== undefined) updates.product_id = body.product_id;
      if (body.product_name !== undefined) updates.product_name = body.product_name;
      if (body.ship_after_date !== undefined) updates.ship_after_date = body.ship_after_date;

      // Office orders: keep postal_code equal to the courier office's own post
      // code. Re-resolve whenever the delivery method or the office changed.
      if (body.delivery_type !== undefined || body.courier_office_code !== undefined) {
        const dt = body.delivery_type ?? currentOrder.delivery_type;
        const code = body.courier_office_code ?? currentOrder.courier_office_code;
        const pc = await resolveOfficePostCode(dt, code);
        if (pc) updates.postal_code = pc;
      }

      // Re-resolve the MEX zone whenever the city changed. Without this an
      // edited address keeps routing to the settlement it was first saved with.
      if (body.customer_city !== undefined) {
        const mexZone = await resolveMexCity(body.customer_city);
        updates.mex_city_id = mexZone.id;
        updates.mex_city_name = mexZone.name;
      }

      // adminClient, not the RLS client: on an unassigned duplicate the RLS update
      // matched zero rows, .single() errored, and the route 400'd — that is exactly
      // the "Operation failed" agents saw when saving the modal.
      const { data, error } = await adminClient
        .from("orders")
        .update(updates)
        .eq("id", orderId)
        .select()
        .single();

      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // PATCH /api/orders/:id/status
    if (req.method === "PATCH" && segments[0] === "orders" && segments[2] === "status") {
      if (!canMutateOrders) return json({ error: "Forbidden" }, 403);
      const orderId = segments[1];
      let body;
      try { body = parseBody(updateStatusSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const newStatus = body.status;

      // Get current order
      const { data: order } = await adminClient
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .single();
      if (!order) return json({ error: "Order not found" }, 404);

      // Ownership guard (mirrors the orders UPDATE RLS: assigned_agent_id =
      // auth.uid()). This handler writes via adminClient, which bypasses RLS,
      // so without this an agent could PATCH ANY order by id — confirming a
      // colleague's lead to steal the per-package commission, or sabotaging it.
      // Admins/managers act on any order; warehouse drives fulfilment across
      // orders; a plain agent may only touch their own or an unassigned one.
      //
      // EXEMPTION for OPEN LEADS (operator rule, 2026-08-10): "if an agent gets
      // to a client where there is only one call_again, it should let them edit
      // it — it doesn't matter which agent it was assigned to before." Managers
      // hand clients between agents all day; blocking this is exactly what
      // pushed agents into creating a second order instead, which is the bug
      // this whole change set exists to kill. Ownership governs DISTRIBUTION,
      // not deliberate human action. Credit follows the work — confirmed_by_*
      // records whoever closes it, and order_history records the hand-over.
      //
      // Everything past confirm stays locked: a real order's sales credit,
      // fulfilment and money are not a colleague's to rewrite.
      //
      // 'duplicated' counts as OPEN since 2026-08-13: admins/managers create the
      // copies precisely so an agent can follow up and settle them.
      const OPEN_LEAD_STATES = ["pending", "take", "call_again", "duplicated"];
      if (!isAdminOrManager && !isWarehouse
        && !OPEN_LEAD_STATES.includes(order.status)
        && order.assigned_agent_id && order.assigned_agent_id !== user.id) {
        return json({ error: "Forbidden — this order is assigned to another agent" }, 403);
      }

      // Settled orders are manager territory (operator rule 2026-08-13). An agent
      // may only change the status of an order that is still OPEN — a lead or an
      // unsettled duplicate. Once it reaches confirmed/shipped/delivered/paid/
      // returned/cancelled/trashed only admins/managers (and warehouse, for
      // fulfilment) may move it, EVEN the agent who owns it. Without this an agent
      // could flip their own cancelled or paid order back to confirmed, because
      // the allowlist below only checks the TARGET status.
      //
      // `!isWarehouse` is load-bearing here: every warehouse transition acts on an
      // order whose CURRENT status is confirmed/shipped/delivered, so dropping the
      // clause would 403 the entire fulfilment flow.
      // Same-status saves stay allowed so reason corrections keep working.
      if (!isAdminOrManager && !isWarehouse
        && !OPEN_LEAD_STATES.includes(order.status)
        && newStatus !== order.status) {
        return json({ error: "Forbidden — only a manager can change a settled order" }, 403);
      }

      // Permission check for non-admins
      const agentAllowed = ["pending", "take", "call_again", "confirmed"];
      const warehouseAllowed = ["confirmed", "shipped", "delivered", "paid"];
      // Dispositioning a still-OPEN order (a lead the agent is calling):
      // cancelled/trashed are allowed only while the order sits in the call
      // flow. A confirmed or shipped order stays untouchable for agents — the
      // original point of the allowlist (no sabotaging recorded sales). The
      // ownership guard above already limits agents to their own orders.
      const openStatuses = ["pending", "take", "call_again", "duplicated"];
      const isOpenDisposition =
        ["cancelled", "trashed"].includes(newStatus) && openStatuses.includes(order.status);
      if (!isAdminOrManager) {
        if (isWarehouse && warehouseAllowed.includes(newStatus)) {
          // Warehouse users can set confirmed/shipped
        } else if (!agentAllowed.includes(newStatus) && !isOpenDisposition) {
          return json({ error: `You can only set status to: ${agentAllowed.join(", ")}` }, 403);
        }
      }

      // Validation: require fields for certain statuses (only for non-admins).
      // Superadmins (isAdmin) can force any status change without meeting the usual
      // completeness requirements. This is intentional for cleaning up legacy data.
      //
      // Extra leniency: if the order is already shipped (or further) and we're only
      // doing post-shipment status changes (returned/paid/cancelled), admins can
      // always do it even on very old/incomplete records.
      const isPostShipmentAdminEdit =
        isAdmin &&
        ["shipped", "delivered", "paid", "returned"].includes(order.status) &&
        ["returned", "paid", "cancelled"].includes(newStatus);

      const requiresComplete = ["confirmed", "shipped", "returned", "paid", "cancelled"];
      // Cancelling a still-open order is a refusal record, not a shipment —
      // demanding a full address there would make sparse webhook leads
      // uncancellable. The create-order cancel path (prediction flow) already
      // records cancellations with just name+phone, so this keeps parity.
      const isOpenCancel = newStatus === "cancelled" && openStatuses.includes(order.status);
      if (!isPostShipmentAdminEdit && !isAdmin && !isOpenCancel && requiresComplete.includes(newStatus)) {
        const hasName = !!order.customer_name?.trim();
        const hasPhone = !!order.customer_phone?.trim();
        const hasCity = !!order.customer_city?.trim() || !!order.courier_office_city?.trim();

        let hasDeliveryInfo = false;
        const dt = order.delivery_type;

        if (dt === 'home') {
          hasDeliveryInfo = !!order.customer_address?.trim();
        } else if (dt === 'speedy_office' || dt === 'econt_office' || dt === 'mex_office') {
          hasDeliveryInfo = !!order.courier_office_code?.trim() || !!order.courier_office_name?.trim();
        } else {
          // Legacy / unknown delivery type (very old orders). Accept either style.
          hasDeliveryInfo = !!order.customer_address?.trim() ||
                            !!order.courier_office_code?.trim() ||
                            !!order.courier_office_name?.trim();
        }

        if (!hasName || !hasPhone || !hasCity || !hasDeliveryInfo) {
          return json({ 
            error: "Name, Telephone, City, and delivery information (Address or Courier Office) must be filled before changing to this status" 
          }, 400);
        }
      }

      // Stock deduction on SHIPPED (not confirmed) — supports multi-product orders
      if (newStatus === "shipped" && order.status !== "shipped") {
        // Check for order_items first (multi-product)
        const { data: orderItems } = await adminClient.from("order_items").select("*").eq("order_id", orderId);

        if (orderItems && orderItems.length > 0) {
          // Multi-product: deduct stock for each item
          for (const item of orderItems) {
            if (!item.product_id) continue;
            const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", item.product_id).single();
            if (product && product.stock_quantity < item.quantity) {
              return json({ error: `Insufficient stock: ${product.name} has ${product.stock_quantity} available, but order requires ${item.quantity}` }, 400);
            }
          }
          // All stock checks passed, now deduct
          for (const item of orderItems) {
            if (!item.product_id) continue;
            const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", item.product_id).single();
            if (product) {
              const newQty = product.stock_quantity - item.quantity;
              await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", item.product_id);
              await adminClient.from("inventory_logs").insert({
                product_id: item.product_id,
                change_amount: -item.quantity,
                previous_stock: product.stock_quantity,
                new_stock: newQty,
                reason: "order_deduction",
                movement_type: "order_deduction",
                user_id: user.id,
                notes: `Order ${order.display_id} shipped — ${item.product_name}`,
              });
            }
          }
        } else if (order.product_id) {
          // Legacy single-product fallback
          const orderQty = order.quantity || 1;
          const { data: product } = await adminClient
            .from("products")
            .select("stock_quantity, name")
            .eq("id", order.product_id)
            .single();
          if (product && product.stock_quantity < orderQty) {
            return json({ error: `Insufficient stock: ${product.name} has ${product.stock_quantity} available, but order requires ${orderQty}` }, 400);
          }
          if (product && product.stock_quantity >= orderQty) {
            const newQty = product.stock_quantity - orderQty;
            await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", order.product_id);
            await adminClient.from("inventory_logs").insert({
              product_id: order.product_id,
              change_amount: -orderQty,
              previous_stock: product.stock_quantity,
              new_stock: newQty,
              reason: "order_deduction",
              movement_type: "order_deduction",
              user_id: user.id,
              notes: `Order ${order.display_id} shipped`,
            });
          }
        }
      }

      // Stock return on RETURNED — add products back to inventory
      if (newStatus === "returned" && order.status !== "returned") {
        const { data: orderItems } = await adminClient.from("order_items").select("*").eq("order_id", orderId);

        if (orderItems && orderItems.length > 0) {
          for (const item of orderItems) {
            if (!item.product_id) continue;
            const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", item.product_id).single();
            if (product) {
              const newQty = product.stock_quantity + item.quantity;
              await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", item.product_id);
              await adminClient.from("inventory_logs").insert({
                product_id: item.product_id,
                change_amount: item.quantity,
                previous_stock: product.stock_quantity,
                new_stock: newQty,
                reason: "order_return",
                movement_type: "order_return",
                user_id: user.id,
                notes: `Order ${order.display_id} returned — ${item.product_name} x${item.quantity}`,
              });
            }
          }
        } else if (order.product_id) {
          const orderQty = order.quantity || 1;
          const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", order.product_id).single();
          if (product) {
            const newQty = product.stock_quantity + orderQty;
            await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", order.product_id);
            await adminClient.from("inventory_logs").insert({
              product_id: order.product_id,
              change_amount: orderQty,
              previous_stock: product.stock_quantity,
              new_stock: newQty,
              reason: "order_return",
              movement_type: "order_return",
              user_id: user.id,
              notes: `Order ${order.display_id} returned — ${order.product_name} x${orderQty}`,
            });
          }
        }
      }

      // Get profile name
      const { data: profile } = await adminClient
        .from("profiles")
        .select("full_name")
        .eq("user_id", user.id)
        .single();

      // Update status — also write structured reason fields when present
      // so the customer lands in the right Cancelled / Returned mirror list.
      const update: Record<string, any> = { status: newStatus };
      if (newStatus === "cancelled") {
        if (body.cancellation_reason) update.cancellation_reason = body.cancellation_reason;
        if (body.cancellation_reason_notes !== undefined) update.cancellation_reason_notes = body.cancellation_reason_notes;
        if (!order.cancelled_at) update.cancelled_at = new Date().toISOString();
        if (!order.cancelled_by_agent_id) update.cancelled_by_agent_id = user.id;
      }
      if (newStatus === "returned") {
        if (body.return_reason) update.return_reason = body.return_reason;
        if (body.return_reason_notes !== undefined) update.return_reason_notes = body.return_reason_notes;
        if (!order.returned_at) update.returned_at = new Date().toISOString();
      }
      if (newStatus === "trashed") {
        if (body.trash_reason) update.trash_reason = body.trash_reason;
        if (body.trash_reason_notes !== undefined) update.trash_reason_notes = body.trash_reason_notes;
      }
      // First time this order becomes a real order, credit the confirmer.
      // Never overwrite an existing value (normal status flows), so shipped/paid
      // keep the original agent who confirmed it.
      // The only supported way to change the original sales credit later is the
      // admin-only POST /orders/:id/attribution endpoint.
      if (REAL_ORDER_STATUSES.includes(newStatus) && !order.confirmed_by_name) {
        update.confirmed_by_agent_id = user.id;
        update.confirmed_by_name = profile?.full_name || user.email;
        update.confirmed_at = new Date().toISOString();
      }
      // Claim-on-action: an agent settling an unassigned open order (including a
      // duplicate an admin created for follow-up) becomes its owner, so workload
      // counts and "Handled By" stay coherent. The triple moves as ONE.
      if (!isAdminOrManager && !isWarehouse
        && !order.assigned_agent_id
        && OPEN_LEAD_STATES.includes(order.status)) {
        update.assigned_agent_id = user.id;
        update.assigned_agent_name = profile?.full_name || user.email;
        update.assigned_at = new Date().toISOString();
      }
      const { error: updateErr } = await adminClient
        .from("orders")
        .update(update)
        .eq("id", orderId);
      if (updateErr) return json({ error: sanitizeDbError(updateErr) }, 400);

      // Settling an order counts as an answer — release the mandatory-answer
      // obligation. Confirms skip the call-outcome click, so for that path this
      // is the only clearing point.
      await clearCallObligation(adminClient, user.id, order.customer_phone);

      // TV leaderboard: only nudge on a FRESH confirm (this is when confirmed_at
      // is set to today). Later flips (confirmed→shipped→paid) don't change
      // today's confirmed count, so they don't celebrate.
      if (REAL_ORDER_STATUSES.includes(newStatus) && !order.confirmed_by_name) {
        await broadcastLeaderboard("confirmed", { agent_id: user.id, order_id: orderId });
      }

      // Log history — but not for a no-op transition. The Order Editor now
      // re-PATCHes with the SAME status when only the cancel/trash reason was
      // corrected; recording that as a status change would spam the timeline
      // with "Cancelled → Cancelled" rows.
      if (order.status !== newStatus) {
        await adminClient.from("order_history").insert({
          order_id: orderId,
          from_status: order.status,
          to_status: newStatus,
          changed_by: user.id,
          changed_by_name: profile?.full_name || user.email,
        });
      }

      // Sync status to linked inbound lead
      if (order.inbound_lead_id) {
        const inboundStatusMap: Record<string, string> = {
          pending: "pending", take: "contacted", call_again: "contacted",
          confirmed: "converted", shipped: "converted", delivered: "converted",
          paid: "converted", returned: "rejected", trashed: "rejected", cancelled: "rejected",
        };
        const inboundStatus = inboundStatusMap[newStatus] || "contacted";
        await adminClient.from("inbound_leads").update({ status: inboundStatus }).eq("id", order.inbound_lead_id);
      }

      // Affiliate postbacks: the DB trigger just enqueued any stage change —
      // nudge the drain so the affiliate's tracker hears it in seconds
      // (the every-minute cron remains the delivery guarantee).
      if (order.source_type === "affiliate") nudgePostbackDrain(adminClient);

      return json({ success: true });
    }

    // POST /api/orders/:id/duplicate — admin/manager only. Creates a copy of
    // the source order with the next sequential ORD number (display_id trigger),
    // status 'duplicated', and a permanent link to the source. The SOURCE order is
    // NEVER touched — its status, history and attribution stay exactly as they were.
    // Since 2026-08-13 the copy is a normal open order: agents can find it, open it
    // and settle it (confirm / cancel / trash) like any other lead.
    //
    // The insert below is an explicit allowlist that copies NO AlterCPA or inbound
    // lead linkage and forces source_type 'manual'. That is what keeps a confirmed
    // duplicate out of altercpa-sync (which selects by ledger linkage) and therefore
    // out of MEX — no customer can ever receive two parcels from one duplication.
    if (req.method === "POST" && segments[0] === "orders" && segments.length === 3 && segments[2] === "duplicate") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "orders.duplicate", 20)) return json({ error: "Too many requests" }, 429);
      const sourceId = segments[1];

      const { data: src } = await adminClient.from("orders").select("*").eq("id", sourceId).single();
      if (!src) return json({ error: "Order not found" }, 404);

      // Explicit allowlist copy — never spread the source row, so lifecycle
      // timestamps/reasons, assignment, sales attribution and lead/affiliate
      // links can never leak into the copy (copying source_type 'affiliate'
      // would enqueue a CPA postback via trg_affiliate_postback_insert).
      const { data: dup, error: dupErr } = await adminClient
        .from("orders")
        .insert({
          product_id: src.product_id,
          product_name: src.product_name,
          customer_name: src.customer_name,
          customer_phone: src.customer_phone,
          customer_city: src.customer_city,
          customer_address: src.customer_address,
          postal_code: src.postal_code,
          street: src.street ?? "",
          street_number: src.street_number ?? "",
          quarter: src.quarter ?? "",
          apartment: src.apartment ?? "",
          floor: src.floor ?? "",
          block: src.block ?? "",
          entry: src.entry ?? "",
          delivery_instructions: src.delivery_instructions ?? "",
          gift_note: src.gift_note ?? "",
          delivery_type: src.delivery_type ?? "home",
          home_courier: src.home_courier ?? null,
          courier_office_code: src.courier_office_code ?? "",
          courier_office_name: src.courier_office_name ?? "",
          courier_office_city: src.courier_office_city ?? "",
          birthday: src.birthday,
          ship_after_date: src.ship_after_date ?? null,
          price: src.price,
          quantity: src.quantity,
          status: "duplicated",
          source_type: "manual",
          duplicated_from: src.id,
          duplicated_from_display: src.display_id,
        })
        .select()
        .single();
      if (dupErr) return json({ error: sanitizeDbError(dupErr) }, 400);

      const { data: srcItems } = await adminClient
        .from("order_items")
        .select("product_id, product_name, quantity, price_per_unit, total_price")
        .eq("order_id", sourceId);
      if (srcItems && srcItems.length) {
        await adminClient.from("order_items").insert(
          srcItems.map((i: any) => ({ order_id: dup.id, ...i })),
        );
      }

      const { data: dupActorProfile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
      const dupActorName = dupActorProfile?.full_name || user.email;

      // History + note go on the NEW order only — anything written on the
      // source order is readable by its assigned agent via RLS and would
      // leak the duplicate's existence.
      await adminClient.from("order_history").insert({
        order_id: dup.id,
        to_status: "duplicated",
        changed_by: user.id,
        changed_by_name: dupActorName,
      });
      await adminClient.from("order_notes").insert({
        order_id: dup.id,
        text: `Duplicated from ${src.display_id}`,
        author_id: user.id,
        author_name: "System",
      });

      await audit(adminClient, user.id, user.email, "order.duplicate", {
        target_type: "order",
        target_id: dup.id,
        payload: { source_order_id: src.id, source_display_id: src.display_id, new_display_id: dup.display_id },
      });

      return json(dup);
    }

    // POST /api/orders/:id/altercpa-push — the manual "CPA" button (2026-08-14).
    // Pushes THIS order's current state to AlterCPA via comp/edit.json: status
    // (accept=1 for confirmed — never a status number, their commission timers),
    // cancel/trash reason, customer fields, quantity, unit price and a comment.
    //
    // STRICTLY one order per press (operator decision 2026-08-14): there is no
    // bulk variant and no automatic hook — bulk-status-update, bulk-disposition
    // and bigarena-sync must never call this. Gated by
    // app_settings.altercpa_push_enabled (default off), re-read on EVERY call so
    // the Settings switch is an instant kill switch.
    //
    // Loop safety vs the */5 altercpa-sync status cron: terminal statuses
    // (paid/returned/cancelled/trashed) sit outside STATUS_OPEN and are never
    // re-read; confirmed (accept=1 → their phase 3) resolves back to
    // 'confirmed' = unchanged; shipped/delivered hit the courier exception. The
    // bridge-skill sharp edge (phase-4 unmappable reason flips a NON-terminal
    // order to confirmed) cannot fire on our pushes, because status 5 is only
    // ever sent for orders that are terminal here. Price: `base` derives from
    // the lead's own implied rate (price_raw/price_eur), so the cron's resize
    // block (|Δ| > 0.02 EUR) sees ~zero round-trip error on MKD leads; EUR
    // leads with qty ≥ 5 can in theory exceed the tolerance — watched in the
    // live test plan, see .grok/skills/elyon-altercpa-bridge.
    if (req.method === "POST" && segments[0] === "orders" && segments.length === 3 && segments[2] === "altercpa-push") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "orders.altercpa_push", 10)) {
        return json({ error: "Rate limit exceeded — try again in a minute" }, 429);
      }
      let pushBody: any = {};
      try { pushBody = await req.json(); } catch { /* body is optional */ }
      const dryRun = pushBody?.dry_run === true;

      const { data: pushFlag } = await adminClient
        .from("app_settings").select("value").eq("key", "altercpa_push_enabled").maybeSingle();
      if (pushFlag?.value !== true) {
        return json({ error: "AlterCPA push is disabled in Settings" }, 403);
      }

      const { data: order } = await adminClient.from("orders").select("*").eq("id", segments[1]).single();
      if (!order) return json({ error: "Order not found" }, 404);
      if (order.external_source !== "altercpa" || !order.external_order_id) {
        return json({ error: "Not linked to an AlterCPA lead" }, 422);
      }
      const pushStatus = ALTERCPA_PUSH_STATUS[String(order.status)];
      if (!pushStatus) {
        return json({ error: `Status '${order.status}' cannot be pushed to AlterCPA` }, 422);
      }
      if (order.status === "cancelled" &&
          ["pending_cleanup", "stale_pending_cleanup"].includes(String(order.cancellation_reason))) {
        return json({ error: "This cancel is a server cleanup marker, not a real disposition — nothing truthful to send" }, 422);
      }

      // Account + token. The ledger row names the account; an order without one
      // falls back to the single active account and refuses to guess between
      // several. Only the secret NAME lives in the table — never the token.
      const { data: pushLead } = await adminClient
        .from("altercpa_leads")
        .select("id, account_id, altercpa_id, phase, status, reason, price_raw, currency_raw, price_eur")
        .eq("order_id", order.id)
        .maybeSingle();
      let pushAccount: any = null;
      if (pushLead) {
        const { data: acc } = await adminClient
          .from("altercpa_accounts").select("id, name, api_base, token_secret_name, is_active")
          .eq("id", pushLead.account_id).maybeSingle();
        if (!acc || !acc.is_active) return json({ error: "The AlterCPA account for this lead is inactive" }, 422);
        pushAccount = acc;
      } else {
        const { data: accts } = await adminClient
          .from("altercpa_accounts").select("id, name, api_base, token_secret_name")
          .eq("is_active", true);
        if ((accts || []).length !== 1) {
          return json({ error: "No ledger link for this order and the AlterCPA account is ambiguous" }, 422);
        }
        pushAccount = accts![0];
      }
      const pushToken = Deno.env.get(pushAccount.token_secret_name) ?? "";
      if (!pushToken && !dryRun) {
        return json({ error: `Secret ${pushAccount.token_secret_name} is not set on the api function` }, 500);
      }

      // Param assembly. Only non-empty values — on edit.json, sent = overwrite.
      const p = new URLSearchParams({ oid: String(order.external_order_id) });
      if (pushStatus === "accept") p.set("accept", "1");
      else p.set("status", String(pushStatus));
      if (order.status === "cancelled") {
        p.set("reason", String(ALTERCPA_PUSH_CANCEL_REASON[String(order.cancellation_reason)] ?? 2));
      } else if (order.status === "trashed") {
        p.set("reason", String(ALTERCPA_PUSH_TRASH_REASON[String(order.trash_reason)] ?? 2));
      }
      // returned: no reason param — reason is only documented for status 5; the
      // return_reason travels in the comment instead.

      const setIf = (key: string, v: unknown) => {
        const s = String(v ?? "").trim();
        if (s) p.set(key, s);
      };
      setIf("name", order.customer_name);
      setIf("phone", String(order.customer_phone ?? "").replace(/\D/g, "")); // their API: digits only
      setIf("city", order.customer_city);
      setIf("street", [order.street, order.street_number]
        .map((x: unknown) => String(x ?? "").trim()).filter(Boolean).join(" "));
      setIf("area", order.quarter);
      setIf("addr", String(order.customer_address ?? "").trim().slice(0, 500));
      setIf("index", order.postal_code);

      const pushQty = Math.max(1, Math.floor(Number(order.quantity) || 1));
      p.set("count", String(pushQty));

      // base = UNIT price in THEIR currency, computed from the ORDER TOTAL
      // (halves rounding drift vs a pre-rounded unit price). Rate resolution:
      // eur → 1 exact; else the lead's own implied rate price_raw/price_eur
      // (reproduces their figure bit-for-bit while the price is unchanged);
      // else mkd/missing → the frozen 61.5 peg. Any other currency → OMIT base
      // rather than invent an FX rate (bridge doctrine).
      let pushWarning: string | undefined;
      {
        const cur = String(pushLead?.currency_raw ?? "mkd").toLowerCase();
        const total = Number(order.price);
        let rate: number | null = null;
        if (cur === "eur") rate = 1;
        else if (pushLead && Number(pushLead.price_raw) > 0 && Number(pushLead.price_eur) > 0) {
          rate = Number(pushLead.price_raw) / Number(pushLead.price_eur);
        } else if (cur === "mkd") rate = 61.5; // frozen — must match src/lib/currency.ts
        if (rate !== null && Number.isFinite(total) && total > 0) {
          p.set("base", String(Math.round(((total * rate) / pushQty) * 100) / 100));
        } else if (Number.isFinite(total) && total > 0) {
          pushWarning = `unit price omitted: no exchange rate for '${cur}'`;
        }
      }

      // Comment: the client sends orderReasonText()'s localized string (i18n
      // lives in the browser); the server fallback is the same shape in English.
      const fallbackComment = (() => {
        const [code, notes] =
          order.status === "trashed" ? [order.trash_reason, order.trash_reason_notes]
          : order.status === "returned" ? [order.return_reason, order.return_reason_notes]
          : order.status === "cancelled" ? [order.cancellation_reason, order.cancellation_reason_notes]
          : [null, null];
        if (!code) return "";
        const label = String(code).replace(/_/g, " ");
        return notes ? `${label} — ${notes}` : label;
      })();
      const pushComment = String(pushBody?.comment ?? fallbackComment ?? "")
        .replace(/\s+/g, " ").trim().slice(0, 500);
      if (pushComment) p.set("comment", pushComment);

      const pushBase = String(pushAccount.api_base ?? "https://api.cpa.moe").replace(/\/+$/, "");
      if (dryRun) {
        // The costless preview: exactly what WOULD be sent, token redacted.
        // Powers the confirm dialog and Phase A of the test plan.
        return json({
          dry_run: true,
          account: pushAccount.name,
          oid: String(order.external_order_id),
          token_present: !!pushToken,
          params: Object.fromEntries(p),
          url: `${pushBase}/comp/edit.json?id=<${pushAccount.token_secret_name}>&${p.toString()}`,
          remote: pushLead ? { phase: pushLead.phase, status: pushLead.status, reason: pushLead.reason } : null,
          ...(pushWarning ? { warning: pushWarning } : {}),
        });
      }

      const { data: pushActorProfile } = await adminClient
        .from("profiles").select("full_name").eq("user_id", user.id).single();
      const pushActorName = pushActorProfile?.full_name || user.email;

      let pushBodyText = "";
      try {
        const res = await fetch(`${pushBase}/comp/edit.json?id=${encodeURIComponent(pushToken)}&${p.toString()}`);
        pushBodyText = await res.text();
      } catch (e) {
        return json({ error: `AlterCPA unreachable: ${(e as Error).message}` }, 502);
      }
      // HTTP 200 is meaningless here — the verdict is in the JSON body, and
      // their "edit" (no fields changed) is a successful no-op.
      const verdict = classifyPostbackBody(pushBodyText);
      let pushNoop = false;
      try { pushNoop = JSON.parse(pushBodyText)?.error === "edit"; } catch { /* non-JSON = delivered */ }

      if (!verdict.ok) {
        const msg = String(verdict.error ?? "").includes("access-denied")
          ? "AlterCPA refused the write (access-denied) — the merchant token has no write scope. Turn the feature off in Settings until a write-capable key exists."
          : `AlterCPA error: ${verdict.error}`;
        await adminClient.from("order_notes").insert({
          order_id: order.id, text: `CPA push FAILED: ${msg}`,
          author_id: user.id, author_name: pushActorName,
        });
        await audit(adminClient, user.id, user.email, "order.altercpa_push_failed", {
          target_type: "order", target_id: order.id,
          payload: { oid: String(order.external_order_id), account: pushAccount.name, error: verdict.error },
        });
        return json({ error: msg }, 502);
      }

      // Ledger truth: re-read the ONE lead so altercpa_leads reflects what the
      // push actually did on their side (edit.json may normalize status→phase).
      // A failed re-read falls back to the pushed status/reason — never guess
      // phase. No lead row → nothing to refresh.
      if (pushLead) {
        let refreshed = false;
        try {
          const res = await fetch(
            `${pushBase}/comp/list.json?id=${encodeURIComponent(pushToken)}&oid=${encodeURIComponent(String(order.external_order_id))}`,
          );
          const arr = JSON.parse(await res.text());
          if (Array.isArray(arr) && arr[0]) {
            const r = arr[0];
            await adminClient.from("altercpa_leads").update({
              phase: Number(r.phase) || null,
              status: Number(r.status) || null,
              reason: Number(r.reason) || 0,
              payload: r,
              last_seen_at: new Date().toISOString(),
              ...(Number(r.phase) !== pushLead.phase ? { phase_seen_at: new Date().toISOString() } : {}),
            }).eq("id", pushLead.id);
            refreshed = true;
          }
        } catch { /* fall through to the pushed-values fallback */ }
        if (!refreshed) {
          await adminClient.from("altercpa_leads").update({
            ...(pushStatus === "accept" ? {} : { status: pushStatus }),
            ...(p.has("reason") ? { reason: Number(p.get("reason")) } : {}),
            last_seen_at: new Date().toISOString(),
          }).eq("id", pushLead.id);
        }
      }

      const statusLabel = pushStatus === "accept" ? "accepted (accept=1)" : `status ${pushStatus}`;
      await adminClient.from("order_notes").insert({
        order_id: order.id,
        text: `Pushed to AlterCPA (${pushAccount.name}): ${statusLabel}`
          + (p.has("reason") ? `, reason ${p.get("reason")}` : "")
          + `, ${pushQty} × ${p.get("base") ?? "—"}`
          + ` — ${pushNoop ? "no fields changed (already current)" : "accepted"}`,
        author_id: user.id, author_name: pushActorName,
      });
      await audit(adminClient, user.id, user.email, "order.altercpa_push", {
        target_type: "order", target_id: order.id,
        payload: {
          oid: String(order.external_order_id), account: pushAccount.name,
          params: Object.fromEntries(p), noop: pushNoop,
        },
      });

      return json({ success: true, noop: pushNoop, ...(pushWarning ? { warning: pushWarning } : {}) });
    }

    // POST /api/orders/:id/attribution — privileged admin-only manual correction
    // of the original sales credit (confirmed_by_*). This is the escape hatch
    // the user requested so super-admins can fix mis-attributed orders or
    // re-assign credit when needed, while normal status flows keep the
    // original confirmer immutable.
    if (req.method === "POST" && segments[0] === "orders" && segments[2] === "attribution") {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      const orderId = segments[1];
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

      const targetAgentId: string | null = body?.confirmed_by_agent_id ?? null;

      const { data: order } = await adminClient
        .from("orders")
        .select("id, confirmed_by_name, confirmed_at")
        .eq("id", orderId)
        .single();
      if (!order) return json({ error: "Order not found" }, 404);

      let newConfirmedById: string | null = null;
      let newConfirmedByName: string | null = null;

      if (targetAgentId) {
        const { data: profile } = await adminClient
          .from("profiles")
          .select("full_name")
          .eq("user_id", targetAgentId)
          .single();
        if (!profile) return json({ error: "Target agent not found" }, 404);

        newConfirmedById = targetAgentId;
        newConfirmedByName = profile.full_name || "Admin";
      }

      // confirmed_at is SACRED — it is what earns the affiliate their payout
      // (2026-08-10), so this tool may re-point WHO confirmed but never
      // WHETHER or WHEN. Re-attributing preserves the original date and only
      // stamps now if it was somehow missing; CLEARING the attribution leaves
      // the timestamp completely untouched. Sending it unconditionally, as
      // this endpoint used to, NULLed the stamp on every clear.
      const attributionUpdate: Record<string, any> = {
        confirmed_by_agent_id: newConfirmedById,
        confirmed_by_name: newConfirmedByName,
      };
      if (targetAgentId) {
        attributionUpdate.confirmed_at = order.confirmed_at ?? new Date().toISOString();
      }

      const { error: updErr } = await adminClient
        .from("orders")
        .update(attributionUpdate)
        .eq("id", orderId);
      if (updErr) return json({ error: sanitizeDbError(updErr) }, 400);

      // Audit + history entry so the change is fully traceable
      const { data: adminProfile } = await adminClient
        .from("profiles")
        .select("full_name")
        .eq("user_id", user.id)
        .single();

      await adminClient.from("order_history").insert({
        order_id: orderId,
        from_status: null,
        to_status: null,
        changed_by: user.id,
        changed_by_name: `${adminProfile?.full_name || user.email} — Manual attribution correction (was: ${order.confirmed_by_name || 'none'})`,
      });

      await audit(adminClient, user.id, user.email, "order.attribution_correction", {
        target_type: "order",
        target_id: orderId,
        payload: {
          previous_confirmed_by: order.confirmed_by_name,
          new_confirmed_by_agent_id: newConfirmedById,
          new_confirmed_by_name: newConfirmedByName,
        },
      });

      return json({ success: true, confirmed_by_name: newConfirmedByName });
    }

    // POST /api/orders/:id/assign
    if (req.method === "POST" && segments[0] === "orders" && segments[2] === "assign") {
      if (!canViewModule("assigner")) return json({ error: "Forbidden" }, 403);
      const orderId = segments[1];
      const body = await req.json();
      const { agent_id } = body;

      const { data: agentProfile } = await adminClient
        .from("profiles")
        .select("full_name")
        .eq("user_id", agent_id)
        .single();
      if (!agentProfile) return json({ error: "Agent not found" }, 404);

      const { data: adminProfile } = await adminClient
        .from("profiles")
        .select("full_name")
        .eq("user_id", user.id)
        .single();

      await adminClient
        .from("orders")
        .update({
          assigned_agent_id: agent_id,
          assigned_agent_name: agentProfile.full_name,
          assigned_at: new Date().toISOString(),
          assigned_by: adminProfile?.full_name || "Admin",
        })
        .eq("id", orderId);

      // Ping the assigned agent (unless they assigned it to themselves).
      if (agent_id !== user.id) {
        await notifyUsers(adminClient, [agent_id], {
          type: "assignment",
          title: "New order assigned to you",
          message: "An order was assigned to you — open Assigned to Me to start.",
          link: "/assigned",
        });
      }

      return json({ success: true });
    }

    // ============================================================
    // ORDER ITEMS CRUD
    // ============================================================

    // POST /api/orders/:id/items (add product to order)
    if (req.method === "POST" && segments[0] === "orders" && segments[2] === "items") {
      if (!canMutateOrders) return json({ error: "Forbidden" }, 403);
      const orderId = segments[1];
      const body = await req.json();
      const productId = body.product_id || null;
      const productName = body.product_name || "";
      const quantity = body.quantity || 1;
      const pricePerUnit = body.price_per_unit || 0;
      const totalPrice = quantity * pricePerUnit;

      // Check order is editable. adminClient, not the RLS client: agent RLS hid
      // every unassigned open order (incl. duplicates) and broke the modal save.
      const { data: currentOrder } = await adminClient.from("orders").select("status, display_id, assigned_agent_id").eq("id", orderId).single();
      if (!currentOrder) return json({ error: "Order not found" }, 404);
      if (orderOwnershipBlocked(currentOrder)) {
        return json({ error: "Forbidden — this order is assigned to another agent" }, 403);
      }
      const lockedStatuses = ["shipped", "delivered", "paid"];
      if (lockedStatuses.includes(currentOrder.status)) {
        return json({ error: "Cannot modify products — order is locked." }, 400);
      }

      const { data: item, error: itemErr } = await adminClient
        .from("order_items")
        .insert({ order_id: orderId, product_id: productId, product_name: productName, quantity, price_per_unit: pricePerUnit, total_price: totalPrice })
        .select()
        .single();
      if (itemErr) return json({ error: sanitizeDbError(itemErr) }, 400);

      // Recalculate order total from all items
      const { data: allItems } = await adminClient.from("order_items").select("total_price").eq("order_id", orderId);
      const orderTotal = (allItems || []).reduce((s: number, i: any) => s + Number(i.total_price), 0);
      await adminClient.from("orders").update({ price: orderTotal }).eq("id", orderId);

      // Log timeline
      const { data: profile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
      await adminClient.from("order_history").insert({
        order_id: orderId,
        from_status: currentOrder.status,
        to_status: currentOrder.status,
        changed_by: user.id,
        changed_by_name: `${profile?.full_name || user.email} — Product added: ${productName} (Qty ${quantity})`,
      });

      return json(item);
    }

    // PATCH /api/order-items/:id (update order item)
    if (req.method === "PATCH" && segments[0] === "order-items" && segments.length === 2) {
      if (!canMutateOrders) return json({ error: "Forbidden" }, 403);
      const itemId = segments[1];
      const body = await req.json();

      // Get current item to find its order
      // These routes reach the order ONLY through adminClient, so until 2026-08-13
      // they had no ownership check at all — any agent could mutate any order's
      // items by item id. orderOwnershipBlocked closes that.
      const { data: currentItem } = await adminClient.from("order_items").select("*, orders(status, id, display_id, assigned_agent_id)").eq("id", itemId).single();
      if (!currentItem) return json({ error: "Item not found" }, 404);
      if (currentItem.orders && orderOwnershipBlocked(currentItem.orders)) {
        return json({ error: "Forbidden — this order is assigned to another agent" }, 403);
      }

      const lockedStatuses = ["shipped", "delivered", "paid"];
      if (lockedStatuses.includes(currentItem.orders?.status)) {
        return json({ error: "Cannot modify products — order is locked." }, 400);
      }

      const updates: Record<string, any> = {};
      if (body.product_id !== undefined) updates.product_id = body.product_id;
      if (body.product_name !== undefined) updates.product_name = body.product_name;
      if (body.quantity !== undefined) updates.quantity = body.quantity;
      if (body.price_per_unit !== undefined) updates.price_per_unit = body.price_per_unit;

      // Recalculate total_price for this item
      const qty = body.quantity ?? currentItem.quantity;
      const ppu = body.price_per_unit ?? currentItem.price_per_unit;
      updates.total_price = qty * ppu;

      const { data: updatedItem, error: updateErr } = await adminClient
        .from("order_items")
        .update(updates)
        .eq("id", itemId)
        .select()
        .single();
      if (updateErr) return json({ error: sanitizeDbError(updateErr) }, 400);

      // Recalculate order total
      const orderId = currentItem.order_id;
      const { data: allItems } = await adminClient.from("order_items").select("total_price").eq("order_id", orderId);
      const orderTotal = (allItems || []).reduce((s: number, i: any) => s + Number(i.total_price), 0);
      await adminClient.from("orders").update({ price: orderTotal }).eq("id", orderId);

      // Log timeline
      const { data: profile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
      await adminClient.from("order_history").insert({
        order_id: orderId,
        from_status: currentItem.orders?.status,
        to_status: currentItem.orders?.status,
        changed_by: user.id,
        changed_by_name: `${profile?.full_name || user.email} — Product updated: ${updates.product_name || currentItem.product_name}`,
      });

      return json(updatedItem);
    }

    // DELETE /api/order-items/:id (remove product from order)
    if (req.method === "DELETE" && segments[0] === "order-items" && segments.length === 2) {
      if (!canMutateOrders) return json({ error: "Forbidden" }, 403);
      const itemId = segments[1];

      // These routes reach the order ONLY through adminClient, so until 2026-08-13
      // they had no ownership check at all — any agent could mutate any order's
      // items by item id. orderOwnershipBlocked closes that.
      const { data: currentItem } = await adminClient.from("order_items").select("*, orders(status, id, display_id, assigned_agent_id)").eq("id", itemId).single();
      if (!currentItem) return json({ error: "Item not found" }, 404);
      if (currentItem.orders && orderOwnershipBlocked(currentItem.orders)) {
        return json({ error: "Forbidden — this order is assigned to another agent" }, 403);
      }

      const lockedStatuses = ["shipped", "delivered", "paid"];
      if (lockedStatuses.includes(currentItem.orders?.status)) {
        return json({ error: "Cannot modify products — order is locked." }, 400);
      }

      const orderId = currentItem.order_id;
      const removedName = currentItem.product_name;

      await adminClient.from("order_items").delete().eq("id", itemId);

      // Recalculate order total
      const { data: allItems } = await adminClient.from("order_items").select("total_price").eq("order_id", orderId);
      const orderTotal = (allItems || []).reduce((s: number, i: any) => s + Number(i.total_price), 0);
      await adminClient.from("orders").update({ price: orderTotal }).eq("id", orderId);

      // Log timeline
      const { data: profile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
      await adminClient.from("order_history").insert({
        order_id: orderId,
        from_status: currentItem.orders?.status,
        to_status: currentItem.orders?.status,
        changed_by: user.id,
        changed_by_name: `${profile?.full_name || user.email} — Product removed: ${removedName}`,
      });

      return json({ success: true });
    }

    // PUT /api/orders/:id/items (atomic sync – overwrite all items, recalculate total, return updated order)
    if (req.method === "PUT" && segments[0] === "orders" && segments[2] === "items") {
      if (!canMutateOrders) return json({ error: "Forbidden" }, 403);
      const orderId = segments[1];
      const body = await req.json();
      const newItems: any[] = body.items;
      if (!Array.isArray(newItems)) return json({ error: "items array is required" }, 400);

      // Check order exists and is editable. adminClient, not the RLS client: agent
      // RLS hid every unassigned open order (incl. duplicates) and broke the save.
      const { data: currentOrder } = await adminClient.from("orders").select("status, display_id, assigned_agent_id").eq("id", orderId).single();
      if (!currentOrder) return json({ error: "Order not found" }, 404);
      if (orderOwnershipBlocked(currentOrder)) {
        return json({ error: "Forbidden — this order is assigned to another agent" }, 403);
      }
      const lockedStatuses = ["shipped", "delivered", "paid"];
      if (lockedStatuses.includes(currentOrder.status)) {
        return json({ error: "Cannot modify products — order is locked." }, 400);
      }

      // Delete all existing items
      await adminClient.from("order_items").delete().eq("order_id", orderId);

      // Insert new items
      let orderTotal = 0;
      const insertedItems: any[] = [];
      for (const ni of newItems) {
        const qty = Math.max(1, ni.quantity || 1);
        const ppu = Math.max(0, ni.price_per_unit || 0);
        const tp = Math.round(qty * ppu * 100) / 100;
        orderTotal += tp;
        const { data: inserted } = await adminClient.from("order_items")
          .insert({ order_id: orderId, product_id: ni.product_id || null, product_name: ni.product_name || "", quantity: qty, price_per_unit: ppu, total_price: tp })
          .select().single();
        if (inserted) insertedItems.push(inserted);
      }

      orderTotal = Math.round(orderTotal * 100) / 100;

      // Update order total + product summary fields
      // Build nice "Name xN" summary so legacy fallbacks and lists show clean output
      const summaryName = insertedItems
        .map(i => (i.quantity > 1 ? `${i.product_name} x${i.quantity}` : i.product_name))
        .filter(Boolean)
        .join(", ");
      const summaryQty = insertedItems.reduce((s: number, i: any) => s + i.quantity, 0);
      await adminClient.from("orders").update({
        price: orderTotal,
        product_name: summaryName || currentOrder.display_id,
        quantity: summaryQty || 1,
      }).eq("id", orderId);

      // Timeline log
      const { data: profile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
      await adminClient.from("order_history").insert({
        order_id: orderId,
        from_status: currentOrder.status,
        to_status: currentOrder.status,
        changed_by: user.id,
        changed_by_name: `${profile?.full_name || user.email} — Products synced (${insertedItems.length} items, total ${orderTotal})`,
      });

      // Return full updated order
      const { data: updatedOrder } = await adminClient.from("orders").select("*").eq("id", orderId).single();
      return json({ ...updatedOrder, order_items: insertedItems });
    }

    // POST /api/orders/:id/notes
    if (req.method === "POST" && segments[0] === "orders" && segments[2] === "notes") {
      if (!canMutateOrders) return json({ error: "Forbidden" }, 403);
      const orderId = segments[1];
      const body = await req.json();
      if (!body.text?.trim()) return json({ error: "Note text is required" }, 400);

      const { data: profile } = await adminClient
        .from("profiles")
        .select("full_name")
        .eq("user_id", user.id)
        .single();

      const { data: note, error } = await supabase
        .from("order_notes")
        .insert({
          order_id: orderId,
          text: body.text.trim(),
          author_id: user.id,
          author_name: profile?.full_name || user.email || "Unknown",
        })
        .select()
        .single();

      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(note);
    }

    // GET /api/dashboard-stats?period=today|yesterday|month|custom&date=YYYY-MM-DD&from=&to=&agent_id=xxx
    if (req.method === "GET" && path === "dashboard-stats") {
      const period = url.searchParams.get("period") || "today";
      // agent_id feeds a PostgREST .or() filter → UUID-validate before use.
      const agentFilterRaw = url.searchParams.get("agent_id");
      const agentFilter = agentFilterRaw && UUID_RE.test(agentFilterRaw) ? agentFilterRaw : null;

      const now = new Date();
      const todayStr = now.toISOString().substring(0, 10);
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toISOString().substring(0, 10);
      const monthStart = todayStr.substring(0, 7) + "-01";

      // Optional single-day override (agent dashboard ◀ ▶ day browsing).
      // Past days only — a future date clamps to today. Ignored for month.
      const dateRaw = url.searchParams.get("date");
      const dayParam = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
        ? (dateRaw > todayStr ? todayStr : dateRaw)
        : null;
      // Optional custom from–to range (agent dashboard "Custom" period).
      const customWin = period === "custom"
        ? customRangeWindow(url.searchParams.get("from"), url.searchParams.get("to"), todayStr, now)
        : null;

      // period=start: from agent's profiles.created_at (first day in CRM) → now.
      // Resolved per-agent inside computeMetrics when effectiveAgentId is set;
      // for admin team-wide, falls back to a far-past floor.
      let fromDate: string, toDate: string;
      if (period === "yesterday") {
        fromDate = yesterdayStr + "T00:00:00Z";
        toDate = yesterdayStr + "T23:59:59Z";
      } else if (customWin) {
        fromDate = customWin.fromDate;
        toDate = customWin.toDate;
      } else if (period === "month") {
        fromDate = monthStart + "T00:00:00Z";
        toDate = now.toISOString();
      } else if (period === "start") {
        fromDate = "2000-01-01T00:00:00Z"; // overridden per-agent below
        toDate = now.toISOString();
      } else if (dayParam && dayParam !== todayStr) {
        fromDate = dayParam + "T00:00:00Z";
        toDate = dayParam + "T23:59:59Z";
      } else {
        fromDate = todayStr + "T00:00:00Z";
        toDate = now.toISOString();
      }

      // PostgREST default page size is 1000. Paginate so a single high-volume
      // day doesn't silently truncate the dashboard.
      const paginate = async <T,>(makeQuery: () => any, pageSize = 1000): Promise<T[]> => {
        const all: T[] = [];
        for (let from = 0; ; from += pageSize) {
          const { data, error } = await makeQuery().range(from, from + pageSize - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          all.push(...data);
          if (data.length < pageSize) break;
        }
        return all;
      };

      const DASH_ORDER_SELECT =
        "id, status, price, quantity, created_at, paid_at, confirmed_at, returned_at, assigned_agent_id, confirmed_by_agent_id, order_items(product_name, quantity, price_per_unit, total_price, product_id)";

      // Helper to compute metrics for a given agent filter
      async function computeMetrics(effectiveAgentId: string | null) {
        let winFrom = fromDate;
        let winTo = toDate;
        if (period === "start" && effectiveAgentId) {
          const { data: prof } = await adminClient
            .from("profiles")
            .select("created_at")
            .eq("user_id", effectiveAgentId)
            .maybeSingle();
          if (prof?.created_at) winFrom = prof.created_at;
        }

        // Merge activity window (created_at) + earnings window (paid_at) so
        // COD paid this period on older orders still count toward packages/payout.
        const byId = new Map<string, any>();
        const activityOrders = await paginate<any>(() => {
          let q = adminClient.from("orders").select(DASH_ORDER_SELECT)
            .gte("created_at", winFrom).lte("created_at", winTo)
            .or("source_type.is.null,source_type.neq.monadon_legacy");
          if (effectiveAgentId) q = q.or(salesOwnerOrFilter(effectiveAgentId));
          return q;
        });
        for (const o of activityOrders) byId.set(o.id, o);

        const paidWindowOrders = await paginate<any>(() => {
          let q = adminClient.from("orders").select(DASH_ORDER_SELECT)
            .eq("status", "paid")
            .gte("paid_at", winFrom).lte("paid_at", winTo)
            .or("source_type.is.null,source_type.neq.monadon_legacy");
          if (effectiveAgentId) q = q.or(salesOwnerOrFilter(effectiveAgentId));
          return q;
        });
        for (const o of paidWindowOrders) byId.set(o.id, o);

        const orders = Array.from(byId.values());
        const leads = await paginate<any>(() => {
          let q = adminClient.from("prediction_leads").select("id, status, created_at, assigned_agent_id, product").gte("created_at", winFrom).lte("created_at", winTo);
          if (effectiveAgentId) q = q.eq("assigned_agent_id", effectiveAgentId);
          return q;
        });
        const calls = await paginate<any>(() => {
          let q = adminClient.from("call_logs").select("id, agent_id, created_at").gte("created_at", winFrom).lte("created_at", winTo);
          if (effectiveAgentId) q = q.eq("agent_id", effectiveAgentId);
          return q;
        });

        const lead_count = leads.length;
        // deals_won / pipeline sales: confirmed…paid (work activity, not cash)
        const deals_won = orders.filter((o: any) => ["confirmed", "shipped", "delivered", "paid"].includes(o.status)).length;
        const deals_lost = orders.filter((o: any) => ["returned", "cancelled", "trashed"].includes(o.status)).length;
        const total_value = orders.filter((o: any) => ["confirmed", "shipped", "delivered", "paid"].includes(o.status)).reduce((sum: number, o: any) => sum + Number(o.price || 0), 0);
        const tasks_completed = calls.length;
        const total_orders = orders.length;

        const orders_from_standard = deals_won;
        const orders_from_leads = 0;

        const dailyBreakdown: Record<string, { leads: number; deals_won: number; deals_lost: number; orders: number; calls: number }> = {};
        for (const o of activityOrders) {
          const day = o.created_at.substring(0, 10);
          if (!dailyBreakdown[day]) dailyBreakdown[day] = { leads: 0, deals_won: 0, deals_lost: 0, orders: 0, calls: 0 };
          dailyBreakdown[day].orders++;
          if (["confirmed", "shipped", "delivered", "paid"].includes(o.status)) dailyBreakdown[day].deals_won++;
          if (["returned", "cancelled", "trashed"].includes(o.status)) dailyBreakdown[day].deals_lost++;
        }
        for (const l of leads) {
          const day = l.created_at.substring(0, 10);
          if (!dailyBreakdown[day]) dailyBreakdown[day] = { leads: 0, deals_won: 0, deals_lost: 0, orders: 0, calls: 0 };
          dailyBreakdown[day].leads++;
        }
        for (const c of calls) {
          const day = c.created_at.substring(0, 10);
          if (!dailyBreakdown[day]) dailyBreakdown[day] = { leads: 0, deals_won: 0, deals_lost: 0, orders: 0, calls: 0 };
          dailyBreakdown[day].calls++;
        }

        const statusCounts: Record<string, number> = {};
        for (const o of activityOrders) {
          statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
        }

        // Earnings: paid orders whose paid_at falls in window (COD collected).
        const earningsOrders = orders.filter((o: any) =>
          o.status === "paid" && inPaidWindow(o, winFrom, winTo)
        );
        // Pipeline currently awaiting cash (confirmed/shipped/delivered) — from activity set
        const awaitingOrders = activityOrders.filter((o: any) =>
          ["confirmed", "shipped", "delivered"].includes(o.status)
        );
        const returnedOrders = activityOrders.filter((o: any) => o.status === "returned");

        const packages_sold = packagesSoldOf(earningsOrders);
        const packages_awaiting = packagesAwaitingOf(awaitingOrders);
        const packages_returned = packagesReturnedOf(returnedOrders);
        const returns_orders = returnedOrders.length;
        const paid_revenue = paidRevenueOf(earningsOrders);
        // Super-admins earn nothing — but pure-agent dashboards only call this for agents.
        // When admin inspects an agent, still compute bonus (recipient is the agent).
        const payout_earned = calcAgentBonus(earningsOrders);

        // Products on PAID packages only (align with packages_sold)
        const products_sold: Record<string, number> = {};
        for (const o of earningsOrders) {
          const items = o.order_items || [];
          if (items.length > 0) {
            for (const it of items) {
              const qty = Number(it.quantity || 0);
              const name = ((it.product_name as string) || "").trim() || "—";
              products_sold[name] = (products_sold[name] || 0) + qty;
            }
          } else {
            // Legacy: no line items — count order.quantity under product placeholder
            const qty = Number(o.quantity || 0) || 1;
            products_sold["—"] = (products_sold["—"] || 0) + qty;
          }
        }

        // units_sold deprecated alias → packages_sold (paid only) so old FE still works
        const units_sold = packages_sold;

        return {
          lead_count, deals_won, deals_lost, total_value, tasks_completed, total_orders,
          daily: dailyBreakdown, statusCounts, orders_from_standard, orders_from_leads,
          products_sold, units_sold,
          packages_sold, packages_awaiting, packages_returned, returns_orders,
          paid_revenue, payout_earned,
          from: winFrom, to: winTo,
        };
      }

      if (!isAdminOrManager) {
        // Pure agent: personal stats only
        const metrics = await computeMetrics(user.id);
        return json({ ...metrics, period, from: metrics.from || fromDate, to: metrics.to || toDate });
      }

      // Admin or dual-role: compute admin-level metrics (with optional agent filter)
      const effectiveAgentId = agentFilter || null;
      const adminMetrics = await computeMetrics(effectiveAgentId);

      // For dual-role users, also compute personal metrics
      let personalMetrics = null;
      if (isDualRole && !agentFilter) {
        personalMetrics = await computeMetrics(user.id);
      }

      return json({
        ...adminMetrics,
        personalMetrics,
        isDualRole,
        period, from: fromDate, to: toDate,
      });
    }

    // GET /api/my-orders?tab=confirmed|shipped|paid|returned&period=today|month|custom&date=YYYY-MM-DD&from=&to=&page=&limit=&agent_id=
    // Agent-dashboard "My Orders" drill-down worklists (client name/phone/product
    // + Call button). STRUCTURAL PRIVACY BOUNDARY: only these four detail tabs
    // are servable — the status filter is derived from `tab`, so cancelled and
    // trashed client details are unreachable here by construction. That matters
    // because agent roles are UNREDACTED in role_privacy: masking would not hide
    // anything from them, the boundary has to be structural. Cancel/trash COUNTS
    // stay in dashboard-stats.
    // Ownership = salesOwnerId (confirmer ?? assignee), enforced server-side on
    // adminClient — orders RLS only covers the assignee leg, so it cannot be
    // relied on for the confirmer scope.
    if (req.method === "GET" && path === "my-orders") {
      if (!isAgent && !isAdminOrManager) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "my-orders", 60)) {
        return json({ error: "Rate limit exceeded — slow down" }, 429);
      }

      const TAB_EVENT_COL: Record<string, string> = {
        confirmed: "confirmed_at",
        shipped: "shipped_at",
        paid: "paid_at",
        returned: "returned_at",
      };
      const tab = url.searchParams.get("tab") || "confirmed";
      const eventCol = TAB_EVENT_COL[tab];
      if (!eventCol) return json({ error: "Invalid tab" }, 400);

      const periodRaw = url.searchParams.get("period");
      const period = periodRaw === "month" ? "month" : periodRaw === "custom" ? "custom" : "today";
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20") || 20));

      // Agents are hard-locked to themselves; admins/managers may inspect an
      // agent (managers still get role_privacy masking via redactCustomerList).
      // The id is interpolated into a PostgREST .or() string → UUID-validate.
      const agentParam = url.searchParams.get("agent_id");
      let targetId = user.id;
      if (agentParam && isAdminOrManager) {
        if (!UUID_RE.test(agentParam)) return json({ error: "Invalid agent_id" }, 400);
        targetId = agentParam;
      }

      // Same UTC window math as dashboard-stats — deliberately NOT Skopje-
      // midnight, so the dashboard tiles and these lists agree. Day browsing
      // is past-only: a future date clamps to today.
      const now = new Date();
      const todayStr = now.toISOString().substring(0, 10);
      const dateRaw = url.searchParams.get("date");
      const dayParam = dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
        ? (dateRaw > todayStr ? todayStr : dateRaw)
        : null;
      const customWin = period === "custom"
        ? customRangeWindow(url.searchParams.get("from"), url.searchParams.get("to"), todayStr, now)
        : null;
      let fromDate: string, toDate: string;
      if (customWin) {
        fromDate = customWin.fromDate;
        toDate = customWin.toDate;
      } else if (period === "month") {
        fromDate = todayStr.substring(0, 7) + "-01T00:00:00Z";
        toDate = now.toISOString();
      } else if (dayParam && dayParam !== todayStr) {
        fromDate = dayParam + "T00:00:00Z";
        toDate = dayParam + "T23:59:59Z";
      } else {
        fromDate = todayStr + "T00:00:00Z";
        toDate = now.toISOString();
      }

      const ownerOr = salesOwnerOrFilter(targetId);
      const legacyOr = "source_type.is.null,source_type.neq.monadon_legacy";
      // No address columns on purpose — the worklist doesn't need them.
      const SELECT_COLS = "id, display_id, status, price, quantity, product_name, customer_name, customer_phone, created_at, confirmed_at, shipped_at, paid_at, returned_at, return_reason, order_items(product_name, quantity, price_per_unit, total_price)";

      // Tab semantics: current status == tab (+ event-date window), so the tabs
      // are disjoint — a confirmed order that ships moves to the Shipped tab.
      let q = adminClient.from("orders")
        .select(SELECT_COLS, { count: "exact" })
        .eq("status", tab) // tab IS the status — see boundary note above
        .or(ownerOr)
        .or(legacyOr);
      // Agents work duplicates since 2026-08-13, so a duplicate an agent settled
      // must appear in their own Confirmed/Paid buckets. `duplicated_from` is
      // permanent, so filtering on it here would hide their own closed work.
      if (tab === "shipped") {
        // Shipped = UNWINDOWED payment-chase list (every still-unpaid delivery),
        // most-overdue first.
        q = q.order("shipped_at", { ascending: true, nullsFirst: false });
      } else {
        q = q.gte(eventCol, fromDate).lte(eventCol, toDate).order(eventCol, { ascending: false });
      }
      q = q.range((page - 1) * limit, page * limit - 1);

      const countFor = (status: string) => {
        let c = adminClient.from("orders")
          .select("id", { count: "exact", head: true })
          .eq("status", status).or(ownerOr).or(legacyOr);
        if (status !== "shipped") c = c.gte(TAB_EVENT_COL[status], fromDate).lte(TAB_EVENT_COL[status], toDate);
        return c;
      };

      const [listRes, cRes, sRes, pRes, rRes] = await Promise.all([
        q, countFor("confirmed"), countFor("shipped"), countFor("paid"), countFor("returned"),
      ]);
      if (listRes.error) return json({ error: sanitizeDbError(listRes.error) }, 400);

      return json({
        orders: redactCustomerList(listRes.data || [], piiFlags),
        total: listRes.count || 0,
        page,
        limit,
        counts: {
          confirmed: cRes.count || 0,
          shipped: sRes.count || 0,
          paid: pRes.count || 0,
          returned: rRes.count || 0,
        },
        tab, period, from: fromDate, to: toDate,
      });
    }

    // GET /api/ceo-dashboard-stats?period=today|yesterday|month|custom&from=&to=&agent_id=
    if (req.method === "GET" && path === "ceo-dashboard-stats") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      const period = url.searchParams.get("period") || "month";
      const agentFilter = url.searchParams.get("agent_id") || null;
      const customFrom = url.searchParams.get("from");
      const customTo = url.searchParams.get("to");

      const now = new Date();
      const todayStr = now.toISOString().substring(0, 10);
      const monthStart = todayStr.substring(0, 7) + "-01";

      let fromDate: string, toDate: string;
      if (customFrom && customTo) {
        fromDate = customFrom + "T00:00:00Z";
        toDate = customTo + "T23:59:59Z";
      } else if (period === "today") {
        fromDate = todayStr + "T00:00:00Z";
        toDate = now.toISOString();
      } else if (period === "yesterday") {
        const y = new Date(now); y.setDate(y.getDate() - 1);
        fromDate = y.toISOString().substring(0, 10) + "T00:00:00Z";
        toDate = y.toISOString().substring(0, 10) + "T23:59:59Z";
      } else if (period === "all") {
        // "All time" — span everything so created_at-bounded queries are unbounded.
        fromDate = "1970-01-01T00:00:00Z";
        toDate = now.toISOString();
      } else {
        fromDate = monthStart + "T00:00:00Z";
        toDate = now.toISOString();
      }

      // PostgREST caps each SELECT at 1000 rows by default, so once the orders
      // table grows past that the dashboard would compute its KPIs from a
      // truncated sample. Paginate via .range() to fetch everything.
      const paginate = async <T,>(makeQuery: () => any, pageSize = 1000): Promise<T[]> => {
        const all: T[] = [];
        for (let from = 0; ; from += pageSize) {
          const { data, error } = await makeQuery().range(from, from + pageSize - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          all.push(...data);
          if (data.length < pageSize) break;
        }
        return all;
      };

      // Financial KPIs are scoped to the selected period by created_at — the
      // same axis as the funnel/snapshot below — so "Today" means orders that
      // came in today and where they stand now. "All time" (from = 1970) gives
      // the lifetime view. (We deliberately do NOT key off updated_at: a bulk
      // backfill bumps it, which would wrongly pull every order into "today".)
      const financialOrders = await paginate<any>(() => {
        let q = adminClient.from("orders").select("id, status, price, quantity, created_at, updated_at, assigned_agent_id, assigned_agent_name, order_items(price_per_unit, quantity, total_price, product_id), product_id")
          .gte("created_at", fromDate).lte("created_at", toDate)
          .or("source_type.is.null,source_type.neq.monadon_legacy"); // exclude Monadon legacy (another company's revenue)
        if (agentFilter) q = q.eq("assigned_agent_id", agentFilter);
        return q;
      });

      // Period orders (trend/funnel) are the SAME rows as financialOrders: same
      // created_at window, same source_type exclusion, same agent filter, and a
      // strict subset of the columns. Fetching them again doubled the work —
      // two full streams of the orders table on every request, and on
      // `period=all` that meant the whole table twice.
      const periodOrders = financialOrders;

      // Fetch products for cost_price lookup
      const { data: allProducts } = await adminClient.from("products").select("id, cost_price");
      const costMap: Record<string, number> = {};
      for (const p of allProducts || []) costMap[p.id] = Number(p.cost_price || 0);

      // === 1. FINANCIAL KPIs (from ALL orders, not date-filtered) ===
      const confirmedCount = financialOrders.filter((o: any) => o.status === "confirmed").length;
      const shippedCount = financialOrders.filter((o: any) => o.status === "shipped").length;
      const paidOrders = financialOrders.filter((o: any) => o.status === "paid");
      const paidCount = paidOrders.length;
      const paidAmount = paidOrders.reduce((s: number, o: any) => s + Number(o.price || 0), 0);
      const returnedCount = financialOrders.filter((o: any) => o.status === "returned").length;
      const returnedAmount = financialOrders.filter((o: any) => o.status === "returned").reduce((s: number, o: any) => s + Number(o.price || 0), 0);

      // Gross Revenue: shipped + paid
      const revenueOrders = financialOrders.filter((o: any) => ["shipped", "paid"].includes(o.status));
      const revenue = revenueOrders.reduce((s: number, o: any) => s + Number(o.price || 0), 0);

      // Outstanding: shipped only (not paid, not returned)
      const outstandingOrders = financialOrders.filter((o: any) => o.status === "shipped");
      const outstanding = outstandingOrders.reduce((s: number, o: any) => s + Number(o.price || 0), 0);

      // Profit: paid orders only (revenue - cost)
      let totalCost = 0;
      for (const o of paidOrders) {
        const items = o.order_items || [];
        if (items.length > 0) {
          for (const it of items) {
            const cp = costMap[it.product_id] || 0;
            totalCost += cp * (it.quantity || 1);
          }
        } else if (o.product_id) {
          totalCost += (costMap[o.product_id] || 0) * (o.quantity || 1);
        }
      }
      const profit = paidAmount - totalCost;

      // === 2. FUNNEL (from period orders — created in this period) ===
      const taken = periodOrders.filter((o: any) => o.status === "take").length;
      const allTaken = periodOrders.filter((o: any) => ["take", "call_again", "confirmed", "shipped", "delivered", "returned", "paid"].includes(o.status)).length;
      const confirmed = periodOrders.filter((o: any) => ["confirmed", "shipped", "delivered", "returned", "paid"].includes(o.status)).length;
      const paid = periodOrders.filter((o: any) => o.status === "paid").length;
      const shipped = periodOrders.filter((o: any) => ["shipped", "delivered", "returned", "paid"].includes(o.status)).length;
      const returned = periodOrders.filter((o: any) => o.status === "returned").length;
      const pending = periodOrders.filter((o: any) => o.status === "pending").length;

      const conversionRate = allTaken > 0 ? Math.round((paid / allTaken) * 10000) / 100 : 0;
      const confirmationRate = allTaken > 0 ? Math.round((confirmed / allTaken) * 10000) / 100 : 0;
      const returnRate = shipped > 0 ? Math.round((returned / shipped) * 10000) / 100 : 0;

      // === 3. DAILY REVENUE TREND (paid only, by created_at) ===
      const dailyRevenue: Record<string, { revenue: number; orders: number; leads: number }> = {};
      for (const o of periodOrders) {
        const day = o.created_at.substring(0, 10);
        if (!dailyRevenue[day]) dailyRevenue[day] = { revenue: 0, orders: 0, leads: 0 };
        dailyRevenue[day].orders++;
        if (o.status === "paid") dailyRevenue[day].revenue += Number(o.price || 0);
      }
      // Also add prediction leads count
      const pLeads = await paginate<any>(() => {
        let q = adminClient.from("prediction_leads").select("id, created_at").gte("created_at", fromDate).lte("created_at", toDate);
        if (agentFilter) q = q.eq("assigned_agent_id", agentFilter);
        return q;
      });
      for (const l of pLeads || []) {
        const day = l.created_at.substring(0, 10);
        if (!dailyRevenue[day]) dailyRevenue[day] = { revenue: 0, orders: 0, leads: 0 };
        dailyRevenue[day].leads++;
      }

      // === 4. AGENT RANKINGS (from ALL financial orders) ===
      const agentMap: Record<string, { name: string; paidRevenue: number; paidCount: number; takenCount: number; shippedCount: number; returnedCount: number }> = {};
      for (const o of financialOrders) {
        const agentName = o.assigned_agent_name || "Unassigned";
        const agentId = o.assigned_agent_id || "none";
        if (!agentMap[agentId]) agentMap[agentId] = { name: agentName, paidRevenue: 0, paidCount: 0, takenCount: 0, shippedCount: 0, returnedCount: 0 };
        if (["take", "call_again", "confirmed", "shipped", "delivered", "returned", "paid"].includes(o.status)) agentMap[agentId].takenCount++;
        if (o.status === "paid") { agentMap[agentId].paidRevenue += Number(o.price || 0); agentMap[agentId].paidCount++; }
        if (["shipped", "delivered", "returned", "paid"].includes(o.status)) agentMap[agentId].shippedCount++;
        if (o.status === "returned") agentMap[agentId].returnedCount++;
      }
      const agentRankings = Object.values(agentMap)
        .filter((a: any) => a.name !== "Unassigned")
        .sort((a: any, b: any) => b.paidRevenue - a.paidRevenue)
        .map((a: any) => ({
          name: a.name,
          paidRevenue: a.paidRevenue,
          paidCount: a.paidCount,
          conversionPct: a.takenCount > 0 ? Math.round((a.paidCount / a.takenCount) * 10000) / 100 : 0,
          returnPct: a.shippedCount > 0 ? Math.round((a.returnedCount / a.shippedCount) * 10000) / 100 : 0,
        }));

      // === 5. RISK ALERTS ===
      const alerts: { type: string; level: string; message: string }[] = [];
      const totalShippedForAlerts = financialOrders.filter((o: any) => ["shipped", "delivered", "returned", "paid"].includes(o.status)).length;
      const totalReturnedForAlerts = financialOrders.filter((o: any) => o.status === "returned").length;
      const totalTakenForAlerts = financialOrders.filter((o: any) => ["take", "call_again", "confirmed", "shipped", "delivered", "returned", "paid"].includes(o.status)).length;
      const overallReturnRate = totalShippedForAlerts > 0 ? Math.round((totalReturnedForAlerts / totalShippedForAlerts) * 10000) / 100 : 0;
      const overallConversionRate = totalTakenForAlerts > 0 ? Math.round((paidCount / totalTakenForAlerts) * 10000) / 100 : 0;
      const totalPending = financialOrders.filter((o: any) => o.status === "pending").length;
      if (overallReturnRate > 20) alerts.push({ type: "return_rate", level: "red", message: `Return rate is ${overallReturnRate}% (above 20%)` });
      if (overallConversionRate < 10 && totalTakenForAlerts > 5) alerts.push({ type: "conversion", level: "red", message: `Conversion rate is ${overallConversionRate}% (below 10%)` });
      if (outstanding > revenue * 2 && outstanding > 0) alerts.push({ type: "outstanding", level: "yellow", message: `Outstanding balance (${outstanding.toFixed(2)}) is very high` });
      if (totalPending > totalTakenForAlerts * 0.5 && totalPending > 10) alerts.push({ type: "pending", level: "yellow", message: `${totalPending} orders still pending` });

      // === 6. TODAY SNAPSHOT (orders with status *transitions* recorded today) ===
      // Precise "daily operational activity": counts orders that had a real transition
      // (especially to 'paid' or 'returned') on this calendar day, per order_history.
      // This is what powers accurate "we processed these via BigArena file today".
      const todayStart = todayStr + "T00:00:00Z";
      const historyToday = await paginate<any>(() =>
        adminClient.from("order_history")
          .select("order_id, to_status")
          .gte("changed_at", todayStart)
          .in("to_status", ["confirmed", "shipped", "paid", "returned"])
      );
      const todayOrderIds = new Set(historyToday.map((h: any) => h.order_id));
      const todayOrders = financialOrders.filter((o: any) => todayOrderIds.has(o.id));

      // For the 'paid' and 'returns' in snapshot, we can further refine to only those
      // whose *latest* relevant transition today was to that status (avoids any edge double-counting).
      const paidTransitionIdsToday = new Set(
        historyToday.filter((h: any) => h.to_status === 'paid').map((h: any) => h.order_id)
      );
      const returnedTransitionIdsToday = new Set(
        historyToday.filter((h: any) => h.to_status === 'returned').map((h: any) => h.order_id)
      );

      const todaySnapshot = {
        taken: todayOrders.length,
        confirmed: todayOrders.filter((o: any) => ["confirmed", "shipped", "delivered", "returned", "paid"].includes(o.status)).length,
        paid: todayOrders.filter((o: any) => paidTransitionIdsToday.has(o.id) && o.status === "paid").length,
        revenue: todayOrders.filter((o: any) => paidTransitionIdsToday.has(o.id) && o.status === "paid")
          .reduce((s: number, o: any) => s + Number(o.price || 0), 0),
        returns: todayOrders.filter((o: any) => returnedTransitionIdsToday.has(o.id) && o.status === "returned").length,
      };

      return json({
        revenue, profit, outstanding, totalCost, paidCount, paidAmount,
        confirmedCount, shippedCount, returnedCount, returnedAmount,
        funnel: { allTaken, confirmed, paid, shipped, returned, pending, conversionRate, confirmationRate, returnRate },
        dailyRevenue,
        agentRankings,
        topAgent: agentRankings[0] || null,
        alerts,
        todaySnapshot,
        period, from: fromDate, to: toDate,
      });
    }

    // GET /api/orders/stats
    if (req.method === "GET" && path === "orders/stats") {
      const fromP = url.searchParams.get("from");
      const toP = url.searchParams.get("to");
      // Pin bare dates to the Skopje day — see skopjeRangeEnd.
      const from = fromP && DATE_ONLY_RE.test(fromP) ? skopjeMidnight(fromP) : fromP;
      const to = toP && DATE_ONLY_RE.test(toP) ? skopjeRangeEnd(toP) : toP;

      // Three GROUP BYs in one call. This used to stream every matching order in
      // 1000-row pages and tally in JS — and the Dashboard calls it with NO date
      // filter (Dashboard.tsx: `apiGetOrderStats()`), so it walked the entire
      // orders table on every load: 80 sequential round-trips today, 200 at 200k,
      // to produce three counters. COUNT/GROUP BY is arithmetically identical, so
      // no displayed number moves. See 20260910000000_report_count_rpcs.sql.
      // Agents work duplicates since 2026-08-13 — count them for everyone. The
      // RPC keeps its p_exclude_duplicated parameter: PostgREST resolves overloads
      // by exact argument-name set, so dropping the key would 404 the function.
      const { data: stats, error: statsErr } = await adminClient.rpc("orders_status_stats", {
        p_from: from || null,
        p_to: to || null,
        p_exclude_duplicated: false,
      });
      if (statsErr) return json({ error: sanitizeDbError(statsErr) }, 400);

      // Status counts — orders only (do NOT mix prediction_leads into order stats)
      return json({
        statusCounts: stats?.statusCounts ?? {},
        agentCounts: stats?.agentCounts ?? {},
        dailyCounts: stats?.dailyCounts ?? {},
        total: stats?.total ?? 0,
      });
    }

    // ============================================================
    // PRODUCTS
    // ============================================================

    // GET /api/products
    if (req.method === "GET" && path === "products") {
      const { data, error } = await supabase
        .from("products")
        .select("*, suppliers:supplier_id(id, name)")
        .order("created_at", { ascending: false });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      // Suggested selling price = max(cost×3, current price, €15). Computed
      // server-side and exposed to everyone (it's the agent-facing default,
      // never €0). The raw cost_price is sensitive → admins only.
      const PRICE_MULTIPLIER = 3;
      const PRICE_FLOOR = 15;
      const result = (data || []).map((p: any) => {
        const cost = Number(p.cost_price || 0);
        const price = Number(p.price || 0); // website retail = the agents' default
        // Default the agent sees = website retail price when set; otherwise the
        // cost×3 / €15 floor so it's never €0. Agents can edit down (discounts).
        const suggested_price = price > 0 ? price : Math.max(cost * PRICE_MULTIPLIER, PRICE_FLOOR);
        const out: any = { ...p, suggested_price };
        if (!isAdmin) delete out.cost_price; // call agents/managers never see cost
        return out;
      });
      return json(result);
    }

    // POST /api/products
    if (req.method === "POST" && path === "products") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let body;
      try { body = parseBody(createProductSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }

      const { data, error } = await adminClient
        .from("products")
        .insert({
          name: body.name,
          description: body.description,
          price: body.price,
          cost_price: isAdmin ? body.cost_price : 0, // cost is admin-only
          sku: body.sku,
          stock_quantity: body.stock_quantity,
          low_stock_threshold: body.low_stock_threshold,
          photo_url: body.photo_url,
          is_active: body.is_active,
          category: body.category,
          supplier_id: body.supplier_id,
        })
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // PATCH /api/products/:id
    if (req.method === "PATCH" && segments[0] === "products" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const productId = segments[1];
      const body = await req.json();
      // cost_price is admin-only — managers can edit everything else.
      if (!isAdmin && "cost_price" in body) delete body.cost_price;

      // If stock_quantity is changing, log it
      if (body.stock_quantity !== undefined) {
        const { data: current } = await adminClient
          .from("products")
          .select("stock_quantity")
          .eq("id", productId)
          .single();
        if (current && current.stock_quantity !== body.stock_quantity) {
          await adminClient.from("inventory_logs").insert({
            product_id: productId,
            change_amount: body.stock_quantity - current.stock_quantity,
            previous_stock: current.stock_quantity,
            new_stock: body.stock_quantity,
            reason: "manual",
            movement_type: "manual_adjust",
            user_id: user.id,
          });
        }
      }

      const { data, error } = await adminClient
        .from("products")
        .update(body)
        .eq("id", productId)
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // POST /api/products/bigarena-stock-sync
    // Upload of the BigArena "Fulfillment Panel" stock export. The client parses the
    // file and previews the diff; we re-match every row against the catalogue here
    // (never trusting a client-supplied product id) and overwrite stock_quantity.
    // Products missing from the CRM are REPORTED, never created — operator decision.
    if (req.method === "POST" && path === "products/bigarena-stock-sync") {
      if (!isAdminOrManager && !isWarehouse) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "products.bigarena-stock-sync", 5)) {
        return json({ error: "Rate limit exceeded — try again in a minute" }, 429);
      }

      let body;
      try { body = parseBody(bigArenaStockSyncSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const filename = (body.meta?.filename || "bigarena-stock-upload").slice(0, 160);

      // Load the catalogue once and build the same three indexes the client uses.
      const { data: products, error: prodErr } = await adminClient
        .from("products")
        .select("id, sku, barcode, name, stock_quantity")
        .limit(5000);
      if (prodErr) return json({ error: sanitizeDbError(prodErr) }, 400);

      const normalizeName = (s: any) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
      const bySku = new Map<string, any>();
      const byBarcode = new Map<string, any>();
      const byName = new Map<string, any>();
      for (const p of (products || [])) {
        if (p.sku) bySku.set(String(p.sku).trim(), p);
        if (p.barcode) byBarcode.set(String(p.barcode).trim(), p);
        const n = normalizeName(p.name);
        if (n && !byName.has(n)) byName.set(n, p);
      }

      let updated = 0;
      let unchanged = 0;
      const notInCrm: any[] = [];
      const bigChanges: any[] = [];
      const details: any[] = [];
      const seenProductIds = new Set<string>();

      for (const row of body.rows) {
        const sku = row.sku ? String(row.sku).trim() : "";
        const barcode = row.barcode ? String(row.barcode).trim() : "";
        const product =
          (sku && bySku.get(sku)) ||
          (barcode && byBarcode.get(barcode)) ||
          byName.get(normalizeName(row.name)) ||
          null;

        if (!product) {
          notInCrm.push({ sku: row.sku || null, name: row.name, free: row.free });
          continue;
        }
        // Two file rows resolving to the same product would fight each other — the
        // client already merges shared-barcode rows, so this is a corrupt file.
        if (seenProductIds.has(product.id)) {
          details.push({ sku: row.sku, name: row.name, reason: "duplicate_match_skipped" });
          continue;
        }
        seenProductIds.add(product.id);

        const previous = Number(product.stock_quantity || 0);
        if (previous === row.free) { unchanged++; continue; }

        const { error: updErr } = await adminClient
          .from("products")
          .update({ stock_quantity: row.free })
          .eq("id", product.id);
        if (updErr) {
          details.push({ sku: row.sku, name: row.name, reason: sanitizeDbError(updErr) });
          continue;
        }

        await adminClient.from("inventory_logs").insert({
          product_id: product.id,
          change_amount: row.free - previous,
          previous_stock: previous,
          new_stock: row.free,
          reason: "bigarena_import",
          movement_type: "bigarena_sync",
          user_id: user.id,
          notes: `BigArena stock sync — ${filename}`,
        });

        // Flag drastic drops so the report surfaces them even though the operator
        // already saw the delta in the preview.
        if (previous - row.free > 500 && row.free < previous * 0.1) {
          bigChanges.push({ name: product.name, previous_stock: previous, new_stock: row.free });
        }
        updated++;
      }

      await audit(adminClient, user.id, user.email, "products.bigarena_stock_sync", {
        filename,
        rows: body.rows.length,
        updated,
        unchanged,
        not_in_crm: notInCrm.length,
        big_changes: bigChanges.length,
      });

      return json({ success: true, updated, unchanged, notInCrm, bigChanges, details });
    }

    // GET /api/products/:id/inventory-logs
    if (req.method === "GET" && segments[0] === "products" && segments[2] === "inventory-logs") {
      const productId = segments[1];
      const { data, error } = await adminClient
        .from("inventory_logs")
        .select("*")
        .eq("product_id", productId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // ============================================================
    // PREDICTION LISTS & LEADS
    // ============================================================

    // GET /api/prediction-lists
    if (req.method === "GET" && path === "prediction-lists") {
      const { data, error } = await supabase
        .from("prediction_lists")
        .select("*")
        .order("uploaded_at", { ascending: false });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // POST /api/prediction-lists (upload)
    if (req.method === "POST" && path === "prediction-lists") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let body;
      try { body = parseBody(predictionListSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const { name, entries } = body;

      const { data: list, error: listErr } = await adminClient
        .from("prediction_lists")
        .insert({
          name: name.trim(),
          uploaded_by: user.id,
          total_records: entries.length,
          assigned_count: 0,
        })
        .select()
        .single();
      if (listErr) return json({ error: sanitizeDbError(listErr) }, 400);

      // Insert leads
      const leads = entries.map((e: any) => ({
        list_id: list.id,
        name: e.name || "",
        telephone: e.telephone || "",
        address: e.address || "",
        city: e.city || "",
        product: e.product || "",
      }));

      const { error: leadsErr } = await adminClient.from("prediction_leads").insert(leads);
      if (leadsErr) return json({ error: sanitizeDbError(leadsErr) }, 400);

      return json(list);
    }

    // GET /api/prediction-lists/:id
    if (req.method === "GET" && segments[0] === "prediction-lists" && segments.length === 2) {
      const listId = segments[1];
      const { data: list } = await supabase
        .from("prediction_lists")
        .select("*")
        .eq("id", listId)
        .single();
      if (!list) return json({ error: "List not found" }, 404);

      const { data: leads } = await adminClient
        .from("prediction_leads")
        .select("*")
        .eq("list_id", listId)
        .order("created_at", { ascending: true })
        .limit(5000);

      return json({ ...list, entries: leads || [] });
    }

    // POST /api/prediction-lists/:id/assign (bulk assign)
    if (req.method === "POST" && segments[0] === "prediction-lists" && segments[2] === "assign") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const listId = segments[1];
      const body = await req.json();
      const { agent_id, lead_ids } = body;

      const { data: agentProfile } = await adminClient
        .from("profiles")
        .select("full_name")
        .eq("user_id", agent_id)
        .single();
      if (!agentProfile) return json({ error: "Agent not found" }, 404);

      const { error } = await adminClient
        .from("prediction_leads")
        .update({
          assigned_agent_id: agent_id,
          assigned_agent_name: agentProfile.full_name,
        })
        .in("id", lead_ids)
        .eq("list_id", listId);
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Update assigned count
      const { count } = await adminClient
        .from("prediction_leads")
        .select("id", { count: "exact", head: true })
        .eq("list_id", listId)
        .not("assigned_agent_id", "is", null);

      await adminClient
        .from("prediction_lists")
        .update({ assigned_count: count || 0 })
        .eq("id", listId);

      return json({ success: true, assigned_count: count });
    }

    // GET /api/prediction-leads/my (agent's assigned leads)
    if (req.method === "GET" && path === "prediction-leads/my") {
      const search = url.searchParams.get("search");

      // Agents are always restricted to their own assigned leads — no global
      // search bypass via adminClient.
      let query: any;
      if (isAdminOrManager) {
        query = adminClient
          .from("prediction_leads")
          .select("*, prediction_lists(name), prediction_lead_items(*)")
          .not("assigned_agent_id", "is", null);
      } else {
        query = supabase
          .from("prediction_leads")
          .select("*, prediction_lists(name), prediction_lead_items(*)")
          .eq("assigned_agent_id", user.id);
      }

      if (search) {
        const s = sanitizeSearch(search);
        if (s) query = query.or(`name.ilike.%${s}%,telephone.ilike.%${s}%`);
      }

      const { data, error } = await query
        .order("updated_at", { ascending: false })
        .limit(3000);
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Add is_owned flag
      const enriched = (data || []).map((l: any) => ({
        ...l,
        is_owned: isAdminOrManager || l.assigned_agent_id === user.id,
      }));
      return json(enriched);
    }

    // ============================================================
    // PREDICTION LEAD ITEMS CRUD
    // ============================================================

    // POST /api/prediction-leads/:id/items (add product to lead)
    if (req.method === "POST" && segments[0] === "prediction-leads" && segments[2] === "items") {
      const leadId = segments[1];
      const body = await req.json();
      const productId = body.product_id || null;
      const productName = body.product_name || "";
      const quantity = Math.max(1, parseInt(body.quantity) || 1);
      const pricePerUnit = Math.max(0, parseFloat(body.price_per_unit) || 0);
      const totalPrice = Math.round(quantity * pricePerUnit * 100) / 100;

      const { data: item, error: itemErr } = await adminClient
        .from("prediction_lead_items")
        .insert({ lead_id: leadId, product_id: productId, product_name: productName, quantity, price_per_unit: pricePerUnit, total_price: totalPrice })
        .select()
        .single();
      if (itemErr) return json({ error: sanitizeDbError(itemErr) }, 400);

      // Recalculate lead total from all items
      const { data: allItems } = await adminClient.from("prediction_lead_items").select("total_price").eq("lead_id", leadId);
      const leadTotal = (allItems || []).reduce((s: number, i: any) => s + Number(i.total_price), 0);
      const totalQty = (allItems || []).length;
      await adminClient.from("prediction_leads").update({ price: leadTotal, quantity: totalQty }).eq("id", leadId);

      return json(item);
    }

    // PATCH /api/prediction-lead-items/:id (update lead item)
    if (req.method === "PATCH" && segments[0] === "prediction-lead-items" && segments.length === 2) {
      const itemId = segments[1];
      const body = await req.json();

      const { data: currentItem } = await adminClient.from("prediction_lead_items").select("*").eq("id", itemId).single();
      if (!currentItem) return json({ error: "Item not found" }, 404);

      const updates: Record<string, any> = {};
      if (body.product_id !== undefined) updates.product_id = body.product_id;
      if (body.product_name !== undefined) updates.product_name = body.product_name;
      if (body.quantity !== undefined) updates.quantity = body.quantity;
      if (body.price_per_unit !== undefined) updates.price_per_unit = body.price_per_unit;

      const qty = body.quantity ?? currentItem.quantity;
      const ppu = body.price_per_unit ?? currentItem.price_per_unit;
      updates.total_price = Math.round(qty * ppu * 100) / 100;

      const { data: updatedItem, error: updateErr } = await adminClient
        .from("prediction_lead_items")
        .update(updates)
        .eq("id", itemId)
        .select()
        .single();
      if (updateErr) return json({ error: sanitizeDbError(updateErr) }, 400);

      // Recalculate lead total
      const leadId = currentItem.lead_id;
      const { data: allItems } = await adminClient.from("prediction_lead_items").select("total_price").eq("lead_id", leadId);
      const leadTotal = (allItems || []).reduce((s: number, i: any) => s + Number(i.total_price), 0);
      await adminClient.from("prediction_leads").update({ price: leadTotal }).eq("id", leadId);

      return json(updatedItem);
    }

    // DELETE /api/prediction-lead-items/:id (remove product from lead)
    if (req.method === "DELETE" && segments[0] === "prediction-lead-items" && segments.length === 2) {
      const itemId = segments[1];

      const { data: currentItem } = await adminClient.from("prediction_lead_items").select("*").eq("id", itemId).single();
      if (!currentItem) return json({ error: "Item not found" }, 404);

      const leadId = currentItem.lead_id;
      await adminClient.from("prediction_lead_items").delete().eq("id", itemId);

      // Recalculate lead total
      const { data: allItems } = await adminClient.from("prediction_lead_items").select("total_price").eq("lead_id", leadId);
      const leadTotal = (allItems || []).reduce((s: number, i: any) => s + Number(i.total_price), 0);
      const totalQty = (allItems || []).length;
      await adminClient.from("prediction_leads").update({ price: leadTotal, quantity: totalQty > 0 ? totalQty : 1 }).eq("id", leadId);

      return json({ success: true });
    }

    // POST /api/prediction-leads/unassign (admin: bulk unassign leads)
    if (req.method === "POST" && path === "prediction-leads/unassign") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const body = await req.json();
      const { lead_ids } = body;
      if (!lead_ids || !Array.isArray(lead_ids) || lead_ids.length === 0) {
        return json({ error: "lead_ids array is required" }, 400);
      }

      // Get leads to find their list_ids for updating assigned_count
      const { data: leadsToUnassign } = await adminClient
        .from("prediction_leads")
        .select("id, list_id, assigned_agent_name")
        .in("id", lead_ids);

      const { error } = await adminClient
        .from("prediction_leads")
        .update({ assigned_agent_id: null, assigned_agent_name: null })
        .in("id", lead_ids);
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Update assigned_count for affected lists
      const affectedListIds = [...new Set((leadsToUnassign || []).map((l: any) => l.list_id))];
      for (const listId of affectedListIds) {
        const { count } = await adminClient
          .from("prediction_leads")
          .select("id", { count: "exact", head: true })
          .eq("list_id", listId)
          .not("assigned_agent_id", "is", null);
        await adminClient
          .from("prediction_lists")
          .update({ assigned_count: count || 0 })
          .eq("id", listId);
      }

      return json({ success: true, unassigned: lead_ids.length });
    }

    // POST /api/prediction-leads/:id/take (agent takes ownership)
    if (req.method === "POST" && segments[0] === "prediction-leads" && segments[2] === "take" && segments.length === 3) {
      const leadId = segments[1];

      // Get agent profile
      const { data: agentProfile } = await adminClient
        .from("profiles")
        .select("full_name")
        .eq("user_id", user.id)
        .single();

      // Verify lead exists and can be taken
      const { data: lead } = await adminClient
        .from("prediction_leads")
        .select("id, assigned_agent_id, status")
        .eq("id", leadId)
        .single();
      if (!lead) return json({ error: "Lead not found" }, 404);

      // If already assigned to someone else and not admin, block
      if (lead.assigned_agent_id && lead.assigned_agent_id !== user.id && !isAdminOrManager) {
        return json({ error: "Lead is already assigned to another agent" }, 403);
      }

      const { data, error } = await adminClient
        .from("prediction_leads")
        .update({
          assigned_agent_id: user.id,
          assigned_agent_name: agentProfile?.full_name || user.email,
          status: "interested", // Mark as taken/interested
        })
        .eq("id", leadId)
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      return json(data);
    }

    // PATCH /api/prediction-leads/:id (update status/notes/details)
    if (req.method === "PATCH" && segments[0] === "prediction-leads" && segments.length === 2) {
      const leadId = segments[1];
      const body = await req.json();

      const updates: Record<string, any> = {};
      if (body.status) updates.status = body.status;
      if (body.notes !== undefined) updates.notes = body.notes;
      if (body.address !== undefined) updates.address = body.address;
      if (body.city !== undefined) updates.city = body.city;
      if (body.telephone !== undefined) updates.telephone = body.telephone;
      if (body.product !== undefined) updates.product = body.product;
      if (body.quantity !== undefined) updates.quantity = body.quantity;
      if (body.price !== undefined) updates.price = body.price;
      if (body.name !== undefined) updates.name = body.name;

      // Ownership: lock lead to current agent on ownership-claiming statuses
      const ownershipStatuses = ["interested", "confirmed", "no_answer"];
      if (body.status && ownershipStatuses.includes(body.status) && !isAdminOrManager) {
        const { data: agentProfile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
        updates.assigned_agent_id = user.id;
        updates.assigned_agent_name = agentProfile?.full_name || user.email;
      }

      const { data, error } = await supabase
        .from("prediction_leads")
        .update(updates)
        .eq("id", leadId)
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Auto-create order when prediction lead reaches call_again or confirmed
      if (body.status && ["call_again", "confirmed"].includes(body.status)) {
        // Check if an order already exists for this lead (prevent duplicates)
        const { data: existingOrder } = await adminClient
          .from("orders")
          .select("id, status")
          .eq("source_lead_id", leadId)
          .maybeSingle();

        if (!existingOrder) {
          // Get the lead data for order creation
          const lead = data;

          // Validate: do not create empty order
          if (!lead.name && !lead.telephone) {
            // Skip order creation if no meaningful data
          } else {
            const { data: agentProfile } = lead.assigned_agent_id
              ? await adminClient.from("profiles").select("full_name").eq("user_id", lead.assigned_agent_id).single()
              : { data: null };

            // Fetch prediction_lead_items for multi-product transfer
            const { data: leadItems } = await adminClient
              .from("prediction_lead_items")
              .select("*")
              .eq("lead_id", leadId);

            // Determine product summary from items or lead fields
            const hasItems = leadItems && leadItems.length > 0;
            const productSummary = hasItems
              ? leadItems.map((i: any) => i.product_name).join(", ")
              : (lead.product || "From Prediction Lead");
            const totalPrice = hasItems
              ? leadItems.reduce((s: number, i: any) => s + Number(i.total_price || 0), 0)
              : Number(lead.price || 0);
            const totalQty = hasItems
              ? leadItems.reduce((s: number, i: any) => s + Number(i.quantity || 1), 0)
              : Number(lead.quantity || 1);

            const { data: newOrder } = await adminClient
              .from("orders")
              .insert({
                product_name: productSummary,
                customer_name: lead.name || "",
                customer_phone: lead.telephone || "",
                customer_city: lead.city || "",
                customer_address: lead.address || "",
                postal_code: "",
                price: totalPrice,
                quantity: totalQty,
                status: body.status === "confirmed" ? "confirmed" : "call_again",
                source_type: "prediction_lead",
                source_lead_id: leadId,
                assigned_agent_id: lead.assigned_agent_id,
                assigned_agent_name: agentProfile?.full_name || lead.assigned_agent_name || null,
                assigned_at: lead.assigned_agent_id ? new Date().toISOString() : null,
              })
              .select()
              .single();

            if (newOrder) {
              // Transfer multi-product items to order_items
              if (hasItems) {
                const orderItems = leadItems.map((i: any) => ({
                  order_id: newOrder.id,
                  product_id: i.product_id,
                  product_name: i.product_name,
                  quantity: i.quantity,
                  price_per_unit: Number(i.price_per_unit),
                  total_price: Number(i.total_price),
                }));
                await adminClient.from("order_items").insert(orderItems);
              } else if (lead.product) {
                // Single product fallback
                await adminClient.from("order_items").insert({
                  order_id: newOrder.id,
                  product_id: null,
                  product_name: lead.product,
                  quantity: lead.quantity || 1,
                  price_per_unit: Number(lead.price || 0),
                  total_price: totalPrice,
                });
              }

              // Transfer notes
              if (lead.notes && lead.notes.trim()) {
                const changerName = agentProfile?.full_name || "System";
                await adminClient.from("order_notes").insert({
                  order_id: newOrder.id,
                  text: lead.notes.trim(),
                  author_id: user.id,
                  author_name: changerName,
                });
              }

              // Log conversion in order history
              const { data: converterProfile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
              await adminClient.from("order_history").insert({
                order_id: newOrder.id,
                to_status: newOrder.status,
                changed_by: user.id,
                changed_by_name: converterProfile?.full_name || "System",
              });
              // Add conversion note
              await adminClient.from("order_notes").insert({
                order_id: newOrder.id,
                text: "Converted from Prediction Lead",
                author_id: user.id,
                author_name: "System",
              });
            }
          }
        } else {
          // Update existing order status to match lead
          const newStatus = body.status === "confirmed" ? "confirmed" : "call_again";
          if (existingOrder.status !== newStatus) {
            await adminClient.from("orders").update({ status: newStatus }).eq("id", existingOrder.id);
            const { data: profile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
            await adminClient.from("order_history").insert({
              order_id: existingOrder.id,
              from_status: existingOrder.status,
              to_status: newStatus,
              changed_by: user.id,
              changed_by_name: profile?.full_name || "System",
            });
          }
        }
      }

      return json(data);
    }

    // POST /api/check-phone-duplicates
    if (req.method === "POST" && path === "check-phone-duplicates") {
      const body = await req.json();
      const { phone, exclude_order_id } = body;
      if (!phone) return json({ error: "Phone is required" }, 400);

      const { data, error } = await adminClient.rpc("check_phone_duplicates", {
        _phone: phone,
        _exclude_order_id: exclude_order_id || null,
      });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // GET /api/agent-performance — full business metrics (admin: all; agents: self only)
    if (req.method === "GET" && path === "agent-performance") {
      // Allow regular agents (including pending/prediction) to see their *own* performance + payout.
      // Admins/managers can see everyone.
      const isPersonalView = !isAdminOrManager;

      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      // Earnings metrics (packages_sold, payout) window by paid_at by default.
      // date_basis=created_at keeps the legacy activity-window behaviour for all metrics.
      const dateBasis = url.searchParams.get("date_basis") === "created_at" ? "created_at" : "paid_at";
      const search = url.searchParams.get("search")?.toLowerCase();
      const sourceFilter = url.searchParams.get("source");
      const statusFilter = url.searchParams.get("status");
      const includeCancelled = url.searchParams.get("include_cancelled") === "true";
      let agentIdFilter = url.searchParams.get("agent_id");
      const showZero = url.searchParams.get("show_zero") === "true";

      // Force personal scope for non-admins
      if (isPersonalView) {
        agentIdFilter = user.id;
        // Clear search/filter that could leak other agents
        // (search and agentFilter from query are ignored for personal view)
      }

      // ── Engine switch (same pattern as management-insights) ──
      // `legacy` streams every attributed order into this function 1000 rows a
      // round-trip — the whole ~80k-row table for the "Start" preset — and at
      // all-time blows the CPU budget, which KILLS the isolate mid-request.
      // `sql` gets the identical arithmetic as one GROUP BY over
      // (owner_id, owner_raw) via agent_performance_rollup(); the identity
      // fold, the exact-name bonus gate and every rounding stay in the shared
      // TS below, so the response cannot drift between engines.
      //
      // Default comes from the AGENT_PERF_ENGINE secret, so rollback is one
      // `supabase secrets set AGENT_PERF_ENGINE=legacy` with no deploy, and
      // ?engine=legacy is a per-request escape hatch that needs nothing at all.
      const perfEngine = url.searchParams.get("engine") || Deno.env.get("AGENT_PERF_ENGINE") || "legacy";
      const usePerfSql = perfEngine === "sql";

      // Paginate past PostgREST's 1000-row default so high-volume agents don't undercount.
      const paginateOrders = async (makeQuery: () => any, pageSize = 1000): Promise<any[]> => {
        const all: any[] = [];
        for (let fromIdx = 0; ; fromIdx += pageSize) {
          const { data, error } = await makeQuery().range(fromIdx, fromIdx + pageSize - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          all.push(...data);
          if (data.length < pageSize) break;
        }
        return all;
      };

      // Fetch orders first (we need them to know which users actually have sales activity).
      // "trashed" is fetched so we can show a per-agent junk/wrong-number count; it is
      // separated out below so it never inflates leads, packages, payout or any rate.
      // Cancelled + trashed are ALWAYS fetched so their per-agent counts are real:
      // the Cancelled/Trashed cards must never read 0 just because the toggle is off.
      // Whether cancelled counts as a *lead* / rate denominator is decided per-agent
      // below via includeCancelled — exactly how trashed is always kept out of leads.
      const statusesToFetch = ["take", "call_again", "confirmed", "shipped", "delivered", "returned", "paid", "trashed", "cancelled"];
      const ORDER_PERF_SELECT = "id, status, assigned_agent_id, confirmed_by_agent_id, assigned_agent_name, confirmed_by_name, price, quantity, product_id, created_at, paid_at, confirmed_at, returned_at, shipped_at, source_type, prediction_list_id, order_items(price_per_unit, quantity, total_price, product_id)";

      const baseOrdersFilter = (q: any) => {
        let qq = q.in("status", statusesToFetch)
          .or("source_type.is.null,source_type.neq.monadon_legacy")
          // Only orders with SOME attribution can contribute — the loop below
          // skips anything with neither an owner id nor an operator name.
          // Filtering server-side instead of streaming and discarding is
          // semantically identical and keeps unattributed rows off the wire.
          .or("confirmed_by_agent_id.not.is.null,assigned_agent_id.not.is.null,confirmed_by_name.not.is.null,assigned_agent_name.not.is.null");
        if (sourceFilter) qq = qq.eq("source_type", sourceFilter);
        if (statusFilter) qq = qq.eq("status", statusFilter);
        return qq;
      };

      // Two windows merged by id when a date range is set:
      //   (1) created_at in range → activity / pipeline / cancels
      //   (2) paid_at in range → COD collected this period (may have been created earlier)
      // Without a range, fetch everything in the status set.
      let allOrders: any[] = [];
      // The SQL engine gets both windows (created_at OR paid_at, deduped) as
      // one WHERE inside agent_performance_rollup — it never streams rows.
      let sqlGroups: any[] = [];
      if (usePerfSql) {
        const { data: rollup, error: rollupErr } = await adminClient.rpc("agent_performance_rollup", {
          p_from: from || null,
          p_to: to || null,
          p_source: sourceFilter || null,
          p_status: statusFilter || null,
          // earnings window applies only on paid_at basis with a range set —
          // mirrors the earningsOrders filter below.
          p_earn_windowed: dateBasis === "paid_at" && !!(from || to),
        });
        if (rollupErr) return json({ error: `agent_performance_rollup: ${sanitizeDbError(rollupErr)}` }, 500);
        sqlGroups = (rollup as any[]) || [];
      } else if (from || to) {
        const byId = new Map<string, any>();
        const createdRows = await paginateOrders(() => {
          let q = baseOrdersFilter(adminClient.from("orders").select(ORDER_PERF_SELECT));
          if (from) q = q.gte("created_at", from);
          if (to) q = q.lte("created_at", to);
          return q;
        });
        for (const o of createdRows) byId.set(o.id, o);

        // Earnings window: paid orders whose payment event falls in range
        // (covers COD that was confirmed last month but paid this month).
        const paidRows = await paginateOrders(() => {
          let q = adminClient.from("orders").select(ORDER_PERF_SELECT)
            .eq("status", "paid")
            .or("source_type.is.null,source_type.neq.monadon_legacy");
          if (sourceFilter) q = q.eq("source_type", sourceFilter);
          if (from) q = q.gte("paid_at", from);
          if (to) q = q.lte("paid_at", to);
          return q;
        });
        for (const o of paidRows) byId.set(o.id, o);
        allOrders = Array.from(byId.values());
      } else {
        allOrders = await paginateOrders(() =>
          baseOrdersFilter(adminClient.from("orders").select(ORDER_PERF_SELECT)));
      }

      // Build per-agent metrics + collect everyone who has any attribution
      // (assigned_agent_id OR confirmed_by_agent_id). This is the key for showing
      // SuperAdmins who make manual sales.
      // Get all active profiles (needed BEFORE attribution so a name-only order
      // can be resolved onto a real account when the name matches one).
      const { data: agents } = await adminClient
        .from("profiles")
        .select("user_id, full_name, email")
        .eq("is_active", true);

      // Name → account, so an imported order that carries only "Sanela Dzogovich"
      // still lands on Sanela's real profile rather than a parallel ghost row.
      // Keyed on the SCRIPT-FOLDED identity, so the Cyrillic spelling of the same
      // name lands there too — see agentIdentityKey().
      const idByIdentity = buildAgentIdentityIndex(agents as any);

      // The PRE-MERGE attribution index: exact normalised name only. Kept
      // deliberately, because it — not the folded index — defines the bonus
      // basis. See the commission note further down.
      const idByExactName: Record<string, string> = {};
      for (const p of agents || []) idByExactName[normAgentName(p.full_name)] = p.user_id;

      const agentOrderMap: Record<string, any[]> = {};
      const allAttributedUserIds = new Set<string>();
      // Operators who exist only as a name on imported orders — no CRM account.
      // key → how many orders each raw spelling contributed, so the row can be
      // labelled with the spelling most of the history actually uses rather than
      // with the folded key ("saska simonovska").
      const virtualVariants: Record<string, Record<string, number>> = {};

      // ONE owner per order = the first agent who confirmed it (the assignee is
      // only a legacy fallback). Crediting BOTH assignee and confirmer used to
      // double-count an order's sale + bonus, and let a super-admin who edits &
      // re-confirms an agent's order share the credit. See salesOwnerId() and
      // the elyon-agent-commissions skill.
      //
      // The imported AlterCPA history records WHO sold each order as a name
      // (70,467 orders — 100% of paid, 84% of cancelled, 77% of trashed) but
      // never a user id, because those 26 operators never had CRM logins. Keying
      // this report on the id alone made every one of those orders invisible and
      // the whole tab read empty. So: id when present, otherwise the operator's
      // folded name — see agentOwnerKey()/agentIdentityKey().
      for (const o of allOrders || []) {
        const ownerKey = agentOwnerKey(o, idByIdentity);
        if (!ownerKey) continue;
        allAttributedUserIds.add(ownerKey);
        if (ownerKey.startsWith("name:")) {
          const label = normAgentName(salesOwnerName(o));
          const v = (virtualVariants[ownerKey] ??= {});
          v[label] = (v[label] || 0) + 1;
        }
        (agentOrderMap[ownerKey] ??= []).push(o);
      }

      // SQL engine: same fold, over (owner_id, owner_raw) GROUPS instead of
      // rows. agentOwnerKey()'s resolution order is reproduced exactly: the
      // account id when the group carries one, otherwise the script-folded
      // name resolved through idByIdentity, otherwise a `name:` virtual key.
      interface PerfAgg {
        rows: number; trashed: number; cancelled: number; leadsNc: number;
        confirmed: number; shipped: number; returned: number; paidEarn: number;
        gross: number; paidRevRaw: number; outstanding: number; returnedValue: number;
        paidCost: number; returnedCost: number; pkgsSold: number; pkgsAwaiting: number;
        pkgsReturned: number; bonusQualifying: number;
      }
      const aggByOwner: Record<string, PerfAgg> = {};
      for (const grow of sqlGroups) {
        const ownerId = (grow.owner_id as string | null) ?? null;
        let ownerKey: string | null = ownerId;
        if (!ownerKey) {
          const k = agentIdentityKey(grow.owner_raw);
          if (!k) continue;
          ownerKey = idByIdentity[k] ?? `name:${k}`;
        }
        allAttributedUserIds.add(ownerKey);
        if (ownerKey.startsWith("name:")) {
          const label = normAgentName(grow.owner_raw);
          const v = (virtualVariants[ownerKey] ??= {});
          v[label] = (v[label] || 0) + Number(grow.n_rows || 0);
        }
        const a = (aggByOwner[ownerKey] ??= {
          rows: 0, trashed: 0, cancelled: 0, leadsNc: 0, confirmed: 0, shipped: 0,
          returned: 0, paidEarn: 0, gross: 0, paidRevRaw: 0, outstanding: 0,
          returnedValue: 0, paidCost: 0, returnedCost: 0, pkgsSold: 0,
          pkgsAwaiting: 0, pkgsReturned: 0, bonusQualifying: 0,
        });
        a.rows += Number(grow.n_rows || 0);
        a.trashed += Number(grow.n_trashed || 0);
        a.cancelled += Number(grow.n_cancelled || 0);
        a.leadsNc += Number(grow.n_leads_nc || 0);
        a.confirmed += Number(grow.n_confirmed || 0);
        a.shipped += Number(grow.n_shipped || 0);
        a.returned += Number(grow.n_returned || 0);
        a.paidEarn += Number(grow.n_paid_earn || 0);
        a.gross += Number(grow.gross_revenue || 0);
        a.paidRevRaw += Number(grow.paid_revenue_raw || 0);
        a.outstanding += Number(grow.outstanding_revenue || 0);
        a.returnedValue += Number(grow.returned_value || 0);
        a.paidCost += Number(grow.paid_cost || 0);
        a.returnedCost += Number(grow.returned_cost || 0);
        a.pkgsSold += Number(grow.pkgs_sold || 0);
        a.pkgsAwaiting += Number(grow.pkgs_awaiting || 0);
        a.pkgsReturned += Number(grow.pkgs_returned || 0);
        // The exact-name bonus gate, applied per GROUP: earnsBonus() is
        // constant within one — a group with an owner id always earns for its
        // account; a name-only group earns only when its exact normalised
        // spelling maps to the very account it folded onto. This keeps the
        // bonus on the pre-merge basis (see the commission note below).
        const bonusQualifies = ownerId !== null ||
          idByExactName[normAgentName(grow.owner_raw)] === ownerKey;
        if (bonusQualifies) a.bonusQualifying += Number(grow.bonus_earn || 0);
      }

      // Traditional call agents (for the base list)
      const { data: agentRoles } = await adminClient
        .from("user_roles")
        .select("user_id")
        .in("role", ["agent", "pending_agent", "prediction_agent"]);
      const traditionalAgentUserIds = new Set((agentRoles || []).map((r: any) => r.user_id));

      // Super-admins (admin/manager) earn NO bonus — even if they also hold an
      // agent role (e.g. a founder who occasionally confirms an order).
      const { data: superAdminRoles } = await adminClient
        .from("user_roles")
        .select("user_id")
        .in("role", ["admin", "manager"]);
      const superAdminUserIds = new Set((superAdminRoles || []).map((r: any) => r.user_id));

      // Start with traditional agents
      let agentProfiles = (agents || []).filter((a: any) => traditionalAgentUserIds.has(a.user_id));

      // Add any extra users who have sales attributed to them (SuperAdmins etc.)
      const existingIds = new Set(agentProfiles.map((p: any) => p.user_id));
      // `name:` keys are not uuids — they'd make the .in() below a 400.
      const missingIds = Array.from(allAttributedUserIds)
        .filter((id) => !existingIds.has(id) && !id.startsWith("name:"));

      if (missingIds.length > 0) {
        const { data: extraProfiles } = await adminClient
          .from("profiles")
          .select("user_id, full_name, email")
          .in("user_id", missingIds)
          .eq("is_active", true);
        if (extraProfiles?.length) {
          agentProfiles = [...agentProfiles, ...extraProfiles];
        }
      }

      // Operators who only ever existed as a name on the imported history. They
      // have no login and no email; is_virtual lets the UI mark them as historic
      // rather than pretending they are staff accounts.
      for (const [key, variants] of Object.entries(virtualVariants)) {
        if (existingIds.has(key)) continue;
        const label = Object.entries(variants)
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
        agentProfiles.push({ user_id: key, full_name: label, email: "", is_virtual: true });
      }

      // Apply search / single agent filter on the final list
      if (search && !isPersonalView) {
        agentProfiles = agentProfiles.filter((a: any) => a.full_name.toLowerCase().includes(search) || a.email.toLowerCase().includes(search));
      }
      if (agentIdFilter) {
        agentProfiles = agentProfiles.filter((a: any) => a.user_id === agentIdFilter);
      }

      // For non-admin users, force the list to contain only themselves
      if (isPersonalView) {
        agentProfiles = agentProfiles.filter((a: any) => a.user_id === user.id);
      }

      // Get cost prices for profit calculation (SQL engine joins products
      // inside the rollup, so the cost is already in paid_cost/returned_cost).
      const costMap: Record<string, number> = {};
      if (!usePerfSql) {
        const { data: allProducts } = await adminClient.from("products").select("id, cost_price");
        for (const p of allProducts || []) costMap[p.id] = Number(p.cost_price || 0);
      }

      // Load special agents for commission calc (pending + prediction)
      const { data: specialRoleRows } = await adminClient
        .from("user_roles")
        .select("user_id")
        .in("role", ["pending_agent", "prediction_agent"]);
      const specialAgentIds = new Set((specialRoleRows || []).map((r: any) => r.user_id));

      // Module-level unitsOf / packagesSoldOf / calcAgentBonus — do not reintroduce
      // a local units helper. packages_sold = PAID units only (COD collected).

      // Determine which agents to include: those with activity OR all if showZero
      const activeAgentIds = new Set(Object.keys(usePerfSql ? aggByOwner : agentOrderMap));
      let filteredProfiles = showZero
        ? agentProfiles
        : agentProfiles.filter((a: any) => activeAgentIds.has(a.user_id));

      // For personal view, always include the current user even if they have no activity yet
      if (isPersonalView && agentProfiles.length > 0) {
        const self = agentProfiles[0];
        if (!filteredProfiles.some((p: any) => p.user_id === self.user_id)) {
          filteredProfiles = [self, ...filteredProfiles];
        }
      }

      const results = filteredProfiles.map((agent: any) => {
        // Both engines fill the SAME intermediates; every derived formula and
        // the response literal below are shared, so the shape cannot drift.
        let leadsAssigned: number, confirmedCount: number, shippedCount: number,
          paidCount: number, returnedCount: number, cancelledCount: number,
          trashedCount: number, grossRevenue: number, paidRevenue: number,
          outstandingRevenue: number, returnedValue: number, totalProfit: number,
          returnedCost: number, packagesSold: number, packagesAwaiting: number,
          packagesReturned: number, bonusRaw: number;

        if (usePerfSql) {
          const a = aggByOwner[agent.user_id];
          // leadsAssigned: trash is never a lead; cancelled folds in only when
          // the toggle is on (it sits outside every other status set, so
          // nothing else needs it).
          leadsAssigned = a ? a.leadsNc + (includeCancelled ? a.cancelled : 0) : 0;
          confirmedCount = a?.confirmed ?? 0;
          shippedCount = a?.shipped ?? 0;
          paidCount = a?.paidEarn ?? 0;
          returnedCount = a?.returned ?? 0;
          cancelledCount = a?.cancelled ?? 0;
          trashedCount = a?.trashed ?? 0;
          grossRevenue = a?.gross ?? 0;
          paidRevenue = Math.round((a?.paidRevRaw ?? 0) * 100) / 100; // = paidRevenueOf()
          outstandingRevenue = a?.outstanding ?? 0;
          returnedValue = a?.returnedValue ?? 0;
          totalProfit = (a?.paidRevRaw ?? 0) - (a?.paidCost ?? 0); // Σ(price - cost), unrounded
          returnedCost = a?.returnedCost ?? 0;
          packagesSold = a?.pkgsSold ?? 0;
          packagesAwaiting = a?.pkgsAwaiting ?? 0;
          packagesReturned = a?.pkgsReturned ?? 0;
          bonusRaw = a?.bonusQualifying ?? 0;
        } else {
        const allAgentRows = agentOrderMap[agent.user_id] || [];
        // Trash (junk / wrong number) is tracked on its own so it never counts as
        // a lead, package, payout or feeds any rate denominator below.
        const trashedOrders = allAgentRows.filter((o: any) => o.status === "trashed");
        // Count cancelled from the FULL row set so it's always real, independent of
        // whether cancelled is folded into the lead/rate base below.
        const cancelledOrders = allAgentRows.filter((o: any) => o.status === "cancelled");
        // The "lead" base for counts + rates. Trash is never a lead. Cancelled is
        // excluded by default and only folded in when the user flips the Cancelled
        // toggle — keeping conversion clean while the Cancelled card stays accurate.
        const agentOrders = allAgentRows.filter((o: any) =>
          o.status !== "trashed" && (includeCancelled || o.status !== "cancelled")
        );

        leadsAssigned = agentOrders.length;
        const confirmedOrders = agentOrders.filter((o: any) => ["confirmed", "shipped", "delivered", "returned", "paid"].includes(o.status));
        const shippedOrders = agentOrders.filter((o: any) => ["shipped", "delivered", "returned", "paid"].includes(o.status));
        // Earnings subset: when date_basis=paid_at, only paid orders whose payment
        // event falls in the request window. Activity metrics still use agentOrders.
        const earningsOrders = dateBasis === "paid_at" && (from || to)
          ? agentOrders.filter((o: any) => o.status === "paid" && inPaidWindow(o, from, to))
          : agentOrders.filter((o: any) => o.status === "paid");
        const paidOrders = earningsOrders;
        const returnedOrders = agentOrders.filter((o: any) => o.status === "returned");

        // Financial: use locked order price
        grossRevenue = agentOrders
          .filter((o: any) => ["shipped", "paid"].includes(o.status))
          .reduce((s: number, o: any) => s + Number(o.price || 0), 0);

        paidRevenue = paidRevenueOf(paidOrders);

        outstandingRevenue = agentOrders
          .filter((o: any) => o.status === "shipped")
          .reduce((s: number, o: any) => s + Number(o.price || 0), 0);

        returnedValue = returnedOrders.reduce((s: number, o: any) => s + Number(o.price || 0), 0);

        // Profit from paid orders: price - cost snapshot
        totalProfit = 0;
        for (const o of paidOrders) {
          const items = o.order_items || [];
          let orderCost = 0;
          if (items.length > 0) {
            for (const it of items) {
              orderCost += (costMap[it.product_id] || 0) * (it.quantity || 1);
            }
          } else if (o.product_id) {
            orderCost = (costMap[o.product_id] || 0) * (o.quantity || 1);
          }
          totalProfit += Number(o.price || 0) - orderCost;
        }

        // Net Contribution: (Paid Revenue - Returned Value) - Total Cost for Paid + Returned orders
        returnedCost = 0;
        for (const o of returnedOrders) {
          const items = o.order_items || [];
          let orderCost = 0;
          if (items.length > 0) {
            for (const it of items) {
              orderCost += (costMap[it.product_id] || 0) * (it.quantity || 1);
            }
          } else if (o.product_id) {
            orderCost = (costMap[o.product_id] || 0) * (o.quantity || 1);
          }
          returnedCost += orderCost;
        }

        paidCount = paidOrders.length;
        confirmedCount = confirmedOrders.length;
        shippedCount = shippedOrders.length;
        returnedCount = returnedOrders.length;
        cancelledCount = cancelledOrders.length;
        trashedCount = trashedOrders.length;
        packagesSold = packagesSoldOf(paidOrders);
        packagesAwaiting = packagesAwaitingOf(agentOrders);
        packagesReturned = packagesReturnedOf(agentOrders);
        // Raw bonus over the exact-name-qualifying paid orders; the shared code
        // below rounds once — reproducing calcAgentBonus() exactly.
        const earnsBonus = (o: any) =>
          salesOwnerId(o) !== null ||
          idByExactName[normAgentName(salesOwnerName(o))] === agent.user_id;
        bonusRaw = 0;
        for (const o of paidOrders) if (earnsBonus(o)) bonusRaw += orderPackageBonus(o);
        }

        // ── Shared derived metrics (identical for both engines) ──
        // totalCost for paid orders is already: paidRevenue - totalProfit
        const paidCost = paidRevenue - totalProfit;
        const netContribution = (paidRevenue - returnedValue) - (paidCost + returnedCost);

        const avgOrderValue = paidCount > 0 ? Math.round((paidRevenue / paidCount) * 100) / 100 : 0;
        const revenuePerLead = leadsAssigned > 0 ? Math.round((paidRevenue / leadsAssigned) * 100) / 100 : 0;
        const profitPerLead = leadsAssigned > 0 ? Math.round((totalProfit / leadsAssigned) * 100) / 100 : 0;

        // Quality rates
        const conversionRate = leadsAssigned > 0 ? Math.round((confirmedCount / leadsAssigned) * 10000) / 100 : 0;
        const shipmentRate = confirmedCount > 0 ? Math.round((shippedCount / confirmedCount) * 10000) / 100 : 0;
        const collectionRate = shippedCount > 0 ? Math.round((paidCount / shippedCount) * 10000) / 100 : 0;
        const returnRate = shippedCount > 0 ? Math.round((returnedCount / shippedCount) * 10000) / 100 : 0;

        // === Per-package payout (every paid order, credited to confirmer) ===
        // Super-admins (admin/manager, not agents) are never on commission.
        const isSpecial = specialAgentIds.has(agent.user_id);
        const isAgentRole = traditionalAgentUserIds.has(agent.user_id) && !superAdminUserIds.has(agent.user_id);
        // ── The merge must not move money by itself (2026-08-14) ─────────────
        // Cross-script identity merging folds the imported history onto the live
        // account that sold it — Sashka Simonovska's row went from 0 to 6.315
        // orders. Counts, revenue, packages and rates SHOULD move: that is her
        // real work, and seeing it was the whole point.
        //
        // The BONUS deliberately does not. This report already credited a
        // name-only imported order to an account when the name matched EXACTLY
        // (that is how Aleksandra Hristoska's 1.081 imported orders were already
        // earning), so the bonus basis is an established, possibly already-paid
        // number. Widening the match to cross-script variants would silently add
        // thousands of euro to it — Sashka alone brings 6.315 orders that no
        // exact match ever reached. Whether pre-CRM history earns commission at
        // the new spellings is the operator's call, not a side effect of fixing
        // a filter.
        //
        // So: attribution uses the folded index, the bonus uses the exact-name
        // index it always used (per-order in the legacy branch, per-group in
        // the SQL fold above — both feed bonusRaw). Payout totals are unchanged.
        // To pay on the merged history, widen the gate to idByIdentity — one
        // line in each engine, and a deliberate one.
        const payoutEarned = isAgentRole ? Math.round(bonusRaw * 100) / 100 : 0; // = calcAgentBonus()

        // Avg/pkg on paid packages (aligns with payout basis — not pipeline SOLD).
        const avgPerPackage = packagesSold > 0
          ? Math.round((paidRevenue / packagesSold) * 100) / 100
          : 0;

        return {
          user_id: agent.user_id,
          full_name: agent.full_name,
          // true = an operator who exists only as a name on the imported
          // history and has no CRM account, so the UI can label them historic
          // instead of implying they are staff who can log in.
          is_virtual: agent.is_virtual === true,
          email: agent.email,
          leads_assigned: leadsAssigned,
          total_confirmed: confirmedCount,
          total_shipped: shippedCount,
          total_paid: paidCount,
          total_returned: returnedCount,
          packages_returned: packagesReturned,
          total_cancelled: cancelledCount,
          total_trashed: trashedCount,
          conversion_rate: conversionRate,
          shipment_rate: shipmentRate,
          collection_rate: collectionRate,
          return_rate: returnRate,
          gross_revenue: grossRevenue,
          paid_revenue: paidRevenue,
          outstanding_revenue: outstandingRevenue,
          returned_value: returnedValue,
          total_profit: totalProfit,
          net_contribution: netContribution,
          avg_order_value: avgOrderValue,
          revenue_per_lead: revenuePerLead,
          profit_per_lead: profitPerLead,
          is_special_agent: isSpecial,
          // packages_sold = paid units ONLY (COD collected). Not pipeline.
          packages_sold: packagesSold,
          packages_awaiting: packagesAwaiting,
          avg_per_package: avgPerPackage,
          payout_earned: payoutEarned,
          date_basis: dateBasis,
        };
      });

      results.sort((a: any, b: any) => b.paid_revenue - a.paid_revenue);

      return json(results);
    }

    // ============================================================
    // AGENT PAYOUTS (commission settlements)
    // ============================================================
    // Ledger: agent_payouts + agent_payout_items. Never delete — void only.
    // Unpaid = paid packages not yet on a status=paid settlement.

    if (segments[0] === "agent-payouts") {
      // Sanity ceiling for hand-typed amounts — a slipped keystroke must not
      // write a six-figure commission into the ledger.
      const PAYOUT_AMOUNT_MAX = 100000;

      // Period bounds are timestamptz. The UI sends plain dates, so widen them
      // to cover the whole day rather than snapping both ends to midnight.
      const payoutBound = (v: unknown, edge: "start" | "end"): string | null => {
        const s = String(v ?? "").trim();
        if (!s) return null;
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T${edge === "start" ? "00:00:00" : "23:59:59"}Z`;
        const parsed = new Date(s);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
      };

      const payoutPaginate = async (makeQuery: () => any, pageSize = 1000): Promise<any[]> => {
        const all: any[] = [];
        for (let fromIdx = 0; ; fromIdx += pageSize) {
          const { data, error } = await makeQuery().range(fromIdx, fromIdx + pageSize - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          all.push(...data);
          if (data.length < pageSize) break;
        }
        return all;
      };

      const loadSettledOrderIds = async (agentUserId?: string | null): Promise<Set<string>> => {
        let pq = adminClient.from("agent_payouts").select("id").eq("status", "paid");
        if (agentUserId) pq = pq.eq("agent_user_id", agentUserId);
        const payouts = await payoutPaginate(() => pq);
        const payoutIds = payouts.map((p: any) => p.id);
        if (payoutIds.length === 0) return new Set();
        const orderIds = new Set<string>();
        for (let i = 0; i < payoutIds.length; i += 200) {
          const chunk = payoutIds.slice(i, i + 200);
          const items = await payoutPaginate(() =>
            adminClient.from("agent_payout_items").select("order_id").in("payout_id", chunk),
          );
          for (const it of items) orderIds.add(it.order_id);
        }
        return orderIds;
      };

      const loadPaidOrdersForAgent = async (
        agentUserId: string,
        from: string | null,
        to: string | null,
      ): Promise<any[]> => {
        // Fetch all paid orders owned by agent, then apply paid_at window in JS
        // (handles null paid_at → created_at fallback via inPaidWindow).
        const rows = await payoutPaginate(() =>
          adminClient
            .from("orders")
            .select("id, display_id, status, price, quantity, paid_at, created_at, confirmed_by_agent_id, assigned_agent_id, order_items(price_per_unit, quantity, product_id)")
            .eq("status", "paid")
            .or("source_type.is.null,source_type.neq.monadon_legacy")
            .or(salesOwnerOrFilter(agentUserId)),
        );
        return rows.filter((o: any) => salesOwnerId(o) === agentUserId && inPaidWindow(o, from, to));
      };

      // GET /api/agent-payouts/summary
      if (req.method === "GET" && segments[1] === "summary" && segments.length === 2) {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        let agentId = url.searchParams.get("agent_id");
        if (!isAdminOrManager) agentId = user.id;
        if (agentId && !UUID_RE.test(agentId)) return json({ error: "Invalid agent_id" }, 400);

        const { data: agentRoles } = await adminClient
          .from("user_roles")
          .select("user_id")
          .in("role", ["agent", "pending_agent", "prediction_agent"]);
        const agentIds = new Set((agentRoles || []).map((r: any) => r.user_id));
        const { data: superRoles } = await adminClient
          .from("user_roles")
          .select("user_id")
          .in("role", ["admin", "manager"]);
        const superIds = new Set((superRoles || []).map((r: any) => r.user_id));

        let profilesQ = adminClient.from("profiles").select("user_id, full_name, email").eq("is_active", true);
        if (agentId) profilesQ = profilesQ.eq("user_id", agentId);
        const { data: profiles } = await profilesQ;
        const agentProfiles = (profiles || []).filter(
          (p: any) => agentIds.has(p.user_id) && !superIds.has(p.user_id),
        );

        const settledAll = await loadSettledOrderIds(agentId || null);
        // Settled amounts per agent
        let settlementsQ = adminClient
          .from("agent_payouts")
          .select("agent_user_id, amount_eur, paid_on, status")
          .eq("status", "paid");
        if (agentId) settlementsQ = settlementsQ.eq("agent_user_id", agentId);
        const settlements = await payoutPaginate(() => settlementsQ);
        const settledSum: Record<string, number> = {};
        const lastPaid: Record<string, string> = {};
        for (const s of settlements) {
          settledSum[s.agent_user_id] = (settledSum[s.agent_user_id] || 0) + Number(s.amount_eur || 0);
          const d = s.paid_on;
          if (!lastPaid[s.agent_user_id] || d > lastPaid[s.agent_user_id]) lastPaid[s.agent_user_id] = d;
        }

        const results = [];
        for (const p of agentProfiles) {
          const paidOrders = await loadPaidOrdersForAgent(p.user_id, from, to);
          const owned = paidOrders.filter((o: any) => salesOwnerId(o) === p.user_id);
          const unsettled = owned.filter((o: any) => !settledAll.has(o.id));
          // Awaiting packages from current pipeline (not date-windowed tightly)
          const awaitingRows = await payoutPaginate(() =>
            adminClient
              .from("orders")
              .select("id, status, quantity, order_items(quantity)")
              .in("status", ["confirmed", "shipped", "delivered"])
              .or("source_type.is.null,source_type.neq.monadon_legacy")
              .or(salesOwnerOrFilter(p.user_id)),
          );
          const returnedRows = await payoutPaginate(() => {
            let q = adminClient
              .from("orders")
              .select("id, status, quantity, returned_at, created_at, order_items(quantity)")
              .eq("status", "returned")
              .or("source_type.is.null,source_type.neq.monadon_legacy")
              .or(salesOwnerOrFilter(p.user_id));
            if (from) q = q.gte("returned_at", from);
            if (to) q = q.lte("returned_at", to);
            return q;
          });

          const payoutEarned = calcAgentBonus(owned);
          const payoutUnpaid = calcAgentBonus(unsettled);
          results.push({
            agent_user_id: p.user_id,
            full_name: p.full_name,
            email: p.email,
            packages_sold: packagesSoldOf(owned),
            packages_awaiting: packagesAwaitingOf(awaitingRows),
            packages_returned: packagesReturnedOf(returnedRows),
            payout_earned: payoutEarned,
            payout_settled: Math.round((settledSum[p.user_id] || 0) * 100) / 100,
            payout_unpaid: payoutUnpaid,
            last_paid_on: lastPaid[p.user_id] || null,
            unsettled_orders: unsettled.length,
          });
        }
        results.sort((a: any, b: any) => b.payout_unpaid - a.payout_unpaid);
        return json(results);
      }

      // GET /api/agent-payouts/preview?agent_id=&from=&to=
      if (req.method === "GET" && segments[1] === "preview" && segments.length === 2) {
        if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
        const agentId = url.searchParams.get("agent_id");
        if (!agentId || !UUID_RE.test(agentId)) return json({ error: "agent_id required" }, 400);
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");

        const { data: prof } = await adminClient
          .from("profiles")
          .select("user_id, full_name")
          .eq("user_id", agentId)
          .maybeSingle();
        if (!prof) return json({ error: "Agent not found" }, 404);

        const settled = await loadSettledOrderIds(agentId);
        const paidOrders = (await loadPaidOrdersForAgent(agentId, from, to))
          .filter((o: any) => salesOwnerId(o) === agentId && !settled.has(o.id));

        const items = paidOrders.map((o: any) => ({
          order_id: o.id,
          display_id: o.display_id || null,
          package_units: unitsOf(o),
          bonus_eur: Math.round(orderPackageBonus(o) * 100) / 100,
          paid_at: o.paid_at || null,
          price: Number(o.price || 0),
        }));
        const amount = calcAgentBonus(paidOrders);
        const packages = packagesSoldOf(paidOrders);
        return json({
          agent_user_id: agentId,
          full_name: prof.full_name,
          period_from: from || null,
          period_to: to || null,
          packages_count: packages,
          amount_eur: amount,
          order_count: items.length,
          items,
        });
      }

      // GET /api/agent-payouts  (list settlements)
      if (req.method === "GET" && segments.length === 1) {
        let agentId = url.searchParams.get("agent_id");
        const status = url.searchParams.get("status"); // paid | voided | all
        if (!isAdminOrManager) agentId = user.id;

        let q = adminClient
          .from("agent_payouts")
          .select("id, agent_user_id, period_from, period_to, packages_count, amount_eur, computed_amount_eur, amount_source, override_reason, paid_on, paid_by, method, notes, status, voided_at, void_reason, created_at, updated_at")
          .order("paid_on", { ascending: false })
          .order("created_at", { ascending: false });
        if (agentId) {
          if (!UUID_RE.test(agentId)) return json({ error: "Invalid agent_id" }, 400);
          q = q.eq("agent_user_id", agentId);
        }
        if (status && status !== "all") q = q.eq("status", status);
        const rows = await payoutPaginate(() => q);

        const ids = [...new Set(rows.map((r: any) => r.agent_user_id))];
        const nameMap: Record<string, string> = {};
        if (ids.length) {
          const { data: profs } = await adminClient.from("profiles").select("user_id, full_name").in("user_id", ids);
          for (const p of profs || []) nameMap[p.user_id] = p.full_name;
        }
        return json(rows.map((r: any) => ({ ...r, agent_name: nameMap[r.agent_user_id] || null })));
      }

      // GET /api/agent-payouts/:id  or  /api/agent-payouts/:id/report
      if (req.method === "GET" && segments.length >= 2 && UUID_RE.test(segments[1])) {
        const id = segments[1];
        const { data: payout, error } = await adminClient
          .from("agent_payouts")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        if (error || !payout) return json({ error: "Not found" }, 404);
        if (!isAdminOrManager && payout.agent_user_id !== user.id) {
          return json({ error: "Forbidden" }, 403);
        }

        const { data: items } = await adminClient
          .from("agent_payout_items")
          .select("order_id, package_units, bonus_eur")
          .eq("payout_id", id);
        const orderIds = (items || []).map((i: any) => i.order_id);
        let orderMeta: Record<string, any> = {};
        if (orderIds.length) {
          for (let i = 0; i < orderIds.length; i += 200) {
            const chunk = orderIds.slice(i, i + 200);
            const { data: ords } = await adminClient
              .from("orders")
              .select("id, display_id, price, paid_at, customer_name")
              .in("id", chunk);
            for (const o of ords || []) orderMeta[o.id] = o;
          }
        }
        const { data: prof } = await adminClient
          .from("profiles")
          .select("full_name, email")
          .eq("user_id", payout.agent_user_id)
          .maybeSingle();

        const detailItems = (items || []).map((it: any) => ({
          order_id: it.order_id,
          display_id: orderMeta[it.order_id]?.display_id || null,
          package_units: it.package_units,
          bonus_eur: Number(it.bonus_eur),
          paid_at: orderMeta[it.order_id]?.paid_at || null,
          price: orderMeta[it.order_id]?.price != null ? Number(orderMeta[it.order_id].price) : null,
          customer_name: orderMeta[it.order_id]?.customer_name || null,
        }));

        const payload = {
          ...payout,
          agent_name: prof?.full_name || null,
          agent_email: prof?.email || null,
          items: detailItems,
        };

        if (segments[2] === "report") {
          return json({
            report_title: "Elyon CRM — Agent Commission Report",
            generated_at: new Date().toISOString(),
            currency_note: "Amounts shown in MKD (denars), derived from EUR at the frozen 61.5 rate.",
            settlement: payload,
          });
        }
        return json(payload);
      }

      // POST /api/agent-payouts  — mark agent paid (create settlement)
      if (req.method === "POST" && segments.length === 1) {
        if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
        const body = await req.json();
        const agentId = body.agent_id;
        if (!agentId || !UUID_RE.test(agentId)) return json({ error: "agent_id required" }, 400);
        const from = body.from || null;
        const to = body.to || null;
        const method = body.method ? String(body.method).slice(0, 40) : null;
        const notes = body.notes ? String(body.notes).slice(0, 2000) : null;
        const paidOn = body.paid_on && /^\d{4}-\d{2}-\d{2}$/.test(body.paid_on)
          ? body.paid_on
          : new Date().toISOString().slice(0, 10);

        const settled = await loadSettledOrderIds(agentId);
        const paidOrders = (await loadPaidOrdersForAgent(agentId, from, to))
          .filter((o: any) => salesOwnerId(o) === agentId && !settled.has(o.id));
        if (paidOrders.length === 0) {
          return json({ error: "No unsettled paid packages in this period" }, 400);
        }

        // The engine amount is always recorded. The operator may hand over a
        // different sum (agents on a % deal, agreed corrections) — that becomes
        // amount_eur and flags the settlement as a manual override.
        const computedAmount = calcAgentBonus(paidOrders);
        let amount = computedAmount;
        let amountSource = "formula";
        if (body.amount_eur !== undefined && body.amount_eur !== null && String(body.amount_eur).trim() !== "") {
          const n = Number(body.amount_eur);
          if (!Number.isFinite(n) || n < 0 || n > PAYOUT_AMOUNT_MAX) {
            return json({ error: `amount_eur must be between 0 and ${PAYOUT_AMOUNT_MAX}` }, 400);
          }
          amount = Math.round(n * 100) / 100;
          if (amount !== computedAmount) amountSource = "manual";
        }
        const overrideReason = body.override_reason ? String(body.override_reason).slice(0, 500) : null;
        const packages = packagesSoldOf(paidOrders);
        const periodFrom = from || paidOrders.reduce((min: string, o: any) => {
          const at = orderPaidEventAt(o) || o.created_at;
          return !min || at < min ? at : min;
        }, "");
        const periodTo = to || paidOrders.reduce((max: string, o: any) => {
          const at = orderPaidEventAt(o) || o.created_at;
          return !max || at > max ? at : max;
        }, "");

        const { data: payout, error: pErr } = await adminClient
          .from("agent_payouts")
          .insert({
            agent_user_id: agentId,
            period_from: periodFrom,
            period_to: periodTo,
            packages_count: packages,
            amount_eur: amount,
            computed_amount_eur: computedAmount,
            amount_source: amountSource,
            override_reason: overrideReason,
            paid_on: paidOn,
            paid_by: user.id,
            method,
            notes,
            status: "paid",
          })
          .select()
          .single();
        if (pErr || !payout) return json({ error: sanitizeDbError(pErr) || "Failed to create payout" }, 400);

        const itemRows = paidOrders.map((o: any) => ({
          payout_id: payout.id,
          order_id: o.id,
          package_units: unitsOf(o),
          bonus_eur: Math.round(orderPackageBonus(o) * 100) / 100,
        }));
        const { error: iErr } = await adminClient.from("agent_payout_items").insert(itemRows);
        if (iErr) {
          // Roll back header if items fail (e.g. double-pay race)
          await adminClient.from("agent_payouts").delete().eq("id", payout.id);
          return json({ error: sanitizeDbError(iErr) || "Failed to attach payout items" }, 400);
        }

        await audit(adminClient, user.id, user.email || null, "agent_payout.create", {
          target_type: "agent_payout",
          target_id: payout.id,
          target_name: agentId,
          payload: {
            amount_eur: amount,
            computed_amount_eur: computedAmount,
            amount_source: amountSource,
            override_reason: overrideReason,
            packages_count: packages,
            order_count: itemRows.length,
            from,
            to,
          },
        });

        return json({ ...payout, items: itemRows }, 201);
      }

      // PATCH /api/agent-payouts/:id — correct a settlement after the fact.
      // Only the paperwork is editable (amount, period, paid-on, method, notes);
      // the order line items are never touched, so the double-pay guard and the
      // unpaid balance stay intact whatever the operator types here.
      if (req.method === "PATCH" && segments.length === 2 && UUID_RE.test(segments[1])) {
        if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
        const id = segments[1];
        const body = await req.json().catch(() => ({}));

        const { data: existing } = await adminClient
          .from("agent_payouts")
          .select("*")
          .eq("id", id)
          .maybeSingle();
        if (!existing) return json({ error: "Not found" }, 404);

        const patch: Record<string, unknown> = {};

        if (body.amount_eur !== undefined && body.amount_eur !== null && String(body.amount_eur).trim() !== "") {
          const n = Number(body.amount_eur);
          if (!Number.isFinite(n) || n < 0 || n > PAYOUT_AMOUNT_MAX) {
            return json({ error: `amount_eur must be between 0 and ${PAYOUT_AMOUNT_MAX}` }, 400);
          }
          const rounded = Math.round(n * 100) / 100;
          patch.amount_eur = rounded;
          // Fall back to 'formula' if the operator restores the engine number.
          const baseline = existing.computed_amount_eur != null
            ? Number(existing.computed_amount_eur)
            : Number(existing.amount_eur);
          patch.amount_source = rounded === baseline ? "formula" : "manual";
        }

        if (body.paid_on !== undefined) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.paid_on))) {
            return json({ error: "paid_on must be YYYY-MM-DD" }, 400);
          }
          patch.paid_on = body.paid_on;
        }

        if (body.period_from !== undefined) {
          const v = payoutBound(body.period_from, "start");
          if (!v) return json({ error: "Invalid period_from" }, 400);
          patch.period_from = v;
        }
        if (body.period_to !== undefined) {
          const v = payoutBound(body.period_to, "end");
          if (!v) return json({ error: "Invalid period_to" }, 400);
          patch.period_to = v;
        }
        const finalFrom = String(patch.period_from ?? existing.period_from);
        const finalTo = String(patch.period_to ?? existing.period_to);
        if (finalFrom > finalTo) return json({ error: "period_from must be before period_to" }, 400);

        if (body.method !== undefined) {
          patch.method = body.method ? String(body.method).slice(0, 40) : null;
        }
        if (body.notes !== undefined) {
          patch.notes = body.notes ? String(body.notes).slice(0, 2000) : null;
        }
        if (body.override_reason !== undefined) {
          patch.override_reason = body.override_reason ? String(body.override_reason).slice(0, 500) : null;
        }

        if (Object.keys(patch).length === 0) return json({ error: "Nothing to update" }, 400);
        patch.updated_at = new Date().toISOString();
        patch.updated_by = user.id;

        const { data: updated, error } = await adminClient
          .from("agent_payouts")
          .update(patch)
          .eq("id", id)
          .select()
          .single();
        if (error) return json({ error: sanitizeDbError(error) }, 400);

        const changed: Record<string, unknown> = {};
        for (const k of Object.keys(patch)) {
          if (k === "updated_at" || k === "updated_by") continue;
          if (String(existing[k] ?? "") !== String(patch[k] ?? "")) {
            changed[k] = { from: existing[k] ?? null, to: patch[k] ?? null };
          }
        }
        await audit(adminClient, user.id, user.email || null, "agent_payout.update", {
          target_type: "agent_payout",
          target_id: id,
          target_name: existing.agent_user_id,
          payload: { changed },
        });

        return json(updated);
      }

      // POST /api/agent-payouts/:id/void
      if (req.method === "POST" && segments.length === 3 && UUID_RE.test(segments[1]) && segments[2] === "void") {
        if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
        const id = segments[1];
        const body = await req.json().catch(() => ({}));
        const { data: payout } = await adminClient.from("agent_payouts").select("*").eq("id", id).maybeSingle();
        if (!payout) return json({ error: "Not found" }, 404);
        if (payout.status === "voided") return json({ error: "Already voided" }, 400);

        const { data: updated, error } = await adminClient
          .from("agent_payouts")
          .update({
            status: "voided",
            voided_at: new Date().toISOString(),
            voided_by: user.id,
            void_reason: body.reason ? String(body.reason).slice(0, 1000) : null,
          })
          .eq("id", id)
          .select()
          .single();
        if (error) return json({ error: sanitizeDbError(error) }, 400);

        await audit(adminClient, user.id, user.email || null, "agent_payout.void", {
          target_type: "agent_payout",
          target_id: id,
          target_name: payout.agent_user_id,
          payload: { amount_eur: payout.amount_eur, reason: body.reason || null },
        });
        return json(updated);
      }

      return json({ error: "Not found" }, 404);
    }

    // ============================================================
    // CALL SCRIPTS & LOGS
    // ============================================================

    // GET /api/call-scripts (list all scripts)
    if (req.method === "GET" && path === "call-scripts") {
      const { data, error } = await supabase
        .from("call_scripts")
        .select("*")
        .order("title");
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    // POST /api/call-scripts (admin only - create new product script)
    if (req.method === "POST" && path === "call-scripts") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const body = await req.json();
      if (!body.title?.trim()) return json({ error: "title is required" }, 400);
      const { data, error } = await adminClient
        .from("call_scripts")
        .insert({
          context_type: "product",
          title: body.title.trim(),
          description: body.description?.trim() || null,
          script_text: body.script_text || "",
          helpers: Array.isArray(body.helpers) ? body.helpers : [],
          translations: body.translations && typeof body.translations === "object" ? body.translations : {},
          updated_by: user.id,
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // GET /api/call-scripts/:contextType
    if (req.method === "GET" && segments[0] === "call-scripts" && segments.length === 2) {
      const contextType = segments[1];
      const { data, error } = await supabase
        .from("call_scripts")
        .select("*")
        .eq("context_type", contextType)
        .maybeSingle();
      if (error || !data) return json({ script_text: "", title: "", description: null });
      return json(data);
    }

    // PATCH /api/call-scripts/:id  (admin only)
    // If the segment looks like a UUID → update product script by id
    // Otherwise → upsert legacy script by context_type (prediction_lead / order)
    if (req.method === "PATCH" && segments[0] === "call-scripts" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const identifier = segments[1];
      const body = await req.json();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

      let data, error;
      if (isUuid) {
        // Product script update by id
        ({ data, error } = await adminClient
          .from("call_scripts")
          .update({
            title: body.title?.trim(),
            description: body.description?.trim() ?? null,
            script_text: body.script_text,
            // Only persist helpers/translations when explicitly provided (keeps old clients + legacy paths safe)
            ...(Array.isArray(body.helpers) ? { helpers: body.helpers } : {}),
            ...(body.translations && typeof body.translations === "object" ? { translations: body.translations } : {}),
            updated_by: user.id,
            updated_at: new Date().toISOString(),
          })
          .eq("id", identifier)
          .select()
          .single());
      } else {
        // Legacy prediction_lead / order — select then update or insert
        const { data: existing } = await adminClient
          .from("call_scripts")
          .select("id")
          .eq("context_type", identifier)
          .maybeSingle();
        const defaultTitle = identifier === "prediction_lead" ? "Prediction Lead Script" : "Order Script";
        const transPatch = body.translations && typeof body.translations === "object" ? { translations: body.translations } : {};
        if (existing) {
          ({ data, error } = await adminClient
            .from("call_scripts")
            .update({ script_text: body.script_text, ...transPatch, updated_by: user.id, updated_at: new Date().toISOString() })
            .eq("id", existing.id)
            .select()
            .single());
        } else {
          ({ data, error } = await adminClient
            .from("call_scripts")
            .insert({ context_type: identifier, title: defaultTitle, script_text: body.script_text, ...transPatch, updated_by: user.id })
            .select()
            .single());
        }
      }
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // DELETE /api/call-scripts/:id (admin only - delete product script)
    if (req.method === "DELETE" && segments[0] === "call-scripts" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { error } = await adminClient
        .from("call_scripts")
        .delete()
        .eq("id", segments[1]);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ ok: true });
    }

    // POST /api/call-logs
    if (req.method === "POST" && path === "call-logs") {
      let body;
      try { body = parseBody(callLogSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const {
        context_type, context_id, outcome, notes,
        started_at, connected_at, ended_at,
        customer_phone, connection_state,
        cancellation_reason, cancellation_reason_notes, trash_reason,
      } = body;

      // Apply the order status change best-effort. We USED to abort here (return
      // an error before writing the log) when the transition was rejected — which
      // meant the call, and its recording, went completely unlogged (orphan
      // recordings with no agent / customer / outcome). Now we ALWAYS write the
      // call log and just record any rejection as a warning, so every call has an
      // audit trail + a recording link. OrderModal still surfaces hard transition
      // errors via its separate apiUpdateOrderStatus call; the in-call widget
      // shows order_warning from the response.
      let order_warning: string | null = null;
      if (context_type === "order" && context_id) {
        // Ownership guard — same rule as PATCH /orders/:id/status. This path
        // also mutates the order via adminClient (RLS-bypassing), so a plain
        // agent must not drive an order assigned to someone else (commission
        // theft / sabotage). The call itself is still logged below; only the
        // order side-effect is withheld, surfaced as order_warning.
        let mayMutate = isAdminOrManager || isWarehouse;
        if (!mayMutate) {
          const { data: o } = await adminClient
            .from("orders").select("assigned_agent_id").eq("id", context_id).maybeSingle();
          mayMutate = !o || !o.assigned_agent_id || o.assigned_agent_id === user.id;
        }
        if (!mayMutate) {
          order_warning = "Order is assigned to another agent — status not changed.";
        } else {
          const result = await applyOutcomeToOrder(adminClient, {
            orderId: context_id,
            outcome,
            agentId: user.id,
            cancellationReason: cancellation_reason,
            cancellationReasonNotes: cancellation_reason_notes,
            trashReason: trash_reason,
            claimIfUnassigned: !isAdminOrManager && !isWarehouse,
          });
          if (!result.ok) order_warning = result.error || "Order status was not changed.";
        }
      }

      const loggedNotes = order_warning
        ? [notes || "", `⚠ Order not updated: ${order_warning}`].filter(Boolean).join("\n")
        : (notes || "");

      // ── Dedupe the call row with its result ───────────────────────────────
      // The live call is logged by VoipContext with telemetry (started_at +
      // recording match). The agent then often confirms/cancels/trashes the
      // order a couple minutes LATER in OrderModal, which logs a separate
      // "marker" row with NO telemetry. Left alone that yields TWO rows: a
      // neutral "Answered" call (with recording) + a bare result (no recording).
      // We merge them by phone within a 5-minute window measured from the call's
      // hangup (ended_at) so ONE row carries both the recording/duration AND the
      // final result — regardless of whether the order is resolved during or
      // right after the call. Order side-effects already ran via
      // applyOutcomeToOrder above, so this is display-only de-duplication.
      const MERGE_MS = 5 * 60 * 1000;
      const isRealResult = outcome === "confirmed" || outcome === "cancelled" || outcome === "trash";
      const isMarker = !started_at && isRealResult;                                  // OrderModal, after a call
      const isAnsweredTelemetry = !!started_at && (outcome === "answered" || outcome === "interested"); // VoipContext finalize
      // Suffix, never `%last8%` — the two candidate lookups below feed an UPDATE,
      // and a substring match can select a DIFFERENT customer whose number merely
      // contains these 8 digits, re-tagging their call log with this outcome.
      // Rule 7: phone matching on any WRITE path is a suffix.
      const mergePhone8 = customer_phone ? String(customer_phone).replace(/\D/g, "").slice(-8) : "";
      let data: any = null;
      if (mergePhone8.length >= 7 && (isMarker || isAnsweredTelemetry)) {
        const sinceIso = new Date(Date.now() - MERGE_MS).toISOString();
        if (isMarker) {
          // Re-tag the just-ended answered call for this phone with the result.
          const { data: cands } = await adminClient
            .from("call_logs")
            .select("id, notes")
            .eq("agent_id", user.id)
            .ilike("customer_phone", `%${mergePhone8}`)
            .not("started_at", "is", null)
            .in("outcome", ["answered", "interested"])
            .gte("ended_at", sinceIso)
            .order("ended_at", { ascending: false })
            .limit(1);
          const hit = (cands || [])[0];
          if (hit) {
            const { data: upd } = await adminClient
              .from("call_logs")
              .update({ outcome, notes: [hit.notes, loggedNotes].filter(Boolean).join("\n") || null })
              .eq("id", hit.id).select().single();
            data = upd;
          }
        } else {
          // The marker may have arrived first (confirm-DURING-call): fold this
          // call's telemetry INTO that marker row instead of adding a 2nd row.
          const { data: cands } = await adminClient
            .from("call_logs")
            .select("id, notes")
            .eq("agent_id", user.id)
            .ilike("customer_phone", `%${mergePhone8}`)
            .is("started_at", null)
            .in("outcome", ["confirmed", "cancelled", "trash"])
            .gte("created_at", sinceIso)
            .order("created_at", { ascending: false })
            .limit(1);
          const hit = (cands || [])[0];
          if (hit) {
            const { data: upd } = await adminClient
              .from("call_logs")
              .update({
                started_at: started_at ?? null,
                connected_at: connected_at ?? null,
                ended_at: ended_at ?? null,
                connection_state: connection_state ?? null,
                notes: [hit.notes, loggedNotes].filter(Boolean).join("\n") || null,
              })
              .eq("id", hit.id).select().single();
            data = upd;
          }
        }
      }

      if (!data) {
        const { data: inserted, error } = await adminClient
          .from("call_logs")
          .insert({
            agent_id: user.id,
            context_type,
            context_id: context_id ?? null,
            outcome,
            notes: loggedNotes,
            started_at: started_at ?? null,
            connected_at: connected_at ?? null,
            ended_at: ended_at ?? null,
            customer_phone: customer_phone ?? null,
            connection_state: connection_state ?? null,
          })
          .select()
          .single();
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        data = inserted;
      }

      // The agent just called this number — clear any open missed call for it so it
      // drops out of the Call Again queue / Missed Calls inbox (last-8 match).
      if (customer_phone) {
        const cbNorm = String(customer_phone).replace(/\D/g, "").slice(-8);
        if (cbNorm.length >= 7) {
          await adminClient.from("missed_calls")
            .update({ status: "called_back" })
            .eq("linked_phone_norm", cbNorm)
            .in("status", ["new", "assigned"]);
        }
      }

      // Any recorded outcome — including a plain no_answer — is "leaving a mark":
      // release this agent's mandatory-answer obligation for the customer.
      await clearCallObligation(adminClient, user.id, customer_phone);

      // ── No-answer → humane paced retries + 9-consecutive auto-trash ─────
      // Every real no-answer call lands here, so this is the single source of
      // truth for the "doesn't pick up" lifecycle (both the call strip and the
      // manual "Didn't Answer" button log a no_answer call). We count the
      // trailing consecutive no-answers for this phone, and separately how many
      // no-answers already happened TODAY (Europe/Skopje), to pace the calls:
      //   • max 2 calls/day, spaced ~3–4h apart, kept on the SAME agent;
      //   • after the 2nd no-answer today the client resurfaces at ~09:00 Skopje
      //     the next morning (not again today — don't anger the customer);
      //   • across ~4–5 calling days this reaches 9 no-answers → Unreachable:
      //     move to Trash (reason "not_reachable"). Trash, NOT cancel, so cancel
      //     insights stay clean. One trashed order: reuse a workable order if one
      //     exists, else create a single one.
      // No stub orders are created for the no-answer/call-again cycle itself.
      // These knobs are hardcoded for now; they can later move to app_settings
      // (like the Personal-List cap) to be tuned without a deploy.
      const UNREACHABLE_TRASH_STREAK = 9;                     // consecutive no-answers → auto-trash
      const MAX_CALLS_PER_DAY = 2;                            // per client, per Skopje day
      const INTRA_DAY_COOLDOWN_MS = 3.5 * 60 * 60 * 1000;     // ~3–4h between the 2 daily attempts
      const NEXT_DAY_RESUME_HOUR = 9;                         // Skopje local hour to resurface next morning
      const isNoAnswer = outcome === "no_answer" || connection_state === "no_answer";
      if (isNoAnswer && customer_phone) {
        const digits = customer_phone.replace(/\D/g, "");
        const last8 = digits.length >= 8 ? digits.slice(-8) : digits;
        if (last8) {
          // HARD LOCK (2026-08-10): a call outcome may only move an order that is
          // unassigned or already the caller's. Before this, one agent's
          // "didn't answer" parked — and on the 9th strike trashed — leads that
          // belonged to a colleague, because every update below matched on phone
          // alone. `user.id` is the JWT sub, so it is safe to interpolate.
          const ownedByCaller = `assigned_agent_id.is.null,assigned_agent_id.eq.${user.id}`;
          // Fetch enough history to both count the trailing streak (up to 9) and
          // count today's no-answers — comfortably above the 9-streak window.
          const { data: recentLogs } = await adminClient
            .from("call_logs")
            .select("outcome, connection_state, created_at")
            .ilike("customer_phone", `%${last8}`)
            .order("created_at", { ascending: false })
            .limit(20);
          const logIsNoAnswer = (lg: any) => lg.outcome === "no_answer" || lg.connection_state === "no_answer";
          let streak = 0;
          for (const lg of recentLogs || []) {
            if (logIsNoAnswer(lg)) streak++;
            else break;
          }

          // Does this customer have a LIVE LEAD? If so the 9-strike auto-trash is
          // off for them entirely (operator rule, 2026-08-10): a lead the customer
          // asked for is chased until the AGENT decides it is dead — nine
          // unanswered rings is not that decision. The rule stays on for
          // prediction-list customers, who are cold outreach we initiated.
          // This guard also stops a synthetic "Not reachable" order being
          // invented alongside a real, open lead.
          const { data: liveLead } = await adminClient
            .from("orders")
            .select("id")
            .ilike("customer_phone", `%${last8}`)
            .in("status", ["pending", "take", "call_again"])
            .in("source_type", LEAD_SOURCE_TYPES)
            .limit(1)
            .maybeSingle();
          const hasLiveLead = !!liveLead;

          if (streak >= UNREACHABLE_TRASH_STREAK && !hasLiveLead) {
            const NOTE = `Auto-trash: unreachable — ${UNREACHABLE_TRASH_STREAK} consecutive no-answers (doesn't pick up the phone)`;
            const { data: workable } = await adminClient
              .from("orders")
              .select("id, notes")
              .ilike("customer_phone", `%${last8}`)
              .in("status", ["pending", "take", "call_again", "duplicated"])
              .or(ownedByCaller)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (workable) {
              await adminClient
                .from("orders")
                .update({
                  status: "trashed",
                  trash_reason: "not_reachable",
                  assigned_agent_id: null,
                  assigned_agent_name: null,
                  assigned_at: null,
                  next_call_after: null,
                  call_again_since: null,
                  notes: [workable.notes, NOTE].filter(Boolean).join("\n"),
                })
                .eq("id", workable.id);
            } else {
              await adminClient.from("orders").insert({
                product_name: "Not reachable",
                customer_phone,
                status: "trashed",
                trash_reason: "not_reachable",
                price: 0,
                quantity: 1,
                notes: NOTE,
              });
            }
            // Drop them from every calling queue. last_call_at is stamped too —
            // an outcome without a date rendered as "never" in member tables.
            await adminClient
              .from("prediction_segment_members")
              .update({ is_completed: true, last_call_outcome: "trash", last_call_at: new Date().toISOString(), in_call_again_until: null, call_again_since: null })
              .ilike("customer_phone", `%${last8}`);
          } else {
            // Not unreachable yet — pace the retries. The current call is already
            // logged above, so recentLogs includes it: count today's no-answers
            // (Europe/Skopje day). Once the daily cap is hit, push to tomorrow
            // morning; otherwise a short 3–4h intra-day gap.
            const { startISO: skopjeTodayStart, day: skopjeToday } = skopjeDayStart();
            const skopjeTodayStartMs = new Date(skopjeTodayStart).getTime();
            const noAnswersToday = (recentLogs || []).filter(
              (lg) => logIsNoAnswer(lg) && lg.created_at && new Date(lg.created_at).getTime() >= skopjeTodayStartMs,
            ).length;
            let cooldownUntil: string;
            if (noAnswersToday >= MAX_CALLS_PER_DAY) {
              // ~09:00 Skopje the next calling day (same agent — assignment kept).
              const [ty, tm, td] = skopjeToday.split("-").map(Number);
              const tomorrow = new Date(Date.UTC(ty, tm - 1, td + 1)).toISOString().slice(0, 10);
              cooldownUntil = new Date(
                new Date(skopjeMidnight(tomorrow)).getTime() + NEXT_DAY_RESUME_HOUR * 3600 * 1000,
              ).toISOString();
            } else {
              cooldownUntil = new Date(Date.now() + INTRA_DAY_COOLDOWN_MS).toISOString();
            }
            const nowIso = new Date().toISOString();
            // Prediction member: cooldown + mark as awaiting follow-up. Scoped to
            // the caller for the same reason as the orders below — a colleague's
            // no-answer must not park someone else's member row.
            await adminClient
              .from("prediction_segment_members")
              .update({ in_call_again_until: cooldownUntil, last_call_at: nowIso, last_call_outcome: "no_answer" })
              .ilike("customer_phone", `%${last8}`)
              .or(ownedByCaller)
              .eq("is_completed", false);
            // call_again_since = the FIRST no-answer that opened the window
            // (anchored, never reset while it keeps ringing).
            await adminClient
              .from("prediction_segment_members")
              .update({ call_again_since: nowIso })
              .ilike("customer_phone", `%${last8}`)
              .or(ownedByCaller)
              .eq("is_completed", false)
              .is("call_again_since", null);
            // Mark the EXISTING workable LEAD as Call Again (never create a 2nd
            // order) so the operator sees it was already called.
            //
            // LEADS ONLY (operator rule, 2026-08-10). Call Again is a state of an
            // unsettled inbound order: the customer asked for something, we
            // haven't closed it, so we keep ringing. A prediction-list customer
            // who doesn't answer is simply a NO ANSWER — the member row above
            // already carries the cooldown and `last_call_outcome='no_answer'`,
            // and they return to their own list. Flipping their `manual` order to
            // call_again put prediction work into the agent's Pendings queue and
            // buried the partner's leads.
            //
            // The lead STAYS with the agent who worked it: claim it for the caller
            // if nobody owned it, and never touch a colleague's row. Without the
            // claim the order goes back to the free pool the moment the take lock
            // releases, and starts circulating between agents again.
            //
            // NO COOLDOWN ON LEADS (operator rule, 2026-08-10): `next_call_after`
            // is left NULL so the lead never leaves its agent's queue and they
            // can ring back whenever they judge it right. The paced schedule was
            // built for cold prediction outreach; on a lead the customer is
            // waiting for US, and hiding it until 09:00 tomorrow made agents
            // think their call agains had vanished. The record of when they
            // called is in `call_logs` — the pacing was guidance, the log is fact.
            const { data: caller } = await adminClient
              .from("profiles").select("full_name").eq("user_id", user.id).maybeSingle();
            await adminClient
              .from("orders")
              .update({
                status: "call_again",
                next_call_after: null,
                assigned_agent_id: user.id,
                assigned_agent_name: caller?.full_name || user.email || null,
                assigned_at: nowIso,
              })
              .ilike("customer_phone", `%${last8}`)
              .in("status", ["pending", "take", "call_again"])
              .in("source_type", LEAD_SOURCE_TYPES)
              .is("assigned_agent_id", null);
            await adminClient
              .from("orders")
              .update({ status: "call_again", next_call_after: null })
              .ilike("customer_phone", `%${last8}`)
              .in("status", ["pending", "take", "call_again"])
              .in("source_type", LEAD_SOURCE_TYPES)
              .eq("assigned_agent_id", user.id);
            await adminClient
              .from("orders")
              .update({ call_again_since: nowIso })
              .ilike("customer_phone", `%${last8}`)
              .eq("status", "call_again")
              .in("source_type", LEAD_SOURCE_TYPES)
              .eq("assigned_agent_id", user.id)
              .is("call_again_since", null);
          }
        }
      }

      // Auto-update prediction lead status based on outcome
      if (context_type === "prediction_lead") {
        const statusMap: Record<string, string> = {
          no_answer: "no_answer",
          interested: "interested",
          // 'answered' is the new neutral "they picked up, no decision yet"
          // outcome (replaces the old auto-'interested'). For a LEAD it means
          // the same thing the old code did: mark it interested + lock to the
          // agent, so the queue/ownership behaviour is unchanged.
          answered: "interested",
          not_interested: "not_interested",
          call_again: "not_contacted",
        };
        const newStatus = statusMap[outcome];
        if (newStatus) {
          const updatePayload: Record<string, any> = { status: newStatus };
          // Ownership: lock lead to agent on interested/call_again
          if (outcome === "interested" || outcome === "answered" || outcome === "call_again") {
            const { data: agentProfile } = await adminClient
              .from("profiles")
              .select("full_name")
              .eq("user_id", user.id)
              .single();
            updatePayload.assigned_agent_id = user.id;
            updatePayload.assigned_agent_name = agentProfile?.full_name || user.email;
          }
          await adminClient
            .from("prediction_leads")
            .update(updatePayload)
            .eq("id", context_id);
        }
      }

      return json({ ...data, order_warning });
    }

    // GET /api/call-history (list all call logs with filters, pagination, enriched data)
    // GET /api/agent-activity — per-agent call-activity timeline for ONE day
    // (Europe/Skopje). Powers the Agent Activity swimlane: each agent's calls
    // (ring + talk segments), their scheduled shift window, and breaks, all
    // positioned on a real clock axis. Managers/admins see every agent; a plain
    // agent sees only their own row. Purely read-only — no side effects.
    if (req.method === "GET" && path === "agent-activity") {
      if (!canViewModule("call_activity")) return json({ error: "Forbidden" }, 403);
      const TZ = "Europe/Skopje";

      // Minutes to ADD to UTC to get Skopje local time at the given instant
      // (+120 winter / +180 summer). DST handled by the runtime via Intl.
      const tzOffsetMinutes = (at: Date): number => {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: TZ, hour12: false,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
        }).formatToParts(at);
        const m: Record<string, string> = {};
        for (const p of parts) m[p.type] = p.value;
        let hh = m.hour; if (hh === "24") hh = "00";
        const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +hh, +m.minute, +m.second);
        return Math.round((asUTC - at.getTime()) / 60000);
      };

      // Resolve the target day (YYYY-MM-DD) in Skopje local time; default today.
      const skopjeToday = (() => {
        const p = new Intl.DateTimeFormat("en-CA", {
          timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(new Date());
        const g = (t: string) => p.find((x) => x.type === t)?.value || "";
        return `${g("year")}-${g("month")}-${g("day")}`;
      })();
      const dateParam = url.searchParams.get("date");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam || "") ? dateParam! : skopjeToday;
      const [yy, mm, dd] = date.split("-").map(Number);

      // Skopje-local [00:00, 24:00) → UTC ISO bounds for the timestamptz filter.
      // Probe at local noon to read the day's offset clear of DST edges.
      const off = tzOffsetMinutes(new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0)));
      const dayStartMs = Date.UTC(yy, mm - 1, dd, 0, 0, 0) - off * 60000;
      const fromIso = new Date(dayStartMs).toISOString();
      const toIso = new Date(dayStartMs + 24 * 60 * 60 * 1000).toISOString();

      // Non-managers are pinned to their own row; managers may filter to one.
      const agentFilterParam = url.searchParams.get("agent_id");
      const singleAgentId = !isAdminOrManager ? user.id : (agentFilterParam || null);

      // ── Calls for the day (real calls always carry started_at) ──
      const aaPaginate = async (makeQuery: () => any, pageSize = 1000): Promise<any[]> => {
        const out: any[] = [];
        for (let pageStart = 0; ; pageStart += pageSize) {
          const { data, error } = await makeQuery().range(pageStart, pageStart + pageSize - 1);
          if (error) throw error;
          out.push(...(data || []));
          if (!data || data.length < pageSize) break;
        }
        return out;
      };

      let callRows: any[];
      try {
        callRows = await aaPaginate(() => {
          let q = adminClient.from("call_logs")
            .select("id, agent_id, started_at, connected_at, ended_at, connection_state, outcome, customer_phone, ring_seconds, talk_seconds")
            .gte("started_at", fromIso).lt("started_at", toIso)
            .order("started_at", { ascending: true });
          if (singleAgentId) q = q.eq("agent_id", singleAgentId);
          return q;
        });
      } catch (e: any) {
        return json({ error: sanitizeDbError(e) }, 400);
      }

      // ── Shifts scheduled for the day (with their assigned agents) ──
      const { data: dayShifts } = await adminClient
        .from("shifts")
        .select("id, start_time, end_time, shift_assignments(user_id)")
        .eq("date", date);
      const shiftsByAgent: Record<string, { start: string; end: string }[]> = {};
      for (const s of dayShifts || []) {
        for (const a of (s as any).shift_assignments || []) {
          (shiftsByAgent[a.user_id] ??= []).push({
            start: String(s.start_time).slice(0, 5),
            end: String(s.end_time).slice(0, 5),
          });
        }
      }

      // ── Breaks taken that day ──
      const { data: dayBreaks } = await adminClient
        .from("shift_breaks")
        .select("user_id, break_start, break_end")
        .eq("shift_date", date);
      const breaksByAgent: Record<string, { start: string; end: string | null }[]> = {};
      for (const b of dayBreaks || []) {
        (breaksByAgent[b.user_id] ??= []).push({ start: b.break_start, end: b.break_end });
      }

      // ── Group calls + collect the agent set (anyone with a call OR a shift) ──
      const callsByAgent: Record<string, any[]> = {};
      for (const c of callRows) (callsByAgent[c.agent_id] ??= []).push(c);
      const agentIds = new Set<string>([...Object.keys(callsByAgent), ...Object.keys(shiftsByAgent)]);
      if (singleAgentId) { for (const id of [...agentIds]) if (id !== singleAgentId) agentIds.delete(id); }

      // ── Names ──
      const nameById: Record<string, string> = {};
      if (agentIds.size > 0) {
        const { data: profs } = await adminClient.from("profiles").select("user_id, full_name").in("user_id", [...agentIds]);
        for (const p of profs || []) nameById[p.user_id] = p.full_name;
      }

      const num = (x: any) => Number(x || 0);
      const agents = [...agentIds].map((uid) => {
        const calls = callsByAgent[uid] || [];
        let answered = 0, talk = 0, ring = 0;
        let first: string | null = null, last: string | null = null;
        for (const c of calls) {
          const isAns = c.connection_state === "answered" || (c.connection_state == null && num(c.talk_seconds) > 0);
          if (isAns) answered++;
          talk += num(c.talk_seconds);
          ring += num(c.ring_seconds);
          if (c.started_at && (!first || c.started_at < first)) first = c.started_at;
          const end = c.ended_at || c.started_at;
          if (end && (!last || end > last)) last = end;
        }
        return {
          user_id: uid,
          full_name: nameById[uid] || "Unknown",
          shift_windows: shiftsByAgent[uid] || [],
          breaks: breaksByAgent[uid] || [],
          calls,
          totals: {
            calls: calls.length,
            answered,
            answer_rate: calls.length ? answered / calls.length : 0,
            talk_seconds: talk,
            ring_seconds: ring,
            first_call: first,
            last_call: last,
          },
        };
      }).sort((a, b) => a.full_name.localeCompare(b.full_name));

      return json({ date, tz: TZ, agents });
    }

    if (req.method === "GET" && path === "call-history") {
      const agentFilter = url.searchParams.get("agent_id");
      // "result" is the canonical, merged outcome+order-status the UI shows (see
      // the call_logs_with_result view). Accept legacy "outcome" as an alias so an
      // un-refreshed client keeps working.
      const resultFilter = url.searchParams.get("result") || url.searchParams.get("outcome");
      const sourceFilter = url.searchParams.get("source"); // prediction_lead | order
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const search = url.searchParams.get("search");
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = parseInt(url.searchParams.get("limit") || "25");

      // ── Result is CALL-driven and matches what the row DISPLAYS ────────────
      // Every conversation is a row (agent = the caller). A row's "Result" is the
      // call outcome merged with the customer's order/lead status — resolved by
      // context_id, or by phone (last-8) for standalone/Direct calls — exactly
      // what getResult() shows in the UI. So filtering Confirmed/Cancelled/… (or
      // a call outcome) returns precisely the rows whose badge matches. No order
      // with a conversation is left behind, because we resolve every call's phone.
      const last8f = (v: any) => String(v || "").replace(/\D/g, "").slice(-8);
      const RESULT_TOKENS = new Set(["confirmed", "cancelled", "paid", "shipped", "delivered", "returned", "trash", "no_answer", "answered", "call_again"]);
      const RESOLVED = new Set(["confirmed", "cancelled", "trashed", "shipped", "delivered", "paid", "returned"]);
      // Mirror of getResult() in src/pages/CallHistoryPage.tsx (single source of truth).
      const resultTokenOf = (outcome: string | null, eff: string | null): string => {
        if (outcome === "no_answer") return "no_answer";
        if (eff && RESOLVED.has(eff)) return eff === "trashed" ? "trash" : eff;
        switch (outcome) {
          case "confirmed": return "confirmed";
          case "cancelled": case "not_interested": return "cancelled";
          case "trash": case "wrong_number": return "trash";
          case "call_again": return "call_again";
          case "answered": case "interested": return "answered";
          default: return "unknown";
        }
      };

      // Resolve search predicates ONCE (shared by the count scan and the page
      // fetch). Searchable fields live in joined tables, so resolve matching
      // context_ids / agent_ids first, then OR them against call_logs.
      let searchOrs: string[] | null = null;
      let searchImpossible = false;
      if (search && search.trim()) {
        const term = search.trim();
        const safe = term.replace(/[,()*%\\]/g, " ").replace(/\s+/g, " ").trim();
        const digits = term.replace(/\D/g, "");
        const last8 = digits.length >= 8 ? digits.slice(-8) : digits;
        const hasPhone = last8.length >= 5;
        const orderOr: string[] = []; const leadOr: string[] = [];
        if (safe) { orderOr.push(`customer_name.ilike.%${safe}%`); leadOr.push(`name.ilike.%${safe}%`); }
        if (hasPhone) { orderOr.push(`customer_phone.ilike.%${last8}%`); leadOr.push(`telephone.ilike.%${last8}%`); }
        const matchedContextIds = new Set<string>();
        if (orderOr.length || leadOr.length) {
          const [oRes, lRes] = await Promise.all([
            orderOr.length ? adminClient.from("orders").select("id").or(orderOr.join(",")).limit(1000) : Promise.resolve({ data: [] }),
            leadOr.length ? adminClient.from("prediction_leads").select("id").or(leadOr.join(",")).limit(1000) : Promise.resolve({ data: [] }),
          ]);
          for (const o of oRes.data || []) matchedContextIds.add(o.id);
          for (const l of lRes.data || []) matchedContextIds.add(l.id);
        }
        let matchedAgentIds: string[] = [];
        if (safe) { const { data: agProfiles } = await adminClient.from("profiles").select("user_id").ilike("full_name", `%${safe}%`).limit(200); matchedAgentIds = (agProfiles || []).map((p: any) => p.user_id).filter(Boolean); }
        const ors: string[] = [];
        if (hasPhone) ors.push(`customer_phone.ilike.%${last8}%`);
        if (safe) ors.push(`notes.ilike.%${safe}%`);
        if (matchedContextIds.size) ors.push(`context_id.in.(${[...matchedContextIds].slice(0, 500).join(",")})`);
        if (matchedAgentIds.length) ors.push(`agent_id.in.(${matchedAgentIds.join(",")})`);
        if (ors.length) searchOrs = ors; else searchImpossible = true;
      }
      const applyBase = (q: any) => {
        if (!isAdminOrManager) q = q.eq("agent_id", user.id);
        else if (agentFilter) q = q.eq("agent_id", agentFilter);
        if (sourceFilter) q = q.eq("context_type", sourceFilter);
        if (from) q = q.gte("created_at", from);
        if (to) q = q.lte("created_at", to);
        if (searchImpossible) q = q.eq("id", "00000000-0000-0000-0000-000000000000");
        else if (searchOrs) q = q.or(searchOrs.join(","));
        return q;
      };

      let logs: any[] = [];
      let count = 0;

      if (resultFilter && RESULT_TOKENS.has(resultFilter)) {
        // Pull ALL candidate calls (PostgREST caps a response at 1000, so page
        // through with .range), resolve each one's displayed result, keep matches.
        const cand: any[] = [];
        for (let off = 0; ; off += 1000) {
          const { data, error } = await applyBase(
            adminClient.from("call_logs").select("id,context_type,context_id,customer_phone,outcome,created_at").order("created_at", { ascending: false }),
          ).range(off, off + 999);
          if (error) return json({ error: sanitizeDbError(error) }, 400);
          if (!data || !data.length) break;
          cand.push(...data);
          if (data.length < 1000 || cand.length >= 20000) break;
        }
        // Order/lead status by context_id.
        const ctxOrderIds = [...new Set(cand.filter((c) => c.context_type === "order" && c.context_id).map((c) => c.context_id))];
        const ctxLeadIds = [...new Set(cand.filter((c) => c.context_type === "prediction_lead" && c.context_id).map((c) => c.context_id))];
        const ctxOrderStatus: Record<string, string> = {}; const ctxLeadStatus: Record<string, string> = {};
        for (let i = 0; i < ctxOrderIds.length; i += 500) { const { data } = await adminClient.from("orders").select("id,status").in("id", ctxOrderIds.slice(i, i + 500)); for (const o of data || []) ctxOrderStatus[o.id] = o.status; }
        for (let i = 0; i < ctxLeadIds.length; i += 500) { const { data } = await adminClient.from("prediction_leads").select("id,status").in("id", ctxLeadIds.slice(i, i + 500)); for (const l of data || []) ctxLeadStatus[l.id] = l.status; }
        // Order/lead status by phone (last-8, most-recent wins) for standalone calls.
        const needPhone = cand.filter((c) => !(c.context_type === "order" && ctxOrderStatus[c.context_id]) && !(c.context_type === "prediction_lead" && ctxLeadStatus[c.context_id]));
        const phones = [...new Set(needPhone.map((c) => last8f(c.customer_phone)).filter(Boolean))];
        const phoneOrderStatus: Record<string, string> = {}; const phoneLeadStatus: Record<string, string> = {};
        for (let i = 0; i < phones.length; i += 100) {
          const grp = phones.slice(i, i + 100);
          const { data: ords } = await adminClient.from("orders").select("customer_phone,status,created_at").or(grp.map((p) => `customer_phone.ilike.%${p}%`).join(",")).order("created_at", { ascending: false }).limit(3000);
          for (const o of ords || []) { const p = last8f(o.customer_phone); if (p && !(p in phoneOrderStatus)) phoneOrderStatus[p] = o.status; }
          const { data: lds } = await adminClient.from("prediction_leads").select("telephone,status,created_at").or(grp.map((p) => `telephone.ilike.%${p}%`).join(",")).order("created_at", { ascending: false }).limit(3000);
          for (const l of lds || []) { const p = last8f(l.telephone); if (p && !(p in phoneLeadStatus)) phoneLeadStatus[p] = l.status; }
        }
        const effOf = (c: any): string | null => {
          if (c.context_type === "order" && ctxOrderStatus[c.context_id]) return ctxOrderStatus[c.context_id];
          if (c.context_type === "prediction_lead" && ctxLeadStatus[c.context_id]) return ctxLeadStatus[c.context_id];
          const p = last8f(c.customer_phone); return phoneOrderStatus[p] || phoneLeadStatus[p] || null;
        };
        const matchIds = cand.filter((c) => resultTokenOf(c.outcome, effOf(c)) === resultFilter).map((c) => c.id);
        count = matchIds.length;
        const pageIds = matchIds.slice((page - 1) * limit, page * limit);
        if (pageIds.length) {
          const { data } = await adminClient.from("call_logs").select("*").in("id", pageIds);
          const byId = new Map((data || []).map((r: any) => [r.id, r] as [string, any]));
          logs = pageIds.map((id) => byId.get(id)).filter(Boolean);
        }
      } else {
        // No result filter → the straight, paginated call log.
        const { data, count: c, error } = await applyBase(
          adminClient.from("call_logs").select("*", { count: "exact" }).order("created_at", { ascending: false }),
        ).range((page - 1) * limit, page * limit - 1);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        logs = data || []; count = c || 0;
      }

      // Enrich with agent names, customer info (+ listened_by reviewer names)
      const agentIds = [...new Set((logs || []).flatMap((l: any) => [l.agent_id, l.listened_by]).filter(Boolean))];
      let agentMap: Record<string, string> = {};
      if (agentIds.length > 0) {
        const { data: profiles } = await adminClient.from("profiles").select("user_id, full_name").in("user_id", agentIds);
        for (const p of profiles || []) agentMap[p.user_id] = p.full_name;
      }

      // Batch lookup context info
      const orderContextIds = (logs || []).filter((l: any) => l.context_type === "order").map((l: any) => l.context_id);
      const leadContextIds = (logs || []).filter((l: any) => l.context_type === "prediction_lead").map((l: any) => l.context_id);

      let orderMap: Record<string, any> = {};
      let leadMap: Record<string, any> = {};

      if (orderContextIds.length > 0) {
        const { data: orders } = await adminClient.from("orders").select("id, display_id, customer_name, customer_phone, customer_city, customer_address, product_name, price, status, assigned_agent_name, source_type, created_at, order_items(id, product_name, quantity, price_per_unit, total_price)").in("id", orderContextIds);
        for (const o of orders || []) orderMap[o.id] = o;
      }
      if (leadContextIds.length > 0) {
        const { data: leads } = await adminClient.from("prediction_leads").select("id, name, telephone, product, city, address, status, assigned_agent_name, price, quantity, prediction_lead_items(id, product_name, quantity, price_per_unit, total_price), prediction_lists(name)").in("id", leadContextIds);
        for (const l of leads || []) leadMap[l.id] = l;
      }

      // Fetch order_history for order contexts
      let orderHistoryMap: Record<string, any[]> = {};
      if (orderContextIds.length > 0) {
        const { data: history } = await adminClient
          .from("order_history")
          .select("*")
          .in("order_id", orderContextIds)
          .order("changed_at", { ascending: false });
        for (const h of (history || [])) {
          if (!orderHistoryMap[h.order_id]) orderHistoryMap[h.order_id] = [];
          orderHistoryMap[h.order_id].push(h);
        }
      }

      // Search filter (post-query on enriched data if search provided)
      let enriched = (logs || []).map((l: any) => {
        const isOrder = l.context_type === "order";
        const isLead = l.context_type === "prediction_lead";
        // Standalone (topbar / brand-new-number) calls have no context_id — they
        // must NOT crash the page. context_id.substring(0,8) here used to throw.
        const ctx = isOrder ? orderMap[l.context_id] : isLead ? leadMap[l.context_id] : null;
        const items = isOrder ? (ctx?.order_items || []) : isLead ? (ctx?.prediction_lead_items || []) : [];
        const productDisplay = items.length > 0
          ? items.map((i: any) => `${i.product_name} x${i.quantity}`).join(", ")
          : (isOrder ? ctx?.product_name : isLead ? ctx?.product : "") || "";
        const totalPrice = items.length > 0
          ? items.reduce((s: number, i: any) => s + Number(i.total_price || 0), 0)
          : Number(ctx?.price || 0);
        return {
          ...l,
          agent_name: agentMap[l.agent_id] || "Unknown",
          listened_by_name: l.listened_by ? (agentMap[l.listened_by] || null) : null,
          customer_name: isOrder ? (ctx?.customer_name || "Unknown")
            : isLead ? (ctx?.name || "Unknown")
            : (l.customer_phone || "—"),
          customer_phone: isOrder ? ctx?.customer_phone : isLead ? ctx?.telephone : (l.customer_phone || ""),
          customer_city: isOrder ? ctx?.customer_city : isLead ? ctx?.city : "",
          customer_address: isOrder ? ctx?.customer_address : isLead ? ctx?.address : "",
          product_name: productDisplay,
          product_items: items,
          total_price: totalPrice,
          order_status: isOrder ? ctx?.status : isLead ? (ctx?.status || "") : "",
          order_agent: isOrder ? ctx?.assigned_agent_name : isLead ? (ctx?.assigned_agent_name || "") : "",
          order_source: isOrder ? (ctx?.source_type || "manual") : isLead ? "prediction_lead" : "standalone",
          display_id: isOrder ? ctx?.display_id : isLead ? (l.context_id ? l.context_id.substring(0, 8) : "") : "—",
          source: l.context_type,
          status_history: isOrder ? (orderHistoryMap[l.context_id] || []) : [],
          list_name: isLead ? (ctx?.prediction_lists?.name || "") : "",
        };
      });

      // ---- Resolve customer for STANDALONE calls by phone (last-8) ----
      // Standalone logs (topbar dials, and the very common prediction-list call
      // where the customer has no actionable order yet — pickLinkedContext returns
      // null) carry only a phone. Without this they render the raw number as the
      // "customer" and you can't tell which person/order each call was for. The
      // name already exists in prediction_leads / orders; we just look it up by the
      // last-8-digits rule (see skill: elyon-phone-normalization), exactly like the
      // orphan-recording path below. Display-only: outcome/lifecycle is untouched.
      const standaloneRows = enriched.filter(
        (e: any) => e.source !== "order" && e.source !== "prediction_lead" && e.customer_phone,
      );
      if (standaloneRows.length) {
        const last8 = (v: any) => String(v || "").replace(/\D/g, "").slice(-8);
        const wantPhones = [...new Set(standaloneRows.map((e: any) => last8(e.customer_phone)).filter(Boolean))];
        if (wantPhones.length) {
          const ordOr = wantPhones.map((p) => `customer_phone.ilike.%${p}%`).join(",");
          const leadOr = wantPhones.map((p) => `telephone.ilike.%${p}%`).join(",");
          const [ordRes, leadRes] = await Promise.all([
            adminClient.from("orders")
              .select("display_id, customer_name, customer_phone, customer_city, customer_address, status, assigned_agent_name, created_at")
              .or(ordOr).order("created_at", { ascending: false }).limit(500),
            adminClient.from("prediction_leads")
              .select("name, telephone, city, address, status, assigned_agent_name, created_at")
              .or(leadOr).order("created_at", { ascending: false }).limit(500),
          ]);
          const ordByPhone: Record<string, any> = {};
          for (const o of ordRes.data || []) { const p = last8(o.customer_phone); if (p && !ordByPhone[p]) ordByPhone[p] = o; } // most recent wins
          const leadByPhone: Record<string, any> = {};
          for (const l of leadRes.data || []) { const p = last8(l.telephone); if (p && !leadByPhone[p]) leadByPhone[p] = l; }
          for (const e of standaloneRows) {
            const p = last8(e.customer_phone);
            const o = ordByPhone[p];
            const l = leadByPhone[p];
            if (!o && !l) continue; // genuinely unknown number — keep the phone
            e.customer_name = o?.customer_name || l?.name || e.customer_name;
            e.customer_city = o?.customer_city || l?.city || e.customer_city;
            e.customer_address = o?.customer_address || l?.address || e.customer_address;
            e.order_status = o?.status || l?.status || e.order_status;
            e.order_agent = o?.assigned_agent_name || l?.assigned_agent_name || e.order_agent;
            if (o?.display_id) e.display_id = o.display_id;
          }
        }
      }

      // ---- Merge call recordings (best-effort; never block history on the PBX) ----
      // Recordings live on the VPS, not in the DB. We (a) attach a Play link to
      // any call_log on this page that has a matching recording, and (b) on page 1
      // surface recent recordings that have NO matching call_log at all (orphans —
      // e.g. a call the agent never saved an outcome for) enriched by the agent's
      // extension in the filename + the order matched by phone. This is what makes
      // the "agent / customer / what happened" show up for recordings.
      let recordings: any[] = [];
      try {
        const recExp = Math.floor(Date.now() / 1000) + 120;
        const recSig = await recSign("list", recExp);
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        try {
          const rr = await fetch(`${REC_HOST}?mode=list&exp=${recExp}&sig=${recSig}`, { signal: ctrl.signal });
          if (rr.ok) recordings = await rr.json();
        } finally { clearTimeout(t); }
      } catch (_e) { recordings = []; }
      if (!Array.isArray(recordings)) recordings = [];
      recordings = recordings.filter((r: any) => (r.size || 0) > 2000); // drop empty/failed (~44 B)

      const recLast8 = (r: any) => String(r.dialed || "").replace(/\D/g, "").slice(-8);
      const recMsOf = (r: any) => (r.mtime || 0) * 1000 || Date.now();

      // Resolve the agent behind each recording's extension once (tiny table), so
      // the matcher can keep two agents who called the same number apart.
      const extToAgent: Record<string, string> = {};
      if (recordings.length) {
        const recExts = [...new Set(recordings.map((r: any) => r.ext).filter(Boolean))];
        if (recExts.length) {
          const { data: te } = await adminClient.from("telephony_extensions").select("extension,user_id").in("extension", recExts);
          for (const x of te || []) if (x.extension && x.user_id) extToAgent[x.extension] = x.user_id;
        }
      }

      // (a) attach recording_file to THIS page's logs. Rows already linked in the
      // DB (recording_file persisted by the recording webhook / backfill) keep that
      // link untouched; only un-linked rows fall back to the live-list matcher. The
      // deterministic one-to-one matcher (end-anchored / interval-overlap) fixes
      // both the long-call miss and the repeat-number swap.
      if (recordings.length) {
        const needMatch = enriched.filter((e: any) => !e.recording_file && e.customer_phone);
        if (needMatch.length) {
          // Don't let a recording already DB-linked to one row on this page be
          // re-grabbed by another (un-linked) row in the live fallback.
          const linkedFiles = new Set(enriched.filter((e: any) => e.recording_file).map((e: any) => e.recording_file));
          const liveCandidates = (recordings as RecLite[]).filter((r) => !r.file || !linkedFiles.has(r.file));
          const matched = matchRecordingsToCalls(liveCandidates, needMatch as CallLite[], extToAgent);
          for (const e of needMatch) {
            const rec = matched.get(e.id);
            if (rec) { e.recording_file = rec.file; }
          }
        }
        for (const e of enriched) if (e.recording_file) e.has_recording = true;
      }

      // (b) page 1: union recent orphan recordings (no matching log anywhere)
      let orphanRows: any[] = [];
      const ORPHAN_MAX_AGE = 14 * 24 * 3600 * 1000; // only recent, actionable ones
      if (page === 1 && !sourceFilter && !search && recordings.length) {
        const recent = recordings.filter((r) => recMsOf(r) >= Date.now() - ORPHAN_MAX_AGE);
        if (recent.length) {
          const windowStart = new Date(Date.now() - (ORPHAN_MAX_AGE + 24 * 3600 * 1000)).toISOString();
          const { data: winLogs } = await adminClient
            .from("call_logs")
            .select("id, customer_phone, started_at, connected_at, ended_at, created_at")
            .gte("created_at", windowStart)
            .limit(8000);
          // A recording is an orphan only when the deterministic matcher can't
          // assign it to ANY call in the window (e.g. the agent never saved an
          // outcome). Linked recordings match their call here and drop out.
          const matchedWin = matchRecordingsToCalls(recent as RecLite[], (winLogs || []) as CallLite[], extToAgent);
          const claimedFiles = new Set<string>();
          for (const rec of matchedWin.values()) if (rec.file) claimedFiles.add(rec.file);
          const orphanRecs = recent
            .filter((rec: any) => !claimedFiles.has(rec.file))
            .slice(0, 100);

          // agent from filename extension -> telephony_extensions -> profiles
          const exts = [...new Set(orphanRecs.map((r) => r.ext).filter(Boolean))];
          const extAgent: Record<string, { user_id: string; full_name: string }> = {};
          if (exts.length) {
            const { data: te } = await adminClient.from("telephony_extensions").select("extension,user_id").in("extension", exts);
            const uids = [...new Set((te || []).map((x: any) => x.user_id).filter(Boolean))];
            const pm: Record<string, string> = {};
            if (uids.length) { const { data: pr } = await adminClient.from("profiles").select("user_id,full_name").in("user_id", uids); for (const p of pr || []) pm[p.user_id] = p.full_name; }
            for (const x of te || []) if (x.extension) extAgent[x.extension] = { user_id: x.user_id, full_name: pm[x.user_id] || "" };
          }
          // customer + status from the order matched by phone (last 8)
          const phones = [...new Set(orphanRecs.map(recLast8).filter(Boolean))].slice(0, 50);
          const orderByPhone: Record<string, any> = {};
          if (phones.length) {
            const orq = phones.map((p) => `customer_phone.ilike.%${p}%`).join(",");
            const { data: ords } = await adminClient
              .from("orders")
              .select("id, display_id, customer_name, customer_phone, customer_city, status, created_at")
              .or(orq)
              .order("created_at", { ascending: false })
              .limit(500);
            for (const o of ords || []) {
              const p = String(o.customer_phone || "").replace(/\D/g, "").slice(-8);
              if (p && !orderByPhone[p]) orderByPhone[p] = o; // most recent wins
            }
          }
          orphanRows = orphanRecs.map((rec) => {
            const last8 = recLast8(rec);
            const ord = orderByPhone[last8];
            const ag = rec.ext ? extAgent[rec.ext] : null;
            return {
              id: `rec:${rec.file}`,
              agent_id: ag?.user_id || null,
              agent_name: ag?.full_name || "—",
              customer_name: ord?.customer_name || rec.dialed || "—",
              customer_phone: ord?.customer_phone || rec.dialed || "",
              customer_city: ord?.customer_city || "",
              customer_address: "",
              outcome: null,
              notes: "",
              product_name: "",
              product_items: [],
              total_price: 0,
              order_status: ord?.status || "",
              order_agent: "",
              order_source: "recording",
              display_id: ord?.display_id || "—",
              source: "recording",
              result: "untracked",
              status_history: [],
              list_name: "",
              created_at: new Date(recMsOf(rec)).toISOString(),
              started_at: null, connected_at: null, ended_at: null,
              recording_file: rec.file,
              has_recording: true,
            };
          });
          // honour active filters + non-admin scoping on the synthetic rows
          if (!isAdminOrManager) orphanRows = orphanRows.filter((r) => r.agent_id && r.agent_id === user.id);
          if (agentFilter && isAdminOrManager) orphanRows = orphanRows.filter((r) => r.agent_id === agentFilter);
          if (resultFilter) orphanRows = []; // recordings carry no resolved result
          if (from) orphanRows = orphanRows.filter((r) => r.created_at >= from);
          if (to) orphanRows = orphanRows.filter((r) => r.created_at <= to);
        }
      }

      // combine + sort by time desc; orphan total only counts on page 1.
      // NOTE: search is now applied server-side BEFORE pagination (see above),
      // so there is no post-pagination filter here — the old approach only
      // filtered the current page's 25 rows and hid matches on other pages.
      let combined = [...orphanRows, ...enriched].sort((a: any, b: any) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      // total counts real call_logs only (drives pagination); orphan recordings
      // are surfaced on top of page 1 without displacing any log row, so they
      // don't create an empty trailing page.
      return json({ logs: redactCustomerList(combined, piiFlags), total: count || 0, page, limit });
    }

    // GET /api/call-logs/:contextType/:contextId
    if (req.method === "GET" && segments[0] === "call-logs" && segments.length === 3) {
      const contextType = segments[1];
      const contextId = segments[2];
      const { data, error } = await adminClient
        .from("call_logs")
        .select("*")
        .eq("context_type", contextType)
        .eq("context_id", contextId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // POST /api/call-logs/:id/listened — team-wide "reviewed" mark, set by the
    // client after >=10s of real playback. Hear-all roles only (the mark means
    // "a reviewer checked this call"); own-only agents don't set it.
    // Idempotent, first-listener-wins: never overwrites an existing mark.
    if (req.method === "POST" && segments[0] === "call-logs" && segments.length === 3 && segments[2] === "listened") {
      if (!canHearRecordings) return json({ error: "Forbidden" }, 403);
      const callId = segments[1];
      const { error } = await adminClient
        .from("call_logs")
        .update({ listened_at: new Date().toISOString(), listened_by: user.id })
        .eq("id", callId)
        .is("listened_at", null);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ ok: true });
    }

    // ============================================================
    // CUSTOMER HISTORY (full dossier for the Calls page)
    // ============================================================

    // POST /api/customers/update-contact — fix a customer's name / phone across
    // EVERY one of their orders at once (identified by the CURRENT phone, last-8).
    // Re-keys the prediction calling-queue sources too so the corrected number
    // flows into future calls. New phone is stored E.164 (+389…). Used by the
    // inline edit on the Calls customer card; the client then re-points Dial at the
    // new number. See the elyon-phone-normalization skill.
    if (req.method === "POST" && segments[0] === "customers" && segments[1] === "update-contact" && segments.length === 2) {
      if (!canMutateOrders) return json({ error: "Forbidden" }, 403);
      let body;
      try { body = parseBody(updateCustomerContactSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }

      const oldLast8 = body.phone.replace(/\D/g, "").slice(-8);
      if (oldLast8.length < 8) return json({ error: "Current phone must have at least 8 digits" }, 400);

      // Normalise a new phone to Bulgarian E.164. Guards against the scientific-
      // notation pollution that wrecked earlier imports (see the skill).
      let newPhone: string | undefined;
      if (body.customer_phone !== undefined && body.customer_phone.trim() !== "") {
        if (/e[+-]?\d/i.test(body.customer_phone.replace(/\s/g, ""))) {
          return json({ error: "Phone looks corrupted (scientific notation). Re-enter the digits." }, 400);
        }
        const d = body.customer_phone.replace(/\D/g, "");
        if (d.length < 8) return json({ error: "New phone must have at least 8 digits" }, 400);
        // Macedonia: E.164 is +389 + 8 subscriber digits (11 digits total);
        // the national form is 0 + those 8 digits (9 digits, e.g. 070123456).
        newPhone = d.length >= 11 && d.startsWith("389") ? "+" + d
          : d.length === 9 && d.startsWith("0") ? "+389" + d.slice(1)
          : d.length === 8 ? "+389" + d
          : "+" + d;
      }

      const nameProvided = body.customer_name !== undefined;
      if (!nameProvided && !newPhone) return json({ error: "Provide a new name or phone" }, 400);

      const orderUpdates: Record<string, any> = {};
      if (nameProvided) orderUpdates.customer_name = body.customer_name;
      if (newPhone) orderUpdates.customer_phone = newPhone;

      // Every order for this customer (admin client → all of them, whoever owns
      // each one — the whole history must stay linked to the corrected contact).
      const { data: affected, error: updErr } = await adminClient
        .from("orders").update(orderUpdates).ilike("customer_phone", `%${oldLast8}`).select("id");
      if (updErr) return json({ error: sanitizeDbError(updErr) }, 400);

      // Keep the calling-queue sources in sync so the corrected contact surfaces in
      // future prediction / uploaded-list calls. Best-effort — a failure here must
      // not undo the order fix.
      const memberUpdates: Record<string, any> = {};
      if (nameProvided) memberUpdates.customer_name = body.customer_name;
      if (newPhone) memberUpdates.customer_phone = newPhone;
      try { await adminClient.from("prediction_segment_members").update(memberUpdates).ilike("customer_phone", `%${oldLast8}`); } catch (_e) { /* best effort */ }
      const leadUpdates: Record<string, any> = {};
      if (nameProvided) leadUpdates.name = body.customer_name;
      if (newPhone) leadUpdates.telephone = newPhone;
      try { await adminClient.from("prediction_leads").update(leadUpdates).ilike("telephone", `%${oldLast8}`); } catch (_e) { /* best effort */ }

      return json({ ok: true, orders_updated: (affected || []).length, new_phone: newPhone || body.phone });
    }

    // GET /api/customers/:phone/history
    // Returns every order (regardless of status) + every call attempt by
    // every agent for the given customer phone, last-8-digits normalised.
    // Powers the Orders + Calls tabs in ClientProfileCard.
    if (req.method === "GET" && segments[0] === "customers" && segments[2] === "history" && segments.length === 3) {
      const phoneRaw = decodeURIComponent(segments[1]);
      const digitsOnly = phoneRaw.replace(/\D/g, "");
      const last8 = digitsOnly.length >= 8 ? digitsOnly.slice(-8) : "";
      if (!last8) return json({ orders: [], calls: [] });
      // The customer dossier (past orders + call attempts) is order-history data —
      // hidden from roles that can't see order history (investor managers).
      if (!showOrderHistory) return json({ orders: [], calls: [] });

      const [ordersRes, callsRes] = await Promise.all([
        adminClient
          .from("orders")
          .select(`
            id, display_id, customer_name, customer_phone, customer_city,
            customer_address, street, street_number, apartment, floor, block, entry, postal_code,
            product_name, quantity, price, status, source_type, created_at,
            ship_after_date, cancellation_reason, cancellation_reason_notes,
            cancelled_at, return_reason, return_reason_notes, returned_at,
            assigned_agent_name, delivery_type, courier_office_code,
            order_items(id, product_name, quantity, price_per_unit, total_price)
          `)
          .ilike("customer_phone", `%${last8}%`)
          .order("created_at", { ascending: false })
          .limit(200),
        adminClient
          .from("call_logs")
          .select(`
            id, agent_id, context_type, context_id, outcome, notes,
            created_at, started_at, connected_at, ended_at,
            ring_seconds, talk_seconds, total_seconds,
            customer_phone, connection_state
          `)
          .or(`customer_phone.ilike.%${last8}%`)
          .order("created_at", { ascending: false })
          .limit(200),
      ]);

      if (ordersRes.error) return json({ error: sanitizeDbError(ordersRes.error) }, 400);
      if (callsRes.error) return json({ error: sanitizeDbError(callsRes.error) }, 400);

      // Some old call_logs rows (pre-telemetry) have no customer_phone but
      // do have a context_id pointing at an order with the right phone.
      // Pull those in too so the Calls tab is complete for legacy data.
      const orderIds = (ordersRes.data || []).map((o: any) => o.id);
      let legacyCalls: any[] = [];
      if (orderIds.length > 0) {
        const { data: legacy } = await adminClient
          .from("call_logs")
          .select(`
            id, agent_id, context_type, context_id, outcome, notes,
            created_at, started_at, connected_at, ended_at,
            ring_seconds, talk_seconds, total_seconds,
            customer_phone, connection_state
          `)
          .eq("context_type", "order")
          .in("context_id", orderIds)
          .is("customer_phone", null)
          .order("created_at", { ascending: false })
          .limit(200);
        legacyCalls = legacy || [];
      }
      const callsRaw = [...(callsRes.data || []), ...legacyCalls];
      // Dedupe by id
      const seen = new Set<string>();
      const calls = callsRaw.filter(c => {
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      }).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      // Enrich calls with agent name
      const agentIds = [...new Set(calls.map(c => c.agent_id).filter(Boolean))];
      let agentMap: Record<string, string> = {};
      if (agentIds.length > 0) {
        const { data: profiles } = await adminClient
          .from("profiles").select("user_id, full_name").in("user_id", agentIds);
        for (const p of profiles || []) agentMap[p.user_id] = p.full_name;
      }
      const callsEnriched = calls.map(c => ({ ...c, agent_name: agentMap[c.agent_id] || "Unknown" }));

      return json({ orders: ordersRes.data || [], calls: callsEnriched });
    }

    // ============================================================
    // ACTIVE CALL VIEWS (TAKE status, heartbeat-based 2-min auto-release)
    // ============================================================

    // POST /api/active-call-views/heartbeat — body: { customer_phone }
    // Upserts the agent's view of this customer.
    // IMPORTANT: Enforces that an agent can only have ONE active view at a time.
    // On heartbeat for a new phone we first release all other views for that agent
    // (reverting any 'take' orders). This guarantees the Operations "Live Agent
    // Activity" widget and badges only ever show one current customer per agent.
    // On first call for a phone it also flips matching workable orders to 'take'.
    // Subsequent calls just bump last_heartbeat_at + expires_at.
    if (req.method === "POST" && path === "active-call-views/heartbeat") {
      let body: { customer_phone?: string };
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const phone = (body.customer_phone || "").trim();
      if (!phone) return json({ error: "customer_phone is required" }, 400);

      // Lazy cleanup of any expired views (cheap, idempotent).
      await adminClient.rpc("cleanup_expired_active_call_views");

      // === NEW: Enforce "one active customer per agent at a time" ===
      // When an agent heartbeats on a new phone, immediately release any other
      // views they currently have (for different phones). This prevents the
      // situation where one agent appears on many customers in the Operations
      // widget and makes the "currently on" data truthful.
      const { data: myProfile } = await adminClient
        .from("profiles").select("full_name").eq("user_id", user.id).maybeSingle();
      const myName = myProfile?.full_name || user.email || null;

      const { data: otherViews } = await adminClient
        .from("active_call_views")
        .select("id, customer_phone, taken_order_ids, taken_from_status, taken_from_agent")
        .eq("agent_id", user.id)
        .neq("customer_phone", phone);

      for (const view of otherViews || []) {
        await revertTakenOrders(adminClient, view, user.id);
        await adminClient.from("active_call_views").delete().eq("id", view.id);
      }
      // ============================================================

      // Is this the first heartbeat for this (agent, phone) pair?
      const { data: existing } = await adminClient
        .from("active_call_views")
        .select("id, taken_order_ids")
        .eq("agent_id", user.id)
        .eq("customer_phone", phone)
        .maybeSingle();

      const newExpiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

      if (existing) {
        // Just extend the heartbeat.
        const { data, error } = await adminClient
          .from("active_call_views")
          .update({ last_heartbeat_at: new Date().toISOString(), expires_at: newExpiresAt })
          .eq("id", existing.id)
          .select()
          .single();
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        return json(data);
      }

      // First heartbeat — flip the customer's WORKABLE orders to 'take'.
      // Only 'pending' and 'call_again' are workable (an agent is actively going
      // to call them). We deliberately do NOT flip 'cancelled'/'trashed': those
      // are resolved/parked (cancelled customers now live in "Current Cancels"),
      // and flipping a cancelled order to 'take' risks resurrecting it to
      // 'call_again' on an orphan revert. Protected (never flipped): confirmed,
      // shipped, paid, delivered, returned.
      const digitsOnly = phone.replace(/\D/g, "");
      const last8 = digitsOnly.length >= 8 ? digitsOnly.slice(-8) : "";
      let takenIds: string[] = [];
      let takenFrom: string[] = [];
      let takenFromAgent: (string | null)[] = [];
      if (last8) {
        const { data: candidates } = await adminClient
          .from("orders")
          .select("id, status, assigned_agent_id")
          // Suffix match, not `%last8%` — a substring match can hit a DIFFERENT
          // customer whose number merely contains these 8 digits, and takes/
          // parks/trashes would then land on the wrong person.
          //
          // NOTE: .ilike MUST come after .select. On the bare query builder it
          // does not exist, so putting it first throws a TypeError and 500s the
          // whole route — that is exactly what killed the take-lock in prod from
          // 2026-08-11 (no take flip, no assignment-on-open, no live-activity row).
          .ilike("customer_phone", `%${last8}`)
          .in("status", ["pending", "call_again"]);
        for (const o of candidates || []) {
          // A colleague's open lead is taken too (operator rule, 2026-08-10):
          // whoever is on the client is working it, and the screen must say so.
          // This is safe precisely because the release restores the prior
          // assignee from taken_from_agent — the lead goes back to them the
          // moment this agent moves on, unless an outcome resolved it first.
          // Already assigned → flip the status only. Leaving assigned_at alone
          // keeps the original assignment stamp intact through take/release.
          const update: Record<string, any> = o.assigned_agent_id
            ? { status: "take" }
            : {
                status: "take",
                assigned_agent_id: user.id,
                assigned_agent_name: myName,
                assigned_at: new Date().toISOString(),
              };
          const { error: upErr } = await adminClient
            .from("orders")
            .update(update)
            .eq("id", o.id)
            .eq("status", o.status); // optimistic concurrency — only flip if still in expected status
          if (!upErr) {
            takenIds.push(o.id);
            takenFrom.push(o.status);
            takenFromAgent.push(o.assigned_agent_id ?? null);
          }
        }

        // Duplicates (operator rule 2026-08-13): opening the customer CLAIMS any
        // unassigned duplicate for this agent — a sticky, REAL assignment (the
        // full triple), NOT a take. The status stays 'duplicated' so the badge
        // stays truthful, the id is never recorded in taken_order_ids, and the
        // release therefore never reverts it. This is what lets the agent save
        // the duplicate from the modal, exactly like an assigned lead.
        // A duplicate already owned by a colleague is left alone — the open-state
        // exemption still lets whoever is on the customer settle it.
        //
        // Select-then-update: the bundled supabase-js has no .ilike on UPDATE
        // builders either, so this cannot be written as one filtered update.
        const { data: dupsToClaim } = await adminClient
          .from("orders")
          .select("id")
          .ilike("customer_phone", `%${last8}`)
          .eq("status", "duplicated")
          .is("assigned_agent_id", null);
        if (dupsToClaim?.length) {
          await adminClient
            .from("orders")
            .update({
              assigned_agent_id: user.id,
              assigned_agent_name: myName,
              assigned_at: new Date().toISOString(),
            })
            .in("id", dupsToClaim.map((d: any) => d.id));
        }
      }

      const { data, error } = await adminClient
        .from("active_call_views")
        .insert({
          agent_id: user.id,
          agent_name: myName,
          customer_phone: phone,
          expires_at: newExpiresAt,
          taken_order_ids: takenIds,
          taken_from_status: takenFrom,
          taken_from_agent: takenFromAgent,
        })
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // ── Mandatory answer per opened client (operator rule 2026-08-13) ──────────
    // POST /api/call-obligations { customer_phone, customer_name?, source? }
    // Registers "this agent owes an answer for this client". The FIRST unanswered
    // client wins: if the agent already owes one, the STANDING obligation comes
    // back unchanged and the frontend snaps back to it. Admins/managers/warehouse
    // are exempt. Released automatically by every outcome path via
    // clearCallObligation(); DELETE /:agentId is the admin release valve.
    if (req.method === "POST" && path === "call-obligations") {
      if (isAdminOrManager || isWarehouse) return json({ obligation: null, exempt: true });
      let body: { customer_phone?: string; customer_name?: string; source?: string };
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const phone = (body.customer_phone || "").trim();
      const digits = phone.replace(/\D/g, "");
      if (digits.length < 8) return json({ obligation: null });
      const { data: existingOb } = await adminClient
        .from("agent_call_obligations")
        .select("agent_id, customer_phone, customer_name, source, created_at")
        .eq("agent_id", user.id)
        .maybeSingle();
      if (existingOb) return json({ obligation: existingOb });
      const { data: created, error: obErr } = await adminClient
        .from("agent_call_obligations")
        .insert({
          agent_id: user.id,
          customer_phone: phone,
          customer_name: (body.customer_name || "").trim() || null,
          source: (body.source || "calls").slice(0, 40),
        })
        .select()
        .single();
      // A second tab may have inserted first (PK conflict) — return theirs.
      if (obErr) {
        const { data: raced } = await adminClient
          .from("agent_call_obligations")
          .select("agent_id, customer_phone, customer_name, source, created_at")
          .eq("agent_id", user.id)
          .maybeSingle();
        return json({ obligation: raced ?? null });
      }
      return json({ obligation: created });
    }

    // GET /api/call-obligations/mine — the caller's standing obligation, if any.
    if (req.method === "GET" && path === "call-obligations/mine") {
      if (isAdminOrManager || isWarehouse) return json({ obligation: null, exempt: true });
      const { data: ob } = await adminClient
        .from("agent_call_obligations")
        .select("agent_id, customer_phone, customer_name, source, created_at")
        .eq("agent_id", user.id)
        .maybeSingle();
      return json({ obligation: ob ?? null });
    }

    // DELETE /api/call-obligations/:agentId — admin/manager release valve for a
    // stuck agent (e.g. the customer record was merged away mid-call).
    if (req.method === "DELETE" && segments[0] === "call-obligations" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      await adminClient.from("agent_call_obligations").delete().eq("agent_id", segments[1]);
      await audit(adminClient, user.id, user.email, "call_obligation.release", {
        target_type: "agent", target_name: segments[1],
      });
      return json({ success: true });
    }

    // DELETE /api/active-call-views/by-phone/:phone — explicit release
    // (called by the browser when the agent moves to another customer or
    // closes the page). Reverts taken orders to their original status.
    if (req.method === "DELETE" && segments[0] === "active-call-views" && segments[1] === "by-phone" && segments.length === 3) {
      const phone = decodeURIComponent(segments[2]);
      const { data: existing } = await adminClient
        .from("active_call_views")
        .select("id, taken_order_ids, taken_from_status, taken_from_agent, agent_id")
        .eq("agent_id", user.id)
        .eq("customer_phone", phone)
        .maybeSingle();
      if (!existing) return json({ ok: true, reverted: 0 });
      const reverted = await revertTakenOrders(adminClient, existing, user.id);
      await adminClient.from("active_call_views").delete().eq("id", existing.id);
      return json({ ok: true, reverted });
    }

    // GET /api/active-call-views/lookup?phone=... — who's currently viewing?
    // Returns { agent_id, agent_name, opened_at, expires_at } or null.
    if (req.method === "GET" && path === "active-call-views/lookup") {
      const phoneRaw = (url.searchParams.get("phone") || "").trim();
      if (!phoneRaw) return json(null);
      // Sweep first so we don't return stale data.
      await adminClient.rpc("cleanup_expired_active_call_views");
      const { data, error } = await adminClient
        .from("active_call_views")
        .select("id, agent_id, agent_name, customer_phone, opened_at, expires_at")
        .eq("customer_phone", phoneRaw)
        .order("opened_at", { ascending: false })
        .maybeSingle();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // GET /api/active-call-views — admin/manager only
    // Returns all currently active call views (live "who is on which customer").
    // Used for the Operations dashboard widget.
    if (req.method === "GET" && path === "active-call-views") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      await adminClient.rpc("cleanup_expired_active_call_views");

      const { data, error } = await adminClient
        .from("active_call_views")
        .select("id, agent_id, agent_name, customer_phone, opened_at, expires_at, taken_order_ids")
        .order("opened_at", { ascending: false });

      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    // ============================================================
    // CALL-AGAIN QUEUE (customers awaiting follow-up call)
    // ============================================================

    // GET /api/call-again-queue?mine=true|false
    // Customers awaiting a follow-up call within their 3-day Call-Again window.
    // Two sources, merged and de-duped by phone (the order row wins):
    //   A) prediction_segment_members in an open window (call_again_since set)
    //   B) orders currently in 'call_again' status (the order the agent called)
    // Sorted by in_call_again_until ASC so soonest-due appears first. Expiry is
    // lazy: anything past its 3-day window is reverted here before we read.
    if (req.method === "GET" && path === "call-again-queue") {
      const mine = url.searchParams.get("mine") !== "false";
      const restrictToMe = mine || !isAdminOrManager;
      await adminClient.rpc("expire_call_again_window");

      // ── Source A: prediction members in an open window ──
      let qa = adminClient
        .from("prediction_segment_members")
        .select(`
          list_id, customer_phone, customer_name, last_call_at, last_call_outcome,
          in_call_again_until, call_again_since, assigned_agent_id, assigned_agent_name,
          lifetime_value, paid_count, avg_package_price, trigger_event_at,
          prediction_segment_lists(name, category)
        `)
        .not("call_again_since", "is", null)
        .eq("is_completed", false)
        .order("in_call_again_until", { ascending: true, nullsFirst: false })
        // The page filters by agent and source CLIENT-side, so a truncated fetch
        // would quietly under-report a filtered view. The Assigner's Call Agains
        // tab is the paginated surface for bulk work.
        .limit(CALL_AGAIN_FETCH_CAP);
      if (restrictToMe) qa = qa.eq("assigned_agent_id", user.id);

      // ── Source B: orders currently marked Call Again ──
      let qb = adminClient
        .from("orders")
        .select(`
          id, customer_phone, customer_name, next_call_after, call_again_since,
          assigned_agent_id, assigned_agent_name, product_name, updated_at, created_at
        `)
        .eq("status", "call_again")
        .order("next_call_after", { ascending: true, nullsFirst: false })
        .limit(CALL_AGAIN_FETCH_CAP);
      if (restrictToMe) qb = qb.eq("assigned_agent_id", user.id);

      const [membersRes, ordersRes] = await Promise.all([qa, qb]);
      if (membersRes.error) return json({ error: sanitizeDbError(membersRes.error) }, 400);
      if (ordersRes.error) return json({ error: sanitizeDbError(ordersRes.error) }, 400);

      const last8 = (p: string | null) => {
        const d = (p || "").replace(/\D/g, "");
        return d.length >= 8 ? d.slice(-8) : d;
      };
      const byPhone = new Map<string, any>();
      // Orders win on dedupe — insert them first.
      for (const o of ordersRes.data || []) {
        const key = last8(o.customer_phone);
        if (!key || byPhone.has(key)) continue;
        byPhone.set(key, {
          source_kind: "order",
          list_id: `order:${o.id}`,
          customer_phone: o.customer_phone,
          customer_name: o.customer_name,
          last_call_at: o.updated_at,
          last_call_outcome: "no_answer",
          in_call_again_until: o.next_call_after,
          // How long this customer has been in the Call-Again window — the
          // operator's "since when", and the reason the list is sortable by age.
          call_again_since: o.call_again_since,
          assigned_agent_id: o.assigned_agent_id,
          assigned_agent_name: o.assigned_agent_name,
          lifetime_value: 0,
          paid_count: null,
          avg_package_price: null,
          trigger_event_at: o.created_at,
          prediction_segment_lists: { name: o.product_name, category: "order" },
        });
      }
      for (const m of membersRes.data || []) {
        const key = last8(m.customer_phone);
        if (!key || byPhone.has(key)) continue;
        byPhone.set(key, { source_kind: "prediction", ...m });
      }

      const merged = [...byPhone.values()].sort((a, b) => {
        const ta = a.in_call_again_until ? new Date(a.in_call_again_until).getTime() : Infinity;
        const tb = b.in_call_again_until ? new Date(b.in_call_again_until).getTime() : Infinity;
        return ta - tb;
      });
      return json(merged);
    }

    // ── Call Agains as an assignable pool (Assigner tab) ──────────────────
    //
    // PREDICTION-LIST call agains only. A lead (AlterCPA/webhook/site) that
    // didn't answer stays in its agent's own Pendings queue until they reach the
    // customer — it is never redistributed from here. Prediction call agains are
    // the opposite: they belong to no single agent's day and the operator wants
    // to hand them out repeatedly until somebody gets through.
    //
    // A member is "in Call Again" while `call_again_since` is set and the row is
    // not completed; `expire_call_again_window()` clears it after 6 days.
    // Sorted oldest-waiting-first — the ones going stale are the ones to hand out.
    if (req.method === "GET" && path === "call-agains") {
      if (!canViewModule("assigner")) return json({ error: "Forbidden" }, 403);
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
      const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") || "50")));
      const agentId = url.searchParams.get("agent_id");   // uuid | 'unassigned' | null

      await adminClient.rpc("expire_call_again_window");

      let q = adminClient
        .from("prediction_segment_members")
        .select(`
          list_id, customer_phone, customer_name, call_again_since, last_call_at,
          last_call_outcome, in_call_again_until, assigned_agent_id, assigned_agent_name,
          lifetime_value, paid_count, avg_package_price,
          prediction_segment_lists(name, category)
        `, { count: "exact" })
        .not("call_again_since", "is", null)
        .eq("is_completed", false)
        .order("call_again_since", { ascending: true })
        .range((page - 1) * limit, page * limit - 1);
      if (agentId === "unassigned") q = q.is("assigned_agent_id", null);
      else if (agentId && agentId !== "all" && UUID_RE.test(agentId)) q = q.eq("assigned_agent_id", agentId);

      const { data, count, error } = await q;
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ members: data || [], total: count ?? 0, page, limit });
    }

    // POST /api/call-agains/assign — hand a selection to an agent (or free it).
    // Members span MANY lists, so the per-list assign endpoint cannot express
    // this: the body carries (list_id, customer_phone) pairs and we group them
    // into one UPDATE per list.
    if (req.method === "POST" && path === "call-agains/assign") {
      if (!canViewModule("assigner")) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "assigner.unassign", 20)) {
        return json({ error: "Rate limit exceeded — try again in a minute" }, 429);
      }
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const members: Array<{ list_id?: string; customer_phone?: string }> =
        Array.isArray(body?.members) ? body.members.slice(0, 5000) : [];
      const agentId: string | null = body?.agent_id || null;
      if (members.length === 0) return json({ error: "No members specified" }, 400);
      if (agentId && !UUID_RE.test(agentId)) return json({ error: "Invalid agent_id" }, 400);

      let agentName: string | null = null;
      if (agentId) {
        const { data: profile } = await adminClient
          .from("profiles").select("full_name").eq("user_id", agentId).maybeSingle();
        if (!profile) return json({ error: "Agent not found" }, 404);
        agentName = profile.full_name || null;
      }

      const byList = new Map<string, string[]>();
      for (const m of members) {
        if (!m?.list_id || !m?.customer_phone) continue;
        if (!byList.has(m.list_id)) byList.set(m.list_id, []);
        byList.get(m.list_id)!.push(m.customer_phone);
      }

      let assigned = 0;
      for (const [listId, phones] of byList) {
        // Only the three assignment columns move — never is_completed,
        // last_call_* or the call-again window (elyon-assigner skill).
        const { count, error } = await adminClient
          .from("prediction_segment_members")
          .update({
            assigned_agent_id: agentId,
            assigned_agent_name: agentName,
            assigned_at: agentId ? new Date().toISOString() : null,
          }, { count: "exact" })
          .eq("list_id", listId)
          .in("customer_phone", phones)
          .not("call_again_since", "is", null)
          .eq("is_completed", false);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        assigned += count ?? 0;
      }

      await audit(adminClient, user.id, user.email, "call_agains.assign", {
        target_type: "prediction_segment_members",
        target_name: agentId
          ? `${assigned} call agains → ${agentName}`
          : `${assigned} call agains freed`,
        payload: { agent_id: agentId, agent_name: agentName, count: assigned, lists: [...byList.keys()] },
      });

      if (agentId && agentId !== user.id && assigned > 0) {
        await notifyUsers(adminClient, [agentId], {
          type: "assignment",
          title: "Call Agains assigned to you",
          message: `${assigned} customer${assigned === 1 ? "" : "s"} to call back — open Call Again.`,
          link: "/call-again",
          // English above is the fallback; the reader sees their own locale via
          // notif.callAgainsAssigned.* (all four locales). The namespace is
          // `notif`, matching notif.shippedUnpaid / notif.unpaidDigest — see
          // 20260905000000_notifications_meta.sql.
          meta: { i18n: "notif.callAgainsAssigned", count: assigned },
        });
      }

      return json({ success: true, assigned });
    }

    // ============================================================
    // APP SETTINGS (operator-tunable global knobs)
    // ============================================================

    // GET /api/app-settings — every authenticated user reads (e.g. the agent's
    // Personal List "/N" badge needs the cap). Returns a flat key→value map.
    if (req.method === "GET" && path === "app-settings") {
      const { data, error } = await adminClient.from("app_settings").select("key, value");
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      const out: Record<string, any> = {};
      for (const row of data || []) out[row.key] = row.value;
      // Ensure known defaults are always present even before first write.
      if (out.personal_list_max_holds === undefined) out.personal_list_max_holds = PERSONAL_LIST_CAP_DEFAULT;
      if (out.unpaid_chase_days === undefined) out.unpaid_chase_days = UNPAID_CHASE_DAYS_DEFAULT;
      if (out.unpaid_chase_stop_days === undefined) out.unpaid_chase_stop_days = UNPAID_CHASE_STOP_DAYS_DEFAULT;
      if (out.promo_of_the_day === undefined) out.promo_of_the_day = PROMO_OF_THE_DAY_DEFAULT;
      if (out.altercpa_push_enabled === undefined) out.altercpa_push_enabled = false;
      out.voip_minutes_bundle = { ...VOIP_MINUTES_BUNDLE_DEFAULT, ...(out.voip_minutes_bundle || {}) };
      return json(out);
    }

    // PATCH /api/app-settings — admin-only. Body: { personal_list_max_holds: 50 }
    if (req.method === "PATCH" && path === "app-settings") {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

      if (body.personal_list_max_holds !== undefined) {
        const n = Math.floor(Number(body.personal_list_max_holds));
        if (!Number.isFinite(n) || n < 1 || n > 1000) {
          return json({ error: "personal_list_max_holds must be between 1 and 1000" }, 400);
        }
        const { error } = await adminClient
          .from("app_settings")
          .upsert({ key: "personal_list_max_holds", value: n, updated_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "key" });
        if (error) return json({ error: sanitizeDbError(error) }, 400);
      }

      // Unpaid-delivery chase window (read by notify_unpaid_shipped_orders()).
      // `stop` must stay >= `days` or the band collapses and NOTHING is ever
      // chased — so when only one of the pair is patched, validate the incoming
      // value against the stored value of the other.
      if (body.unpaid_chase_days !== undefined || body.unpaid_chase_stop_days !== undefined) {
        const { data: cur } = await adminClient
          .from("app_settings").select("key, value")
          .in("key", ["unpaid_chase_days", "unpaid_chase_stop_days"]);
        const stored: Record<string, number> = {};
        for (const row of cur || []) stored[row.key] = Number(row.value);

        const patch: { key: string; value: number }[] = [];
        const days = body.unpaid_chase_days !== undefined
          ? Math.floor(Number(body.unpaid_chase_days))
          : (stored.unpaid_chase_days ?? UNPAID_CHASE_DAYS_DEFAULT);
        const stop = body.unpaid_chase_stop_days !== undefined
          ? Math.floor(Number(body.unpaid_chase_stop_days))
          : (stored.unpaid_chase_stop_days ?? UNPAID_CHASE_STOP_DAYS_DEFAULT);

        if (!Number.isFinite(days) || days < 1 || days > 30) {
          return json({ error: "unpaid_chase_days must be between 1 and 30" }, 400);
        }
        if (!Number.isFinite(stop) || stop < days || stop > 999) {
          return json({ error: "unpaid_chase_stop_days must be between unpaid_chase_days and 999" }, 400);
        }
        if (body.unpaid_chase_days !== undefined) patch.push({ key: "unpaid_chase_days", value: days });
        if (body.unpaid_chase_stop_days !== undefined) patch.push({ key: "unpaid_chase_stop_days", value: stop });

        for (const p of patch) {
          const { error } = await adminClient
            .from("app_settings")
            .upsert({ ...p, updated_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "key" });
          if (error) return json({ error: sanitizeDbError(error) }, 400);
        }
      }

      // A1 minutes bundle. Commercial terms, so they change on A1's schedule, not
      // ours — hence a tunable knob rather than a constant. Stored as one jsonb
      // blob because the fields only make sense together.
      if (body.voip_minutes_bundle !== undefined) {
        const b = body.voip_minutes_bundle;
        if (!b || typeof b !== "object" || Array.isArray(b)) {
          return json({ error: "voip_minutes_bundle must be an object" }, 400);
        }
        const included = Math.floor(Number(b.included_minutes));
        if (!Number.isFinite(included) || included < 0 || included > 1_000_000) {
          return json({ error: "included_minutes must be between 0 and 1000000" }, 400);
        }
        // 28, not 31: a cycle starting on the 29th-31st would skip February.
        const billingDay = Math.floor(Number(b.billing_day));
        if (!Number.isFinite(billingDay) || billingDay < 1 || billingDay > 28) {
          return json({ error: "billing_day must be between 1 and 28" }, 400);
        }
        const metric = b.metric === "total" ? "total" : "talk";
        const warn = Math.floor(Number(b.warn_pct));
        const critical = Math.floor(Number(b.critical_pct));
        if (!Number.isFinite(critical) || critical < 2 || critical > 100) {
          return json({ error: "critical_pct must be between 2 and 100" }, 400);
        }
        if (!Number.isFinite(warn) || warn < 1 || warn >= critical) {
          return json({ error: "warn_pct must be between 1 and critical_pct" }, 400);
        }
        const value = { included_minutes: included, billing_day: billingDay, metric, warn_pct: warn, critical_pct: critical };
        const { error } = await adminClient
          .from("app_settings")
          .upsert({ key: "voip_minutes_bundle", value, updated_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "key" });
        if (error) return json({ error: sanitizeDbError(error) }, 400);
      }

      // Product of the Day — the promo banner agents see on /calls. Purely
      // motivational: it is NEVER read by any payout/commission math (see
      // elyon-agent-commissions), so the only thing at stake is what the banner
      // says. Stored as one jsonb blob under `promo_of_the_day`.
      // Manual CPA push button on /orders (2026-08-14). Boolean only. This is
      // the feature's kill switch — the push route re-reads it on EVERY call,
      // so flipping it off is effective within one request.
      if (body.altercpa_push_enabled !== undefined) {
        if (typeof body.altercpa_push_enabled !== "boolean") {
          return json({ error: "altercpa_push_enabled must be a boolean" }, 400);
        }
        const { error } = await adminClient
          .from("app_settings")
          .upsert({ key: "altercpa_push_enabled", value: body.altercpa_push_enabled, updated_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "key" });
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        await audit(adminClient, user.id, user.email, "settings.altercpa_push_toggle", {
          target_type: "app_settings", target_id: "altercpa_push_enabled",
          payload: { enabled: body.altercpa_push_enabled },
        });
      }

      if (body.promo_of_the_day !== undefined) {
        const p = body.promo_of_the_day;
        if (!p || typeof p !== "object" || Array.isArray(p)) {
          return json({ error: "promo_of_the_day must be an object" }, 400);
        }
        const enabled = !!p.enabled;
        const productId = p.product_id == null ? null : String(p.product_id);
        if (productId !== null && !UUID_RE.test(productId)) {
          return json({ error: "promo_of_the_day.product_id must be a product UUID" }, 400);
        }
        const num = (v: unknown) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 && n <= 1000 ? Math.round(n * 100) / 100 : null;
        };
        const price = num(p.price_eur);
        const bonus = num(p.bonus_eur);
        // Only a switched-ON promo must be fully specified — a draft can be saved
        // with holes as long as it stays off (nothing renders for the agents).
        if (enabled && (!productId || price === null || bonus === null)) {
          return json({ error: "An enabled promo needs a product, a price and a bonus (0 < value <= 1000)" }, 400);
        }
        const expires = p.expires_on == null || p.expires_on === "" ? null : String(p.expires_on);
        if (expires !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
          return json({ error: "promo_of_the_day.expires_on must be YYYY-MM-DD or empty" }, 400);
        }
        // Optional hand-written wording, per language. Unknown language codes are
        // dropped; empty strings are dropped so the built-in translated default
        // takes over again the moment the operator clears a field.
        const LANGS = ["bg", "en", "sq"];
        const customText: Record<string, { short?: string; full?: string }> = {};
        if (p.custom_text && typeof p.custom_text === "object" && !Array.isArray(p.custom_text)) {
          for (const lang of LANGS) {
            const entry = (p.custom_text as any)[lang];
            if (!entry || typeof entry !== "object") continue;
            const short = String(entry.short ?? "").trim().slice(0, 300);
            const full = String(entry.full ?? "").trim().slice(0, 600);
            if (short || full) customText[lang] = { ...(short ? { short } : {}), ...(full ? { full } : {}) };
          }
        }

        const value = {
          enabled,
          product_id: productId,
          product_name: String(p.product_name ?? "").slice(0, 200),
          price_eur: price,
          bonus_eur: bonus,
          expires_on: expires,
          note: String(p.note ?? "").slice(0, 300),
          custom_text: customText,
        };
        const { error } = await adminClient
          .from("app_settings")
          .upsert({ key: "promo_of_the_day", value, updated_by: user.id, updated_at: new Date().toISOString() }, { onConflict: "key" });
        if (error) return json({ error: sanitizeDbError(error) }, 400);
      }
      return json({ success: true });
    }

    // GET /api/promo-of-the-day — the resolved promo for the CALLER, plus the
    // caller's OWN qualifying-order count for today. Display-only: nothing here
    // is written anywhere or fed into a payout. Returns {active:false} alone
    // when there is nothing to show, so the banner simply renders nothing.
    if (req.method === "GET" && path === "promo-of-the-day") {
      const { data: row } = await adminClient
        .from("app_settings").select("value").eq("key", "promo_of_the_day").maybeSingle();
      const p: any = row?.value || PROMO_OF_THE_DAY_DEFAULT;
      const { day, startISO, endISO } = skopjeDayRange();
      const price = Number(p?.price_eur);
      const bonus = Number(p?.bonus_eur);
      const active = !!p?.enabled
        && typeof p?.product_id === "string" && UUID_RE.test(p.product_id)
        && Number.isFinite(price) && Number.isFinite(bonus)
        && (!p?.expires_on || day <= String(p.expires_on));
      if (!active) return json({ active: false });

      // The caller's own orders for the Skopje day. Ownership = salesOwnerId
      // (confirmer, or the assignee on legacy rows) so "my sale" means the same
      // thing here as on every other surface.
      const { data: orders } = await adminClient
        .from("orders")
        .select("id, status, order_items(product_id, price_per_unit)")
        .or(salesOwnerOrFilter(user.id))
        .gte("created_at", startISO)
        .lt("created_at", endISO);

      // Up-sell rule: the promo product at or above the promo price, PLUS at
      // least one line of a different product. One bonus per order, however
      // many promo units are on it. Dead orders never count.
      const DEAD = new Set(["cancelled", "trashed", "duplicated"]);
      let count = 0;
      for (const o of orders || []) {
        if (DEAD.has(String((o as any).status))) continue;
        const items = (o as any).order_items || [];
        const hasPromo = items.some((it: any) => it.product_id === p.product_id && Number(it.price_per_unit) >= price);
        const hasOther = items.some((it: any) => it.product_id && it.product_id !== p.product_id);
        if (hasPromo && hasOther) count++;
      }

      return json({
        active: true,
        product_name: String(p.product_name || ""),
        price_eur: price,
        bonus_eur: bonus,
        note: String(p.note || ""),
        // Sent whole — the browser knows the agent's language, the server doesn't.
        custom_text: (p.custom_text && typeof p.custom_text === "object") ? p.custom_text : {},
        my_orders_today: count,
        my_bonus_today: Math.round(count * bonus * 100) / 100,
      });
    }

    // ============================================================
    // PERSONAL LIST (agent-self-claim of customers)
    // ============================================================

    // POST /api/personal-list — claim a customer for the current agent.
    if (req.method === "POST" && path === "personal-list") {
      let body;
      try { body = parseBody(personalListCreateSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }

      // Per-agent ceiling: configurable via app_settings (admin-tunable from
      // Settings → System Rules). Defaults to 50.
      const cap = await getPersonalListCap(adminClient);
      const { count: activeCount } = await adminClient
        .from("personal_list_holds")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", user.id)
        .eq("status", "active");
      if ((activeCount ?? 0) >= cap) {
        return json({ error: `You already have ${cap} customers in your Personal List. Release one before claiming another.` }, 409);
      }

      // Already claimed by anyone?
      const { data: existing } = await adminClient
        .from("personal_list_holds")
        .select("id, agent_name, reason, expires_at")
        .eq("customer_phone", body.customer_phone)
        .eq("status", "active")
        .maybeSingle();
      if (existing) {
        return json({
          error: `Already claimed by ${existing.agent_name} until ${existing.expires_at}`,
          held_by: existing,
        }, 409);
      }

      const { data: profile } = await adminClient
        .from("profiles").select("full_name").eq("user_id", user.id).maybeSingle();

      const { data, error } = await adminClient
        .from("personal_list_holds")
        .insert({
          agent_id: user.id,
          agent_name: profile?.full_name || user.email,
          customer_phone: body.customer_phone,
          customer_name: body.customer_name ?? null,
          reason: body.reason,
          follow_up_by: body.follow_up_by ?? null,
        })
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      // Claiming the customer to a Personal List is "leaving a mark" too.
      await clearCallObligation(adminClient, user.id, body.customer_phone);
      return json(data);
    }

    // GET /api/personal-list?mine=true — agent's own active holds.
    if (req.method === "GET" && path === "personal-list") {
      const mine = url.searchParams.get("mine") === "true";
      let q = adminClient
        .from("personal_list_holds")
        .select("*")
        .eq("status", "active")
        .order("expires_at", { ascending: true });
      if (mine) q = q.eq("agent_id", user.id);
      else if (!isAdminOrManager) q = q.eq("agent_id", user.id);
      const { data, error } = await q;
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    // GET /api/personal-list/lookup?phone=... — does anyone hold this phone?
    if (req.method === "GET" && path === "personal-list/lookup") {
      const phoneRaw = (url.searchParams.get("phone") || "").trim();
      const digitsOnly = phoneRaw.replace(/\D/g, "");
      const last8 = digitsOnly.length >= 8 ? digitsOnly.slice(-8) : "";
      if (!last8) return json(null);
      const { data, error } = await adminClient
        .from("personal_list_holds")
        .select("id, agent_id, agent_name, customer_phone, customer_name, reason, claimed_at, expires_at, follow_up_by")
        .eq("status", "active")
        // Suffix: `.maybeSingle()` THROWS when two rows match, so a substring
        // that catches a second customer turns this lookup into a 400.
        .ilike("customer_phone", `%${last8}`)
        .maybeSingle();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // GET /api/personal-list/expiring — admin/manager review queue.
    // Side effect: marks rows as escalated_at on first read past expiry.
    if (req.method === "GET" && path === "personal-list/expiring") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      // Lazy escalation — flips escalated_at on rows past expires_at.
      await adminClient.rpc("escalate_expired_personal_list_holds");
      const nowIso = new Date().toISOString();
      const { data, error } = await adminClient
        .from("personal_list_holds")
        .select("*")
        .eq("status", "active")
        .lt("expires_at", nowIso)
        .order("expires_at", { ascending: true });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    // GET /api/personal-list/expiring-count — header bell badge.
    if (req.method === "GET" && path === "personal-list/expiring-count") {
      const { data, error } = await adminClient.rpc("count_expired_personal_list_holds");
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ count: data ?? 0 });
    }

    // POST /api/personal-list/:id/extend — admin/manager only.
    if (req.method === "POST" && segments[0] === "personal-list" && segments[2] === "extend" && segments.length === 3) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const id = segments[1];
      let body;
      try { body = parseBody(personalListExtendSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const { data, error } = await adminClient
        .from("personal_list_holds")
        .update({
          expires_at: new Date(Date.now() + body.days * 86400_000).toISOString(),
          escalated_at: null,  // clear escalation flag — admin acted
          status: "extended",
        })
        .eq("id", id)
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      // Flip back to 'active' immediately — 'extended' is a transient marker
      // for audit; queue/badges look at status='active'.
      await adminClient.from("personal_list_holds").update({ status: "active" }).eq("id", id);
      return json(data);
    }

    // DELETE /api/personal-list/:id — release. Agent can release own;
    // admin/manager can release any (used by "Return to pool").
    if (req.method === "DELETE" && segments[0] === "personal-list" && segments.length === 2) {
      const id = segments[1];
      const { data: hold, error: fetchErr } = await adminClient
        .from("personal_list_holds")
        .select("agent_id, status")
        .eq("id", id)
        .single();
      if (fetchErr || !hold) return json({ error: "Hold not found" }, 404);
      if (hold.agent_id !== user.id && !isAdminOrManager) {
        return json({ error: "Forbidden" }, 403);
      }
      const newStatus = isAdminOrManager && hold.agent_id !== user.id
        ? "returned_to_pool"
        : "released";
      const { error } = await adminClient
        .from("personal_list_holds")
        .update({
          status: newStatus,
          released_at: new Date().toISOString(),
          released_by: user.id,
        })
        .eq("id", id);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ ok: true });
    }

    // ============================================================
    // SHIFTS
    // ============================================================

    // POST /api/shifts (admin only)
    if (req.method === "POST" && path === "shifts") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let body;
      try { body = parseBody(createShiftSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const { name, date, start_time, end_time, agent_ids } = body;

      // Support date range
      const dates: string[] = [];
      if (body.date_end && body.date_end !== date) {
        let cur = new Date(date);
        const end = new Date(body.date_end);
        while (cur <= end) {
          dates.push(cur.toISOString().substring(0, 10));
          cur.setDate(cur.getDate() + 1);
        }
      } else {
        dates.push(date);
      }

      const createdShifts = [];
      for (const d of dates) {
        const { data: shift, error: shiftErr } = await adminClient
          .from("shifts")
          .insert({ name: name.trim(), date: d, start_time, end_time, created_by: user.id })
          .select()
          .single();
        if (shiftErr) return json({ error: sanitizeDbError(shiftErr) }, 400);

        if (agent_ids?.length) {
          const assignments = agent_ids.map((aid: string) => ({ shift_id: shift.id, user_id: aid }));
          await adminClient.from("shift_assignments").insert(assignments);
        }
        createdShifts.push(shift);
      }

      return json(createdShifts.length === 1 ? createdShifts[0] : createdShifts);
    }

    // GET /api/shifts
    if (req.method === "GET" && path === "shifts") {
      const agentFilter = url.searchParams.get("agent_id");
      const dateFrom = url.searchParams.get("from");
      const dateTo = url.searchParams.get("to");

      let query = adminClient.from("shifts").select("*").order("date", { ascending: true }).order("start_time", { ascending: true });
      if (dateFrom) query = query.gte("date", dateFrom);
      if (dateTo) query = query.lte("date", dateTo);

      const { data: shifts, error } = await query;
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Get all assignments (paginated — a plain read caps at 1000 rows, which
      // would drop assignments and render shifts as falsely "Unassigned" once the
      // table grows past a month or two of data).
      const shiftIds = (shifts || []).map((s: any) => s.id);
      let assignments: any[] = [];
      if (shiftIds.length > 0) {
        for (let from = 0; ; from += 1000) {
          const { data: a } = await adminClient
            .from("shift_assignments").select("shift_id, user_id")
            .in("shift_id", shiftIds)
            .range(from, from + 999);
          if (!a || a.length === 0) break;
          assignments.push(...a);
          if (a.length < 1000) break;
        }
      }

      // Get agent profiles
      const agentUserIds = [...new Set(assignments.map((a: any) => a.user_id))];
      let agentMap: Record<string, string> = {};
      if (agentUserIds.length > 0) {
        const { data: profiles } = await adminClient.from("profiles").select("user_id, full_name").in("user_id", agentUserIds);
        for (const p of profiles || []) agentMap[p.user_id] = p.full_name;
      }

      const enriched = (shifts || []).map((s: any) => {
        const sAssignments = assignments.filter((a: any) => a.shift_id === s.id);
        return {
          ...s,
          agents: sAssignments.map((a: any) => ({ user_id: a.user_id, full_name: agentMap[a.user_id] || "Unknown" })),
        };
      });

      // Filter by agent if requested
      const result = agentFilter
        ? enriched.filter((s: any) => s.agents.some((a: any) => a.user_id === agentFilter))
        : enriched;

      return json(result);
    }

    // GET /api/shifts/my (agent's shifts) — enriched with clock-in time and
    // breaks per shift so the My Shifts page can show when the agent logged in
    // and how long they've spent on break.
    if (req.method === "GET" && path === "shifts/my") {
      const { data: myAssignments } = await adminClient.from("shift_assignments").select("shift_id").eq("user_id", user.id);
      const myShiftIds = (myAssignments || []).map((a: any) => a.shift_id);
      if (myShiftIds.length === 0) return json([]);

      const { data: shifts } = await adminClient.from("shifts").select("*").in("id", myShiftIds).order("date", { ascending: true }).order("start_time", { ascending: true });
      if (!shifts || shifts.length === 0) return json([]);

      // Earliest login per shift = the clock-in time.
      const { data: logins } = await adminClient
        .from("shift_login_logs")
        .select("shift_id, login_time")
        .eq("user_id", user.id)
        .in("shift_id", myShiftIds)
        .order("login_time", { ascending: true });
      const clockInByShift: Record<string, string> = {};
      for (const l of logins || []) {
        if (l.shift_id && !clockInByShift[l.shift_id]) clockInByShift[l.shift_id] = l.login_time;
      }

      // Breaks per shift.
      const { data: breaks } = await adminClient
        .from("shift_breaks")
        .select("id, shift_id, break_start, break_end")
        .eq("user_id", user.id)
        .in("shift_id", myShiftIds)
        .order("break_start", { ascending: true });
      const breaksByShift: Record<string, any[]> = {};
      for (const b of breaks || []) {
        if (!b.shift_id) continue;
        (breaksByShift[b.shift_id] ||= []).push(b);
      }

      const enriched = shifts.map((s: any) => {
        const shiftBreaks = breaksByShift[s.id] || [];
        const totalBreakMs = shiftBreaks.reduce((sum: number, b: any) => {
          const end = b.break_end ? new Date(b.break_end).getTime() : Date.now();
          return sum + Math.max(0, end - new Date(b.break_start).getTime());
        }, 0);
        return {
          ...s,
          clock_in_time: clockInByShift[s.id] || null,
          breaks: shiftBreaks,
          total_break_seconds: Math.round(totalBreakMs / 1000),
        };
      });
      return json(enriched);
    }

    // POST /api/shifts/break/start — begin a break for the current user.
    // Resolves the active shift server-side; idempotent (returns the existing
    // open break if one is already running).
    if (req.method === "POST" && path === "shifts/break/start") {
      const { data: existing } = await adminClient
        .from("shift_breaks")
        .select("*")
        .eq("user_id", user.id)
        .is("break_end", null)
        .order("break_start", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing) return json(existing);

      // Resolve today's shift (Europe/Skopje local date) to attach the break to.
      const tzParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Skopje",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).formatToParts(new Date());
      const g = (t: string) => tzParts.find((p) => p.type === t)?.value || "";
      const today = `${g("year")}-${g("month")}-${g("day")}`;

      // Find today's assigned shift via a date-filtered join (see check-login:
      // fetching all assignments then filtering caps at 1000 rows and misses the
      // row once an agent has many shifts).
      const { data: todayAssign } = await adminClient
        .from("shift_assignments")
        .select("shifts!inner(id,date)")
        .eq("user_id", user.id)
        .eq("shifts.date", today)
        .limit(1)
        .maybeSingle();
      const shiftId: string | null = (todayAssign as any)?.shifts?.id || null;

      const { data: created, error } = await adminClient
        .from("shift_breaks")
        .insert({ user_id: user.id, shift_id: shiftId, shift_date: today })
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(created);
    }

    // POST /api/shifts/break/end — close the current user's open break.
    if (req.method === "POST" && path === "shifts/break/end") {
      const { data: open } = await adminClient
        .from("shift_breaks")
        .select("id, break_start")
        .eq("user_id", user.id)
        .is("break_end", null)
        .order("break_start", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!open) return json({ ended: false });
      const { data: updated, error } = await adminClient
        .from("shift_breaks")
        .update({ break_end: new Date().toISOString() })
        .eq("id", open.id)
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ ended: true, break: updated });
    }

    // GET /api/shifts/break/active — current open break (or null) so the UI
    // can resume the running timer after a page refresh.
    if (req.method === "GET" && path === "shifts/break/active") {
      const { data: open } = await adminClient
        .from("shift_breaks")
        .select("*")
        .eq("user_id", user.id)
        .is("break_end", null)
        .order("break_start", { ascending: false })
        .limit(1)
        .maybeSingle();
      return json({ active: open || null });
    }

    // PATCH /api/shifts/:id (admin only)
    if (req.method === "PATCH" && segments[0] === "shifts" && segments.length === 2 && segments[1] !== "my") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const shiftId = segments[1];
      const body = await req.json();
      const { agent_ids, ...shiftUpdates } = body;

      if (Object.keys(shiftUpdates).length > 0) {
        const { error } = await adminClient.from("shifts").update(shiftUpdates).eq("id", shiftId);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
      }

      if (agent_ids !== undefined) {
        await adminClient.from("shift_assignments").delete().eq("shift_id", shiftId);
        if (agent_ids.length > 0) {
          const assignments = agent_ids.map((aid: string) => ({ shift_id: shiftId, user_id: aid }));
          await adminClient.from("shift_assignments").insert(assignments);
        }
      }

      return json({ success: true });
    }

    // DELETE /api/shifts/:id (admin only)
    if (req.method === "DELETE" && segments[0] === "shifts" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const shiftId = segments[1];
      const { error } = await adminClient.from("shifts").delete().eq("id", shiftId);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // GET /api/shifts/check-login — check if current user has an active shift right now
    if (req.method === "GET" && path === "shifts/check-login") {
      // Get user profile for logging
      const { data: userProfile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
      const userName = userProfile?.full_name || user.email || "Unknown";
      const primaryRole = roles[0] || "agent";

      // Admins and managers bypass shift restrictions.
      // They still get logged: the client only writes shift_login_logs on the
      // non-bypass branch, so before this the highest-privilege accounts were the
      // only ones with no login trail at all. Written here rather than in the
      // browser so it cannot be skipped by calling the auth endpoint directly.
      // Best-effort — a logging failure must never block a login.
      if (isAdminOrManager) {
        try {
          await adminClient.from("admin_login_logs").insert({
            user_id: user.id,
            email: user.email ?? null,
            roles,
            ip: req.headers.get("x-forwarded-for")?.split(",")[0].trim() || null,
            user_agent: req.headers.get("user-agent") || null,
          });
        } catch (_e) { /* ignore — logging is not worth failing a login over */ }
        return json({ allowed: true, bypass: true });
      }

      // Shift hours are entered in the operator's local time (Bulgaria /
      // Macedonia — Europe/Skopje, UTC+2 summer / UTC+1 winter). Edge Functions
      // run in UTC, so comparing against UTC "now" makes every shift look
      // 1–2h off (the 08:46 shift read as "not started" at 08:48 local because
      // the server saw 06:48 UTC). Evaluate today + now in Europe/Skopje so the
      // comparison matches what the user typed. DST handled by the runtime.
      const TZ = "Europe/Skopje";
      const tzParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: TZ,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(new Date());
      const tzGet = (t: string) => tzParts.find((p) => p.type === t)?.value || "";
      const today = `${tzGet("year")}-${tzGet("month")}-${tzGet("day")}`;
      let nowTime = `${tzGet("hour")}:${tzGet("minute")}`;
      if (nowTime.startsWith("24:")) nowTime = `00:${nowTime.slice(3)}`; // hour12:false can emit 24:xx at midnight

      // Fetch ONLY today's assigned shifts, filtering by date server-side via an
      // inner join. The previous approach fetched ALL of the user's assignments
      // and filtered in JS — but PostgREST caps an unpaginated read at 1000 rows,
      // so once an agent accumulated >1000 assignment rows (e.g. many months of
      // shifts), today's row fell outside the returned window and EVERY login was
      // wrongly blocked with "no shift scheduled for today". Filtering by date in
      // the query returns only today's handful of rows, immune to the cap.
      const { data: todayRows } = await adminClient
        .from("shift_assignments")
        .select("shifts!inner(id,date,start_time,end_time)")
        .eq("user_id", user.id)
        .eq("shifts.date", today);
      const todayShifts = (todayRows || []).map((r: any) => r.shifts).filter(Boolean);

      if (todayShifts.length === 0) {
        // Cheap existence check (head+count, not a capped fetch) to tell
        // "never scheduled" apart from "not scheduled today".
        const { count: anyAssign } = await adminClient
          .from("shift_assignments")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.id);
        const noneAtAll = (anyAssign || 0) === 0;
        await adminClient.from("blocked_login_attempts").insert({
          user_id: user.id, user_name: userName, role: primaryRole,
          reason: noneAtAll ? "No active shift assignment" : "No shift scheduled for today",
        });
        return json({
          allowed: false,
          message: noneAtAll
            ? "Login not allowed. You currently have no active shift."
            : "Login not allowed. You have no shift scheduled for today.",
        });
      }

      // Check if any shift covers the current time
      for (const shift of todayShifts) {
        const start = shift.start_time.substring(0, 5);
        const end = shift.end_time.substring(0, 5);

        // Special rule: 00:00 → 00:00 means NO active shift
        if (start === "00:00" && end === "00:00") {
          continue;
        }

        // Check if current time is within shift window
        if (nowTime >= start && nowTime <= end) {
          return json({ allowed: true, shift_id: shift.id, shift_date: shift.date, shift_start_time: start, shift_end_time: end, user_name: userName, role: primaryRole });
        }
      }

      // Check if all shifts are 00:00-00:00
      const allZero = todayShifts.every((s: any) => s.start_time.substring(0, 5) === "00:00" && s.end_time.substring(0, 5) === "00:00");
      if (allZero) {
        await adminClient.from("blocked_login_attempts").insert({
          user_id: user.id, user_name: userName, role: primaryRole,
          reason: "Shift set to 00:00-00:00 (no active shift)",
        });
        return json({ allowed: false, message: "Login not allowed. You currently have no active shift." });
      }

      // Has shifts but outside time window
      const shiftTimes = todayShifts
        .filter((s: any) => !(s.start_time.substring(0, 5) === "00:00" && s.end_time.substring(0, 5) === "00:00"))
        .map((s: any) => `${s.start_time.substring(0, 5)} - ${s.end_time.substring(0, 5)}`)
        .join(", ");
      await adminClient.from("blocked_login_attempts").insert({
        user_id: user.id, user_name: userName, role: primaryRole,
        reason: `Outside shift hours (${shiftTimes})`,
      });
      return json({ allowed: false, message: `Login not allowed. Your shift hours are: ${shiftTimes}. Current time is outside this window.` });
    }

    // POST /api/shifts/login-log — record login
    if (req.method === "POST" && path === "shifts/login-log") {
      const body = await req.json();
      const { shift_id, shift_date, shift_start_time, shift_end_time } = body;
      
      const { data, error } = await adminClient.from("shift_login_logs").insert({
        user_id: user.id,
        shift_id,
        shift_date,
        shift_start_time,
        shift_end_time,
        login_time: new Date().toISOString(),
      }).select().single();
      
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // PATCH /api/shifts/logout-log — record logout
    if (req.method === "PATCH" && path === "shifts/logout-log") {
      // Update the latest open login log for this user
      const { data: openLog } = await adminClient
        .from("shift_login_logs")
        .select("id")
        .eq("user_id", user.id)
        .is("logout_time", null)
        .order("login_time", { ascending: false })
        .limit(1)
        .single();
      
      if (openLog) {
        await adminClient.from("shift_login_logs")
          .update({ logout_time: new Date().toISOString() })
          .eq("id", openLog.id);
      }
      return json({ success: true });
    }

    // GET /api/shifts/statistics — agent shift statistics for admin/manager
    if (req.method === "GET" && path === "shifts/statistics") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      const dateFrom = url.searchParams.get("from");
      const dateTo = url.searchParams.get("to");

      let query = adminClient.from("shifts").select("*").order("date", { ascending: true });
      if (dateFrom) query = query.gte("date", dateFrom);
      if (dateTo) query = query.lte("date", dateTo);

      const { data: shifts } = await query;
      if (!shifts) return json([]);

      const shiftIds = shifts.map((s: any) => s.id);
      let assignments: any[] = [];
      if (shiftIds.length > 0) {
        const { data: a } = await adminClient.from("shift_assignments").select("shift_id, user_id").in("shift_id", shiftIds);
        assignments = a || [];
      }

      // Build per-agent statistics
      const agentStats: Record<string, { total_days: Set<string>; weekend_days: Set<string>; total_hours: number; total_shifts: number; weekday_shifts: number; weekend_shifts: number }> = {};

      for (const assignment of assignments) {
        const shift = shifts.find((s: any) => s.id === assignment.shift_id);
        if (!shift) continue;

        if (!agentStats[assignment.user_id]) {
          agentStats[assignment.user_id] = { total_days: new Set(), weekend_days: new Set(), total_hours: 0, total_shifts: 0, weekday_shifts: 0, weekend_shifts: 0 };
        }

        const stats = agentStats[assignment.user_id];
        stats.total_days.add(shift.date);
        stats.total_shifts++;

        // Calculate hours
        const startParts = shift.start_time.split(":").map(Number);
        const endParts = shift.end_time.split(":").map(Number);
        const startMins = startParts[0] * 60 + (startParts[1] || 0);
        const endMins = endParts[0] * 60 + (endParts[1] || 0);
        const hours = endMins > startMins ? (endMins - startMins) / 60 : 0;
        stats.total_hours += hours;

        // Weekend check (Saturday=6, Sunday=0)
        const dayOfWeek = new Date(shift.date + "T12:00:00").getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          stats.weekend_days.add(shift.date);
          stats.weekend_shifts++;
        } else {
          stats.weekday_shifts++;
        }
      }

      // Get agent names
      const agentUserIds = Object.keys(agentStats);
      let agentMap: Record<string, string> = {};
      if (agentUserIds.length > 0) {
        const { data: profiles } = await adminClient.from("profiles").select("user_id, full_name").in("user_id", agentUserIds);
        for (const p of profiles || []) agentMap[p.user_id] = p.full_name;
      }

      // Get login logs for actual hours
      let loginLogs: any[] = [];
      if (agentUserIds.length > 0) {
        let logQuery = adminClient.from("shift_login_logs").select("*").in("user_id", agentUserIds);
        if (dateFrom) logQuery = logQuery.gte("shift_date", dateFrom);
        if (dateTo) logQuery = logQuery.lte("shift_date", dateTo);
        const { data: logs } = await logQuery;
        loginLogs = logs || [];
      }

      const result = agentUserIds.map(uid => {
        const s = agentStats[uid];
        const agentLogs = loginLogs.filter((l: any) => l.user_id === uid);
        let actualHours = 0;
        for (const log of agentLogs) {
          if (log.login_time && log.logout_time) {
            actualHours += (new Date(log.logout_time).getTime() - new Date(log.login_time).getTime()) / 3600000;
          }
        }

        return {
          user_id: uid,
          full_name: agentMap[uid] || "Unknown",
          total_worked_days: s.total_days.size,
          total_weekend_days: s.weekend_days.size,
          total_hours_scheduled: Math.round(s.total_hours * 100) / 100,
          total_hours_actual: Math.round(actualHours * 100) / 100,
          total_shifts: s.total_shifts,
          average_hours_per_shift: s.total_shifts > 0 ? Math.round((s.total_hours / s.total_shifts) * 100) / 100 : 0,
          weekday_shifts: s.weekday_shifts,
          weekend_shifts: s.weekend_shifts,
        };
      });

      return json(result);
    }

    // GET /api/shifts/login-activity — login activity logs for admin/manager
    if (req.method === "GET" && path === "shifts/login-activity") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      const dateFrom = url.searchParams.get("from");
      const dateTo = url.searchParams.get("to");
      const agentFilter = url.searchParams.get("agent_id");
      const statusFilter = url.searchParams.get("status");

      // Fetch login logs
      let logQuery = adminClient.from("shift_login_logs").select("*").order("login_time", { ascending: false });
      if (dateFrom) logQuery = logQuery.gte("shift_date", dateFrom);
      if (dateTo) logQuery = logQuery.lte("shift_date", dateTo);
      if (agentFilter) logQuery = logQuery.eq("user_id", agentFilter);
      const { data: loginLogs } = await logQuery;

      // Fetch blocked attempts
      let blockedQuery = adminClient.from("blocked_login_attempts").select("*").order("attempt_time", { ascending: false });
      if (dateFrom) blockedQuery = blockedQuery.gte("attempt_time", `${dateFrom}T00:00:00`);
      if (dateTo) blockedQuery = blockedQuery.lte("attempt_time", `${dateTo}T23:59:59`);
      if (agentFilter) blockedQuery = blockedQuery.eq("user_id", agentFilter);
      const { data: blockedAttempts } = await blockedQuery;

      // Get user names & roles for login logs
      const userIds = [...new Set((loginLogs || []).map((l: any) => l.user_id))];
      let userMap: Record<string, { full_name: string; role: string }> = {};
      if (userIds.length > 0) {
        const { data: profiles } = await adminClient.from("profiles").select("user_id, full_name").in("user_id", userIds);
        const { data: userRoles } = await adminClient.from("user_roles").select("user_id, role").in("user_id", userIds);
        for (const p of profiles || []) {
          const role = (userRoles || []).find((r: any) => r.user_id === p.user_id)?.role || "agent";
          userMap[p.user_id] = { full_name: p.full_name, role };
        }
      }

      // Build activity entries from login logs
      const activities: any[] = [];
      for (const log of loginLogs || []) {
        const userInfo = userMap[log.user_id] || { full_name: "Unknown", role: "agent" };
        const shiftStart = log.shift_start_time?.substring(0, 5) || "";
        const shiftEnd = log.shift_end_time?.substring(0, 5) || "";
        const loginTimeStr = log.login_time ? new Date(log.login_time).toTimeString().substring(0, 5) : "";
        const logoutTimeStr = log.logout_time ? new Date(log.logout_time).toTimeString().substring(0, 5) : null;

        // Calculate session duration
        let sessionDuration: number | null = null;
        if (log.login_time && log.logout_time) {
          sessionDuration = (new Date(log.logout_time).getTime() - new Date(log.login_time).getTime()) / 60000; // minutes
        }

        // Determine status
        let status = "On Time";
        if (shiftStart && loginTimeStr > shiftStart) {
          status = "Late Login";
        }
        if (log.logout_time && shiftEnd && logoutTimeStr && logoutTimeStr < shiftEnd) {
          status = status === "Late Login" ? "Late Login" : "Early Logout";
        }

        activities.push({
          id: log.id,
          type: "login",
          user_id: log.user_id,
          user_name: userInfo.full_name,
          role: userInfo.role,
          shift_date: log.shift_date,
          shift_start: shiftStart,
          shift_end: shiftEnd,
          login_time: log.login_time,
          logout_time: log.logout_time,
          session_duration: sessionDuration,
          status,
        });
      }

      // Add blocked attempts
      for (const attempt of blockedAttempts || []) {
        activities.push({
          id: attempt.id,
          type: "blocked",
          user_id: attempt.user_id,
          user_name: attempt.user_name,
          role: attempt.role,
          shift_date: attempt.attempt_time?.substring(0, 10) || "",
          shift_start: null,
          shift_end: null,
          login_time: attempt.attempt_time,
          logout_time: null,
          session_duration: null,
          status: "Outside Shift (Blocked)",
          reason: attempt.reason,
        });
      }

      // Filter by status if provided
      let filtered = activities;
      if (statusFilter && statusFilter !== "all") {
        filtered = activities.filter(a => a.status === statusFilter);
      }

      // Sort by login_time descending
      filtered.sort((a, b) => new Date(b.login_time).getTime() - new Date(a.login_time).getTime());

      // Build per-agent summary
      const agentSummary: Record<string, { total_shifts: number; attended: number; late: number; early: number; blocked: number }> = {};
      for (const a of activities) {
        if (!agentSummary[a.user_id]) {
          agentSummary[a.user_id] = { total_shifts: 0, attended: 0, late: 0, early: 0, blocked: 0 };
        }
        const s = agentSummary[a.user_id];
        if (a.type === "blocked") {
          s.blocked++;
        } else {
          s.total_shifts++;
          s.attended++;
          if (a.status === "Late Login") s.late++;
          if (a.status === "Early Logout") s.early++;
        }
      }

      const summaryArray = Object.entries(agentSummary).map(([uid, s]) => ({
        user_id: uid,
        user_name: userMap[uid]?.full_name || activities.find(a => a.user_id === uid)?.user_name || "Unknown",
        ...s,
      }));

      return json({ activities: filtered, summary: summaryArray });
    }


    // ============================================================
    // SHIFT TEMPLATES
    // ============================================================

    // GET /api/shift-templates
    if (req.method === "GET" && path === "shift-templates") {
      const { data, error } = await adminClient.from("shift_templates").select("*").order("name", { ascending: true });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    // POST /api/shift-templates
    if (req.method === "POST" && path === "shift-templates") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const body = await req.json();
      const { name, start_time, end_time } = body;
      if (!name || !start_time || !end_time) return json({ error: "name, start_time, end_time required" }, 400);
      const { data, error } = await adminClient.from("shift_templates").insert({ name: name.trim(), start_time, end_time, created_by: user.id }).select().single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // PATCH /api/shift-templates/:id
    if (req.method === "PATCH" && segments[0] === "shift-templates" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const templateId = segments[1];
      const body = await req.json();
      const updates: Record<string, any> = {};
      if (body.name !== undefined) updates.name = body.name.trim();
      if (body.start_time !== undefined) updates.start_time = body.start_time;
      if (body.end_time !== undefined) updates.end_time = body.end_time;
      updates.updated_at = new Date().toISOString();

      const { data, error } = await adminClient.from("shift_templates").update(updates).eq("id", templateId).select().single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Update future shifts that use this template name (propagate time changes)
      const today = new Date().toISOString().substring(0, 10);
      if (body.start_time || body.end_time) {
        const shiftUpdates: Record<string, any> = {};
        if (body.start_time) shiftUpdates.start_time = body.start_time;
        if (body.end_time) shiftUpdates.end_time = body.end_time;
        if (body.name && data) shiftUpdates.name = data.name;
        // Update future shifts with matching name
        const oldName = body.name ? body.name.trim() : data.name;
        await adminClient.from("shifts").update(shiftUpdates).eq("name", oldName).gte("date", today);
      }

      return json(data);
    }

    // DELETE /api/shift-templates/:id
    if (req.method === "DELETE" && segments[0] === "shift-templates" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const templateId = segments[1];
      const { error } = await adminClient.from("shift_templates").delete().eq("id", templateId);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // POST /api/shift-templates/assign-week — assign a template to agents for a week
    if (req.method === "POST" && path === "shift-templates/assign-week") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const body = await req.json();
      const { template_id, agent_ids, week_start, days } = body;
      // days: array of date strings OR we generate Mon-Fri from week_start

      if (!template_id || !agent_ids?.length || !week_start) {
        return json({ error: "template_id, agent_ids, week_start required" }, 400);
      }

      // Get template
      const { data: template } = await adminClient.from("shift_templates").select("*").eq("id", template_id).single();
      if (!template) return json({ error: "Template not found" }, 404);

      // Generate dates for the week (Mon-Sun or custom days)
      let datesToCreate: string[] = [];
      if (days && Array.isArray(days) && days.length > 0) {
        datesToCreate = days;
      } else {
        // Default: Mon-Fri
        const start = new Date(week_start + "T12:00:00");
        for (let i = 0; i < 5; i++) {
          const d = new Date(start);
          d.setDate(d.getDate() + i);
          datesToCreate.push(d.toISOString().substring(0, 10));
        }
      }

      const createdShifts: any[] = [];
      for (const date of datesToCreate) {
        // Check if shift already exists for this template name + date
        const { data: existing } = await adminClient.from("shifts").select("id").eq("name", template.name).eq("date", date);
        
        let shiftId: string;
        if (existing && existing.length > 0) {
          shiftId = existing[0].id;
          // Update times in case template changed
          await adminClient.from("shifts").update({ start_time: template.start_time, end_time: template.end_time }).eq("id", shiftId);
        } else {
          const { data: newShift, error: shiftErr } = await adminClient.from("shifts").insert({
            name: template.name,
            date,
            start_time: template.start_time,
            end_time: template.end_time,
            created_by: user.id,
          }).select().single();
          if (shiftErr) return json({ error: sanitizeDbError(shiftErr) }, 400);
          shiftId = newShift.id;
          createdShifts.push(newShift);
        }

        // Add agent assignments (skip duplicates)
        for (const agentId of agent_ids) {
          const { data: existingAssignment } = await adminClient.from("shift_assignments").select("id").eq("shift_id", shiftId).eq("user_id", agentId);
          if (!existingAssignment || existingAssignment.length === 0) {
            await adminClient.from("shift_assignments").insert({ shift_id: shiftId, user_id: agentId });
          }
        }
      }

      return json({ success: true, shifts_created: createdShifts.length, days: datesToCreate.length });
    }

    // GET /api/warehouse/incoming-orders (confirmed orders + confirmed prediction leads)
    if (req.method === "GET" && path === "warehouse/incoming-orders") {
      if (!canViewModule("warehouse_incoming")) return json({ error: "Forbidden" }, 403);
      const agentFilter = url.searchParams.get("agent_id");
      let from = url.searchParams.get("from");
      let to = url.searchParams.get("to");
      const productFilter = url.searchParams.get("product");
      const sourceFilter = url.searchParams.get("source"); // "order" | "prediction_lead" | null
      const all = url.searchParams.get("all") === "1" || url.searchParams.get("all") === "true";

      // Safety default: never let an unfiltered call dump the entire history and hammer the DB.
      // Warehouse work is almost always "last 1-3 months". Explicit from/to or ?all=1 bypasses.
      const DEFAULT_WINDOW_DAYS = 90;
      if (!all && !from) {
        const d = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400000);
        from = d.toISOString();
      }

      const results: any[] = [];

      // Filter by status (default: confirmed + shipped)
      const statusFilter = url.searchParams.get("status"); // "confirmed" | "shipped" | null (both)

      // 1. Orders — always fetch orders (both standard and converted from prediction leads)
      // When source filter is "prediction_lead", only show orders that originated from prediction leads
      {
        let oQuery = adminClient.from("orders").select("*, order_items(id, product_id, product_name, quantity, price_per_unit, total_price)").order("created_at", { ascending: false });
        if (statusFilter) {
          oQuery = oQuery.eq("status", statusFilter);
        } else {
          oQuery = oQuery.in("status", ["confirmed", "shipped", "delivered", "paid"]);
        }
        if (agentFilter && agentFilter !== "all") oQuery = oQuery.eq("assigned_agent_id", agentFilter);
        if (from) oQuery = oQuery.gte("created_at", from);
        if (to) oQuery = oQuery.lte("created_at", to);
        if (productFilter) oQuery = oQuery.ilike("product_name", `%${productFilter}%`);
        // Apply source filter
        if (sourceFilter === "order") {
          oQuery = oQuery.is("source_lead_id", null);
        } else if (sourceFilter === "prediction_lead") {
          oQuery = oQuery.not("source_lead_id", "is", null);
        }

        // PostgREST default page size is 1000 rows — we must paginate explicitly
        // with .range() (same pattern used in dashboard-stats, CEO report, agent-performance,
        // segments membership counts, etc.). This guarantees we never silently truncate
        // even on wide windows or high-volume days. The composite indexes added in
        // 20260523093000_warehouse_incoming_orders_indexes.sql make the range scans efficient.
        const orders: any[] = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await oQuery.range(from, from + 999);
          if (error) throw error;
          if (!data || data.length === 0) break;
          orders.push(...data);
          if (data.length < 1000) break;
        }
        for (const o of orders) {
          results.push({
            id: o.id,
            display_id: o.display_id,
            customer_name: o.customer_name,
            customer_phone: o.customer_phone,
            customer_address: o.customer_address,
            customer_city: o.customer_city,
            postal_code: o.postal_code,
            birthday: o.birthday,
            product_name: o.product_name,
            product_id: o.product_id,
            price: o.price,
            quantity: o.quantity,
            assigned_agent_name: o.assigned_agent_name,
            assigned_agent_id: o.assigned_agent_id,
            created_at: o.created_at,
            status: o.status,
            source: o.source_lead_id ? "prediction_lead" : "order",
            source_lead_id: o.source_lead_id,
            order_items: o.order_items || [],
            ship_after_date: o.ship_after_date || null,
          });
        }
      }

      // 2. Unconverted prediction leads (confirmed but no linked order yet)
      if ((!sourceFilter || sourceFilter === "prediction_lead") && (!statusFilter || statusFilter === "confirmed")) {
        // Collect lead IDs that already have a linked order to avoid duplicates
        const linkedLeadIds = new Set(
          results.filter((r: any) => r.source_lead_id).map((r: any) => r.source_lead_id)
        );

        let lQuery = adminClient.from("prediction_leads").select("*, prediction_lists(name), prediction_lead_items(id, product_id, product_name, quantity, price_per_unit, total_price)").eq("status", "confirmed").order("created_at", { ascending: false });
        if (agentFilter && agentFilter !== "all") lQuery = lQuery.eq("assigned_agent_id", agentFilter);
        if (from) lQuery = lQuery.gte("created_at", from);
        if (to) lQuery = lQuery.lte("created_at", to);
        if (productFilter) lQuery = lQuery.ilike("product", `%${productFilter}%`);

        // Same explicit pagination as the orders branch above (PostgREST 1000-row safety).
        const leads: any[] = [];
        for (let from = 0; ; from += 1000) {
          const { data, error } = await lQuery.range(from, from + 999);
          if (error) throw error;
          if (!data || data.length === 0) break;
          leads.push(...data);
          if (data.length < 1000) break;
        }
        for (const l of leads) {
          // Skip leads that already have a linked order
          if (linkedLeadIds.has(l.id)) continue;

          // Use prediction_lead_items if available for correct product display
          const items = l.prediction_lead_items || [];
          const productDisplay = items.length > 0
            ? items.map((i: any) => i.product_name).join(", ")
            : (l.product || "—");
          const totalPrice = items.length > 0
            ? items.reduce((s: number, i: any) => s + Number(i.total_price || 0), 0)
            : (l.price || 0);
          const totalQty = items.length > 0
            ? items.reduce((s: number, i: any) => s + (i.quantity || 0), 0)
            : (l.quantity || 1);

          results.push({
            id: l.id,
            display_id: `LEAD-${l.name?.substring(0, 8) || l.id.substring(0, 8)}`,
            customer_name: l.name,
            customer_phone: l.telephone,
            customer_address: l.address || "",
            customer_city: l.city || "",
            postal_code: "",
            birthday: null,
            product_name: productDisplay,
            product_id: null,
            price: totalPrice,
            quantity: totalQty,
            assigned_agent_name: l.assigned_agent_name,
            assigned_agent_id: l.assigned_agent_id,
            created_at: l.created_at,
            status: "confirmed",
            source: "prediction_lead",
            list_name: l.prediction_lists?.name || "",
            notes: l.notes || "",
            order_items: items.length > 0 ? items : [],
          });
        }
      }

      // Sort combined by date desc
      results.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      return json(results);
    }

    // PATCH /api/warehouse/incoming-orders/:id (admin/manager/warehouse can edit order or lead)
    if (req.method === "PATCH" && segments[0] === "warehouse" && segments[1] === "incoming-orders" && segments.length === 3) {
      if (!canViewModule("warehouse_incoming")) return json({ error: "Forbidden" }, 403);
      const itemId = segments[2];
      const body = await req.json();
      const source = body._source; // "order" or "prediction_lead"

      if (source === "prediction_lead") {
        // Update prediction lead fields
        const leadUpdates: Record<string, any> = {};
        if (body.customer_name !== undefined) leadUpdates.name = body.customer_name;
        if (body.customer_phone !== undefined) leadUpdates.telephone = body.customer_phone;
        if (body.customer_address !== undefined) leadUpdates.address = body.customer_address;
        if (body.customer_city !== undefined) leadUpdates.city = body.customer_city;
        if (body.product_name !== undefined) leadUpdates.product = body.product_name;
        if (body.quantity !== undefined) leadUpdates.quantity = body.quantity;
        if (body.price !== undefined) leadUpdates.price = body.price;
        if (body.notes !== undefined) leadUpdates.notes = body.notes;

        // Map order/warehouse statuses to valid lead_status enum values
        if (body.status !== undefined) {
          const validLeadStatuses = ["not_contacted", "no_answer", "interested", "not_interested", "confirmed"];
          const orderToLeadStatusMap: Record<string, string> = {
            pending: "not_contacted",
            take: "interested",
            call_again: "no_answer",
            confirmed: "confirmed",
            shipped: "confirmed",
            delivered: "confirmed",
            returned: "not_interested",
            paid: "confirmed",
            trashed: "not_interested",
            cancelled: "not_interested",
          };
          leadUpdates.status = validLeadStatuses.includes(body.status)
            ? body.status
            : (orderToLeadStatusMap[body.status] || "not_contacted");
        }

        const { data: updatedLead, error } = await adminClient
          .from("prediction_leads")
          .update(leadUpdates)
          .eq("id", itemId)
          .select()
          .single();
        if (error) return json({ error: sanitizeDbError(error) }, 400);

        // If status changed, sync with linked order
        if (body.status) {
          const { data: existingOrder } = await adminClient
            .from("orders")
            .select("id, status")
            .eq("source_lead_id", itemId)
            .maybeSingle();

          if (existingOrder) {
            // Map lead status to order status
            const statusMap: Record<string, string> = {
              not_contacted: "pending",
              no_answer: "call_again",
              interested: "take",
              not_interested: "cancelled",
              confirmed: "confirmed",
            };
            const orderStatus = statusMap[body.status] || body.status;
            // Also sync fields
            const orderSync: Record<string, any> = { status: orderStatus };
            if (body.customer_name !== undefined) orderSync.customer_name = body.customer_name;
            if (body.customer_phone !== undefined) orderSync.customer_phone = body.customer_phone;
            if (body.customer_address !== undefined) orderSync.customer_address = body.customer_address;
            if (body.customer_city !== undefined) orderSync.customer_city = body.customer_city;
            if (body.product_name !== undefined) orderSync.product_name = body.product_name;
            if (body.quantity !== undefined) orderSync.quantity = body.quantity;
            if (body.price !== undefined) orderSync.price = body.price;

            await adminClient.from("orders").update(orderSync).eq("id", existingOrder.id);

            if (existingOrder.status !== orderStatus) {
              const { data: profile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
              await adminClient.from("order_history").insert({
                order_id: existingOrder.id,
                from_status: existingOrder.status,
                to_status: orderStatus,
                changed_by: user.id,
                changed_by_name: profile?.full_name || "Warehouse",
              });
            }
          } else if (["call_again", "confirmed"].includes(body.status)) {
            // Create order if none exists
            const lead = updatedLead;
            const { data: agentProfile } = lead.assigned_agent_id
              ? await adminClient.from("profiles").select("full_name").eq("user_id", lead.assigned_agent_id).single()
              : { data: null };
            const { data: newOrder } = await adminClient
              .from("orders")
              .insert({
                product_name: lead.product || "From Prediction Lead",
                customer_name: lead.name || "",
                customer_phone: lead.telephone || "",
                customer_city: lead.city || "",
                customer_address: lead.address || "",
                price: lead.price || 0,
                quantity: lead.quantity || 1,
                status: body.status === "confirmed" ? "confirmed" : "call_again",
                source_type: "prediction_lead",
                source_lead_id: itemId,
                assigned_agent_id: lead.assigned_agent_id,
                assigned_agent_name: agentProfile?.full_name || lead.assigned_agent_name || null,
                assigned_at: lead.assigned_agent_id ? new Date().toISOString() : null,
              })
              .select()
              .single();
            if (newOrder) {
              await adminClient.from("order_history").insert({
                order_id: newOrder.id,
                to_status: newOrder.status,
                changed_by: user.id,
                changed_by_name: "Warehouse",
              });
            }
          }
        }

        return json(updatedLead);
      } else {
        // Update order fields directly using adminClient
        const orderUpdates: Record<string, any> = {};
        if (body.customer_name !== undefined) orderUpdates.customer_name = body.customer_name;
        if (body.customer_phone !== undefined) orderUpdates.customer_phone = body.customer_phone;
        if (body.customer_address !== undefined) orderUpdates.customer_address = body.customer_address;
        if (body.customer_city !== undefined) orderUpdates.customer_city = body.customer_city;
        if (body.postal_code !== undefined) orderUpdates.postal_code = body.postal_code;
        if (body.birthday !== undefined) orderUpdates.birthday = body.birthday;
        if (body.product_name !== undefined) orderUpdates.product_name = body.product_name;
        if (body.product_id !== undefined) orderUpdates.product_id = body.product_id;
        if (body.quantity !== undefined) orderUpdates.quantity = body.quantity;
        if (body.price !== undefined) orderUpdates.price = body.price;

        // Handle status change
        if (body.status !== undefined) {
          const { data: currentOrder } = await adminClient.from("orders").select("*").eq("id", itemId).single();
          if (!currentOrder) return json({ error: "Order not found" }, 404);

          // Stock deduction on shipped — supports multi-product orders
          if (body.status === "shipped" && currentOrder.status !== "shipped") {
            const { data: orderItems } = await adminClient.from("order_items").select("*").eq("order_id", itemId);
            if (orderItems && orderItems.length > 0) {
              // Multi-product: check stock for all items first
              for (const item of orderItems) {
                if (!item.product_id) continue;
                const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", item.product_id).single();
                if (product && product.stock_quantity < item.quantity) {
                  return json({ error: `Insufficient stock: ${product.name} has ${product.stock_quantity} available, but order requires ${item.quantity}` }, 400);
                }
              }
              // All checks passed, deduct
              for (const item of orderItems) {
                if (!item.product_id) continue;
                const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", item.product_id).single();
                if (product) {
                  const newQty = product.stock_quantity - item.quantity;
                  await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", item.product_id);
                  await adminClient.from("inventory_logs").insert({
                    product_id: item.product_id,
                    change_amount: -item.quantity,
                    previous_stock: product.stock_quantity,
                    new_stock: newQty,
                    reason: "order_deduction",
                    movement_type: "order_deduction",
                    user_id: user.id,
                    notes: `Order ${currentOrder.display_id} shipped (warehouse) — ${item.product_name}`,
                  });
                }
              }
            } else {
              // Legacy single-product fallback
              const orderQty = body.quantity ?? currentOrder.quantity ?? 1;
              const productId = body.product_id ?? currentOrder.product_id;
              if (productId) {
                const { data: product } = await adminClient.from("products").select("stock_quantity, name").eq("id", productId).single();
                if (product && product.stock_quantity < orderQty) {
                  return json({ error: `Insufficient stock: ${product.name} has ${product.stock_quantity} available, but order requires ${orderQty}` }, 400);
                }
                if (product) {
                  const newQty = product.stock_quantity - orderQty;
                  await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", productId);
                  await adminClient.from("inventory_logs").insert({
                    product_id: productId,
                    change_amount: -orderQty,
                    previous_stock: product.stock_quantity,
                    new_stock: newQty,
                    reason: "order_deduction",
                    movement_type: "order_deduction",
                    user_id: user.id,
                    notes: `Order ${currentOrder.display_id} shipped (warehouse)`,
                  });
                }
              }
            }
          }

          orderUpdates.status = body.status;
          const { data: profile } = await adminClient.from("profiles").select("full_name").eq("user_id", user.id).single();
          await adminClient.from("order_history").insert({
            order_id: itemId,
            from_status: currentOrder.status,
            to_status: body.status,
            changed_by: user.id,
            changed_by_name: profile?.full_name || "Warehouse",
          });

          // Sync back to prediction lead if linked
          if (currentOrder.source_lead_id) {
            const leadStatusMap: Record<string, string> = {
              pending: "not_contacted",
              take: "interested",
              call_again: "no_answer",
              confirmed: "confirmed",
            };
            const leadStatus = leadStatusMap[body.status];
            if (leadStatus) {
              await adminClient.from("prediction_leads").update({ status: leadStatus }).eq("id", currentOrder.source_lead_id);
            }
          }
        }

        const { data, error } = await adminClient.from("orders").update(orderUpdates).eq("id", itemId).select().single();
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        return json(data);
      }
    }

    // DELETE /api/warehouse/incoming-orders/:id
    if (req.method === "DELETE" && segments[0] === "warehouse" && segments[1] === "incoming-orders" && segments.length === 3) {
      if (!canViewModule("warehouse_incoming")) return json({ error: "Forbidden" }, 403);
      const itemId = segments[2];
      const source = url.searchParams.get("source");

      if (source === "prediction_lead") {
        // Delete linked order first if exists
        await adminClient.from("orders").delete().eq("source_lead_id", itemId);
        const { error } = await adminClient.from("prediction_leads").delete().eq("id", itemId);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
      } else {
        // Delete order notes and history first
        await adminClient.from("order_notes").delete().eq("order_id", itemId);
        await adminClient.from("order_history").delete().eq("order_id", itemId);
        const { error } = await adminClient.from("orders").delete().eq("id", itemId);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
      }
      return json({ success: true });
    }

    // GET /api/warehouse/user-items (admin: all, agent: own)
    if (req.method === "GET" && path === "warehouse/user-items") {
      let query = adminClient.from("user_warehouse").select("*, products(name, sku, price, stock_quantity)").order("created_at", { ascending: false });
      if (!isAdminOrManager && !isWarehouse) {
        query = query.eq("user_id", user.id);
      }
      const { data, error } = await query;
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Enrich with user names
      const userIds = [...new Set((data || []).map((d: any) => d.user_id))];
      let userMap: Record<string, string> = {};
      if (userIds.length > 0) {
        const { data: profiles } = await adminClient.from("profiles").select("user_id, full_name").in("user_id", userIds);
        for (const p of profiles || []) userMap[p.user_id] = p.full_name;
      }

      const enriched = (data || []).map((d: any) => ({
        ...d,
        user_name: userMap[d.user_id] || "Unknown",
        product_name: d.products?.name || "Unknown",
        product_sku: d.products?.sku || null,
        product_price: d.products?.price || 0,
      }));
      return json(enriched);
    }

    // POST /api/warehouse/user-items (admin: assign product to user)
    if (req.method === "POST" && path === "warehouse/user-items") {
      if (!isAdminOrManager && !isWarehouse) return json({ error: "Forbidden" }, 403);
      let body;
      try { body = parseBody(warehouseItemSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const { user_id: targetUserId, product_id, quantity, notes: itemNotes } = body;

      // Upsert: if exists, add quantity
      const { data: existing } = await adminClient
        .from("user_warehouse")
        .select("id, quantity")
        .eq("user_id", targetUserId)
        .eq("product_id", product_id)
        .single();

      let result;
      if (existing) {
        const { data, error } = await adminClient
          .from("user_warehouse")
          .update({ quantity: existing.quantity + (quantity || 1), assigned_by: user.id, notes: itemNotes || "" })
          .eq("id", existing.id)
          .select()
          .single();
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        result = data;
      } else {
        const { data, error } = await adminClient
          .from("user_warehouse")
          .insert({ user_id: targetUserId, product_id, quantity: quantity || 1, assigned_by: user.id, notes: itemNotes || "" })
          .select()
          .single();
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        result = data;
      }
      return json(result);
    }

    // PATCH /api/warehouse/user-items/:id (admin: update assignment)
    if (req.method === "PATCH" && segments[0] === "warehouse" && segments[1] === "user-items" && segments.length === 3) {
      if (!isAdminOrManager && !isWarehouse) return json({ error: "Forbidden" }, 403);
      const itemId = segments[2];
      const body = await req.json();
      const updates: Record<string, any> = {};
      if (body.quantity !== undefined) updates.quantity = body.quantity;
      if (body.user_id !== undefined) updates.user_id = body.user_id;
      if (body.notes !== undefined) updates.notes = body.notes;

      const { data, error } = await adminClient
        .from("user_warehouse")
        .update(updates)
        .eq("id", itemId)
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // DELETE /api/warehouse/user-items/:id (admin only)
    if (req.method === "DELETE" && segments[0] === "warehouse" && segments[1] === "user-items" && segments.length === 3) {
      if (!isAdminOrManager && !isWarehouse) return json({ error: "Forbidden" }, 403);
      const itemId = segments[2];
      const { error } = await adminClient.from("user_warehouse").delete().eq("id", itemId);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // GET /api/me
    if (req.method === "GET" && path === "me") {
      const { data: profile } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", user.id)
        .single();

      // Derive a primary role for legacy callers (mirror determinePrimaryRole in AuthContext)
      const primaryRole = isAdmin ? "admin"
        : isManager ? "manager"
        : roles.includes("prediction_agent") ? "prediction_agent"
        : roles.includes("pending_agent") ? "pending_agent"
        : roles.includes("agent") ? "agent"
        : isWarehouse ? "warehouse"
        : isAdsAdmin ? "ads_admin"
        : "pending_agent";

      return json({ ...profile, role: primaryRole, roles });
    }

    // GET /api/recent-activity
    if (req.method === "GET" && path === "recent-activity") {
      const limit = parseInt(url.searchParams.get("limit") || "20");
      // Call Agents (non admin/manager) only see their OWN activity, never the
      // system-wide feed. Admins/managers see everything.
      const scopeMine = !isAdminOrManager;

      // Strip the technical backup payload the address-restructure script
      // appends ("... __ORIG__{json}") so notes read as plain text, not code.
      const cleanActivityNote = (t: string) =>
        (t || "").replace(/\s*__ORIG__[\s\S]*$/, "").replace(/\s*Original: city=[\s\S]*$/, "").trim();

      // Fetch recent order status changes
      let statusQ = adminClient
        .from("order_history")
        .select("id, order_id, from_status, to_status, changed_by_name, changed_at")
        .order("changed_at", { ascending: false })
        .limit(limit);
      if (scopeMine) statusQ = statusQ.eq("changed_by", user.id);
      const { data: statusChanges } = await statusQ;

      // Fetch recent call logs
      let callsQ = adminClient
        .from("call_logs")
        .select("id, context_type, context_id, outcome, notes, agent_id, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (scopeMine) callsQ = callsQ.eq("agent_id", user.id);
      const { data: callLogs } = await callsQ;

      // Fetch recent order notes
      let notesQ = adminClient
        .from("order_notes")
        .select("id, order_id, author_name, text, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (scopeMine) notesQ = notesQ.eq("author_id", user.id);
      const { data: orderNotes } = await notesQ;

      // Get agent names for call logs
      const agentIds = [...new Set((callLogs || []).map((c: any) => c.agent_id))];
      const agentNameMap: Record<string, string> = {};
      if (agentIds.length > 0) {
        const { data: profiles } = await adminClient
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", agentIds);
        for (const p of profiles || []) {
          agentNameMap[p.user_id] = p.full_name;
        }
      }

      // Get display_ids for orders referenced in status changes and notes
      const orderIds = [
        ...new Set([
          ...(statusChanges || []).map((s: any) => s.order_id),
          ...(orderNotes || []).map((n: any) => n.order_id),
        ]),
      ];
      const orderDisplayMap: Record<string, string> = {};
      if (orderIds.length > 0) {
        const { data: orders } = await adminClient
          .from("orders")
          .select("id, display_id")
          .in("id", orderIds);
        for (const o of orders || []) {
          orderDisplayMap[o.id] = o.display_id;
        }
      }

      // Merge into unified activity feed
      const activities: any[] = [];

      for (const s of statusChanges || []) {
        activities.push({
          id: s.id,
          type: "status_change",
          actor: s.changed_by_name || "System",
          description: `Changed order ${orderDisplayMap[s.order_id] || "?"} from ${s.from_status || "new"} to ${s.to_status}`,
          order_id: s.order_id,
          display_id: orderDisplayMap[s.order_id],
          metadata: { from: s.from_status, to: s.to_status },
          timestamp: s.changed_at,
        });
      }

      for (const c of callLogs || []) {
        activities.push({
          id: c.id,
          type: "call",
          actor: agentNameMap[c.agent_id] || "Agent",
          description: `Made a ${c.outcome} call (${c.context_type})`,
          metadata: { outcome: c.outcome, context_type: c.context_type, notes: c.notes },
          timestamp: c.created_at,
        });
      }

      for (const n of orderNotes || []) {
        const noteText = cleanActivityNote(n.text);
        activities.push({
          id: n.id,
          type: "note",
          actor: n.author_name,
          description: `Added note on ${orderDisplayMap[n.order_id] || "order"}: "${noteText.substring(0, 60)}${noteText.length > 60 ? "..." : ""}"`,
          order_id: n.order_id,
          display_id: orderDisplayMap[n.order_id],
          timestamp: n.created_at,
        });
      }

      // Sort by timestamp descending
      activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return json(activities.slice(0, limit));
    }

    // ============================================================
    // ADS CAMPAIGNS
    // ============================================================

    // GET /api/ads-campaigns
    if (req.method === "GET" && path === "ads-campaigns") {
      if (!isAdmin && !isAdsAdmin) return json({ error: "Forbidden" }, 403);
      const platform = url.searchParams.get("platform");
      const status = url.searchParams.get("status");
      const search = url.searchParams.get("search");

      let query = adminClient
        .from("ads_campaigns")
        .select("*")
        .order("created_at", { ascending: false });

      if (platform) query = query.eq("platform", platform);
      if (status) query = query.eq("status", status);
      if (search) query = query.ilike("campaign_name", `%${search}%`);

      const { data, error } = await query;
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    // POST /api/ads-campaigns
    if (req.method === "POST" && path === "ads-campaigns") {
      if (!isAdmin && !isAdsAdmin) return json({ error: "Forbidden" }, 403);
      let body;
      try { body = parseBody(createCampaignSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }

      const { data, error } = await adminClient
        .from("ads_campaigns")
        .insert({ campaign_name: body.campaign_name, platform: body.platform, budget: body.budget, notes: body.notes })
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Audit log
      await adminClient.from("ads_audit_logs").insert({
        campaign_id: data.id,
        action: "created",
        details: `Campaign "${body.campaign_name}" created on ${body.platform}`,
        performed_by: user.id,
      });

      return json(data);
    }

    // PATCH /api/ads-campaigns/:id
    if (req.method === "PATCH" && segments[0] === "ads-campaigns" && segments.length === 2) {
      if (!isAdmin && !isAdsAdmin) return json({ error: "Forbidden" }, 403);
      const campaignId = segments[1];
      const body = await req.json();

      const updates: Record<string, any> = {};
      if (body.campaign_name !== undefined) updates.campaign_name = body.campaign_name;
      if (body.platform !== undefined) updates.platform = body.platform;
      if (body.status !== undefined) updates.status = body.status;
      if (body.budget !== undefined) updates.budget = body.budget;
      if (body.notes !== undefined) updates.notes = body.notes;

      const { data, error } = await adminClient
        .from("ads_campaigns")
        .update(updates)
        .eq("id", campaignId)
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Audit log
      await adminClient.from("ads_audit_logs").insert({
        campaign_id: campaignId,
        action: "updated",
        details: `Updated fields: ${Object.keys(updates).join(", ")}`,
        performed_by: user.id,
      });

      return json(data);
    }

    // DELETE /api/ads-campaigns/:id
    if (req.method === "DELETE" && segments[0] === "ads-campaigns" && segments.length === 2) {
      if (!isAdmin && !isAdsAdmin) return json({ error: "Forbidden" }, 403);
      const campaignId = segments[1];

      // Audit log before delete
      await adminClient.from("ads_audit_logs").insert({
        campaign_id: campaignId,
        action: "deleted",
        details: `Campaign deleted`,
        performed_by: user.id,
      });

      const { error } = await adminClient.from("ads_campaigns").delete().eq("id", campaignId);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // GET /api/inbound-leads (admin only)
    if (req.method === "GET" && path === "inbound-leads") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const status = url.searchParams.get("status");
      let query = adminClient
        .from("inbound_leads")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (status && status !== "all") query = query.eq("status", status);
      const { data, error } = await query;
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // PATCH /api/inbound-leads/:id (admin only)
    if (req.method === "PATCH" && segments[0] === "inbound-leads" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const leadId = segments[1];
      const body = await req.json();
      const allowed: Record<string, boolean> = { status: true, name: true, phone: true, source: true };
      const updates: Record<string, any> = {};
      for (const [k, v] of Object.entries(body)) {
        if (allowed[k]) updates[k] = v;
      }
      if (Object.keys(updates).length === 0) return json({ error: "No valid fields" }, 400);
      const { error } = await adminClient.from("inbound_leads").update(updates).eq("id", leadId);
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Sync status to linked order
      if (updates.status) {
        const validOrderStatuses = ["pending", "take", "call_again", "confirmed", "shipped", "delivered", "returned", "paid", "trashed", "cancelled"];
        if (validOrderStatuses.includes(updates.status)) {
          await adminClient
            .from("orders")
            .update({ status: updates.status })
            .eq("inbound_lead_id", leadId);
        }
      }

      return json({ success: true });
    }

    // DELETE /api/inbound-leads/:id (admin only)
    if (req.method === "DELETE" && segments[0] === "inbound-leads" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const leadId = segments[1];
      const { error } = await adminClient.from("inbound_leads").delete().eq("id", leadId);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // ── WEBHOOKS CRUD (admin only) ──

    // GET /api/webhooks
    if (req.method === "GET" && path === "webhooks") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { data, error } = await adminClient
        .from("webhooks")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // POST /api/webhooks
    if (req.method === "POST" && path === "webhooks") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const body = await req.json();
      const productName = (body.product_name || "").trim();
      if (!productName || productName.length > 200) return json({ error: "Product name is required (max 200 chars)" }, 400);
      const description = (body.description || "").substring(0, 2000);

      const slug = productName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .substring(0, 60) + "-" + crypto.randomUUID().substring(0, 8);

      const { data, error } = await adminClient
        .from("webhooks")
        .insert({ product_name: productName, description, slug, created_by: user.id })
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      await audit(adminClient, user.id, user.email, "webhook.create", {
        target_type: "webhook",
        target_id: data.id,
        target_name: productName,
        payload: { slug, product_name: productName },
      });
      return json(data);
    }

    // PATCH /api/webhooks/:id
    if (req.method === "PATCH" && segments[0] === "webhooks" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const webhookId = segments[1];
      const body = await req.json();
      const updates: Record<string, any> = {};
      if (body.product_name !== undefined) updates.product_name = body.product_name.substring(0, 200);
      if (body.description !== undefined) updates.description = body.description.substring(0, 2000);
      if (body.status !== undefined && ["active", "disabled"].includes(body.status)) updates.status = body.status;
      if (Object.keys(updates).length === 0) return json({ error: "No valid fields" }, 400);

      const { data, error } = await adminClient
        .from("webhooks")
        .update(updates)
        .eq("id", webhookId)
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      await audit(adminClient, user.id, user.email, "webhook.update", {
        target_type: "webhook",
        target_id: webhookId,
        target_name: data?.product_name ?? null,
        payload: { updates },
      });
      return json(data);
    }

    // DELETE /api/webhooks/:id
    if (req.method === "DELETE" && segments[0] === "webhooks" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const webhookId = segments[1];

      const { data: existing } = await adminClient
        .from("webhooks")
        .select("product_name, slug")
        .eq("id", webhookId)
        .single();

      const { error } = await adminClient.from("webhooks").delete().eq("id", webhookId);
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      await audit(adminClient, user.id, user.email, "webhook.delete", {
        target_type: "webhook",
        target_id: webhookId,
        target_name: existing?.product_name ?? null,
        payload: existing ? { slug: existing.slug } : {},
      });
      return json({ success: true });
    }

    // ============================================================
    // SUPPLIERS
    // ============================================================

    // GET /api/suppliers
    if (req.method === "GET" && path === "suppliers") {
      const { data, error } = await supabase
        .from("suppliers")
        .select("*")
        .order("name");
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // POST /api/suppliers
    if (req.method === "POST" && path === "suppliers") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let body;
      try { body = parseBody(createSupplierSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }
      const { data, error } = await adminClient
        .from("suppliers")
        .insert(body)
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // PATCH /api/suppliers/:id
    if (req.method === "PATCH" && segments[0] === "suppliers" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const supplierId = segments[1];
      const body = await req.json();
      const updates: Record<string, any> = {};
      if (body.name !== undefined) updates.name = body.name;
      if (body.contact_info !== undefined) updates.contact_info = body.contact_info;
      if (body.email !== undefined) updates.email = body.email;
      if (body.phone !== undefined) updates.phone = body.phone;
      if (body.address !== undefined) updates.address = body.address;
      const { data, error } = await adminClient
        .from("suppliers")
        .update(updates)
        .eq("id", supplierId)
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // DELETE /api/suppliers/:id
    if (req.method === "DELETE" && segments[0] === "suppliers" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const supplierId = segments[1];
      const { error } = await adminClient.from("suppliers").delete().eq("id", supplierId);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ success: true });
    }

    // ============================================================
    // RESTOCK
    // ============================================================

    // POST /api/restock
    if (req.method === "POST" && path === "restock") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let body;
      try { body = parseBody(restockSchema, await req.json()); } catch (e: any) { return json({ error: e.message }, 400); }

      const { data: product } = await adminClient
        .from("products")
        .select("stock_quantity, name")
        .eq("id", body.product_id)
        .single();
      if (!product) return json({ error: "Product not found" }, 404);

      const newQty = product.stock_quantity + body.quantity;
      await adminClient.from("products").update({ stock_quantity: newQty }).eq("id", body.product_id);
      await adminClient.from("inventory_logs").insert({
        product_id: body.product_id,
        change_amount: body.quantity,
        previous_stock: product.stock_quantity,
        new_stock: newQty,
        reason: "restock",
        movement_type: "restock",
        user_id: user.id,
        supplier_name: body.supplier_name,
        invoice_number: body.invoice_number,
        notes: body.notes,
      });

      return json({ success: true, product_name: product.name, new_stock: newQty });
    }

    // GET /api/stock-movements (all movements across products)
    if (req.method === "GET" && path === "stock-movements") {
      const productId = url.searchParams.get("product_id");
      const movementType = url.searchParams.get("movement_type");
      const limit = parseInt(url.searchParams.get("limit") || "100");

      let query = adminClient
        .from("inventory_logs")
        .select("*, products:product_id(name, sku)")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (productId) query = query.eq("product_id", productId);
      if (movementType) query = query.eq("movement_type", movementType);

      const { data, error } = await query;
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Enrich with user names
      const userIds = [...new Set((data || []).map((d: any) => d.user_id).filter(Boolean))];
      const { data: profiles } = await adminClient
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", userIds.length > 0 ? userIds : ["__none__"]);
      const profileMap: Record<string, string> = {};
      for (const p of profiles || []) profileMap[p.user_id] = p.full_name;

      const enriched = (data || []).map((d: any) => ({
        ...d,
        user_name: profileMap[d.user_id] || "System",
        product_name: d.products?.name || "Unknown",
        product_sku: d.products?.sku || "",
      }));

      return json(enriched);
    }

    // GET /api/search-prediction?q=...
    if (req.method === "GET" && path === "search-prediction") {
      if (!checkUserRateLimit(user.id, "search-prediction", 60)) return json({ error: "Rate limit exceeded — slow down" }, 429);
      // sanitizeSearch strips , ( ) % _ \ — without it these break out of the
      // .or() filter string below and let a caller inject arbitrary PostgREST
      // predicates against orders/prediction_leads (adminClient bypasses RLS).
      // Matches the other search endpoints (see /search, /call-history).
      const q = sanitizeSearch((url.searchParams.get("q") || "").trim());
      if (!q) return json({ orders: [], leads: [], order_history: [] });

      // Normalize phone: extract last 8 digits for matching
      const digitsOnly = q.replace(/\D/g, "");
      const last8 = digitsOnly.length >= 8 ? digitsOnly.slice(-8) : "";

      // Build search: name OR phone (last 8 digits pattern)
      // For orders
      let orderQuery = adminClient
        .from("orders")
        .select("*, order_items(id, product_name, quantity, price_per_unit, total_price)")
        .order("created_at", { ascending: false })
        .limit(50);

      let leadQuery = adminClient
        .from("prediction_leads")
        .select("*, prediction_lists(name)")
        .order("created_at", { ascending: false })
        .limit(50);

      if (last8) {
        // Search by last 8 digits of phone OR name
        orderQuery = orderQuery.or(`customer_name.ilike.%${q}%,customer_phone.ilike.%${last8}%,display_id.ilike.%${q}%`);
        leadQuery = leadQuery.or(`name.ilike.%${q}%,telephone.ilike.%${last8}%`);
      } else {
        // Text-only search (name / display_id)
        orderQuery = orderQuery.or(`customer_name.ilike.%${q}%,display_id.ilike.%${q}%`);
        leadQuery = leadQuery.or(`name.ilike.%${q}%`);
      }
      // Agents work duplicates since 2026-08-13 — they must be able to FIND the
      // order they've been asked to settle, so there is no duplicated_from filter.

      const [ordersRes, leadsRes] = await Promise.all([orderQuery, leadQuery]);
      const orders = (ordersRes.data || []).map((o: any) => ({
        ...o,
        is_owned: isAdminOrManager || o.assigned_agent_id === user.id,
      }));
      const leads = (leadsRes.data || []).map((l: any) => ({
        ...l,
        is_owned: isAdminOrManager || l.assigned_agent_id === user.id,
      }));

      // Get order history for found orders
      const orderIds = orders.map((o: any) => o.id);
      let historyData: any[] = [];
      if (orderIds.length > 0) {
        const { data: history } = await adminClient
          .from("order_history")
          .select("*")
          .in("order_id", orderIds)
          .order("changed_at", { ascending: false });
        historyData = history || [];
      }

      return json({
        orders: redactCustomerList(orders, piiFlags),
        leads: redactCustomerList(leads, piiFlags, true),
        order_history: showOrderHistory ? historyData : [],
      });
    }

    // ══════════════════════════════════════════════════════════════
    // COURIER OFFICES — Speedy + Econt branch picker
    // ══════════════════════════════════════════════════════════════

    // GET /api/courier-offices/cities?courier=speedy|econt&q=<prefix>&limit=15
    // Distinct cities matching the prefix. Matching is on city_normalized
    // (lowercase Latin) so typing "С" / "S" / "со" / "so" all match София.
    if (req.method === "GET" && segments[0] === "courier-offices" && segments[1] === "cities") {
      const courier = url.searchParams.get("courier");
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "15"), 50);
      if (courier !== "speedy" && courier !== "econt" && courier !== "mex") return json({ error: "Invalid courier" }, 400);

      // Inline Cyrillic→Latin lowercaser (matches scripts/scrape-courier-offices.mjs)
      const CYR_TO_LAT: Record<string, string> = {
        'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ж':'zh','з':'z','и':'i',
        'й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s',
        'т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sht',
        'ъ':'a','ь':'y','ю':'yu','я':'ya',
        // Macedonian-only letters — absent from the Bulgarian original, so they used
        // to pass through unchanged and leave a mixed-script key. Keep in sync with
        // src/lib/transliterate.ts.
        'ѓ':'gj','ѕ':'dz','ј':'j','љ':'lj','њ':'nj','ќ':'kj','џ':'dzh','ѐ':'e','ѝ':'i',
      };
      const qNorm = q.split('').map(c => CYR_TO_LAT[c] ?? c).join('');

      // Pull all active rows for this courier (max ~1300) and aggregate.
      const all: any[] = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await adminClient
          .from("courier_offices")
          .select("city, city_normalized")
          .eq("courier", courier)
          .eq("is_active", true)
          .range(from, from + PAGE - 1);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < PAGE) break;
      }

      const seen = new Map<string, { city: string; count: number }>();
      for (const r of all) {
        const cityNorm = (r.city_normalized || '').toLowerCase();
        if (qNorm && !cityNorm.startsWith(qNorm)) continue;
        if (!seen.has(r.city)) seen.set(r.city, { city: r.city, count: 0 });
        seen.get(r.city)!.count++;
      }
      const cities = [...seen.values()]
        .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city, 'bg'))
        .slice(0, limit);
      return json(cities);
    }

    // GET /api/courier-offices?courier=speedy|econt&city=<exact>&limit=200
    // Offices in a specific city, sorted by office name.
    if (req.method === "GET" && path === "courier-offices") {
      const courier = url.searchParams.get("courier");
      const city = (url.searchParams.get("city") || "").trim();
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "200"), 500);
      if (courier !== "speedy" && courier !== "econt" && courier !== "mex") return json({ error: "Invalid courier" }, 400);
      if (!city) return json([]);
      const { data, error } = await adminClient
        .from("courier_offices")
        .select("office_code, name, address, hours, lat, lng, post_code")
        .eq("courier", courier)
        .eq("city", city)
        .eq("is_active", true)
        .order("name")
        .limit(limit);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    // GET /api/courier-offices/match?courier=&q=<freetext> — best-matching
    // offices for a legacy free-text courier address (e.g. "офис на Еконт- кв.
    // Бостанджиите, ул. Бели брези 21"). Tokenises the text, drops courier/
    // address-type stopwords, and ranks offices by how many distinctive tokens
    // appear in the office name + address. Lets the order modal auto-fill the
    // office that historical prose never stored a code for.
    if (req.method === "GET" && segments[0] === "courier-offices" && segments[1] === "match") {
      const courier = url.searchParams.get("courier");
      const q = (url.searchParams.get("q") || "").trim();
      if (courier !== "speedy" && courier !== "econt" && courier !== "mex") return json({ error: "Invalid courier" }, 400);
      if (!q) return json([]);

      const STOP = new Set([
        "офис", "офиса", "на", "до", "еконт", "econt", "спиди", "speedy", "еконтомат", "econtomat",
        "ул", "улица", "бул", "булевард", "пл", "площад", "кв", "квартал", "жк", "кк", "блок", "бл",
        "ет", "етаж", "ап", "апартамент", "вх", "вход", "гр", "град", "село", "обл", "област",
        "общ", "община", "номер", "near",
      ]);
      const tokens = q.toLowerCase()
        .replace(/[^a-zа-я0-9 ]/gi, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
      if (tokens.length === 0) return json([]);

      const orFilter = tokens.slice(0, 6)
        .flatMap((t) => [`name.ilike.%${t}%`, `address.ilike.%${t}%`])
        .join(",");
      const { data } = await adminClient
        .from("courier_offices")
        .select("office_code, name, city, address")
        .eq("courier", courier)
        .eq("is_active", true)
        .or(orFilter)
        .limit(100);

      const scored = (data || [])
        .map((o: any) => {
          const hay = `${o.name} ${o.address}`.toLowerCase();
          const score = tokens.reduce((s: number, t: string) => s + (hay.includes(t) ? 1 : 0), 0);
          return { ...o, score };
        })
        .filter((o: any) => o.score > 0)
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, 6);
      return json(scored);
    }

    // GET /api/courier-offices/by-code?courier=...&code=... — single office
    // for cases where we need to render the saved selection (e.g. OrderModal).
    if (req.method === "GET" && segments[0] === "courier-offices" && segments[1] === "by-code") {
      const courier = url.searchParams.get("courier");
      const code = url.searchParams.get("code");
      if (!courier || !code) return json({ error: "Missing courier or code" }, 400);
      const { data } = await adminClient
        .from("courier_offices")
        .select("office_code, name, city, address, hours, lat, lng, post_code")
        .eq("courier", courier)
        .eq("office_code", code)
        .maybeSingle();
      return json(data || null);
    }

    // ══════════════════════════════════════════════════════════════
    // SEGMENTS — admin/manager rule-driven customer lists
    // ══════════════════════════════════════════════════════════════

    // GET /api/segments — overview list with member counts
    if (req.method === "GET" && path === "segments") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      const { data: lists, error: listsErr } = await adminClient
        .from("prediction_segment_lists")
        .select("*")
        .order("display_order", { ascending: true });
      if (listsErr) return json({ error: sanitizeDbError(listsErr) }, 400);

      // Membership counts, as one GROUP BY. This used to stream the whole
      // prediction_segment_members table in 1000-row pages and tally in JS — 57
      // sequential round-trips at 56,807 rows, on an endpoint the Assigner polls
      // every 30s and Segments every 60s (~114 round-trips/min per admin).
      // COUNT/GROUP BY is arithmetically identical to that tally, so no displayed
      // number moves. See migration 20260910000000_report_count_rpcs.sql.
      // "open" = not done = what the operator counts as real work in a list;
      // "distributable" additionally has no agent — exactly the pool the
      // auto-assign 'unassigned' scope pulls, so badge and Distribute agree.
      const { data: countRows, error: countsErr } = await adminClient.rpc("segment_list_counts");
      if (countsErr) return json({ error: sanitizeDbError(countsErr) }, 400);
      const counts: Record<string, { total: number; assigned: number; completed: number; open: number; distributable: number }> = {};
      let engineDataAsOf: string | null = null;
      for (const r of countRows || []) {
        counts[r.list_id] = {
          total: r.total, assigned: r.assigned, completed: r.completed,
          open: r.open_count, distributable: r.distributable,
        };
        // Global max(updated_at), repeated on every row by the RPC — matches the
        // single shared variable the old loop maintained across all lists.
        if (r.engine_data_as_of && (!engineDataAsOf || r.engine_data_as_of > engineDataAsOf)) {
          engineDataAsOf = r.engine_data_as_of;
        }
      }

      // Managers (investors) see that lists EXIST but not how many people are in
      // them — counts come back null so the UI can render "Admin only".
      const enriched = (lists || []).map((l: any) => ({
        ...l,
        member_count: showSegmentMembers ? (counts[l.id]?.total ?? 0) : null,
        assigned_count: showSegmentMembers ? (counts[l.id]?.assigned ?? 0) : null,
        completed_count: showSegmentMembers ? (counts[l.id]?.completed ?? 0) : null,
        open_count: showSegmentMembers ? (counts[l.id]?.open ?? 0) : null,
        distributable_count: showSegmentMembers ? (counts[l.id]?.distributable ?? 0) : null,
        engine_data_as_of: engineDataAsOf,
      }));

      return json(enriched);
    }

    // ── Prediction Engine config (no-code list builder) ──────────────────────
    // The classifier's thresholds (recency day-bands, value brackets, frequency
    // tiers, Current Cancels / Never-Converted windows, and the package-based
    // "Due to Reorder" knobs) live in segment_engine_config and are read by the
    // v4 engine. Until cutover, edits only affect the SHADOW table (v4), never
    // the live v3.4 lists — so saving is safe and reversible.

    // GET /api/segments/engine-config — the active config + which engine is live
    if (req.method === "GET" && segments[0] === "segments" && segments[1] === "engine-config" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { data, error } = await adminClient
        .from("segment_engine_config")
        .select("id, version, config, active_engine, note, created_at")
        .eq("is_active", true)
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // GET /api/segments/engine-diff — live (v3.4) vs shadow (v4) counts + drift
    if (req.method === "GET" && segments[0] === "segments" && segments[1] === "engine-diff" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { data, error } = await adminClient.rpc("segment_engine_diff");
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // GET /api/segments/engine-controls — kill-switch + cron status for the dashboard
    if (req.method === "GET" && segments[0] === "segments" && segments[1] === "engine-controls" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { data, error } = await adminClient.rpc("segment_engine_controls_status");
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // POST /api/segments/shadow-engine — STOP/START the new preview (shadow) engine's
    // nightly job. Does NOT touch the live v3.4 engine or its 03:00 cron. Admin only.
    if (req.method === "POST" && segments[0] === "segments" && segments[1] === "shadow-engine" && segments.length === 2) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const enabled = body?.enabled === true;
      const { error } = await adminClient.rpc("set_shadow_engine", { _enabled: enabled });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      await adminClient.from("audit_log").insert({
        actor_id: user.id, actor_email: user.email,
        action: enabled ? "segment.shadow_engine_on" : "segment.shadow_engine_off",
        target_type: "segment_engine_config", target_id: null,
        target_name: enabled ? "preview engine ON" : "preview engine STOPPED",
        payload: { enabled },
      });
      return json({ shadow_enabled: enabled });
    }

    // POST /api/segments/recompute-shadow — rebuild the preview (shadow) now. Admin only.
    if (req.method === "POST" && segments[0] === "segments" && segments[1] === "recompute-shadow" && segments.length === 2) {
      if (!isAdmin) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "segments.recompute_shadow", 6)) return json({ error: "Rate limit exceeded — recompute is heavy; try again in a minute" }, 429);
      const { data, error } = await adminClient.rpc("recompute_all_segments_v4");
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ recomputed_customers: data });
    }

    // PUT /api/segments/engine-config — save a new config version (admin only).
    // Validates shape, writes a new version atomically, syncs list rows, recomputes
    // the shadow table, and returns the resulting live-vs-shadow diff (the preview).
    if (req.method === "PUT" && segments[0] === "segments" && segments[1] === "engine-config" && segments.length === 2) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      if (!checkUserRateLimit(user.id, "segments.engine_config", 6)) return json({ error: "Rate limit exceeded — engine recompute is heavy; try again in a minute" }, 429);
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const cfg = body?.config;
      const note: string = typeof body?.note === "string" ? body.note.slice(0, 500) : "";

      // ── Validate the config shape so a bad save can't break classification ──
      const errs: string[] = [];
      const isArr = (x: any) => Array.isArray(x);
      if (!cfg || typeof cfg !== "object") errs.push("config must be an object");
      else {
        const rb = cfg.recency_bands, vb = cfg.value_bands, fb = cfg.frequency_bands;
        if (!isArr(rb) || rb.length === 0) errs.push("recency_bands must be a non-empty array");
        if (!isArr(vb) || vb.length === 0) errs.push("value_bands must be a non-empty array");
        if (!isArr(fb) || fb.length === 0) errs.push("frequency_bands must be a non-empty array");
        if (isArr(rb)) {
          if (!rb.some((b: any) => b && (b.max_days === null || b.max_days === undefined))) {
            errs.push("recency_bands must end with an open-ended band (max_days: null)");
          }
          let prev = -Infinity;
          for (const b of rb) {
            if (!b || !b.label) { errs.push("every recency band needs a label"); break; }
            if (b.max_days !== null && b.max_days !== undefined) {
              if (typeof b.max_days !== "number" || b.max_days <= prev) { errs.push("recency band max_days must ascend"); break; }
              prev = b.max_days;
            }
          }
        }
        if (isArr(vb) && !vb.some((b: any) => b && (b.max_price === null || b.max_price === undefined))) {
          errs.push("value_bands must end with an open-ended band (max_price: null)");
        }
        if (isArr(fb)) {
          for (const b of fb) if (!b || !b.label || typeof b.min_count !== "number") { errs.push("every frequency band needs a label and numeric min_count"); break; }
        }
        if (cfg.windows == null || typeof cfg.windows !== "object") errs.push("windows object is required");
      }
      if (errs.length) return json({ error: "Invalid engine config", details: errs }, 400);

      const { data: ver, error: setErr } = await adminClient.rpc("set_segment_engine_config", {
        _config: cfg, _note: note, _actor: user.id,
      });
      if (setErr) return json({ error: sanitizeDbError(setErr) }, 400);

      const { data: diff } = await adminClient.rpc("segment_engine_diff");

      await adminClient.from("audit_log").insert({
        actor_id: user.id,
        actor_email: user.email,
        action: "segment.engine_config_update",
        target_type: "segment_engine_config",
        target_id: null,
        target_name: `engine config v${ver}`,
        payload: { version: ver, note },
      });

      return json({ version: ver, diff });
    }

    // POST /api/segments — create a new (standalone/informational) list. The
    // matrix calling-lists are created automatically by the config band editor;
    // this is for additive/informational lists the operator wants by hand.
    if (req.method === "POST" && path === "segments") {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const name: string = typeof body?.name === "string" ? body.name.trim() : "";
      if (!name) return json({ error: "name is required" }, 400);
      const category: string = ["value", "prestige", "cancel", "return", "other"].includes(body?.category) ? body.category : "other";
      const triggerEvent: string = ["last_paid", "last_cancelled", "last_returned", "last_trashed"].includes(body?.trigger_event) ? body.trigger_event : "last_paid";

      const { data, error } = await adminClient
        .from("prediction_segment_lists")
        .insert({
          name,
          description: typeof body?.description === "string" ? body.description : "",
          category,
          trigger_event: triggerEvent,
          is_static: body?.is_static === true,
          is_active: true,
          display_order: Number.isFinite(body?.display_order) ? body.display_order : 500,
        })
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      await adminClient.from("audit_log").insert({
        actor_id: user.id,
        actor_email: user.email,
        action: "segment.create",
        target_type: "prediction_segment_lists",
        target_id: data.id,
        target_name: name,
        payload: { category, trigger_event: triggerEvent, is_static: data.is_static },
      });
      return json(data, 201);
    }

    // DELETE /api/segments/:id — remove a list. Default = safe DEACTIVATE
    // (is_active=false, keeps history + assignments). ?hard=true hard-deletes,
    // but only when the list has no members (live or shadow) — otherwise refuse
    // and tell the operator to deactivate instead.
    if (req.method === "DELETE" && segments[0] === "segments" && segments.length === 2) {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      const listId = segments[1];
      const hard = url.searchParams.get("hard") === "true";

      const { data: list, error: listErr } = await adminClient
        .from("prediction_segment_lists")
        .select("id, name")
        .eq("id", listId)
        .single();
      if (listErr || !list) return json({ error: "Segment not found" }, 404);

      if (hard) {
        const { count: liveCount } = await adminClient
          .from("prediction_segment_members")
          .select("customer_phone", { count: "exact", head: true })
          .eq("list_id", listId);
        const { count: shadowCount } = await adminClient
          .from("prediction_segment_members_shadow")
          .select("customer_phone", { count: "exact", head: true })
          .eq("list_id", listId);
        if ((liveCount ?? 0) > 0 || (shadowCount ?? 0) > 0) {
          return json({ error: "List is not empty — deactivate it instead, or empty it first." }, 400);
        }
        const { error } = await adminClient.from("prediction_segment_lists").delete().eq("id", listId);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        await adminClient.from("audit_log").insert({
          actor_id: user.id, actor_email: user.email,
          action: "segment.delete", target_type: "prediction_segment_lists",
          target_id: listId, target_name: list.name, payload: { hard: true },
        });
        return json({ deleted: true });
      }

      const { error } = await adminClient
        .from("prediction_segment_lists")
        .update({ is_active: false })
        .eq("id", listId);
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      await adminClient.from("audit_log").insert({
        actor_id: user.id, actor_email: user.email,
        action: "segment.deactivate", target_type: "prediction_segment_lists",
        target_id: listId, target_name: list.name, payload: { hard: false },
      });
      return json({ deactivated: true });
    }

    // GET /api/segments/:id — list info + paginated members
    if (req.method === "GET" && segments[0] === "segments" && segments.length === 2 && segments[1] !== "recompute" && segments[1] !== "engine-config" && segments[1] !== "engine-diff" && segments[1] !== "engine-controls") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      // The PEOPLE inside a list are hidden from roles without segment-member access
      // (managers/investors). They can still see that lists exist via GET /segments.
      if (!showSegmentMembers) return json({ error: "Forbidden — segment members are admin-only" }, 403);
      const listId = segments[1];
      const page = parseInt(url.searchParams.get("page") || "1");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);
      const assignedFilter = url.searchParams.get("assigned"); // 'all' | 'none' | <agent_id>
      const completedFilter = url.searchParams.get("completed"); // 'all' | 'yes' | 'no'

      const { data: list, error: listErr } = await adminClient
        .from("prediction_segment_lists")
        .select("*")
        .eq("id", listId)
        .single();
      if (listErr || !list) return json({ error: "Segment not found" }, 404);

      let q = adminClient
        .from("prediction_segment_members")
        .select("*", { count: "exact" })
        .eq("list_id", listId)
        .order("trigger_event_at", { ascending: false })
        .range((page - 1) * limit, page * limit - 1);

      if (assignedFilter === "none") q = q.is("assigned_agent_id", null);
      else if (assignedFilter && assignedFilter !== "all") q = q.eq("assigned_agent_id", assignedFilter);

      if (completedFilter === "yes") q = q.eq("is_completed", true);
      else if (completedFilter === "no") q = q.eq("is_completed", false);

      const { data: members, count, error } = await q;
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Truth enrichment: latest REAL call per phone from call_logs (last-8
      // match via the bulk_last_calls RPC). Member rows are only stamped by the
      // queue/no-answer paths, so calls made via the order-confirmation flow or
      // standalone dialing would otherwise render "never". Best effort: an RPC
      // failure degrades to un-enriched rows, never an error.
      let enrichedMembers = members || [];
      const p8 = (s: string | null) => String(s || "").replace(/\D/g, "").slice(-8);
      const phone8s = [...new Set(enrichedMembers.map((m: any) => p8(m.customer_phone)).filter((x: string) => x.length >= 7))];
      if (phone8s.length > 0) {
        const { data: lastCalls, error: lcErr } = await adminClient.rpc("bulk_last_calls", { p8s: phone8s });
        if (!lcErr && lastCalls) {
          const byP8 = new Map<string, any>((lastCalls as any[]).map((r: any) => [r.phone8, r]));
          enrichedMembers = enrichedMembers.map((m: any) => {
            const lc = byP8.get(p8(m.customer_phone));
            return lc ? {
              ...m,
              real_last_call_at: lc.last_call_at,
              real_last_call_outcome: lc.outcome,
              real_last_call_connection: lc.connection_state,
            } : m;
          });
        }
      }

      return json({ list, members: enrichedMembers, total: count, page, limit });
    }

    // POST /api/segments/:id/assign — bulk-assign N members to an agent (or unassign)
    if (req.method === "POST" && segments[0] === "segments" && segments[2] === "assign") {
      if (!canViewModule("assigner")) return json({ error: "Forbidden" }, 403);
      const listId = segments[1];
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const memberPhones: string[] = Array.isArray(body?.member_phones) ? body.member_phones.slice(0, 5000) : [];
      const agentId: string | null = body?.agent_id || null;
      if (memberPhones.length === 0) return json({ error: "No members specified" }, 400);

      let agentName: string | null = null;
      if (agentId) {
        const { data: profile } = await adminClient
          .from("profiles")
          .select("full_name")
          .eq("user_id", agentId)
          .single();
        agentName = profile?.full_name || null;
      }

      const { error, count } = await adminClient
        .from("prediction_segment_members")
        .update({
          assigned_agent_id: agentId,
          assigned_agent_name: agentName,
          assigned_at: agentId ? new Date().toISOString() : null,
        }, { count: "exact" })
        .eq("list_id", listId)
        .in("customer_phone", memberPhones);
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Audit
      await adminClient.from("audit_log").insert({
        actor_id: user.id,
        actor_email: user.email,
        action: "segment.bulk_assign",
        target_type: "prediction_segment_members",
        target_id: listId,
        target_name: `${memberPhones.length} members → ${agentName || "Unassigned"}`,
        payload: { list_id: listId, agent_id: agentId, agent_name: agentName, count: memberPhones.length },
      });

      return json({ updated: count, agent_name: agentName });
    }

    // POST /api/segments/:id/auto-assign — distribute unassigned members across
    // 1+ agents. With 1 agent the whole (unassigned) list goes to them. With
    // 2+ agents the members are shuffled then chunked round-robin so each
    // agent gets ~equal share and no two agents see the same customer.
    // Body: { agent_ids: string[], scope?: 'unassigned' | 'all' }
    //   scope='unassigned' (default): only assign members where assigned_agent_id IS NULL
    //   scope='all': re-distribute every non-completed member, wiping current assignments
    if (req.method === "POST" && segments[0] === "segments" && segments[2] === "auto-assign") {
      if (!canViewModule("assigner")) return json({ error: "Forbidden" }, 403);
      const listId = segments[1];
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const agentIds: string[] = Array.isArray(body?.agent_ids) ? body.agent_ids.filter((x: any) => typeof x === "string") : [];
      const scope: "unassigned" | "all" = body?.scope === "all" ? "all" : "unassigned";
      if (agentIds.length === 0) return json({ error: "At least one agent_id is required" }, 400);

      // Denorm: cache full_name per agent so we set assigned_agent_name in the update.
      const { data: agentProfiles } = await adminClient
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", agentIds);
      const nameById = new Map((agentProfiles || []).map((p: any) => [p.user_id, p.full_name as string]));

      // Pull all eligible member phones for this list (paginated to dodge the
      // 1000-row PostgREST default — see CLAUDE.md "PostgREST 1000-row
      // truncation"). is_completed=false always; assigned_agent_id IS NULL
      // only when scope='unassigned'.
      const memberPhones: string[] = [];
      for (let from = 0; ; from += 1000) {
        let q = adminClient
          .from("prediction_segment_members")
          .select("customer_phone")
          .eq("list_id", listId)
          .eq("is_completed", false)
          .range(from, from + 999);
        if (scope === "unassigned") q = q.is("assigned_agent_id", null);
        const { data, error } = await q;
        if (error) return json({ error: sanitizeDbError(error) }, 400);
        if (!data || data.length === 0) break;
        for (const row of data) memberPhones.push(row.customer_phone);
        if (data.length < 1000) break;
      }

      if (memberPhones.length === 0) {
        return json({ distributed: 0, per_agent: {}, scope });
      }

      // Fisher-Yates shuffle so the assignment isn't sensitive to whatever
      // order the segment trigger inserted the rows in (e.g. high-value
      // customers wouldn't all land on one agent if the list happens to be
      // sorted by lifetime_value).
      for (let i = memberPhones.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [memberPhones[i], memberPhones[j]] = [memberPhones[j], memberPhones[i]];
      }

      // Optional partial distribution: `limit` (absolute count) or `fraction`
      // (0–1, e.g. 0.5 for half). Applied AFTER the shuffle so the slice is a
      // fair random sample, not the first-inserted rows. No cap = whole pool.
      const cap = body?.limit != null
        ? Math.floor(Number(body.limit))
        : body?.fraction != null
          ? Math.ceil(memberPhones.length * Number(body.fraction))
          : memberPhones.length;
      const pool = memberPhones.slice(0, Math.max(0, Math.min(cap, memberPhones.length)));

      if (pool.length === 0) {
        return json({ distributed: 0, per_agent: {}, scope });
      }

      // Round-robin chunk across agent_ids.
      const buckets: Record<string, string[]> = {};
      for (const aid of agentIds) buckets[aid] = [];
      pool.forEach((phone, i) => {
        buckets[agentIds[i % agentIds.length]].push(phone);
      });

      // Apply per-agent updates. .in() handles up to a few thousand values
      // per call comfortably; chunk if needed.
      const perAgent: Record<string, number> = {};
      const nowIso = new Date().toISOString();
      const CHUNK = 1000;
      for (const agentId of agentIds) {
        const phones = buckets[agentId];
        if (phones.length === 0) { perAgent[agentId] = 0; continue; }
        const agentName = nameById.get(agentId) || null;
        let total = 0;
        for (let i = 0; i < phones.length; i += CHUNK) {
          const slice = phones.slice(i, i + CHUNK);
          const { error, count } = await adminClient
            .from("prediction_segment_members")
            .update({
              assigned_agent_id: agentId,
              assigned_agent_name: agentName,
              assigned_at: nowIso,
            }, { count: "exact" })
            .eq("list_id", listId)
            .in("customer_phone", slice);
          if (error) return json({ error: sanitizeDbError(error) }, 400);
          total += count || 0;
        }
        perAgent[agentId] = total;
      }

      await adminClient.from("audit_log").insert({
        actor_id: user.id,
        actor_email: user.email,
        action: "segment.auto_assign",
        target_type: "prediction_segment_members",
        target_id: listId,
        target_name: `${pool.length} members → ${agentIds.length} agent${agentIds.length === 1 ? "" : "s"}`,
        payload: { list_id: listId, scope, agent_ids: agentIds, per_agent: perAgent, eligible: memberPhones.length, distributed: pool.length },
      });

      // One summary ping per agent who actually received members (never one-per-lead).
      for (const [aid, cnt] of Object.entries(perAgent)) {
        if (cnt > 0 && aid !== user.id) {
          await notifyUsers(adminClient, [aid], {
            type: "assignment",
            title: "New prediction leads assigned to you",
            message: `${cnt} new lead${cnt === 1 ? "" : "s"} assigned to you — open Prediction Leads to start calling.`,
            link: "/prediction-leads",
          });
        }
      }

      return json({ distributed: pool.length, per_agent: perAgent, scope, eligible: memberPhones.length });
    }

    // POST /api/segments/:id/bulk-unassign — clear assignment for a whole
    // list, or just one agent's slice of it. scope: 'all' | <agent_id>.
    if (req.method === "POST" && segments[0] === "segments" && segments[2] === "bulk-unassign") {
      if (!canViewModule("assigner")) return json({ error: "Forbidden" }, 403);
      const listId = segments[1];
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const scope: string = typeof body?.scope === "string" && body.scope.length > 0 ? body.scope : "all";

      let q = adminClient
        .from("prediction_segment_members")
        .update({ assigned_agent_id: null, assigned_agent_name: null, assigned_at: null }, { count: "exact" })
        .eq("list_id", listId)
        .not("assigned_agent_id", "is", null);
      if (scope !== "all") q = q.eq("assigned_agent_id", scope);
      const { error, count } = await q;
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      await adminClient.from("audit_log").insert({
        actor_id: user.id,
        actor_email: user.email,
        action: "segment.bulk_unassign",
        target_type: "prediction_segment_members",
        target_id: listId,
        target_name: `${count ?? 0} members unassigned (${scope === "all" ? "all" : "one agent"})`,
        payload: { list_id: listId, scope, unassigned: count ?? 0 },
      });

      return json({ unassigned: count ?? 0, scope });
    }

    // ── Assigner: cross-list assignment overview + mass unassign ──
    // The per-list bulk-unassign above only frees one list at a time, so taking
    // an agent off everything meant walking every list by hand. These two do it
    // in one shot, across every list.

    // GET /api/assigner/assignment-summary — who holds what, per agent per list.
    // One aggregate RPC instead of the old one-request-per-list probe loop.
    if (req.method === "GET" && path === "assigner/assignment-summary") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      const { data: matrix, error: matrixErr } = await adminClient.rpc("assignment_matrix");
      if (matrixErr) return json({ error: sanitizeDbError(matrixErr) }, 400);
      const rows = matrix || [];

      // Pendings are a parallel assignment system (orders.assigned_agent_id,
      // status='pending') the matrix knows nothing about — without this an
      // agent holding only leads was invisible in the Unassign tab.
      const { data: pendingCounts, error: pendErr } = await adminClient.rpc("assigned_pending_counts");
      if (pendErr) return json({ error: sanitizeDbError(pendErr) }, 400);
      const pendingRows = pendingCounts || [];

      const agentIds = [...new Set([
        ...rows.map((r: any) => r.agent_id),
        ...pendingRows.map((r: any) => r.agent_id),
      ].filter(Boolean))];
      const listIds = [...new Set(rows.map((r: any) => r.list_id).filter(Boolean))];

      let profileRows: any[] = [];
      if (agentIds.length > 0) {
        const { data } = await adminClient.from("profiles").select("user_id, full_name").in("user_id", agentIds);
        profileRows = data || [];
      }
      const nameById = new Map(profileRows.map((p: any) => [p.user_id, p.full_name as string]));

      let listRows: any[] = [];
      if (listIds.length > 0) {
        const { data } = await adminClient.from("prediction_segment_lists").select("id, name, display_order, is_active").in("id", listIds);
        listRows = data || [];
      }
      const listById = new Map(listRows.map((l: any) => [l.id, l]));

      type SummaryList = { list_id: string; list_name: string; display_order: number; is_active: boolean; assigned: number; open: number };
      type SummaryAgent = { agent_id: string; full_name: string; assigned_total: number; open_total: number; pendings_total: number; lists: SummaryList[] };
      const byAgent = new Map<string, SummaryAgent>();
      const agentEntry = (id: string): SummaryAgent => {
        let entry = byAgent.get(id);
        if (!entry) {
          entry = {
            agent_id: id,
            full_name: nameById.get(id) || "Unknown agent",
            assigned_total: 0,
            open_total: 0,
            pendings_total: 0,
            lists: [],
          };
          byAgent.set(id, entry);
        }
        return entry;
      };
      for (const r of rows) {
        const list = listById.get(r.list_id);
        const entry = agentEntry(r.agent_id);
        entry.assigned_total += r.members_assigned || 0;
        entry.open_total += r.members_open || 0;
        entry.lists.push({
          list_id: r.list_id,
          list_name: list?.name || "Removed list",
          display_order: list?.display_order ?? 999,
          is_active: list?.is_active ?? false,
          assigned: r.members_assigned || 0,
          open: r.members_open || 0,
        });
      }
      for (const r of pendingRows) {
        agentEntry(r.agent_id).pendings_total += r.pendings || 0;
      }

      const agentsOut = [...byAgent.values()]
        .map(a => ({ ...a, lists: a.lists.sort((x, y) => x.display_order - y.display_order) }))
        .sort((a, b) =>
          (b.open_total + b.pendings_total) - (a.open_total + a.pendings_total) ||
          a.full_name.localeCompare(b.full_name));

      return json({
        agents: agentsOut,
        totals: {
          agents: agentsOut.length,
          assigned_total: agentsOut.reduce((s, a) => s + a.assigned_total, 0),
          open_total: agentsOut.reduce((s, a) => s + a.open_total, 0),
          pendings_total: agentsOut.reduce((s, a) => s + a.pendings_total, 0),
        },
      });
    }

    // POST /api/assigner/unassign-all — free prediction members from one agent,
    // or from every agent, across ALL lists at once.
    // Body: { agent_id: 'all' | <uuid>, list_ids?: string[],
    //         include_pendings?: boolean, include_done?: boolean }
    // Default frees only NOT-yet-called members (is_completed=false) — done
    // members keep their agent stamp as the who-called-whom record.
    // include_done ALSO clears the stamp on done rows so the (agent, list)
    // pair fully detaches (operator decision 2026-07-28: an "empty" list must
    // not stay attached to an agent's profile). Call history is untouched —
    // is_completed / last_call_* / call_logs / sales credit all survive; only
    // the 3 assignment columns are nulled.
    // include_pendings also frees the agent's assigned status='pending' orders
    // (leads). Only 'pending' — take/call_again means the agent already engaged,
    // the orders-side mirror of the is_completed rule. Ignored when list_ids
    // narrows the call, because pendings are not list-scoped.
    if (req.method === "POST" && path === "assigner/unassign-all") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "assigner.unassign", 20)) {
        return json({ error: "Rate limit exceeded — try again in a minute" }, 429);
      }
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const agentId: string = typeof body?.agent_id === "string" && body.agent_id.length > 0 ? body.agent_id : "";
      if (!agentId) return json({ error: "agent_id required ('all' or a user id)" }, 400);
      const requestedLists: string[] = Array.isArray(body?.list_ids)
        ? body.list_ids.filter((x: any) => typeof x === "string" && x.length > 0)
        : [];
      const listIds: string[] | null = requestedLists.length > 0 ? requestedLists : null;
      const includePendings: boolean = body?.include_pendings === true && !listIds;
      const includeDone: boolean = body?.include_done === true;

      // Snapshot the breakdown BEFORE the wipe — after the update these numbers
      // are gone, and the audit row is the only record of what was released.
      const { data: matrix } = await adminClient.rpc("assignment_matrix");
      const affected = (matrix || []).filter((r: any) =>
        (agentId === "all" || r.agent_id === agentId) &&
        (!listIds || listIds.includes(r.list_id))
      );
      const perAgent: Record<string, number> = {};
      for (const r of affected) {
        const n = includeDone ? (r.members_assigned || 0) : (r.members_open || 0);
        perAgent[r.agent_id] = (perAgent[r.agent_id] || 0) + n;
      }
      const perAgentPendings: Record<string, number> = {};
      if (includePendings) {
        const { data: pendingCounts } = await adminClient.rpc("assigned_pending_counts");
        for (const r of pendingCounts || []) {
          if (agentId === "all" || r.agent_id === agentId) {
            perAgentPendings[r.agent_id] = r.pendings || 0;
          }
        }
      }

      let q = adminClient
        .from("prediction_segment_members")
        .update({ assigned_agent_id: null, assigned_agent_name: null, assigned_at: null }, { count: "exact" })
        .not("assigned_agent_id", "is", null);
      if (!includeDone) q = q.eq("is_completed", false);
      if (agentId !== "all") q = q.eq("assigned_agent_id", agentId);
      if (listIds) q = q.in("list_id", listIds);
      const { error, count } = await q;
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Free the agent's untouched pending leads too — same 4 columns
      // POST /orders/bulk-unassign nulls, scoped strictly to status='pending'.
      let pendingsUnassigned = 0;
      if (includePendings) {
        let pq = adminClient
          .from("orders")
          .update(
            { assigned_agent_id: null, assigned_agent_name: null, assigned_at: null, assigned_by: null },
            { count: "exact" },
          )
          .not("assigned_agent_id", "is", null)
          .eq("status", "pending");
        if (agentId !== "all") pq = pq.eq("assigned_agent_id", agentId);
        const { error: pendError, count: pendCount } = await pq;
        if (pendError) return json({ error: sanitizeDbError(pendError) }, 400);
        pendingsUnassigned = pendCount ?? 0;
      }

      const who = agentId === "all"
        ? `all agents (${Object.keys(perAgent).length})`
        : (await adminClient.from("profiles").select("full_name").eq("user_id", agentId).maybeSingle()).data?.full_name || agentId;

      await audit(adminClient, user.id, user.email, "assigner.unassign_all", {
        target_type: "prediction_segment_members",
        target_id: agentId,
        target_name: `${count ?? 0} clients${includePendings ? ` + ${pendingsUnassigned} pendings` : ""} freed from ${who}`,
        payload: {
          agent_id: agentId,
          list_ids: listIds,
          include_done: includeDone,
          unassigned: count ?? 0,
          per_agent: perAgent,
          ...(includePendings ? { pendings_unassigned: pendingsUnassigned, per_agent_pendings: perAgentPendings } : {}),
        },
      });

      return json({ unassigned: count ?? 0, pendings_unassigned: pendingsUnassigned, agent_id: agentId, per_agent: perAgent });
    }

    // PATCH /api/segments/:id — admin-only edit of rule parameters
    if (req.method === "PATCH" && segments[0] === "segments" && segments.length === 2) {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const listId = segments[1];
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const updates: Record<string, any> = {};
      const allowedKeys = [
        "name", "description", "is_active", "display_order",
        "recency_months_min", "recency_months_max",
        "single_price_min", "single_price_max",
        "min_paid_count", "lifetime_min",
      ];
      for (const k of allowedKeys) {
        if (body[k] !== undefined) updates[k] = body[k];
      }
      if (Object.keys(updates).length === 0) return json({ error: "No updates provided" }, 400);

      const { data, error } = await adminClient
        .from("prediction_segment_lists")
        .update(updates)
        .eq("id", listId)
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Edited rules → re-classify everyone so memberships reflect the new thresholds
      await adminClient.rpc("recompute_all_segments");

      await adminClient.from("audit_log").insert({
        actor_id: user.id,
        actor_email: user.email,
        action: "segment.update",
        target_type: "prediction_segment_lists",
        target_id: listId,
        target_name: data.name,
        payload: updates,
      });

      return json(data);
    }

    // POST /api/segments/recompute — admin/manager triggered classification refresh
    if (req.method === "POST" && segments[0] === "segments" && segments[1] === "recompute") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      if (!checkUserRateLimit(user.id, "segments.recompute", 6)) return json({ error: "Rate limit exceeded — recompute is heavy; try again in a minute" }, 429);
      const { data, error } = await adminClient.rpc("recompute_all_segments");
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json({ recomputed_customers: data });
    }

    // ══════════════════════════════════════════════════════════════
    // GET /api/customer-prefill?phone=... — one server-authorized bundle for the
    // Create/Confirm Order modal: the saved profile + the customer's recent
    // orders (with items). Looked up across ALL agents via adminClient (last-8
    // match, the CRM phone canon) so a front-line agent gets the customer's real
    // name/address even when the prior order was taken by someone else — the
    // RLS-scoped /orders search returns nothing for them (see resolveKnownCustomerName).
    // Returned UNREDACTED for order-creating roles: an agent literally cannot ship
    // an order without name/phone/address. Viewer-only roles keep the mask.
    if (req.method === "GET" && path === "customer-prefill") {
      const phone = (url.searchParams.get("phone") || "").trim();
      if (!phone) return json({ error: "phone required" }, 400);
      const last8 = phone.replace(/\D/g, "").slice(-8);
      if (last8.length < 8) return json({ profile: null, recent: [] });

      const [profRes, ordRes] = await Promise.all([
        adminClient.from("customer_profiles").select("*")
          .ilike("phone", `%${last8}`).order("updated_at", { ascending: false }).limit(1),
        adminClient.from("orders")
          .select("*, order_items(id, product_id, product_name, quantity, price_per_unit, total_price)")
          .ilike("customer_phone", `%${last8}`).order("created_at", { ascending: false }).limit(10),
      ]);
      const profile = profRes.data?.[0] || null;
      const recent = ordRes.data || [];

      if (canMutateOrders) return json({ profile, recent });
      // Viewer-only roles: keep masking consistent with the rest of the API.
      return json({
        profile: profile ? redactCustomer(profile, piiFlags) : null,
        recent: redactCustomerList(recent, piiFlags),
      });
    }

    // ══════════════════════════════════════════════════════════════
    // GET /api/customer-profile?phone=... — fetch the saved customer profile
    // (birthday / address / delivery prefs / notes) for pre-filling the order
    // modal. Returns null if none saved yet.
    if (req.method === "GET" && path === "customer-profile") {
      const phone = (url.searchParams.get("phone") || "").trim();
      if (!phone) return json({ error: "phone required" }, 400);
      const { data } = await adminClient
        .from("customer_profiles")
        .select("*")
        .eq("phone", phone)
        .maybeSingle();
      return json(data ? redactCustomer(data, piiFlags) : null);
    }

    // POST /api/customer-profile — upsert customer info by phone WITHOUT
    // creating an order. Any authenticated user (agents during a call) can do
    // this. Keyed on phone so re-saving updates the same row.
    if (req.method === "POST" && path === "customer-profile") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const phone = (body?.phone || "").trim();
      if (!phone) return json({ error: "phone required" }, 400);

      const payload = {
        phone,
        customer_name: body.customer_name ?? null,
        birthday: body.birthday || null,
        street: body.street ?? null,
        street_number: body.street_number ?? null,
        quarter: body.quarter ?? null,
        apartment: body.apartment ?? null,
        floor: body.floor ?? null,
        block: body.block ?? null,
        entry: body.entry ?? null,
        city: body.city ?? null,
        postal_code: body.postal_code ?? null,
        delivery_type: body.delivery_type ?? null,
        home_courier: body.home_courier ?? null,
        courier_office_code: body.courier_office_code ?? null,
        courier_office_name: body.courier_office_name ?? null,
        courier_office_city: body.courier_office_city ?? null,
        delivery_instructions: body.delivery_instructions ?? null,
        gift_note: body.gift_note ?? null,
        notes: body.notes ?? null,
        updated_by: user.id,
        updated_at: new Date().toISOString(),
      };

      const { data, error } = await adminClient
        .from("customer_profiles")
        .upsert(payload, { onConflict: "phone" })
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // POST /api/customer-profile/notes — save ONLY the free-form customer note,
    // keyed by phone. Unlike the full upsert above, the payload contains just
    // the notes column, so on conflict PostgREST updates only `notes` and leaves
    // birthday/address/delivery prefs intact. Used by the Calls-page notes board.
    if (req.method === "POST" && path === "customer-profile/notes") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const phone = (body?.phone || "").trim();
      if (!phone) return json({ error: "phone required" }, 400);

      const { data, error } = await adminClient
        .from("customer_profiles")
        .upsert(
          {
            phone,
            notes: body.notes ?? null,
            updated_by: user.id,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "phone" },
        )
        .select()
        .single();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data);
    }

    // GET /api/address/settlements?q= — type-ahead over the Macedonian
    // settlement reference (cities, towns, villages and Skopje's districts).
    //
    // Matches Cyrillic OR Latin, in either direction: the agent can type
    // "Ѓорче", "Gjorce" or "Gorce" and reach Ѓорче Петров. That is what
    // name_norm is for — normalizeMkGeo() folds both scripts, the diacritics
    // and the digraphs onto one key (see scripts/lib/mk-translit.mjs).
    //
    // Returns post_code so the form can fill it in automatically, and
    // mex_city_id so the caller knows the address is routable at all.
    if (req.method === "GET" && path === "address/settlements") {
      const q = (url.searchParams.get("q") || "").trim();
      if (q.length < 2) return json([]);
      // Sanitize before interpolating into .or() (same class as
      // search-prediction; geo data, so impact is low, but stay consistent).
      const lc = sanitizeSearch(q.toLowerCase());
      const norm = sanitizeSearch(normalizeMkGeo(q));
      if (lc.length < 2 && norm.length < 2) return json([]);

      const clauses = [`name_lc.ilike.${lc}%`, `name_lat.ilike.${lc}%`, `name_sq.ilike.${lc}%`];
      if (norm.length >= 2) clauses.push(`name_norm.ilike.${norm}%`);

      const { data } = await adminClient
        .from("mk_settlements")
        .select("id, name, name_lat, name_sq, post_code, region, municipality, kind, mex_city_id")
        .or(clauses.join(","))
        // Cities and towns first — an agent typing "Ко" wants Кочани before a
        // hamlet that happens to sort earlier alphabetically.
        .order("kind", { ascending: true })
        .order("name", { ascending: true })
        .limit(15);
      return json(data || []);
    }

    // GET /api/address/streets?settlement_id=&q=&kind= — streets, boulevards
    // and squares for a settlement.
    //
    // Served from mk_streets (OpenStreetMap, ODbL). This replaced a live call
    // to ECONT's Bulgarian nomenclature API — an outbound request to the
    // Bulgarian courier from the Macedonian deployment, which should never
    // have existed here.
    //
    // When the settlement is a city, its districts are unioned in: every Skopje
    // street belongs to a district (Центар, Аеродром, …), so an agent who picks
    // "Скопје" would otherwise see an empty list.
    if (req.method === "GET" && path === "address/streets") {
      const settlementId = (url.searchParams.get("settlement_id") || "").trim();
      const q = (url.searchParams.get("q") || "").trim();
      const kind = url.searchParams.get("kind");
      if (!settlementId) return json([]);

      const { data: children } = await adminClient
        .from("mk_settlements")
        .select("id")
        .eq("parent_id", settlementId);
      const ids = [settlementId, ...(children || []).map((c: { id: string }) => c.id)];

      let query = adminClient
        .from("mk_streets")
        .select("name, kind, name_norm")
        .in("settlement_id", ids);

      // The picker's Quarter field asks for kind=quarter; everything else is an
      // addressable way.
      if (kind === "quarter") query = query.eq("kind", "quarter");
      else if (kind === "street") query = query.in("kind", ["street", "boulevard", "square"]);

      if (q) {
        const lc = sanitizeSearch(q.toLowerCase());
        const norm = sanitizeSearch(normalizeMkGeo(q));
        const clauses: string[] = [];
        // Substring, not prefix: agents type the distinctive part of a name
        // ("Мисирков"), not the "ул. " it starts with.
        if (lc.length >= 2) clauses.push(`name_lc.ilike.%${lc}%`);
        if (norm.length >= 2) clauses.push(`name_norm.ilike.%${norm}%`);
        if (clauses.length) query = query.or(clauses.join(","));
      }

      // Over-fetch, then collapse. The same street is a separate row in each of
      // a city's districts (a Skopje boulevard runs through several), and OSM
      // sometimes carries a Latin spelling of a street as its own way. Both
      // would show up as repeated entries in the dropdown.
      //
      // Dedupe on name_norm — which folds script and diacritics — and keep the
      // Cyrillic spelling, since that is what goes on the parcel.
      const { data } = await query.order("name", { ascending: true }).limit(200);
      // Count Latin letters, not "does it contain Cyrillic" — every name starts
      // with a Cyrillic prefix ("ул. ", "бул. "), so a presence test rates
      // "ул. Krste Misirkov" as Cyrillic and can pick it over the real
      // "ул. Крсте Мисирков". Fewer Latin letters wins; the parcel gets the
      // Macedonian spelling.
      const latinCount = (s: string) => (s.match(/[A-Za-z]/g) || []).length;
      const best = new Map<string, string>();
      for (const r of (data || []) as Array<{ name: string; name_norm: string }>) {
        const key = r.name_norm || r.name.toLowerCase();
        const current = best.get(key);
        if (!current || latinCount(r.name) < latinCount(current)) best.set(key, r.name);
      }
      return json([...best.values()].sort((a, b) => a.localeCompare(b, "mk")).slice(0, 15));
    }

    // GET /api/customer-intelligence?phone=...
    // Returns customer history, timeline, lead quality score, and recommendations
    // ══════════════════════════════════════════════════════════════
    if (req.method === "GET" && path === "customer-intelligence") {
      const phone = (url.searchParams.get("phone") || "").trim();
      if (!phone) return json({ error: "Phone required" }, 400);
      // The intelligence dossier is customer-history + identity — hidden from roles
      // without order-history access (investor managers); agents keep it for calls.
      if (!showOrderHistory) return json({ found: false });

      // Normalize the search phone the same way the import does, then match
      // against multiple equivalent representations. Substring matching is
      // unsafe — it collapses unrelated customers who happen to share digit
      // sequences.
      const digitsOnly = phone.replace(/\D/g, "");
      if (digitsOnly.length < 7) return json({ found: false });

      // Build a small set of candidate canonical forms so we match regardless
      // of how the phone was originally stored.
      const candidates = new Set<string>();
      candidates.add(phone);                    // exactly as typed
      candidates.add(digitsOnly);               // digits only
      candidates.add("+" + digitsOnly);         // + prefix
      // Macedonia: 8 subscriber digits, national form 0 + 8 = 9, E.164 389 + 8 = 11.
      if (digitsOnly.length === 8) {
        candidates.add("+389" + digitsOnly);
        candidates.add("0" + digitsOnly);
      } else if (digitsOnly.length === 9 && digitsOnly.startsWith("0")) {
        candidates.add("+389" + digitsOnly.slice(1));
        candidates.add(digitsOnly.slice(1));
      } else if (digitsOnly.length === 11 && digitsOnly.startsWith("389")) {
        candidates.add("+" + digitsOnly);
        candidates.add(digitsOnly.slice(3));    // 8-digit local form
        candidates.add("0" + digitsOnly.slice(3));
      }

      const candidateList = [...candidates];

      // Find all orders matching any canonical form of this phone (exact match).
      // adminClient bypasses RLS. Duplicates are included for everyone since
      // 2026-08-13 — the dossier must show the copy the agent is settling.
      const ciOrderQuery = adminClient
        .from("orders")
        .select("id, display_id, status, price, product_name, customer_name, customer_phone, customer_city, customer_address, assigned_agent_name, created_at, source_type, order_items(id, product_name, quantity, price_per_unit, total_price)")
        .in("customer_phone", candidateList)
        .order("created_at", { ascending: false })
        .limit(100);
      const { data: orders } = await ciOrderQuery;

      // Find all prediction leads matching this phone
      const { data: leads } = await adminClient
        .from("prediction_leads")
        .select("id, name, telephone, status, product, created_at, assigned_agent_name, list_id, prediction_lists(name)")
        .in("telephone", candidateList)
        .order("created_at", { ascending: false })
        .limit(100);

      const allOrders = orders || [];
      const allLeads = leads || [];

      if (allOrders.length === 0 && allLeads.length === 0) {
        return json({ found: false });
      }

      // Stats
      const totalOrders = allOrders.length;
      const paidOrders = allOrders.filter((o: any) => o.status === "paid");
      const returnedOrders = allOrders.filter((o: any) => o.status === "returned");
      const shippedOrders = allOrders.filter((o: any) => o.status === "shipped");
      const confirmedOrders = allOrders.filter((o: any) => o.status === "confirmed");
      const lifetimeRevenue = paidOrders.reduce((sum: number, o: any) => sum + Number(o.price || 0), 0);

      // 21-day cooldown after a recent PAID order. This MUST mirror the segment
      // engine (recompute_customer_segments, hotfix 2026-06-03), which anchors the
      // cooldown on the ORDER DATE (created_at) of the customer's most recent PAID
      // order — NOT updated_at. updated_at is bumped by ANY later edit (re-save,
      // a segment recompute, an address change), which wrongly kept long-past
      // customers "in cooldown" even though the segment engine had already let
      // them out. paidOrders comes from allOrders (ordered created_at DESC), so
      // paidOrders[0] is the most recent paid order.
      let cooldownInfo = null;
      const lastPaidForCooldown = paidOrders[0];
      if (lastPaidForCooldown?.created_at) {
        const cooldownUntil = new Date(new Date(lastPaidForCooldown.created_at).getTime() + 21 * 24 * 60 * 60 * 1000);
        if (cooldownUntil > new Date()) {
          cooldownInfo = {
            is_in_cooldown: true,
            until: cooldownUntil.toISOString(),
            reason: "paid",
          };
        }
      }

      const lastOrder = allOrders[0] || null;

      // Timeline: build chronological events
      const orderIds = allOrders.map((o: any) => o.id);
      let historyData: any[] = [];
      if (orderIds.length > 0) {
        const { data: history } = await adminClient
          .from("order_history")
          .select("*")
          .in("order_id", orderIds)
          .order("changed_at", { ascending: false })
          .limit(200);
        historyData = history || [];
      }

      // Build timeline events
      const timeline: any[] = [];
      
      // Lead created events
      for (const l of allLeads) {
        timeline.push({
          type: "lead_created",
          date: l.created_at,
          agent: l.assigned_agent_name || null,
          details: `Lead created in ${(l as any).prediction_lists?.name || "list"}`,
        });
      }

      // Order events from history
      for (const h of historyData) {
        const order = allOrders.find((o: any) => o.id === h.order_id);
        timeline.push({
          type: `status_${h.to_status}`,
          date: h.changed_at,
          agent: h.changed_by_name || null,
          details: h.from_status 
            ? `${order?.display_id || ""}: ${h.from_status} → ${h.to_status}`
            : `${order?.display_id || ""}: ${h.to_status}`,
          from_status: h.from_status,
          to_status: h.to_status,
          order_display_id: order?.display_id,
        });
      }

      // Sort newest first
      timeline.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      // Lead quality score
      let qualityScore = "MEDIUM";
      let qualityReason = "";
      if (paidOrders.length >= 2 && returnedOrders.length === 0) {
        qualityScore = "HIGH";
        qualityReason = `${paidOrders.length} paid orders, no returns`;
      } else if (paidOrders.length >= 1 && returnedOrders.length === 0) {
        qualityScore = "HIGH";
        qualityReason = `${paidOrders.length} paid order(s), no returns`;
      } else if (returnedOrders.length > paidOrders.length) {
        qualityScore = "RISK";
        qualityReason = `${returnedOrders.length} returns vs ${paidOrders.length} paid`;
      } else if (returnedOrders.length > 0 && paidOrders.length > 0) {
        qualityScore = "MEDIUM";
        qualityReason = `${paidOrders.length} paid, ${returnedOrders.length} returned`;
      } else if (totalOrders === 0 && allLeads.length > 0) {
        qualityScore = "MEDIUM";
        qualityReason = "New lead, no order history";
      } else if (totalOrders > 0 && paidOrders.length === 0 && returnedOrders.length === 0) {
        qualityScore = "MEDIUM";
        qualityReason = `${totalOrders} orders, none paid yet`;
      }

      // Product recommendations: find frequently co-purchased products
      const productPairs: Record<string, number> = {};
      const currentProducts = new Set<string>();
      // Get product IDs from all order items
      for (const o of allOrders) {
        const items = o.order_items || [];
        for (const item of items) {
          if (item.product_name) currentProducts.add(item.product_name);
        }
      }

      // Find products often bought together across ALL orders
      const { data: coPurchaseOrders } = await adminClient
        .from("order_items")
        .select("order_id, product_id, product_name")
        .in("order_id", 
          // Get order_ids that contain any of the current products  
          allOrders.filter((o: any) => o.order_items?.length > 0).map((o: any) => o.id)
        )
        .limit(500);

      // Group by order to find co-purchased products
      const orderProductMap: Record<string, string[]> = {};
      for (const item of (coPurchaseOrders || [])) {
        if (!orderProductMap[item.order_id]) orderProductMap[item.order_id] = [];
        orderProductMap[item.order_id].push(item.product_name);
      }

      // Find products that appear in multi-product orders
      // Instead, query globally for popular add-ons
      const { data: popularProducts } = await adminClient
        .from("order_items")
        .select("product_id, product_name")
        .not("product_id", "is", null)
        .limit(1000);

      // Count product frequency
      const productFreq: Record<string, { name: string; id: string; count: number }> = {};
      for (const p of (popularProducts || [])) {
        if (!p.product_id) continue;
        if (!productFreq[p.product_id]) productFreq[p.product_id] = { name: p.product_name, id: p.product_id, count: 0 };
        productFreq[p.product_id].count++;
      }
      const recommendations = Object.values(productFreq)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map(p => ({ product_id: p.id, product_name: p.name, frequency: p.count }));

      // Past orders list — every paid order with line items and totals so
      // the OrderModal can show what the customer actually bought, not just
      // the count.
      const ordersHistory = allOrders.map((o: any) => ({
        id: o.id,
        display_id: o.display_id,
        status: o.status,
        date: o.created_at,
        agent: o.assigned_agent_name,
        price: Number(o.price || 0),
        source_type: o.source_type,
        items: (o.order_items || []).map((i: any) => ({
          product_name: i.product_name,
          quantity: i.quantity,
          price_per_unit: Number(i.price_per_unit || 0),
          total_price: Number(i.total_price || 0),
        })),
        // Cheap fallback when the order has no order_items rows (legacy
        // single-product layout).
        product_name_fallback: o.product_name,
      }));

      return json({
        found: true,
        stats: {
          total_orders: totalOrders,
          paid_orders: paidOrders.length,
          returned_orders: returnedOrders.length,
          shipped_orders: shippedOrders.length,
          confirmed_orders: confirmedOrders.length,
          lifetime_revenue: lifetimeRevenue,
          total_leads: allLeads.length,
        },
        last_order: lastOrder ? {
          display_id: lastOrder.display_id,
          product: lastOrder.order_items?.length > 0
            ? lastOrder.order_items.map((i: any) => i.product_name).join(", ")
            : lastOrder.product_name,
          status: lastOrder.status,
          date: lastOrder.created_at,
          agent: lastOrder.assigned_agent_name,
          price: lastOrder.price,
        } : null,
        orders_history: ordersHistory,
        quality_score: qualityScore,
        quality_reason: qualityReason,
        timeline: timeline.slice(0, 50),
        recommendations,
        customer_name: allOrders[0]?.customer_name || allLeads[0]?.name || "",
        cooldown: cooldownInfo,
      });
    }

    // ══════════════════════════════════════════════════════════════
    // GET /api/cooldown-clients
    // Admin only: list phones currently blocked by the 21-day global cooldown
    // (recent paid/confirmed/shipped/cancelled). Used by the "Cooldown Clients" button
    // in Prediction Lists UI.
    // ══════════════════════════════════════════════════════════════
    if (req.method === "GET" && path === "cooldown-clients") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      // Cooldown = 21 days after the ORDER DATE (created_at) of a customer's most
      // recent PAID order — mirrors recompute_customer_segments (hotfix 2026-06-03)
      // and the per-customer banner. Anchored on created_at, NOT updated_at, so a
      // later edit to an old order can't re-arm the cooldown.
      const since = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();

      // Paid orders placed in the last 21 days, newest first.
      const { data: recent } = await adminClient
        .from("orders")
        .select("customer_phone, created_at")
        .eq("status", "paid")
        .gte("created_at", since)
        .order("created_at", { ascending: false });

      // First occurrence per phone = that customer's most recent paid order.
      const seen = new Map<string, string>();
      for (const r of recent || []) {
        if (r.customer_phone && !seen.has(r.customer_phone)) seen.set(r.customer_phone, r.created_at);
      }
      const result = Array.from(seen.entries()).slice(0, 500).map(([phone, created_at]) => ({
        phone,
        last_status: "paid",
        last_at: created_at,
        cooldown_until: new Date(new Date(created_at).getTime() + 21 * 24 * 60 * 60 * 1000).toISOString(),
      }));

      return json({ clients: result, total: result.length });
    }

    // ══════════════════════════════════════════════════════════════
    // GET /api/management-insights
    // Admin/Manager only analytics
    // ══════════════════════════════════════════════════════════════
    if (req.method === "GET" && path === "management-insights") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      const fromRaw = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      // Pin bare dates to the operator's (Skopje) day — see skopjeRangeEnd.
      const from = DATE_ONLY_RE.test(fromRaw) ? skopjeMidnight(fromRaw) : fromRaw;
      const toEnd = DATE_ONLY_RE.test(to) ? skopjeRangeEnd(to) : (to ? to + "T23:59:59" : "");
      // Margin Lab: net-profit-per-package target the floor prices must clear (operator-tunable, €7 default).
      const marginTarget = Math.max(0, Number(url.searchParams.get("target")) || 7);

      // ── Engine switch ──
      // `legacy` streams every matching order (plus its order_items) into this
      // function and aggregates ~630 lines of JS over them — 65 sequential
      // round-trips and 28-42s at a 12-month range. `sql` does the same
      // arithmetic as GROUP BY and returns a few hundred rows instead of 70,000.
      //
      // ONLY the four O(n) row loops differ between the two. Every .sort(),
      // topN(), r2(), floorPriceFor(), pctl() and the final json({...}) literal
      // below is shared, so the response SHAPE cannot drift between engines —
      // the same code assembles it either way.
      //
      // Default comes from the INSIGHTS_ENGINE secret, so rollback is one
      // `supabase secrets set INSIGHTS_ENGINE=legacy` with no deploy, and
      // ?engine=legacy is a per-request escape hatch that needs nothing at all.
      const engine = url.searchParams.get("engine") || Deno.env.get("INSIGHTS_ENGINE") || "legacy";
      const useSql = engine === "sql";

      // Paginate past PostgREST's ~1000-row cap so every figure reflects ALL
      // matching rows, not the first page. (Same pattern as dashboard-stats.)
      const paginate = async (makeQuery: () => any, pageSize = 1000): Promise<any[]> => {
        const all: any[] = [];
        for (let f = 0; ; f += pageSize) {
          const { data, error } = await makeQuery().range(f, f + pageSize - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          all.push(...data);
          if (data.length < pageSize) break;
        }
        return all;
      };

      // Merge operator-name variants ("Елена Т." / "Елена Т" → "Елена"); blank → Unknown.
      const normAgent = (raw: any): string => {
        let n = String(raw || "").trim().replace(/\s+/g, " ");
        if (!n) return "Unknown operator";
        n = n.replace(/\s+\p{L}\.?$/u, "").trim(); // strip a trailing single-letter initial
        return n || "Unknown operator";
      };

      // top-N with an "Others" rollup to bound payload size.
      const topN = (rows: any[], valueKey: string, label: string, n = 20) => {
        // Tie-break on the label. sort() is stable, so equal values used to
        // resolve by insertion order — which came from an unordered paginate()
        // and was never deterministic run-to-run.
        const sorted = [...rows].sort((a, b) => Number(b[valueKey] || 0) - Number(a[valueKey] || 0)
          || String(a[label] ?? "").localeCompare(String(b[label] ?? "")));
        if (sorted.length <= n) return sorted;
        const head = sorted.slice(0, n);
        const rest = sorted.slice(n);
        const others: any = { [label]: "Others" };
        for (const r of rest) for (const k of Object.keys(r)) {
          if (k === label) continue;
          if (typeof r[k] === "number") others[k] = (others[k] || 0) + r[k];
        }
        return [...head, others];
      };

      // ── Fetch (paginated where it matters) ──
      // The SQL engine never materialises order rows — this is the 70,000-row,
      // 65-round-trip stream it exists to delete.
      const orders = useSql ? [] : await paginate(() => {
        let q = adminClient.from("orders").select(
          "id,status,price,quantity,product_name,customer_city,courier_office_city,delivery_type,home_courier,assigned_agent_name,confirmed_by_name,cancelled_by_agent_id,source_type,created_at,cancellation_reason,return_reason,prediction_list_id,prediction_list_name,prediction_list_type,prediction_list_category,order_items(product_name,quantity,total_price,price_per_unit)"
        ).or("source_type.is.null,source_type.neq.monadon_legacy"); // exclude Monadon legacy from all insights (profit, payouts, predictions ROI)
        if (from) q = q.gte("created_at", from);
        if (toEnd) q = q.lte("created_at", toEnd);
        return q;
      });
      // None of these five depend on each other, so they run concurrently
      // instead of nine serial waits. (`orders` above stays separate only
      // because it is by far the largest and starts first.)
      const [products, callLogs, invLogs, profiles, roleRowsRes] = await Promise.all([
        paginate(() => adminClient.from("products").select("id,name,stock_quantity,low_stock_threshold,cost_price,price,is_active")),
        // Both of these are rolled up by insights_calls_and_movement under the
        // SQL engine, so don't stream their rows as well.
        useSql ? Promise.resolve([] as any[]) : paginate(() => {
          let q = adminClient.from("call_logs").select("agent_id,outcome,connection_state,talk_seconds,total_seconds,started_at,created_at");
          if (from) q = q.gte("created_at", from);
          if (toEnd) q = q.lte("created_at", toEnd);
          return q;
        }),
        useSql ? Promise.resolve([] as any[]) : paginate(() => {
          let q = adminClient.from("inventory_logs").select("reason,change_amount,created_at");
          if (from) q = q.gte("created_at", from);
          if (toEnd) q = q.lte("created_at", toEnd);
          return q;
        }),
        paginate(() => adminClient.from("profiles").select("user_id,full_name")),
        // Who is a real AGENT (vs super-admin)? Commission is paid only to agents,
        // so a super-admin-confirmed order costs the business nothing in bonus.
        // A super-admin = anyone with admin OR manager role, and they earn €0 EVEN
        // IF they also hold an agent role (e.g. Miki, a founder who also confirms).
        adminClient.from("user_roles").select("user_id, role")
          .in("role", ["agent", "pending_agent", "prediction_agent", "admin", "manager"]),
      ]);
      const nameById: Record<string, string> = {};
      for (const p of profiles) nameById[p.user_id] = p.full_name;

      const roleRowsForPay = (roleRowsRes as any)?.data;
      const agentUserIds = new Set<string>();
      const superAdminIds = new Set<string>();
      for (const r of roleRowsForPay || []) {
        if (r.role === "admin" || r.role === "manager") superAdminIds.add(r.user_id);
        else agentUserIds.add(r.user_id);
      }
      const agentNames = new Set<string>();
      for (const p of profiles) {
        if (agentUserIds.has(p.user_id) && !superAdminIds.has(p.user_id)) agentNames.add(normAgent(p.full_name));
      }

      // Editable courier rate card (deliver / round-trip return per courier+service).
      const { rates: courierRates, fallback: courierFallback } = await loadCourierRates(adminClient);

      // ── SQL engine: one parallel batch of aggregates replaces the row stream ──
      // insights_paid_basis needs the rate card, so this runs after
      // loadCourierRates rather than inside the fetch batch above. The card is
      // PASSED IN rather than re-read in SQL, so loadCourierRates() stays the
      // single source of truth for money and the two can never disagree.
      const SQLROLL = { rollup: null as any, prods: null as any, paid: null as any, calls: null as any };
      if (useSql) {
        const ratesForSql: Record<string, any> = {};
        for (const [k, v] of Object.entries(courierRates)) {
          ratesForSql[k] = { deliver: (v as any).deliver, return: (v as any).return_ };
        }
        const argsRange = { p_from: from || null, p_to_end: toEnd || null };
        const [qRoll, qProd, qPaid, qCalls] = await Promise.all([
          adminClient.rpc("insights_orders_rollup", argsRange),
          adminClient.rpc("insights_products", argsRange),
          adminClient.rpc("insights_paid_basis", {
            ...argsRange, p_rates: ratesForSql, p_fallback_deliver: courierFallback.deliver,
          }),
          adminClient.rpc("insights_calls_and_movement", argsRange),
        ]);
        for (const [nm, q] of [["orders_rollup", qRoll], ["products", qProd],
                               ["paid_basis", qPaid], ["calls", qCalls]] as any[]) {
          if (q.error) return json({ error: `insights_${nm}: ${sanitizeDbError(q.error)}` }, 500);
        }
        SQLROLL.rollup = qRoll.data; SQLROLL.prods = qProd.data;
        SQLROLL.paid = qPaid.data; SQLROLL.calls = qCalls.data;
      }

      // Prediction-list payout is now attribution-gated (prediction_list_id on the
      // order), so management-insights no longer needs the special-agent role list.

      const PAID = (o: any) => o.status === "paid";
      // A "real order" = a lead that became an actual sale. Pending leads,
      // no-answer/call-again and cancelled/trashed rows are NOT orders.
      const REAL_ORDER = (o: any) => REAL_ORDER_STATUSES.includes(o.status);
      // "Sold" = a real order that hasn't come back. This — not just paid — is
      // what drives revenue/AOV/products/cities, because this is a COD business:
      // orders are confirmed & shipped today and paid days later, so a paid-only
      // view of "today" is always empty. Returned orders drop out of revenue.
      const SOLD = (o: any) => o.status === "confirmed" || o.status === "shipped" || o.status === "delivered" || o.status === "paid";
      // Attribute an order to whoever CONFIRMED it (stable across shipping),
      // falling back to the assigned agent for legacy rows without a confirmer.
      const ownerOf = (o: any) => normAgent(o.confirmed_by_name ?? o.assigned_agent_name);
      const num = (x: any) => Number(x || 0);
      const unitsOf = (o: any) => {
        const items = o.order_items || [];
        return items.length ? items.reduce((s: number, i: any) => s + num(i.quantity), 0) : num(o.quantity) || 1;
      };

      // === Pure Profit: Agent commission (per-package, every paid order) ===
      // Per operator spec (2026-06-04, clarified): per-package bonus on every PAID
      // order, tiered <25€→1 / 25–35€→2 / ≥35€→3, every package earns, no minimum,
      // no source/role gate. Uses the shared module-level calcAgentBonus so this
      // number can never diverge from /api/agent-performance. See elyon-agent-commissions.

      // ── Overview ──
      let paidRevenue = 0, paidCount = 0, unitsSold = 0, returnsValue = 0, pipelineValue = 0;
      let soldRevenue = 0, soldCount = 0; // revenue/AOV are sold-based (see SOLD above)
      const statusDist: Record<string, any> = {};
      const cityMap: Record<string, any> = {};
      const deliveryMap: Record<string, any> = {};
      const sourceMap: Record<string, any> = {};
      const prodMap: Record<string, any> = {};
      const agMap: Record<string, any> = {};
      const retReason: Record<string, any> = {};
      const retProduct: Record<string, any> = {};
      const retCity: Record<string, any> = {};
      const canReason: Record<string, any> = {};
      const canProduct: Record<string, any> = {};
      const trend: Record<string, any> = {};

      // Agent buckets exist only for meaningful outcomes: a real order
      // (credited to its confirmer), a cancellation (credited to whoever
      // cancelled), or a trash. Pending/take/call_again leads never create a
      // row, so unassigned pendings stop polluting the agents table.
      const bucket = (name: string) =>
        (agMap[name] ??= { name, orders: 0, sold: 0, paid: 0, returned: 0, cancelled: 0, trashed: 0, revenue: 0, units: 0 });

      // Choose trend granularity from the data span. (Reduce, not Math.min(...spread),
      // which would overflow the call stack on large arrays.)
      let minT = Infinity, maxT = -Infinity;
      for (const o of orders) {
        const t = new Date(o.created_at).getTime();
        if (isNaN(t)) continue;
        if (t < minT) minT = t;
        if (t > maxT) maxT = t;
      }
      if (!isFinite(minT)) { minT = Date.now(); maxT = Date.now(); }
      const spanDays = useSql ? Number(SQLROLL.rollup.span_days) : Math.max(1, (maxT - minT) / 86400000);
      const granularity = useSql
        ? SQLROLL.rollup.granularity
        : (spanDays <= 92 ? "day" : spanDays <= 400 ? "week" : "month");
      const bucketKey = (d: Date) => {
        if (granularity === "day") return d.toISOString().slice(0, 10);
        if (granularity === "month") return d.toISOString().slice(0, 7);
        const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() - day + 1);
        return t.toISOString().slice(0, 10);
      };

      for (const o of orders) {
        const s = o.status || "(none)";
        statusDist[s] ??= { status: s, count: 0, value: 0 };
        statusDist[s].count++; statusDist[s].value += num(o.price);

        const items = o.order_items || [];

        if (REAL_ORDER(o)) {
          const a = bucket(ownerOf(o));
          a.orders++;
          if (PAID(o)) a.paid++;
          if (o.status === "returned") a.returned++;
          if (SOLD(o)) { a.sold++; a.revenue += num(o.price); a.units += unitsOf(o); }   // revenue + packages (units) of orders sold
        }

        if (PAID(o)) {
          paidRevenue += num(o.price);
          paidCount++;
        }  // cash actually collected

        if (SOLD(o)) {
          soldRevenue += num(o.price); soldCount++; unitsSold += unitsOf(o);

          // trend (sold revenue over time)
          const bk = bucketKey(new Date(o.created_at));
          trend[bk] ??= { bucket: bk, revenue: 0, orders: 0 };
          trend[bk].revenue += num(o.price); trend[bk].orders++;

          // city / delivery / source (sold)
          const city = (o.customer_city || o.courier_office_city || "").trim() || "Unknown";
          cityMap[city] ??= { city, orders: 0, revenue: 0 };
          cityMap[city].orders++; cityMap[city].revenue += num(o.price);
          const dt = o.delivery_type || "home";
          deliveryMap[dt] ??= { delivery: dt, orders: 0, revenue: 0 };
          deliveryMap[dt].orders++; deliveryMap[dt].revenue += num(o.price);
          const src = o.source_type || "manual";
          sourceMap[src] ??= { source: src, orders: 0, revenue: 0 };
          sourceMap[src].orders++; sourceMap[src].revenue += num(o.price);

          // products (sold)
          if (items.length) {
            const seen = new Set();
            for (const it of items) {
              const p = it.product_name || "(unknown)";
              prodMap[p] ??= { product: p, units: 0, revenue: 0, orders: 0 };
              prodMap[p].units += num(it.quantity); prodMap[p].revenue += num(it.total_price);
              if (!seen.has(p)) { prodMap[p].orders++; seen.add(p); }
            }
          } else if (o.product_name) {
            const p = o.product_name;
            prodMap[p] ??= { product: p, units: 0, revenue: 0, orders: 0 };
            prodMap[p].units += num(o.quantity) || 1; prodMap[p].revenue += num(o.price); prodMap[p].orders++;
          }
        }

        if (o.status === "returned") {
          returnsValue += num(o.price);
          const rr = o.return_reason || "(unspecified)";
          retReason[rr] ??= { reason: rr, count: 0 }; retReason[rr].count++;
          const city = (o.customer_city || o.courier_office_city || "").trim() || "Unknown";
          retCity[city] ??= { city, count: 0 }; retCity[city].count++;
          const pns = items.length ? items.map((i: any) => i.product_name) : [o.product_name || "(unknown)"];
          for (const pn of pns) { retProduct[pn] ??= { product: pn, count: 0 }; retProduct[pn].count++; }
        }

        if (o.status === "cancelled") {
          // Credit whoever actually cancelled; fall back to confirmer/assigned
          // for legacy rows that predate cancelled_by_agent_id.
          const canceller = normAgent(nameById[o.cancelled_by_agent_id] ?? o.confirmed_by_name ?? o.assigned_agent_name);
          bucket(canceller).cancelled++;
          const cr = o.cancellation_reason || "(unspecified)";
          canReason[cr] ??= { reason: cr, count: 0 }; canReason[cr].count++;
          const pns = items.length ? items.map((i: any) => i.product_name) : [o.product_name || "(unknown)"];
          for (const pn of pns) { canProduct[pn] ??= { product: pn, count: 0 }; canProduct[pn].count++; }
        }

        if (o.status === "trashed") bucket(ownerOf(o)).trashed++;

        if (["confirmed", "shipped", "delivered"].includes(o.status)) pipelineValue += num(o.price);
      }

      // ── SQL engine: fill the very same maps the loop above builds ──
      // (`orders` is [] under the SQL engine, so that loop is a no-op and this
      // populates instead. Everything downstream is shared and untouched.)
      const payoutAgg: Record<string, { rev: number; bonus: number; pkgs: number; awaiting: number; ret: number }> = {};
      if (useSql) {
        const R = SQLROLL.rollup, P = SQLROLL.prods;
        const S = R.scalars;
        paidRevenue = num(S.paid_revenue); paidCount = S.paid_count;
        soldRevenue = num(S.sold_revenue); soldCount = S.sold_count;
        unitsSold = S.units_sold;
        returnsValue = num(S.returns_value); pipelineValue = num(S.pipeline_value);

        for (const r of R.status_distribution) statusDist[r.status] = { status: r.status, count: r.count, value: num(r.value) };
        for (const r of R.trend)       trend[r.bucket]   = { bucket: r.bucket, revenue: num(r.revenue), orders: r.orders };
        for (const r of R.by_city)     cityMap[r.city]   = { city: r.city, orders: r.orders, revenue: num(r.revenue) };
        for (const r of R.by_delivery) deliveryMap[r.delivery] = { delivery: r.delivery, orders: r.orders, revenue: num(r.revenue) };
        for (const r of R.by_source)   sourceMap[r.source] = { source: r.source, orders: r.orders, revenue: num(r.revenue) };
        for (const r of P.prod)        prodMap[r.product] = { product: r.product, units: r.units, revenue: num(r.revenue), orders: r.orders };
        for (const r of R.ret_reason)  retReason[r.reason] = { reason: r.reason, count: r.count };
        for (const r of R.ret_city)    retCity[r.city]     = { city: r.city, count: r.count };
        for (const r of P.ret_product) retProduct[r.product] = { product: r.product, count: r.count };
        for (const r of R.can_reason)  canReason[r.reason] = { reason: r.reason, count: r.count };
        for (const r of P.can_product) canProduct[r.product] = { product: r.product, count: r.count };

        // Agents arrive at RAW-name grain; normAgent merges here exactly as the
        // loop did. The payout key applies normAgent TWICE (ownerOf already
        // normalises) — reproduced verbatim, see the byPayoutKey note below.
        for (const r of R.agents) {
          // The legacy loop only ever calls bucket() for a REAL order or a
          // trashed one (cancels get their own canceller key below). SQL groups
          // ALL orders, so an owner with nothing but pending/call_again rows
          // would otherwise gain an all-zero agent row that legacy never had.
          if (r.orders === 0 && r.trashed === 0) continue;
          const a = bucket(normAgent(r.owner_raw));
          a.orders += r.orders; a.sold += r.sold; a.paid += r.paid;
          a.returned += r.returned; a.trashed += r.trashed;
          a.revenue += num(r.revenue); a.units += r.units;

          const pk = normAgent(normAgent(r.owner_raw));
          const p = (payoutAgg[pk] ??= { rev: 0, bonus: 0, pkgs: 0, awaiting: 0, ret: 0 });
          p.rev += num(r.paid_revenue); p.bonus += r.bonus_sum; p.pkgs += r.pkgs_paid;
          p.awaiting += r.pkgs_awaiting; p.ret += r.pkgs_returned;
        }
        for (const r of R.cancels) bucket(normAgent(r.canceller_raw)).cancelled += r.cancelled;
      }

      const returnedCount = statusDist["returned"]?.count || 0;
      const cancelledCount = statusDist["cancelled"]?.count || 0;
      const trashedCount = statusDist["trashed"]?.count || 0;
      const leadsPending = statusDist["pending"]?.count || 0;
      const realOrdersCount = useSql
        ? SQLROLL.rollup.scalars.real_orders_count
        : orders.filter(REAL_ORDER).length; // actual orders, not leads/cancels

      // Per-agent derived rates + merge call stats.
      const callByAgentName: Record<string, any> = {};
      let callsTotal = 0, callsAnswered = 0, talkTotal = 0;
      const byOutcome: Record<string, number> = {};
      for (const c of callLogs) {
        callsTotal++;
        const answered = c.connection_state === "answered" || (c.connection_state == null && num(c.talk_seconds) > 0);
        if (answered) callsAnswered++;
        talkTotal += num(c.talk_seconds);
        byOutcome[c.outcome || "(none)"] = (byOutcome[c.outcome || "(none)"] || 0) + 1;
        const an = normAgent(nameById[c.agent_id]);
        callByAgentName[an] ??= { calls: 0, answered: 0, talk_seconds: 0 };
        callByAgentName[an].calls++; if (answered) callByAgentName[an].answered++; callByAgentName[an].talk_seconds += num(c.talk_seconds);
      }
      if (useSql) {
        const C = SQLROLL.calls;
        callsTotal = C.total; callsAnswered = C.answered; talkTotal = Number(C.talk);
        for (const r of C.by_outcome) byOutcome[r.outcome] = r.count;
        for (const r of C.by_agent) {
          // Same key as the loop: normAgent of the profile name, so several
          // agent_ids collapsing to one operator name merge, exactly as before.
          const an = normAgent(nameById[r.agent_id]);
          const e = (callByAgentName[an] ??= { calls: 0, answered: 0, talk_seconds: 0 });
          e.calls += r.calls; e.answered += r.answered; e.talk_seconds += Number(r.talk_seconds);
        }
      }

      // Bucket the real orders by payout key ONCE. This was three full
      // orders.filter() scans PER AGENT — O(agents × orders) — and each predicate
      // evaluated normAgent twice per order (a Unicode regex), so ~29 operators
      // over a 12-month range meant millions of regex executions per request.
      //
      // ⚠️ The key is normAgent(ownerOf(o)) — normAgent applied TWICE, because
      // ownerOf() already normalises. normAgent is NOT idempotent: "Ана М Б" →
      // "Ана М" → "Ана". So an agent whose name has 3+ tokens ending in a single
      // letter is bucketed under a key that never matches a.name, and reads 0 for
      // payout/packages while their revenue is fine. Reproduced verbatim on
      // purpose — fixing it moves real payout figures and must be its own
      // reviewed change. No current operator name triggers it (verified against
      // all 29 names carrying paid orders, 2026-08-05).
      const byPayoutKey: Record<string, any[]> = {};
      for (const o of orders) {
        if (!REAL_ORDER(o)) continue;
        (byPayoutKey[normAgent(ownerOf(o))] ??= []).push(o);
      }
      // Reduce the legacy buckets to the same shape the SQL engine returns, so
      // perAgent below is engine-agnostic. Every one of the three old filters
      // also required REAL_ORDER, so the bucket IS
      // `orders.filter(REAL_ORDER && key === a.name)`; and packagesSoldOf /
      // packagesAwaitingOf / packagesReturnedOf each re-filter by status
      // internally, so handing them the whole bucket is identical.
      for (const [k, list] of Object.entries(byPayoutKey)) {
        const paidList = list.filter(PAID);
        payoutAgg[k] = {
          rev: paidList.reduce((s: number, o: any) => s + num(o.price), 0),
          bonus: calcAgentBonus(paidList),
          pkgs: packagesSoldOf(paidList),
          awaiting: packagesAwaitingOf(list),
          ret: packagesReturnedOf(list),
        };
      }

      const perAgent = Object.values(agMap).map((a: any) => {
        const cs = callByAgentName[a.name] || { calls: 0, answered: 0, talk_seconds: 0 };

        const P = payoutAgg[a.name] || { rev: 0, bonus: 0, pkgs: 0, awaiting: 0, ret: 0 };
        // Super-admins earn no bonus — only real agents are on commission.
        // calcAgentBonus already rounded in the legacy path; the SQL sum is
        // integer-valued (rate ∈ {1,2,3} × integer quantity), so both are exact.
        const agentPayout = agentNames.has(a.name) ? P.bonus : 0;
        // packages_sold = PAID units only (aligns with payout). a.units stays pipeline SOLD.
        const packagesSoldPaid = P.pkgs;
        const packagesAwaiting = P.awaiting;
        const packagesReturned = P.ret;

        return {
          ...a,
          aov: a.sold > 0 ? a.revenue / a.sold : 0,
          // Pipeline avg/pkg (SOLD basis) for analytics; packages_sold is paid-only.
          avg_per_package: packagesSoldPaid > 0
            ? (a.paid > 0 ? (P.rev / packagesSoldPaid) : 0)
            : (a.units > 0 ? a.revenue / a.units : 0),
          packages_sold: packagesSoldPaid,
          packages_awaiting: packagesAwaiting,
          packages_returned: packagesReturned,
          // Of the decisions this agent reached (orders vs. cancels), what share cancelled.
          cancel_rate: (a.orders + a.cancelled) > 0 ? a.cancelled / (a.orders + a.cancelled) : 0,
          // Of this agent's orders, what share came back.
          return_rate: a.orders > 0 ? a.returned / a.orders : 0,
          calls: cs.calls, answered: cs.answered,
          answer_rate: cs.calls > 0 ? cs.answered / cs.calls : 0,
          talk_seconds: cs.talk_seconds,
          payout_earned: agentPayout,
        };
      }).sort((a: any, b: any) => b.revenue - a.revenue || String(a.name).localeCompare(String(b.name)));

      // Total agent commission actually owed (a Pure Profit cost): every paid
      // order, but only those owned by a real agent — super-admins earn nothing.
      // NB this gates on normAgent applied ONCE (ownerOf), unlike the payout
      // buckets above which apply it twice — which is why
      // Σ agents[].payout_earned need not equal this total.
      const totalSpecialAgentCommissions = Math.round(
        (useSql
          ? SQLROLL.rollup.agents.reduce(
              (s: number, r: any) => s + (agentNames.has(normAgent(r.owner_raw)) ? r.bonus_sum : 0), 0)
          : orders.reduce((s: number, o: any) => s + (agentNames.has(ownerOf(o)) ? orderPackageBonus(o) : 0), 0)
        ) * 100,
      ) / 100;

      // ── Prediction Lists ROI ──
      // "Which list generated how much money." Order-derived metrics come from the
      // attribution snapshot (prediction_list_id), so they are exact and survive a
      // list being renamed/deleted (we group by the snapshot name). Membership is
      // enriched from the live segment/lead tables. Returned = refund (this is a
      // COD business — a returned order is money that came back).
      const plMap: Record<string, any> = {};
      const plRow = (id: string, name: string, type: string | null, category: string | null) =>
        (plMap[id] ??= {
          list_id: id, name: name || "(unnamed list)", type: type || "segment", category: category || null,
          orders: 0, confirmed: 0, paid: 0, returned: 0, cancelled: 0,
          revenue: 0, refund_value: 0, bonus_paid: 0, members: 0,
        });
      for (const o of orders) {
        if (!o.prediction_list_id) continue;
        const r = plRow(o.prediction_list_id, o.prediction_list_name, o.prediction_list_type, o.prediction_list_category);
        r.orders++;
        if (REAL_ORDER(o)) r.confirmed++;
        if (PAID(o)) r.paid++;
        if (o.status === "returned") { r.returned++; r.refund_value += num(o.price); }
        if (o.status === "cancelled") r.cancelled++;
        if (SOLD(o)) r.revenue += num(o.price);
        if (agentNames.has(ownerOf(o))) r.bonus_paid += orderPackageBonus(o);
      }
      if (useSql) {
        // Rows arrive at (list × raw owner) grain so the agentNames gate on
        // bonus_paid can be applied here, exactly as the loop does.
        for (const r of SQLROLL.rollup.prediction) {
          const row = plRow(r.list_id, r.name, r.type, r.category);
          row.orders += r.orders; row.confirmed += r.confirmed; row.paid += r.paid;
          row.returned += r.returned; row.cancelled += r.cancelled;
          row.revenue += num(r.revenue); row.refund_value += num(r.refund_value);
          if (agentNames.has(normAgent(r.owner_raw))) row.bonus_paid += r.bonus_sum;
        }
      }
      // Enrich with current membership counts (segment members + uploaded leads).
      // One GROUP BY instead of streaming both tables in full. The old code paid
      // ~57 sequential round-trips over 56,807 membership rows on EVERY insights
      // request — including Pure Profit, which never displays these counts — and
      // ignored the date range while doing it. Skip entirely when no order in
      // range carries a prediction-list attribution.
      const memberCounts: Record<string, number> = {};
      if (Object.keys(plMap).length) {
        try {
          const { data: memberRows } = await adminClient.rpc("prediction_list_member_counts");
          for (const r of memberRows || []) memberCounts[r.list_id] = r.members;
        } catch (_e) { /* membership enrichment is best-effort */ }
      }
      const predictionLists = Object.values(plMap).map((r: any) => ({
        ...r,
        members: memberCounts[r.list_id] || 0,
        net_revenue: Math.round((r.revenue - r.refund_value) * 100) / 100,
        revenue: Math.round(r.revenue * 100) / 100,
        refund_value: Math.round(r.refund_value * 100) / 100,
        bonus_paid: Math.round(r.bonus_paid * 100) / 100,
        conversion_rate: r.orders > 0 ? r.paid / r.orders : 0,
        return_rate: r.confirmed > 0 ? r.returned / r.confirmed : 0,
      })).sort((a: any, b: any) => b.revenue - a.revenue || String(a.name).localeCompare(String(b.name)));

      // ── Products & stock ──
      const stock = products.filter((p: any) => p.is_active).map((p: any) => {
        const sold = prodMap[p.name]?.units || 0;
        const sq = num(p.stock_quantity);
        const state = sq <= 0 ? "out" : sq <= num(p.low_stock_threshold) ? "low" : "ok";
        const daily = sold / spanDays;
        return {
          name: p.name, stock_quantity: sq, low_stock_threshold: num(p.low_stock_threshold),
          state, units_sold: sold,
          days_of_cover: daily > 0 ? Math.round(sq / daily) : null,
          cost_price: num(p.cost_price), price: num(p.price),
        };
      }).sort((a: any, b: any) => a.stock_quantity - b.stock_quantity || String(a.name).localeCompare(String(b.name)));

      // ── Profit (only where cost is known) ──
      const costByName: Record<string, number> = {};
      for (const p of products) if (num(p.cost_price) > 0) costByName[p.name] = num(p.cost_price);
      const profitRows = Object.values(prodMap)
        .filter((p: any) => costByName[p.product] != null)
        .map((p: any) => {
          const cogs = costByName[p.product] * p.units;
          return { product: p.product, revenue: p.revenue, cogs, profit: p.revenue - cogs, margin: p.revenue > 0 ? (p.revenue - cogs) / p.revenue : 0 };
        }).sort((a: any, b: any) => b.profit - a.profit || String(a.product).localeCompare(String(b.product)));

      // ── Logistics cost + actuals Pure Profit ──
      // Money OUT for shipping: deliver rate on everything shipped, full round-trip
      // loss on every return. COGS is booked on PAID orders only (returned stock
      // comes back to inventory, so only the shipping is lost). Revenue = cash
      // actually collected (paidRevenue). Also split spend by courier so the
      // operator can see "which orders went by what".
      const r2 = (n: number) => Math.round(n * 100) / 100;
      const costOfName = (_pid: any, name: any) => costByName[name] || 0;
      let deliveryCost = 0, returnLoss = 0, cogsPaid = 0, paidPackages = 0;
      const logisticsMap: Record<string, any> = {};
      // Margin Lab: realized price of every paid package (for distribution stats).
      const realizedPkg: number[] = [];
      // Per-product breakdown on the PAID (cash) basis, so the COGS column sums
      // to pure_profit.cogs. Tracks packages (units), distinct orders, revenue & cost.
      // deliverSum accumulates each line's amortized delivery share (Margin Lab floor).
      const paidProdMap: Record<string, any> = {};
      const addPaidProduct = (orderId: string, name: string, qty: number, revenue: number, deliverShare = 0) => {
        const m = (paidProdMap[name] ??= { product: name, packages: 0, orders: 0, revenue: 0, cogs: 0, deliverSum: 0, _seen: new Set<string>() });
        m.packages += qty;
        m.revenue += revenue;
        m.cogs += (costByName[name] || 0) * qty;
        m.deliverSum += deliverShare * qty;
        if (!m._seen.has(orderId)) { m.orders++; m._seen.add(orderId); }
      };
      for (const o of orders) {
        const st = o.status;
        const shipped = st === "shipped" || st === "delivered" || st === "paid";
        const returned = st === "returned";
        if (shipped || returned) {
          const cs = resolveCourierService(o);
          const rate = (cs && courierRates[`${cs.courier}_${cs.service}`]) || courierFallback;
          const label = cs ? `${cs.courier}_${cs.service}` : "unknown";
          const L = (logisticsMap[label] ??= {
            courier: cs?.courier ?? "unknown", service: cs?.service ?? "—",
            delivered: 0, returned: 0, deliver_cost: 0, return_cost: 0,
          });
          if (returned) { returnLoss += rate.return_; L.returned++; L.return_cost += rate.return_; }
          else { deliveryCost += rate.deliver; L.delivered++; L.deliver_cost += rate.deliver; }
        }
        if (PAID(o)) {
          cogsPaid += orderCOGS(o, costOfName);
          const items = o.order_items || [];
          const price = num(o.price); // orders.price is the cash source of truth
          // One delivery is paid per ORDER, so amortize it across the order's packages
          // (Margin Lab: bigger bundle ⇒ smaller per-package delivery ⇒ lower floor).
          const csP = resolveCourierService(o);
          const deliverRateP = (csP && courierRates[`${csP.courier}_${csP.service}`]?.deliver) ?? courierFallback.deliver;
          if (items.length) {
            // Distribute the order's locked price across its items by the best
            // available price signal (item totals are often 0 on these rows),
            // so Σ per-product revenue == cash collected.
            const w = items.map((it: any) => {
              const ppu = num(it.price_per_unit), tp = num(it.total_price), q = num(it.quantity) || 1;
              return ppu > 0 ? ppu * q : tp > 0 ? tp : q;
            });
            const tot = w.reduce((s: number, x: number) => s + x, 0) || 1;
            const orderPkgs = items.reduce((s: number, it: any) => s + num(it.quantity), 0) || 1;
            const deliverShare = deliverRateP / orderPkgs;
            items.forEach((it: any, i: number) => {
              const q = num(it.quantity);
              paidPackages += q;
              const lineRev = price * (w[i] / tot);
              addPaidProduct(o.id, it.product_name || "(unknown)", q, lineRev, deliverShare);
              const unit = q > 0 ? lineRev / q : 0;
              for (let k = 0; k < q; k++) realizedPkg.push(unit);
            });
          } else if (o.product_name) {
            const q = num(o.quantity) || 1;
            paidPackages += q;
            addPaidProduct(o.id, o.product_name, q, price, deliverRateP / q);
            const unit = q > 0 ? price / q : 0;
            for (let k = 0; k < q; k++) realizedPkg.push(unit);
          }
        }
      }
      if (useSql) {
        const B = SQLROLL.paid;
        // Logistics: SQL returns per courier+service COUNTS; the editable rate
        // card is applied here so loadCourierRates() remains the only place
        // money comes from. Accumulate rate-by-rate (not rate × count) so the
        // float addition order matches the legacy loop exactly.
        for (const L of SQLROLL.rollup.logistics) {
          const rate = (L.known && courierRates[`${L.courier}_${L.service}`]) || courierFallback;
          const label = L.known ? `${L.courier}_${L.service}` : "unknown";
          const M = (logisticsMap[label] ??= {
            courier: L.courier, service: L.service,
            delivered: 0, returned: 0, deliver_cost: 0, return_cost: 0,
          });
          M.delivered += L.delivered; M.returned += L.returned;
          for (let k = 0; k < L.delivered; k++) { deliveryCost += rate.deliver; M.deliver_cost += rate.deliver; }
          for (let k = 0; k < L.returned;  k++) { returnLoss   += rate.return_; M.return_cost  += rate.return_; }
        }
        // COGS keys on the RAW product name with (quantity || 1) units — a
        // different key and unit count than by_product below, which is why the
        // RPC returns cogs_units separately. Preserves the existing (real)
        // discrepancy between pure_profit.cogs and Σ by_product.cogs.
        for (const r of B.cogs_units) cogsPaid += (costByName[r.raw_product] || 0) * r.cogs_units;
        paidPackages = B.paid_packages;
        for (const m of B.by_product) {
          paidProdMap[m.product] = {
            product: m.product, packages: m.packages, orders: m.orders,
            revenue: num(m.revenue), cogs: (costByName[m.product] || 0) * m.packages,
            deliverSum: num(m.deliver_sum), _seen: new Set<string>(),
          };
        }
      }
      deliveryCost = r2(deliveryCost); returnLoss = r2(returnLoss); cogsPaid = r2(cogsPaid);
      // VAT owed on collected cash (prices are gross / VAT-inclusive).
      const vatDue = r2(paidRevenue - paidRevenue / (1 + VAT_RATE));
      const clearProfit = r2(paidRevenue - vatDue - cogsPaid - totalSpecialAgentCommissions - deliveryCost - returnLoss);
      // Cost coverage: how much of what sold has a known cost_price. Products
      // without one count €0 COGS (never invent a cost) — surface the gap instead.
      let knownCostPackages = 0;
      const productsMissingCost: string[] = [];
      for (const m of Object.values(paidProdMap) as any[]) {
        if (costByName[m.product] != null) knownCostPackages += m.packages;
        else productsMissingCost.push(m.product);
      }
      productsMissingCost.sort();
      const costCoverage = paidPackages > 0 ? Math.round((knownCostPackages / paidPackages) * 10000) / 10000 : 1;
      const logistics = Object.values(logisticsMap).map((L: any) => ({
        ...L, deliver_cost: r2(L.deliver_cost), return_cost: r2(L.return_cost),
        total_cost: r2(L.deliver_cost + L.return_cost),
      })).sort((a: any, b: any) => b.total_cost - a.total_cost || String(a.courier + a.service).localeCompare(String(b.courier + b.service)));
      const pureProfitByProduct = Object.values(paidProdMap).map((m: any) => ({
        product: m.product,
        packages: m.packages,
        orders: m.orders,
        unit_cost: m.packages > 0 ? r2(m.cogs / m.packages) : 0,
        unit_price: m.packages > 0 ? r2(m.revenue / m.packages) : 0,
        cogs: r2(m.cogs),
        revenue: r2(m.revenue),
        profit: r2(m.revenue - m.cogs),
        net_revenue: r2(m.revenue / (1 + VAT_RATE)),
        net_profit: r2(m.revenue / (1 + VAT_RATE) - m.cogs),
        // Tie-break by name. Array.prototype.sort is stable, so equal package
        // counts used to resolve by insertion order — which came from an
        // unordered paginate() and was never deterministic run-to-run.
      })).sort((a: any, b: any) => b.packages - a.packages || String(a.product).localeCompare(String(b.product)));

      // ── Margin Lab: realized per-package price + the floor each product needs ──
      // Floor solves  P − P/6 − cogs − deliver − commission = target  ⇒  P = 1.2·(target+cogs+deliver+m),
      // picking the commission tier m (1/2/3 €) consistent with the resulting price.
      const GROSS = 1 + VAT_RATE;
      const floorPriceFor = (cogs: number, deliver: number, target: number): number => {
        for (const m of [1, 2, 3]) { const P = GROSS * (target + cogs + deliver + m); if (packageBonusRate(P) === m) return r2(P); }
        return r2(GROSS * (target + cogs + deliver + 3));
      };
      const sortedPkg = realizedPkg.slice().sort((a, b) => a - b);
      // The SQL engine returns the same order statistics without materialising
      // one array element per physical package. js_pctl_index() reproduces the
      // index this expression picks — note that is NOT percentile_disc, which
      // picks ceil(f*N)-1 and disagrees (at N=4, f=0.5: index 1 vs 2).
      const sqlReal = useSql ? SQLROLL.paid.realized : null;
      const pctl = (p: number) => (sqlReal
        ? Number(sqlReal[`p${p}`] ?? 0)
        : (sortedPkg.length ? sortedPkg[Math.min(sortedPkg.length - 1, Math.max(0, Math.round((p / 100) * (sortedPkg.length - 1))))] : 0));
      const pkgMin = sqlReal ? Number(sqlReal.min ?? 0) : (sortedPkg[0] || 0);
      const pkgMax = sqlReal ? Number(sqlReal.max ?? 0) : (sortedPkg[sortedPkg.length - 1] || 0);
      const marginByProduct = (Object.values(paidProdMap) as any[]).map((m) => {
        const pkgs = m.packages;
        const avgPrice = pkgs > 0 ? m.revenue / pkgs : 0;
        const known = costByName[m.product] != null;
        const cogsUnit = known ? costByName[m.product] : 0;
        const avgDeliver = pkgs > 0 ? m.deliverSum / pkgs : 0;
        const commNow = packageBonusRate(avgPrice);
        const netNow = avgPrice - avgPrice / GROSS * VAT_RATE - cogsUnit - avgDeliver - commNow;
        return {
          product: m.product, packages: pkgs, cost_known: known, cogs_unit: r2(cogsUnit),
          avg_realized_price: r2(avgPrice), avg_delivery_share: r2(avgDeliver),
          net_profit_per_pkg: r2(netNow), clears_target: netNow >= marginTarget,
          floor_price: floorPriceFor(cogsUnit, avgDeliver, marginTarget),
          uplift_pct: avgPrice > 0 ? Math.round((floorPriceFor(cogsUnit, avgDeliver, marginTarget) / avgPrice - 1) * 100) : null,
        };
      }).sort((a, b) => b.packages - a.packages || String(a.product).localeCompare(String(b.product)));
      const marginLab = {
        target_profit_per_package: marginTarget,
        vat_rate: VAT_RATE,
        blended_deliver_cost: courierFallback.deliver,        // simulator default delivery/order
        commission_tiers: [{ max: 25, bonus: 1 }, { max: 35, bonus: 2 }, { max: null, bonus: 3 }],
        realized: {
          packages: paidPackages,
          avg: paidPackages > 0 ? r2(paidRevenue / paidPackages) : 0,
          median: r2(pctl(50)), p25: r2(pctl(25)), p75: r2(pctl(75)),
          min: r2(pkgMin), max: r2(pkgMax),
          net_profit_per_pkg: paidPackages > 0 ? r2(clearProfit / paidPackages) : 0,
        },
        by_product: marginByProduct,
      };

      // ── Inventory movement summary ──
      const movement: Record<string, number> = {};
      for (const l of invLogs) movement[l.reason || "manual"] = (movement[l.reason || "manual"] || 0) + Math.abs(num(l.change_amount));
      if (useSql) for (const [k, v] of Object.entries(SQLROLL.calls.movement || {})) movement[k] = num(v);

      const topSellers = Object.values(prodMap).sort((a: any, b: any) => b.revenue - a.revenue
        || String(a.product).localeCompare(String(b.product))).slice(0, 20);

      return json({
        meta: { from: fromRaw, to, granularity, generated_at: new Date().toISOString() },
        overview: {
          revenue: soldRevenue,        // value of orders sold (confirmed → paid), not yet-returned
          paid_revenue: paidRevenue,   // cash actually collected
          orders_total: realOrdersCount,
          sold_count: soldCount,
          paid_count: paidCount,
          aov: soldCount > 0 ? soldRevenue / soldCount : 0,
          units_sold: unitsSold,
          // Returns ÷ all orders; cancels ÷ (orders + cancels) — orders and
          // cancels are separate buckets, never mixed.
          return_rate: realOrdersCount > 0 ? returnedCount / realOrdersCount : 0,
          cancel_rate: (realOrdersCount + cancelledCount) > 0 ? cancelledCount / (realOrdersCount + cancelledCount) : 0,
          returns_value: returnsValue,
          pipeline_value: pipelineValue,
          returned_count: returnedCount,
          cancelled_count: cancelledCount,
          trashed_count: trashedCount,
          leads_pending: leadsPending,
        },
        status_distribution: Object.values(statusDist).sort((a: any, b: any) => b.count - a.count
          || String(a.status).localeCompare(String(b.status))),
        revenue_trend: Object.values(trend).sort((a: any, b: any) => a.bucket.localeCompare(b.bucket)),
        sales: {
          by_product: topN(Object.values(prodMap), "revenue", "product"),
          by_city: topN(Object.values(cityMap), "revenue", "city"),
          by_delivery: Object.values(deliveryMap).sort((a: any, b: any) => b.revenue - a.revenue
            || String(a.delivery).localeCompare(String(b.delivery))),
          by_source: Object.values(sourceMap).sort((a: any, b: any) => b.revenue - a.revenue
            || String(a.source).localeCompare(String(b.source))),
        },
        agents: perAgent,
        products_stock: {
          top_sellers: topSellers,
          stock,
          low_stock: stock.filter((s: any) => s.state === "low"),
          out_of_stock: stock.filter((s: any) => s.state === "out"),
          movement,
        },
        returns: {
          rate: realOrdersCount > 0 ? returnedCount / realOrdersCount : 0,
          value_lost: returnsValue,
          by_reason: Object.values(retReason).sort((a: any, b: any) => b.count - a.count || String(a.reason).localeCompare(String(b.reason))),
          by_product: topN(Object.values(retProduct), "count", "product"),
          by_city: topN(Object.values(retCity), "count", "city"),
        },
        cancellations: {
          total: cancelledCount,
          trashed: trashedCount,
          by_reason: Object.values(canReason).sort((a: any, b: any) => b.count - a.count || String(a.reason).localeCompare(String(b.reason))),
          by_product: topN(Object.values(canProduct), "count", "product"),
        },
        calls: {
          total: callsTotal,
          answered: callsAnswered,
          answer_rate: callsTotal > 0 ? callsAnswered / callsTotal : 0,
          talk_seconds: talkTotal,
          by_outcome: Object.entries(byOutcome).map(([outcome, count]) => ({ outcome, count })).sort((a, b) => b.count - a.count || String(a.outcome).localeCompare(String(b.outcome))),
          per_agent: perAgent.filter((a: any) => a.calls > 0).map((a: any) => ({ name: a.name, calls: a.calls, answered: a.answered, answer_rate: a.answer_rate, talk_seconds: a.talk_seconds })),
        },
        profit: { has_costs: profitRows.length > 0, by_product: profitRows, total_profit: profitRows.reduce((s: number, p: any) => s + p.profit, 0) },

        // === Pure Profit (actuals — money in vs money out) ===
        pure_profit: {
          total_packages: unitsSold,
          avg_price_per_package: unitsSold > 0 ? soldRevenue / unitsSold : 0,
          // Paid-basis totals (match the cash + by_product breakdown below).
          paid_orders: paidCount,
          paid_packages: paidPackages,
          packages_per_order: paidCount > 0 ? r2(paidPackages / paidCount) : 0,
          by_product: pureProfitByProduct,
          // Money in: cash actually collected (paid orders).
          cash_collected: r2(paidRevenue),
          // Money out:
          vat: vatDue,                                     // VAT included in collected cash (gross ÷ 6 at 20%)
          vat_rate: VAT_RATE,
          cogs: cogsPaid,                                  // product cost of what sold
          agent_commissions: totalSpecialAgentCommissions, // first-confirmer bonus (agents only)
          delivery_cost: deliveryCost,                     // courier outbound on all shipped
          return_loss: returnLoss,                         // round-trip loss on every return
          clear_profit: clearProfit,
          // COGS completeness: share of sold packages whose product has a known
          // cost_price, plus the offenders (their cost counts €0 above).
          cost_coverage: costCoverage,
          products_missing_cost: productsMissingCost,
          // Back-compat aliases for older UI keys.
          gross_profit_from_cost: r2(paidRevenue - cogsPaid),
          special_agent_commissions: totalSpecialAgentCommissions,
        },

        // === Margin Lab: realized per-package price + floor each product needs ===
        margin_lab: marginLab,

        // === Logistics spend by courier (which orders went by what) ===
        logistics,

        // === Prediction Lists ROI (which list generated how much money) ===
        prediction_lists: predictionLists,
      });
    }

    // ── Lead Distribution Config ─────────────────────────────
    // GET /api/lead-distribution-config
    if (req.method === "GET" && path === "lead-distribution-config") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let { data, error } = await adminClient
        .from("lead_distribution_config")
        .select("*")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      if (!data) {
        // Self-heal: never let the page break on a missing config row.
        const seeded = await adminClient
          .from("lead_distribution_config")
          .insert({ strategy: "round_robin", is_active: false, max_leads_per_agent: 50, priority_threshold: 500 })
          .select("*").single();
        if (seeded.error) return json({ error: sanitizeDbError(seeded.error) }, 400);
        data = seeded.data;
      }

      // Everything the page needs to explain its own state. Before 2026-08-13
      // this endpoint returned the config alone, so a screen that assigned
      // nothing for a week still displayed "Engine Active" and gave the
      // operator no way at all to find out why.
      const { startISO } = skopjeDayStart();
      const [waiting, assignedToday, candidatesRes, runsRes] = await Promise.all([
        adminClient
          .from("orders")
          .select("id", { count: "exact", head: true })
          .is("assigned_agent_id", null)
          .eq("status", "pending")
          .in("source_type", LEAD_SOURCE_TYPES),
        // Counted from orders, not from run rows: the AFTER INSERT trigger
        // assigns without writing a run row at all, so run rows would
        // undercount exactly the continuous path this page is about.
        adminClient
          .from("orders")
          .select("id", { count: "exact", head: true })
          .gte("assigned_at", startISO)
          .in("source_type", LEAD_SOURCE_TYPES),
        adminClient.rpc("lead_distribution_candidates"),
        adminClient
          .from("lead_distribution_runs")
          .select("ran_at, source, assigned, considered, skipped_reason")
          .order("ran_at", { ascending: false })
          .limit(20),
      ]);

      const runs = (runsRes.data || []) as any[];
      const candidates = ((candidatesRes.data || []) as any[])
        .map((c) => ({
          agent_id: c.agent_id,
          full_name: c.full_name,
          open_leads: c.open_leads,
          open_members: c.open_members,
          effective_load: c.effective_load,
          is_online: c.is_online,
          has_capacity: c.has_capacity,
        }))
        .sort((a, b) => a.effective_load - b.effective_load || String(a.full_name).localeCompare(String(b.full_name)));

      return json({
        ...data,
        waiting_leads: waiting.count ?? 0,
        assigned_today: assignedToday.count ?? 0,
        last_meaningful_run: runs[0] || null,
        candidates,
      });
    }

    // GET /api/lead-distribution/rules — the opt-in per-product specialists.
    // A product absent from this list goes to every participating agent, which
    // is the default and what the operator wants for almost everything.
    if (req.method === "GET" && path === "lead-distribution/rules") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const [prodRes, ruleRes] = await Promise.all([
        adminClient.from("products").select("id, name, is_active").order("name", { ascending: true }),
        adminClient.from("lead_routing_rules").select("product_id, agent_id"),
      ]);
      if (prodRes.error) return json({ error: sanitizeDbError(prodRes.error) }, 400);
      if (ruleRes.error) return json({ error: sanitizeDbError(ruleRes.error) }, 400);
      const byProduct: Record<string, string[]> = {};
      for (const r of (ruleRes.data || []) as any[]) (byProduct[r.product_id] ||= []).push(r.agent_id);
      return json({
        products: (prodRes.data || []).map((p: any) => ({
          product_id: p.id, name: p.name, is_active: p.is_active, agent_ids: byProduct[p.id] || [],
        })),
      });
    }

    // PUT /api/lead-distribution/rules — replace one product's specialists.
    // Body: { product_id: uuid, agent_ids: uuid[] }  (empty array = everyone)
    if (req.method === "PUT" && path === "lead-distribution/rules") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const productId = typeof body?.product_id === "string" ? body.product_id : null;
      if (!productId) return json({ error: "product_id is required" }, 400);
      const agentIds: string[] = Array.isArray(body?.agent_ids)
        ? [...new Set(body.agent_ids.filter((x: any) => typeof x === "string"))] as string[]
        : [];

      const del = await adminClient.from("lead_routing_rules").delete().eq("product_id", productId);
      if (del.error) return json({ error: sanitizeDbError(del.error) }, 400);
      if (agentIds.length) {
        const ins = await adminClient.from("lead_routing_rules")
          .insert(agentIds.map((aid) => ({ product_id: productId, agent_id: aid, created_by: user.id })));
        if (ins.error) return json({ error: sanitizeDbError(ins.error) }, 400);
      }

      await adminClient.from("audit_log").insert({
        actor_id: user.id,
        actor_email: user.email,
        action: "lead_distribution.rules",
        target_type: "lead_routing_rules",
        target_id: productId,
        target_name: agentIds.length ? `${agentIds.length} specialist${agentIds.length === 1 ? "" : "s"}` : "everyone",
        payload: { product_id: productId, agent_ids: agentIds },
      });
      return json({ success: true, product_id: productId, agent_ids: agentIds });
    }

    // GET /api/lead-distribution/participants — every agent the engine could
    // use, with their participation flag. Absence from lead_distribution_optout
    // means participating, so a new hire is included without anyone acting.
    if (req.method === "GET" && path === "lead-distribution/participants") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { data: cfg } = await adminClient
        .from("lead_distribution_config").select("participating_roles").limit(1).maybeSingle();
      const roles: string[] = cfg?.participating_roles || ["pending_agent", "agent", "inbound_agent"];

      const [profRes, roleRes, outRes] = await Promise.all([
        adminClient.from("profiles").select("user_id, full_name").eq("is_active", true),
        adminClient.from("user_roles").select("user_id, role"),
        adminClient.from("lead_distribution_optout").select("agent_id"),
      ]);
      if (profRes.error) return json({ error: sanitizeDbError(profRes.error) }, 400);

      const rolesByUser: Record<string, Set<string>> = {};
      for (const r of (roleRes.data || []) as any[]) (rolesByUser[r.user_id] ||= new Set()).add(r.role);
      const optedOut = new Set(((outRes.data || []) as any[]).map((r) => r.agent_id));

      const participants = ((profRes.data || []) as any[])
        // Same eligibility test as lead_distribution_candidates(): a
        // participating role, and never an admin or manager (they do not own
        // leads — the commission rule credits the confirmer).
        .filter((p) => {
          const rs = rolesByUser[p.user_id];
          if (!rs) return false;
          if (rs.has("admin") || rs.has("manager")) return false;
          return [...rs].some((r) => roles.includes(r));
        })
        .map((p) => ({
          agent_id: p.user_id,
          full_name: p.full_name,
          roles: [...(rolesByUser[p.user_id] || [])],
          is_participating: !optedOut.has(p.user_id),
        }))
        .sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));

      return json({ participating_roles: roles, participants });
    }

    // PUT /api/lead-distribution/participants — toggle one agent on or off.
    // Body: { agent_id: uuid, is_participating: boolean }
    if (req.method === "PUT" && path === "lead-distribution/participants") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      let body: any;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const agentId = typeof body?.agent_id === "string" ? body.agent_id : null;
      if (!agentId) return json({ error: "agent_id is required" }, 400);
      const participating = body?.is_participating !== false;

      if (participating) {
        const { error } = await adminClient.from("lead_distribution_optout").delete().eq("agent_id", agentId);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
      } else {
        const { error } = await adminClient.from("lead_distribution_optout")
          .upsert({ agent_id: agentId, created_by: user.id }, { onConflict: "agent_id" });
        if (error) return json({ error: sanitizeDbError(error) }, 400);
      }

      await adminClient.from("audit_log").insert({
        actor_id: user.id,
        actor_email: user.email,
        action: participating ? "lead_distribution.participant_on" : "lead_distribution.participant_off",
        target_type: "profiles",
        target_id: agentId,
        payload: { agent_id: agentId, is_participating: participating },
      });
      return json({ success: true, agent_id: agentId, is_participating: participating });
    }

    // GET /api/courier-rates — the editable logistics rate card (admin/manager)
    if (req.method === "GET" && path === "courier-rates") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const { data, error } = await adminClient
        .from("courier_rates")
        .select("id,courier,service,deliver_cost,return_cost,updated_at")
        .order("courier", { ascending: true })
        .order("service", { ascending: true });
      if (error) return json({ error: sanitizeDbError(error) }, 400);
      return json(data || []);
    }

    // PATCH /api/courier-rates — update deliver/return costs (admin only).
    // Body: { rates: [{ courier, service, deliver_cost, return_cost }, ...] }
    if (req.method === "PATCH" && path === "courier-rates") {
      if (!isAdmin) return json({ error: "Forbidden — admin only" }, 403);
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const rows = Array.isArray(body?.rates) ? body.rates : Array.isArray(body) ? body : [];
      if (!rows.length) return json({ error: "No rates provided" }, 400);
      const couriers = ["speedy", "econt"]; const services = ["door", "office"];
      for (const r of rows) {
        if (!couriers.includes(r.courier) || !services.includes(r.service)) {
          return json({ error: `Invalid courier/service: ${r.courier}/${r.service}` }, 400);
        }
        const { error } = await adminClient
          .from("courier_rates")
          .update({
            deliver_cost: Number(r.deliver_cost || 0),
            return_cost: Number(r.return_cost || 0),
            updated_at: new Date().toISOString(),
          })
          .eq("courier", r.courier)
          .eq("service", r.service);
        if (error) return json({ error: sanitizeDbError(error) }, 400);
      }
      return json({ success: true });
    }

    // PATCH /api/lead-distribution-config — strategy, Start/Stop, and the
    // fairness knobs. Every field is optional; only what is sent changes.
    if (req.method === "PATCH" && path === "lead-distribution-config") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);
      const body = await req.json();
      const {
        strategy, is_active, max_leads_per_agent, priority_threshold,
        respect_online, include_prediction_load, participating_roles,
        working_hours_only, order_direction,
      } = body;
      const updates: any = { updated_at: new Date().toISOString(), updated_by: user.id };
      if (strategy !== undefined) {
        if (!["round_robin", "load_balance", "priority"].includes(strategy)) {
          return json({ error: `Unknown strategy: ${strategy}` }, 400);
        }
        updates.strategy = strategy;
      }
      if (is_active !== undefined) updates.is_active = !!is_active;
      if (max_leads_per_agent !== undefined) updates.max_leads_per_agent = Math.max(1, Math.floor(Number(max_leads_per_agent) || 50));
      // EUR — orders.price is stored in euro. See elyon-currency.
      if (priority_threshold !== undefined) updates.priority_threshold = Math.max(0, Number(priority_threshold) || 0);
      if (respect_online !== undefined) updates.respect_online = !!respect_online;
      if (include_prediction_load !== undefined) updates.include_prediction_load = !!include_prediction_load;
      if (working_hours_only !== undefined) updates.working_hours_only = !!working_hours_only;
      if (order_direction !== undefined) {
        if (!["newest", "oldest"].includes(order_direction)) return json({ error: "order_direction must be newest|oldest" }, 400);
        updates.order_direction = order_direction;
      }
      if (participating_roles !== undefined) {
        const ALLOWED = ["pending_agent", "agent", "inbound_agent", "prediction_agent"];
        const roles = Array.isArray(participating_roles)
          ? [...new Set(participating_roles.filter((r: any) => ALLOWED.includes(r)))]
          : [];
        // Never let the floor be emptied by accident: an engine with no
        // participating role can never assign anything and looks identical to
        // one that is simply broken.
        if (!roles.length) return json({ error: "At least one participating role is required" }, 400);
        updates.participating_roles = roles;
      }

      const { data: configs } = await adminClient.from("lead_distribution_config").select("id").limit(1);
      if (!configs?.length) return json({ error: "No config found" }, 404);

      const { error } = await adminClient
        .from("lead_distribution_config")
        .update(updates)
        .eq("id", configs[0].id);
      if (error) return json({ error: sanitizeDbError(error) }, 400);

      // Start/Stop is the one setting worth an audit trail of its own — it is
      // the difference between leads reaching the floor and dying unworked.
      if (is_active !== undefined) {
        await adminClient.from("audit_log").insert({
          actor_id: user.id,
          actor_email: user.email,
          action: is_active ? "lead_distribution.start" : "lead_distribution.stop",
          target_type: "lead_distribution_config",
          target_id: configs[0].id,
          payload: updates,
        });
      }
      return json({ success: true });
    }

    // POST /api/lead-distribution/auto-assign — drain the unassigned inbound-lead
    // pool once, right now ("Run once now" on /lead-distribution).
    //
    // The strategy logic itself lives in Postgres — distribute_pending_leads()
    // → pick_agent_for_lead() → assign_one_lead(), migration 20260921000000.
    // It was moved out of this handler on 2026-08-13 because an edge function
    // cannot do this job correctly: the PostgREST 1000-row cap silently
    // truncated BOTH the candidate pull and the per-agent load tally (so
    // max_leads_per_agent was enforced against undercounted load), the
    // round_robin branch dropped every remaining order once one agent filled
    // up, the candidate query had no lead-source filter (it would have handed
    // out 80.360 legacy source_type='import' rows), and one UPDATE round-trip
    // per order timed out long before a real backlog drained.
    //
    // Body: { limit?: number, dry_run?: boolean }
    if (req.method === "POST" && path === "lead-distribution/auto-assign") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      let body: any = {};
      try { body = await req.json(); } catch { /* body is optional */ }
      const rawLimit = Number(body?.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 0), 5000) : 500;
      const dryRun = body?.dry_run === true;

      const { data: runData, error: runErr } = await adminClient.rpc("distribute_pending_leads", {
        _limit: limit,
        _dry_run: dryRun,
        _source: "manual",
      });
      if (runErr) return json({ error: sanitizeDbError(runErr) }, 400);

      const row: any = Array.isArray(runData) ? runData[0] : runData;
      const perAgent: Record<string, number> = (row?.per_agent as Record<string, number>) || {};
      const assigned = Number(row?.assigned || 0);
      const considered = Number(row?.considered || 0);
      const skippedReason: string | null = row?.skipped_reason ?? null;

      // Resolve names once, for both the preview and the real run.
      const agentIds = Object.keys(perAgent);
      let agents: { agent_id: string; full_name: string; count: number }[] = [];
      if (agentIds.length) {
        const { data: profs } = await adminClient
          .from("profiles").select("user_id, full_name").in("user_id", agentIds);
        const nameById = new Map((profs || []).map((p: any) => [p.user_id, p.full_name as string]));
        agents = agentIds
          .map((id) => ({ agent_id: id, full_name: nameById.get(id) || "", count: Number(perAgent[id] || 0) }))
          .sort((a, b) => b.count - a.count || a.full_name.localeCompare(b.full_name));
      }

      if (!dryRun && assigned > 0) {
        await adminClient.from("audit_log").insert({
          actor_id: user.id,
          actor_email: user.email,
          action: "lead_distribution.run",
          target_type: "orders",
          target_name: `${assigned} lead${assigned === 1 ? "" : "s"} → ${agentIds.length} agent${agentIds.length === 1 ? "" : "s"}`,
          payload: { assigned, considered, per_agent: perAgent, source: "manual", limit },
        });

        // One summary ping per agent who actually received leads (never
        // one-per-lead). The continuous trigger path deliberately notifies
        // NOBODY: ~193 leads a day would be pure noise, and the agent's
        // Pendings badge on /calls already pulses when work arrives.
        for (const [aid, cnt] of Object.entries(perAgent)) {
          if (cnt > 0 && aid !== user.id) {
            await notifyUsers(adminClient, [aid], {
              type: "assignment",
              title: "New leads assigned to you",
              message: `${cnt} new lead${cnt === 1 ? "" : "s"} assigned to you — open Calls to work your Pendings queue.`,
              link: "/calls",
              meta: { i18n: "notif.leadsAssigned", count: cnt },
            });
          }
        }
      }

      return json({ assigned, considered, skipped_reason: skippedReason, per_agent: perAgent, agents, dry_run: dryRun });
    }

    // ── Operations Command Center ────────────────────────────
    // GET /api/operations-center
    if (req.method === "GET" && path === "operations-center") {
      if (!isAdminOrManager) return json({ error: "Forbidden" }, 403);

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayISO = todayStart.toISOString();

      // Today's orders by status
      const { data: todayOrders } = await adminClient
        .from("orders")
        .select("id, status, price, assigned_agent_id, assigned_agent_name, updated_at, created_at")
        .gte("created_at", todayISO);

      const confirmed = (todayOrders || []).filter((o: any) => o.status === "confirmed").length;
      const shipped = (todayOrders || []).filter((o: any) => o.status === "shipped").length;
      const returned = (todayOrders || []).filter((o: any) => o.status === "returned").length;
      const paid = (todayOrders || []).filter((o: any) => o.status === "paid").length;
      const todayRevenue = (todayOrders || [])
        .filter((o: any) => ["shipped", "paid"].includes(o.status))
        .reduce((s: number, o: any) => s + Number(o.price || 0), 0);
      const totalToday = (todayOrders || []).length;

      // Daily activity KPIs — strictly from actual status *transitions* recorded today via order_history.
      // This is the accurate "what we closed / processed today" (e.g. via BigArena CSV upload).
      // An order appears here on the calendar day its status actually became 'paid'/'returned' etc.
      // This prevents duplication and gives real operational visibility separate from cohort-by-created_at numbers.
      const todayHistory = await adminClient
        .from("order_history")
        .select("order_id, to_status, changed_at")
        .gte("changed_at", todayISO)
        .in("to_status", ["confirmed", "shipped", "paid", "returned"]);

      const todayTransitionOrderIds = new Set((todayHistory.data || []).map((h: any) => h.order_id));

      // Fetch current details only for orders that had relevant transitions today
      let todayTransitionOrders: any[] = [];
      if (todayTransitionOrderIds.size > 0) {
        const ids = Array.from(todayTransitionOrderIds);
        const { data: ords } = await adminClient
          .from("orders")
          .select("id, status, price")
          .in("id", ids);
        todayTransitionOrders = ords || [];
      }

      const confirmedToday = todayTransitionOrders.filter((o: any) => o.status === "confirmed").length;
      const shippedToday = todayTransitionOrders.filter((o: any) => o.status === "shipped").length;
      const returnedToday = todayTransitionOrders.filter((o: any) => o.status === "returned").length;
      const paidToday = todayTransitionOrders.filter((o: any) => o.status === "paid").length;
      const revenueToday = todayTransitionOrders
        .filter((o: any) => o.status === "paid")
        .reduce((s: number, o: any) => s + Number(o.price || 0), 0);

      // Online agents with today's activity
      const { data: profiles } = await adminClient
        .from("profiles")
        .select("user_id, full_name, email, last_seen_at, voip_state, voip_state_at")
        .eq("is_active", true);

      const pIds = (profiles || []).map((p: any) => p.user_id);
      const { data: roles } = await adminClient
        .from("user_roles")
        .select("user_id, role")
        .in("user_id", pIds.length > 0 ? pIds : ["__none__"]);

      const roleMap2: Record<string, string[]> = {};
      for (const r of roles || []) {
        if (!roleMap2[r.user_id]) roleMap2[r.user_id] = [];
        roleMap2[r.user_id].push(r.role);
      }

      const agentProfiles = (profiles || []).filter((p: any) => {
        const r = roleMap2[p.user_id] || [];
        return r.includes("agent") || r.includes("prediction_agent");
      });

      // Today's shift login logs
      const todayDateStr = new Date().toISOString().split("T")[0];
      const { data: loginLogs } = await adminClient
        .from("shift_login_logs")
        .select("user_id, login_time, logout_time, shift_start_time, shift_end_time")
        .eq("shift_date", todayDateStr);

      const loginMap: Record<string, any> = {};
      for (const log of loginLogs || []) {
        loginMap[log.user_id] = log;
      }

      // Agent activity: orders touched today
      const agentActivity: Record<string, { confirmed: number; total: number }> = {};
      for (const o of todayOrders || []) {
        if (!o.assigned_agent_id) continue;
        if (!agentActivity[o.assigned_agent_id]) agentActivity[o.assigned_agent_id] = { confirmed: 0, total: 0 };
        agentActivity[o.assigned_agent_id].total++;
        if (o.status === "confirmed") agentActivity[o.assigned_agent_id].confirmed++;
      }

      // Active lead counts
      const { data: activeCounts } = await adminClient
        .from("orders")
        .select("assigned_agent_id")
        .in("assigned_agent_id", pIds.length > 0 ? pIds : ["__none__"])
        .in("status", ["pending", "take", "call_again"]);

      const activeMap: Record<string, number> = {};
      for (const o of activeCounts || []) {
        activeMap[o.assigned_agent_id] = (activeMap[o.assigned_agent_id] || 0) + 1;
      }

      // "Online" = a recent presence heartbeat (profiles.last_seen_at within 2 min),
      // exactly like GET /agents/online used by the Assigner — so the two "who's
      // online" views can never disagree. The old check (a shift_login_logs row with
      // no logout_time) wrongly marked active users offline when they never started a
      // shift or closed the tab without logging out, and could pin stale sessions
      // "online" forever. login_time is still surfaced for the "Since …" label.
      const ONLINE_WINDOW_MS = 2 * 60 * 1000;
      // Same staleness rule as GET /agents/online — see that handler.
      const CALL_STALE_MS = 3 * 60 * 1000;
      const nowMs = Date.now();
      const agentList = agentProfiles.map((p: any) => {
        const login = loginMap[p.user_id];
        const activity = agentActivity[p.user_id] || { confirmed: 0, total: 0 };
        const lastSeen = p.last_seen_at ? new Date(p.last_seen_at).getTime() : 0;
        const isOnline = lastSeen > 0 && (nowMs - lastSeen) < ONLINE_WINDOW_MS;
        const stateAt = p.voip_state_at ? new Date(p.voip_state_at).getTime() : 0;
        const inCall = isOnline &&
          (p.voip_state === "dialing" || p.voip_state === "in_call") &&
          stateAt > 0 && (nowMs - stateAt) < CALL_STALE_MS;
        return {
          user_id: p.user_id,
          full_name: p.full_name,
          email: p.email,
          roles: roleMap2[p.user_id] || [],
          is_online: isOnline,
          in_call: inCall,
          login_time: login?.login_time || null,
          last_seen_at: p.last_seen_at || null,
          active_leads: activeMap[p.user_id] || 0,
          today_confirmed: activity.confirmed,
          today_total: activity.total,
        };
      });

      return json({
        kpi: {
          total_orders_today: totalToday,
          confirmed_today: confirmedToday,
          shipped_today: shippedToday,
          returned_today: returnedToday,
          paid_today: paidToday,
          revenue_today: revenueToday,
        },
        agents: agentList.sort((a: any, b: any) => b.today_total - a.today_total),
        agents_online: agentList.filter((a: any) => a.is_online).length,
        agents_total: agentList.length,
      });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error("API Error:", err);
    return json({ error: "Internal server error" }, 500);
  }
}

// Top-level dispatcher — handles CORS scoping then delegates to handleRequest.
serve(async (req: Request) => {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = pickAllowedOrigin(origin);

  const response = await handleRequest(req);

  // Only add CORS origin headers when the request actually came from a browser
  // on an allowed origin. Server-to-server callers don't need them.
  if (allowedOrigin) {
    response.headers.set("Access-Control-Allow-Origin", allowedOrigin);
    response.headers.set("Vary", "Origin");
  }

  return response;
});

// Normalize a Macedonia phone to E.164 (+389XXXXXXXX) - TODO(mk): verify digit lengths vs real +389 numbers, matching how the rest
// of the CRM stores phones. Returns "" if there aren't enough digits.
//   070123456 / 38970123456 / +38970123456 / 0038970123456 → +38970123456
function normalizeMkPhone(raw: string): string {
  let digits = (raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("389")) {
    digits = digits.slice(3);
  } else if (digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  digits = digits.replace(/^0+/, "");
  if (digits.length < 8) return "";
  return "+389" + digits;
}

// ── Deterministic recording ↔ call matcher (shared by every surface) ─────────
// Fixes the long-call miss (#1) and the repeat-number swap (#4). The OLD code
// matched by "last-8 phone + nearest timestamp within ±20 min" comparing the
// recording's mtime (≈ call END) against the call's connected_at (call START),
// so any call longer than ~20 min could never match its own recording, and two
// calls to the same number could swap recordings.
//
// This matcher instead:
//   • anchors on the call END (recording mtime ≈ when MixMonitor closed the file
//     ≈ ended_at), so call length is irrelevant — the ±20 min window now only
//     absorbs PBX↔browser clock skew, not the call duration;
//   • prefers true interval OVERLAP when the recording's start is known
//     (elyon-rec.php now returns it), which is exact regardless of length;
//   • gates on the agent (recording extension → agent) when BOTH sides know it,
//     so two agents calling the same number can't cross;
//   • assigns ONE-TO-ONE (greedy by best score) so a recording or a call is used
//     at most once — no more "second call's recording shows on the first".
// Phone uses the last-8 rule (skill: elyon-phone-normalization).
type RecLite = { file?: string; dialed?: string; ext?: string; mtime?: number; start?: number; uniqueid?: string };
type CallLite = {
  id: string; agent_id?: string | null; customer_phone?: string | null;
  started_at?: string | null; connected_at?: string | null; ended_at?: string | null; created_at?: string | null;
};
function matchRecordingsToCalls(
  recordings: RecLite[],
  calls: CallLite[],
  extToAgent: Record<string, string> = {}, // extension -> agent user_id
): Map<string, RecLite> {
  const WINDOW_MS = 20 * 60 * 1000; // end-anchor tolerance (clock skew), NOT call length
  const last8 = (v: any) => String(v || "").replace(/\D/g, "").slice(-8);
  const callEndMs = (c: CallLite) => new Date(c.ended_at || c.connected_at || c.started_at || c.created_at || 0).getTime();
  const callStartMs = (c: CallLite) => new Date(c.connected_at || c.started_at || c.created_at || 0).getTime();
  // The Asterisk uniqueid is "<epoch>.<seq>" and is the LAST hyphen-separated
  // token of the recording filename (out-HHMMSS-ext-cid-to-dialed-<uniqueid>.wav).
  // Its leading integer is the channel-creation time = the call START — so we get
  // a reliable start with no timezone math and WITHOUT any elyon-rec.php change.
  const recStartMs = (rec: RecLite): number | null => {
    if (rec.start) return rec.start * 1000;
    const uid = rec.uniqueid || (rec.file ? String(rec.file).replace(/\.wav$/i, "").split("-").pop() || "" : "");
    const epoch = parseInt(String(uid).split(".")[0], 10);
    return Number.isFinite(epoch) && epoch > 1_000_000_000 ? epoch * 1000 : null;
  };

  const byPhone: Record<string, CallLite[]> = {};
  for (const c of calls) {
    const p = last8(c.customer_phone);
    if (p) (byPhone[p] = byPhone[p] || []).push(c);
  }

  type Pair = { rec: RecLite; call: CallLite; score: number };
  const pairs: Pair[] = [];
  for (const rec of recordings) {
    const p = last8(rec.dialed);
    if (!p || !byPhone[p]) continue;
    const recEnd = (rec.mtime || 0) * 1000;
    const recStart = recStartMs(rec);
    const recAgent = rec.ext ? extToAgent[rec.ext] : undefined;
    for (const call of byPhone[p]) {
      // Agent gate: only when BOTH sides know the agent (newer recordings carry ext).
      if (recAgent && call.agent_id && recAgent !== call.agent_id) continue;
      const cEnd = callEndMs(call);
      const cStart = callStartMs(call);
      let score: number;
      if (recStart) {
        const overlap = Math.min(recEnd, cEnd) - Math.max(recStart, cStart);
        if (overlap > 0) {
          score = overlap; // true overlaps (positive) always beat end-proximity (negative)
        } else {
          const endDist = Math.abs(cEnd - recEnd);
          if (endDist > WINDOW_MS) continue;
          score = -endDist;
        }
      } else {
        // No start known (pre-upgrade elyon-rec.php): anchor on the END only.
        const endDist = Math.abs(cEnd - recEnd);
        if (endDist > WINDOW_MS) continue;
        score = -endDist;
      }
      pairs.push({ rec, call, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const out = new Map<string, RecLite>(); // call.id -> rec
  const usedRec = new Set<RecLite>();
  const usedCall = new Set<string>();
  for (const { rec, call } of pairs) {
    if (usedRec.has(rec) || usedCall.has(call.id)) continue;
    usedRec.add(rec); usedCall.add(call.id);
    out.set(call.id, rec);
  }
  return out;
}

// HMAC-SHA256 verification for inbound webhooks.
// The sender must include x-webhook-signature: <hex(HMAC_SHA256(rawBody, secret))>.
// FAIL CLOSED: if WEBHOOK_SECRET is unset we REJECT every webhook rather than
// silently accepting unsigned requests. The secret is always set in production,
// so this only guards against a misconfigured/blank-secret deploy opening the
// inbound pipeline to anyone. (Initial-rollout fail-open was removed 2026-06-11.)
async function verifyWebhookSignature(req: Request, rawBody: string): Promise<boolean> {
  const secret = Deno.env.get("WEBHOOK_SECRET");
  if (!secret) {
    console.error("WEBHOOK_SECRET not set — REJECTING webhook (fail-closed). Set the secret to restore inbound leads.");
    return false;
  }
  const provided = (req.headers.get("x-webhook-signature") || "").toLowerCase();
  if (!provided) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)),
  );
  const expected = Array.from(sigBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // timing-safe compare
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < provided.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

// Append-only audit log writer. Fire-and-await with error swallow — an
// audit failure should never block the actual operation. The audit_log
// table has BEFORE UPDATE/DELETE triggers that reject mutations, so once
// a row lands it cannot be tampered with even via the service role.
async function audit(
  client: any,
  actorId: string | null,
  actorEmail: string | null,
  action: string,
  opts: {
    target_type?: string;
    target_id?: string | number | null;
    target_name?: string | null;
    payload?: any;
  } = {},
): Promise<void> {
  try {
    await client.from("audit_log").insert({
      actor_id: actorId,
      actor_email: actorEmail,
      action,
      target_type: opts.target_type ?? null,
      target_id: opts.target_id != null ? String(opts.target_id) : null,
      target_name: opts.target_name ?? null,
      payload: opts.payload ?? {},
    });
  } catch (err) {
    console.error("audit_log insert failed:", err);
  }
}

/**
 * Fire in-app notifications to a set of users. Best-effort: a failure here must
 * NEVER fail the request that triggered it (the same guarantee the DB triggers
 * give for missed-call / returned / low-stock events). De-dupes + drops nulls.
 *
 * `meta` carries the translation contract: the DB cannot know which language the
 * reader picked, so we store English title+message AND `meta.i18n` — a key whose
 * `.title` / `.body` are resolved in the reader's locale by
 * localizeNotification() in src/components/NotificationsDropdown.tsx. Any other
 * meta keys become interpolation vars. Rows without meta render as plain
 * English, which is why the older call sites still work unchanged.
 */
async function notifyUsers(
  client: any,
  userIds: (string | null | undefined)[],
  n: { type: string; title: string; message?: string; link?: string | null; meta?: Record<string, any> | null },
): Promise<void> {
  const uniq = [...new Set(userIds.filter(Boolean))] as string[];
  if (uniq.length === 0) return;
  try {
    await client.from("notifications").insert(
      uniq.map((uid) => ({
        user_id: uid,
        type: n.type,
        title: n.title,
        message: n.message ?? "",
        link: n.link ?? null,
        meta: n.meta ?? null,
      })),
    );
  } catch (err) {
    console.error("notifyUsers insert failed:", err);
  }
}

function sanitizeDbError(err: any): string {
  const errorMap: Record<string, string> = {
    '23505': 'Duplicate entry',
    '23503': 'Referenced record not found',
    '23502': 'Required field missing',
    '23514': 'Invalid value',
    '42P01': 'Operation failed',
    '42703': 'Operation failed',
    '42501': 'Permission denied',
  };
  const code = err?.code;
  // Only log the error code, never the full error payload (avoid leaking
  // schema details such as table/column/constraint names into logs).
  console.error('Database error code:', code || 'unknown');
  return errorMap[code] || 'Operation failed';
}

// Per-agent Personal List capacity. Operator-tunable from Settings → System
// Rules (app_settings.personal_list_max_holds). Clamped to a sane range and
// defaults to 50 when unset/invalid.
const PERSONAL_LIST_CAP_DEFAULT = 50;
async function getPersonalListCap(adminClient: any): Promise<number> {
  try {
    const { data } = await adminClient
      .from("app_settings")
      .select("value")
      .eq("key", "personal_list_max_holds")
      .maybeSingle();
    const n = Number(data?.value);
    if (Number.isFinite(n) && n >= 1 && n <= 1000) return Math.floor(n);
  } catch (_) { /* fall through to default */ }
  return PERSONAL_LIST_CAP_DEFAULT;
}

// Unpaid-delivery chase window. Operator-tunable from Settings → Notifications.
// These MUST stay in step with the defaults hard-coded in
// notify_unpaid_shipped_orders() (migration 20260905000100) — the DB job reads
// app_settings directly and falls back to the same numbers.
const UNPAID_CHASE_DAYS_DEFAULT = 3;        // first ping N days after shipping
const UNPAID_CHASE_STOP_DAYS_DEFAULT = 30;  // stop chasing past this age

// Product of the Day (the /calls promo banner). Off until the operator sets one
// up from Call Scripts → Promo. Display-only — never touches payout math.
const PROMO_OF_THE_DAY_DEFAULT = {
  enabled: false, product_id: null, product_name: "",
  price_eur: null, bonus_eur: null, expires_on: null, note: "",
};

// Concurrent-line cap fallback. The REAL value comes from the PBX health pull,
// which now reads it from the enforced dialplan global OUTMAXCHANS_1, so this
// constant only covers the window before the first snapshot lands.
// Deliberately 10, NOT the 25 A1 sold us: the 2026-07-28 CAC test proved A1's
// Admission Control still admits only 10 concurrent calls (11/13/18-call bursts
// all yielded exactly 10, the rest rejected with RELEASE_BECAUSE_IN_ADMISSION_FAILED).
// Raise it only when a re-test passes. Do not scatter this number again.
const TRUNK_MAX_LINES_FALLBACK = 10;

// A1 minutes bundle. Operator-tunable from Settings → Telephony
// (app_settings.voip_minutes_bundle) because A1 changes it commercially, not on
// our release cycle.
//   included_minutes — bundle size (20,000 since the 2026-07 upgrade; was 5,000)
//   billing_day      — day of month the cycle resets. A1's invoice date, NOT
//                      necessarily the 1st — confirm before trusting the gauge.
//   metric           — 'talk' (answered time, what A1 bills) or 'total'
//                      (includes ring time, always higher than the invoice).
const VOIP_MINUTES_BUNDLE_DEFAULT = {
  included_minutes: 20000,
  billing_day: 1,
  metric: "talk" as "talk" | "total",
  warn_pct: 80,
  critical_pct: 95,
};

async function getVoipMinutesBundle(adminClient: any) {
  try {
    const { data } = await adminClient
      .from("app_settings").select("value")
      .eq("key", "voip_minutes_bundle").maybeSingle();
    const v = data?.value;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return { ...VOIP_MINUTES_BUNDLE_DEFAULT, ...v };
    }
  } catch (_) { /* fall through to default */ }
  return VOIP_MINUTES_BUNDLE_DEFAULT;
}

// Current billing cycle [start, end) for a reset day-of-month. billing_day is
// clamped to 28 on write, so no month can skip a cycle boundary.
function voipBillingCycle(billingDay: number, now = new Date()) {
  const d = Math.min(Math.max(Math.floor(billingDay) || 1, 1), 28);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(d);
  if (now.getDate() < d) start.setMonth(start.getMonth() - 1);
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return { start, end };
}

// Bundle consumption for the CURRENT billing cycle. Aggregated in Postgres
// (voip_minutes_cycle_usage, migration 20260906000000) rather than by streaming
// call_logs — a cycle can hold 30k+ rows and PostgREST silently caps a response
// at 1000, which is exactly how this page used to under-report minutes.
async function computeVoipCycle(adminClient: any) {
  const bundle = await getVoipMinutesBundle(adminClient);
  const { start, end } = voipBillingCycle(bundle.billing_day);
  const { data, error } = await adminClient.rpc("voip_minutes_cycle_usage", {
    p_start: start.toISOString(), p_end: end.toISOString(),
  });
  if (error) return null;
  const days: any[] = data || [];

  const secField = bundle.metric === "total" ? "total_seconds" : "talk_seconds";
  const usedMin = Math.round(days.reduce((s, d) => s + Number(d[secField] || 0), 0) / 60);
  const usedTotalMin = Math.round(days.reduce((s, d) => s + Number(d.total_seconds || 0), 0) / 60);

  const DAY_MS = 86400_000;
  const daysTotal = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const daysElapsed = Math.max(1, Math.ceil((Date.now() - start.getTime()) / DAY_MS));
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  // Weekday-aware forecast: average each day-of-week seen so far, then sum the
  // expected value of every remaining calendar day. A flat used/elapsed*total
  // is biased by up to ~30% depending on how many weekends have passed.
  const byDow: number[][] = [[], [], [], [], [], [], []];
  for (const d of days) {
    const dow = new Date(`${d.day}T12:00:00Z`).getUTCDay();
    byDow[dow].push(Number(d[secField] || 0) / 60);
  }
  const dowAvg = byDow.map((a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null));
  const overallAvg = usedMin / daysElapsed;
  let projected = usedMin;
  const cursor = new Date(start.getTime() + daysElapsed * DAY_MS);
  for (let i = 0; i < daysRemaining; i++) {
    projected += dowAvg[cursor.getUTCDay()] ?? overallAvg;
    cursor.setDate(cursor.getDate() + 1);
  }
  projected = Math.round(projected);

  const included = Number(bundle.included_minutes) || 0;
  const pctUsed = included ? Math.round((usedMin / included) * 100) : 0;
  const projectedPct = included ? Math.round((projected / included) * 100) : 0;
  return {
    start: start.toISOString(), end: end.toISOString(),
    days_total: daysTotal, days_elapsed: daysElapsed, days_remaining: daysRemaining,
    metric: bundle.metric,
    used_minutes: usedMin, used_total_minutes: usedTotalMin,
    included_minutes: included,
    pct_used: pctUsed,
    projected_minutes: projected, projected_pct: projectedPct,
    projected_over_by: Math.max(0, projected - included),
    status: pctUsed >= bundle.critical_pct || projectedPct >= 100
      ? "critical" : pctUsed >= bundle.warn_pct ? "warn" : "ok",
  };
}

// ── Affiliate postback delivery ──────────────────────────────────────────────
// Drains the affiliate_postbacks queue: renders the affiliate's URL template,
// GETs it (10s timeout), logs the outcome, and schedules retries with
// exponential backoff. Claiming goes through the FOR UPDATE SKIP LOCKED RPC
// (claim_due_affiliate_postbacks, migration 20260801000200), so overlapping
// drains (cron tick + a waitUntil nudge) can never double-send a row.
// Backoff by attempt number (the claim already incremented it):
// 1m → 5m → 15m → 1h → 6h → 24h, then terminal 'failed' (admin can resend).
const POSTBACK_BACKOFF_MINUTES = [1, 5, 15, 60, 360, 1440];
const POSTBACK_MAX_ATTEMPTS = 7;

// Keitaro-style default {status}: 'lead' = revenue on hold, 'sale' = confirmed
// revenue, 'rejected' = lost. Trackers needing other words use {stage:…}.
const POSTBACK_STATUS_MAP: Record<string, string> = {
  lead: "lead", hold: "lead", approve: "sale",
  cancel: "rejected", trash: "rejected", return: "rejected", test: "lead",
};
const POSTBACK_STAGE_ORDER = ["lead", "hold", "approve", "cancel", "trash", "return"];

// AlterCPA-family endpoints answer HTTP 200 with the real verdict in the JSON
// BODY — {"status":"error","error":"no-id"} is a rejection, not a delivery.
// Treating 2xx as success made every postback we ever sent look green while
// none of them landed. Generic trackers (Keitaro etc.) return HTML or an empty
// body, so anything that isn't JSON-with-a-status stays "delivered" as before.
//
// Permanent = never worth retrying; burning the 7-attempt backoff on these
// just delays the failure being visible.
const POSTBACK_PERMANENT_ERRORS = new Set([
  "access-denied", // order isn't ours / unknown id
  "orderid",       // no order id supplied
  "no-id",         // same, older wording
  "key",           // bad or missing API token
  "func",          // no such endpoint
  "security",      // rejected credential
]);

// ── AlterCPA advertiser-API mode ────────────────────────────────────────────
// Our reason strings → their numeric codes. Overridable per affiliate via
// affiliates.altercpa_reason_map, because each network configures its own
// reason table (cpa.toys and cashfactories already diverge on 15/18/19).
// 'rude'/'uncooperative' deliberately map to 2 (Changed his mind) rather than
// a trash-flagged code — operator decision 2026-07-22, see the migration.
const ALTERCPA_REASON_DEFAULT: Record<string, number> = {
  // trash-flagged on their side, and genuinely invalid on ours
  wrong_number: 1,        // Incorrect phone
  wrong_person: 3,        // Did not order
  not_reachable: 11,      // Could not get through
  bought_elsewhere: 8,    // Ordered elsewhere
  duplicate_order: 7,     // Duplicate order
  wrong_product: 14,      // Product did not fit
  // not trash — a real customer who said no
  price_too_high: 9,      // Expensive
  no_money: 9,            // Expensive
  rude: 2, uncooperative: 2, not_satisfied: 2, changed_mind: 2,
  still_using_product: 2, not_interested: 2, will_call_back: 2,
  family_refused: 2, other: 2,
};

// Their status codes. Approval is NOT a status change — see accept=1 below.
const ALTERCPA_STATUS = { processing: 2, cancelled: 5, sending: 7, completed: 10, returned: 11 };

// ── Manual CPA push (POST /orders/:id/altercpa-push, 2026-08-14) ────────────
// Our order_status → their comp/edit.json expression. This is the BUTTON's map,
// not the affiliate drain's event map above — the two speak different source
// vocabularies (order statuses vs postback stages) and must not be merged.
// pending/take/duplicated have nothing truthful to say; call_again (their 3
// Callback) is deliberately excluded until the read-back loop is verified live.
const ALTERCPA_PUSH_STATUS: Record<string, number | "accept"> = {
  confirmed: "accept",   // accept=1 — never status 10 (their commission timers)
  shipped: 7,            // Sending
  delivered: 9,          // Arrived
  paid: 10,              // Completed
  returned: 11,          // Return — no reason param; reason is only for status 5
  cancelled: 5,
  trashed: 5,
};

// orders.cancellation_reason → their cancel code 1-15. Same decisions as
// ALTERCPA_REASON_DEFAULT with ONE override: not_satisfied → 10 ("Not satisfied
// with delivery" — their exact code, and CANCEL_REASON_TO_CRM maps 10 back to
// not_satisfied, so it round-trips). pending_cleanup / stale_pending_cleanup
// are deliberately absent: server cleanup markers, blocked with 422 upstream.
const ALTERCPA_PUSH_CANCEL_REASON: Record<string, number> = {
  no_money: 9, changed_mind: 2, wrong_product: 14, bought_elsewhere: 8,
  family_refused: 2, duplicate_order: 7, price_too_high: 9, not_satisfied: 10,
  still_using_product: 2, not_interested: 2, will_call_back: 2, other: 2,
};

// orders.trash_reason → their cancel code. rude/uncooperative stay 2 (Changed
// his mind), never a trash-flagged code — operator decision 2026-07-22.
const ALTERCPA_PUSH_TRASH_REASON: Record<string, number> = {
  wrong_number: 1, wrong_person: 3, not_reachable: 11, duplicate_order: 7,
  rude: 2, uncooperative: 2, other: 2,
};

// Build the AlterCPA query string for one event. Returns null when the event
// cannot be expressed (no oid to key on).
function altercpaParams(
  event: string,
  extId: string | null,
  reason: string | null,
  reasonMap: Record<string, number> | null,
): URLSearchParams | null {
  if (!extId) return null;                       // no oid → nothing we can say
  const p = new URLSearchParams({ oid: extId });
  const codeFor = (r: string | null) =>
    (r && (reasonMap?.[r] ?? ALTERCPA_REASON_DEFAULT[r])) ?? 2; // 2 = changed his mind
  switch (event) {
    case "lead":    p.set("status", String(ALTERCPA_STATUS.processing)); break;
    // Confirmed by the call centre = accepted. MUST be accept=1, never a
    // status number, or their hold timer / commission mechanics don't fire.
    case "hold":    p.set("accept", "1"); break;
    case "ship":    p.set("status", String(ALTERCPA_STATUS.sending)); break;
    case "approve": p.set("status", String(ALTERCPA_STATUS.completed)); break;
    case "return":  p.set("status", String(ALTERCPA_STATUS.returned)); break;
    case "cancel":
    case "trash":
      p.set("status", String(ALTERCPA_STATUS.cancelled));
      p.set("reason", String(codeFor(reason)));  // mandatory when status=5
      break;
    default: return null;                        // 'test' handled by the caller
  }
  return p;
}

// The status.json endpoint is the free-text one and cannot carry numeric
// statuses, cancel reasons or tracking codes. edit.json can. Partners often
// paste the status.json URL, so normalise it instead of making them re-paste.
function altercpaBaseUrl(raw: string): string {
  return raw.replace(/\/api\/comp\/status\.json/i, "/api/comp/edit.json");
}

function classifyPostbackBody(
  bodyText: string,
  // AlterCPA connectivity probe: we deliberately send no order id, so the
  // endpoint answering "no order id" is exactly the success signal — it proves
  // the URL resolved AND the API token was accepted (a bad token answers
  // "key"). Only the portal's test-fire sets this.
  probeMode = false,
): { ok: boolean; permanent: boolean; error?: string } {
  const t = (bodyText || "").trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return { ok: true, permanent: false };
  let parsed: any;
  try { parsed = JSON.parse(t); } catch { return { ok: true, permanent: false }; }
  if (!parsed || typeof parsed !== "object" || parsed.status === undefined) {
    return { ok: true, permanent: false };
  }
  if (parsed.status !== "error") return { ok: true, permanent: false };
  const err = String(parsed.error ?? "unknown");
  // "edit" = AlterCPA's "nothing to update", i.e. a successful no-op. Retrying
  // it would manufacture permanent false failures on every unchanged resend.
  if (err === "edit") return { ok: true, permanent: false };
  if (probeMode && (err === "no-id" || err === "orderid")) return { ok: true, permanent: false };
  return { ok: false, permanent: POSTBACK_PERMANENT_ERRORS.has(err), error: `api: ${err}` };
}

// String-level SSRF guard for affiliate-supplied postback URLs. The portal's
// PATCH /affiliate/postback validates on save too — this is the backstop that
// also covers URLs written directly by admins.
function isSafePostbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "0.0.0.0" || host === "[::1]") return false;
    if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host.endsWith(".supabase.co") || host.endsWith(".supabase.net")) return false;
    return true;
  } catch {
    return false;
  }
}

function renderPostbackUrl(template: string, ctx: Record<string, string>): string {
  // {stage:a|b|c|d|e|f} — positional custom mapping (AlterCPA convention),
  // values in order lead|hold|approve|cancel|trash|return.
  let out = template.replace(/\{stage:([^}]*)\}/gi, (_m, map: string) => {
    const parts = String(map).split("|");
    const idx = POSTBACK_STAGE_ORDER.indexOf(ctx.stage);
    return encodeURIComponent(idx >= 0 ? (parts[idx] ?? ctx.stage) : ctx.stage);
  });
  // Plain {macro}s — unknown macros stay literal so misspellings are visible
  // in the affiliate's own tracker logs instead of silently vanishing.
  out = out.replace(/\{([a-z][a-z0-9_]*)\}/gi, (m, name: string) => {
    const k = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ctx, k) ? encodeURIComponent(ctx[k]) : m;
  });
  return out;
}

async function drainAffiliatePostbacks(
  client: any,
  batch = 20,
): Promise<{ claimed: number; delivered: number; retried: number; failed: number; skipped: number }> {
  const counters = { claimed: 0, delivered: 0, retried: 0, failed: 0, skipped: 0 };
  const { data: rows, error: claimErr } = await client.rpc("claim_due_affiliate_postbacks", { _batch: batch });
  if (claimErr) {
    console.error("postback drain: claim failed:", claimErr.code);
    return counters;
  }
  if (!rows?.length) return counters;
  counters.claimed = rows.length;

  // Batch-load context for the whole claim (affiliates / leads).
  // The orders table is deliberately NOT loaded here: nothing in a postback
  // may carry orders.display_id, so there is nothing left to read from it.
  const affIds = [...new Set(rows.map((r: any) => r.affiliate_id))];
  const leadIds = [...new Set(rows.map((r: any) => r.affiliate_lead_id).filter(Boolean))];
  const [affRes, leadRes] = await Promise.all([
    client.from("affiliates")
      .select("id, code, status, postback_url, postback_enabled, postback_events, postback_format, altercpa_reason_map")
      .in("id", affIds),
    leadIds.length
      ? client.from("affiliate_leads")
        .select("id, ext_id, clickid, sub1, sub2, sub3, sub4, sub5, offer_id, payout_eur_snapshot, order_id")
        .in("id", leadIds)
      : Promise.resolve({ data: [] }),
  ]);
  const affById = new Map((affRes.data || []).map((a: any) => [a.id, a]));
  const leadById = new Map((leadRes.data || []).map((l: any) => [l.id, l]));

  await Promise.all(rows.map(async (row: any) => {
    const finish = (patch: Record<string, unknown>) =>
      client.from("affiliate_postbacks").update(patch).eq("id", row.id);
    try {
      const aff = affById.get(row.affiliate_id);
      const lead = row.affiliate_lead_id ? leadById.get(row.affiliate_lead_id) : null;
      const isTest = row.event === "test";

      // Skips are policy decisions, not failures — no retry.
      const skip = async (why: string) => {
        counters.skipped++;
        await finish({ status: "skipped", last_error: why });
      };
      if (!aff) return await skip("affiliate missing");
      if (aff.status === "banned") return await skip("affiliate banned");
      if (!aff.postback_url) return await skip("no postback url");
      if (!isTest && !aff.postback_enabled) return await skip("postbacks disabled");
      if (!isTest && aff.postback_events && aff.postback_events[row.event] === false) {
        return await skip("event disabled");
      }
      if (!isSafePostbackUrl(aff.postback_url)) return await skip("unsafe url");
      if (!isTest && !lead) return await skip("lead missing");

      const payout = Number(lead?.payout_eur_snapshot ?? 0) || 0;
      const moneyOn = row.event === "approve";
      const holdOn = row.event === "lead" || row.event === "hold";
      const click = lead?.clickid || (isTest ? "test-click-1" : "");
      const ctx: Record<string, string> = {
        // NEITHER of these may ever render orders.display_id. {id} is THEIR
        // lead id (no fallback — a fallback would silently leak ORD-xxxxx for
        // any lead sent without an ext_id); {oid} is our opaque lead ref.
        id: lead?.ext_id || (isTest ? "TEST-1" : ""),
        oid: lead?.id || (isTest ? "TEST-REF" : ""),
        offer: lead?.offer_id || "",
        stage: isTest ? "test" : row.event,
        status: POSTBACK_STATUS_MAP[row.event] || row.event,
        reason: row.reason || "",
        subid: lead?.clickid || lead?.sub1 || (isTest ? "test-click-1" : ""),
        clickid: click, cuid: click, fbclid: click, gclid: click, ttclid: click,
        cash: (moneyOn ? payout : 0).toFixed(2),
        payout: (moneyOn ? payout : 0).toFixed(2),
        hold: (holdOn ? payout : 0).toFixed(2),
        sub1: lead?.sub1 || "", sub2: lead?.sub2 || "", sub3: lead?.sub3 || "",
        sub4: lead?.sub4 || "", sub5: lead?.sub5 || "",
        currency: "EUR",
        date: new Date().toISOString(),
        rand: crypto.randomUUID().slice(0, 8),
      };
      const isAlterCpa = aff.postback_format === "altercpa";

      let rendered: string;
      if (isAlterCpa) {
        // Their advertiser API takes fixed parameter names, so we build the
        // query ourselves and ignore the URL's macros entirely.
        const base = altercpaBaseUrl(aff.postback_url);
        if (isTest) {
          // A bare call is a genuine auth probe: a valid token answers
          // "no-id" (endpoint reached, key accepted), a bad one answers "key".
          rendered = base;
        } else {
          const params = altercpaParams(
            row.event, lead?.ext_id ?? null, row.reason, aff.altercpa_reason_map,
          );
          if (!params) {
            return await skip(
              lead?.ext_id ? `event '${row.event}' not mapped for altercpa` : "no ext_id for altercpa",
            );
          }
          rendered = `${base}${base.includes("?") ? "&" : "?"}${params.toString()}`;
        }
      } else {
        rendered = renderPostbackUrl(aff.postback_url, ctx);
      }

      // Tracker dedup: an identical rendered URL was already delivered for this
      // lead → skip. Templates using {rand}/{date} opt out.
      // NOT applied to AlterCPA: that is a status API, resends are idempotent
      // (it answers "edit" = nothing changed), and suppressing them would lose
      // a real transition — e.g. confirmed → cancelled → confirmed renders the
      // same accept=1 twice and the partner would never learn about the second.
      if (!isTest && !isAlterCpa && row.affiliate_lead_id) {
        const { data: dupe } = await client
          .from("affiliate_postbacks").select("id")
          .eq("affiliate_lead_id", row.affiliate_lead_id)
          .eq("status", "delivered")
          .eq("rendered_url", rendered)
          .neq("id", row.id)
          .limit(1).maybeSingle();
        if (dupe) {
          counters.skipped++;
          return await finish({ status: "skipped", rendered_url: rendered, last_error: "unchanged" });
        }
      }

      let code: number | null = null;
      let bodyText = "";
      let errText = "";
      try {
        const res = await fetch(rendered, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(10_000),
          headers: { "User-Agent": "ElyonCRM-Postback/1.0" },
        });
        code = res.status;
        try { bodyText = (await res.text()).slice(0, 1024); } catch { bodyText = ""; }
      } catch (e: any) {
        errText = String(e?.message || e).slice(0, 300);
      }

      // A 2xx is necessary but NOT sufficient — the body decides (see
      // classifyPostbackBody).
      const transportOk = code !== null && code >= 200 && code < 300;
      const verdict = transportOk
        ? classifyPostbackBody(bodyText, isAlterCpa && isTest)
        : { ok: false, permanent: false, error: errText || `HTTP ${code}` };

      if (verdict.ok) {
        counters.delivered++;
        return await finish({
          status: "delivered",
          delivered_at: new Date().toISOString(),
          rendered_url: rendered,
          last_response_code: code,
          last_response_body: bodyText,
          last_error: null,
        });
      }
      const failReason = verdict.error || errText || `HTTP ${code}`;

      const attempts = Number(row.attempts) || 1; // claim returns the post-increment value
      if (verdict.permanent || attempts >= POSTBACK_MAX_ATTEMPTS) {
        counters.failed++;
        return await finish({
          status: "failed",
          rendered_url: rendered,
          last_response_code: code,
          last_response_body: bodyText,
          last_error: failReason,
        });
      }
      const delayMin = POSTBACK_BACKOFF_MINUTES[Math.min(attempts, POSTBACK_BACKOFF_MINUTES.length) - 1];
      counters.retried++;
      return await finish({
        status: "pending",
        next_attempt_at: new Date(Date.now() + delayMin * 60_000).toISOString(),
        rendered_url: rendered,
        last_response_code: code,
        last_response_body: bodyText,
        last_error: failReason,
      });
    } catch (e: any) {
      // Never let one row kill the batch; the row stays on its 10-min lease.
      console.error("postback drain: row error:", String(e?.message || e).slice(0, 200));
    }
  }));
  return counters;
}

// Fire-and-forget drain right after a status change / intake so trackers hear
// about events in seconds. On Supabase's runtime EdgeRuntime.waitUntil keeps
// the isolate alive for it; without it the promise still starts and the
// every-minute cron remains the delivery guarantee either way.
function nudgePostbackDrain(client: any) {
  try {
    const p = drainAffiliatePostbacks(client, 5).catch(() => {});
    (globalThis as any).EdgeRuntime?.waitUntil?.(p);
  } catch (_) { /* best-effort */ }
}

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

// Macedonian geo-name normalisation — MIRROR of src/lib/transliterate.ts and
// scripts/lib/mk-translit.mjs. Keep all three in sync (that file header lists
// the contract; src/lib/transliterate.test.ts enforces the .mjs copy).
//
// Deliberately lossy: it folds Cyrillic and Latin, diacritics and digraphs onto
// one key so an agent typing "Gjorce", "Gorce" or "Ѓорче" all reach the same
// settlement, and so MEX's inconsistent transliterations line up with ours.
// Place names ONLY — it merges ц with ч and would produce false hits anywhere else.
const MK_GEO_CYR: Record<string, string> = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','ѓ':'g','е':'e',
  'ж':'z','з':'z','ѕ':'d','и':'i','ј':'j','к':'k','л':'l',
  'љ':'l','м':'m','н':'n','њ':'n','о':'o','п':'p','р':'r',
  'с':'s','т':'t','ќ':'k','у':'u','ф':'f','х':'h','ц':'c',
  'ч':'c','џ':'d','ш':'s',
  'й':'j','щ':'st','ъ':'a','ь':'j','ю':'u','я':'a',
  'ы':'i','э':'e','ё':'e','ђ':'d','ћ':'c','ѐ':'e','ѝ':'i',
};
const MK_GEO_MARKS = /[\u0300-\u036f]/g;
const MK_GEO_DIGRAPHS: Array<[string, string]> = [
  ['dzh','d'],['zh','z'],['sh','s'],['ch','c'],['dz','d'],
  ['dj','d'],['gj','g'],['kj','k'],['lj','l'],['nj','n'],['ts','c'],
];
function normalizeMkGeo(s: string): string {
  if (!s) return '';
  let out = String(s).toLowerCase();
  out = out.split('').map(c => MK_GEO_CYR[c] ?? c).join('');
  out = out.normalize('NFD').replace(MK_GEO_MARKS, '');
  out = out.replace(/ç/g,'c').replace(/đ/g,'d').replace(/ł/g,'l').replace(/ø/g,'o');
  for (const [from, to] of MK_GEO_DIGRAPHS) out = out.split(from).join(to);
  return out.replace(/[^a-z0-9]/g, '');
}

// Strip characters that have meaning in PostgREST's `.or()` filter syntax
// or in LIKE patterns. Defense-in-depth — the Supabase SDK already escapes
// most of these, but we don't want a stray '%' in user input to suddenly
// match every row, and we don't want commas/parens to be interpreted as
// filter separators in our search-string concatenation.
function sanitizeSearch(s: string): string {
  return (s || "").replace(/[%_\\,().]/g, "").trim();
}

// True if the target user holds a privileged role (admin or manager). Used to
// stop a manager from deleting/suspending an admin or a fellow manager — a
// manager may only manage plain agent accounts.
async function targetHasPrivilegedRole(client: any, userId: string): Promise<boolean> {
  const { data } = await client
    .from("user_roles").select("role").eq("user_id", userId)
    .in("role", ["admin", "manager"]).limit(1);
  return !!(data && data.length);
}

// In-memory sliding-window rate limiter for public webhook endpoints.
// 100 requests per 60 seconds per key (slug or IP).
const __webhookRateBuckets = new Map<string, number[]>();
function checkWebhookRateLimit(key: string, limit = 100, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (__webhookRateBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) {
    __webhookRateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  __webhookRateBuckets.set(key, arr);
  return true;
}

// Per-user rate limiter for sensitive authed endpoints. Keyed by
// `${userId}:${endpoint}`. Defaults are deliberately generous — these
// are admin operations performed by humans, not bots, so the limit is
// to protect against runaway scripts and automation accidents, not
// against deliberate denial-of-service.
const __userRateBuckets = new Map<string, number[]>();
function checkUserRateLimit(userId: string, endpoint: string, limit = 30, windowMs = 60_000): boolean {
  const key = `${userId}:${endpoint}`;
  const now = Date.now();
  const arr = (__userRateBuckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= limit) {
    __userRateBuckets.set(key, arr);
    return false;
  }
  arr.push(now);
  __userRateBuckets.set(key, arr);
  return true;
}
