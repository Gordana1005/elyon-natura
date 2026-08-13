# Backend API — the Edge Function

> One Deno file, **[../supabase/functions/api/index.ts](../supabase/functions/api/index.ts)** (~14,900
> lines), is the entire REST surface. It's dispatched off URL path segments. The frontend never builds
> URLs by hand — it calls thin wrappers in **[../src/lib/api.ts](../src/lib/api.ts)**. Base URL:
> `${VITE_SUPABASE_URL}/functions/v1/api`.

Deploy: `npx supabase functions deploy api --project-ref bmfxhgznttcnnlqloqzp` (export `SUPABASE_ACCESS_TOKEN` first — see [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md)).

---

## 1. Request lifecycle

```
serve() ──► pickAllowedOrigin(origin)        # CORS scoping decided up front
        ──► handleRequest(req):
              • OPTIONS → 204 + CORS headers
              • build adminClient (service role) + supabase (anon + caller JWT)
              • path = pathname without /api/ prefix; segments = path.split('/')
              • PUBLIC webhooks first (no auth): webhook/leads, webhook/:slug, webhook/opencart
              • else: require Bearer JWT → getClaims() → load user_roles → role flags
              • match method+path → handler → json(...)
              • catch → 500 "Internal server error"
        ──► attach Access-Control-Allow-Origin only if origin allow-listed
```

**Two Supabase clients per request:**
- `adminClient` = service role, **bypasses RLS**. Used for nearly all reads/writes; the function does
  its own role checks first.
- `supabase` = anon key + the caller's `Authorization` header, **RLS‑bound**. Used where row scoping
  should apply even server‑side (e.g. `GET /orders` for a plain agent, single‑order GET).

**Auth:** `verify_jwt = false` in [../supabase/config.toml](../supabase/config.toml) — Supabase does
**not** gate the function; the function calls `supabase.auth.getClaims(token)` itself. No token → 401.
Roles are loaded from `user_roles` into flags: `isAdmin`, `isManager`, `isAgent` (agent|pending|prediction),
`isWarehouse`, `isAdsAdmin`, `isAdminOrManager`, `isDualRole` (admin+agent).

---

## 2. CORS

`ALLOWED_ORIGINS` = `elyoncall.com`, `www.elyoncall.com`, `elyoncrm.vercel.app`, `localhost:8080/5173/3000`,
plus a regex for Vercel preview deploys (`elyoncrm-<hash>-gordanas-projects-….vercel.app`). The
`Access-Control-Allow-Origin` header is echoed **only** for matching origins; server‑to‑server callers
(webhooks, no `Origin`) skip CORS and are gated by HMAC instead.

> **Adding a new frontend domain requires editing `ALLOWED_ORIGINS` AND redeploying the function.**
> Frontend‑only changes do nothing — symptom is "every API call CORS‑errors, pages spin forever".

---

## 3. Public webhooks (no JWT — HMAC‑gated)

Handled before auth. Each verifies `x-webhook-signature: hex(HMAC_SHA256(rawBody, WEBHOOK_SECRET))`
via `verifyWebhookSignature()` and is rate‑limited (`checkWebhookRateLimit`, 100 req / 60 s per key).

| Method · Path | Purpose |
|---|---|
| `POST /webhook/leads` | Legacy global landing‑page endpoint. Inserts `inbound_leads` + a `pending` order with `product_name="From Landing Page"`. |
| `POST /webhook/:slug` | Per‑product landing‑page endpoint. Looks up the `webhooks` row by slug, inserts `inbound_leads` (denormalising `product_name`) + a `pending` unassigned order, increments `total_leads`. |
| `POST /webhook/opencart` | naturatherapy.bg order bridge. Idempotent upsert on `(external_source, external_order_id)`; matches items to catalogue by sku/barcode/name; converts BGN→EUR; handles abandoned‑cart leads. |

> If `WEBHOOK_SECRET` is unset the function **logs a warning and accepts unsigned bodies** — never leave
> it unset in production. Full request/response shapes: [WEBSITES_WEBHOOKS.md](WEBSITES_WEBHOOKS.md).

---

## 4. Endpoint catalogue (authenticated)

