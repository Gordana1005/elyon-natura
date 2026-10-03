# Database — Supabase Postgres, end to end

> Every table, enum, function, trigger, the RLS model, the segment engine, and how data actually
> moves. Project ref **`oufoazmnbwugtfldkwsn`**. ~39 tables, 3 enums, ~18 functions, ~70 migrations in
> [../supabase/migrations](../supabase/migrations). Apply with `npx supabase db push --linked`.

> ⚠️ **The generated types file is stale.** [src/integrations/supabase/types.ts](../src/integrations/supabase/types.ts)
> predates ~10 tables and dozens of columns the backend actively writes (order address granularity,
> cancel/return/confirm fields, call telemetry, courier_offices, customer_profiles, segments,
> personal_list_holds, active_call_views, shift_breaks, bg_settlements). The app mostly uses untyped
> `apiFetch`, so this hasn't broken anything — but **regenerate it** (`npx supabase gen types typescript
> --linked > src/integrations/supabase/types.ts`) before relying on it. This doc is built from the
> migrations and is the accurate picture.

---

## 1. Connection model — who reads/writes the DB

```
Browser ──(anon key, RLS-bound)──► PostgREST           : Auth + get_my_permissions RPC only
Browser ──(JWT)──► Edge Function `api` ──(service role, bypasses RLS)──► Postgres : ~everything else
Scripts ──(service role from .env)──► Postgres          : imports / audits / scrapers
Webhooks ──► Edge Function (no JWT) ──(service role)──► Postgres : inbound leads/orders
```

- The Edge Function builds **two clients**: `supabase` (anon key + caller's JWT, RLS‑bound — used for a
  few reads where row scoping matters) and `adminClient` (service‑role, **bypasses RLS** — used for
  almost all reads/writes because the function does its own role checks). See [BACKEND_API.md](BACKEND_API.md).
- **RLS is enabled on every table** so that even if a token leaks, direct PostgREST access is scoped.
  The service role is the trusted path and is never exposed to the browser.

---

## 2. Enums (`public`)

| Enum | Values | Notes |
|---|---|---|
| `app_role` | `admin · agent · warehouse · ads_admin · manager · pending_agent · prediction_agent` | Started as `('admin','agent')`, expanded over migrations. A user can hold several (rows in `user_roles`). |
| `order_status` | `pending · take · call_again · confirmed · shipped · delivered · returned · paid · trashed · cancelled` | The order state machine. `take` = transient soft‑lock during a live call. |
| `lead_status` | `not_contacted · no_answer · interested · not_interested · confirmed` | For `prediction_leads` (imported lead pool). |

---

## 3. Tables by domain

Legend: **PK** primary key · **FK** foreign key · _italic_ = added by a later migration (not in the stale types.ts).

### 3.1 Orders & fulfilment (the core)

**`orders`** — central table (**80,360 rows** as of 2026-08-05). Columns:
- `id` PK, `display_id` (human ID, auto via trigger), `created_at`, `updated_at`
- Customer: `customer_name`, `customer_phone` (stored `+359…`), `customer_city`, `customer_address`, `postal_code`
- _Granular address (Phase 3+):_ `street`, _`quarter`_, `apartment`, `floor`, `building`, `delivery_instructions`, `gift_note`
- _Delivery (Phase 6):_ `delivery_type` (`home`/`speedy_office`/`econt_office`, default `home`), _`home_courier`_ (`speedy`/`econt`), `courier_office_code`, `courier_office_name`, `courier_office_city`
- Product/value: `product_id` FK→products (nullable), `product_name`, `price` (EUR), `quantity`
- Status: `status` (enum), `birthday`, `ship_after_date` (postpone date)
- Assignment: `assigned_agent_id`, `assigned_agent_name`, `assigned_at`, `assigned_by`
- Source: `source_type` (`manual`/`inbound_lead`/`opencart`/`opencart_abandoned`), `source_lead_id` FK→prediction_leads, `inbound_lead_id` FK→inbound_leads, _`external_source`_, _`external_order_id`_ (OpenCart dedupe key)
- _Termination reasons:_ `cancellation_reason`, `cancellation_reason_notes`, `cancelled_at`, `cancelled_by_agent_id`; `return_reason`, `return_reason_notes`, `returned_at`
- _Attribution (2026‑05‑22):_ `confirmed_by_agent_id`, `confirmed_by_name`, `confirmed_at` — credits whoever turned the lead into a real order; analytics key off this.

**`order_items`** — line items: `order_id` FK, `product_id` FK (nullable — legacy imports are null), `product_name`, `quantity`, `price_per_unit`, `total_price`. Drives stock decrement.

**`order_notes`** — `order_id`, `text`, `author_id`, `author_name`. Import provenance (`Imported from …`) stays here; `cleanNoteForDisplay()` strips it only on render. System notes use `author_name='System'`.

**`order_history`** — append‑only audit of every status change: `order_id`, `from_status`, `to_status`, `changed_by`, `changed_by_name`, `changed_at`. Analytics use this (not `updated_at`) to know what changed "today".

**`order_locks`** — pessimistic lock when an order is opened for edit. Cleaned by `cleanup_expired_order_locks()`.

### 3.2 Catalogue & inventory

**`products`** — `name`, `description`, `sku` (auto via trigger if null), _`barcode`_ (EAN, partial‑unique), `price` (EUR retail = agent default selling price), `cost_price` (EUR, admin‑only), `stock_quantity`, `low_stock_threshold` (default 5), `category`, `supplier_id` FK, `photo_url`, `is_active`. **55 active items.** SKU = internal panel SKU (e.g. `NT0095…`), **not** the barcode (4 products keep barcode‑as‑sku) — see [PRODUCTS_STOCK_WAREHOUSE.md](PRODUCTS_STOCK_WAREHOUSE.md).

**`inventory_logs`** — every stock change: `product_id`, `change_amount` (±), `previous_stock`, `new_stock`, `reason` (`order_deduction`/`order_return`/`bigarena_import`/`manual`/`restock`/`manual_adjust`), `movement_type`, `user_id`, `supplier_name`, `invoice_number`, `notes`.

**`suppliers`** — `name`, `contact_info`, `email`, `phone`, `address`.

### 3.3 Leads, prediction lists & the segment engine

**`prediction_lists`** — uploaded lead lists (XLSX): `name`, `total_records`, `assigned_count`, `uploaded_by`.

**`prediction_leads`** — the imported lead pool: `list_id` FK, `name`, `telephone`, `address`, `city`, `product`, `price`, `quantity`, `status` (`lead_status`), `assigned_agent_id/name`, `notes`.

**`prediction_lead_items`** — line items per lead (mirror of order_items).

**`inbound_leads`** — raw inbound webhook payloads: `name`, `phone`, `status` (`pending`/`contacted`/`converted`/`rejected`), `source`, `webhook_id` FK, `product_name` (denormalised from the webhook). An order is auto‑created alongside each.

**`prediction_segment_lists`** — the **27 rule definitions** (not member rows). Columns: `name` (unique), `description`, `category` (`value`/`prestige`/`cancel`/`return`/`other`), `trigger_event` (`last_paid`/`last_cancelled`/`last_returned`), `recency_months_min/max`, `single_price_min/max`, `min_paid_count`, `lifetime_min`, `is_active`, `display_order`. Boundaries are inclusive‑lower/exclusive‑upper. "Premium" lists match if the **price band OR the paid‑count** threshold is met.

**`prediction_segment_members`** — computed membership: PK `(list_id, customer_phone)`, plus `customer_name`, `trigger_order_id`, `trigger_event_at`, `trigger_price`, `last_paid_at`, `paid_count`, `lifetime_value`, `assigned_agent_id/name/at`, `last_call_at`, `last_call_outcome`, `in_call_again_until`, `is_completed`. **This is the agent calling queue source** (see `call-again-queue`, `useMyQueue`). One **calling** list per phone, EXCEPT **`Current Returns`** (engine v3.3) which is **additive + UNASSIGNED**: a customer whose newest order is a return is tracked there *in addition to* their normal band (excluded from the one‑list‑per‑phone nuclear delete + carry‑over + audit exclusivity check).

**`lead_distribution_config`** — single‑row config for auto‑assign: `strategy` (`round_robin`/`load_balance`/`priority`), `is_active`, `max_leads_per_agent`, `priority_threshold`, `updated_by`. ⚠️ Its API handlers have a `userId` bug — see [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md).

> **The 27 segments** (seeded in `20260508000000_prediction_segments.sql`): value tier × recency
> (1‑3m / 3‑6m / 6‑12m / 1y+) × price band (`$50+`, `$100+`, `Premium`) = 12; prestige `$300+` × 3
> recencies = 3; cancel × 4 recencies = 4; return × 4 recencies = 4; low `<$50` × 4 recencies = 4.

### 3.4 Calling & agents

**`call_logs`** — one row per dial: `agent_id`, `context_type` (`order`/`prediction_lead`), `context_id`, `outcome`, `notes`, _telemetry:_ `started_at`, `connected_at`, `ended_at`, `ring_seconds`, `talk_seconds`, `total_seconds`, `customer_phone`, `connection_state` (`answered`/`no_answer`/`busy`/`failed`/`voicemail`). `outcome` is free‑text in the column; the app uses a fixed set (`no_answer`/`interested`/`not_interested`/`wrong_number`/`call_again`/`confirmed`/`cancelled`/`trash`). The two‑level Answered/Not‑answered picker is a UI layer over these.

**`call_scripts`** — one row per `context_type`: `script_text`, `updated_by`.

**`active_call_views`** — heartbeat‑based soft lock: while an agent has a customer open, a row keeps the customer's pending/call_again orders flipped to `take`; `cleanup_expired_active_call_views()` reverts after ~2 min of no heartbeat.

**`personal_list_holds`** — an agent "claims" a customer for personal follow‑up: `agent_id`, `customer_phone`, `reason`, `follow_up_by`, `claimed_at`, `expires_at`, `escalated_at`, `status`. Helpers `escalate_expired_personal_list_holds()`, `count_expired_personal_list_holds()`.

### 3.5 Shifts & presence

**`shifts`** (`name`, `date`, `start_time`, `end_time`, `created_by`), **`shift_assignments`** (`shift_id`, `user_id`), **`shift_templates`** (reusable shift defs), **`shift_login_logs`** (`user_id`, `shift_id`, `shift_date`, `login_time`, `logout_time`, `shift_start/end_time`), _**`shift_breaks`**_ (pause within a shift). Presence: _`profiles.last_seen_at`_ bumped by the `presence/heartbeat` endpoint (2‑min "online" window), which also records the browser‑reported softphone state in _`profiles.voip_state`_ / _`voip_state_at`_ (3‑min staleness window → the `in_call` flag on `agents/online` and `operations-center`).

### 3.6 Auth, roles & permissions

**`profiles`** — one per `auth.users`: `user_id`, `full_name`, `email`, `is_active`, `language`, _`last_seen_at`_, _`voip_state`_ (`text NOT NULL DEFAULT 'idle'`, CHECK `idle|dialing|in_call|wrapping|ending`), _`voip_state_at`_ (`timestamptz`). Auto‑created by the `handle_new_user` trigger on signup. The two `voip_*` columns are written only by the edge function's service‑role client, from the presence heartbeat.

**`user_roles`** — `(user_id, role)` many‑to‑many.

**`role_permissions`** — per‑role module grants: `role`, `module_key`, `can_view/create/edit/delete/export`.

**`module_settings`** — feature flags: `module_key`, `module_label`, `is_enabled`, `is_protected`.

**`financial_visibility`** — per‑role money visibility: `show_profit`, `show_net_contribution`, `show_cost`, `show_returned_value`, `show_financial_insights`.

**`audit_log`** — **tamper‑evident**, append‑only: `actor_id`, `actor_email`, `action`, `target_type/id/name`, `payload` (JSON). Triggers `audit_log_block_update`/`_delete` raise on any mutation — even the service role can't edit/delete rows.

**`blocked_login_attempts`** — failed‑login rate‑limit ledger.

### 3.7 Couriers & addresses

**`courier_offices`** — Speedy + Econt branch cache (~1888 active): `courier`, `office_code`, `name`, `city`, `city_normalized` (Latin), `address`, `hours`, `lat`, `lng`, `is_active`, _`post_code`_. Refreshed by `scripts/scrape-courier-offices.mjs`.

**`bg_settlements`** — Bulgarian cities/villages from Econt: `id`, `name`, `name_en`, `post_code`, `region`, _`municipality`_. Backs the order‑form city autocomplete; street/quarter suggestions are fetched live from Econt and cached in‑memory by the function.

**`customer_profiles`** — per‑phone saved info (independent of orders): `phone` (key), `customer_name`, `birthday`, address fields (`street`, _`quarter`_, `apartment`, `floor`, `building`, `city`, `postal_code`), delivery prefs (`delivery_type`, _`home_courier`_, `courier_office_*`, `delivery_instructions`, `gift_note`), and `notes` (the persistent "About this customer" note on the Calls strip).

### 3.8 Marketing & misc

**`webhooks`** — one row per landing‑page endpoint: `slug` (unique, URL‑safe), `product_name`, `status` (`active`/`disabled`), `total_leads`, `created_by`, `description`. **55 active.**

**`ads_campaigns`** + **`ads_audit_logs`** — ads module (separate from the call‑centre core).

**`notifications`** — in‑app notifications: `user_id`, `title`, `message`, `type`, `link`, `is_read`, `meta`.
`title`/`message` are written in **English** by the DB triggers/jobs. `meta` (jsonb, 2026‑09) optionally carries `{ i18n: 'notif.<key>', ...vars }` so the bell renders the row in the reader's own language, falling back to the stored English when a locale key is missing. `meta IS NULL` = legacy row, rendered verbatim.
Types in use: `missed_call`, `order_returned`, `order_paid`, `low_stock`, `shipped_unpaid`, `unpaid_digest`.

**`order_unpaid_alerts`** — append‑only ledger of unpaid‑delivery chase pings: `order_id`, `alert_date` (Europe/Sofia day), `days_shipped`, `owner_id`. PK `(order_id, alert_date)` is what makes the daily job idempotent. **Internal only** — RLS on with zero policies *and* all grants revoked from `PUBLIC`/`anon`/`authenticated`; only the SECURITY DEFINER job and `service_role` can reach it.

**`user_warehouse`** — assigns product stock to a warehouse user: `user_id`, `product_id`, `quantity`, `notes`.

---

## 4. Functions (`public`)

| Function | Purpose | Security |
|---|---|---|
| `has_role(_user_id, _role) → bool` | Role check without RLS recursion — foundation of every policy | SECURITY DEFINER |
| `is_admin_or_manager(_user_id) → bool` | The most common gate | SECURITY DEFINER |
| `get_my_role() → app_role` | Current user's primary role from JWT | DEFINER |
| `get_my_permissions() → json` | Bundles modules + role_permissions + financial_visibility for the frontend bootstrap | DEFINER |
| `handle_new_user()` | Signup trigger → creates `profiles` row (+ initial role) | DEFINER |
| `admin_grant_all_roles()` | Trigger fn — grants every non‑admin role to any admin user (so admins can act as agent/warehouse) | DEFINER |
| `generate_order_display_id()` | Human order ID on insert | — |
| `generate_product_sku()` | SKU on product insert when null | — |
| `recompute_customer_segments(_phone)` | Reclassify ONE phone into the 27 lists from order history | DEFINER |
| `recompute_all_segments() → int` | Full rebuild across all customers (bootstrap / on‑demand) | DEFINER, service_role only |
| `trg_orders_recompute_segments()` | Trigger fn driving the above on order changes | DEFINER |
| `assignment_matrix()` | Who holds what: `(agent_id, list_id, members_assigned, members_open)` over `prediction_segment_members WHERE assigned_agent_id IS NOT NULL`. **Deliberately has no `is_completed` filter** — that is what surfaces done‑only lists in the Assigner's Unassign tab. Feeds `GET /assigner/assignment-summary`. | DEFINER, service_role only |
| `assigned_pending_counts()` | Per‑agent count of assigned `status='pending'` orders (the leads side of the same summary) | DEFINER, service_role only |
| `agent_workloads()` | Per agent: `orders_open` (assigned orders in `pending\|take\|call_again`) + `members_assigned/open/parked`. Powers the Assigner agent cards' "Clients to call" tile in one aggregate instead of an unbounded select. | DEFINER, service_role only |
| `bulk_last_calls(p8s text[])` | Latest real `call_logs` row per last‑8 phone — overlays `real_last_call_*` onto member tables at read time | DEFINER |
| `orders_set_cancelled_at()` | Trigger fn — stamps `cancelled_at = now()` when an order enters `cancelled` without one (NULL‑only; explicit code‑set values win) | — |
| `orders_set_returned_at()` | Trigger fn — stamps `returned_at = now()` when an order enters `returned` without one (NULL‑only; same pattern as cancelled_at) | — |
| `cleanup_expired_order_locks()` | Drop stale `order_locks` | — |
| `cleanup_expired_active_call_views()` | Revert stale `take` locks | — |
| `escalate_expired_personal_list_holds()` / `count_expired_personal_list_holds()` | Personal‑list expiry handling | — |
| `check_phone_duplicates(_phone, _exclude_order_id)` | Find suspected duplicate customers by phone | — |
| `audit_log_no_mutation()` | Raises on any UPDATE/DELETE of `audit_log` | — |
| `update_updated_at_column()` | Generic `updated_at = now()` trigger fn | — |
| `notify_unpaid_shipped_orders(_force, _dry_run) → int` | Daily unpaid‑delivery chase: one notification per stale shipped order to the owning agent (`confirmed_by ?? assigned`) + one digest per superadmin. Idempotent via `order_unpaid_alerts`. `_force` skips the 09:00–11:00 Sofia gate, `_dry_run` writes nothing. | DEFINER, **EXECUTE revoked from PUBLIC/anon/authenticated** |

### pg_cron jobs

| Job | Schedule | Runs |
|---|---|---|
| `nightly-segment-recompute` | `0 0 * * *` | `recompute_all_segments()` |
| `reconcile-recording-links` | `*/10 * * * *` | `reconcile_recording_links(12)` |
| `unpaid-delivery-chase` | `0 * * * *` | `notify_unpaid_shipped_orders()` — self‑gated to 09:00–11:00 Europe/Sofia, so hourly ticks are cheap no‑ops and a missed 09:00 heals at 10:00 |

---

## 5. Triggers (key ones)

| Trigger | On | Effect |
|---|---|---|
| `on_auth_user_created` | INSERT `auth.users` | `handle_new_user()` → create profile |
| `trg_admin_grant_all_roles` | INSERT/UPDATE `user_roles` | grant all roles to admins |
| `trg_order_display_id` / `trigger_generate_order_display_id` | BEFORE INSERT `orders` | display_id |
| `set_product_sku` | BEFORE INSERT `products` | sku |
| `trg_orders_segments_insert` / `_delete` / `_status` | INSERT/DELETE/UPDATE(status,price,phone) `orders` | reclassify the customer's segments |
| `trg_orders_set_cancelled_at` | BEFORE INSERT/UPDATE(status) `orders` | stamp `cancelled_at` when a row enters `cancelled` (guarantees it on every path: synthetic‑cancel creation, status PATCH, BigArena/lead sync) |
| `trg_orders_set_returned_at` | BEFORE INSERT/UPDATE(status) `orders` | stamp `returned_at` when a row enters `returned` (guarantees it on every path, incl. BigArena warehouse sync) |
| `audit_log_block_update` / `_block_delete` | UPDATE/DELETE `audit_log` | RAISE — append‑only |
| `trg_*_updated_at` / `update_*_updated_at` | BEFORE UPDATE (most tables) | bump `updated_at` |

The segment‑status trigger is guarded (`WHEN status/price/phone IS DISTINCT`) so trivial updates don't
fire a reclassify.

---

## 6. RLS model

Every table has RLS enabled. The recurring pattern (example, `prediction_segment_members`):

```sql
-- Agents see only what's assigned to them; admins/managers see all
CREATE POLICY "Agents see assigned members" ON public.prediction_segment_members
  FOR SELECT USING (assigned_agent_id = auth.uid() OR public.is_admin_or_manager(auth.uid()));
