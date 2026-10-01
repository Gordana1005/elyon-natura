---
name: elyon-stock-v2
description: THE LAW for stock in the Macedonian Elyon CRM since 01.10.2026 — Stock v2 (migrations 20260945000100–0900, contract docs/STOCK-V2.md, JSON src/lib/stockV2Types.ts). Exact stock per Sigma ARTICLE × warehouse × moment in ONE append-only ledger (stock_moves): the opening = the 22.09 morning count, every MEX parcel created since deducted at its MEX label, MEX 7 returns back on the shelf, gifts deducted, test phones excluded; the parcel resolver's priority (override → collabBox goods lines → web order → CRM orders through APPROVED recipes); Sigma documents for everything that is not a parcel (never the MEX invoices 000217, АД Астра 000549, the 04↔08 transfers or documents before the opening); a count is a rule (back-datable); the preview mode and the owner-only switch-on procedure; the mapping (articles, kits, recipes, aliases, exemptions); Sigma ingest (CSV now, the office connector later) and why Sigma balances are never the truth for what leaves; the scripts and the checker. Read before touching stock_*, product_articles, stock_moves, /warehouse Залихи · Пратки · Движења · Попис, products.stock_quantity, the Sigma ingest or anything that moves or reports stock.
---

# Stock v2 — exact stock per article, warehouse and moment (MACEDONIA)

> Owner, 01.10.2026: *know exactly how much stock there is on any day, starting from the physical count of 22.09 —
> every parcel since that count applied: delivered, returned, still with the courier.*

- Contract (tables, functions, routes, the engine and integration notes): **`docs/STOCK-V2.md`** — change it first,
  then the code. JSON shapes: `src/lib/stockV2Types.ts`. Plan: `~/.claude/plans/revert-the-421-unproven-encapsulated-brook.md`.
- Migrations (all applied 01–02.10): `20260945000100` schema · `0200` resolver · `0300` desired / apply / reset ·
  `0400` audited writers · `0500` reports · `0510` counts reader + product overview · `0600` Sigma costs · `0650`
  Sigma ingest · `0700` retire v1 · `0800` profit on Sigma costs · `0900` `mex_parcels.picked_up_at`.
- Code: api `supabase/functions/api/stockV2.ts` (+ `stockV2.test.ts`, `stockLedger.ts`); UI
  `src/components/warehouse/v2/*` (`StockDayTab`, `ParcelsDayTab`, `MovementsV2Tab`, `CountV2Tab`, `ArticleDrawer`,
  `StockV2HealthCard`), client `src/lib/stockV2Api.ts`; /products recipe drawer `src/components/products/RecipeDrawer.tsx`.
- The v1 regime (a product-level count + `stock_mex_apply`, migration `20260942000100`) and the older status-driven
  deduction are **RETIRED** (`…0700`) — `elyon-stock-and-bigarena` is history now.

## State on 02.10.2026 (read-only check, ~01:45 Skopje)

| What | Value |
|---|---|
| `app_settings.stock_v2.enabled` | **false — PREVIEW** (nothing written; every report reads `stock_v2_desired()`) |
| Ledger `stock_moves` / counts `stock_wh_counts` | 0 / 0 — no opening yet |
| Articles `stock_articles` | 1.507 (1.506 Sigma + 1 local `L00001`) |
| Kits `stock_article_kits` | 122 kit codes |
| Recipes `product_articles` | 316 products: **154 approved** (confidence high) · **162 proposed** for the owner (135 medium, 27 low) |
| Aliases `stock_article_aliases` | 155 rows: 78 approved (66 web products, 9 collabBox not-stock codes, 3 collabBox names) · 77 proposed |
| Costs | 1.362 articles costed (`stock_article_costs`), 153 products complete in `product_cost_history`; `profit.cost_source = 'sigma'` |
| Sigma staging | 1 CSV batch, 82 documents staged; `sigma.ingest = false`; connector not installed |
| Crons | `stock-v2-apply` `12,27,42,57 * * * *`, `stock-v2-mirror` `14,29,44,59 * * * *` — both return at once while off |
| Preview workbook | `exports/stock/preview/stock-preview-<from>_<to>[-<variant>].xlsx` (gitignored, never committed) |

## 1. The model