Gate legend: 🔓 any authed user · 👤 owner/agent‑scoped · 🛡️ admin/manager · 📦 +warehouse · 🅰️ ads_admin.
"Stock" = touches `products.stock_quantity` + `inventory_logs`.

### Users & presence
| Method · Path | Gate | Purpose |
|---|---|---|
| `POST /users/create` | 🛡️ | Create auth user + profile + roles (rate‑limited 10/min) |
| `PUT /users/:id/roles` | 🛡️ | Replace a user's role set |
| `PATCH /users/:id/role` | 🛡️ | Set single role |
| `POST /users/:id/toggle-active` | 🛡️ | Enable/disable login |
| `DELETE /users/:id` | 🛡️ | Delete user (auth + profile + roles) |
| `GET /users` · `GET /users/agents` | 🛡️ | List users / agents |
| `POST /presence/heartbeat` | 🔓 | Bump `profiles.last_seen_at` (every ~45 s). Optional body `{voip_state}` (`idle\|dialing\|in_call\|wrapping\|ending`, whitelist‑validated) also writes `profiles.voip_state` + `voip_state_at`. Body is optional — legacy empty‑body beats still work, and an omitted `voip_state` leaves the columns untouched (multi‑tab safety). |
| `GET /agents/online` | 🛡️ | Online agents (2‑min window) + load + today's shift. Also returns `in_call: boolean` and `voip_state` (forced to `'idle'` unless in call), where **`in_call` = `is_online` AND `voip_state ∈ {dialing,in_call}` AND `voip_state_at` younger than 3 min** (staleness guard so a crashed tab self‑clears). Browser‑self‑reported, *not* PBX‑derived. |
| `GET /me` | 🔓 | Current user + roles |

### Orders
| Method · Path | Gate | Purpose |
|---|---|---|
| `POST /orders` | 🔓 (agents auto‑assign to self) | Create order; credits `confirmed_by_*` if status is a real order. **No stock change.** |
| `GET /orders` | 👤/🛡️ | Paginated list; filters status/agent/source/date/price/search; adds `is_owned` + `last_action_by` |
| `GET /orders/:id` | 👤 | Single order (RLS‑bound `supabase` client) |
| `GET /orders/unassigned-pending` · `/orders/assigned` | 🛡️ | Assigner feeds |
| `POST /orders/bulk-assign` · `/orders/bulk-unassign` | 🛡️ | Bulk (un)assign (audited, rate‑limited) |
| `POST /orders/bulk-status-update` | 📦 | **Bulk flip** (shipped/paid/cancelled/returned). **Stock** on shipped/returned. Used by the Fulfilment CSV auto‑flip. |
| `PATCH /orders/:id/status` | 👤/📦 | Single status change. **Stock** on shipped/returned. Requires name/phone/city/address for terminal statuses. Syncs linked inbound lead. |
| `PATCH /orders/:id/customer` | 👤 | Edit customer/address/delivery fields |
| `POST /orders/:id/assign` | 🛡️ | Assign one order |
| `POST/PUT /orders/:id/items` · `PATCH/DELETE /order-items/:id` | 👤 | Item CRUD; recomputes order total; locked once shipped/paid/delivered |
| `POST /orders/:id/notes` | 👤 | Add a note |
| `GET /orders/stats` | 🔓 | Status/agent/day counts. ⚠️ **not paginated → 1000‑row truncation** (Audit) |

### Analytics
| Method · Path | Gate | Purpose |
|---|---|---|
| `GET /dashboard-stats?period=&agent_id=` | 👤/🛡️ | Per‑agent or org KPIs (leads/deals/value/calls/products) — paginated |
| `GET /ceo-dashboard-stats?period=&from=&to=&agent_id=` | 🛡️ | Revenue/profit/funnel/agent rankings/risk alerts/today snapshot — paginated |
| `GET /agent-performance?from=&to=&…` | 🛡️ | Per‑agent conversion/shipment/collection/return rates, profit, net contribution |
| `GET /management-insights?from=&to=` | 🛡️ | The big one: revenue (SOLD basis), AOV, by product/city/delivery/source, returns, cancellations, calls, profit, stock cover — all paginated |
| `GET /operations-center` | 🛡️ | Today's live ops board (KPIs + online agents + activity). Agent rows carry `is_online` and `in_call` — same 2‑min presence / 3‑min call‑staleness rule as `GET /agents/online`. |
| `GET /recent-activity` | 🔓 | Recent activity feed |

