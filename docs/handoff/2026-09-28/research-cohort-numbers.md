The owner is right: the current tiles can't add up. They count different things on three different clocks. The fix is to make the week's confirmed sales the base, put each sale in exactly one state, and show leads and MEX cash as separate figures. For 22–28.09 that base is **1.343 sales, 3.239.584 ден, of which 723 are paid (1.685.032 ден)**. Everything below comes from read-only SQL on MK, run at 28.09 01:40 Skopje. Nothing in the repo was edited.

## 1. How today's 7 tiles are computed, and why they don't add up
All tiles come from `kpj` in `supabase/migrations/20260936000000_insights_overview.sql:750-772`. Calling the RPC for the week reproduces them exactly (placed now reads 2.772 · 39.980,32 €).

| Tile | Clock | What it actually counts (22–28.09) |
|---|---|---|
| **Наплатено 3.062.765 · 1.302** (hero, `KpiRow.tsx:53`) | Cash: MEX delivered_at in the window (:341-345, :479-483); MEX-only parcels (:385-404) | Every MEX parcel of **both accounts** delivered in the week, from a sale on **any** date. CRM-linked 418 / 1.169.020 + MEX-only 884 / 1.893.745 (teleshop 633 / 1.370.990, web 129 / 238.070, Elyon series 9110/9103 not linked 71 / 209.025, social 37 / 67.450, other 14 / 8.210). **1.390.333 of it is from sales made before 22.09.** |
| **Направени 2.458.790 · 2.772** (screenshot 2.454.319 · 2.769) | Placed: created_at (:453) + web placed | These are **not sales**. It holds 1.638 ElyonCRM "no" call rows at 0 ден, 831 AlterCPA leads (407 cancelled/trashed = 766.647 ден, 116 still open = 175.857 ден), 142 ElyonCRM sales and 161 web orders (333.108, of which 48 unconfirmed = 103.511 and 23 cancelled = 28.400). Teleshop is **absent** because collabBox has not been imported since 18.09, yet its cash is in the hero. |
| **Потврдени 464 · 1.208.050** | Sold: `coalesce(sold_at, confirmed_at, created_at)` (:340, :459) | CRM only. 426 have a sale stamp (AlterCPA 284 = 206 confirmed + 43 shipped + 34 paid + 1 returned; ElyonCRM 142). 38 AlterCPA orders have no stamp and are dated by created_at. It leaves out web (90), MEX-only (746) and 43 AlterCPA "cancelled" orders that MEX shows as shipped. |
| **Кај курирот 93 · 281.229** | Placed | Created this week and CRM status is `shipped` now (82), plus 11 web orders at the courier. It ignores MEX status, so it misses the 43 cancelled-but-shipped orders and counts parcels that only have a label. Value is price. |
| **Се очекува 1.048.050 · 375** | Placed | The count is CRM confirmed+shipped (331) + web preparing/courier (44). The **value** uses a different set: `web_order_money='to_collect'` (`20260937000000_web_orders.sql:91-104`), which includes the 48 unconfirmed web orders (103.511) and leaves out paid ones (`wk_b` :743 vs :746). Count and value of this one tile describe different orders. |
| **Изгубено 28.400 · 23** | Placed | **100% of it is web orders cancelled before they shipped** (`wk_b` :747 counts web returned + cancelled). The CRM part is 0. It is not "lost after confirmation". |
| **Непотврдени платени 0** | Cash | Orders marked paid, with paid_at in the window and no MEX delivery. Correct. |

## 2. Recommended definitions (SQL predicates)
**CRM sale (a):**
- A row counts as a sale when all of these hold:
  - `source_type IS DISTINCT FROM 'monadon_legacy'`
  - `coalesce(sale_source_detail,'')<>'disposition'`
  - `price>0 AND NOT is_synthetic_product_name(product_name)`
  - and at least one of `sold_at IS NOT NULL`, `status IN (confirmed,shipped,delivered,paid,returned)` or `mex_tracking_id IS NOT NULL`.
- **Sale time:** `coalesce(sold_at, altercpa_leads.decided_at WHEN decision IN ('approved','cancel_other'), confirmed_at, created_at)`.
- **Parcel:** `mex_parcels.tracking_id = orders.mex_tracking_id`, excluding parcels that a web order claims.

**Web sale (b):**
- `deleted_in_shop_at IS NULL`, `web_order_outcome(...) NOT IN ('card_unpaid','awaiting')`, and not `cancelled` unless a parcel exists.
- Sale time is created_at; value is `total`.

**MEX-only (c):**
- `p.order_id IS NULL`, no `web_orders.mex_tracking_id` claim, no `orders.mex_tracking_id` claim, and `cod_mkd>0` (recommended).
- Sale time is created_at_mex; value is COD.
- Channel: natura 9100/9102 = teleshop · 9108 = social · 9110 = LEADS · 9103 = LEADS-OUT.

**Buckets (MEX status decides first; first match wins, every sale lands in exactly one):**