- **One ledger, `stock_moves`, append-only.** A signed quantity of one ARTICLE in one warehouse at `event_at` (when it
  happened); `recorded_at` says when we learnt it (`late_days` in Движења). A trigger refuses UPDATE / DELETE and any
  INSERT outside the transaction-local gate `elyon.stock_write = 'on'`. A changed fact is a `correction` row, never an
  edit; a reset (`stock_v2_reset`) is a set of negating rows. Kinds: `opening`, `count_adjust`, `parcel_out`,
  `return_in`, `unpack_in`, `transfer_out/_in`, `receipt`, `production_in/_use`, `b2b_out`, `b2b_return_in`,
  `export_out`, `shop_out`, `shop_return_in`, `writeoff`, `damaged_in`, `adjust`.
- **Desired → apply.** `stock_v2_desired()` = what the ledger SHOULD hold, computed from the facts (parcels, Sigma,
  counts, manual moves, overrides); `stock_v2_apply(trigger, dry)` writes only the differences (advisory lock, one
  run at a time, logged in `stock_runs`). Preview = the reports read `desired()` instead of the ledger.
- **Article** = a Sigma item code (`^[0-9]{6}$`) or a local `L00001…` (a collabBox code Sigma uses for something
  else). КОМ articles are whole numbers (`kom_fraction` refusal).
- **Warehouses** (`stock_warehouses` + `stock_warehouse_keys`): `main` "Главен магацин Скопје" (Sigma `Ф00001-04`,
  collabBox `002`; tracked, shipping) · `wh08` "Сигма 08 Кол Центар (преглед)" (review, NOT tracked) · `damaged`
  (collabBox `014`) · `writeoff` (`Ф00001-11`) · `lab` (`Ф00002-00`, not tracked). One parcel route: priority 100 →
  `main`, valid from 22.09 00:00 Skopje.
- **Balance at t** = Σ moves before t + a count at exactly t. Days are Skopje days (`AT TIME ZONE 'Europe/Skopje'`).
- **The pipeline:** `to_pack` = units in parcels already deducted that MEX has not picked up (MEX 8, `picked_up_at`);
  `with_courier` = picked up, not delivered / returned. Both are already OUT of `closing`, so
  **`available = closing − reserved`** (never `− to_pack` again). `reserved` = confirmed CRM orders and collabBox
  bookings with no parcel yet (an estimate; unmapped lines counted, never guessed).
- **Pickup time** `mex_parcels.picked_up_at` + `picked_up_basis` (`…0900`): write-once, set by `mex_upsert_parcels`
  the first time the register sees a parcel off 8 (MEX keeps no status history). NULL with a status ≠ 8 = unknown →
  shown as "на пат".
- **Money** (cost, value, COD, count value difference) is for owners only (`is_business_owner()`); the api strips
  every money key for everyone else.

## 2. The opening and every later count — a count is a RULE

- **The opening = the 22.09 MORNING count, before dispatch** (`counted_at 2026-09-22T00:00:00+02:00`). The owner
  thinks it was **Sigma 04**; there is **no count document in Sigma** — his original count sheet is awaited.
  Sigma variants (`exports/stock/openings.json`, built by `docs/stock/build_sigma_stock.py`): `04_morning_2209`
  (documents dated ≤ 21.09) · `04_end_2209` · `04_plus_08_morning_2209` · `08_end_2209`. The owner's workbook
  `exports/stock/Magacin-pregled-<date>.xlsx` has the empty column "ПОПИС 22.09 (внесете)" on "Почетна состојба".
- **A count says: at `counted_at` the balance of each counted article IS the counted figure.** Adjustment = counted −
  (previous count + every non-count move since it). So a count can be **back-dated** (owners) and later moves keep
  applying on top; a re-dated or late fact before it is absorbed by the count, after it is not.
- Only the listed articles are adjusted — a `full` count warns `not_counted:N` and **never zeroes the rest**.
- `packed_counted = true` takes the units still at MEX 8 at `counted_at` off the counted figure (they were on the
  shelf, already deducted at their label). Whether parcel packing happens inside 04 is an OPEN owner question.
- One approved `opening` per warehouse, the earliest approved count. Owners' counts are approved at once; a
  non-owner's (admin / warehouse) is `pending`, must be dated after the last approved count, and waits for an owner.
- Codes, translated `stock2.count.warn.<code>`: warnings `parcels_near_count:N` (± 2 h), `no_opening`, `old_count`
  (> 30 days), `pending_owner_approval`, `not_counted:N`; refusals `before_last_count`, `opening_exists`,
  `opening_not_first`, `unknown_article:<codes>`, `kom_fraction:<codes>`.

## 3. What leaves and comes back — the MEX parcels

