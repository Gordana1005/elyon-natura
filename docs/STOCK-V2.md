# Stock v2: exact stock per article, warehouse and day, plus Sigma purchase costs (contract)

Owner request, 01.10.2026: know exactly how much stock there is on any day, starting from the physical count of 22.09.
Every parcel since that count is applied: delivered, returned, still with the courier.
Purchase prices come from Sigma, and real profit is calculated from them.
The approved plan is `~/.claude/plans/revert-the-421-unproven-encapsulated-brook.md`.

This file is the shared **contract** for the parallel workstreams. Table and column names, function signatures and route JSON live here.
Change this file first, then the code.

## Owner decisions (01.10.2026)
- The 22.09 count was taken in the **morning, before dispatch**. Every parcel created from **2026-09-22 00:00 Europe/Skopje** (`2026-09-22T00:00:00+02:00`) is deducted.
- The owner thinks the counted warehouse is **Sigma Ф00001-04**. There is no count document in Sigma, so the original count sheet has been requested.
  - The opening is loaded from that sheet, or from a Sigma variant the owner picks.
  - Until then everything runs in **preview** mode.
- **New goods are entered in Sigma.** They must show in Магацин → Движења, through the Sigma ingest (a CSV export now, an office connector later).
- **Purchase cost is Sigma CalcBuyPrice for everything, for the whole history.**
  - The 69 old CRM `cost_price` values are archived, not kept.
  - BioNatural items are costed at Ф00001 production cost, not the АД Астра inter-company price.

## Why Sigma is NOT the stock truth for what leaves
Investigation of 01.10 (read only):
- Sigma books MEX COD as one monthly invoice to client `000217`, posted 2–7 weeks late. For NATURA it is a hand-typed lump (+17 % against delivered for April–August, per-article errors in the thousands).
- Gifts are 11–19 % of units, and returns are 4–4.8 k units a month; Sigma never books either.
- September 2026 is not invoiced at all.

What leaves is therefore taken from **MEX parcels** plus the **collabBox document goods lines**: `collabbox_documents.payload->'lines'`, where `code` is the Sigma item code and `doc_number` is the MEX tracking id. That covers 99.4–99.9 % of units, and kits are already split into their components.

Sigma feeds everything that is not a parcel: plant receipts and transfers into 04, purchases, sales to shops, exports, Labs, B2B and write-offs.
- **Always excluded:** the MEX invoices (client `000217`), АД Астра (`000549`), and every 04↔08 transfer, because Sigma 08 is under review.
- **Also excluded:** documents dated before the opening, because they are already in the count.

## Units, money, time
- Quantities are `numeric(14,3)`. КОМ articles must be whole numbers.
- **Cost is in MKD** (`cost_mkd`, excluding VAT). This is a deliberate exception to "store EUR": these are Sigma book values. `products.cost_price` (EUR) becomes a guarded mirror equal to `cost_mkd / 61.5`. Display is always денари through `formatDenari`.
- **Days are Skopje days.** Every boundary uses `AT TIME ZONE 'Europe/Skopje'`, so the switch on 25.10 is safe.
- **Money (cost, value, COD) is for owners only** (`is_business_owner()`). The api strips the money keys for everyone else.

## Tables (migration `20260945000100_stock_v2_schema.sql`, all empty and dark)
Pattern for every table:
- RLS on.
- `REVOKE ALL FROM PUBLIC, anon, authenticated`, then `GRANT ALL TO service_role`.
- Reads go through the api.
- Writes go through SECURITY DEFINER writers that set the transaction-local GUC `elyon.stock_write = 'on'` and write `audit_log(actor_id, actor_email, action, target_type, target_id, target_name, payload)`.

### Warehouses, routes, aliases
| Table | Columns |
|---|---|
| `stock_warehouses` | `id smallint identity PK`; `code text UNIQUE` (`main`, `wh08`, `lab`, `damaged`, `writeoff`); `name`; `role` CHECK (`main`, `shipping`, `lab`, `damaged`, `writeoff`, `plant`, `review`, `other`); `tracked bool default false`; `sellable bool`; `sigma_moves_from timestamptz`; `active bool`; `sort int`; `note` |
| `stock_warehouse_keys` | `system` CHECK (`sigma`, `collabbox`); `key text` (e.g. `Ф00001-04`, `Ф00001-08`, collabBox `002`); `warehouse_id`; PK `(system, key)` |
| `stock_parcel_routes` | `id`; `priority int`; `match_account text NULL` (`natura` / `bio_natural`); `match_series text NULL`; `match_shape text NULL` (`collabbox`, `web`, `crm`, `other`); `warehouse_id`; `return_warehouse_id NULL`; `valid_from timestamptz`; `valid_to timestamptz NULL`; `active bool` |

