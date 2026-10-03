# Importing & exporting — the scripts toolbox (Macedonia)

> Rewritten 29.09.2026. Everything in [../scripts/](../scripts/) is a Node 22 ESM CLI, run from the
> repo root as `node scripts/<name>.mjs`. The Macedonian write scripts share one safety kit
> (`scripts/lib/repair-kit.mjs`) and one protocol (§0). The scripts inherited from Bulgaria are
> listed at the end — **do not run them on Macedonia without reading them first.**
>
> 🛑 The access token in `.env` can write to Bulgaria too. Run `node scripts/assert-mk-target.mjs`
> before any write; never pass a `--project-ref` copied out of an old doc.

---

## 0. The protocol every Macedonian write script follows

- **Guards.** `mkGuard()` pins the ref `oufoazmnbwugtfldkwsn`, refuses a `supabase/config.toml` or
  `.env` that mentions the Bulgarian project, and loads `SUPABASE_ACCESS_TOKEN` without printing it;
  `assertRemoteIsMk()` refuses a remote whose orders look Bulgarian (+359). Reads go through the
  Management API with `read_only: true` (`sqlRead`).
- **Dry run first — it writes nothing** (or only a `data_repair_runs` row with `dry_run = true`):
  it classifies, writes CSVs / an owner `.xlsx` to `exports/…` (gitignored — they hold customer
  data) and prints a **run id** with a `candidate_hash` of what it plans.
- **`--apply --run <id>`** re-classifies and **refuses unless the hash is the dry run's** (the set
  moved → dry-run again). Writes go in ≤ 200-order transactions, keep only rows still exactly as
  reviewed, record `data_repair_rows` (before / after / evidence per order), an order note where the
  owner sees it, and one `audit_log` row (`--actor mile@elyon.com`).
- **Rollback.** `node scripts/rollback-repair.mjs --run <id> [--apply]` restores an order only
  while it still equals `after` (`--only ORD-…`, `--loose` to ignore MEX facts the cron refreshed);
  importers have their own `--rollback --run <id>` (they delete what the run created).
- **Transaction-local switches** (never a session SET on a pooled connection):
  `elyon.keep_updated_at` (GET /call-agains reads `orders.updated_at` as the last call — bulk work
  must not move it), `elyon.bulk_repair` (no paid / returned bells), `elyon.allow_source_change`
  (the only door to a `sale_source` move), `elyon.allow_sold_change` (a deliberate seller
  correction), `elyon.defer_segments` (bulk loads queue phones for `segment_recompute_drain()`).
- **When.** An apply refuses while `recompute_all_segments` or `apply_no_parcel_rule` runs and,
  unless `--outside-quiet-window`, outside the kit's quiet window (20:55–07:00 Skopje). That window
  predates the 15-minute MEX / collabBox passes — see
  [OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) §6.

---

## 1. The live feeds (not scripts)

| Feed | What | How often | Read |
|---|---|---|---|
| AlterCPA | `altercpa-sync`: new leads → `altercpa_leads`, MK pendings → `orders`; outcomes by `oid` | rolling 2 min · status 5 min (07:00–20:55) · resumable nightly / weekly sweeps | `docs/ALTERCPA-BRIDGE.md`, skill `elyon-altercpa-bridge` |
| MEX Poshta (BIO NATURAL + NATURA) | `mex-reconcile`: both accounts → `mex_parcels` → links → shipped / paid / returned; a dead order is revived only by its own folder's parcel | every 15 min, 06:00–22:59 Skopje · Sunday 60-day sweep | `docs/ALTERCPA-BRIDGE.md` §Schedule |
| naturatherapy.mk shop | `web-sync`: read-only mirror → `web_orders` (NOT orders) | every 15 min · nightly sweep | skill `elyon-web-shop-bridge` |
| collabBox | `collabbox-sync`: documents → `collabbox_documents`; orders once the MEX parcel exists | every 15 min 07:00–22:59 (yesterday + today) · nightly 00:00 (last 3 days) | skill `elyon-collabbox-sync` |

Owner rule 29.09: every source refreshed at least every 15 minutes; MEX (both accounts) is the final
proof of shipped / paid / returned.

---

## 2. History imports — done once, with ledgers and rollback

### AlterCPA history (05.08.2026)

