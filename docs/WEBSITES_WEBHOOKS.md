# Websites & webhooks — how pendings arrive

> Every "pending" that an agent calls comes from one of four intakes. Two are external (push into the CRM
> over HMAC‑signed webhooks): **landing pages** and the **naturatherapy.bg OpenCart store**. This doc is
> the contract for both, end to end, plus how a new pending reaches an agent.

---

## 1. The four intakes

```
1. Landing page form  ── POST /webhook/<slug> ──┐
2. naturatherapy.bg   ── POST /webhook/opencart ┤
3. XLSX lead import   ── scripts → prediction_leads ┤──► orders/prediction (status=pending, unassigned)
4. Agent (manual)     ── CreateOrderModal / POST /orders ┘
                                                            │
                                       Assigner / auto-distribute / segment assign
                                                            ▼
                                                  agent's Calls queue → call
```

Intakes 1–2 are covered here. Intake 3 is in [IMPORT_EXPORT.md](IMPORT_EXPORT.md); intake 4 + distribution
in [ORDERS_AND_CLIENTS.md](ORDERS_AND_CLIENTS.md).

---

## 2. Security model (shared by all webhooks)

Every inbound POST must carry:

```
x-webhook-signature: hex( HMAC_SHA256( rawRequestBody, WEBHOOK_SECRET ) )
```

- `WEBHOOK_SECRET` is a Supabase Edge‑Function secret (value in [VAULT.md](VAULT.md)). The **same secret**
  is shared by landing pages and the OpenCart bridge.
- The function verifies with a **timing‑safe** comparison (`verifyWebhookSignature`). Bad/missing signature → **401**.
- ✅ If `WEBHOOK_SECRET` is **unset**, the function **fails closed**: it logs an error and rejects every
  webhook with 401. (Corrected 2026-08-06 — this page previously claimed the opposite. The code has
  failed closed since 2026-06-11; see `verifyWebhookSignature` in `supabase/functions/api/index.ts`.)
- **Rate‑limited** in‑memory: 100 requests / 60 s, keyed per slug and per IP (`checkWebhookRateLimit`).
- These endpoints **bypass JWT/CORS** (server‑to‑server) — they're gated by HMAC, not auth.
- **Never put `WEBHOOK_SECRET` in browser JS.** Compute the signature server‑side. A pure‑static landing
  page needs a tiny proxy (Cloudflare Worker, etc.) holding the secret.

Rotate with `npx supabase secrets set WEBHOOK_SECRET=… --project-ref oufoazmnbwugtfldkwsn` **and** update
every sender in lockstep, or they start 401‑ing.

---

## 3. Landing‑page webhooks (one per product)

**Idea:** the URL itself encodes which product the lead wants, so the form only sends name + phone.

### Endpoints
| Endpoint | Behaviour |
|---|---|
| `POST /functions/v1/api/webhook/<slug>` | Per‑product. Looks up `webhooks` by `slug`; rejects if not found (404) or disabled (403). Inserts `inbound_leads` (denormalising the webhook's `product_name`), increments `total_leads`, and auto‑creates a `pending`, unassigned order with that product. |
| `POST /functions/v1/api/webhook/leads` | Legacy global endpoint; `product_name` hardcoded to "From Landing Page". Kept for back‑compat. |

### Request / response
```http
POST /functions/v1/api/webhook/<slug>
x-webhook-signature: <hex hmac>
Content-Type: application/json

{ "name": "Иван Петров", "phone": "0888123456", "source": "fb-ad-aug" }   // source optional
```
```json
{ "success": true, "id": "<inbound_lead_id>", "order_id": "<order_id>", "product": "<product_name>" }
```
Schema (`inboundLeadSchema`): `name` (required), `phone` (required), `status?` (default `pending`),
`source?` (default `landing_page`). If a page sends first/last separately, **concatenate before POSTing** —
the CRM stores a single `customer_name`. Phone is normalised to `+359…` downstream.

### Admin
- `webhooks` table: `slug` (unique), `product_name`, `status` (active/disabled), `total_leads`. **55 active**,
  one per active product, bulk‑seeded by `scripts/create-webhooks-for-products.mjs` (slug = transliterated
  lowercase product name, Cyrillic‑aware).
- UI: [../src/pages/WebhookManagementPage.tsx](../src/pages/WebhookManagementPage.tsx) ("Webhooks & Ads")
  — total leads per webhook, copy‑URL, enable/disable.
- Raw inbound stream: [../src/pages/InboundLeadsPage.tsx](../src/pages/InboundLeadsPage.tsx) (`/inbound-leads`,
  refreshes ~15 s).
- **Don't rename a slug in place** — every landing page using its URL breaks silently (404). Delete +
  recreate with a new slug and update the page.

### Example signer (Node, server‑side)
```js
import crypto from 'node:crypto';
const body = JSON.stringify({ name, phone, source });
const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
await fetch(`${CRM}/functions/v1/api/webhook/${slug}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-webhook-signature': sig },
  body, // send the EXACT string you signed
});
```

---

## 4. naturatherapy.bg → CRM (OpenCart bridge)

A self‑contained OpenCart 3 module (`opencart-bridge/`, packaged as `elyon_crm_bridge.ocmod.zip`) pushes
**every order** placed on naturatherapy.bg into the CRM as a Pending, and optionally captures **abandoned
checkouts** as leads. No core OpenCart files are modified.

### Flow
```
naturatherapy.bg (OpenCart 3.0.3.8 + TK one-page checkout)
  ├─ order confirmed  ── event addOrderHistory/after ─┐
  ├─ checkout started ── event addOrder/after ────────┤  HMAC POST  → POST /functions/v1/api/webhook/opencart
  ├─ "Run import now" (admin, historical backfill) ───┤
  └─ daily cron (elyon_cron.php, 3-day rolling re-send)┘
        │
        ▼  CRM: orders(status=pending, unassigned), source_type = opencart | opencart_abandoned
            deduped on (external_source, external_order_id)
        ▼
   Assigner → Pendings  (badge "Site" / "Site · abandoned")