> Metric definitions (SOLD vs PAID, conversion, etc.): [INSIGHTS_ANALYTICS.md](INSIGHTS_ANALYTICS.md).

### Products, suppliers, stock
| Method · Path | Gate | Purpose |
|---|---|---|
| `GET /products` | 🔓 | Catalogue + suggested selling price (cost×3 floor €15; agent default = retail) |
| `POST /products` · `PATCH /products/:id` | 🛡️ | Create/update |
| `GET /products/:id/inventory-logs` | 🛡️ | Stock history for a product |
| `GET /suppliers` · `POST` · `PATCH/:id` · `DELETE/:id` | 🛡️ | Supplier CRUD |
| `POST /restock` | 🛡️ | **Stock** increment + log |
| `GET /stock-movements` | 🛡️ | Inventory log feed |

### Calls
| Method · Path | Gate | Purpose |
|---|---|---|
| `GET /call-scripts` · `GET /call-scripts/:type` · `PATCH /call-scripts/:type` | 🔓 / 🛡️ | Call scripts |
| `POST /call-logs` | 🔓 | **Log a call.** Applies outcome→order status (`applyOutcomeToOrder`) for `order` context, or auto‑updates `prediction_leads.status` for `prediction_lead`. Stores telemetry. |
| `GET /call-history` | 👤/🛡️ | Enriched, paginated call log with customer + order/lead context |
| `GET /call-logs/:type/:id` | 🔓 | Calls for one context |
| `GET /customers/:phone/history` | 🔓 | Full dossier: every order + every call for a phone (last‑8 normalised) |
| `POST /active-call-views/heartbeat` · `DELETE /active-call-views/by-phone/:phone` · `GET /active-call-views/lookup` | 👤 | The TAKE soft‑lock |
| `GET /call-again-queue?mine=` | 👤 | Customers due a follow‑up call |

### Personal list (agent claims)
`POST /personal-list`, `GET /personal-list`, `GET /personal-list/lookup`, `GET /personal-list/expiring`,
`GET /personal-list/expiring-count`, `POST /personal-list/:id/extend`, `DELETE /personal-list/:id` — 👤.

### Shifts
`POST/GET /shifts`, `GET /shifts/my`, `POST /shifts/break/start|end`, `GET /shifts/break/active`,
`PATCH/DELETE /shifts/:id`, `GET /shifts/check-login`, `POST /shifts/login-log`, `PATCH /shifts/logout-log`,
`GET /shifts/statistics`, `GET /shifts/login-activity`; templates: `GET/POST /shift-templates`,
`PATCH/DELETE /shift-templates/:id`, `POST /shift-templates/assign-week`. Mix of 👤 and 🛡️.

### Warehouse
`GET /warehouse/incoming-orders`, `PATCH/DELETE /warehouse/incoming-orders/:id`,
`GET/POST /warehouse/user-items`, `PATCH/DELETE /warehouse/user-items/:id` — 📦/🛡️.

### Prediction lists / leads
`GET/POST /prediction-lists`, `GET /prediction-lists/:id`, `POST /prediction-lists/:id/assign`;
`GET /prediction-leads/my`, `POST /prediction-leads/:id/items`, `PATCH/DELETE /prediction-lead-items/:id`,
`POST /prediction-leads/unassign`, `POST /prediction-leads/:id/take`, `PATCH /prediction-leads/:id`.

### Segments (rule‑driven lists)
`GET /segments`, `GET /segments/:id` (paginated members; filters `?assigned=none|all|<agent_id>` and
`?completed=yes|no` — the Assigner's expandable per‑agent rows call it with `assigned=<agent_id>` and
*no* `completed` so already‑called members show too; additionally gated by the `show_segment_members`
privilege → **403** for managers without it), `POST /segments/:id/assign` (`agent_id: null` = unassign,
works on done rows, max 5000 phones), `POST /segments/:id/auto-assign` (shuffle + round‑robin across
agents, optional `limit`/`fraction`), `POST /segments/:id/bulk-unassign` (one list; `scope='all'` or an
agent id; **no `is_completed` filter — clears done rows too**), `PATCH /segments/:id` (edits rules →
`recompute_all_segments`), `POST /segments/recompute` — all 🛡️.