Seed rows:
- **Warehouses:**
  - `main` "Главен магацин Скопје" (role main + shipping, keys sigma `Ф00001-04` and collabbox `002`).
  - `wh08` "Сигма 08 Кол Центар (преглед)" (role review, `tracked=false`).
  - `damaged` "Оштетена роба" (collabbox `014`).
  - `writeoff` (sigma `Ф00001-11`).
  - `lab` (sigma `Ф00002-00`, `tracked=false`).
- **Route:** one row, priority 100, no match filters → `main`, valid from `2026-09-22 00:00+02`.

### Articles and recipes
| Table | Columns |
|---|---|
| `stock_articles` | `code text PK` CHECK (`^[0-9]{6}$` or `^L[0-9]{5}$`); `name`; `unit` (КОМ, КГ…); `sigma_class` (АРТИКЛ, ТС, ЛОЈАЛИТИ…); `brand`; `is_set bool`; `active bool`; `source` (`sigma`, `local`); `last_seen_export timestamptz`; `created_at`; `updated_at` |
| `stock_article_kits` | `kit_code`; `component_code`; `qty numeric(10,3) > 0`; `source_ref`; `observed_at`; PK `(kit_code, component_code)` |
| `product_articles` (the recipe) | `id uuid PK`; `product_id` FK products; `article_code` FK; `qty numeric(10,3)` with `0 < qty <= 100`; `role` CHECK (`main`, `component`, `gift`); `valid_from timestamptz default '-infinity'`; `valid_to NULL`; `status` CHECK (`proposed`, `approved`, `rejected`); `source`; `confidence` (`high`, `medium`, `low`); `approved_by`; `approved_at`; `note`; `created_at`. Unique `(product_id, article_code, valid_from)` WHERE status <> 'rejected'. **Only `approved` rows move stock or cost.** |
| `product_stock_exempt` | `product_id PK`; `reason`; `set_by`; `set_at` (delivery, ПОЕН, flyers… never move stock) |
| `stock_article_aliases` | `id`; `source` CHECK (`collabbox_code`, `collabbox_name`, `web_product`, `web_sku`, `name_any`); `key text` (normalised); `kind` CHECK (`article`, `not_stock`); `article_code NULL`; `qty numeric(10,3) default 1`; `status` (`proposed`, `approved`); `note`; `set_by`; `set_at`. Unique `(source, key, coalesce(article_code, ''))`. |

### Costs (owners only)
| Table | Columns |
|---|---|
| `stock_article_costs` | `id`; `article_code`; `cost_mkd numeric(14,4) >= 0`; `valid_from timestamptz` (the first Sigma load uses `'-infinity'`); `source` CHECK (`sigma_calcbuyprice`, `sigma_last_buyprice`, `owner`); `basis text`; `source_ref` (e.g. `Ф00001-04 StockObject 2026-09-29`); `flags text[]`; `recorded_by`; `recorded_at`. Unique `(article_code, valid_from, source)`. Append-only. |
| `product_cost_history` | `product_id`; `valid_from`; `valid_to NULL`; `cost_mkd numeric(14,4)`; `complete bool`; `components jsonb`; PK `(product_id, valid_from)`. Derived by `product_costs_rebuild()`. |
| `products_cost_legacy` | `product_id PK`; `cost_price_eur`; `archived_at`; `archived_by` |

### Counts, manual moves, overrides
| Table | Columns |
|---|---|
| `stock_wh_counts` | `id uuid`; `warehouse_id`; `counted_at timestamptz`; `kind` CHECK (`opening`, `full`, `partial`); `source` (`manual`, `sigma_variant`, `xlsx`); `source_ref`; `status` CHECK (`pending`, `approved`, `void`); `packed_counted bool default false`; `note`; `created_by`; `created_at`; `approved_by`; `approved_at`; `voided_by`; `voided_at`; `void_reason`. At most one approved `opening` per warehouse (partial unique index). |
| `stock_wh_count_lines` | `count_id`; `article_code`; `counted_qty numeric(14,3) >= 0`; `system_qty_at_save numeric(14,3) NULL`; PK `(count_id, article_code)` |
| `stock_manual_moves` | `id uuid`; `kind` CHECK (`receipt`, `transfer`, `adjust`, `writeoff`, `damaged`, `unpack`); `from_wh NULL`; `to_wh NULL`; `event_at`; `doc_ref`; `note`; `status` (`approved`, `void`); `created_by`; `created_at`; `voided_by`; `voided_at` |
| `stock_manual_move_lines` | `move_id`; `article_code`; `qty numeric(14,3) > 0`; PK `(move_id, article_code)` |
| `stock_parcel_overrides` | `tracking_id PK`; `action` CHECK (`exclude`, `lines`, `route`, `unpacked`, `damaged_return`); `payload jsonb`; `event_at NULL`; `active bool`; `note`; `set_by`; `set_at` |

