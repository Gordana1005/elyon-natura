# AlterCPA → Elyon bridge

Leads arrive at AlterCPA from the affiliate network and **keep arriving there** — nothing about
that changes. This bridge pulls a copy into Elyon so the CRM is one place.

Built 2026-08-06, live the same day. Four operator decisions define its shape:

1. **Foreign geos are mirror + report only.** Macedonian agents call only MK leads.
2. **Read-only API access for the sync.** We poll; nothing has to be configured in AlterCPA's
   panel.
3. **Nothing flows back automatically.** AlterCPA's operators own the outcome on their side; we
   decide independently on ours. **No automatic postbacks, ever.** The ONE outbound path
   (added 2026-08-14) is the **manual CPA push** on /orders — admin/manager sends a single order
   (or, since 2026-08-18, a selection that loops the same endpoint one order at a time) and its
   current state goes to `comp/edit.json` as **two POSTs** — the state transition and the data
   fields separately, because a call that performs a real transition silently drops its data
   fields, and data fields in a GET query string are always dropped (both found live
   2026-08-18). The write signs with the dedicated push token
   (`push_token_secret_name`, Dragana) so their panel attributes it to her; the confirming agent
   rides in the comment (`Agent: <name>`). Gated by `app_settings.altercpa_push_enabled`
   (default off). Since 2026-08-19 `call_again` is pushable too (their status 3 Callback) —
   guarded to leads the ledger still shows in phase ≤ 2, so a callback can never regress an
   order they already accepted or resolved; the same change made the status cron's callback
   mirror revert (`call_again` → `pending`) fire only on an observed 3→non-3 remote
   transition, so agent-set call-backs survive until they are pushed.
   Full contract in `.grok/skills/elyon-altercpa-bridge` decision #3.
4. **Pendings only.** Only AlterCPA phase 1 (processing) and 2 (hold) become orders here. An
   order they already approved, cancelled or trashed has been decided — importing it would drop
   a finished order into the calling queue, and for phase 3 would book revenue and commission our
   agents never earned. Everything else stays in the ledger, fully visible in reports.

---

## How it works

```
                    ┌───────────────────────────────────────────────┐
  api.cpa.moe ──────▶  altercpa-sync  (edge fn, pg_cron every 2 min) │
  comp/list.json     └────────────────┬──────────────────────────────┘
                                      │
                         ┌────────────▼────────────┐
                         │   altercpa_leads        │  ← EVERY record, every geo,
                         │   (the ledger)          │    raw phone, raw price,
                         └────────────┬────────────┘    full payload
                                      │
                     callable geo?    │
                  ┌───────NO──────────┴───────YES──────────┐
                  ▼                                        ▼
       report-only. Never enters                  upsert into `orders`
       orders / segments / queues                 (external_source='altercpa')
       Visible on /altercpa                       → normal MK pipeline
```

**Why the ledger-first split is the whole design.** The alternative — put every geo into
`orders` and filter foreign ones out downstream — is the `monadon_legacy` pattern
(`source_type IS DISTINCT FROM …`, repeated in every segment-engine migration since
`20260627000000`). It would mean auditing the engine, prediction lists, the assigner, Insights,
commissions, payouts and stock against 80.360 live orders. Ledger-first has **zero blast radius**
on all of them.

It also contains a live data-corruption hazard. `normalizeMkPhone`
(`supabase/functions/api/index.ts`) is a **rewriter, not a validator**: a Romanian
`+40 721 234 567` comes back as `+38940721234567`, and is then stored, dialled and matched that
way. Foreign leads never reach any code path that would normalize them; the ledger keeps
`phone_raw` verbatim and leaves `phone_e164` NULL for any geo whose dialling rules we have not
explicitly added.

**Idempotency is free.** The 2026-08 history import wrote `external_source='altercpa'`,
`external_order_id=<their id>`, and `20260521150000` puts a partial-unique index on that pair.
The live poller reuses it, so it continues from the 81.657 already-imported orders with no
duplicates and no cutover date to get right.