`export-altercpa-mk.mjs` (read-only export) → `analyze-altercpa-mk.mjs` → `build-product-map.mjs` →
`import-altercpa-mk.mjs` → `verify-altercpa-import.mjs`: 80.360 orders, 2025-04 → 2026-08.
Idempotent on `external_source = 'altercpa'` + `external_order_id` (the live bridge continues on the
same key). Around a bulk load: `node scripts/segment-trigger-mk.mjs --disable` … `--enable` →
`--recompute` (and `--backfill-timestamps`, so imported rows keep their real paid / cancelled /
trashed dates — `trashed_at` especially drives the 21-day trash timer).

### The collabBox teleshop history (28.09.2026) — `import-teleshop-collabbox.mjs`

```
node scripts/import-teleshop-collabbox.mjs                         # dry run: report, CSVs, owner .xlsx
node scripts/import-teleshop-collabbox.mjs --record                # + a data_repair_runs row (run id + hash)
node scripts/import-teleshop-collabbox.mjs --apply --run <id> [--chunk 500] [--outside-quiet-window]
node scripts/import-teleshop-collabbox.mjs --drain                 # settle the deferred segment queue
node scripts/import-teleshop-collabbox.mjs --rollback --run <id> [--apply]
```

- Source: the local collabBox header crawl (types 10036 / 10050), the komitent registry, line-item
  summaries and fresh fetches (`--fetch`, `--items`); the owner's decisions are flags (all ON for the
  real run: `--banned-as-trash`, `--trash-banned-existing`, `--relabel-source`).
- Run `8bb49e8e` (17:10–19:40 Skopje): **247.001 orders** (01.2023 → 27.09.2026) — 214.700 paid –
  history (`paid_basis 'legacy_import'`: no parcel, before MEX coverage), 28.577 paid with MEX proof,
  3.311 returned, 413 in transit; 56.699 new customers; 598 do-not-contact / deceased Trash markers;
  1.432 conflicts and 7.777 skips recorded, never forced.
- Ledgers (migration 20260942000300): `teleshop_import_documents` (one row per document seen:
  created / exists / enriched / conflict / skipped + reason; 258.705 rows) and
  `teleshop_import_customers` (one per komitent; 71.669). `created_by_run` is what `--rollback`
  deletes by.
