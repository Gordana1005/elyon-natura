# Elyon — Affiliate Integration Guide

Technical documentation for affiliates (webmasters) sending leads to Elyon via S2S API.

- **Base URL:** `https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/api`
- **Auth:** your personal API key (`aff_…`), passed in the JSON body as `key`, as `?key=` query parameter, or as an `X-Api-Key` header.
- **Format:** JSON in, JSON out. UTF-8. All money values are **EUR**.
- **GEO:** North Macedonia (MK). Phone numbers are normalized to Macedonian E.164 (`+389…`) — leads without enough digits are rejected with `nophone`.

> ⚠️ **Corrected 2026-08-06.** This page previously said Bulgaria / `+359`, inherited from the
> Bulgarian original. The code has always used `+389` here. Note that intake does not *reject* a
> foreign number — `normalizeMkPhone` rewrites it to `+389…`, so only send Macedonian numbers.

---

## Your affiliate account

Log in to your Elyon affiliate portal:

- **Portal:** https://elyon-natura.vercel.app
- **Email / password:** issued to you individually by your Elyon manager.

> 🛑 **Corrected 2026-08-06.** This block used to point at `https://www.elyoncall.com` with a
> shared demo login. That is the **Bulgarian** system — a completely separate business — and a
> partner following it would have been sent to the wrong company entirely. It also published a
> working credential in a file meant to be handed to third parties.

Inside the portal you'll find everything you need to integrate:

- **Integration page** — your **API key** is here. Copy it, and you can **rotate** it anytime (rotating invalidates the old key immediately — update your sender right after). This is also where you set your **postback URL**, toggle which events fire, and **test-fire** a postback to your tracker. It also shows ready-made curl / PHP / Node snippets pre-filled with your real key and offer IDs.
- **Offers page** — the offers you're approved to run, each with your payout and the **offer ID** to put in the `offer` field below.
- **Dashboard** — live stats for your leads: sent, approve rate, buyout rate, **approved** (= confirmed, which is what you are paid for) and **payout earned**. Filter by any date range you like.

You can integrate straight from the portal snippets, or follow the reference below.

---

## 1. Submit a lead

```
POST /cpa/lead
Content-Type: application/json
```

### Fields

| Field | Required | Description |
|---|---|---|
| `key` | yes* | Your API key (*or `?key=` / `X-Api-Key` header) |
| `offer` | yes | Offer ID (UUID we give you) or exact offer name |
| `phone` | yes | Customer phone, any common format (`070123456`, `+38970123456`, `0038970…`) |
| `id` / `ext_id` | recommended | **Your** unique lead ID. Send `"auto"` or omit to let us generate one. Same `id` twice = `duplicate` (idempotent, safe to retry) |
| `name` | recommended | Customer name |
| `sub1`…`sub5` | optional | Your sub-IDs / campaign split-test labels — stored verbatim, returned in postbacks |
| `clickid` (or `cuid`, `fbclid`, `gclid`, `ttclid`) | optional | Your tracker's click ID — returned in postbacks as `{subid}`/`{clickid}` |
| `wm` | optional | Sub-source ID (used as `sub1` if `sub1` is empty) |
| `us`, `uc`, `um`, `un`, `ut` | optional | utm_source / campaign / medium / content / term (stored for reference) |
| `ip`, `ua`, `country` | optional | Visitor IP, user-agent, 2-letter country (defaults taken from the request) |
| `email`, `address`, `city`, `postal_code` | optional | Extra customer data if your funnel collects it |
| `quantity` | optional | Units requested, 1–10 (default 1) |

### Responses

Business responses are always **HTTP 200**:

```json
{"status":"ok","id":"2b2832af-c311-4009-8de7-f744547e59a8","uid":"ext-1"}
```

- `id` — **our reference for this lead** (an opaque UUID). Store it if you like; you can use it in status checks. It is not an order number and its format may not be parsed or validated.
- `uid` — your `id`/`ext_id` echoed back (or our reference when you sent `auto`)

> **Changed 2026-07-22:** `id` used to be an `ORD-…` order number. It is now an opaque reference. Everything else is unchanged — same fields, same key, same offer IDs. If your integration stores our returned value verbatim (AlterCPA does), nothing on your side needs to change. Your own `id`/`ext_id` remains the recommended key for everything.