### The ledger
`stock_moves`. Append-only: a trigger refuses UPDATE and DELETE, and refuses INSERT unless `elyon.stock_write = 'on'`.

| Column | Definition |
|---|---|
| `id` | `bigint identity PK` |
| `article_code` | FK |
| `warehouse_id` | FK |
| `qty` | `numeric(14,3) <> 0` |
| `kind` | CHECK (`opening`, `count_adjust`, `parcel_out`, `return_in`, `unpack_in`, `transfer_out`, `transfer_in`, `receipt`, `production_in`, `production_use`, `b2b_out`, `b2b_return_in`, `export_out`, `shop_out`, `shop_return_in`, `writeoff`, `damaged_in`, `adjust`) |
| `event_at` | `timestamptz` |
| `recorded_at` | `timestamptz default now()` |
| `source` | CHECK (`mex`, `count`, `sigma`, `manual`, `override`) |
| `source_key` | `text`, e.g. `mex:<tracking>:out`, `mex:<tracking>:ret`, `sigma:<doc_key>`, `count:<id>`, `manual:<id>`, `ovr:<tracking>:unpack` |
| `correction` | `bool` |
| `provisional` | `bool` |
| `tracking_id` | `NULL` |
| `sigma_doc` | `NULL` |
| `count_id` | `NULL` |
| `manual_id` | `NULL` |
| `lines_source` | `NULL` (`override`, `collabbox`, `web`, `crm`) |
| `run_id` | FK `stock_runs` |

Indexes:
- `(warehouse_id, article_code, event_at)`
- `(event_at)`
- `(source_key)`
- `(tracking_id)`
- `(sigma_doc)`
- `(run_id)`

Supporting tables:
- **`stock_runs`:** `id uuid`, `trigger`, `dry`, `status`, `stats jsonb`, `error`, `actor`, `started_at`, `finished_at`.
- **`stock_parcel_state`:** one row per parcel in scope.
  - `tracking_id PK`, `warehouse_id`, `return_warehouse_id`, `lines_source`
  - `state` CHECK (`moved`, `partial`, `unmapped`, `no_lines`, `no_route`, `test_phone`, `excluded`, `pre_opening`, `waiting_lines`)
  - `units_out`, `units_back`, `unmapped jsonb`, `flags text[]`, `fingerprint text`, `updated_at`

### Sigma staging
| Table | Columns |
|---|---|
| `stock_sigma_batches` | `batch_id text PK`; `source` (`csv`, `connector`); `mode` (`delta`, `snapshot`, `items`, `balances`); `exported_at`; `window_from`; `window_to`; `counts jsonb`; `result jsonb`; `received_at` |
| `stock_sigma_docs` | `doc_key text PK` = `'<WYear>|<DocType>|<DocNo>'`; `wyear`; `doc_type`; `doc_no`; `doc_date date`; `posted_at`; `created_at_sigma`; `created_by`; `last_change_by`; `status`; `company_from`; `object_from`; `company_to`; `object_to`; `client_code`; `client_name` (companies only); `lines jsonb` = `[{"item_code","qty","side":"in"|"out"}]` summed per item and side; `content_hash`; `versions int`; `first_seen_at`; `last_seen_at`; `last_changed_at`; `vanished_at NULL`; `excluded_reason NULL` |
| `stock_sigma_doc_versions` | `doc_key`; `version`; `doc_date`; `content_hash`; `lines jsonb`; `seen_at`; PK `(doc_key, version)` |
| `stock_sigma_doc_types` | `doc_type PK`; `name`; `direction` (`in`, `out`, `transfer`); `ledger_kind`; `include bool` |
| `stock_sigma_rules` | `id`; `match jsonb` (`{"client_code":"000217"}`, `{"doc_type":…}`, `{"doc_key":…}`, `{"objects":["Ф00001-04","Ф00001-08"]}`); `action` (`exclude`, `include`); `reason`; `active`; `set_by`; `set_at`. Seeded to exclude `000217`, `000549`, and transfers between `Ф00001-04` and `Ф00001-08`. |
| `stock_sigma_balances` | `taken_at`; `company`; `object`; `item_code`; `wyear`; `qty`; `calc_buy_price`; PK `(taken_at, company, object, item_code, wyear)` |
| `stock_sigma_drafts` | `doc_key PK`; `doc_date`; `object_from`; `object_to`; `lines jsonb`; `seen_at` ("најавено": never moves stock) |