CREATE POLICY "Admins/Managers manage members" ON public.prediction_segment_members
  FOR ALL USING (public.is_admin_or_manager(auth.uid())) WITH CHECK (public.is_admin_or_manager(auth.uid()));
```

Because the Edge Function uses the **service role** for most queries, RLS is mainly a **defence‑in‑depth
backstop** (the function re‑checks roles in code for every privileged route). The browser's direct
PostgREST access (Auth + `get_my_permissions` RPC) is the path RLS actively governs day‑to‑day.

Security hardening is split across `20260506140000_security_hardening_batch_a.sql`,
`…_get_my_permissions_rpc.sql`, `…_seed_default_permissions.sql`, `…_lock_down_permissions_tables.sql`,
and `…_audit_log.sql`. See [SECURITY.md](SECURITY.md).

---

## 7. Storage buckets

**None configured yet.** The `call-recordings` bucket is planned for VOIP Phase 2 (recording storage)
— see [CALLING_PLAN_SIP.md](CALLING_PLAN_SIP.md). Product photos use `products.photo_url` (external URL),
not Storage.

---

## 8. Migrations — how they're managed

- Files: `supabase/migrations/YYYYMMDDHHMMSS_<slug>.sql`, **forward‑only**.
- Apply: `npx supabase db push --linked` (needs `SUPABASE_ACCESS_TOKEN` exported — see [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md)).
- New: `npx supabase migration new <name>`.
- Applied set is tracked in `supabase_migrations.schema_migrations`. If `db push` complains about
  ordering, `npx supabase migration repair --status reverted <timestamp>` then retry.
- **Never** `npx supabase db reset --linked` on production.

The migration history (early Feb 2026 schema → security hardening → segments → couriers → telemetry →
customer profiles → settlements → confirmer attribution → office post codes) is a faithful timeline of
the product's evolution; reading them in order is the fastest way to understand "why is this column here".

---

## 9. Known database weak spots (summary — full list in the Audit)

- **Stale `types.ts`** (section above) — regenerate.
- **`orders/stats` endpoint isn't paginated** → 1000‑row truncation on a >1000‑order range.
- **N+1 stock queries** in the shipped/returned loops (fine at current volume, not at 10×).
- **`lead_distribution_config` PATCH / auto‑assign** reference an undefined `userId` → 500.
- **No DB‑level uniqueness** on `orders.customer_phone` (intentional — customers are virtual), so
  duplicate detection is heuristic (`check_phone_duplicates`, `find-shared-phones.mjs`).

See [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md).
