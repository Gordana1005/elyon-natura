---
name: elyon-altercpa-bridge
description: The AlterCPA → Elyon lead mirror — ledger-first design, callable geos, offer mapping, status mirroring, and why nothing flows back. Read before touching altercpa_* tables, the altercpa-sync edge function, /altercpa admin routes, or anything that would put a foreign-geo lead into public.orders.
---

# AlterCPA bridge — how the mirror works

Shipped 2026-08-06. Full reference: `docs/ALTERCPA-BRIDGE.md`.

Leads arrive at AlterCPA from the affiliate network and keep arriving there. This pulls a copy
into Elyon so the CRM is one place. **We poll them; nothing is configured on their side.**

## The five decisions (do not re-litigate)

1. **Ledger first, orders second.** EVERY record lands in `altercpa_leads` — every geo, with the
   raw payload. Only geos listed in `altercpa_accounts.callable_geos` are ALSO written to
   `public.orders`. Foreign traffic is mirrored and reported on, never called.
2. **Foreign geos never enter `orders`.** Not "enter and get filtered" — never enter. See below.
3. **Nothing flows back to AlterCPA.** Their operators own the outcome on their side. This is
   structural, not a setting: mirrored orders get no `affiliate_leads` row, so
   `tg_enqueue_affiliate_postback` has nothing to fire on.

   *Asked 2026-08-13: could we later push a CRM disposition back to them (a "CPA" button on a
   cancelled order)?* **Yes — their API supports it. Researched, not built. Do not build it until
   the operator asks.** The no-postback rule above is about the **affiliate payout** drain, a
   different system, and does not stand in the way.

   Their merchant API (https://cpa.moe/en/api-comp.html) has two write endpoints on the host we
   already read from, using the same `id={user}-{key}` credential shape as `comp/list.json`:
   - **`comp/edit.json`** — the one we would want. Sets `status` **1-12** (the full ladder,
     including 3 Callback and 5 Cancelled) plus **`reason`**, a cancel code **1-15** — the very
     same numbering as our `REASON` map in `altercpa.ts`. So status + reason + note round-trips.
   - **`comp/status.json`** — coarser: `status` is only approve / hold / cancel / trash (phase
     level, no reason parameter), plus `comment`, `name`, `phone`, `email`, `count`, `base`.
     Responds `{"status":"ok"}` or `{"status":"error","error":"access-denied"}`.

   Three things to settle BEFORE writing any of it:
   1. **Write scope is undocumented.** The docs say nothing about what permission a key needs for
      writes; `access-denied` and `edit` are documented error codes. Prove it with ONE order.
   2. **The reverse reason map is lossy and needs operator decisions.** `CANCEL_REASON_TO_CRM`
      only ever had to go inbound. Outbound, several CRM reasons have no code on their side —
      `no_money`, `family_refused`, `still_using_product`, `not_interested`, `will_call_back`,
      `pending_cleanup`, `stale_pending_cleanup`. Someone must choose each mapping; do not invent
      them. (Their 16-19 are this account's own custom codes.)
   3. **Check the loop.** Pushing a cancel makes their phase 4, which the `status` kind reads back
      5 minutes later. Today that converges safely — `cancelled` is in `CRM_TERMINAL` and the sync
      never rewrites a terminal status — but note the sharp edge: the manager rule maps a phase-4
      cancel whose reason has **no** CRM equivalent to `confirmed`. Push an unmappable reason onto
      a non-terminal order and it would flip back. Re-verify this the day it is built.
4. **Pendings only** (`import_scope='pending_only'`). Only phase 1/2 become orders. Phase 3/4/5
   are already decided on their side; importing them would drop finished orders into the calling
   queue and book revenue our agents never earned. They stay in the ledger as `not_pending`.
   ⚠️ **A skip means "do not CREATE an order", never "leave an existing one orphaned."**
   `upsertLead()` used to set `order_id` only when it created the order, so a skipped lead whose
   order already existed from an earlier path stayed unlinked — and the `status` kind's candidate
   query requires `.not("order_id","is",null)`. 204 rows were in that state on 2026-08-13, 20 of
   them orders still in the calling queue that AlterCPA had already closed. A skipped lead now
   **adopts** an existing order on the same `(external_source='altercpa', external_order_id)` key.
   Repair migration: `20260921000200_altercpa_adopt_orphaned_orders.sql`.
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
   - `call_again_since` is anchored at the FIRST call-back and never reset (`20260622000000`).
   - `next_call_after` stays NULL — **leads are never throttled** (lead rule 9).
   - `take` is never touched: an agent has the customer open right now; the next run catches it.
   - One `order_notes` line per real remote change (`statusChanged`), not one per run.

   This reverses when the CRM becomes the system of record — the operator will say when.

## The `status` kind — how outcomes arrive (added 2026-08-11)

The windowed kinds filter on CREATION time and can never see an old pending resolve. The
`status` kind inverts it: every 5 minutes (07:00–20:55 Skopje, gate inside
`invoke_altercpa_status_sync()` because pg_cron is UTC and Skopje flips CET/CEST) it takes our
still-open mirrored orders (`pending/take/call_again/confirmed/shipped/delivered`), re-reads
exactly those ids with `comp/list.json?oid=…` (batches of 100, same non-array-is-failure
contract), and resolves forward-only via `resolveRemoteOutcome` — **the B′ map, not
`PHASE_TO_STATUS`**:

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

## Why foreign leads must stay out of `orders`

Two independent reasons, either one sufficient:

- **`normalizeMkPhone` is a REWRITER, not a validator.** It strips any country code it does not
  recognise and prefixes `+389` regardless. A Romanian `+40 721 234 567` becomes
  `+38940721234567` — stored, dialled and matched that way, permanently and silently. It is
  called on *every* intake path in `supabase/functions/api/index.ts`.
- **Blast radius.** The segment engine, prediction lists, the assigner, Insights, commissions,
  payouts and stock all read `orders` unconditionally against 80.360 live rows. Filtering foreign
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
  **1 processing / 2 hold → `pending` (imported); 3/4/5 → ledger only.** The full map
  (3 → `paid`, 4 → `cancelled`, 5 → `trashed`) applies only under `import_scope='all'`.
- The documented `items` map is **empty on every real order**. The product is `goods[0].name`,
  falling back to `offername`.
- Cancel reasons 1-15 are documented; **16-19 are this account's custom codes** with no API
  lookup. Meanings recovered from operator comments — see `scripts/lib/altercpa.mjs`.
- **An error is an OBJECT, not an array.** `{"status":"error",…}` comes back with HTTP 200.
  Code that only checks `Array.isArray` reads it as end-of-stream and reports success while
  importing nothing. Non-array = HARD failure, always.
- Very large windows 500. ~94k records was fine, ~150k died. Halve the window and retry.

## Traps

- **Outcome timestamps must come from THEIR clock** (`o.paid`, `o.done`), not `now()`. The
  NULL-only BEFORE triggers would otherwise restart the engine v3.7 21-day Trash List parking
  period from today, and push a COD paid last week into this week's payout window.
- **An unmapped offer must never import with `product_id = NULL`.** That order is invisible to
  every product and stock report and nothing surfaces the gap. Mirror it, set
  `skip_reason='unmapped_offer'`, and let `altercpa_offer_map` be the work queue.
- **A currency with no rate yields `price_eur = NULL`**, never a guessed number. Once a fabricated
  figure is in a report there is nothing to distinguish it from a real one. Extend `FX_TO_EUR`
  deliberately, per currency.
- **A backfill must not advance `last_synced_at`** — it looks at the past, and moving the cursor
  skips everything between the backfill's end and now.
- **Disable `trg_orders_segments_insert` before any backfill** (`scripts/segment-trigger-mk.mjs
  --disable`, then `--recompute`), or you get one full segment recompute per imported row.
- **The merchant token lives in a Supabase function secret**, and `altercpa_accounts` stores only
  its NAME. A token can read every order in the account — never put it in a table or a body.
- **`altercpa_*` tables are admin/manager only**, deliberately NOT `is_internal_staff`:
  `payload` holds every competing webmaster's volumes and customer PII across every geo.

## The window is CREATION time (measured 2026-08-06)

`node scripts/probe-altercpa-window.mjs --month 2025-06` proved it: re-fetching a month captured
in August returns exactly the same id set, and nothing created outside the window comes back.

So the 2-minute rolling poll sees **new leads only** — it can never observe a later phase change.
Outcome-chasing is the `status` kind's job (by `oid`, above); the nightly/weekly sweeps exist to
fill gaps when the function was down, not to chase outcomes.

Same probe measured creation→settlement: **p50 0.5d, p90 44d, p99 59d, max 129d**. Relevant if
`import_scope` is ever set to `all`, where the weekly window must exceed the p99.

## Verify, don't trust the run log

`node scripts/verify-altercpa-bridge.mjs --days 7` re-fetches independently and compares the API,
the ledger and `orders`, and asserts containment (no `geo_not_callable` lead has an order). The
run log records what the sync *believed* it saw.

## Promoting a geo

Adding a country to `callable_geos` is **not sufficient** — see the blocker table in
`docs/ALTERCPA-BRIDGE.md`. At minimum: a `DIAL` entry, geo-scoped last-8 dedupe, per-geo currency
rendering (`formatMoney` prints `ден` unconditionally), a courier, and agent→market routing.