**No AUTOMATIC postback is structural, not a setting.** Mirrored orders get no `affiliate_leads`
row, so `tg_enqueue_affiliate_postback` (`20260904000200`) finds nothing and returns. Do not
"fix" that by giving these orders a sidecar. The manual CPA button
(`POST /orders/:id/altercpa-push`, 2026-08-14) is a separate operator-triggered route that never
touches the affiliate drain.

---

## Pieces

| Piece | Where |
|---|---|
| Sync function | `supabase/functions/altercpa-sync/index.ts` |
| AlterCPA vocabulary (Deno port) | `supabase/functions/altercpa-sync/altercpa.ts` |
| Tables + RLS | `supabase/migrations/20260914000000_altercpa_bridge.sql` |
| Offer-sighting RPC | `supabase/migrations/20260914000100_altercpa_offer_sighting.sql` |
| Schedulers | `supabase/migrations/20260914000200_altercpa_sync_cron.sql` |
| Resumable sweeps (2026-09-28) | `supabase/functions/altercpa-sync/sweep.ts` (+ `sweep.test.ts`) + `supabase/migrations/20260940000100_altercpa_sweep_resume.sql` — see **Sweeps** below |
| Report rollups | `supabase/migrations/20260914000300_altercpa_summary.sql` |
| Admin routes | `supabase/functions/api/index.ts` → `altercpa/*` |
| Admin UI | `src/pages/AlterCpaPage.tsx`, `src/components/altercpa/` |
| Manual CPA push (2026-08-14) | `supabase/functions/api/index.ts` → `POST orders/:id/altercpa-push`; button + dialog in `src/pages/Orders.tsx`; toggle in Settings → System |
| Order attribution (wm/offer/stream) | `orders.cpa_webmaster_id/cpa_offer_id/cpa_offer_name` (`20260927000100`) + `cpa_stream_id` = tracking.exts, raw code, no names (`20260929000000`, 2026-08-19); backfills `scripts/backfill-cpa-attribution.mjs` + `backfill-cpa-stream.mjs`; Sources tab `src/components/altercpa/SourcesTab.tsx` ← `altercpa_stream_distribution()` |
| Reconciliation | `scripts/verify-altercpa-bridge.mjs` |
| Status-sync reconciliation | `scripts/verify-altercpa-status.mjs` |
| Status-sync scheduler | `supabase/migrations/20260918000000_altercpa_status_sync.sql` |
| Window-semantics probe | `scripts/probe-altercpa-window.mjs` |

### Tables

- **`altercpa_accounts`** — one row per AlterCPA install. Several networks (cpa.moe, cpa.toys,
  cashfactories) can run side by side. `token_secret_name` holds the **name** of a function
  secret, never a token. `callable_geos` decides which geos become orders, `import_scope` decides which phases, and
  `status_mirror` (default `off`) decides whether their later outcome may touch our order.
- **`altercpa_leads`** — the ledger. Every record, every geo, `payload` jsonb so any decision is
  replayable without re-fetching. `skip_reason` says why a row is not an order.
- **`altercpa_offer_map`** — `(account, geo, offer name) → product`. Self-populating: a new offer
  name is recorded on first sighting and appears in the admin queue.
- **`altercpa_sync_runs`** — what each run fetched, created and skipped. For a sweep: one row
  per invocation ("slice"), `sweep_id` set.
- **`altercpa_sweeps`** (2026-09-28) — one row per nightly/weekly sweep: its fixed window, the
  cursor, the lease, and how it ended (`done` · `superseded` · `expired` · `failed`).

### AlterCPA vocabulary

`phase` is the reliable outcome field; `status` (1–12) is noisier. The documented `items` map is
**empty on every real order** — the product lives in `goods[0].name`.