| # | Bucket | Predicate |
|---|---|---|
| 1 | Paid (MEX) | parcel status 2 |
| 2 | Paid, no MEX proof | status paid/delivered (web: DELIVERED/DONE) with no delivered parcel; should be 0, shown red |
| 3 | Returned | parcel status 7, or status returned |
| 4 | At courier, problem | parcel status 3, 9 or 13 |
| 5 | Label printed, waiting pickup ("packed") | parcel status 8 |
| 6 | At courier, moving | parcel status 1, 4 or 10, or status shipped |
| 7 | In warehouse, to pack | status confirmed, no parcel (web: CONFIRMED/PROCESSING, no parcel) |
| 8 | Cancelled after sale | cancelled/trashed, no parcel |
| 9 | Other | anything else; 0 in every window checked |

**Value:** parcel COD when a parcel exists, else price × 61,5 (web: total). With this, Paid equals money actually collected, and the buckets sum exactly to the total.

## 3. Computed tables
Unified cohort, value "at the door" (ден):

| Bucket | 22–28.09 (partial) | 15–21.09 | 01–27.09 |
|---|---|---|---|
| Paid (MEX) | 723 · 1.685.032 | 1.224 · 3.015.924 | 5.512 · 13.435.231 |
| Paid, no MEX proof | 0 | 6 · 12.220 | 44 · 103.420 |
| At courier, moving | 113 · 287.430 | 25 · 64.430 | 142 · 362.200 |
| At courier, problem | 121 · 301.160 | 35 · 104.529 | 166 · 433.669 |
| Label printed, waiting pickup | 105 · 281.605 | 91 · 242.495 | 248 · 649.780 |
| Warehouse, to pack | 267 · 648.757 | 109 · 254.520 | 404 · 980.907 |
| Returned | 14 · 35.600 | 151 · 426.380 | 729 · 1.965.559 |
| Cancelled after sale | 0 | 60 · 113.410 | 421 · 728.490 |
| **Total (sums exactly)** | **1.343 · 3.239.584** | **1.701 · 4.233.908** | **7.666 · 18.659.256** |

- **MEX COD actually collected, week:** 1.672.432 (CRM 355.510, web 85.107, MEX-only 1.231.815). Plus 12.600 ден of web orders paid by card, which have COD 0 at MEX.
- **Price basis instead of COD:** week total 3.169.758.

Week by channel (count · value at the door; paid; warehouse):

| Channel | Sales · ден | Paid | Warehouse |
|---|---|---|---|
| Teleshop 9100/9102 (MEX-only) | 639 · 1.397.880 | 484 | – |
| AlterCPA | 365 · 991.320 | 70 | 207 |
| ElyonCRM | 142 · 390.802 | 51 | 53 |
| Web | 90 · 201.197 | 46 | 7 |
| LEADS-OUT 9103 (MEX-only) | 38 · 101.225 | – | – |
| LEADS 9110 (MEX-only) | 32 · 95.560 | – | – |
| Social 9108 (MEX-only) | 31 · 61.600 | – | – |
| Other, COD 0 | 6 · 0 | – | – |

With the `cod>0` rule, the other 6 drop out and the week total becomes 1.337.

**(a) CRM by source, price basis** (n · € · ден; delivered COD):
- **Week:**
  - AlterCPA 365 · 14.983,93 € · 921.512 ден (paid 70, COD 223.210)
  - ElyonCRM 142 · 6.354,49 € · 390.801 ден (paid 51, COD 132.300)
  - collabBox 0
- **15–21.09:** AlterCPA 497 · 1.341.530 ден · ElyonCRM 229 · 657.809 ден · collabBox 503 · 1.092.046 ден.
- **Month:** AlterCPA 2.497 · 6.608.358 ден · collabBox 2.604 · 5.651.701 ден · ElyonCRM 688 · 1.932.941 ден.
- Web, affiliate and legacy have 0 CRM rows.
- **Rows that don't fit:** none. There are 0 pending/take/call_again/duplicated orders with a sale stamp. Trashed after sale is 1 in the month (counted as cancelled after sale).
- **Excluded as not real sales:**
  - Month: 2 AlterCPA + 40 collabBox price-0 rows, and 12 "No prior product on file" rows.
  - Week: 1.638 "no" call rows and 5 price-0 / "No prior product" rows.

**(b) Web, week:** 195 orders created.
- 90 sales: 46 paid (COD 85.107), 11 at courier, 26 label printed, 7 to pack.
- Not sales: 48 still awaiting shop confirmation, 23 cancelled before shipping, 34 failed card payments.
- 15–21.09: 144 sales. Month: 365 sales.

**(c) MEX-only parcels (created at MEX):**
- **Week:** 746 · 1.656.265 ден.
  - Teleshop 639: delivered 484 / 1.071.880, moving 61, problem 63, label 20, returned 11.
  - Social 31, LEADS 9110 32, LEADS-OUT 9103 38.
- **15–21.09:** 328 · 746.868. **Month:** 1.512 · 3.417.126.
- They fit the cohort as their own channel rows. A parcel is counted in (c) only if no CRM order and no web order claims it, so collabBox rows (whose DocNumber is the MEX tracking id) and web orders can't be counted twice.
- When collabBox is imported, those parcels move from MEX-only to the collabBox channel. They are not added a second time.