### Settings
```json
"stock_v2": {"enabled": false, "free_units": "deduct", "stale_label_days": 14,
             "relabel_window_days": 3,
             "sigma": {"ingest": false, "apply_on_ingest": true, "costs_follow": false},
             "profit": {"cost_source": "legacy", "extra_goods": false}}
```
`app_settings.stock_v2` is an owner-only key (re-emit `tg_app_settings_guard_owner_keys` with a drift guard).

## SQL functions
Every function is `SECURITY DEFINER`, `search_path = public`, with EXECUTE for `service_role` only. Read-only reports also grant EXECUTE to `supabase_read_only_user`.

### Engine (migrations `…0200`, `…0300`, `…0400`, `…0500`)
- **`stock_v2_parcel_lines(p_from timestamptz DEFAULT NULL)`** returns `(tracking_id, lines_source, provisional, article_code, qty, line_state, line_code, line_name, product_id, why)`.
  - Sources, one per parcel, tried in order:
    1. an active override;
    2. the collabBox document `doc_number = tracking_id` (not storno, `lines_complete`, at least one goods line with qty > 0);
    3. the web order that claims the parcel;
    4. the union of the real orders holding the parcel, through their recipes;
    5. otherwise `no_lines`.
  - A collabBox line maps to an article through the alias `collabbox_code`, then `stock_articles.code = code`, then the line's `product_id` → recipe.
  - Gifts are deducted. Lines with qty ≥ 100, and products without an approved recipe, go to review.
  - Test phones (`report_excluded_phone8s()`) move nothing.
- **`stock_v2_parcels(p_from)`**: one verdict per parcel (route, state, flags, units).
- **`stock_v2_desired()`**: what the ledger should hold, as `(source_key, kind, article_code, warehouse_id, event_at, qty, source, tracking_id, count_id, sigma_doc, manual_id, lines_source, provisional)`.
  - `parcel_out`: −qty at `created_at_mex`.
  - `return_in`: +qty at `returned_at`, only while `status_id = 7`. **A return of a parcel created before the opening counts**, because the count only saw the shelf.
  - Sigma staged documents: those not vanished, not excluded, and with `doc_date ≥ sigma_moves_from`. A Sigma document's event time is its date at 12:00 Skopje.
  - Approved manual moves, overrides, and counts. The count adjustment = counted − (previous counted + non-count moves since then).
- **`stock_v2_pending()`**: the difference between desired and applied.
- **`stock_v2_apply(p_trigger text DEFAULT 'cron', p_dry boolean DEFAULT false) RETURNS jsonb`**:
  - Uses an advisory lock.
  - Writes only the differences. A difference against an already applied group is written as `correction`.
  - With the switch off it returns `{"status":"disabled"}`, unless `p_dry` is set.
- **`stock_v2_reset(p_actor uuid, p_reason text)`**: switches off, then negates every group that is not zero.
- **Writers, all audited and taking `p_actor uuid`:**
  - `stock_v2_set(p_enabled, p_patch jsonb, p_actor)` refuses ON while a routed warehouse has no approved opening.
  - `stock_v2_count_save(p_warehouse text, p_counted_at timestamptz, p_kind text, p_lines jsonb, p_source text, p_source_ref text, p_packed_counted bool, p_note text, p_actor uuid, p_is_owner bool, p_dry bool) RETURNS jsonb`.
  - `stock_v2_count_void(p_count uuid, p_reason text, p_actor uuid)`.
  - `stock_v2_manual_move(p_kind, p_from text, p_to text, p_event_at, p_lines jsonb, p_doc_ref, p_note, p_actor, p_dry)`.
  - `stock_v2_parcel_override(p_tracking text, p_action text, p_payload jsonb, p_note text, p_actor uuid)`.
  - `stock_v2_config_set(p_patch jsonb, p_actor uuid)` covers warehouses, keys, routes and Sigma rules.
  - `stock_articles_upsert(p_rows jsonb, p_source text, p_actor uuid, p_dry bool) RETURNS jsonb`.
  - `stock_article_kits_upsert(p_rows jsonb, p_actor uuid)`.
  - `product_articles_set(p_product uuid, p_lines jsonb, p_valid_from timestamptz, p_source text, p_confidence text, p_approve bool, p_note text, p_actor uuid)`.
  - `product_articles_approve(p_products uuid[], p_actor uuid)`.
  - `stock_article_alias_set(p_source text, p_key text, p_lines jsonb, p_approve bool, p_actor uuid)`.
  - `product_stock_exempt_set(p_products uuid[], p_exempt bool, p_reason text, p_actor uuid)`.