- **Every MEX parcel of BOTH accounts created from 22.09 00:00 Skopje is deducted at its MEX label**
  (`parcel_out` at `created_at_mex`), whatever its status — the label is when the goods leave the shelf.
- **A MEX 7 return goes back on the shelf** (`return_in` at `returned_at`, only while `status_id = 7`) — **also for a
  parcel created BEFORE the count** (the count only saw the shelf). It goes to the route's return warehouse (`main`);
  a damaged return is an override (`damaged_return` → `damaged`). Whether returns really go back on the shelf is an
  OPEN owner question.
- **Gifts are deducted** (`stock_v2.free_units = 'deduct'`): 0-value collabBox goods lines, web GIFT / 0-price lines,
  0-price CRM items — 11–19 % of units, real goods.
- **Test phones move nothing** (`report_excluded_phone8s()` — on the parcel, the claiming web order or any holder).
- One verdict per parcel (`stock_parcel_state`): `moved` · `partial` · `unmapped` · `no_lines` · `waiting_lines`
  (no lines < 2 days) · `no_route` · `test_phone` · `excluded` · `pre_opening`; flags `provisional`, `stale_label`
  (> 14 days at 8), `possible_relabel` (3 days), `override_<action>`.

### The resolver — what a parcel holds (`stock_v2_parcel_lines`), ONE source per parcel, first wins

| # | Source | Notes |
|---|---|---|
| 0 | test phone → nothing; override `exclude` → excluded | |
| 1 | an active override `lines` (`stock_parcel_overrides`) | owners, note ≥ 3 chars |
| 2 | **the collabBox document** `doc_number = tracking_id` — not storno, lines complete, ≥ 1 goods line qty > 0 | `payload->'lines'`, `code` = the Sigma item code, kits already split; covers 99,4–99,9 % of units. A vanished document still counts, flagged `provisional` |
| 3 | the live web order that claims the parcel | aliases `web_sku` → `web_product` → `name_any` → the CRM product's recipe |
| 4 | the union of the real orders holding the parcel | through their **APPROVED recipes** valid at `created_at_mex` |
| 5 | otherwise `no_lines` | |

- A collabBox line → article: approved alias `collabbox_code` → `stock_articles.code = code` → alias `collabbox_name`
  → alias `name_any` → the line's `product_id` → recipe. A kit article (`is_set` + kit rows) expands ONE level, for
  parcel lines only (never for Sigma documents).
- Not stock: delivery / marker / note lines, ПОЕН / ЗАБЕЛЕШКА / ФЛАЕР / ДОСТАВА, an alias of kind `not_stock`, a
  product in `product_stock_exempt`, qty ≤ 0. To review (unmapped): qty ≥ 100 (`bad_quantity`), `unknown_code`,
  `no_product`, `no_recipe`.
- **Only APPROVED recipes and APPROVED aliases move stock or cost.** A proposal is information.

## 4. Sigma — everything that is not a parcel

- **Sigma feeds:** plant receipts and transfers into 04, purchases, sales to the shops (client `000001`), exports, Labs,
  B2B, write-offs. New goods are entered in Sigma, never typed into the CRM (`POST /restock` answers 410).
- **Always excluded** (`stock_sigma_rules`, server-side): the MEX invoices (client **`000217`**), **АД Астра
  (`000549`)**, every transfer between **`Ф00001-04` and `Ф00001-08`** (08 is under review); plus documents dated before
  the opening (`sigma_moves_from`), types not included (`stock_sigma_doc_types.include` — only the posted stock layer),
  vanished documents and drafts ("најавено", `stock_sigma_drafts` — never move stock).
- Staging keeps everything with its reason: `stock_sigma_docs` (`doc_key = WYear|DocType|DocNo`, `content_hash`,
  `versions` — a re-dated / edited document gets a new version, shown "менуван N пати"), `vanished_at` instead of a
  delete, a batch id seen twice is a no-op. Event time = the document date at 12:00 Skopje. A line `{item_code, qty,
  side}`: `out` = the From object (−qty), `in` = the To object (+qty), Sigma's own sign kept (sign rule proven on
  9.125 of 9.126 StockObject keys). An item code with no `stock_articles` row is skipped and counted in health.
- **There is no live link yet (02.10).** Today's data is a CSV dump (`D:\naturatherapy\_salesforce-plan\05-sigma-export\raw-export\`,
  17–30.09) → `docs/stock/build_sigma_stock.py` → `exports/stock/sigma-batch-since-2209.json` → `scripts/stock/sigma-ingest-file.mjs`.
  A CSV batch is staged even while `stock_v2.sigma.ingest` is off (staging moves no stock).
