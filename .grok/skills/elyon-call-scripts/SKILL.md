---
name: elyon-call-scripts
description: Targeted call scripts in the Macedonian Elyon CRM (owner 02.10.2026) — one script per LIST GROUP (lead_new / lead_callback + the 10 prediction groups from the list name), optionally per product (twins count), sections Отворање · Презентација · Приговори · Затворање + custom + quick answers, mk + sq only; the matcher (tiers, primary product first, priority, newest), the variables ({{customer_name}} … and the legacy [Customer Name] form → segments, never HTML), the audited SQL writers (call_script_save / _duplicate / _bulk / _restore / _delete, versions append-only, admins delete), the RLS (agents see published only), the switch app_settings.call_scripts.mode (off | preview | on, owner key), GET /calls/scripts, the coverage grid and verify-call-scripts. Read before touching call_scripts / call_script_versions, supabase/functions/api/callScriptMatch.ts or callScriptsAdmin.ts, the /call-scripts page, the /calls script dock, or any call-script import.
---

# Targeted call scripts (MACEDONIA)

> Owner, 02.10.2026: scripts for **leads** and for **prediction**, written on `/call-scripts`, shown on `/calls` by
> what the agent works and who the client is. **One script per list group** (no split by value, order count or list),
> optionally attached to products. Admins + managers write and publish; only admins delete; every change is a
> version and can be restored. **Not live** until the owner switches `app_settings.call_scripts.mode`.

- Contract + as-built notes: **`docs/CALL-SCRIPTS.md`**. Migration **`20260947000100_call_scripts_targeting.sql`**.
- Pure rules (shared by the api and the UI): `supabase/functions/api/callScriptMatch.ts` (+ test), re-exported by
  `src/lib/callScriptsTypes.ts`. Api helpers: `supabase/functions/api/callScriptsAdmin.ts` (+ test). Client:
  `src/lib/callScriptsApi.ts` (`CallScriptsError` keeps `status` + `code`; `isStale`, `currentVersion`).
- Check: **`node scripts/verify-call-scripts.mjs`** (V1–V10, read-only, pinned to MK).

## 1. Groups — never rename a list
`LEAD_GROUPS = lead_new | lead_callback` (order status pending/take → new, call_again → callback; **no fallback** from
callback to new). `PREDICTION_GROUPS = newcomers | d21 | d57 | m4_6 | m6_12 | y1_2 | y2plus | cancels | never_converted | trash`.
`groupOfListName(name)` READS a name: exact pens first (Current Cancels + Cancelled Pendings → cancels, Never-Converted
Recent/Old → never_converted, Trash List → trash, **Current Returns / Due to Reorder / FULL MONAD LIST → null**), then
the first token (NEWCOMERS | 21d | 57d | 4-6m | 6-12m | 1-2yr | 2yr+ = the `RECENCY_ID` ids of listModel.ts). Anything
else (uploaded lists) → null. A null group is reached only by scripts with `groups = {}`. The engine resolves lists by
EXACT name — a script feature never touches a list name. Labels reuse `insights.lists.name.recency.*`.

## 2. Matching (`matchScripts`)
Candidates = `context_type = 'targeted'` and published (drafts too in preview for admins / managers; archived never).
gHit: `groups = {}` → all, G ∈ groups → group, else skip. pHit: `product_ids = {}` → all, ∩ family(primary) → primary,
∩ family(other products of the call) → other, else skip. Tier: group&prod 1 · group&all 2 · all&prod 3 · all&all 4.
Order: tier ↑ · primary before other · priority ↓ · coalesce(published_at, updated_at) ↓ · id ↑. Best + 4 alternatives,
reasons `group:<g>` / `all_groups` / `product:<id>` / `all_products` / `twin`, `tie_break` (what beat the next one on
the same tier). **Twins** = same normalised name (`productFamilyKey`, 0 live on 02.10). Different spellings of one
product ("ПРОСТАТОЛ КОМПЛЕКС cps 30" vs "Prostatol Complex") are NOT twins — attach both; `proposeProductsForTitle`
finds them (Cyrillic → Latin, c/q→k, x→ks …).

## 3. The call context (`GET /api/calls/scripts?phone&source=lead|prediction|manual&order_id&list_id&include_drafts`)
- Lead: the `order_id` if it is an open lead (pending/take/call_again, lead source) on the same last-8 phone, else the
  newest one; products = order product + items, primary = order product.