| phase | meaning | → Elyon status (at import) |
|---|---|---|
| 1 | processing | `pending` ✅ imported |
| 2 | hold | `pending` ✅ imported |
| 3 | approved | ledger only (`not_pending`) |
| 4 | cancelled | ledger only (`not_pending`) |
| 5 | trash | ledger only (`not_pending`) |

Once imported, an order's RESOLUTION arrives through the `status` sync kind (below), which maps
the remote record forward-only via `resolveRemoteOutcome` (the **B′ map**, 2026-08-11 decision —
deliberately not `HISTORY_PHASE_TO_STATUS` (renamed from `PHASE_TO_STATUS` 2026-09-27 after the 18.09 catch-up inserted 1.344 orders as `paid` through it), whose `3 → paid` was correct only for the settled history
import):

**Final doctrine (2026-08-11): AlterCPA decides confirmed-or-dead; MEX alone decides
shipped/paid/returned** (an order shows `shipped` only with a real `mex_tracking_id`).

| Their record | → Elyon status |
|---|---|
| phase 1/2 | untouched (`still_open_remote`) |
| phase 3 approved (any fulfilment status) | `confirmed` — `mex-reconcile` walks it shipped → paid/returned |
| phase 4, reason with no CRM equivalent (→ 'other') | **`confirmed`** — manager rule (first version said `paid`; 1.194 walked back). reason 0 stays a cancel. Pre-Aug-2026 history: operator ruled those `paid`. |
| phase 4, mappable reason | `cancelled` — unless the parcel is at the courier: then untouched, MEX settles it |
| phase 5 trash | `trashed` — same courier exception |
| id absent from response (deleted there) | untouched, counted `missing_remote` |

Rules: never backwards (`CRM_STATUS_RANK`), never rewrite a terminal status, never re-open;
reasons (`crmReasonFor`, the port of `scripts/backfill-altercpa-reasons.mjs`) only alongside
`cancelled`/`trashed`; ownership guard per `status_mirror` — `until_touched` (the transition
operating mode) applies only while `assigned_agent_id IS NULL AND confirmed_at IS NULL`, and a
guarded remote change becomes one `order_notes` line per remote phase change.

Cancel reasons 1–15 are documented; **16–19 are this account's own custom codes** and the API
exposes no lookup for them. Their meanings were recovered from operator comments during the
history import — see `scripts/lib/altercpa.mjs`.

### Outcome timestamps

`paid_at` / `cancelled_at` / `trashed_at` are set from **AlterCPA's own clock** (`o.paid`,
`o.done`), not ours. The NULL-only BEFORE triggers would otherwise stamp `now()`, which would
restart the engine v3.7 21-day Trash List parking period from today and push a COD paid last week
into this week's payout window.

---

## Setup

```bash
node scripts/assert-mk-target.mjs          # 🛑 before every state-changing command

# 1. the merchant token (read-only use), as a function secret
npx supabase secrets set ALTERCPA_TOKEN_MAIN=<token> --project-ref bmfxhgznttcnnlqloqzp

# 2. the cron gate — must match the vault row
npx supabase secrets set ALTERCPA_SYNC_SECRET=<64-hex> --project-ref bmfxhgznttcnnlqloqzp
#    SELECT vault.create_secret('<same 64-hex>', 'altercpa_sync_secret');
```

Then **/altercpa → Accounts → Add account**, with `token_secret_name = ALTERCPA_TOKEN_MAIN`.
The card shows a red **No token** badge if that secret is not actually present — an account
configured without its secret is the single most likely reason for a bridge that reports success
and imports nothing.

Both secrets are recorded in `docs/VAULT.md` §2 (gitignored).

## Schedule