- **Reports, all with `p_preview bool`** (preview reads `stock_v2_desired()` instead of the ledger):
  - `stock_v2_on_hand(p_at timestamptz, p_warehouse text, p_preview bool)` returns `(warehouse_code, article_code, qty)`.
  - `stock_v2_day(p_day date, p_warehouse text, p_at time, p_money bool, p_preview bool) RETURNS jsonb` → `StockDay`.
  - `stock_v2_article_series(p_article text, p_warehouse text, p_from date, p_to date, p_preview bool) RETURNS jsonb` → `StockArticleSeries`.
  - `stock_v2_parcels_day(p_day date, p_filters jsonb, p_limit int, p_offset int, p_money bool) RETURNS jsonb` → `StockParcelsDay`.
  - `stock_v2_movements(p_filters jsonb, p_limit int, p_offset int) RETURNS jsonb` → `StockMovementsPage`.
  - `stock_v2_reserved_now() RETURNS jsonb`.
  - `stock_v2_health(p_detail bool) RETURNS jsonb` → `StockHealth`.
  - `stock_v2_sigma_month_check(p_month date) RETURNS jsonb`.

### Costs (migration `…0600`)
- `stock_article_costs_import(p_rows jsonb, p_valid_from timestamptz, p_source_ref text, p_actor uuid, p_dry bool) RETURNS jsonb`. Each row is `{code, cost_mkd, source, basis, flags}`.
- `stock_article_cost_set(p_article text, p_cost_mkd numeric, p_valid_from timestamptz, p_note text, p_actor uuid)`.
- `article_cost_at(p_article text, p_at timestamptz) RETURNS numeric`. On a tie the `owner` value wins.
- `product_cost_at(p_product uuid, p_at timestamptz) RETURNS numeric`. NULL when the recipe is incomplete.
- `product_costs_rebuild(p_actor uuid, p_archive_legacy bool) RETURNS jsonb`. Rebuilds `product_cost_history` and the `products.cost_price` mirror (`cost_mkd / 61.5`), and archives the legacy values once.
- `tg_products_cost_guard`: `products.cost_price` is written only by `product_costs_rebuild` (GUC `elyon.cost_write`).

### Sigma ingest (migration `…0650`)
`stock_sigma_ingest(p_batch jsonb) RETURNS jsonb` takes a `SigmaBatch` (see the types file):
- Only whitelisted fields are kept. Delivery addresses, contact names and person names are rejected.
- A batch id it has already seen is a no-op.
- A document is upserted, and a new version is added when its date or `content_hash` changes.
- A `snapshot` marks missing documents in its window as vanished.
- `items` upserts candidate articles.
- `balances` go into `stock_sigma_balances`. When `costs_follow` is on, a change of more than 0.5 % in 04's CalcBuyPrice adds a cost row dated at the snapshot.
- When `stock_v2.enabled` and `sigma.apply_on_ingest` are both on, it runs `stock_v2_apply('sigma_ingest')`.

Also: `stock_sigma_rule_set(p_row jsonb, p_actor uuid)`.

### Retire v1 (migration `…0700`, api workstream)
- Unschedule `stock-mex-apply`, and mark `app_settings.stock_mex_movements` with `{"retired":"stock_v2"}`.
- Re-emit `insights_stock`: the figure is trusted when an approved opening exists, v2 is on, and the last ok run is under 60 minutes old.
- `products_stock_mirror_refresh()` writes `products.stock_quantity` as the derived value:
  - a single-article product shows that article's on-hand at `main`;
  - a bundle shows the minimum, over its components, of on-hand divided by component quantity;
  - a guard trigger protects it.

### Pickup time (migration `…0900`)
- `mex_parcels.picked_up_at timestamptz` and `picked_up_basis text` (`observed`, `orders.shipped_at`, `estimated`). Both are NULL together.
- Write-once: set on the first status that is not 8. `mex_upsert_parcels` is re-emitted with a drift guard. mex-reconcile is unchanged, so no redeploy is needed.
- MEX keeps no status history: only `created_at` and `last_update_at`. The writer reads the previous register row:
  - **Seen at 8 (or a push placeholder with no status), now anything else:** MEX `last_update_at` of that sighting, clamped to [label, now], basis `observed`. Normally this is the 8 → 10 "In Transit" scan, ≤ 15 min before the sync. After an outage it is the first later event seen, an upper bound.
  - **Never seen, already 4/10 with the scan on the label's Skopje day:** that scan, `observed`.
  - **Never seen, anything else:** NULL.
- **NULL with a status other than 8 means unknown.** Show it as "на пат" (за пакување and кај курирот combined). NULL with status 8 is за пакување.
- History: the 01.10 sync sightings (`order_history` shipped rows since the MEX-8 rule) and parcels still at 4/10 scanned on their label day. Both are `observed`; 498 parcels as of 01.10.
  - `orders.shipped_at` is a copy of the label time everywhere, so it writes nothing.
  - No estimate is written.

