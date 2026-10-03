# Elyon CRM Bridge — naturatherapy.bg (OpenCart) → Elyon CRM

Pushes every order placed on **naturatherapy.bg** into the Elyon CRM as a
**Pending** (lands in the Assigner), tagged with its source, products, total,
address and provenance. Optionally also captures **abandoned checkouts** as
leads — but only when they carry a full name + phone.

It's a self-contained OpenCart 3 module + storefront event handler. No core
files are modified.

---

## How it works

```
naturatherapy.bg (OpenCart 3.0.3.8)
  │
  ├─ order confirmed  ── event: addOrderHistory/after ──┐
  │                                                      │  HMAC-signed POST
  ├─ checkout started ── event: addOrder/after ─────────┤  (X-Webhook-Signature)
  │   (status 0 = abandoned, only if full name+phone)    ▼
  └─ "Run import now" (historical backfill) ──────► POST /functions/v1/api/webhook/opencart
                                                        │
                                                        ▼
                                            Elyon CRM  ── orders (status=pending, unassigned)
                                                        ── source_type = opencart | opencart_abandoned
                                                        ── deduped on (external_source, external_order_id)
                                                        ▼
                                            Assigner → Pendings   (badge: "Site" / "Site · abandoned")
```

Because OpenCart's event system wraps the **core order model**, the events fire
for every order regardless of which checkout created it — including the **TK
one-page checkout** running on naturatherapy.bg.

The bridge is **idempotent**: live event, historical import and the
abandoned→completed upgrade all upsert the same CRM row (keyed on the OpenCart
order id), so nothing is duplicated. An untouched pending is refreshed; once an
agent has picked it up it is left alone.

---

## CRM side (already deployed)

- Endpoint: `POST https://oufoazmnbwugtfldkwsn.supabase.co/functions/v1/api/webhook/opencart`
- Auth: `X-Webhook-Signature: hex(HMAC_SHA256(rawBody, WEBHOOK_SECRET))`
- The shared secret is the **`WEBHOOK_SECRET`** already set on the CRM edge
  function (the same one the landing-page webhooks use).

---

## Install on naturatherapy.bg

1. **Upload** — OpenCart admin → *Extensions → Installer* → upload
   `elyon_crm_bridge.ocmod.zip`.
2. **Refresh modifications** — *Extensions → Modifications* → click **Refresh**
   (the blue ↻ top-right).
3. **Install the module** — *Extensions → Extensions* → choose **Modules** in the
   dropdown → find **Elyon CRM Bridge** → click the green **+ (Install)**.
   *(This registers the two storefront order events.)*
4. **Configure** — click the blue **✎ (Edit)** and fill in:
   - **Live sync**: `Enabled`
   - **CRM webhook URL**: `https://oufoazmnbwugtfldkwsn.supabase.co/functions/v1/api/webhook/opencart`
   - **Shared secret**: the value of `WEBHOOK_SECRET` on the CRM edge function
   - **Source label**: `naturatherapy.bg` (default)
   - **Send these order statuses**: leave **Pending** selected (add more if you
     want those statuses pushed too)
   - **Capture abandoned carts**: `Enabled` if you want incomplete checkouts as
     leads (qualified by full name + phone), otherwise `Disabled`
   - **Save**.
5. **Test** — click **Test connection**.
   - ✅ *"Connected and signature OK"* → you're done with setup.
   - ❌ *"shared secret is wrong (401)"* → fix the secret.
   - ❌ *"Connection failed"* → check the URL / outbound network.

From now on, every new order flows into the CRM automatically.

---

## One-time historical import (May onwards)

In the module's **Historical import** panel:

1. The date defaults to the **1st of the current month** (`2026-05-01`). Older
   orders are intentionally skipped.
2. Click **Run import now**. It pushes every order since that date in the
   selected statuses (default **Pending**) to the CRM and reports
   `sent / failed / total`.
3. Safe to re-run — duplicates are de-duped in the CRM.

---

## What you'll see in the CRM

- **Assigner → Pendings**: new orders appear unassigned, ready to distribute.
  - Source badge **"Site"** = a real naturatherapy.bg order.
  - Source badge **"Site · abandoned"** = an abandoned-cart lead.
- **Orders** list + the Daily Fulfilment CSV: `SOURCE` column reads
  `naturatherapy.bg` / `naturatherapy.bg (abandoned)`.
- Each pending carries a **System note** with the OpenCart order #, status,
  email, order date and any customer comment, plus line items + total (EUR).
- If an abandoned cart is later completed, its CRM row upgrades from
  *abandoned* → *Site order* automatically (note + badge update).

---

## Notes & troubleshooting

- **Money**: values are stored in EUR. If the storefront ever sends BGN, the CRM
  converts at the fixed peg (1 EUR = 1.95583 BGN).
- **Phones** are normalised to `+359…` E.164 on the CRM side.
- **Products** are matched to the CRM catalogue by SKU/barcode, then by name; if
  no match, the line item is still recorded (no stock link), same as legacy
  imported orders.
- **Module page shows "no permission"**: *Users → User Groups → Administrator →
  Edit* → tick **Access** and **Modify** for `extension/module/elyon_bridge`.
- **Uninstall**: *Extensions → Extensions → Modules → Elyon CRM Bridge → Uninstall*
  removes the events (files can then be removed via *Extensions → Installer*).

---

## Source layout

```
install.xml                                              OCMOD manifest
upload/system/library/elyon/bridge.php                  payload build + HMAC sign + POST (shared)
upload/catalog/controller/extension/module/elyon_bridge.php   storefront event handlers
upload/admin/controller/extension/module/elyon_bridge.php     settings + install(events) + import + test
upload/admin/model? (none — uses setting/event + setting/setting)
upload/admin/view/template/extension/module/elyon_bridge.twig settings UI
upload/admin/language/en-gb/extension/module/elyon_bridge.php  labels
```