Errors: `{"status":"error","error":"<code>"}`

| Code | Meaning |
|---|---|
| `security` | Unknown API key, or your account is paused |
| `ban` | Your account is banned |
| `nooffer` | `offer` field missing |
| `offer` | Offer not found, inactive, or not approved for you |
| `nophone` | Phone missing or too short to be a valid Macedonian number |
| `duplicate` | Same `ext_id` already sent, **or** same phone already in our system within the dedupe window (default 24h). Includes `id`/`uid` of the existing lead when known. Not an error to worry about — do not retry |
| `traffic` | Rate limit exceeded — slow down |
| `db` | Temporary error on our side — retry later |

### Example — curl

```bash
curl -X POST "https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/api/cpa/lead" \
  -H "Content-Type: application/json" \
  -d '{
    "key":    "aff_YOUR_KEY_HERE",
    "offer":  "YOUR_OFFER_ID",
    "id":     "lead-10001",
    "phone":  "070123456",
    "name":   "Petar Ilievski",
    "sub1":   "campaign-a",
    "clickid":"{subid_from_your_tracker}"
  }'
```

### Example — PHP

```php
$payload = [
  'key'     => 'aff_YOUR_KEY_HERE',
  'offer'   => 'YOUR_OFFER_ID',
  'id'      => $yourLeadId,
  'phone'   => $phone,
  'name'    => $name,
  'sub1'    => $sub1,
  'clickid' => $clickid,
];
$ch = curl_init('https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/api/cpa/lead');
curl_setopt_array($ch, [
  CURLOPT_POST => true,
  CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
  CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT => 15,
]);
$res = json_decode(curl_exec($ch), true);
// $res['status'] === 'ok'  → accepted; save $res['id']
// $res['error'] === 'duplicate' → already have this customer, do not resend
```

### Example — Node.js

```js
const res = await fetch("https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/api/cpa/lead", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    key: "aff_YOUR_KEY_HERE",
    offer: "YOUR_OFFER_ID",
    id: yourLeadId,
    phone, name, sub1, clickid,
  }),
});
const data = await res.json(); // {status:"ok", id:"ORD-…", uid:"…"}
```

---

## 2. Check lead statuses

```
GET /cpa/leads?key=aff_YOUR_KEY&ids=lead-10001,lead-10002,ORD-37405
```

- Up to **50 IDs** per request, comma-separated. Use your own `ext_id`s and/or the references we returned at intake.
- Unknown IDs are silently skipped.

```json
{"status":"ok","leads":[
  {"id":"2b2832af-c311-4009-8de7-f744547e59a8","uid":"lead-10001","stage":"hold","reason":null,"created_at":"2026-07-09T17:54:47Z"}
]}
```

### Stages

| Stage | Meaning | Money |
|---|---|---|
| `wait` | In processing — the call center is working the lead | — |
| `hold` | **Approved** — confirmed by the call center | **payout earned** (final) |
| `approve` | **Paid (buyout)** — COD cash collected | payout was already earned at `hold` |
| `cancel` | Cancelled during processing (+ `reason`) | no payout if it never reached `hold`; an earned payout is kept |
| `trash` | Invalid lead — wrong/unreachable number (+ `reason`) | no payout if it never reached `hold`; an earned payout is kept |
| `return` | Delivered but returned/refused (+ `reason`) | payout kept — **not** reversed |

**Payout accrues when the call centre confirms the order (`hold`), and is never reversed.**
Your job ends at confirmation: what happens afterwards — shipped, delivered, paid, returned,
or even cancelled later — is logistics information for your panel, not a payment event. A
delivery that fails is our loss, not yours. The **"Payout earned" figure in your portal is the
billing truth**; the stage stream your tracker receives is unchanged (same events, same codes,
same moments) and remains logistics truth.

---

## 3a. Running an AlterCPA network? We drive your API directly

If you run **AlterCPA** (cpa.toys, cashfactories.com and similar), you do **not** need a macro template and you do **not** need to configure anything. Tell us your merchant API token and we call your advertiser API ourselves:

```
GET https://<your-network>/api/comp/edit.json?id=<token>&oid=<your order id>&…
```