### Assigner (cross‑list mass distribution)
| Method · Path | Gate | Purpose |
|---|---|---|
| `GET /assigner/assignment-summary` | 🛡️ | Who holds what, per agent × list: one `assignment_matrix()` + `assigned_pending_counts()` round‑trip, joined to names. Returns `agents[{agent_id, full_name, assigned_total, open_total, pendings_total, lists[{list_id, list_name, assigned, open}]}]` + `totals`. |
| `POST /assigner/unassign-all` | 🛡️ | Mass unassign. Body `{agent_id:'all'\|<uuid>, list_ids?, include_pendings?, include_done?}`. Rate‑limited `assigner.unassign` 20/min, audited as `assigner.unassign_all` (payload includes `include_done` + the pre‑wipe per‑agent breakdown — the only record of what was released). |

`POST /assigner/unassign-all` semantics — nulls **only** `assigned_agent_id`/`assigned_agent_name`/`assigned_at`:

- **default (no `include_done`)** — frees only `is_completed = false` members; already‑called rows keep their stamp (original 2026‑07‑22 contract, kept for compatibility).
- **`include_done: true`** — also clears the stamp on done rows, so the `(agent, list)` pair disappears from `assignment_matrix()` and the list fully detaches from the agent's profile. **The Unassign tab always sends this** (operator decision 2026‑07‑28). `is_completed`, `last_call_*`, `in_call_again_until`, `call_logs` and sales credit (`confirmed_by_*`) are never touched.
- **`include_pendings: true`** — additionally frees the agent's `status='pending'` orders (4 columns, same as `/orders/bulk-unassign`). Strictly `pending`: `take`/`call_again` mean the agent already engaged. Server‑ignored when `list_ids` is present, since pendings are not list‑scoped.

### Lead distribution
`GET /lead-distribution-config`, `PATCH /lead-distribution-config`, `POST /lead-distribution/auto-assign`,
`GET|PUT /lead-distribution/rules`, `GET|PUT /lead-distribution/participants` — 🛡️ admin/manager.

The engine itself is **SQL, not TypeScript** (migration `20260921000000_lead_distribution_engine.sql`):
`distribute_pending_leads(_limit, _dry_run, _source)` → `pick_agent_for_lead(_order_id, _extra_load)` →
`assign_one_lead(_order_id, _by)`, with `lead_distribution_candidates()` supplying eligibility, load and
presence. It was moved out of the edge function on 2026‑08‑13: the PostgREST 1000‑row cap silently
truncated both the candidate pull and the load tally, the `round_robin` branch dropped the rest of a
batch once one agent filled up, the candidate query had **no lead‑source filter**, and a per‑order
UPDATE loop timed out before any real backlog drained.

- `GET /lead-distribution-config` also returns `waiting_leads`, `assigned_today`, `last_meaningful_run`
  and the live `candidates[]`, so the page can say *why* a run assigned nothing.
- `POST /lead-distribution/auto-assign` body `{limit?, dry_run?}`. `dry_run: true` previews the split
  (simulating load as it goes) and writes nothing.
- Continuous operation is `lead_distribution_config.is_active` + the `trg_orders_auto_distribute`
  AFTER INSERT trigger + the `lead-auto-distribute` pg_cron job (every minute).

*(The old `undefined userId` → 500 defect was fixed 2026‑05‑23; the handlers now use `user.id`.)*

### Couriers & addresses
`GET /courier-offices/cities?courier=&q=`, `GET /courier-offices?courier=&city=`,
`GET /courier-offices/match?courier=&q=` (free‑text → ranked offices), `GET /courier-offices/by-code`,
`GET /address/settlements?q=` (bg_settlements), `GET /address/streets?settlement_id=&q=` (live Econt, cached).