- It loads under `elyon.defer_segments`; `--drain` settled 70.036 phones (memberships
  54.145 → 112.148). The DB disk had to go from 2 GB to 8 GB mid-apply (owner's OK); the apply
  resumed from the ledger with the hash check.
- `build-teleshop-customers.mjs` builds the clean customer file it reads.

### collabBox LEADS-OUT, sellers, types, departments (28.09)

| Script | Run | What |
|---|---|---|
| `import-leads-out-collabbox.mjs --fetch <collabbox_….json>` | `954707fd` | 64 LEADS-OUT (10114) sales booked only in collabBox, created once their parcel existed; `--apply --run`, `--rollback --run` |
| `backfill-sellers-collabbox.mjs` | `5b29ca75` | 506 sales credited to their collabBox author (document whose DocNumber is the order's parcel, CRM decisions, push comments, one-candidate phone rule); `--rollback --run` |
| `backfill-order-deciders.mjs` | — | the backfill twin of the `stamp-order-deciders` cron (`verify-stamp-parity.mjs` must show 0 diffs) |
| `backfill-collabbox-doc-types.mjs` | 28.09 night | `orders.collabbox_doc_type` for 255.243 orders (dry run default; `--apply [--chunk 2000]`; undo = set the column NULL) |
| `reclass-department-sources.mjs` · `reclass-by-folder.mjs` | 28.09 night | every collabBox order to its department, by series then by TYPE; logged in `sale_source_reclass`; `--rollback` — see skill `elyon-departments-and-sources` |

### collabBox history through the sync (29.09)

The live `collabbox-sync` function is also the backfill tool: manual windows of at most 4 days
(`{"mode":"manual","from":…,"to":…}`), in the night gap, one at a time (a second run gets 409).
On 29.09 it read **01.03 → 26.09.2026** (finished 08:03, 0 errors) into its ledger
`collabbox_documents`: mostly `exists` / `recorded` / `credit_pending` (the teleshop import already
held the orders); what it created is chiefly social (10106) and LEADS-OUT (10114) — only once each
MEX parcel existed. At 08:46 it re-applied the 125 documents whose parcels the cross-channel repair
(`a057bc52`) took off dead AlterCPA leads (run `4cdb427f`). How to run a window:
[OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) §9; the writer's rules: skill `elyon-collabbox-sync`.
Social history before March 2026 (no MEX data) is not imported.

### collabBox raw fetch — `collabbox-fetch.mjs`

Read-only headless client (credentials read at runtime from `docs/VAULT.md` §7, never printed):

```
node scripts/collabbox-fetch.mjs --from 25.09.2026 --to 27.09.2026 [--types orders|sales|10036,10050] [--items xls|html|none]
```

`--chunk-days` (1), `--pause-ms` (2500), `--max-requests` (250), `--out exports/collabbox`
(gitignored). The header of the file is the protocol (PROTOCOL §0–§4: login, header search with
COMMA-WRAPPED type lists, the line-items form, the list of things never to touch). The Edge Function
`collabbox-sync` is its Deno port.

### Superseded — do not re-run

`match-collabbox.mjs` (its `--apply` once put 2.512 orders live as paid), `import-collabbox-teleshop.mjs`
(the 02–17.09 import, 2.644 orders), `create-missing-orders-from-collabbox.mjs` (5.563 register orders,
12.08). `reconcile-collabbox-mex.mjs` and `audit-collabbox-paid.mjs` only report;
`fix-order-values-from-collabbox.mjs`, `map-collabbox-skus.mjs`,
`create-missing-products-from-collabbox.mjs` belong to the August work.

---

## 3. Catalogue, prices and stock

| Script | What |
|---|---|
| `import-catalogue-products.mjs` | Every product that ever sold must exist in the catalogue. Dry run → `exports/products/<date>-analysis.json` + owner `.xlsx` + run file; `--apply --run <id>`; `--rollback --run <id>`; `--explain --run <id>`; `--no-third-party`. Run `01d83713` (28.09): **170 aliases** |
| `complete-catalogue.mjs` | Creates every sold-but-missing product and activates sold-but-inactive ones. `--include-active`, `--explain --run`, `--apply --run`, `--rollback --run`. Run `324615d4` (28.09): **325 new products** (34 active, 291 history), **139 activations / fills** (45 inactive sold products activated, 94 active ones given price / stock), **479 aliases**; 32 spelling groups linked to existing products, 16 unsure groups left for the owner, 42 non-products excluded |
| `set-stock-mk.mjs` | Absolute stock set to a flat quantity (default 1000) + one `inventory_logs` row each; snapshot for rollback |
| `reprice-catalogue-mk.mjs` | Re-price the catalogue in EUR from real denar shelf prices — the ONLY answer to a market move (the 61,5 peg is frozen) |
| `recover-zero-prices-mk.mjs` | 08-06: 461 zero-price paid AlterCPA orders priced where a quantity + a settled peer price existed; 738 stay 0 on purpose |
| `seed-altercpa-offer-map.mjs` | Seeds `altercpa_offer_map` from the curated 08-2026 history map |

Both catalogue scripts write `product_aliases` rows with `reviewed_by` NULL and a note "AUTO … чека
одобрување" — and `product_key()` / `order_line_kind()` do NOT filter on `reviewed_by`, so an applied
alias counts in every report at once (all 1.744 aliases are unreviewed on 29.09). Stock is the
placeholder 1000 until the owner's count. Details:
[PRODUCTS_STOCK_WAREHOUSE.md](PRODUCTS_STOCK_WAREHOUSE.md).

---

## 4. MEX, addresses, web shop

| Script | What |
|---|---|
| `backfill-mex-register.mjs` | Backfill `mex_parcels` from BOTH MEX accounts |
| `fetch-mex-shipments.mjs` | Pull the MEX register to a local cache |
| `reconcile-mex-shipments.mjs` | Reconcile portal CSV exports + API dates against the CRM (the fresh-match rules of mex-reconcile, minus the upsell revive; the portal CSV is the only source of receiver ADDRESSES — the API withholds them) |
| `report-cod-mismatch.mjs` | Read-only: MEX COD ≠ CRM price |
| `fetch-mex-cities.mjs` · `import-mk-settlements.mjs` · `import-mk-streets-osm.mjs` · `map-settlements-to-mex.mjs` · `enrich-mk-postal-codes.mjs` · `backfill-order-mex-city.mjs` | The Macedonian address stack: MEX zones (`mex_cities`), OSM settlements / streets (`mk_settlements` / `mk_streets`, ODbL), zone mapping, post codes |
| `apply-shop-crm-export.mjs` | The ONE approved change on the naturatherapy.mk shop DB (schema `crm_export` + reader role); dry static checks by default; `--apply`, `--verify`, `--set-function-secrets`, `--backfill`, `--sync` |
| `backfill-web-parcel-links.mjs` | One-off: link OpenCart-era NATURA `M…` parcels to their web orders by phone + amount (`--apply --expect N`) |

---

## 5. Repairs

Every data repair is a repair-kit script with a dry run, a hash-checked apply and a rollback — the
full list with applied run ids and what each FAIL means is in
[OPERATIONS_RUNBOOK.md](OPERATIONS_RUNBOOK.md) §7.

---

## 6. People and logins

`create-user-mk.mjs` (the only way besides /users — public signup is off) · `seed-sales-people.mjs`
(people, identities, teams — 20260935000100) · `audit-agent-identity-merge.mjs` (the cross-script
operator fold guard) · `backfill-cpa-attribution.mjs` / `backfill-cpa-stream.mjs` (AlterCPA
webmaster / offer / stream on orders).

---

## 7. Exports

- **MEX Import CSV** — client-side on /orders (`src/lib/mexImportCsv.ts`): MEX's own 8-column portal
  template, Latin, integer денари, no quoted fields. Contract: skill `elyon-fulfilment-csv`.
- **No-parcel rule report** — `GET /api/integrations/no-parcel-rule/report?run_id=` (CSV, English
  headers, `Price MKD`, Skopje times, UTF-8 BOM; owners).
- **Dry-run files** of every script above — `exports/<area>/…` (CSV / XLSX / JSON), gitignored,
  customer data: share with the owner, never commit.

---

## 8. Inherited from Bulgaria — read before running on Macedonia

Written for the Bulgarian catalogue, couriers, lev prices or source files; most make no sense here:

`import-cpa-xlsx.mjs`, `import-outbound-xlsx.mjs`, `rollback-cpa-import.mjs` (the BG workbook
imports, not idempotent) · `import-products-bigarena.mjs`, `reconcile-panel-pdf.mjs`,
`analyze-bigarena-skus.mjs`, `fix-skus-to-nt.mjs`, `fix-product-skus.mjs` (the BG 3PL catalogue) ·
`scrape-courier-offices.mjs`, `backfill-office-postal-codes.mjs`, `fetch-bg-settlements.mjs`,
`enrich-settlements-municipality.mjs` (Speedy / Econt / `bg_settlements` — dead in MK) ·
`gen-natura-prices.mjs`, `gen-natura-price-update.mjs`, `import-natura-costs.mjs`,
`import-natura-retail.mjs` · `check-dashboard-numbers.mjs`, `check-insights-accuracy.mjs`,
`check-segment-counts.mjs`, `check-customer-intelligence.mjs` (the BG-era audits; the MK checkers
are in the runbook) · `create-admin-users.mjs`, `create-agents-2026-05.mjs` (BG bootstrap).
`import-costs-from-bg.mjs` and `import-scripts-from-bg.mjs` READ the Bulgarian project — reading is
allowed, writing to it never. `import-scripts-from-bg.mjs`, `import-call-scripts.mjs` and
`translate-call-scripts.mjs` are **retired** (02.10.2026): call scripts are written only on /call-scripts
through the audited writers (docs/CALL-SCRIPTS.md).

---

## 9. Writing a new script

- Start from `scripts/lib/repair-kit.mjs`: `mkGuard()`, `assertRemoteIsMk()`, `sqlRead` for every
  read, the dry-run → run id → hash → apply → rollback protocol, the transaction-local switches.
- Phones: last-8 matching; a strict Macedonian 8-digit NSN for anything imported
  (`scripts/lib/teleshop-import.mjs MK_NSN_RE`) — never `normalizeMkPhone`, which rewrites any
  number into +389.
- Money: EUR in `orders.price`, денари everywhere else; 61,5 is frozen; COD is already денари.
- Dates: Skopje wall clock, DST-exact; never a fixed `+02:00`.
- A bulk loader sets `elyon.defer_segments` and drains afterwards; anything touching many orders
  keeps `updated_at` and runs `node scripts/engine-fixture-mk.mjs` after.
- An importer must diff apply against dry run — counting every 23505 as "already imported" hid the
  18.09 display-id outage.