```

### What the CRM does on receipt (`POST /webhook/opencart`)
1. Verify HMAC + rate‑limit.
2. Normalise name (`first+last` or `customer_name`) and phone (`+359…`). **Abandoned carts are dropped**
   unless they have a **full name (2+ parts) AND a real phone (≥11 digits)**.
3. **Money → EUR**: if the storefront sent BGN, convert at the fixed peg 1.95583.
4. **Match items** to the catalogue by **sku → barcode → name**; unmatched items are still recorded (no
   stock link), like legacy orders.
5. **Idempotent upsert** on `(external_source, external_order_id)`:
   - new → insert pending order + items + a System provenance note + an `order_history` row.
   - existing & still an **untouched pending** → refresh it (incl. an abandoned→completed upgrade that
     flips `source_type`/product/total and the note).
   - existing & **already worked by an agent** → left alone (never clobbered).
6. Returns `{ success, order_id, created, mode }`.

### Request shape (`opencartOrderSchema`)
`order_id` (string/number → string, the dedupe key), `mode` (`order`/`abandoned`), `status_label`,
`customer_name`/`first_name`/`last_name`, `phone`, `email`, `city`, `address`, `postal_code`, `comment`,
`total`, `currency` (default EUR), `source` (default `naturatherapy.bg`), `date_added`, `items[]`
(`name`, `sku`, `quantity`, `price`).

### The OpenCart side (files in `opencart-bridge/`)
- `upload/system/library/elyon/bridge.php` — builds the payload from raw `oc_order`/`oc_order_product`
  tables (works even for status 0 = incomplete), signs `hash_hmac('sha256', json, secret)`, POSTs.
- `upload/catalog/controller/extension/module/elyon_bridge.php` — the storefront event handlers.
- `upload/admin/...` — settings UI (URL, secret, statuses, source, abandoned toggle), the install (registers
  events), historical import (from the 1st of the current month), and a Test‑connection button.
- `upload/elyon_cron.php` — **daily safety‑net** (cPanel cron): re‑sends the last **3 days** of orders so a
  momentary outage can't lose anything; fully idempotent. CLI needs no auth; URL mode requires `?token=<WEBHOOK_SECRET>`.

### Install (on the store) — summary
Upload the OCMOD zip → Modifications → Refresh → Extensions → Modules → install **Elyon CRM Bridge** →
Edit: set Live sync on, the CRM webhook URL (`…/functions/v1/api/webhook/opencart`), the shared secret
(= `WEBHOOK_SECRET`), source `naturatherapy.bg`, statuses (Pending), abandoned on/off → Save → **Test
connection**. Then run the **historical import** once (defaults to the 1st of the current month). Full
step‑by‑step + troubleshooting: [../opencart-bridge/README.md](../opencart-bridge/README.md).

> **Current status:** bridge built & deployed in the repo; awaiting the operator to install the OCMOD on
> naturatherapy.bg, enter the secret, and run the May import (memory note `project_naturatherapy_bridge`).

---

## 5. What you'll see in the CRM
- **Inbound Leads** (`/inbound-leads`) — the raw landing‑page stream.
- **Assigner → Pendings** — new orders, unassigned, with a source badge: landing pages show their source;
  OpenCart shows **"Site"** (real order) or **"Site · abandoned"**.
- **Orders** + the Daily Fulfilment CSV `SOURCE` column → `naturatherapy.bg` / `naturatherapy.bg (abandoned)`.
- Each pending carries a **System note** with provenance (order #, status, email, date, customer comment)
  + line items + total (EUR). Provenance stays in storage; stripped on render via `cleanNoteForDisplay()`.

---

## 6. Adding a new website / source
- **Another landing page for an existing product:** reuse that product's webhook URL — nothing to build.
- **A new product:** add the product, re‑run `scripts/create-webhooks-for-products.mjs --commit`, copy the
  new slug's URL into the page (server‑side signer with the shared secret).
- **Another storefront (e.g. a second OpenCart):** point its bridge at `/webhook/opencart` with a distinct
  `source` label — dedupe is per `(external_source, external_order_id)`, so multiple stores coexist.
- **A different platform (WooCommerce/Shopify/custom):** POST the same `opencartOrderSchema` shape (or the
  `{name, phone}` lead shape) with the HMAC header. The CRM doesn't care what generated it.