### Profit (migration `…0800`)
`insights_profit` costs a line through `product_cost_history` at the sale day:

`cm = cost_mkd × qty`

- Phase B, behind `stock_v2.profit.extra_goods`: per parcel, the ledger COGS minus the order-line COGS is added as "дополнително спакувано".
- Cache version 5 → 6, and the signature includes the cost history and the approved recipes.

### Engine notes — what workstream E built (deviations and additions, 02.10.2026)
**Apply order:** `…0100` → `…0200` → `…0300` → `…0400` → `…0900` (M, `picked_up_at`) → `…0500` → `…0600` / `…0650` / `…0700` / `…0800`.
`…0500` refuses to install without `mex_parcels.picked_up_at`. `…0300`'s `stock_v2_desired()` reads it only for a count saved with `packed_counted` (dynamic SQL), so `…0300` installs without it.

**Deviations from the text above:**
- `available = closing − reserved`, **not** `closing − to_pack − reserved`. A parcel is deducted when MEX creates the label, so `closing` already excludes `to_pack` and `with_courier`. The comment in `stockV2Types.ts` should be corrected by the lead.
- `in` also counts `damaged_in`. `adjust` also counts an `opening` move that falls inside the day (an opening not counted at 00:00).
- `days_cover = max(closing, 0) / avg_out_14d`. `avg_out_14d` divides by the days since the scope start while fewer than 14 have passed.
- `stock_v2_parcel_lines(p_from, p_to)` and `stock_v2_parcels(p_from, p_to)` take an optional `p_to` (DEFAULT NULL = no end). Calls with only `p_from` behave as the contract says.
- `stock_v2_article_series` always carries `article.cost_mkd`. The function has no `p_money`, so the api strips the key for non-owners.
- `stock_v2_set` does not run a pass itself. The api runs `stock_v2_apply('switch_on')` after switching on.

**Additions:**
- **Writers:**
  - `stock_v2_count_approve(p_count, p_actor)` (lead request).
  - `stock_v2_manual_move_void(p_move, p_reason, p_actor)`.
- **Readers:**
  - `stock_v2_config()` returns `StockConfig`.
  - `stock_v2_position_at(p_at, p_warehouse, p_preview)` returns on_hand, to_pack and with_courier per article (`on_hand()` wraps it).
  - `stock_v2_reserved_lines()`.
- **Helpers:**
  - `stock_v2_settings()`, `stock_v2_enabled()`, `stock_v2_scope_from()`.
  - `stock_v2_num()`, `stock_v2_alias_key()`, `stock_v2_wh()`.
  - `stock_v2_sigma_object()`, `stock_v2_sigma_excluded()`.
  - `stock_v2_cost_at()`, `stock_v2_parse_lines()`, `stock_v2_audit()`.
  - `stock_v2_moves_sql()`, `stock_v2_wh_ref()`, `stock_v2_freshness()`.

**Semantics the contract left open:**
- **Balance at t** = Σ moves with `event_at < t`, plus a count (`opening` / `count_adjust`) at exactly t. A count's adjustment uses the non-count moves in [previous count of that article, this count).
- **Counts:**
  - Only the listed articles are adjusted. A `full` count warns `not_counted:N` and never zeroes the rest.
  - `packed_counted` takes the units still at MEX 8 at `counted_at` off the counted figure.
  - The opening must be the earliest approved count of its warehouse.
  - A non-owner's count is `pending` and must be dated after the last approved count.
  - Warnings are codes: `parcels_near_count:N` (± 2 h), `no_opening`, `old_count`, `pending_owner_approval`, `not_counted:N`.
- **Resolver:**
  - A vanished collabBox document still supplies the lines, flagged `provisional`.
  - `provisional` also marks CRM lines on a collabBox-numbered parcel (`NNN-SSSS-…`): a document is expected.
  - A test phone is caught on the parcel, on the claiming web order or on any holding order.
  - "No lines" under 2 days old is `waiting_lines`.
  - Recipes are taken at the parcel's `created_at_mex`.
  - Kits expand one level, for parcel lines only (never for Sigma documents).
  - Only **approved** aliases are used. Alias keys: codes / SKUs / shop ids upper-trimmed, names via `product_alias_norm`.
- **Routes:**
  - The lowest `priority` wins, and a route must ship from a tracked warehouse.
  - The return route is the one valid at `returned_at`.
  - Override payloads: `route` → `{warehouse, return_warehouse}`; `damaged_return` → `{warehouse}` (default `damaged`); `unpacked` → `{event_at}` (default now); `lines` → `{lines:[{code, qty}]}`.
  - Action `clear` deactivates the override.
  - A note of 3 or more characters is required on overrides and manual moves.
