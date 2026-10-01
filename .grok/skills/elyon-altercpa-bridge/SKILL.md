---
name: elyon-altercpa-bridge
description: The AlterCPA → Elyon lead mirror — ledger-first design, callable geos, offer mapping, status mirroring, the resumable nightly/weekly sweeps, why nothing flows back automatically, the one manual exception (the CPA push button), and the 30% guarantee page (/altercpa Денес · Стапки · Лидови · Поставки, 01.10.2026). Read before touching altercpa_* tables, the altercpa-sync edge function, /altercpa admin routes, the altercpa_guarantee_* read model, the orders/:id/altercpa-push route, or anything that would put a foreign-geo lead into public.orders.
---

# AlterCPA bridge — how the mirror works

Shipped 2026-08-06. Full reference: `docs/ALTERCPA-BRIDGE.md`.

Leads arrive at AlterCPA from the affiliate network and keep arriving there. This pulls a copy
into Elyon so the CRM is one place. **We poll them; nothing is configured on their side.**

**Department (owner law 28–29.09, see `elyon-departments-and-sources`):** every order this bridge
creates — `altercpa/bridge`, and the 2025-04 → 2026-08 history `altercpa/history` — is
**Affiliate – Lead in** (cohort key `altercpa`), together with collabBox 10111 "Нарачка LEADS"
(`altercpa/collabbox_leads`; the collabBox sync never creates a 10111 order, it only credits the
seller on the order holding its parcel). A re-sale our agents make in the CRM to an affiliate
customer is **Affiliate – Lead out** (`elyon_crm`) when it ships on BIO NATURAL, as nearly all do
(on NATURA its series decides — the MEX profile rule, 20260942001860), never this department, even
when the customer arrived through AlterCPA — and even when the seller sits in the AlterCPA team
(that override was withdrawn, 20260942001100). An ad lead from an existing client is still a new
lead here.

## The five decisions (do not re-litigate)

1. **Ledger first, orders second.** EVERY record lands in `altercpa_leads` — every geo, with the
   raw payload. Only geos listed in `altercpa_accounts.callable_geos` are ALSO written to
   `public.orders`. Foreign traffic is mirrored and reported on, never called.
