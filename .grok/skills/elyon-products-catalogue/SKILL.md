---
name: elyon-products-catalogue
description: The product catalogue of the Macedonian Elyon CRM after "Производи 2.0" (30.09–01.10.2026) and Stock v2 (01–02.10.2026) — each product's RECIPE (product_articles: which Sigma articles it is made of; only an APPROVED recipe moves stock and cost; the /products Рецепт drawer and "Набавна (Сигма)" column, owners only), every product's KIND (product / bundle / gift / other, products.kind, product_kind_by_name + product_kind_proposal, the TS twin in productsCatalog.ts) and BRAND LINE (natura_therapy / bio_natural / ad_astra / dr_becker, products.brand_line, product_brand_line_proposal, mex_profile_for_line — the line decides the MEX profile when the CRM itself ships), the owner's web-catalogue rule (naturatherapy.mk = Natura Therapy or Ad Astra, never Bio Natural), the two audited writers behind guard triggers (products_set_kind / products_set_brand_line) and the VAT rate per product (products.vat_rate from Sigma, products_set_vat_rate, owners only — docs/VAT.md), the machine-text cleanup and its backup table, the /products page (opens on active products of kind "product", chips, Предлог), and the scripts apply-brand-lines / map-web-catalogue / apply-product-kinds / clear-product-machine-text. Read before touching products.kind or brand_line, the /products page, the catalogue scripts, or the MEX account choice of a CRM push.
---

# Products catalogue — kinds and brand lines (MACEDONIA)

Two owner rulings shaped the catalogue:

- **30.09.2026 (plan Фаза 4):** when the CRM itself ships an order via MEX, the **product line
  decides the MEX profile** (the team is secondary): Bio Natural and Dr.Becker → BIO NATURAL;
  Natura Therapy and Ad Astra → NATURA. He asked for a map of ALL products by line first.
- **01.10.2026 ("Производи 2.0"):** /products showed 706 rows where bundles, promotions, gifts and
  objects (a scale, a blender, shakers …) sat next to the products. The page must open on the
  ordinary PRODUCTS; the rest is categorised. The machine notes the 28.09 catalogue scripts wrote
  into descriptions "look unprofessional" — gone.

Neither kind nor line is read by any report, order, money or stock path (the RECIPE is — §8). The department of a sale stays
the collabBox folder + the MEX profile of its PARCEL (`elyon-departments-and-sources`) — a product
line never decides a department.

## 1. Kind — `products.kind` (migration `20260943001400`)

| kind | Label (mk) | What |
|---|---|---|
| `product` | Производи | a single supplement / cosmetic sold as a product — **the default view** |
| `bundle` | Пакети и промоции | 1+1, 2+1, 2x, 3x, сет, PACK, Combo, пакет, гратис, подарок … |
| `gift` | Подароци | an item used as a free gift |
| `other` | Друго | a physical object that is not a supplement (вага, блендер, тостер, шејкер, jade roller …) |
| NULL | Неодредено | not decided |

- `product_kind_by_name(name)` (immutable) — the NAME classifier, first rule that fires: promo
  (1+1, 30+30) → bundle word → multi-pack (2x / a leading count, not "5 in 1") → a "+" joining
  another item (a "+" between nutrients of ONE formula — MAGNESIUM+B6, D3+K2+BOR — does not count)
  → an object word (mk / en / sq / bg) → a single product.
- `product_kind_proposal()` — the name, plus: a single product whose order lines are mostly FREE
  (0 ден beside a paid line of another product) is a gift — ≥ 60 % of ≥ 20 lines, **sure** from
  ≥ 90 % of ≥ 30. An object stays `other` even when given away (owner: shakers are Друго).