### Customer profile & intelligence & search
`GET /customer-profile?phone=`, `POST /customer-profile`, `POST /customer-profile/notes`,
`GET /customer-intelligence?phone=` (dossier, quality score, recommendations, timeline),
`GET /search-prediction?q=` (orders + leads + history, last‑8 phone match).

### Webhooks admin, inbound leads, ads
`GET/POST /webhooks`, `PATCH/DELETE /webhooks/:id`; `GET /inbound-leads`, `PATCH/DELETE /inbound-leads/:id`;
`GET/POST /ads-campaigns`, `PATCH/DELETE /ads-campaigns/:id`.

---

## 5. Stock decrement — exactly where it lives

Stock changes happen in **two endpoints, four code blocks** (not on order creation):

| Where | Trigger | Effect |
|---|---|---|
| `PATCH /orders/:id/status` → `shipped` | single | decrement each item (checks availability, 400 if short) + `inventory_logs reason=order_deduction` |
| `PATCH /orders/:id/status` → `returned` | single | increment each item + `reason=order_return` |
| `POST /orders/bulk-status-update` → `shipped` | bulk | same as above; insufficient‑stock orders are **skipped** (not failed) |
| `POST /orders/bulk-status-update` → `returned` | bulk | restore stock |

Both handle **multi‑product** (`order_items` rows) and the **legacy single‑product** fallback
(`orders.product_id`). **Only fires when a `product_id` exists** — the 14k legacy import items are null
and intentionally skipped. The loops do one query per item (N+1 — acceptable now, see Audit).

> CLAUDE.md says stock decrement is in "4 places incl. `POST /orders`". That's slightly off: **`POST /orders`
> does not change stock** (you can't create an order as `shipped`). It's 2 endpoints / 4 blocks. (Audit.)

---

## 6. Outcome → order‑status mapping

`applyOutcomeToOrder()` is the single source of truth used by `POST /call-logs` (order context):

| outcome | →status | allowed from |
|---|---|---|
| `confirmed` | confirmed | pending, take, call_again |
| `cancelled` | cancelled (requires reason) | pending, take, call_again, confirmed |
| `trash` / `wrong_number` | trashed | pending, take, call_again |
| `call_again` | call_again | pending, take, call_again, confirmed |
| `no_answer` / `interested` / `not_interested` | (no status change) | — |

Idempotent (re‑logging the same target status is a no‑op), and returns **409** on illegal jumps (e.g.
cancelling something already shipped, with a helpful message pointing to the Returned flow).

---

## 7. Helpers & safety machinery (file tail)

| Helper | What it does |
|---|---|
| `verifyWebhookSignature(req, rawBody)` | Timing‑safe HMAC‑SHA256 check; bypasses (with warning) if `WEBHOOK_SECRET` unset |
| `checkWebhookRateLimit(key)` | In‑memory sliding window, 100/60 s, keyed by slug/IP |
| `checkUserRateLimit(userId, endpoint, limit)` | Per‑user limiter for sensitive authed routes (create user, bulk ops) |
| `normalizeBgPhone(raw)` | → `+359XXXXXXXXX` (handles `0…`, `359…`, `00359…`, `+…`) |
| `sanitizeSearch(s)` | Strips PostgREST `.or()`/LIKE metacharacters from search input |
| `sanitizeDbError(err)` | Maps PG error codes → generic messages; never leaks schema details |
| `audit(client, actor, action, opts)` | Append‑only write to `audit_log` (errors swallowed) |
| `getEcontStreetsAndQuarters(cityId)` | Live Econt street/quarter fetch, cached per warm instance |
| `paginate(makeQuery)` | `.range()` loop to defeat the 1000‑row cap (defined inline in analytics handlers) |

---

## 8. Conventions when extending the API

- **Gate every privileged route in code** (`if (!isAdminOrManager) return json({error:'Forbidden'},403)`) —
  RLS is a backstop, not the primary gate, because most queries use the service role.
- **Validate with zod** (`parseBody(schema, …)`); schemas live at the top of the file.
- **Paginate** any aggregate read over a table that can exceed 1000 rows.
- **Mirror role checks on the frontend** (`useAuth().user.isAdmin/...` + `usePermissions()`), and keep
  `ALLOWED_ORIGINS` current. Redeploy after any change — the function is not hot‑reloaded by a frontend push.
