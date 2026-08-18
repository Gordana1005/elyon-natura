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
   current state goes to `comp/edit.json` as a **POST** (data fields in the query string are
   silently dropped — found live 2026-08-18). The write signs with the dedicated push token
   (`push_token_secret_name`, Dragana) so their panel attributes it to her; the confirming agent
   rides in the comment (`Agent: <name>`). Gated by `app_settings.altercpa_push_enabled`
   (default off). Full contract in `.grok/skills/elyon-altercpa-bridge` decision #3.
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
| Report rollups | `supabase/migrations/20260914000300_altercpa_summary.sql` |
| Admin routes | `supabase/functions/api/index.ts` → `altercpa/*` |
| Admin UI | `src/pages/AlterCpaPage.tsx`, `src/components/altercpa/` |
| Manual CPA push (2026-08-14) | `supabase/functions/api/index.ts` → `POST orders/:id/altercpa-push`; button + dialog in `src/pages/Orders.tsx`; toggle in Settings → System |
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
- **`altercpa_sync_runs`** — what each run fetched, created and skipped.

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
deliberately not `PHASE_TO_STATUS`, whose `3 → paid` was correct only for the settled history
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
| `altercpa-sync-nightly` | `15 1 * * *` | last 7 days |
| `altercpa-sync-weekly` | `45 2 * * 0` | last 90 days |
| `altercpa-sync-status` | `*/5 * * * *` | not a window — our open orders, by `oid` |
| `mex-reconcile` | `7,37 * * * *` | MEX terminal shipments by `updated_from` (see below) |

**`mex-reconcile`** (`20260918000100`, edge fn `supabase/functions/mex-reconcile`) is the courier
ground-truth corrector: twice an hour (07:00–20:55 Skopje gate) it pulls MEX shipments whose
status became Delivered/Returned since the cursor, matches them to orders (remembered
`orders.mex_tracking_id` link first, else phone→E.164 + COD ×61.5 ±150 ±3 + nearest date, never
guessing on ambiguity), and applies **Delivered → paid / Returned → returned** — overriding even
terminal statuses (operator decision 2026-08-11; `duplicated` excluded), because the courier's
record of collected COD outranks anything AlterCPA says. Run log: `mex_sync_runs` (admin/manager).
Port of `scripts/reconcile-mex-shipments.mjs` — keep the two matchers in step. The CSV-export
path remains only for ADDRESS backfill (the API withholds `receiver_address`).

`altercpa-sync-status` (added 2026-08-11, `20260918000000`) fires around the clock but
`invoke_altercpa_status_sync()` gates on `hour(Europe/Skopje) BETWEEN 7 AND 20` — i.e. it works
07:00–20:55 local, DST-proof, and pre-gates on any active account having
`status_mirror <> 'off'`. Each run takes the ledger rows linked to still-open orders
(`pending/take/call_again/confirmed/shipped/delivered`, oldest first, `limit` 500 default) and
re-reads exactly those ids with `comp/list.json?oid=…` in batches of 100.

**The window is CREATION time** — measured 2026-08-06 with `scripts/probe-altercpa-window.mjs`:
re-fetching a month captured in August returns exactly the same id set. So the rolling poll sees
**new leads only** and can never observe a later phase change. Outcome-chasing is the `status`
kind's job; the sweeps exist to fill gaps when the function was down.

The same probe measured creation→settlement: **p50 0.5d, p90 44d, p99 59d, max 129d** — relevant
only if `import_scope` is ever set to `all`, where the weekly window must exceed the p99.

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
