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
4. **Pendings only** (`import_scope='pending_only'`). Only phase 1/2 become orders. Phase 3/4/5
   are already decided on their side; importing them would drop finished orders into the calling
   queue and book revenue our agents never earned. They stay in the ledger as `not_pending`.
5. **`status_mirror = 'until_touched'` is the transition-period operating mode** (revised
   2026-08-11; the original default was `off`). During the migration off AlterCPA their operators
   still resolve most pendings THERE, so the `status` sync kind (below) chases those outcomes —
   but only while nobody here has taken or confirmed the order. **"Once we have taken a pending,
   the order is ours" still holds**: an agent-owned order is never overwritten; the remote change
   becomes one `order_notes` line per remote phase change. `off` disables the status kind for the
   account entirely; `always` trusts AlterCPA even over our agents (post-cutover: switch back
   to `off`).

## The `status` kind — how outcomes arrive (added 2026-08-11)

The windowed kinds filter on CREATION time and can never see an old pending resolve. The
`status` kind inverts it: every 5 minutes (07:00–20:55 Skopje, gate inside
`invoke_altercpa_status_sync()` because pg_cron is UTC and Skopje flips CET/CEST) it takes our
still-open mirrored orders (`pending/take/call_again/confirmed/shipped/delivered`), re-reads
exactly those ids with `comp/list.json?oid=…` (batches of 100, same non-array-is-failure
contract), and resolves forward-only via `resolveRemoteOutcome` — **the B′ map, not
`PHASE_TO_STATUS`**:

| Their record | Our order |
|---|---|
| phase 1/2 | untouched |
| phase 3, status 6–9 (Packing…Arrived) | `shipped` — **never `confirmed`** (that is our warehouse's to-ship queue → double shipment) |
| phase 3, status 10 Completed or `o.paid > 0` | `paid`, `paid_at` from their clock |
| phase 3, status 11 Return | `returned` |
| phase 4 | `cancelled` + reason map — or `returned` if we already saw it ship |
| phase 5 | `trashed` + reason map |
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