2. **Foreign geos never enter `orders`.** Not "enter and get filtered" — never enter. See below.
3. **Nothing flows back to AlterCPA automatically.** Their operators own the outcome on their
   side. The automatic part is structural, not a setting: mirrored orders get no
   `affiliate_leads` row, so `tg_enqueue_affiliate_postback` has nothing to fire on. Do not
   "fix" that by giving these orders a sidecar.

   **The ONE exception (operator asked 2026-08-13, built 2026-08-14): the manual CPA button.**
   `POST /orders/:id/altercpa-push` in the `api` edge fn + a "Send to CPA" item on each
   AlterCPA-sourced order row on /orders (admin/manager only). It pushes THAT order's current
   state to `comp/edit.json` (https://cpa.moe/en/api-comp.html):
   - **⚠️ POST, and TWO calls per push (both found live 2026-08-18).** Round 1 (oid 1434157):
     data fields sent via GET query string are **silently dropped** — their doc marks only
     `oid`/`eid`, `accept`, `status`, `reason`, `track` as "Can be send via GET" → POST body.
     Round 2 (oids 1434755/1434337): a POST that performs a REAL state transition (first
     accept, or a status change) applies the transition and drops every data field —
     including `comment` — in the same call; a call whose transition is a no-op applies data
     fine. So the route sends the transition and the data as SEPARATE
     `application/x-www-form-urlencoded` POSTs: accept target → transition first, then data
     (data edits proven on accepted orders); status targets → data first, then transition.
     Data edits also work on already-terminal orders (proven: comment onto a phase-4 cancel).
     The API answers success either way — only the read-back comparison tells the truth.
   - **Write token = Dragana's, not the merchant token (operator decision 2026-08-18).**
     AlterCPA shows the API token's ACCOUNT as the order's operator and has **no API param for
     an operator name**, so the edit write signs with
     `altercpa_accounts.push_token_secret_name` (secret `ALTERCPA_PUSH_TOKEN_DRAGANA`, value in
     VAULT §2) → their panel attributes pushes to Dragana. Falls back to `token_secret_name`
     when NULL. **Reads use the same token since 18.09:** the main merchant token was revoked, and
     the account's `token_secret_name` now also names `ALTERCPA_PUSH_TOKEN_DRAGANA`. The API
     takes the token as `?id=`, not `?token=` — a wrong parameter makes a good token look dead
     (the 25.08 → 18.09 outage was caught up: 4.443 orders). The confirming
     agent additionally travels as a server-forced `comment` prefix `Agent: <name>`
     (`confirmed_by_name ?? assigned_agent_name`) — the only per-order vehicle their API has.
   - **One order per CALL; bulk = client loop (2026-08-18, reversing the 08-14 one-per-press
     rule).** The /orders selection bar has "Send to CPA (N)" which loops the same endpoint
     sequentially — one payload/note/audit/verification per order. There is still no
     server-side bulk route and NO automatic hook — bulk-status-update / bulk-disposition /
     bigarena-sync must never call it. Rate-limited 60/min per user.
   - **Kill switch:** `app_settings.altercpa_push_enabled` (default **false**), a switch in
     Settings → System → "CPA Push". The route re-reads it on every call.
   - **What it sends:** status (`accept=1` for confirmed — never status 10; call_again→3,
     shipped→7, delivered→9, paid→10, returned→11, cancelled/trashed→5+reason), customer name /
     digits-only phone / city / street+number / quarter (`area`) / address / postal (`index`),
     `count` (= SUM(order_items.quantity), falling back to orders.quantity — the column can
     lag single-item edits), `base` (unit price in THEIR currency — rate from the lead's own
     `price_raw/price_eur`, eur→1, mkd→61.5, anything else omits base; **mkd rounds to whole
     denars** — their own upsell edits produce 3 × 1000, never 3 × 999.89), and `comment` =
     `Agent: <name>` + `orderReasonText()`. `pending`/`take`/`duplicated` are not pushable;
     `pending_cleanup`/`stale_pending_cleanup` cancels are blocked with 422 (server markers,
     not dispositions).
   - **call_again → their 3 Callback (enabled 2026-08-19, operator request; was excluded
     until the read-back loop was verified live on 08-18).** Two protections ship with it:
     (1) status 3 lives INSIDE their phase 1/2, so the route 422s unless the ledger row
     exists AND shows phase ≤ 2 — pushing a callback onto their accepted/resolved order
     would REGRESS it (ledger-less = the pre-08-05 historical imports, long resolved there);
     (2) the read-back additionally verifies `status` really reads 3 (their API answers
     success even when a transition rule swallows the change) — call_again is the ONE push
     that verifies the status flag; the others keep the 08-18 error-classification contract.
     For call_again the comment is just `Agent: <name>` (no reason pair, and
     `next_call_after` is always NULL on leads — lead rule 9 — so there is no callback
     time to send; their API has no scheduling param anyway).
   - **Verified read-back:** after the write, the one-oid re-read compares `count`/`base`,
     each sent address field AND `comment` against what their side now holds; mismatches come
     back as a `warning` on the response and a "remote did NOT apply: …" order note instead of
     a silent success. This caught BOTH transport bugs (GET-drop and transition-drop).
   - **Outbound reason maps** (in `api/index.ts`, `ALTERCPA_PUSH_CANCEL_REASON` /
     `ALTERCPA_PUSH_TRASH_REASON`): same decisions as `ALTERCPA_REASON_DEFAULT` with one
     override — `not_satisfied → 10` (their exact code; round-trips via
     `CANCEL_REASON_TO_CRM[10]`). rude/uncooperative stay 2, never a trash-flagged code.
   - **Loop analysis (2026-08-14):** pushed terminal statuses are outside `STATUS_OPEN`, so the
     `status` kind never re-reads them; confirmed resolves back to `confirmed` (unchanged);
     shipped/delivered hit the courier exception. The old sharp edge (phase-4 unmappable reason
     flips a NON-terminal order to `confirmed`) cannot fire because status 5 is only sent for
     orders already terminal here. NEW hazard: the cron's resize block rewrites our
     quantity/price when untouched && non-terminal && |Δ|>0.02 EUR — mitigated by deriving
     `base` from the lead's implied rate; EUR-denominated leads with qty ≥ 5 are the residual
     case.
   - **Result logging:** `order_notes` line + `audit` (`order.altercpa_push` /
     `_push_failed`) + `altercpa_leads` refresh via a one-oid `comp/list.json` re-read (falls
     back to the pushed status/reason; never guesses phase).
   - **Write scope PROVEN 2026-08-18** (live push on oid 1434157: accept landed, phase 3 on
     read-back). The same test exposed the GET-transport bug above — data fields were
     dropped until the POST fix.
   - `comp/status.json` (coarser: approve/hold/cancel/trash + free-text fields) exists but is
     not used by the button.
4. **Pendings only** (`import_scope='pending_only'` — it must stay that way). Only phase 1/2
   become orders. Phase 3/4/5
   are already decided on their side; importing them would drop finished orders into the calling
   queue and book revenue our agents never earned. They stay in the ledger as `not_pending`.
   This also holds for a newly mapped offer: its leads that were decided before the mapping are
   **not back-imported** — only its pendings from then on enter the CRM.
   ⚠️ **A skip means "do not CREATE an order", never "leave an existing one orphaned."**
   `upsertLead()` used to set `order_id` only when it created the order, so a skipped lead whose
   order already existed from an earlier path stayed unlinked — and the `status` kind's candidate
   query requires `.not("order_id","is",null)`. 204 rows were in that state on 2026-08-13, 20 of
   them orders still in the calling queue that AlterCPA had already closed. A skipped lead now
   **adopts** an existing order on the same `(external_source='altercpa', external_order_id)` key.
   Repair migration: `20260921000200_altercpa_adopt_orphaned_orders.sql`.
   ⚠️ **And skip ≠ leave the existing order pending.** Under `pending_only` a lead that
   resolves inside the rolling 45-minute overlap used to update the ledger to phase 3/4/5
   and skip `upsertOrder` entirely — CRM stayed `pending`. Outcomes were delegated to the
   `status` kind, which is correct only while that kind actually scans the row. As of
   2026-08-22 `upsertLead` also runs B′ `applyOutcomeToExistingOrder` on a skipped lead
   that already has an `order_id`.
5. **`status_mirror = 'until_touched'` is the transition-period operating mode** (revised
   2026-08-11; the original default was `off`). During the migration off AlterCPA their operators
   still resolve most pendings THERE, so the `status` sync kind (below) chases those outcomes —
   but only while nobody here has actually WORKED the order. `off` disables the status kind for
   the account entirely; `always` trusts AlterCPA even over our agents (post-cutover: switch back
   to `off`).

   ⚠️ **"Touched" means worked, NOT merely assigned** (fixed 2026-08-13). `untouched` also tested
   `assigned_agent_id` until then, and that froze orders solid: 70 pendings were assigned by hand
   on 08-06, AlterCPA then closed 37 of them, and every 5-minute run for a week skipped the change
   — `"guarded": 37`, over and over — because an agent nominally owned rows nobody had touched.
   They sat `pending` in a queue while the partner had already cancelled them; only unassigning
   released them. **With the automatic lead-distribution engine assigning every lead within a
   minute of arrival, the old test would have frozen the entire queue permanently.** The guard is
   now `!confirmed_at && status !== 'take'` — a recorded sale, or an agent with the customer open
   at this second. Do not reintroduce `assigned_agent_id` here.

6. **Their call-backs are mirrored (operator rule, 2026-08-13).** While AlterCPA is the system of
   record, our status follows theirs. Their `status = 3` ("Callback") lives **inside phase 1**, so
   `resolveRemoteOutcome()` correctly returns null and the outcome ladder never sees it — on
   2026-08-13, 50 of the 58 live leads were call-backs invisible here. It also cannot travel that
   ladder: `pending`, `take` and `call_again` all share `CRM_STATUS_RANK` 0 and the forward-only
   rule deliberately refuses lateral moves. So it is mirrored as its own explicitly-lateral step:
   - `pending` → `call_again` when they set status 3; `call_again` → `pending` when they clear it.
     **"Clear" = an OBSERVED 3→non-3 transition** (ledger snapshot 3, remote now non-3 — fixed
     2026-08-19): until then the test was just "remote isn't 3", which silently reverted every
     AGENT-set call_again within 5 minutes (their side still showed 1/2) and would have left the
     call_again CPA push nothing to send. An agent's call-back now stands until it is pushed
     (both sides then agree at 3) or until THEY clear an acknowledged callback.
   - `call_again_since` is anchored at the FIRST call-back and never reset (`20260622000000`).
   - `next_call_after` stays NULL — **leads are never throttled** (lead rule 9).
   - `take` is never touched: an agent has the customer open right now; the next run catches it.
   - One `order_notes` line per real remote change (`statusChanged`), not one per run.

   This reverses when the CRM becomes the system of record — the operator will say when.

## The `status` kind — how outcomes arrive (added 2026-08-11)

The windowed kinds filter on CREATION time and can never see an old pending resolve. The
`status` kind inverts it: every 5 minutes (07:00–20:55 Skopje, gate inside
`invoke_altercpa_status_sync()` because pg_cron is UTC and Skopje flips CET/CEST) it takes our
still-open mirrored orders (`pending/take/call_again` first, then `confirmed/shipped/delivered`),
rotates by `last_seen_at ASC` (default cap 2000), re-reads exactly those ids with
`comp/list.json?oid=…` (batches of 100, same non-array-is-failure contract), and resolves
forward-only via `resolveRemoteOutcome` — **the B′ map, not `HISTORY_PHASE_TO_STATUS`** (renamed 2026-09-27; history import only):

⚠️ **Do not sort by `created_remote` ASC with a small cap.** Confirmed/shipped stay in
`STATUS_OPEN` until MEX marks them paid/returned, so they accumulate. On 2026-08-20 that
filled the original 500-row window (377 confirmed + 97 shipped + 26 call_again, **zero
pendings**). Every pending created after 08:25 UTC that day — all of 21–22 Aug — sat
`pending` while AlterCPA had already approved/cancelled/trashed them. The run log looked
healthy (`fetched: 500`, `orders_updated: 0`). `skipped.candidates_total` vs
`candidates_scanned` is how you see the next freeze. Do not drop confirmed/shipped from
the set — an AlterCPA cancel on an unshipped confirmed sale still has to land.

**Final doctrine (2026-08-11, after two same-day corrections): AlterCPA decides only whether a
sale is CONFIRMED or dead; MEX alone decides shipped/paid/returned.** An order may show
`shipped` only when the courier holds the parcel (`orders.mex_tracking_id` set by
`mex-reconcile`), and money lands only on a courier delivery. AlterCPA's own fulfilment
statuses (Packing…Completed) are never trusted for physical facts — the first design mapped
them to shipped/paid, and 142 orders showed "shipped" that MEX had never seen.

| Their record | Our order |
|---|---|
| phase 1/2 | untouched |
| phase 3 approved (any fulfilment status) | `confirmed` — `mex-reconcile` walks it shipped → paid/returned |
| phase 4, reason maps to 'other' (custom 16-19, certificate, offer disabled…) | **`confirmed`** — manager rule (the first version said `paid`; 1.194 orders walked back). reason 0 = no reason recorded stays a cancel. Historical split (operator): cancel-other created BEFORE Aug 2026 = `paid` (settled outside MEX records); from Aug 2026 the courier decides. |
| phase 4, mappable reason | `cancelled` — unless the parcel is already at the courier (CRM shipped/delivered): then untouched, MEX settles it |
| phase 5 | `trashed` — same courier exception |
| absent from response / deleted | untouched, counted `missing_remote` |

Never backwards, never re-open, never rewrite a terminal status; reasons
(`crmReasonFor`, ported from `scripts/backfill-altercpa-reasons.mjs`) are written only alongside
`cancelled`/`trashed`; `last_synced_at` is never advanced. **Paid lands only on their Completed**
— approval alone is not money, and a wrong `paid` is locked, moves commissions/sticky-trash/
revenue, and cannot be corrected. Verify with `node scripts/verify-altercpa-status.mjs`.

**The no-parcel rule and its reopen (owner rules 2026-09-27/28; 10 days since 28.09, was 7).** An
AlterCPA-confirmed order with no MEX parcel 10 days after the approval (`app_settings.no_parcel_rule.days`)
is cancelled `no_parcel_7d` (the code keeps its old name) by the nightly
`apply_no_parcel_rule()` (`20260938000000`, APPLY mode) — our cancel, not the customer's. When the
parcel turns up later, `mex-reconcile` reopens the order (rule C → `shipped`, then MEX decides
paid/returned): on a `tracking` or phone+COD (`phone_cod`) link, or — when the COD differs from
the CRM price, an upsell (~8.3% of 9110 parcels) — on an `upsell_revive` link: a BIO NATURAL
series 9110 parcel with a COD > 0, inside the ship window, on a phone whose only real sale is that
AlterCPA `no_parcel_7d` cancel. Rules: `supabase/functions/mex-reconcile/match.ts`
(`pickCandidate`, `shipGate`). The no-parcel ledger (`no_parcel_rule_items`) is never rewritten
by a reopen: its `cancelled` row stays the true record of that night.

**Only the lead's own parcel reopens it (29.09, `mayReviveWith`).** A cancelled or trashed
AlterCPA lead fits a fresh parcel on its phone only when the parcel is series **9110** ("Нарачка
LEADS", either account). A teleshop (9102 / 9100), social (9108 / 1300) or web parcel on the same
phone is another department's sale: before the guard the phone + COD match had revived July leads
on September teleshop parcels (money in Affiliate – Lead in, the teleshop seller never credited).
The repair `scripts/repair-cross-channel-parcels.mjs` run `a057bc52` put 145 such leads back to
their pre-flip status and unlinked the parcels; their collabBox documents became their own orders
(`elyon-departments-and-sources`).

## Why foreign leads must stay out of `orders`

Two independent reasons, either one sufficient:

- **`normalizeMkPhone` is a REWRITER, not a validator.** It strips any country code it does not
  recognise and prefixes `+389` regardless. A Romanian `+40 721 234 567` becomes
  `+38940721234567` — stored, dialled and matched that way, permanently and silently. It is
  called on *every* intake path in `supabase/functions/api/index.ts`.
- **Blast radius.** The segment engine, prediction lists, the assigner, Insights, commissions,
  payouts and stock all read `orders` unconditionally (354.048 rows on 29.09). Filtering foreign
  rows out downstream is the `monadon_legacy` pattern (`source_type IS DISTINCT FROM …` repeated
  in every engine migration) and would mean auditing all of them.

The bridge instead uses `normalizePhoneForGeo(raw, geo)` in
`supabase/functions/altercpa-sync/altercpa.ts`, which returns **null** for any geo not in its
`DIAL` table. Unknown geo → `phone_e164` stays NULL, `phone_raw` keeps the truth. **Never widen
this by falling back to MK.**

## Idempotency — the thing that makes the whole bridge cheap

The 2026-08 history import wrote `external_source='altercpa'`, `external_order_id=<their id>`,
and `20260521150000` has a partial-unique index on that pair. The live poller reuses the exact
same key, so it continues from the 81.657 imported orders with no duplicates and **no cutover
date to get right**. Do not invent a new key.

## AlterCPA's data, as it really is (not as documented)

- `phase` (1-5) is the reliable outcome field. `status` (1-12) is noisier. Under `pending_only`,
  **1 processing / 2 hold → `pending` (imported); 3/4/5 → ledger only.** Under
  `import_scope='all'` a decided lead is inserted through `insertStatusFor` = the B′ map
  (3 → `confirmed`, 4 → `cancelled` or `confirmed` for "other" reasons, 5 → `trashed`) —
  **never `paid`** (fixed 2026-09-27). The old table, now `HISTORY_PHASE_TO_STATUS`
  (3 → `paid`), is for the settled history import only; on 2026-09-18 the insert path still
  used it and a catch-up created 1.344 orders directly as `paid`, ~345 of which never had a
  parcel. A DB trigger now refuses any `altercpa` insert as paid/returned/shipped/delivered.
- **AlterCPA never moves this account past status 6 "Packing"** — even for parcels MEX
  delivered (checked on all 1.180 catch-up orders, 2026-09-27). Their status can say
  confirmed-or-dead; shipped/paid/returned come from MEX only.
- The documented `items` map is **empty on every real order**. The product is `goods[0].name`,
  falling back to `offername`.
- **The affiliate has no name, anywhere in the API.** `wm` is a bare integer and there is no
  directory endpoint: `comp/list.json` returns no `wmname`/`wmlogin`, and `comp/stats.json`'s
  `item` accepts only offer/date/hour/stage/geo — it cannot even group by affiliate (checked
  against both the EN and RU doc pages, 2026-08-18). Names exist solely in their web panel, so
  `altercpa_webmasters` holds them, an admin maintains them on **/altercpa → Affiliates**, and
  the sync auto-discovers new ids via `altercpa_record_webmaster_sighting`. Same wall, same
  answer as `scripts/data/altercpa-operators.json` for their `user`/`app` operator ids.
  The 5 live names were derived by matching their panel's per-phase counts against our ledger
  for the same window, then seeded in `20260927000000`:
  2676 KMA.biz · 3221 Fomikch · 3223 ezaff.com · 3285 LeadBit · 3226 Nastia Shakes.
- **Attribution lives on `orders`, not only in the ledger** (`20260927000100` + `20260929000000`):
  `cpa_webmaster_id`, `cpa_offer_id`, `cpa_offer_name`, and since 2026-08-19 **`cpa_stream_id`**
  — the publisher/traffic-source code (`tracking.exts`), the third dimension: which media buyer
  UNDER the webmaster (KMA.biz is a reseller network, so this is the only way to tell its buyers
  apart). The ledger began with the live poller on 2026-08-05 and covers only a sliver of the
  82k `external_source='altercpa'` orders, so a read-time join would be blank on 97% of the
  table. The **id** is stored and the name resolved at display time, so renaming a partner is
  one row. Backfilled from `scripts/data/altercpa-mk-raw.jsonl` by
  `scripts/backfill-cpa-attribution.mjs` and `scripts/backfill-cpa-stream.mjs` (idempotent;
  they suppressed triggers via `session_replication_role = replica` so `trg_orders_updated_at`
  did not stamp 82k rows — `GET /call-agains` reports `orders.updated_at` as `last_call_at`. New
  bulk work uses `SET LOCAL elyon.keep_updated_at = 'on'` instead: `session_replication_role`
  cannot be set inside functions on MK).
  **Admin/manager only**: `stripCpaAttribution()` deletes all four fields on the way out of
  `GET /orders` and `GET /orders/:id` for every other role.
- **Streams have NO names and NO registry, on purpose** (operator decision 2026-08-19: "the
  publisher code is okay.. no needed names"). The tracking fields are undocumented in their API,
  no endpoint lists or names streams, and their own panel renders the bare hashes. `exts` is the
  stream code (unique per webmaster — grain is `(stream, wm)`, formats are heterogeneous:
  16-char hashes for KMA, bare numerics for Fomikch/ezaff); **`extu` is a PER-LEAD click id —
  never use it as attribution**. Surfaces: /orders expand "Publisher", a publisher filter,
  /altercpa → Traffic sources tab (`altercpa_stream_distribution()`; the dimensions RPC gained a
  minimal `streams` key). ⚠️ Their panel's per-source counts are LEADS across ALL geos; our
  surfaces count MK ORDERS — a foreign-geo stream (e.g. `drkbu8aj7hhbps6n` = KMA's RS Prostatol
  traffic, 837 leads) correctly shows 0 orders and lives only in the ledger.
- The payload holds much more than we promote — `tracking.{source,campaign,content,term,medium,
  extu}`, `user`/`app` (their operator), `ip`, `gender`, `email`, `base`, `delivery`
  (`tracking.exts` graduated to `orders.cpa_stream_id` 2026-08-19; `tracking.source` is a
  genuinely different UTM-ish axis, populated only on KMA leads — a possible fourth dimension,
  not built). All of it is already in `altercpa_leads.payload` and reachable with plain JSON
  operators; no re-sync is needed to surface any of it.
- Cancel reasons 1-15 are documented; **16-19 are this account's custom codes** with no API
  lookup. Meanings recovered from operator comments — see `scripts/lib/altercpa.mjs`.
- **An error is an OBJECT, not an array.** `{"status":"error",…}` comes back with HTTP 200.
  Code that only checks `Array.isArray` reads it as end-of-stream and reports success while
  importing nothing. Non-array = HARD failure, always.
- Very large windows 500. ~94k records was fine, ~150k died. Halve the window and retry.

## The 30% guarantee — /altercpa (owner decision 01.10.2026)

Every affiliate guarantees that ~30% of the Macedonian leads they send get confirmed (a verbal deal
with all publishers). **One definition, everywhere** (migration `20260944000210`, pure twin
`supabase/functions/api/altercpaGuarantee.ts`):

- **rate = (approved + cancel_other) ÷ ALL MK leads**, read off AlterCPA's own decision
  (`altercpa_leads.decision`, the trigger-kept `altercpa_decision()`): approved = phase 3;
  cancel_other = phase 4 with a non-cancel reason (the 08-11 manager rule); cancelled / trashed;
  NULL = **Отворени** (never "На чекање" — that is only the CRM status `pending`).
- **cohort** = the Skopje ARRIVAL day of `COALESCE(created_remote, first_seen_at)`, bounds
  `(d)::timestamp AT TIME ZONE crm_tz()`; population `geo = altercpa_rate_geo` (stored upper-case —
  a plain `=` that `idx_altercpa_leads_geo_arrival` (`20260944000200`) answers).
- **test leads are excluded and shown apart**: `skip_reason = 'test_order'` (the sync's name/phone
  test — September had 76), the owner's test phones (`report_excluded_phone8s()`), and any wm in
  `app_settings.altercpa_rate_excluded_webmasters` (default `[]`; e.g. 3226 "test" needs no migration).
- N = non-test leads, C = approved + cancel_other, O = open; **required = ceil(target·N/100) in
  integers/NUMERIC** (`altercpa_need_confirm()`; 0.3·70 in floating point is the trap — N 70 → 21);
  need = max(0, required − C); reachable = need ≤ O (else max rate = (C+O)/N); cancellable = O − need;
  margin = C − required. States: too_few (N < `altercpa_rate_min_cohort` 20) · stuck (open older
  than `altercpa_rate_settle_days` 3) · met · settling · below. Risk order: unreachable → below →
  stuck → settling (need desc) → met (margin asc) → too few.
- Secondary figures: **"Реално испратени (MEX)"** = the lead's CRM order at MEX 1,2,3,4,7,9,10,13
  (8 = за пакување); **"Стар метод"** = the 20260922000000 sticky-CRM metric (`crm_sticky`), kept
  ONE release as a muted transition figure (September: 49,9% old vs 36,0% new) — gone in Фаза 8.
- Reference: September 5.754 leads (76 test), approved 1.760 + cancel_other 284 = 2.044 →
  35,5% raw / 36,0% without test. `node scripts/verify-altercpa-guarantee.mjs` (G1–G8, read-only).

Read model (all `SECURITY DEFINER`, service role + the read-only verifier only):
`altercpa_guarantee_base(from,to)` (one row per lead — every reader counts through it) ·
`altercpa_guarantee_rates(from,to)` (GROUPING SETS day / webmaster / stream / offer, one pass;
leads = approved+cancel_other+cancelled+trashed+open) · `altercpa_guarantee_open(from,to,limit)` ·
`altercpa_guarantee_journal(…)` (`{total, rows}`, operator via `sales_person_identities` kind
`altercpa_user`) · `altercpa_guarantee_freshness()`. Routes (admin/manager, **no money**, placed
before the `startsWith("altercpa/leads")` mirror route): `GET altercpa/guarantee/today?day=&back=`,
`…/rates?from&to` (≤ 92 days), `…/leads?from&to&wm&stream&offer&decision&q&test=1&page&limit`
(PII masked by the api's masker).

The page (`src/pages/AlterCpaPage.tsx`, "Афилијати (AlterCPA)"): **Денес** (default; tiles, a card
per webmaster in risk order with ONE sentence — `guaranteeText.ts` —, its open leads, yesterday /
the day before, stuck open leads) · **Стапки** (`?tab=rates&wm=&date=` — the notification links;
matrix from xl, day cards below, the cohort sheet) · **Лидови** (filters in the URL) · **Поставки**
(`?tab=setup&sub=` — the old mirror/offers/affiliates/sources/accounts/runs tabs; old `?tab=` keys
are redirected by `resolveAlterCpaTab`). Money: the mirror's prices (`altercpa/leads`) and
`altercpa/summary.revenue_eur` are **owners only**, server-side (explicit column list, never
`payload`); MirrorTab opens on MK.

Alerts v2 (`20260944000300`, applied in the quiet window): the per-10-leads / per-10-confirms
triggers are dropped; one hourly `altercpa_guarantee_sweep()` sends a digest at 18:xx, "unreachable"
12–20 h, the day's close at 21:xx and the settled verdict at 10:xx — see `elyon-notifications`.

## Traps

- **Outcome timestamps must come from THEIR clock** (`o.paid`, `o.done`), not `now()`. The
  NULL-only BEFORE triggers would otherwise restart the engine v3.7 21-day Trash List parking
  period from today, and push a COD paid last week into this week's payout window.
- **An unmapped offer must never import with `product_id = NULL`.** That order is invisible to
  every product and stock report and nothing surfaces the gap. Mirror it, set
  `skip_reason='unmapped_offer'`, and let `altercpa_offer_map` be the work queue.
  **28.09:** the 10 MK offers that had been arriving unmapped since 17.09 (their leads never
  entered the CRM — GlucoCare had 202) were mapped; 8 new products were created for them
  (GlucoCare, MenCare, ProstaCare, NeuroCare, Arthriva, Collagen Peptides Bionatural, Neurofix
  1+1, Prostafix 1+1 — the 1+1 are bundles of 2) in category "AlterCPA — нови понуди
  (28.09.2026)": active, stock placeholder 1000, cost price 0 (the owner sets it). Map a new offer
  on /altercpa; from then on its pending leads enter the CRM — its leads decided before the mapping
  are not back-imported (`pending_only`).
- **A currency with no rate yields `price_eur = NULL`**, never a guessed number. Once a fabricated
  figure is in a report there is nothing to distinguish it from a real one. Extend `FX_TO_EUR`
  deliberately, per currency.
- **A backfill must not advance `last_synced_at`** — it looks at the past, and moving the cursor
  skips everything between the backfill's end and now.
- **Never recompute segments per row in a backfill.** The August import disabled the trigger
  (`scripts/segment-trigger-mk.mjs --disable`, then `--recompute`); since 28.09 a bulk writer sets
  `SET LOCAL elyon.defer_segments = 'on'` instead and drains `segment_recompute_queue` with
  `segment_recompute_drain()` afterwards (`20260942000300`, `elyon-segments-and-prediction`).
  Either way, never one full segment recompute per imported row.
- **The merchant token lives in a Supabase function secret**, and `altercpa_accounts` stores only
  its NAME. A token can read every order in the account — never put it in a table or a body.
- **`altercpa_*` tables are admin/manager only**, deliberately NOT `is_internal_staff`:
  `payload` holds every competing webmaster's volumes and customer PII across every geo.
- **Status-kind candidate selection must prefer the calling queue and rotate.** See the
  2026-08-20 starvation above. Never go back to `created_remote ASC` + 500.
- **A sweep's run row being ok does not mean the sweep finished.** Sweeps span invocations
  (2026-09-28): check `altercpa_sweeps.status = 'done'`, and the slices by `sweep_id`.

## The window is CREATION time (measured 2026-08-06)

`node scripts/probe-altercpa-window.mjs --month 2025-06` proved it: re-fetching a month captured
in August returns exactly the same id set, and nothing created outside the window comes back.

So the 2-minute rolling poll sees **new leads only** — it can never observe a later phase change.
Outcome-chasing is the `status` kind's job (by `oid`, above); the nightly/weekly sweeps exist to
fill gaps when the function was down, not to chase outcomes.

Same probe measured creation→settlement: **p50 0.5d, p90 44d, p99 59d, max 129d**. Relevant if
`import_scope` is ever set to `all`, where the weekly window must exceed the p99.

## Sweeps are resumable (2026-09-28)

From 18.09 to 28.09 no nightly (7 d) or weekly (90 d) sweep finished: ~88 ms of DB round-trips per
lead in ONE invocation, killed by the edge wall clock (~150 s) before it wrote its end — every
run row "stale: still running after 10 minutes". Now (`20260940000100`, `altercpa-sync/sweep.ts`):

- A sweep is a row in **`altercpa_sweeps`**: window fixed at open (creation time, both ends
  inclusive), `cursor_at` = every lead created before it is written, a lease, and how it ended
  (`done` · `superseded` · `expired` · `failed`).
- It is worked in **day chunks** (one `comp/list.json` call per day), leads in `(time, id)` order,
  the cursor checkpointed after every page of 100, **100 s** of new work per invocation. The
  cron **`altercpa-sync-continue`** (`1-59/2 * * * *`) POSTs `{kind:'continue'}` through
  `invoke_altercpa_sync()` only while a sweep is open and unleased; otherwise it makes no HTTP
  call. The nightly/weekly crons keep their schedules and now OPEN a sweep:
  `altercpa-sync-nightly` `15 1 * * *` UTC (03:15 Skopje in summer, the last 7 days) and
  `altercpa-sync-weekly` `45 2 * * 0` (Sunday 04:45, 90 days). The first 90-day sweep under this
  code (started by hand 29.09 04:48) finished at 05:11; the Sunday runs had failed since 16.08.
- **One run row per invocation** (kind = the sweep's, `sweep_id`), ok once its chunks are written.
  An ok row ≠ a finished sweep: read `altercpa_sweeps.status`.
- **One open sweep per account.** A start while one is open continues it, except weekly-over-
  nightly (the nightly closes `superseded`). A 240 s lease keeps two slices off one sweep; a slice
  that lost it cannot move the cursor. A throwing slice pauses the sweep 5 min; a killed one is
  retried when its lease runs out.
- **Every sweep ends**: 20 h open → `expired`, 8 claims in a row without progress → `failed`, each
  with a FAILED run row naming reason, days written, cursor and last error — that is what
  `integrations_health()` shows as the failing nightly/weekly job.
- A completed sweep moves `last_synced_at` **forward only**.

⚠️ **Never make a sweep one-shot again** — the wall clock will kill it at any real volume.

⚠️ **Never fork the per-lead logic for sweeps.** A sweep page calls the same `buildLead` +
`upsertLead` as rolling; the page only batches READS. A prefetched order status may SKIP the
per-order read (`forwardOutcome` says nothing to do) but never decides a write — that is always
made on a fresh read. New ledger rows stay one INSERT each (until 20260944000300 dropped it,
`trg_altercpa_lead_rate` counted the arrival cohort per inserted row; keep single inserts anyway —
the ledger trigger that keeps `decision` / `decided_*` is per row too).

⚠️ The cursor is a creation SECOND: a budget cut re-writes that second's written leads
(idempotent). Progress needs one second's leads to fit in one invocation — true by orders of
magnitude, but do not shrink the budget to nothing.

## Verify, don't trust the run log

`node scripts/verify-altercpa-bridge.mjs --days 7` re-fetches independently and compares the API,
the ledger and `orders`, and asserts containment (no `geo_not_callable` lead has an order). The
run log records what the sync *believed* it saw.

## Promoting a geo

Adding a country to `callable_geos` is **not sufficient** — see the blocker table in
`docs/ALTERCPA-BRIDGE.md`. At minimum: a `DIAL` entry, geo-scoped last-8 dedupe, per-geo currency
rendering (`formatMoney` prints `ден` unconditionally), a courier, and agent→market routing.