| Job | Cron (UTC) | Window |
|---|---|---|
| `altercpa-sync-rolling` | `*/2 * * * *` | `last_synced_at − 45 min → now` |
| `altercpa-sync-nightly` | `15 1 * * *` | opens a sweep over the last 7 days |
| `altercpa-sync-weekly` | `45 2 * * 0` | opens a sweep over the last 90 days |
| `altercpa-sync-continue` | `1-59/2 * * * *` | works an open sweep on from its cursor; no HTTP at all while none is open (2026-09-28) |
| `altercpa-sync-status` | `*/5 * * * *` | not a window — our open orders, by `oid` |
| `mex-reconcile` | `7,37 * * * *` | MEX shipments by `updated_from`, both accounts (see below) |

**`mex-reconcile`** (`20260918000100`, edge fn `supabase/functions/mex-reconcile`; the pure
matching rules live in `match.ts`, tested by `match.test.ts`) is the courier ground-truth
corrector: twice an hour (07:00–20:55 Skopje gate, plus a Sunday sweep of the last 60 days) it
pulls every shipment MEX updated since the cursor from BOTH accounts (BIO NATURAL = the Elyon
business, series 9110/9103; NATURA = teleshop/social/web), upserts each into the parcel register
`mex_parcels`, then matches it — never guessing:

1. **remembered** — the order whose `orders.mex_tracking_id` is the parcel (`tracking`);
2. **fresh** — phone → E.164, unlinked orders created within [−3d … +75d], **real sales only**
   (price > 0, a real product name, not `duplicated`):
   - COD = round(price€ × 61.5) [+150 delivery] ±3 ден → `phone_cod`, nearest date wins;
   - no COD fit, exactly ONE real sale on the phone, open/shipped/delivered → `phone_single`;
   - **upsell revive** (owner rule 2026-09-28) — no COD fit, exactly ONE real sale on the phone,
     it is our own 7-day no-parcel cancel (`no_parcel_7d`) of an AlterCPA order, and the parcel
     is BIO NATURAL series 9110 with a COD > 0 (an upsell: ~8.3% of 9110 parcels carry a COD ≠
     the CRM price) → `upsell_revive`;
   - anything else is skipped and counted (`ambiguous`, `single_not_open`, …).

Every link goes through `mex_link_parcel()`. Then **2 Delivered → paid** (`paid_basis 'mex'`)
and **7 Returned → returned** from any status (operator decision 2026-08-11 — the courier's
record of collected COD outranks anything AlterCPA says); any other status → **shipped**,
forward-only from open statuses, plus **rule C** (MEX outranks AlterCPA): an AlterCPA
cancel/trash, or a `no_parcel_7d` cancel, whose parcel turns up on a `tracking`/`phone_cod`
link — or the `no_parcel_7d` AlterCPA cancel an `upsell_revive` link names — goes to shipped
and then follows MEX. `duplicated` rows are never touched and a 0-value row never takes money.
Run log: `mex_sync_runs` (per-rule counters in `skipped`: `rule_c`, `fallback_single`,
`upsell_revive`, …). `scripts/reconcile-mex-shipments.mjs` mirrors the fresh-match rules except
the upsell revive (a portal CSV has no MEX account); the CSV-export path remains only for
ADDRESS backfill (the API withholds `receiver_address`).

`altercpa-sync-status` (added 2026-08-11, `20260918000000`) fires around the clock but
`invoke_altercpa_status_sync()` gates on `hour(Europe/Skopje) BETWEEN 7 AND 20` — i.e. it works
07:00–20:55 local, DST-proof, and pre-gates on any active account having
`status_mirror <> 'off'`. Each run takes the ledger rows linked to still-open orders
(`pending/take/call_again` first, then `confirmed/shipped/delivered`, rotated by
`last_seen_at`, `limit` 2000 default) and re-reads exactly those ids with
`comp/list.json?oid=…` in batches of 100.

⚠️ The original query (`created_remote ASC`, cap 500) starved every pending after
2026-08-20 08:25 UTC: confirmed/shipped filled the window and never leave `STATUS_OPEN`
until MEX settles them. Do not restore that sort. The run log's `skipped.candidates_total`
vs `candidates_scanned` is the freeze detector.