- **Sigma:**
  - A line's `side` picks the object: `out` = `object_from`, `in` = `object_to`. A one-object document falls back to the object it has. A line with no side follows the document's direction.
  - Kinds: transfer → `transfer_out` / `transfer_in`. Otherwise `ledger_kind`, flipped `production_in` ↔ `production_use` when the side disagrees. If none is set: `shop_out` / `receipt`.
  - An item code that is not a `stock_articles` row is skipped and counted in `health.sigma.unknown_items`.
  - Objects match keys as written, or as `company-object`.
- **Write gates:**
  - The guard triggers (`elyon.stock_write`) sit on E's tables only: warehouses, keys, routes, articles, kits, recipes, exempt, aliases, counts, manual moves, overrides, parcel state, and `stock_moves` (append-only).
  - The Sigma staging tables and the cost tables are protected by RLS and grants only. Their writers (S / P) add any gate themselves.
  - `stock_article_costs` refuses UPDATE / DELETE.
- **Writer errors:** writers answer `{ok:false, error:'<code>'}` instead of raising. The exception is `stock_v2_config_set`, which raises 22023 so that a bad patch writes nothing.
- **`stock_v2_apply`:**
  - It returns `{status: ok | disabled | busy | failed, run_id, dry, trigger, groups, moves, corrections, parcels, parcel_states_changed, units_out, units_back, by_kind{kind:{rows, qty}}, samples[50], duration_ms}`.
  - Dry runs are logged in `stock_runs` when the transaction is writable.
  - `supabase_read_only_user` may EXECUTE it: in a read-only transaction a dry pass writes nothing.
- **Filters:**
  - `stock_v2_movements` takes `{from, to (inclusive Skopje days), warehouse, article, kind, source, q, corrections: true = only / false = without (also 'only' / 'hide'), preview}`.
  - `stock_v2_parcels_day` takes `{warehouse, account, department, status, city, state}`. It never shows test phones. `returned_units` = units returned that day, whatever the creation day. `hourly.picked_up` counts every pickup of that hour (account filter only).
- **`health`:**
  - Extra keys: `queues.unmapped_parcels`, `queues.states`, `recipes.exempt`, `sigma.docs_type_not_included`, `sigma.unknown_items`; `last_run.stats.error`.
  - `negatives` come from the ledger when the switch is on, and from the preview when it is off.
- **`reserved_now` is an estimate:**
  - Confirmed CRM orders with no parcel (`warehouse_send_base()`), through approved recipes.
  - collabBox order / order_unless_held / credit documents of the last 14 days with no parcel, not tied to a queued order.
  - Unmapped lines are counted, never guessed.
- **Before articles are loaded,** every parcel is `unmapped` and a pass writes nothing. The preview becomes meaningful once S loads `articles.json`, plus approved recipes for web / CRM-only parcels.

## Data files from `docs/stock/build_sigma_stock.py`
Output goes to `exports/stock/`, which is gitignored and never committed (business-confidential costs).

| File | Shape |
|---|---|
| `articles.json` | `[{code, name, unit, sigma_class, brand, is_set, active}]` |
| `costs.json` | `[{code, cost_mkd, source, basis, source_ref, flags[]}]`. `basis` is one of `04_calcbuy_qtyweighted`, `04_calcbuy_single`, `04_last_buyprice_2026`, `other_object`, `none`. |
| `openings.json` | `{generated_at, variants: {<key>: {warehouse:"main", at:"2026-09-22T00:00:00+02:00", label, lines:[{code, qty}], totals}}}`. Keys: `04_morning_2209` (doc date ≤ 21.09), `04_end_2209`, `04_plus_08_morning_2209`, `08_end_2209`. |
| `kits.json` | `[{kit_code, components:[{code, qty}], source_ref, observed_at}]` |
| `recipes.json` | `[{product_id, product_name, kind, lines:[{code, qty, role}], confidence, source, note}]` |
| `sigma-batch-since-2209.json` | One `SigmaBatch` (`mode:"delta"`): every posted document dated on or after 22.09 touching `Ф00001-04`/`08`/`11`, plus `items` and `balances` |

## HTTP API (`supabase/functions/api`, module `stockV2.ts`; JSON shapes in `src/lib/stockV2Types.ts`)
**Access:**
- Quantities: owners, admin, manager, warehouse.
- Money: owners only.
- Counts: owners, admin, warehouse. A non-owner's count is saved `pending`.
- Configuration, mappings, costs, switch, overrides: owners only.