- Prediction: `list_id` required, a real list; an agent must hold the member row (403 `not_your_member`); product =
  the trigger order's (+ items), else `last_sale_product(phone)`; last purchase = member `last_paid_at`, else the last sale.
- Manual: open lead → list hint (if usable) → `resolvePredictionAttribution` → none.
- Privacy: no name without `show_customer_name`, no city without `show_customer_address`, no `last_*` without
  `show_order_history`. The AlterCPA offer never leaves the server.
- Mode `off` (or `preview` for a non admin/manager) → `{enabled:false}` and /calls keeps today's panel.
- Per-isolate caches: mode / script metadata / products 30 s, demand 60 s; every write clears its isolate's copy.

## 4. Variables (`substitute` → segments, never HTML)
New: `{{customer_name}} {{first_name}} {{agent_name}} {{product}} {{price}} {{last_product}} {{last_purchase_date}}
{{days_since_purchase}} {{since_purchase}} {{city}} {{order_id}}`. Legacy: `[Customer Name] [Product] [Order ID]
[Agent Name] [Your Name] [Price] [City]`. A missing value → a `missing` segment (amber chip). `{{price}}` = price_eur ×
the FROZEN 61,5 (`1.599 ден`); dates on the Skopje calendar.

## 5. Writes — only the audited SQL writers
`call_scripts` has ONE select policy (`call_scripts_select`: internal staff, published only unless admin/manager —
InitPlan form) and no browser write grant. Writers (SECURITY DEFINER, service role only, role check + advisory lock +
version row + audit row in one transaction): `call_script_save` (create / update, 409 `stale` on a version mismatch,
draft ↔ published, any → archived, archived → draft; publishing needs a title + a section with text),
`call_script_duplicate` (≤ 50 drafts, `copied_from`), `call_scripts_bulk` (≤ 200), `call_script_restore` (a deleted row:
admins only), `call_script_delete` (admins only; never the order / prediction_lead rows), `call_scripts_set_mode`
(admins). The machine code is in the error HINT → `CSA.mapWriterError`. `call_script_versions` is append-only (trigger),
RLS deny-all. **Never** write `call_scripts` with the service role from a script — `verify-call-scripts` V4 catches
any row that differs from its latest snapshot. `import-scripts-from-bg.mjs`, `import-call-scripts.mjs` and
`translate-call-scripts.mjs` are retired (they exit with a message).

Legacy rows (`product` / `order` / `prediction_lead`) stay published and untargeted; the old routes are hardened
(GET legacy only, POST → 410, PATCH through the writer's legacy branch, DELETE admins only). The 11 product rows each
got a DRAFT targeted copy at migration (sections = [pitch: the old text], empty targeting).

## 6. Sections and languages
`sections = [{id, key: opening|pitch|objections|closing|custom, title? (custom, ≤ 80), text ≤ 8000}]`, ≤ 12, a fixed key
once (id = key), custom id `custom-[a-z0-9]{6,12}`. `script_text` is DERIVED (`call_script_sections_text` = TS
`sectionsToText`, "Heading\ntext" blocks; mk headings Отворање / Презентација / Приговори / Затворање, sq Hapja /
Prezantimi / Kundërshtimet / Mbyllja). Scripts are written in **mk + sq only**: `translations = {sq: {title,
description, sections (matched by id), helpers}}`; sq falls back to mk PER SECTION ID (`resolveTargetedScript`).

## 7. Lint (warnings, never blocking)
`bg_content` (евро / € / лв / лева / Еконт / Спиди / Econt / Speedy / Бугарија / България — "лв" bounded by a non-letter),
`terminology` (прогноз / пендинг / на чекање — the owner's terms are предикција, лидови), `unknown_var`,
`legacy_placeholder` (also `[Company]`, `[Address]` and `___` blanks), `missing_sq` (info). On 02.10 the 10 legacy
product scripts and their 10 copies carry Bulgarian delivery / currency wording — `verify-call-scripts` V10 WARNs.

## 8. Coverage
`GET /call-scripts/coverage?families=1&assigned_only=0` (writers): `call_script_demand_json()` (members of active
lists by trigger-order product + open leads by status, test phones excluded) × list groups × products → per cell the
published winner, the draft that would win, the overlap; `outside` = clients of null-group lists. 02.10: 113.547
members + 170 open leads waiting; y2plus 20.595, m6_12 18.567, y1_2 16.961, trash 13.257, never_converted 10.674,
d57 10.118, m4_6 7.630, d21 6.072, newcomers 3.340, cancels 2.951, Current Returns 3.383 (no group).