**The window is CREATION time** — measured 2026-08-06 with `scripts/probe-altercpa-window.mjs`:
re-fetching a month captured in August returns exactly the same id set. So the rolling poll sees
**new leads only** and can never observe a later phase change. Outcome-chasing is the `status`
kind's job; the sweeps exist to fill gaps when the function was down.

The same probe measured creation→settlement: **p50 0.5d, p90 44d, p99 59d, max 129d** — relevant
only if `import_scope` is ever set to `all`, where the weekly window must exceed the p99.

## Sweeps: resumable (2026-09-28)

From 18.09 to 28.09 not one nightly or weekly sweep finished. The function spent ~88 ms of DB
round-trips per lead (+ ~0.5 s fixed) and worked the whole window in one invocation, so the edge
wall clock (~150 s) killed it before it wrote the run's end: every run row ended
"stale: still running after 10 minutes" (last complete nightly: 08-09). A sweep now outlives any
one invocation — `20260940000100_altercpa_sweep_resume.sql`, `altercpa-sync/sweep.ts`:

- **A sweep is a row** in `altercpa_sweeps`. Its window is FIXED when it opens (nightly
  `now − 7 d → now`, weekly `now − 90 d → now`; AlterCPA creation time, both ends inclusive), and
  `cursor_at` says how far it got: every lead created before it is written.
- **Day chunks.** Each API call fetches `[cursor, cursor + 1 day − 1]`. Leads are written in
  `(time, id)` order and the cursor is checkpointed after every page of 100, so a killed
  invocation loses one page, never the sweep. A budget cut puts the cursor on the first unwritten
  lead's second; that second's already-written leads are written again (every write is
  idempotent), nothing is skipped. Progress needs one second's leads to fit in one invocation —
  AlterCPA creates a handful a second at most.
- **100 s per invocation.** A slice stops STARTING work 100 s in, then records the sightings, its
  run row and releases its lease. The per-lead work is the rolling kind's own (`buildLead` +
  `upsertLead`); only the READS are batched per page — the ledger rows, the orders a skipped lead
  may adopt, the status of every linked order. That status is a **prefilter only**: it may skip
  the per-order read when B′ has nothing to do from it (`forwardOutcome`), but every write is
  decided on a fresh read, as before. Ledger updates go out 8 at a time; NEW ledger rows are
  inserted one by one, in lead order (`trg_altercpa_lead_rate` counts the cohort per inserted row).
- **The continuation cron** `altercpa-sync-continue` closes stale sweeps in SQL, then POSTs
  `{kind:'continue'}` through `invoke_altercpa_sync()` — only while a sweep is open and unleased.
  Otherwise it makes no HTTP call, which is its state for most of the day.
- **One run row per invocation**: `kind` = the sweep's, `sweep_id` set, window = the
  creation-time span that slice wrote. It ends `ok` once its chunks are written, while the sweep
  goes on (`skipped.budget_exhausted = 1`: it stopped for the budget). **An ok row does not mean
  the sweep finished — `altercpa_sweeps.status = 'done'` does.**
- **Overlap.** One open sweep per account (`uq_altercpa_sweeps_open`). A start while one is open
  continues THAT sweep (the start is absorbed) — except a weekly start meeting an open nightly:
  the nightly closes `superseded` and the weekly opens, since its 90 days contain the nightly's
  rest. A slice in flight holds a 240 s lease: a second caller gets `busy`, and a slice that lost
  its lease can no longer move the cursor.
- **Failures.** A slice that throws marks its row `failed` and pauses the sweep 5 minutes
  (`paused`); the next tick retries from the cursor. A killed slice is retried once its lease runs
  out (its row still reads `running`, then hung after 15 min in `integrations_health()`).