| Method | Route | Body / query → response |
|---|---|---|
| GET | `stock/v2/health` | → `StockHealth` |
| GET | `stock/v2/day?day=YYYY-MM-DD&warehouse=main&at=HH:MM&preview=0/1` | → `StockDay` |
| GET | `stock/v2/article?code&warehouse&from&to&preview` | → `StockArticleSeries` |
| GET | `stock/v2/parcels?day&warehouse&account&department&status&city&state&limit&offset` | → `StockParcelsDay` |
| GET | `stock/v2/movements?from&to&warehouse&article&kind&source&q&corrections&limit&offset` | → `StockMovementsPage` |
| POST | `stock/v2/count` | `StockCountRequest` → `StockCountResult` |
| POST | `stock/v2/count/:id/void` | `{reason}` |
| POST | `stock/v2/count/:id/approve` | (owners) |
| POST | `stock/v2/move` | `StockManualMoveRequest` → `{ok, move_id?, preview?}` |
| POST | `stock/v2/parcel-override` | `{tracking_id, action, payload, note}` |
| GET / PUT | `stock/v2/config` | `StockConfig` |
| POST | `stock/v2/switch` | `{enabled}` |
| POST | `stock/v2/run` | `{dry}` → run stats |
| GET | `stock/v2/articles?q` | → `StockArticleRow[]` |
| POST | `stock/v2/article-cost` | `{code, cost_mkd, valid_from, note}` |
| GET | `products/:id/articles` | → `ProductRecipe` |
| POST | `products/articles` | `{product_id, lines, approve}` |
| POST | `products/articles/approve` | `{product_ids}` |
| GET | `stock/v2/sigma/status` | Sigma status |
| GET | `stock/v2/sigma/month-check?month=YYYY-MM` | Sigma month check |
| POST | `stock/sigma/ingest` | **HMAC only, no login.** Secret `SIGMA_CONNECTOR_SECRET`. Headers `x-elyon-ts` and `x-elyon-signature = hex(HMAC_SHA256(secret, ts + "." + rawBody))`, within ±300 s. Body is a `SigmaBatch`. |

Old routes once the v2 UI ships:
- `restock`, `stock/count`, `stock/mex-movements` → 410.
- `stock-movements` reads v2.
- `stockByStatus()` → false. The status-driven deduction is gone.

## UI (`/warehouse`)
Tabs: `send` · `pack` · `stock` (Залихи) · `parcels` (Пратки) · `movements` (Движења) · `count` (Попис).
- Insights style. Cards below `md`, never a sideways scroll. i18n namespace `stock2.*` in mk, en, sq and bg.
- A banner "Преглед — пресметано, ништо не е запишано" shows while `enabled = false` (`preview=1`).
- `/products` (owners): "Набавна (Сигма)" in денари, a recipe drawer, and a "без рецепт" filter.

## Workstreams and file ownership
| WS | Branch | Owns |
|---|---|---|
| Lead | main | this file, `src/lib/stockV2Types.ts`, merges, applies migrations, deploys |
| E (engine) | `stock-v2-engine` | `…0100`, `…0200`, `…0300`, `…0400`, `…0500`; `scripts/verify-stock-v2.mjs`; `scripts/stock/{backfill-preview,stock-run,stock-reset}.mjs` |
| S (Sigma) | `stock-v2-sigma` | `docs/stock/**`, `…0650`, `scripts/stock/{mapping-review-xlsx,mapping-apply,opening-apply,sigma-month-check,sigma-ingest-file}.mjs`, `tools/sigma-connector/**`, the internal report in `exports/magacin/` (local only) |
| A (api) | `stock-v2-api` | `supabase/functions/api/index.ts`, `stockV2.ts` and its test, `productsCatalog.ts`, `…0700` |
| U (ui) | `stock-v2-ui` | `src/pages/WarehousePage.tsx`, `src/components/warehouse/v2/**`, `src/lib/stockV2Api.ts`, the `stock2.*` i18n keys |
| P (profit) | `stock-v2-profit` | `…0600`, `…0800`, `supabase/functions/api/insightsProfit.ts` and its test, `src/components/insights/profit/**`, `src/components/products/**` (cost column, recipe drawer), `scripts/stock/costs-apply.mjs`, the `profitCost.*` / `productsRecipe.*` i18n keys |
| M (mex) | `stock-v2-pickup` | `…0900`, `supabase/functions/mex-reconcile/**` (only if the column must be fed from TS) |

**Rules:**
- Nobody applies migrations or deploys; the lead does.
- An agent may dry-run SQL against MK inside `BEGIN … ROLLBACK` through the Management API (`read_only:false`) after `node scripts/assert-mk-target.mjs`.
- Bulgaria (`sxymaloycddnoxudxaqp`) is never touched.