| Our event | What we send | Meaning |
|---|---|---|
| lead received | `status=2` | Processing |
| confirmed by the call centre | `accept=1` | approved — *not* a status change, per AlterCPA's own guidance |
| shipped | `status=7` | Sending |
| paid (COD collected) | `status=10` | Completed / bought out |
| returned | `status=11` | Return |
| cancelled / invalid | `status=5&reason=<code>` | with your network's numeric reason code |

`oid` is **your** order ID — the `id`/`ext_id` you sent us at intake. We never send our own order numbers. If you paste a `…/api/comp/status.json` URL we rewrite it to `edit.json` automatically, since only `edit.json` carries numeric statuses and cancel reasons.

Reason codes are configured **per network**, because AlterCPA installs differ — send us your table (Profile → API docs) if it isn't the vendor default.

**Billing settles at confirmation on our side** (`accept=1`), so the offer's payout model does not change what we owe you: `status=10` (paid) and `status=11` (returned) are pushed as logistics information only and neither creates nor removes a payout. **One thing we need from you:** confirmation that no company working-hours or balance limit is set, since either one blocks the API in a way that looks nothing like a rate limit.

---

## 3. Postbacks (S2S callbacks to your tracker)

Give us your postback URL template (or configure it yourself in your affiliate panel). We fire a **GET** request on every stage change. Macros in `{curly}` are replaced and URL-encoded; unknown macros are left as-is.

### Macros

| Macro | Value |
|---|---|
| `{subid}` | Your click ID (falls back to `sub1`) |
| `{clickid}` `{cuid}` `{fbclid}` `{gclid}` `{ttclid}` | Same as your click ID |
| `{id}` | Your `ext_id` (empty if you didn't send one) |
| `{oid}` | Our opaque reference for the lead |
| `{offer}` | Offer ID |
| `{stage}` | `lead` \| `hold` \| `approve` \| `cancel` \| `trash` \| `return` |
| `{status}` | Keitaro-style: `lead` (wait/hold), `sale` (approve), `rejected` (cancel/trash/return) |
| `{stage:w\|h\|a\|c\|t\|r}` | Custom mapping — your own six values, pipe-separated, in order: lead\|hold\|approve\|cancel\|trash\|return |
| `{cash}` / `{payout}` | Payout amount in EUR — non-zero **only** on `approve` |
| `{hold}` | Payout amount in EUR — non-zero on `lead`/`hold` |
| `{reason}` | Cancellation/trash/return reason code, when applicable |
| `{sub1}`…`{sub5}` | Your sub-IDs, verbatim |
| `{currency}` | `EUR` |
| `{date}` | ISO timestamp of the event |
| `{rand}` | Random value (cache-buster) |

> **These macros are logistics truth, not billing truth.** The postback stream is deliberately
> unchanged by the 2026-08-10 payout rule: `{stage}`, `{status}`, `{cash}` and `{hold}` still
> follow the order's *current* status exactly as before, so nothing in your tracker needs
> touching. What you are actually owed is the **"Payout earned"** figure in your portal, which
> counts every lead that was ever confirmed and never goes down. It is normal for your panel to
> show `return` on an order the portal still counts as earned.

### Example — Keitaro

```
https://your-tracker.com/postback?subid={subid}&status={status}&payout={cash}
```

### Example — custom statuses

```
https://your-tracker.com/pb?cid={clickid}&st={stage:new|approved|paid|cancel|trash|return}&sum={cash}
```

### Delivery guarantees

- Fired on every stage **change** (internal processing steps do not spam you).
- Response `2xx` = delivered. Anything else is retried with backoff: **1m → 5m → 15m → 1h → 6h → 24h**, then marked failed (manual resend possible on our side).
- Duplicate protection: if a re-render produces the exact same URL that was already delivered for that lead, it is skipped. Include `{rand}` if you want every event delivered regardless.
- Re-sending the same `subid` with a new status is safe — trackers (Keitaro etc.) overwrite the conversion.

---

## 4. Good practices

- Always send your own `id`/`ext_id` — it makes retries idempotent and status checks easy.
- Treat `duplicate` as success-with-no-action, not an error.
- Send `sub1`–`sub5` for anything you want to split-test; we never interpret them.
- Rate limits are generous for real traffic; batch status checks (up to 50 IDs) instead of polling one by one.

Questions / key rotation / new offers: contact your Elyon manager.