- **The TS twin** `supabase/functions/api/productsCatalog.ts` (`classifyKindByName` /
  `proposeKind`, also the product form's live hint) carries the same regex SOURCES verbatim;
  `productsCatalog.test.ts` reads the migration and fails on drift. Keep both to the POSIX-ARE /
  JavaScript subset (no `\b` / `\y`, explicit Cyrillic ranges, lower-cased input).
- **Applied 01.10:** 635 set (323 product, 244 bundle, 68 other) + the 36 sure "free in orders"
  candidates kept as **products** (Immuno Boost, Chia, D3, Zinc … are products we also give away).
  Live: product 359 · bundle 244 · other 68 · gift 0 · undecided 35. **The 35 uncertain gift
  candidates wait for the owner** (/products → Предлог → Вид).

## 2. Brand line — `products.brand_line` (migration `20260943001300`)

- Values `natura_therapy | bio_natural | ad_astra | dr_becker`, NULL = not decided (nothing guesses
  a line into it); `brand_line_set_by` / `brand_line_set_at`.
- **`mex_profile_for_line(line)`** (immutable): `bio_natural` / `dr_becker` → `'bio_natural'`;
  `natura_therapy` / `ad_astra` → `'natura'`; anything else → NULL. The MEX push
  (`decideAccount`, `supabase/functions/api/mexPush.ts`) takes the account from the basket's lines:
  one profile → that account; a basket with no line → the department only SUGGESTS and a person
  confirms (`line_missing`); a department or team that disagrees, or a MIXED basket
  (`mixed_basket`), → no account until a person picks one with a reason. The mixed-basket rule
  itself is still the owner's (see `elyon-fulfilment-csv`).
- `product_brand_line_proposal(p_days default 180)` — per product the parcels per account of the
  last p_days, a suggested line, a confidence and the reason. Precedence: a Dr.Becker / Ad Astra
  word in the name (a HINT — the owner confirms) > a Bio Natural ANCHOR name (the 12 products of the
  untracked `bionatural products/` folder, or BIONATURAL in the name) > the parcels (≥ 90 % on one
  account → bio_natural / natura_therapy; otherwise the majority, low). An anchor the parcels
  contradict is a CONFLICT, never automatic. `auto` = undecided + anchor or high.
- **The web-catalogue rule (owner, 01.10):** everything sold on naturatherapy.mk is **Natura
  Therapy or Ad Astra** (the Ad Astra page is `/adastra-nutrition`); **Bio Natural never appears on
  the web.** `scripts/map-web-catalogue.mjs` (+ `scripts/lib/web-catalogue-mk.mjs`) reads the PUBLIC
  shop pages politely (cached 24 h under `exports/web-catalogue/cache/`, the live shop is never
  written) and proposes: anchor → Bio Natural; on the web → Ad Astra (on `/adastra-nutrition`) or
  Natura Therapy; not on the web and sold via BIO NATURAL in the last 120 days → Bio Natural; not on
  the web and ≥ 90 % NATURA parcels → Natura Therapy. It never overwrites an owner's Ad Astra /
  Dr.Becker tag or an anchor.
- **Applied 01.10:** `apply-brand-lines` 131 Natura Therapy (≥ 90 % of ≥ 10 parcels) + 21 Bio
  Natural **by name only** (`--bio-by-name-only`: a BIO NATURAL parcel alone never makes a product
  Bio Natural); Ad Astra from the owner's `/adastra-nutrition` page; then `map-web-catalogue` 346
  (Natura Therapy 339, Bio Natural 6 by recent BIO NATURAL parcels — none on the web, Ad Astra 1,
  0 overwrites). **Live 01.10 (read-only count): Natura Therapy 438 · Ad Astra 123 · Bio Natural 27
  · undecided 118 of 706.** No product is Dr.Becker yet. **Waiting for the owner:** the 22 products
  that are Bio Natural by parcels only, the mixed / conflict rows, and the Dr.Becker products.

## 3. The two writers — audited, behind guard triggers

`products` is writable by admins and managers straight through PostgREST, so without a guard a kind
or a line could change with no audit row.

- `products_set_kind(ids, kind, actor)` and `products_set_brand_line(ids, line, actor)` are the
  ONLY writers of their three columns: `tg_products_kind_guard` / `tg_products_brand_line_guard`
  refuse any other write; each function opens its gate with a transaction-local setting and writes
  one `audit_log` row per call. NULL = back to undecided. Service role only.
- API (admins + owners): `GET /products/kind-proposal`, `POST /products/kind {ids, kind}`,
  `GET /products/brand-line-proposal?days=`, `POST /products/brand-line {ids, line}`.
  `PATCH /products/:id` whitelists the form's fields and drops kind / line. `GET /products` and the
  lean `GET /products/catalogue` return both columns to every login that may read products — a kind
  or a line is not money.
- A maintenance script that must write the columns goes through the same functions (every script
  below does).

## 4. Machine text — cleared, backed up (`20260943001410`)

The 28.09 catalogue scripts wrote their own notes into `products.description` ("Креиран автоматски
(complete-catalogue, run …) …") and `products.category` ("Од продажби — collabBox/web …", "Без
каталог — …", "AlterCPA — нови понуди …"). The api blanks them on `GET /products` and
`/products/catalogue` (`humanDescription` / `humanCategory` in `productsCatalog.ts`), and
`scripts/clear-product-machine-text.mjs` cleared them on **493 products** (run `90c58d34`) after
backing up `(product_id, description, category)` into **`products_description_backup_20261001`**
(RLS on, no policies). `--restore` puts them back where the product still carries `''`, which keeps
the 28.09 scripts' rollbacks (they find their rows by the run id in the description) possible. Only
rows whose description STARTS WITH the machine text are touched — a human note is never cleared.

## 5. The /products page

- Opens on **active products of kind "product"** (`DEFAULT_KIND_FILTER`, `src/lib/products/kinds.ts`;
  status `active`, `8a8508f`); Сите / Исклучени and the other kinds are one chip away (Производи ·
  Пакети и промоции · Подароци · Друго · Неодредено · Сите). Chips kind · line ("Линија": Natura
  Therapy / Bio Natural / Ad Astra / Dr.Becker, `src/lib/products/brandLines.ts`) · status with
  faceted counts, in the URL (`?line=` …);
  deferred search; ONE layout mounted (table from xl, cards below), 50 per page + "Прикажи уште",
  no descriptions in the list (57.000 → 2.100 DOM elements).
- Bulk "Постави вид" / "Постави линија" and the line picker on a product are for admins / owners;
  **Предлог** (`?view=proposal&of=kind|line`, admins / owners only) = the kind + line proposals
  (tiles, accept one, accept all sure with a confirm, pick per row).
- The product form (rebuilt 01.10): full screen on a phone, a dialog from sm; sections Основно ·
  Цени · Код · Залиха · Детали; only changed fields are sent; kind and line go through their audited
  routes; a partial failure keeps the form open on the saved product. Managers see no cost; the form's cost
  is "Набавна (Сигма)" — computed from the recipe, never typed (`products.cost_price` is a guarded mirror).
- Stock is Stock v2 (`elyon-stock-v2`, in preview until the owner's count): sellable products keep the
  placeholder 1.000 until the switch, then `products.stock_quantity` mirrors the ledger (guarded — the form
  has no stock field). The low-stock threshold is edited in the product form.

## 6. Scripts (all dry run by default, Macedonia-pinned repair-kit guards)

| Script | Does | Apply |
|---|---|---|
| `scripts/apply-brand-lines.mjs` | sets the proposal's `auto` rows (undecided + anchor / ≥ 90 %); full map CSV under `exports/repairs/` | `--apply --actor <admin uuid>` (`--min-parcels N`, `--bio-by-name-only`, `--from-json`) |
| `scripts/map-web-catalogue.mjs` | the web-catalogue map above (new + web-contradicted lines) | `--apply --actor <uuid> [--no-overwrite]` (`--offline`, `--refresh`) |
| `scripts/apply-product-kinds.mjs` | sets the kind proposal's sure rows | `--apply --actor <uuid> [--only bundle,other]` |
| `scripts/clear-product-machine-text.mjs` | clears the machine description / category after the backup | `--apply --actor <uuid>` · `--restore --actor <uuid>` |

Each writes only through the audited functions, only rows still undecided at write time (an owner's
choice is never overwritten), and touches no order, money or stock.

## 7. VAT rate per product (owner 01.10.2026 — `docs/VAT.md`, migration `20260944000900`)

- `products.vat_rate` (0 / 0.05 / 0.10 / 0.18; NULL = **Некласифицирано**), `vat_source` (sigma:crosswalk-… /
  sigma:manual / sigma:by-name[+mixed] / rule:… / owner), `vat_sigma_code` / `vat_sigma_name`, `vat_evidence`
  (the Sigma invoice lines), `vat_set_by` / `vat_set_at`. Backfilled for the 706 products of 01.10 from
  `docs/vat/crm_products_vat.json` (`scripts/vat/gen-vat-backfill.mjs`); a new product stays NULL until an owner
  sets it (reports tax it at 5 % and show it apart).
- The third audited writer: `products_set_vat_rate(ids, rate, actor, note)` behind `tg_products_vat_guard`;
  `POST /api/products/vat-rate` — **owners only** (it moves every profit figure). `GET /products` and
  `/products/catalogue` send the VAT columns to owners only (`vat_visible`); `PATCH /products/:id` drops them.
- /products (owners): a ДДВ column / card chip (`VatChip`: the rate, its source, the Sigma item and the invoice
  evidence; pick 5 % / 18 % / 10 % / 0 % / Некласифицирано), a ДДВ filter row (`?vat=r5|r18|none`), "Постави ДДВ"
  for a selection. Pure half: `src/lib/products/vat.ts` (+ `vat.test.ts`); server: `supabase/functions/api/vatRates.ts`.

## 8. Recipes and the Sigma purchase cost (Stock v2, owner 01.10.2026 — `docs/STOCK-V2.md`, `elyon-stock-v2`)

- **`product_articles` = the recipe**: which Sigma ARTICLES (`stock_articles`, 6-digit Sigma codes or local `L…`)
  one unit of the product is — a single product = its own article × 1, a bundle = its components, a gift packed with
  it = role `gift` (a real cost). Lines carry `status` proposed / approved / rejected, `confidence` high / medium /
  low, `valid_from` / `valid_to`. **Only an APPROVED recipe moves stock (a CRM-only or web parcel is resolved through
  it) and gives the product a cost.** `product_stock_exempt` = products that carry no goods (delivery, ПОЕН, flyers):
  never stock, cost 0.
- **Loaded 02.10** by `scripts/stock/mapping-apply.mjs` from `docs/stock/build_sigma_stock.py`: recipes for 316
  products — **154 approved** (confidence high) and **162 proposed for the owner's review** (135 medium, 27 low).
- **Cost** = Σ qty × the article's Sigma `CalcBuyPrice` at that moment (`product_cost_at`, history in
  `product_cost_history`; complete only when every line's article has a cost). `products.cost_price` (EUR) is a GUARDED
  mirror = cost_mkd / 61,5 written only by `product_costs_rebuild()` (`tg_products_cost_guard`); the 69 old EUR values
  are archived in `products_cost_legacy`. Denari, ex VAT — the exception to "store EUR".
- **/products (owners only):** the column / card value **"Набавна (Сигма)"** (`cost_mkd` from
  `stock_v2_product_overview()` via `GET /products/catalogue` — never the EUR mirror × 61,5), the **Рецепт** chips
  (Со рецепт · Предлог · Без рецепт; "без роба" for an exempt product) and the **recipe drawer**
  (`src/components/products/RecipeDrawer.tsx`: search Sigma articles, qty 0–100, role главен / состојка / подарок,
  each line's cost, "Зачувај како предлог" · "Зачувај и одобри" · "Одобри го предлогот"). Routes `GET
  products/:id/articles`, `POST products/articles`, `POST products/articles/approve`, `POST products/articles/exempt`
  — owners, audited; after each write the api runs `product_costs_rebuild(actor, false)` (profit follows) and the
  stock mirror. Managers and everyone else get no cost key and no recipe status.

## Never

- Write `kind` / `brand_line` / `vat_*` (or their `_set_*` columns) with a plain UPDATE or PATCH — use the
  three functions; never disable the guard triggers.
- Guess a VAT rate into a new product, or show the VAT columns to a non-owner.
- Type a purchase cost into `products.cost_price` (the guard refuses it — set the recipe or the article's cost), show
  a cost or a recipe status to a non-owner, or approve the proposed recipes in bulk without the owner.
- Decide a sale's department from a product line, or a product line from a single BIO NATURAL parcel.
- Tag a web-catalogue product Bio Natural.
- Change the classifier in one twin only (SQL `product_kind_by_name` / TS `productsCatalog.ts`).
- Delete `products_description_backup_20261001` while a 28.09 rollback could still be needed.

## Companion skills

`elyon-fulfilment-csv` (the MEX push uses the line) · `elyon-warehouse-incoming` (Залихи) ·
`elyon-departments-and-sources` (departments never follow a product) · `elyon-web-shop-bridge`
(the shop is read-only) · `elyon-stock-v2` (recipes move stock) · `elyon-logistics-costs` (costs in the
profit) · `elyon-security` (the guard triggers).
