# 04 — Seed & bootstrap the empty database

Now we put the first real content into the empty Macedonia DB: an admin to log in, the product
catalog, the call scripts, and the per-product webhooks. **Customer/order data stays empty —
that fills up from real Macedonia business.**

> 🛑 Everything here runs against the **new** project, via the fork's `.env` (the one you filled
> in [03](03-SUPABASE-FROM-ZERO.md)). Confirm `.env` has the **new** ref before running anything.
>
> ⚠️ **Env var name quirk:** the admin script reads `SUPABASE_URL`; the other scripts read
> `VITE_SUPABASE_URL`. Both are shown below. Don't mix them up.

Run in this order.

---

## 1. Founding admin user(s) — `create-admin-users.mjs`

Creates the first admin(s) (auth user + profile + `admin` role), bypassing email confirmation.

By default the script creates 3 hardcoded Bulgarian admins
(`MileStoev@elyoncrm.local`, …) with password `12345678`. **For Macedonia, edit the `USERS`
array and email domain in the script first** (e.g. an `@elyon-mk.local` address), then run it.

```powershell
# PowerShell — note: plain SUPABASE_URL, NOT VITE_
$env:SUPABASE_URL="https://<NEW_PROJECT_REF>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<new service-role key>"
node scripts/create-admin-users.mjs
```

➡ **Immediately rotate the `12345678` password** from the app or the Supabase dashboard.

---

## 2. Product catalog — `import-products-bigarena.mjs` *(carry-over)*

Imports the catalog from the BigArena fulfilment XLSX placed at the repo root. Dry-run first,
then `--commit`.

```bash
# dry run — shows what would change, writes nothing
node --env-file=.env scripts/import-products-bigarena.mjs
# commit
node --env-file=.env scripts/import-products-bigarena.mjs --commit
```

- Matches by SKU, falls back to normalized name; auto-generates SKUs on insert.
- Stock >10 → insert/update + activate; stock ≤10 → update existing only.
- Each change writes an `inventory_logs` row.
- Prices are in **EUR** in the catalog — correct for Macedonia as-is.
- Rules: [../.grok/skills/elyon-stock-and-bigarena/SKILL.md](../.grok/skills/elyon-stock-and-bigarena/SKILL.md).

> If Macedonia sells a **different** product set, just import a different XLSX (`--file=PATH`).

---

## 3. Call scripts — `import-call-scripts.mjs` *(carry-over)*

> **Macedonia: retired 02.10.2026.** The script exits with a message; call scripts are written on
> /call-scripts through the audited writers (docs/CALL-SCRIPTS.md, migration 20260947000100).

Imports the talk-track scripts (trilingual; Albanian already drafted).

```bash
node --env-file=.env scripts/import-call-scripts.mjs            # dry-run
node --env-file=.env scripts/import-call-scripts.mjs --commit   # write
```

- Idempotent by title.
- Albanian/English/Bulgarian variants live in the `call_scripts.translations` JSONB; for
  Macedonia the operator should review/adjust the **sq** wording in-app afterwards.
- Reference: [../docs/CALL_SCRIPTS.md](../docs/CALL_SCRIPTS.md).

---

## 4. Per-product webhooks — `create-webhooks-for-products.mjs`

One inbound webhook per active product (so each landing page knows which product a lead wants).

```bash
node --env-file=.env scripts/create-webhooks-for-products.mjs            # dry-run
node --env-file=.env scripts/create-webhooks-for-products.mjs --commit   # write
```

- Idempotent (upserts on slug).
- The signing key is the `WEBHOOK_SECRET` you set in [03](03-SUPABASE-FROM-ZERO.md). Give that
  secret + each webhook URL to whoever builds the Macedonia landing pages.
- Contract: [../docs/WEBSITES_WEBHOOKS.md](../docs/WEBSITES_WEBHOOKS.md) and
  [../.grok/skills/elyon-webhook-and-lead-ingestion/SKILL.md](../.grok/skills/elyon-webhook-and-lead-ingestion/SKILL.md).

---

## 5. Couriers + cities — **Macedonia-local (fresh, not carried over)**

Bulgaria's Speedy/Econt offices and `bg_settlements` do **not** apply to Macedonia. You need:

- A **Macedonia courier list** + their office/pickup points → populate `courier_offices`.
- A **Macedonia city/settlement list** → populate the settlements table.

The Bulgarian scripts are the **pattern to adapt**, not to run as-is:
- `scripts/scrape-courier-offices.mjs` (Speedy/Econt scraper) → rewrite for the Macedonia carrier(s).
- `scripts/fetch-bg-settlements.mjs` (+ `enrich-settlements-municipality.mjs`) → replace with
  Macedonia data (a one-off CSV/JSON import is fine to start).

> Minimum to go live: even a small static list of the main Macedonia cities + one courier is
> enough for Phase 1. Expand later. The matching enum/labels are listed in
> [06-PER-MARKET-CHANGES.md](06-PER-MARKET-CHANGES.md).

---

## 6. Verify the engine — `audit-segments-integrity.mjs`

```bash
node --env-file=.env scripts/audit-segments-integrity.mjs
```

On a fresh DB this should report a clean engine (all checks pass; the live system runs 13/13).
With no orders yet, segment membership is simply empty — that's correct.

---

✅ The database now has an admin, a catalog, scripts, and webhooks. Time to put a face on it.

➡ Next: [05-FRONTEND-DEPLOY.md](05-FRONTEND-DEPLOY.md)