- **Every sweep ends.** Open 20 h → `expired`; 8 claims in a row that moved nothing → `failed`.
  Both write a FAILED run row (kind = the sweep's) whose error names the reason, the days written,
  the cursor and the last error, so `integrations_health()` shows the job failing with the why.
  A walked window closes `done` (`complete`).
- **High-water mark.** A completed sweep moves `last_synced_at` to its `window_to` only if that is
  later (forward only) — rolling has usually long passed it, and setting it back would only make
  the next rolling run re-read the gap.
- **Unchanged:** the nightly/weekly schedules, rolling, the status kind, `import_scope`, the B′
  map and every money guard. A DRY nightly/weekly is still the one-shot preview; backfill and
  manual are still one-shot.

Check the last two days' sweeps (read-only):

```sql
SELECT s.kind, s.status, s.close_reason, s.opened_at, s.closed_at, s.claims,
       s.cursor_at > s.window_to AS walked,
       count(r.id) AS slices, count(r.id) FILTER (WHERE r.status = 'ok') AS slices_ok,
       sum(r.fetched) AS fetched, sum(r.orders_created) AS created, sum(r.orders_updated) AS updated
  FROM altercpa_sweeps s LEFT JOIN altercpa_sync_runs r ON r.sweep_id = s.id
 WHERE s.opened_at > now() - interval '2 days'
 GROUP BY s.id ORDER BY s.opened_at DESC;
```

## Backfill

```bash
node scripts/segment-trigger-mk.mjs --disable    # 81k redundant recomputes otherwise
# /altercpa → Accounts → (or) POST api/altercpa/sync {"kind":"backfill","from":"2026-08-05"}
node scripts/segment-trigger-mk.mjs --recompute
```

A backfill deliberately does **not** advance `last_synced_at`: it looks at the past, and moving
the cursor would skip everything between the backfill's end and now.

## Verifying

```bash
node scripts/verify-altercpa-bridge.mjs --days 7   # import containment over a window
node scripts/verify-altercpa-status.mjs            # outcome agreement + reason/timestamp invariants
```

Re-fetches the window independently and compares three id sets: the API, the ledger, and
`orders`. It also asserts **containment** — that no `geo_not_callable` lead has an order. The run
log records what the sync *believed* it saw; only an independent re-fetch shows what it missed.

---

## Promoting a geo to callable

Adding a country to `callable_geos` is **not sufficient**. These are the real blockers:

| Blocker | Where |
|---|---|
| `normalizePhoneForGeo` only knows MK; every other geo returns `null` (by design) | `supabase/functions/altercpa-sync/altercpa.ts` — add a `DIAL` entry, deliberately, per country |
| `normalizeMkPhone` rewrites any number to `+389` | `supabase/functions/api/index.ts` |
| Last-8 dedupe is country-blind → cross-border false duplicates | ~40 inline sites in `api/index.ts`; must become last-8-**within-geo** |
| Every price renders `ден`; `codFor` returns the literal type `'MKD'` | `src/lib/currency.ts` |
| One global `products.price`, no currency | needs `product_prices(product_id, geo, currency, price)` |
| A courier for that country | separate track — MK is moving to **MEx Poshta** |
| No agent→market scoping anywhere | `profiles` has no geo; the assigner load-balances a flat pool |
| A 5th locale = 2.833 strings + a migration + a flag SVG | `src/i18n/index.ts` |

The ledger records `geo`, `currency_raw` and `price_raw` from day one, so when a geo is promoted
the history is already there and nothing needs re-fetching.

## Adding a currency

`FX_TO_EUR` in `supabase/functions/altercpa-sync/altercpa.ts`. A currency that is absent yields
`price_eur = NULL` and `skip_reason = 'no_fx_rate'` — the lead is mirrored **without** a EUR
figure rather than with a guessed one. Once a fabricated number is in a report there is nothing
to distinguish it from a real one.

`MKD_PER_EUR` is **frozen at 61.5** and must never be "updated" — see `src/lib/currency.ts`.