- **The office connector `tools/sigma-connector`** (install guide in Macedonian: `README-INSTALL.md`) is BUILT, NOT
  INSTALLED: an always-on office PC with Node 20, a SELECT-only SQL login `elyon_reader` on `SSBNatura` (Sigma-СБ creates
  it — `node connector.mjs --print-grants`), the secret `SIGMA_CONNECTOR_SECRET` (NOT set yet, on both sides). It
  posts the same `SigmaBatch` to **`POST /api/stock/sigma/ingest`** — HMAC only, no login: `x-elyon-ts` +
  `x-elyon-signature = hex(HMAC_SHA256(secret, ts + "." + rawBody))`, ± 300 s. Field whitelist:
  `tools/sigma-connector/sigma-fields.json` (no addresses, contacts or person names). A connector batch answers
  `disabled` while `sigma.ingest` is off.
- **Why Sigma is NEVER the stock truth for what leaves:** Sigma books MEX COD as ONE monthly invoice to `000217`,
  2–7 weeks late; for NATURA it is a hand-typed lump (+17 % against delivered for April–August, per-article errors in
  the thousands); it never books gifts (11–19 % of units) or returns (4–4,8 k units a month); September 2026 is not
  invoiced at all. Proof, read-only: `node scripts/stock/sigma-month-check.mjs [--month 2026-08]`.

## 5. Purchase costs (owners only) — see `elyon-logistics-costs`

Sigma `CalcBuyPrice` (Ф00001-04, MKD ex VAT) for everything, the whole history (`stock_article_costs`, append-only,
first load from `-infinity`); a product's cost = Σ qty × `article_cost_at()` over its APPROVED recipe
(`product_cost_history`, rebuilt by `product_costs_rebuild()` after every recipe approval); `products.cost_price` (EUR)
is a guarded mirror = cost_mkd / 61,5; the 69 old values sit in `products_cost_legacy`. Costs are DENARI — the
deliberate exception to "store EUR" (CLAUDE.md per-market rules). BioNatural at Ф00001 production cost, never the
АД Астра price.

## 6. The mapping — how it was loaded (02.10) and how it changes