**(d) Is sold_at reliable?**
- **ElyonCRM:** 142 of 142 have it; the trigger stamps them live (`20260935000100_sales_people_teams.sql:418-482`).
- **collabBox:** all real rows have it.
- **AlterCPA, week:** 38 of 308 confirmed/shipped/paid orders created in the week have sold_at NULL (36 paid, 1 shipped, 1 confirmed). On top of that, 43 AlterCPA "cancelled" orders have a parcel moving at MEX.
- **AlterCPA, month:** 793 of 1.975 have sold_at NULL (656 paid, 135 returned). These are leads AlterCPA's panel marks cancelled but that shipped on our 9110 series, so there is nobody to credit.
- **Why:** AlterCPA approvals are only stamped by `scripts/backfill-order-deciders.mjs`, which nothing schedules (`20260939000000_leaderboard_day.sql:67-76`). The sync never writes confirmed_at (`altercpa-sync/altercpa.ts:208`).
- The backfill was run recently: 284 of the week's 285 ledger approvals that have a CRM order carry sold_at = decided_at.
- **"Потврдени 464"** = 426 stamped sales + 38 unstamped orders dated by created_at.

## 4. Proposed layout for the owner (real values, 22–28.09)
- **Продажби (потврдени) 22–28.09: 1.343 · 3.239.584 ден** (15–21.09: 1.701 · 4.233.908)
  - One stacked bar that adds up: Платено 723 · 1.685.032 · Кај курирот 234 · 588.590 (од тоа проблем 121) · Спакувано, чека курир 105 · 281.605 · Во магацин за пакување 267 · 648.757 · Вратено 14 · 35.600 · Откажано по потврда 0.
  - Under the bar, one line per channel, as in the table above.
- **Small separate figure, "Дојдоа" (leads this week):**
  - AlterCPA: 1.014 MK leads in their panel, 831 reached the CRM. 351 became sales (42%), 364 dead, 116 still open. 42 approvals never reached the CRM.
  - ElyonCRM: 1.780 calls recorded → 142 sales (8,0%).
  - Web: 161 orders → 90 confirmed, 48 waiting for the shop, 23 cancelled.
- **Separate cash figure:** "Пари од MEX оваа недела (продажби од кој било ден): 1.302 пратки · 3.062.765 ден — 1.672.432 од продажбите од оваа недела + 1.390.333 од претходни недели."

## 5. Where a sale can be counted twice or dropped
1. **Counted twice:** 6 web-shop parcels (NTMK…) are linked to old AlterCPA orders, e.g. ORD-98929 ↔ NTMK62289 and ORD-95297 ↔ NTMK62345. They count as a CRM sale and as a web sale. Fix: web claims win.
2. **Probably counted twice:** MEX-only parcels on the phone of a CRM sale that has no parcel yet (likely the same sale, not linked). Week 7 / 24.400 ден, month 15 / 49.900.
3. **Structural, not in September:** 3 tracking ids are claimed by two CRM orders each, and 5 parcels have order_id NULL but an order claims them. The current MEX-only filter (:401) only checks `p.order_id`, so these would be counted twice.
4. **Dropped:** MK approvals that never became CRM orders (skip_reason not_pending). Week: 30 approvals + 12 cancel_other (≈ €1.875, 42 total). They stay invisible until they ship.
5. **Dropped:** parcels held by price-0 / "No prior product on file" rows. Week 5 / 7.625 ден, month 59 / 48.665. Neither (a) nor (c) counts them.
6. **Wrong state today:** 43 AlterCPA orders this week (98 in the month) are "cancelled" in the CRM but at the courier per MEX. The MEX-first bucket rule fixes this.
7. **Owner decision:** 160 cancel_other rows in the month are stamped as sales but cancelled with no parcel. They are in "cancelled after sale". He needs to say whether they count as sales at all.
8. **Mixed values:** COD vs price differs by about 70k ден this week (AlterCPA upsells and the +150 delivery fee). Card-paid web orders never appear in MEX cash.
9. **Packed is never recorded:** packed_at is 0 on every order since 01.08, so "packed" can only come from MEX status 8. Some labels look dead: 91 sales from 15–21.09 still have only a label.
10. **Warehouse ageing:** 109 sales from 15–21.09 are still unpacked with no parcel after more than 7 days.
11. **collabBox stale:** the newest document is 18.09 (this is the "застарено" warning). Since then teleshop and social exist only at MEX: 670 parcels / 1.459.480 ден this week.
12. **Partial and timing:**
    - 28.09 has only 1 sale so far; the day had just started.
    - MEX created no labels from 26.09 onward (weekend; newest 25.09), so the 174 sales from 25–27.09 are all "to pack".

The SQL is saved in `C:\Users\Mile\AppData\Local\Temp\claude\d--Dev-archives-elyon-natura\ba6c6515-0d2a-4518-b77a-a3e01748e84d\scratchpad\cohort\`:
- `base.sql`, `u.sql`, `u3base.sql`
- `a6.sql`, `a7.sql`, `b2.sql`, `c_mex.sql`, `c_dup.sql`, `cash.sql`, `d1.sql`