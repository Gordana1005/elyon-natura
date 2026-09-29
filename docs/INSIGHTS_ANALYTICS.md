# Insights & analytics — Macedonia

> Rewritten 29.09.2026 from the code and the live database. The Bulgarian version of this page
> (SOLD-basis revenue, EUR + лв, credit to the confirmer) is gone: Macedonia counts **one sale
> cohort** in **денари**, split into **six departments**, and **MEX decides money**. Owner law of
> 28–29.09.2026. Where an older doc disagrees, this page, the migrations and
> `.grok/skills/elyon-departments-and-sources` win.

---

## 1. The surfaces

**`/insights`** (`src/pages/ManagementInsightsPage.tsx`, one page, one shared period in the URL,
each tab in `src/components/insights/<tab>/`):

| Tab (`?tab=`) | Label mk / en | Endpoint | SQL (migration) | Who |
|---|---|---|---|---|
| `overview` | Преглед / Overview | `GET /api/insights/overview` | `insights_overview` + `insights_cohort` + `collabbox_feed_state` | owners with money; admin/manager counted |
| `sales` | Продажби / Sales | `GET /api/insights/sales?part=core\|detail` | `insights_sales` (20260941000100) | same |
| `agents` | Агенти / Agents | `GET /api/insights/agents[?person=]` | `insights_people` (20260941000200) | module permission; money for owners |
| `payout` | Исплати / Payout | the old `/api/management-insights` blocks | `insights_orders_rollup` / `insights_paid_basis` / `insights_channel_pl` | module permission; payout math deferred by the owner |
| `pure-profit` | Чиста добивка / Pure Profit | `GET /api/insights/profit` (+ `POST …/profit/refresh`) | `insights_profit` (20260941000300) + `insights_profit_monthly` (20260942000200) | **owners only** |
| `margin-lab` | Маржи / Margin Lab | same payload | same | **owners only** |
| `prediction-lists` | Прогнозни списоци / Prediction Lists | `GET /api/insights/lists` | `insights_lists` / `insights_lists_cash` (20260941000400; every department's list sales since 20260942001800) | owners with money; admin/manager counted |
| `stock` | Производи и залихи / Products & Stock | `GET /api/insights/stock` | `insights_stock` (20260941000500, trust verdict 20260942000100) | same |
| `returns` | Враќања / Returns | `GET /api/insights/returns?clock=sale\|returned` | `insights_returns` / `insights_parcel_rows` | same |
| `call-activity` | Активност на повици / Call Activity | `GET /api/insights/work`, `…/work/day?day=` | `insights_work*` (20260941000600) over `v_sales_work` | module permission |

Also: `GET /api/insights/cohort` (the cohort alone), `GET /api/insights/pivot?by=source,team,person`
(owners only, the Overview's pivot). Every tab ties to the cohort — see §7.

**One calculation everywhere (owner, 29.09: "Табла, Insights and Операции synchronised").** The
other live surfaces read the same cohort instead of counting orders their own way:

| Surface | What it shows now | Reads |
|---|---|---|
| **Табла** (`/`, `src/pages/Dashboard.tsx`) for **admins** | the Insights Overview itself, with the Insights period bar (`InsightsFilterBar` + `OverviewTab`) — the same numbers as Insights → Преглед, every number opening exactly its orders (`981051b`) | `GET /api/insights/overview` |
| Табла for everyone else | the agent's personal dashboard (own day / month, My Orders), unchanged | `dashboard-stats` and the agent endpoints |
| **Операции** (`/operations`, admin / manager) | today = the sale cohort of the **Skopje** day: sales today by department, to pack (`to_pack`), MEX money collected today (the cohort's cash flow), MEX returns today; per agent the day's credited sales (`total_count`) and worked decisions — the TV board's numbers; online = the 2-minute presence heartbeat (`3463311`) | `GET /api/operations-center` → `insights_cohort` (the Skopje day, six departments) + `leaderboard_day_v2` + `mex_parcels.returned_at` |
| **TV leaderboard** (`/tv/leaderboard?key=…`) | one row per agent, the day split over the six departments, managers shown not ranked, no bonus | `GET /api/leaderboard?v=2` → `leaderboard_day_v2` (reads `insights_sale_rows`) |

The old admin Табла — CRM statuses by created UTC day, "revenue" = shipped + paid, rankings by
the assigned agent, paging every order of the period — is gone, and so is Операции' "orders created
today by CRM status" with "revenue" = the price of orders flipped to paid today. Money tiles and
`*_mkd` keys only for business owners on all of them (the TV token keeps the wall board's денари).
`/performance` redirects to `/insights?tab=agents` and `/agent-activity` to
`/insights?tab=call-activity`. The TV board in depth: `.grok/skills/elyon-presence-and-leaderboard`.

## 2. Who sees money

- **`public.is_business_owner(uid)` is THE predicate** (RLS, the api's `isBusinessOwner()` and the
  UI's `canSeeBusiness` all ask it). Since `20260939000500` every **active admin** is an owner, plus
  the `business_owners` list.
- A **manager** (not an owner) gets the same Overview / Sales / Lists / Stock / Returns payloads
  with **every money key absent** (`meta.money = false`; the `*_mkd` / `*_eur` whitelist strip).
  Owner-only surfaces (Pure Profit, Маржи, the pivot, Settings → Teams / Integrations) answer
  `403 owners_only`. Never gate money on `financial_visibility` — nothing reads it. The order
  window's "Origin and proof" follows the same rule: its CRM price, MEX COD and collabBox amount
  reach owners only (`edfa901`).
- All amounts are **денари** (owner, 28.09). The api sends whole денари in `*_mkd` keys, rendered
  with `formatDenari`; stored EUR prices go through `formatMoney` (× the FROZEN 61,5). Never
  multiply a COD or a `*_mkd` value by 61,5. The only EUR on screen is the foreign affiliate payout.

## 3. The cohort — the one definition of a sale

`20260940000000_insights_foundation.sql` (re-emitted with the six departments by
`20260942001000`): `insights_sale_rows` (one row per sale), `insights_leads_rows` (one row per lead
that came in), `insights_cash_rows` (one row per delivered MEX parcel + the card line),
`insights_parcel_rows`, `insights_cohort` (the `/api/insights/cohort` body). Every tab reads these
instead of re-deriving "what is a sale".

**What a sale is.**
- An **order** row that is not a disposition (`elyon_crm/disposition` = a 0 ден call outcome, never
  a sale) and either has a parcel (MEX-first) or a CRM status confirmed / shipped / paid /
  returned (`delivered`, inherited from BG, reads as paid).
- A **web order** from the `web_orders` mirror (failed card checkouts `card_unpaid` excluded).
- A **MEX-only parcel** — a parcel no order and no web order owns.

**A parcel counts once**, first match: a live web order claims it → web; a real order holds it
(`orders.mex_tracking_id` or `mex_parcels.order_id`) → that order; else MEX-only. The 3 parcels two
orders hold (owner: both accurate) are one parcel whose COD is split by price share.

**Sale day** (Skopje days): orders `coalesce(sold_at, AlterCPA ledger decided_at of an approved /
cancel-other decision, confirmed_at, created_at)`; web `web_orders.created_at`; MEX-only
`mex_parcels.created_at_mex`.

**Buckets — MEX status beats CRM status.** The eight sum EXACTLY to the total; every sale lands in
exactly one:

| Bucket | mk label | Rule |
|---|---|---|
| `paid` | Наплатено | MEX 2 Delivered |
| `paid_unproven` | Платено без MEX доказ | CRM paid, no parcel, not legacy (red; should be 0) |
| `paid_legacy` | Платено (одлука / стар увоз) | CRM paid, no parcel, `paid_basis` `operator_ruling` / `legacy_import`, or a pre-guard import row; web OC-order delivered/done with no parcel |
| `courier` | Кај курирот | MEX 1 / 4 / 10 / other moving statuses; CRM shipped with no parcel |
| `courier_problem` | Проблем кај курирот | MEX 3 / 9 / 13 (inside "at the courier") |
| `label` | Спакувано, чека курир | MEX 8 Shipment created |
| `to_pack` | Во магацин за пакување | CRM confirmed, no parcel |
| `returned` | Вратено | MEX 7, or CRM returned with no parcel |

Outside the total ("Надвор од збирот"): `cancelled_after_sale` (Откажани по продажбата, red),
`trashed_after_sale` (Во корпа по продажбата, grey) — sold, then cancelled / trashed, no parcel —
and `replacement` (Замени (без откуп): COD ≤ 0, or no parcel and price ≤ 0). "Нарачки" are only
real orders; cancels and trash are never orders or order value.

**Value** (денари): the parcel's COD when a parcel exists (never × 61,5 again), else price × 61,5;
web = the shop total; a replacement is 0.

**Why a paid order is paid — `orders.paid_basis`:** `mex` · `operator_ruling` · `legacy_import` ·
`manual` · `unproven` (a paid write without a basis is stamped `manual`). The teleshop history
before MEX coverage is `legacy_import` (214.700 orders — "paid – history", shown as `paid_legacy`,
never as MEX-proven cash); rows paid before the guard of 27.09 (the AlterCPA history, the 12.08
collabBox register) carry NULL — 14.797 of them hold a delivered MEX parcel and still wait for the
`mex` stamp (a hygiene item; no figure moves). **The cohort judges proof from the parcel, not from
this column.**

**Leads** (`insights_leads_rows`): every order row and web order that CAME IN in the window (by
`created_at`), with its state now — sale / cancelled / trashed / open / other; a disposition row is
a worked decision ("Обработени"), never a sale. MEX-only parcels are not leads. **Cash**
(`insights_cash_rows`): every parcel MEX delivered in the window (by `delivered_at`), once, plus the
card money of card-paid web orders (`card_mkd` = shop total − COD). The leads funnel and the cash
flow are separate, labelled figures — never mixed into the cohort total.

**Test phones:** the owner's two test numbers (`public.report_excluded_phones`, read through
`report_excluded_phone8s()`) are in no sale, lead or cash figure.

## 4. The six departments

Every sale is in exactly one department; Σ departments = total.

| key | Label | Orders | MEX-only parcels (BIO NATURAL first, then series) |
|---|---|---|---|
| `altercpa` | Affiliate – Lead in | `altercpa/bridge`, `altercpa/history`, `altercpa/collabbox_leads` (collabBox 10111), `affiliate/partner` | BIO NATURAL 9110; 9110 |
| `elyon_crm` | Affiliate – Lead out | CRM-made sales `elyon_crm/prediction_list` + `direct` on BIO NATURAL or with no parcel yet; collabBox 10114 `elyon_crm/collabbox_leads_out` | any other BIO NATURAL parcel; 9103 |
| `teleshop_out` | Телешоп – Lead out | collabBox 10050 `collabbox/teleshop_out`; a CRM-made sale on NATURA outside 9100 / 9108 / 1300 | 9102 |
| `teleshop_other` | Телешоп – Lead in | collabBox 10036 `collabbox/teleshop`; anything unclassified | 9100 and anything else |
| `social` | Социјални мрежи | collabBox 10106 / 10055 `collabbox/social` | 9108, 1300 |
| `web` | Веб-продавница | `web_orders` (not orders) | `NTMK…`, `M…`, web-claimed |

- The order's department is `cohort_order_source(sale_source, sale_source_detail,
  mex_tracking_id, dept_override)` — **4 arguments** in every report since `20260942001800`:
  `orders.dept_override` first, else the folder / series mapping (the 3-argument form — never call
  that one in a report).
- **A CRM-made sale (prediction list / direct) follows its MEX PROFILE** (owner 29.09 ~12:05,
  `20260942001860`: "every order sent via BIO NATURAL comes from affiliate IN and OUT … teleshop
  sends via NATURA"): on BIO NATURAL it is Affiliate – Lead out whatever the series; on NATURA it
  goes by series (9100 → Телешоп – Lead in, 9108 / 1300 → Социјални мрежи, else → Телешоп – Lead
  out); with no parcel yet it is Affiliate – Lead out until MEX shows the profile. The trigger
  re-decides when mex-reconcile links the parcel.
- A MEX-only parcel's department is `cohort_parcel_source(cohort_parcel_split(…))`: a BIO NATURAL
  parcel is affiliate first (9110 → Lead in, anything else → Lead out — never web or teleshop), then
  NTMK / `M…` → web, then the series.
- Decided by the collabBox FOLDER and the MEX profile / series — never by the system an order was
  made in, never by the seller or her team. A team rule (`20260942001800`: `crm_prediction` sellers
  → Телешоп – Lead out) was withdrawn the same morning (`…1850`). The whole rule, the stored
  vocabulary and the reclass log: `.grok/skills/elyon-departments-and-sources`.
- The same mapping names every order outside Insights: the Orders list shows each order's
  department chip and seller (`order_departments(ids)`, `20260942001500`), and the order window's
  **"Origin and proof"** panel (admin / manager; its money keys for owners only) shows department,
  intake, seller, the AlterCPA decision, the collabBox document and the MEX parcel
  (`order_origin(id)`, `20260942001600`);
  Customer 360 badges each order with its department (`customer_timeline`, `20260942001700`).
- `mex-reconcile` revives a cancelled / trashed order only with its own folder's parcel (AlterCPA
  9110, CRM 9103 — `mayReviveWith`, 29.09), so a teleshop / social parcel is never counted in
  Affiliate – Lead in through an old lead on the same phone.

September 01–27.09 (orders, 28.09 night, before the MEX-profile rule): Affiliate – Lead in 2.132 /
6.348.156 ден · Телешоп – Lead out 2.162 / 4.959.661 · Телешоп – Lead in 1.382 / 2.854.065 ·
Affiliate – Lead out 736 / 2.072.845 · Social 152 / 284.460. After `…1860` (29.09 ~12:00, the whole
cohort incl. MEX-only parcels and web): Affiliate – Lead out 842 / 2.393.446 ден, Телешоп – Lead
out 2.292 / 5.246.701 ден, total 7.696 / 19.297.997 ден — a rule of this kind moves the split, never
the total.

## 5. The tabs, briefly

- **Преглед** (also the admins' Табла). Header KPIs, the eight buckets, the six departments with their splits (e.g. the
  CRM department's `prediction_list` / `direct` split, MEX-only by profile / series), the spark, the leads
  funnel, cash flow, feed freshness (collabBox overlaid from `collabbox_feed_state()` by the api),
  and attention items (e.g. `approved_no_parcel_7d` — the 10-day no-parcel rule's candidates).
  Every number drills into `/orders` (§6).
- **Продажби.** Trend, departments, MEX account × series, products (through `product_key()` /
  `order_line_kind()` and the unreviewed-but-live `product_aliases`), cities, the weekday × hour
  grid ("timed" by the order's own `sale_source`, not its department).
- **Агенти.** People and teams on the cohort — sales credited to `orders.sold_by_person_id`
  (write-once `sold_*` stamps), by department; the work ledger `v_sales_work` (decisions,
  conversion = sale decisions / worked); time on the CRM (`agent_presence_days`); sales with no
  seller, by reason (Σ people + no seller = the cohort total); one person in depth.
- **Чиста добивка / Маржи.** Two clocks — **cohort** (the sales made in the period and what MEX
  collected on them) and **cash** (MEX money delivered in the period). Revenue − VAT (18%,
  confirmed 28.09) − COGS (known `cost_price`; uncosted estimated and labelled) − courier (150 ден
  per delivered parcel) − returns (0 per return, to confirm) − lead cost (a wired-but-zero slot) −
  commission (today's rule, a labelled cost line; payout math deferred). Windows over 62 days read
  closed months from `insights_profit_monthly` (**cache version 4** since `20260942001000`; nightly
  `insights-profit-monthly` at 03:40 Skopje; the owners' refresh button =
  `POST /api/insights/profit/refresh`). Details: `.grok/skills/elyon-logistics-costs`.
- **Прогнозни списоци.** The list sales of EVERY department (since `20260942001800`): Σ lists +
  "list not recorded" = the cohort's `prediction_list` split summed over the departments, so a list
  sale shipped on NATURA counts in its NATURA department and stays on the tab. The footer is the
  Affiliate – Lead out card; every `/orders` link selects by `sale_source=elyon_crm` +
  `sale_source_detail=prediction_list` (no `cohort_source`).
- **Производи и залихи / Враќања.** Units and value by product and department; returns on the sale
  clock or the MEX `returned` clock. Stock on hand is the placeholder 1000 until the owner's stock
  count, and the tab says so.
- **Активност на повици.** Decisions and call activity per person / team per day from
  `v_sales_work`; call timings are agent-reported while VOIP is off (Phase 2) — never proof that a
  call connected.

## 6. Drill-downs — the `/orders` twin

`GET /orders?cohort_bucket=<keys|total>&cohort_source=<keys>&sold_from=YYYY-MM-DD&sold_to=…` lists
exactly the ORDER part of a figure. The PostgREST predicates in
`supabase/functions/api/insightsCommon.ts` (`cohortOrdersFilter`, `cohortSourceOrFilter` /
`COHORT_SOURCE_TERM`, `cohortBucketOrFilter`, `cohortSaleWindowOrFilter`) are twins of the SQL
rules (a department term is `dept_override.in.(…)` OR `dept_override` NULL AND the mapping); what
they cannot see (a web claim, a ledger date, the test orders) comes from
`insights_cohort_order_exceptions()`. **Change the SQL and the TS twin together**;
`verify-insights-ties` D2 replays the TS filter as SQL and ties every order part to its `/orders`
count.

## 7. The checks (all read-only, pinned to Macedonia)

Run after any change to a rule, a migration bundle, a reclass or a repair. Exit 0 = no FAIL,
1 = FAIL, 2 = refused / unreachable.

| Script | Proves |
|---|---|
| `node scripts/verify-insights-ties.mjs --from … --to …` | T1 Σ buckets = total (count, денари, COD; orders / web / MEX-only) · T2 Σ departments = total · T3 splits · T4 leads partition · T5 previous period + spark · D1 an independent recount, one bucket per sale, no parcel owned twice · D2 every order part = its `/orders` drill count · D3 drill links · D4 test phones absent · D5 cash = the MEX register · D6 shared parcels valued once |
| `node scripts/verify-attribution.mjs [--from … --to …]` | C1–C14: Overview ties (C1–C3, C6), MEX-only cash by the series rule (C2), the Lists tab = Σ departments · prediction_list and its footer = the Affiliate – Lead out card (C3), the two legacy v1 leaderboard boards (`leaderboard_day`) vs the sales ledger (C4/C5), paid without MEX proof (C7), one parcel one order (C8a/b/c), AlterCPA never writes money (C9), no ghost parcels (C10), `sale_source` never NULL (C12), decisions have a person (C13), the web block = the shop's classifier (C14) |
| `node scripts/verify-tab-sales.mjs` · `-agents` · `-profit [--cache]` · `-lists` · `-returns [--year]` · `-work` | each tab = the cohort for the same window (S*, A*, P*, L*, R*, W*) |
| `node scripts/verify-leaderboard-v2.mjs [--from … --to …]` | the TV board v2: every person × department = a truth recomputed from orders + `v_sales_work` + the collabBox bookings; Σ board per department = `insights_cohort`; once only; rank; roster; filters (L1–L7) |
| `node scripts/verify-stock.mjs` | stock on hand vs its movements — meaningful once the owner's stock count exists |

**State 29.09 09:00** (September and July): engine fixture, `verify-insights-ties`, every
`verify-tab-*` and `verify-leaderboard-v2` PASS. `verify-attribution` shows only the known
leftovers: C7 (September 37; July 655 = the 11.08 "cancel(other) before August = paid" ruling,
report only) and C8b (September 14, July 1) — AlterCPA rows older than the 28.09 repairs, listed
for a human and for the owner. `verify-tab-lists` L8 flickers only while the lists are being
recomputed (02:00 Skopje). Re-run after `…1800` (`40f1425`, 11:44): `verify-tab-lists` L1–L8 and
`verify-leaderboard-v2` 22–29.09 PASS, once L4 / L7 and the board's own truth read `dept_override` —
before the `…1850` / `…1860` reversal.

## 8. Rules that bite

- **Skopje days.** A naked `YYYY-MM-DD::timestamptz` is UTC midnight = 02:00 Skopje. Every window
  comes from `insightsCommon.ts insightsWindows` (the previous period is the same length, cut at the
  elapsed time when `to` is today).
- **Money keys are suffixed** (`*_mkd`, `*_eur`) — the non-owner strip works by key.
- **THE department is the 4-argument `cohort_order_source`.** A new report that calls the 3-argument
  form silently loses the MEX-profile rule for CRM sales.
- **Keep `AppLayout`'s frame and `<main>` `position: relative`** (`81f4182`): the tabs carry
  absolutely positioned sr-only captions and table twins; without a containing block inside the
  `h-screen` frame they stretch the page and the window scrolls into an empty grey area below the
  content (seen on Агенти / Продажби, 29.09).
- **A department reclass does not move `orders.updated_at`**, so the profit cache cannot see it:
  refresh the cache by hand after `reclass-by-folder.mjs` / `reclass-department-sources.mjs`.
- **The 10-day no-parcel rule** (21:10 Skopje, APPLY mode) touches AlterCPA approvals only
  (`sale_source altercpa | affiliate`, minus `team_prediction`) — in `apply_no_parcel_rule`, the
  Overview's `anp` and `overview.ts attentionFilter`. Keep the three twins equal.
- **Performance:** the cohort functions run with `jit = off`; a year window of Pure Profit reads the
  monthly cache (≈1,5 s instead of ≈5 s live).
- The old `management-insights`, `insights_orders_rollup`, `insights_paid_basis`,
  `insights_channel_pl` still feed the Payout tab and `scripts/verify-insights-parity.mjs`
  (engine switch: the `INSIGHTS_ENGINE` secret). Do not change them to "fix" a new tab.