- Built by `docs/stock/build_sigma_stock.py` (+ `crm_snapshot.mjs`, `mapping_review_xlsx.py` → the owner's workbook),
  loaded by `node scripts/stock/mapping-apply.mjs` (dry by default → `--apply --actor <owner uuid>`; only confidence
  `high` recipes / aliases are approved; `--kits unstocked`: a Sigma set that HAS stock in the opening keeps no
  components — a set on the shelf leaves as the set).
- Later changes go through the audited writers only (owners via the api): `product_articles_set` / `_approve`
  (`POST products/articles[/approve]` — the api then runs `product_costs_rebuild` and the mirror),
  `stock_article_alias_set`, `product_stock_exempt_set`, `stock_article_kits_upsert`, `stock_articles_upsert`,
  `stock_v2_config_set` (warehouses, keys, routes, Sigma rules), `stock_v2_parcel_override`, `stock_v2_manual_move`
  (+ `_void`), `stock_v2_count_save` / `_approve` / `_void`, `stock_article_cost_set`. Every writer takes `p_actor`,
  answers `{ok:false, error}` instead of raising, and writes one `audit_log` row.

## 7. Switch-on procedure (owner only — never without him)

1. **The owner answers:** the count sheet itself; which warehouse was counted (04? 04 + 08?); is parcel packing inside
   04 (→ `packed_counted`); what Sigma 08 is; do MEX returns go back on the shelf.
2. **Recipes:** the owner reviews the 162 proposed (/products → Рецепт chip "Предлог" → the drawer, or the workbook);
   each approval rebuilds the cost history.
3. **Opening:** `node scripts/stock/opening-apply.mjs --xlsx <sheet>` (or `--variant <key>` if he picks a Sigma
   variant) — DRY: read unknown articles, КОМ fractions, negatives left out → `--apply --actor <owner uuid>` (an owner's
   opening is approved at once; a second one is refused).
4. **Sigma:** stage the newest batch (`sigma-ingest-file.mjs --direct` dry → `--apply`, or `--send`).
5. **Preview:** `node scripts/stock/backfill-preview.mjs` (workbook into `exports/stock/preview`) +
   `node scripts/verify-stock-v2.mjs --preview` → the owner reads negatives, unmapped parcels, the day sheets.
6. **The switch:** Магацин → Попис → the Stock v2 health card → "вклучи" (owners, with a confirm) = `POST
   /api/stock/v2/switch {enabled:true}` → `stock_v2_set` (refuses while a routed warehouse has no approved opening) →
   the api runs `stock_v2_apply('switch_on')` (every parcel since 22.09) and `products_stock_mirror_refresh()`.
7. **After:** `node scripts/verify-stock-v2.mjs` (full) and the health card's queues. Expect a burst of low-stock
   bells on the mirror's first refresh (`trg_notify_low_stock`) — products whose real stock is under the threshold.
8. **Undo:** `node scripts/stock/stock-reset.mjs` (dry) → `--apply --actor <email|uuid> --reason "…"` = switch off +
   negate every group (the ledger keeps its history).

## 8. Scripts and the checker (Macedonia-pinned; dry by default; the lead runs `--apply`)

| Script | Does |
|---|---|
| `scripts/verify-stock-v2.mjs [--preview] [--day=] [--json]` | READ-ONLY S1–S17: installed, locked down, seeds, the switch, ledger integrity, one first write per group, pending = 0 after a run, parcel coverage and moves = verdicts, test phones, collabBox first, the count rule, the Sigma exclusions, day-sheet / on-hand / parcel-day ties, no PII / no money leak |
| `scripts/stock/backfill-preview.mjs` | the computed preview per day and article → json + xlsx in `exports/stock/preview` (`--opening --variant` adds a Sigma opening; `--unapplied` dry-runs uninstalled migrations, rolled back) |
| `scripts/stock/stock-run.mjs` | one `stock_v2_apply` (dry; `--apply` needs the switch on) |
| `scripts/stock/stock-reset.mjs` | `stock_v2_reset` (dry; `--apply --actor --reason`) |
| `scripts/stock/mapping-apply.mjs` | articles → local articles → kits → recipes → aliases → exemptions, one transaction |
| `scripts/stock/opening-apply.mjs` | the 22.09 opening from a Sigma variant or the owner's xlsx |
| `scripts/stock/costs-apply.mjs` | the Sigma costs + `product_costs_rebuild` |
| `scripts/stock/sigma-ingest-file.mjs` | one `SigmaBatch` → staging (`--direct [--apply]` or HMAC `--send`) |
| `scripts/stock/sigma-month-check.mjs` | READ-ONLY: Sigma's 000217 invoice vs the parcels per month and article |

Shared helpers: `scripts/stock/sigma-common.mjs` (one transaction per call, `lock_timeout 2 s`, `statement_timeout 45 s`).

## Never

- **Never use Sigma balances (04 / 08 `StockObject`) as the stock truth for what leaves in COD parcels** — the 000217
  invoice is late, hand-typed and has no gifts or returns. Parcels + collabBox goods lines are the truth.
- **Never deduct the MEX invoices (000217) or АД Астра (000549) on top of the parcels** — the goods would leave twice.
  Never count a 04↔08 transfer while 08 is under review.
- **Never re-enable the status-driven deduction or v1** (`stockByStatus()`, `stock_mex_apply`, the `stock-mex-apply`
  cron, `restock` / `stock/count` / `stock/mex-movements`, the BigArena stock sync) — a parcel would be deducted twice.
- Never write `products.stock_quantity` or `products.cost_price` directly — both are guarded mirrors.
- Never UPDATE / DELETE `stock_moves` or `stock_article_costs`; never open `elyon.stock_write` outside a writer.
- Never let a proposed recipe or alias move stock or cost; never guess an unmapped line.
- Never switch `stock_v2.enabled` on, approve the opening or approve recipes in bulk without the owner.
- Never show a cost, value or COD to a non-owner, and never commit `exports/stock/**` or `exports/magacin/**`
  (business-confidential); the warehouse-08 report is INTERNAL — never published, never quoted in the repo.
- Never derive a stock day in UTC (Skopje days only).

## Companion skills

`elyon-warehouse-incoming` (the /warehouse tabs) · `elyon-logistics-costs` (costs in the profit) ·
`elyon-products-catalogue` (recipes, "Набавна (Сигма)") · `elyon-collabbox-sync` (the goods lines) ·
`elyon-shops` (the shops' own stock in collabBox) · `elyon-security` (owner-only keys, the guard pattern) ·
`elyon-stock-and-bigarena` (v1 and BigArena — history).
