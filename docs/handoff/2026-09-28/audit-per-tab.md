# Per-tab audit (28.09.2026, read-only) — issues and upgrade proposals

## sales — Продажби (Sales) — /insights?tab=sales, component Sales() in src/pages/ManagementInsightsPage.tsx:230-256; Page-level date bar + note line shared by all money tabs (ManagementInsightsPage.tsx:148-173, src/components/DateRangePicker.tsx)

**Live engine:** INSIGHTS_ENGINE = sql. Checked by comparing the Supabase secrets digest against sha256('sql'). No secret value was printed. AGENT_PERF_ENGINE and PAYOUT_SUMMARY_ENGINE are also sql.

The Sales tab therefore reads the SQL twins `insights_orders_rollup` (by_city, by_delivery, by_source) and `insights_products` (by_product). The live function bodies match migrations 20260928000100 (the MEX-aware rollup) and 20260911000000 (products): the live rollup contains 'mex_office'.

The legacy TS loop (index.ts:17151-17230) uses the same predicates: SOLD = confirmed/shipped/delivered/paid, created_at, raw 

### Issues
- [critical] **The Sales total is created-day and status-based, not the owner's cohort, and it disagrees with the Overview** — insights_orders_rollup: is_sold = status IN (confirmed,shipped,delivered,paid), filtered on created_at (migration 20260928000100:36-37, 58, 114-118). For 01.09-27.09 the Sales tab shows 4.728 / 11.648.755 ден, while the live insights_overview confirmed = 5.734 / 13.938.945 ден (ov1.sql, coh1.sql). Returned (586 / 1.546.327, 585 MEX-proven) and cancelled-after-confirm (412) simply vanish. There is no paid / at courier / to pack split, so a confirmed-but-never-shipped sale weighs the same as cash.
  - Fix: Rebuild Sales on the cohort. Base = sales with sale_at = coalesce(sold_at, confirmed_at, created_at) in the Skopje window, excluding disposition. Each sale sits in exactly one bucket: paid (MEX-proven, unproven flagged) · at courier · packed · to pack · returned · cancelled after confirm. The buckets sum to the total. Use the same predicates as insights_overview (is_sale, sale_at, bucket CASE at migration 20260936000000:340-371), ideally from one shared SQL source so the two tabs cannot drift.
- [critical] **Two of the four selling sources are missing: web shop and MEX-only (teleshop after 18.09)** — The rollup reads public.orders only. Missing for Sept: web_orders 444 / 911.707 ден (284 MEX-delivered, 484.593 COD), and 1.512 MEX-only parcels / 3.417.126 ден COD (1.160 delivered / 2.556.958). collabBox orders stop at 18.09 07:00 UTC; in the week of 21.09, 882 of 944 teleshop/social parcels have no order. So the 'Import' number silently freezes.
  - Fix: Add the web block (insights_web_block or web_orders + web_order_outcome; sale day = created, sales = preparing/courier/delivered/returned/no_record) and the MEX-only block (mex_parcels with order_id NULL, not NTMK, not claimed by web_orders.mex_tracking_id; day = created_at_mex; bucket from status_id: 2 paid, 7/13 returned, else at courier; value = cod_mkd). Show both under the four sources, with a 'last collabBox import dd.mm.yyyy' freshness line.
- [critical] **Unproven money counted as sales revenue** — fp1.sql, Sept created-set: 40 AlterCPA orders with status paid and no MEX parcel at all (mex_tracking_id NULL), plus 278 AlterCPA 'confirmed' with no parcel (623.603 ден, part of the 522 the 7-day rule would cancel). All are summed into Приход. Revenue = orders.price x 61.5, not MEX COD (AlterCPA paid: price 3.874.956 vs COD 3.974.504).
  - Fix: Paid = mex_delivered_at present (COD from mex_cod_mkd via formatDenari). Show paid-without-parcel as a separate flagged 'unproven' line (43 / 101.670 ден in the cohort), never inside paid. Confirmed without a parcel belongs in 'to pack', with an age badge that ties to the no_parcel_7d rule.
- [critical] **Cities duplicated Latin vs Cyrillic (Skopje / Скопје, Bitola / Битола ...)** — insights_orders_rollup groups the raw coalesce(customer_city, courier_office_city). Sept: Skopje 1.183 / 3.340.880 and Скопје 903 / 2.020.186 appear as two rows (the screenshot shows 3.899.214 and 2.020.186). 137 raw strings; a fold via mk_settlements.name_lc/name_norm gives 104, and Скопје = 2.091 / 5.377.067. mex_city_id covers only 48% and splits Skopje into MEX zones. Web and MEX-only cities mix both scripts too.
  - Fix: Add an SQL twin mk_geo_norm(text) of normalizeMkGeo (scripts/lib/mk-translit.mjs: lowercase -> MK Cyrillic->Latin table -> strip diacritics -> digraphs dzh/zh/sh/ch/dz/dj/gj/kj/lj/nj/ts -> [^a-z0-9] removed). Add mk_city_key(text) that joins mk_settlements.name_norm (prefer kind='city'; 'Skopje - *' MEX zones -> Скопје) and returns id, name (mk) and name_lat (en/sq). Extend the transliterate.test.ts parity corpus to cover the SQL twin. Fold all three sources with it.
- [major] **Product chart shows EUR on the axis (0-18.000, no unit) while the tooltip shows denars** — ManagementInsightsPage.tsx:239 <XAxis type="number"> is fed raw EUR data.sales.by_product.revenue; the top product = 16.227 EUR (prod1.sql). Tooltip :241 formats with formatMoney (x61.5). The same bar reads 16.227 on the axis and 997.954 ден in the tooltip. This breaks the no-EUR-on-screen rule.
  - Fix: Convert to denars before charting (or use a tickFormatter with eurToDen and a short 'ден' / 'илј. ден' unit). Better: replace the chart with a table (units, sales, value ден, paid %, return %), because the long product names are truncated at width 130 anyway.
- [major] **'По извор' uses legacy source_type codes, not the owner's four sources** — by_source groups coalesce(source_type,'manual') (migration 20260928000100:117); UI cap() prints 'Altercpa' / 'Import' / 'Manual'. 'Import' is the collabBox teleshop/social/leads series, and 'Manual' is ElyonCRM (prediction_list / direct / disposition). orders.sale_source + sale_source_detail exist and are filled (20260935000000) but are not used. The hardcoded English footnote (ManagementInsightsPage.tsx:253) is a BG leftover and is false here.
  - Fix: Group by the Overview source key (altercpa+affiliate · elyon_crm · web · teleshop_other) with i18n labels, and splits: AlterCPA new/returning; ElyonCRM prediction_list/direct; Teleshop teleshop/social/leads/leads_out/MEX-only; Web shop/MEX-only. Delete the footnote.
- [major] **Zero-price and disposition rows counted as sales orders and units** — fp1.sql / syn1.sql, Sept: 6 elyon_crm/disposition rows in sold statuses (5 paid with 9.640 ден real COD, 3 of them 'No prior product on file' mex-reconcile ghosts), 36 collabBox 0-price replacement shipments ('+ ЗАБЕЛЕШКА ќе врати ...'), and 2 AlterCPA 0-price paid rows. They inflate order counts and product units; their real COD is not counted.
  - Fix: Exclude sale_source_detail='disposition' and price<=0 rows from sales (is_sale already excludes disposition in insights_overview). Show them in a data-quality footer with a drill link: 'replacements / 0 ден' count, and ghost rows with COD.
- [major] **Product names not folded: collabBox lines have no product_id** — prod3.sql: collabBox has 6.523 lines with 0 product_id and 302 distinct names, including free-text notes and bundles ('2 ПРОСТАТОЛ + 2 ДИАБЕТОЛ'). 'Neurofix' (AlterCPA/CRM) vs 'NEUROFIX BIONATURAL 30/1' (collabBox); 'Простатол Комплекс' vs 'ПРОСТАТОЛ КОМПЛЕКС cps 30'; 'MAGNESIUM CITRAT 325mg' vs '... 150/1 tab'. A single product is split into several bars.
  - Fix: Add a product_aliases table (alias_norm -> product_id), seeded from the 302 collabBox names plus web_order_items names for owner review. Add product_key(product_id, name) that strips the ' + ЗАБЕЛЕШКА…' tail. Group by product_id; unmapped names roll into one visible 'Немапирани' row with a count.
- [major] **'По начин на испорака' carries no information in MK** — del1.sql: since 01.06 every order has delivery_type 'home' (31.718 with home_courier NULL, 970 mex, 2 econt). The card always shows one row, 'Home' (the English cap()). Office types are BG leftovers (econt/speedy).
  - Fix: Replace it with 'По MEX сметка / серија' (bio_natural vs natura; 9110 leads, 9103 leads_out, 9102/9100 teleshop, 9108 social, NTMK web), showing sales, paid COD and return rate. Or drop it.
- [major] **The note under the date bar is false for Sales (and Pure Profit)** — insights.workClockFromAugust says work numbers from Aug follow the confirm/cancel day and cash follows the paid day. Every RPC of GET /management-insights filters orders.created_at (insights_orders_rollup/products/paid_basis), and index.ts has no sold_at/decided_at reference. Commit 9a27cc7 itself says 'rollups stay on created_at'.
  - Fix: Remove the shared note. Each tab states its own basis in one mk/en/sq/bg line, for example Sales: 'Основа: продажби потврдени во периодот (ден на потврда, Скопје). Наплата = MEX.' Plus a separate label for the cash-by-delivery-day figure.
- [major] **Date presets disagree with the Overview, and dates render mm/dd/yyyy** — DateRangePicker.tsx:23 '1 месец' = subMonths(today,1) = 28.08-28.09 = 32 days. Overview FilterBar 'Месец' = rolling 30 days (overview/model.ts:53). The same 'month' therefore yields different totals on two tabs. Native <input type=date> (DateRangePicker.tsx:119-125, and FilterBar.tsx:85-90) renders the browser locale (08/28/2026). today() uses the browser clock, not Europe/Skopje (the Overview uses skopjeToday()).
  - Fix: One shared Skopje filter model: reuse overview/model.ts presetRange and skopjeToday. Add calendar-month presets the owner uses ('Овој месец', 'Претходен месец'). Replace the native inputs with a Popover + Calendar (src/components/ui/calendar.tsx, popover.tsx) displaying format(d,'dd.MM.yyyy') with the date-fns mk locale. DateRangePicker is also used by the Dashboard, so add a new component or a prop rather than changing its default behaviour.
- [major] **Order counts and the 'Others' row are never shown** — ListCard (ManagementInsightsPage.tsx:821-853) renders only cols[cols.length-1] (revenue), so the declared 'Нарачки' column is invisible (the screenshot shows only ден). topN returns 20 + 'Others' but ListCard slices rows.slice(0,20), so 'Others' is cut: 117 of 137 cities are silently hidden and the list never sums to the total.
  - Fix: Use real table rows with count, value, paid % and return %, a searchable full list, an always-visible 'Останати' row and a total row.
- [minor] **Hardcoded English and raw codes** — 'Top products by revenue' (ManagementInsightsPage.tsx:234); footnote (:253); Recharts series name 'revenue' (:242); backend labels 'Others' (index.ts:16910), 'Unknown' (city), '(unknown)' (product); cap() names 'Altercpa' / 'Import' / 'Manual' / 'Home'.
  - Fix: i18n keys in mk/en/sq/bg for titles, source/bucket labels, 'Останати' and 'Непознат'. The backend returns codes, not display strings.
- [minor] **Inconsistent number formatting** — Counts use v.toLocaleString() (ManagementInsightsPage.tsx:843; browser locale gives 1,183) while money uses formatMoney's '.' grouping (1.183).
  - Fix: Use one mk-style count formatter (as useOverviewFormat does) for every count.
- [minor] **End-of-range bound differs from the Overview by 1 second** — index.ts:1496 skopjeRangeEnd = next Skopje midnight minus 1000 ms (23:59:59.000). overview.ts skopjeDayEndIso = 23:59:59.999999. Rows in the last second of the window are dropped on the money tabs only.
  - Fix: Use overview.ts skopjeMidnightIso/skopjeDayEndIso in the new Sales endpoint (and eventually in management-insights).
- [minor] **No headline, no period label, heavy payload for four lists** — Sales() renders four cards with no total, no count and no period. It depends on the full management-insights aggregate (4 RPCs + channel P&L + profiles + products + calls) just to draw data.sales.
  - Fix: Give the tab its own endpoint (below) and a cohort header. Keep the management-insights sales block untouched until both engines drop it together (the verify-insights-parity.mjs walk() diffs the whole payload).
- [minor] **Admins/managers get nothing** — The tab is need:'business' (owners only, ManagementInsightsPage.tsx:52); money must stay owners-only (rule 5), but counts are operational.
  - Fix: Optional: the new endpoint returns a counts-only payload for admin/manager via the stripOverviewMoney pattern (overview.ts:213). The tab then shows buckets and counts without ден.

### Upgrade proposal
The audit changed no repo file and ran no deploy. The only files written are the SQL scratch files in scratchpad\audit\sales\.

## Upgraded 'Продажби' tab — one cohort, four sources, MEX decides money

### Definitions
These are the same as the Overview's (insights_overview 20260936000000:340-371), so the totals tie by construction.
- **A sale** is any of:
  - an order with is_sale (not disposition, not price ≤ 0, sold_at set or status confirmed/shipped/delivered/paid/returned);
  - a web order with shop outcome preparing, courier, delivered, returned or no_record (card_unpaid and awaiting excluded);
  - an unlinked MEX parcel (order_id NULL, not NTMK, not claimed by web_orders.mex_tracking_id).
- **Sale day**, on the Skopje calendar:
  - orders: coalesce(sold_at, confirmed_at, created_at);
  - web: created_at;
  - MEX-only: created_at_mex.
- **Buckets** (every sale in exactly one; they sum to the total):
  - Наплатено = paid/delivered with mex_delivered_at, or web delivered, or parcel status 2. Paid without a parcel is shown as a separate flagged "Неподкрепено" line.
  - Кај курир = shipped, or parcel status 1/3/4/8/9/10.
  - Спакувано, чека курир = confirmed with packed_at.
  - Во магацин за пакување = confirmed without packed_at, with an age badge (> 7 days feeds no_parcel_7d).
  - Вратено = returned, or parcel 7/13.
  - Откажано по потврда = cancelled/trashed with sold_at.
- **Money:**
  - Value: price → formatMoney. Web and MEX-only are already in denars → formatDenari.
  - Paid: MEX COD (mex_cod_mkd / cod_mkd → formatDenari).
  - Cash by MEX delivery day: a separate labelled tile. It reuses kpis.delivered.proven_cod_mkd.
- **Live Sept baseline this would show:**
  - Orders cohort: 5.734 / 13.938.945 ден (paid 4.109 proven = 10.296.849 COD + 43 unproven; courier 186; to pack 398; returned 586; cancelled after confirm 412).
  - Plus web 444 placed / 911.707 ден (364 sales once awaiting and cancelled are removed).
  - Plus MEX-only 1.512 / 3.417.126 ден.
  - The tab today shows 11.648.755.

### Widgets, top to bottom
1. **Filter row.**
   - It shares the Overview model (overview/model.ts: skopjeToday, presetRange).
   - Presets: Денес · 7 дена · Овој месец · Претходен месец · 30 дена · Година · Прилагодено.
   - The custom range is a Popover + Calendar with dd.mm.yyyy (date-fns mk locale). Source chips.
   - One per-tab basis line replaces workClockFromAugust.
2. **Cohort header.**
   - Вкупно продажби N / value.
   - One segmented bar with the 6 buckets. Each segment shows count, value and share, and drills to /orders?sold_from&sold_to&outcome=…
   - A separately labelled tile: "Готовина по ден на испорака (MEX)".
3. **Four source rows.** AlterCPA · ElyonCRM · Веб продавница · Телешоп/Друго, each with:
   - the same bucket bar;
   - sales, value, paid COD, return %, AOV;
   - expandable splits: new/returning; prediction_list/direct; teleshop/social/leads/leads_out/MEX-only; shop/MEX-only.
   - Rows can reuse the Overview's SourceRows/OutcomeBar components.
4. **Daily trend.**
   - Stacked bars of sale value by source (SOLD clock) plus a thin line of MEX cash by delivered day.
   - The two series are labelled separately. The axis is in ден.
5. **Products table.**
   - Folded by product_id plus aliases.
   - Columns: units, sales, value ден, paid %, return %, and a per-source mini split.
   - An 'Немапирани' row for unmapped names.
6. **Cities table.**
   - Folded with mk_geo_norm → mk_settlements: Cyrillic names in mk/bg, Latin in en/sq. All four sources.
   - Columns: sales, value, paid, return %.
   - Search, an always-visible 'Останати' row and a total row.
7. **MEX account / series table.** Replaces the delivery card: bio_natural vs natura × 9110/9103/9102/9100/9108/NTMK, with sales, COD and return %.
8. **Data-quality footer**, each item with a drill link:
   - unproven paid (43 / 101.670)
   - confirmed older than 7 days with no parcel
   - excluded 0 ден / replacement rows (42)
   - "No prior product on file" ghosts with COD
   - last collabBox import (18.09.2026, stale warning)
   - unmapped product names
   - unfolded city strings

### Backend
- **Migration `2026094xxxxxx_insights_sales.sql`:**
  - (a) `mk_geo_norm(text)`, IMMUTABLE: SQL twin of normalizeMkGeo.
  - (b) `mk_city_key(text)` → settlement id / name / name_lat. It prefers kind='city' and folds the 'Skopje - *' MEX zones to Скопје.
  - (c) The `product_aliases(alias_norm pk, product_id, reviewed_by, reviewed_at)` table plus `product_key(product_id, name)`. The seed is proposed from the 302 collabBox names; the owner reviews it.
  - (d) One shared cohort source, `sales_cohort_rows(p_from, p_to_end)`: orders ∪ web_orders ∪ unlinked mex_parcels → src, detail, sale_at, bucket, proven, value_eur, value_mkd, cod_mkd, product_key, city_key, mex_account, series, flags.
  - (e) `insights_sales(p_from, p_to_end, p_prev_from, p_prev_to_end)` → jsonb {cohort, sources[], trend, products[], cities[], mex_series[], quality}.
    - plpgsql with EXECUTE … USING; SECURITY DEFINER.
    - EXECUTE granted to service_role and supabase_read_only_user (for the harness).
  - Ideally insights_overview's 'confirmed' and cohort blocks read the same sales_cohort_rows. Coordinate with the Overview rebuild. Its pivot's city/product dimensions should also switch to mk_city_key/product_key.
- **API:**
  - Add `GET /api/insights/sales?from&to&compare=1` in a new `supabase/functions/api/sales.ts` (plus a test), routed from index.ts.
  - Use overview.ts skopjeMidnightIso/skopjeDayEndIso.
  - Owners get the full payload; admin/manager get a counts-only payload via the stripOverviewMoney pattern.
  - The management-insights `sales` block stays until both engines drop it together, so the parity gate is not disturbed.
- **Frontend:**
  - A new `src/components/insights/sales/SalesTab.tsx` with its own react-query and filter row.
  - ManagementInsightsPage renders it instead of Sales().
  - Remove the workClockFromAugust note.
  - New i18n keys `insights.sales.*` in all four locales.

### Guard
A script check (or a new case in scripts/verify-attribution.mjs) must assert all three:
- Σ buckets = total;
- Sales total == Overview confirmed for the same window;
- city fold leaves < 1% unmatched.

### Files the fix touches
- (audit edited NO repo file; the list below is the files the FIX would touch)
- D:\Dev\archives\elyon-natura\src\pages\ManagementInsightsPage.tsx (Sales() at :230-256, ListCard :821-853, the date bar and note :148-153)
- D:\Dev\archives\elyon-natura\src\components\insights\sales\SalesTab.tsx (new) + model/test files
- D:\Dev\archives\elyon-natura\src\components\DateRangePicker.tsx (shared with the Dashboard; prefer a new Skopje dd.mm.yyyy picker or an opt-in prop)
- D:\Dev\archives\elyon-natura\src\components\insights\overview\model.ts and FilterBar.tsx (if presets/skopjeToday are shared; the Overview agent owns these)
- D:\Dev\archives\elyon-natura\src\lib\api.ts (new apiGetInsightsSales + types; InsightsResponse.sales left as is)
- D:\Dev\archives\elyon-natura\src\i18n\locales\mk.json, en.json, sq.json, bg.json (insights.sales.*, remove/replace insights.workClockFromAugust)
- D:\Dev\archives\elyon-natura\supabase\functions\api\index.ts (new route insights/sales near :16999)
- D:\Dev\archives\elyon-natura\supabase\functions\api\sales.ts + sales.test.ts (new; reuse overview.ts helpers)
- D:\Dev\archives\elyon-natura\supabase\migrations\2026094xxxxxx_insights_sales.sql (new: mk_geo_norm, mk_city_key, product_aliases, product_key, sales_cohort_rows, insights_sales)
- D:\Dev\archives\elyon-natura\supabase\migrations\20260936000000_insights_overview.sql successor migration (optional: Overview/pivot read the shared cohort + folded city/product; Overview agent)
- D:\Dev\archives\elyon-natura\src\lib\transliterate.ts and transliterate.test.ts, scripts\lib\mk-translit.mjs (parity corpus for the SQL twin mk_geo_norm)
- D:\Dev\archives\elyon-natura\scripts\verify-attribution.mjs (new checks: Σ buckets = total, Sales == Overview confirmed, city fold coverage)

## agents — Агенти (Agents) — src/components/insights/AgentsTab.tsx, mounted at src/pages/ManagementInsightsPage.tsx:202-204

**Live engine:** AGENT_PERF_ENGINE=sql is live. I checked the function-secret digest against sha256('sql') without printing any value; INSIGHTS_ENGINE=sql and PAYOUT_SUMMARY_ENGINE=sql too. Live path: AgentsTab → apiGetAgentPerformance (src/lib/api.ts:1515) → GET /agent-performance (supabase/functions/api/index.ts:9750) → RPC public.agent_performance_rollup(text,text,text,text,boolean). The live body is byte-identical to supabase/migrations/20260924000000_agent_performance_rollup.sql. After the RPC, a TS fold runs (agentOwnerKey/agentIdentityKey, active-profile join, exact-name bonus gate, rounding), then the 

### Issues
- [critical] **The AlterCPA team is invisible: attribution uses confirmed_by/assigned id or name, which AlterCPA bridge orders do not carry** — The rollup groups by coalesce(confirmed_by_agent_id,assigned_agent_id) / coalesce(confirmed_by_name,assigned_agent_name) (migration 20260924000000:68-69). TS drops any group with no owner key (index.ts:9941-9944). September 01–27.09 (Skopje, SOLD clock) has 2.400 AlterCPA bridge sales; only 9 carry any id or name (audit/agents/b01_coverage.sql). In the tab's custom range 01.09–27.09, 1.692 paid AlterCPA orders worth €79.997,98 enter the rollup through the paid window and are then silently dropped (b04.sql, fold.mjs). All-time, 5.243 AlterCPA sales (€217.093) never reach the tab (c17.sql). Per person, tab vs truth (c15.sql): Aleksandra Hristoska shows 5 paid / €145,70 but has 221 sales and 53
  - Fix: Re-key the tab on orders.sold_by_person_id → sales_people. The team is the person's primary sales_team_members row on the Skopje sale day. Work comes from v_sales_work. Build it as a new RPC (see the proposal); do not patch agentOwnerKey. Leave /agent-performance untouched for the bonus columns only.
- [critical] **Money reaches non-owners (breaks rule 5)** — GET /agent-performance has no isBusinessOwner() gate (index.ts:9750-9772); the helper exists at index.ts:2935 and is used by the other money routes. The UI gates finance on canSeeFinance = user.isAdmin || user.isManager (AgentsTab.tsx:55); admin fans out to 8 roles and 9 logins. Платен приход and Просечна нарачка tiles and columns render for every viewer, including agents on the self view (AgentsTab.tsx:363,368,479,483). CSV export includes profit, gross and net for anyone who opens the tab (AgentsTab.tsx:36-49). The table is also sorted by EUR revenue (index.ts:10281), which leaks the money ranking.
  - Fix: Server: compute money only when isBusinessOwner(user.id). Otherwise strip every *_eur/*_mkd/revenue/profit key with the overview.ts stripOverviewMoney whitelist pattern and set meta.money=false. Client: gate on useInsightsAccess().business, not isAdmin/isManager. Sort non-owners by sales count. The CSV omits money unless meta.money. The agent self-view keeps counts, packages and the (untouched) bonus column; whether agents may see their own sold value is an owner decision.
- [critical] **Money is shown as bare catalogue EUR numbers, not MEX COD in denars** — fmt() (AgentsTab.tsx:34) prints v/1000+'k' or v.toFixed(2) with no currency. Every money tile and column uses it (lines 362-370, 456-483). The values are orders.price in EUR, not mex_cod_mkd. In the September custom range, the tab's paid revenue is €104.104,33 (6.402.416 ден at the peg) versus MEX COD 6.448.265 ден for the same 2.871 orders (c10.sql). The tab shows '104.1k' with no unit.
  - Fix: Sold value in EUR via formatMoney(eur) (peg 61,5, never recomputed). Cash is MEX COD in denars (orders.mex_cod_mkd where mex_delivered_at IS NOT NULL) via formatDenari, never ×61,5. Delete fmt(). The bonus column keeps its current rendering (out of scope) but should at least get a unit label when payouts are redone.
- [critical] **Conversion is 100% for everyone: 'leads' is the confirmed set** — By default leads = n_leads_nc (status NOT IN trashed,cancelled) (rollup:156, index.ts:10091), and no take/call_again row carries attribution (September: 118 open orders, 0 attributed; b03.sql). So leads = confirmed. Custom 01.09–27.09 gives leads 3.393 = confirmed 3.393 → 100,00% on all 51 active rows (fold.mjs). All-time: leads 43.000, confirmed 42.999. The 'Доделени лидови — Сите доделени нарачки' description is also false.
  - Fix: Use the Overview/leaderboard definition. Worked = v_sales_work decisions of the person in the window. Conversion = sale decisions / worked. September truth by team (c05.sql): Pending–AlterCPA 1.183 sales of 4.033 AlterCPA decisions (+ 521 CRM decisions on ElyonCRM orders); Prediction–ElyonCRM 659 of 6.476; Management 416 of 481.
- [critical] **'Откажани'/'Ѓубре' count 0-денар ElyonCRM call-outcome (disposition) rows; ghost 'paid' disposition rows count as sales** — In the custom September range, all 4.543 cancelled and 1.764 trashed come from sale_source_detail='disposition' (6.312 disposition rows; b04.sql). None is a sale that was cancelled. Nine disposition rows sit in sale statuses and are counted as paid (5), returned (3) and confirmed (1) with price 0, e.g. ORD-94110, ORD-92603, ORD-91484, ORD-107420, ORD-93612 (c08.sql). They inflate paid count, collection rate, packages and bonus, while their real MEX COD (1.640–3.000 ден each) sits on them. This matches the known mex-reconcile ghost-paid bug, whose fix is not decided.
  - Fix: Exclude sale_source_detail='disposition' from every sales, cohort and money figure, as insights_overview.is_sale does. Disposition appears only as 'worked/cancel/trash decisions' from v_sales_work. List ghost rows (disposition in a sale status with a MEX parcel) as an attention line with a drill-down. Do not change mex-reconcile (not decided).
- [critical] **Mixed clocks and UTC day bounds: wrong period membership and a lost last day** — The rollup merges created_at-in-range with paid_at-in-range and counts the paid-window rows as leads, confirmed and shipped too (rollup:73-89,156-159). In September, 53 attributed paid orders created before 01.09 are counted as September leads (c10.sql). Bounds are naked dates under SET TimeZone='UTC' (rollup:51-52,61), so 00:00 UTC = 02:00 Skopje. Presets use toISOString(). For Custom, p_to='YYYY-MM-DD' becomes 00:00 UTC of that day, so the whole last day is dropped: a range ending Friday 25.09 loses 355 attributed orders created that day and 23 paid (c12.sql). 'Месец' is rolling 30 days. This is the unswept Skopje-day bug from memory.
  - Fix: Use the page's shared DateRangePicker (dd.mm.yyyy) and send Skopje-inclusive instants (skopjeDayStart/End, as overviewWindows does). Cohort = sales whose SOLD instant (sold_at, else confirmed_at, else created_at, the Overview rule) is in the window, each in one current bucket. Cash by MEX delivery day is a separate figure.
- [major] **The same human appears twice (account row + 'historic operator' row)** — Name-folding misses collabBox Cyrillic spellings. In September 17 virtual rows render beside their accounts (fold.mjs): Adela Numanovikj 33 + Адела Нуманович 62, Aida Kajevikj 32 + Аида Кајевич 57, Tamara Radovikj 15 + Тамара Радович 53, Sonja Taseva 50 + Соња Т Тасева 108, Sanela Dzogovikj 8 + Sanela Dzogovich 4, Iva + Iva Kunoska. All-time there are 41 virtual rows out of 78.
  - Fix: Resolve through sales_person_identities, not agentIdentityKey. The missing collabbox_author handles (Адела Нуманович, Аида Кајевич, Тамара Радович, Соња Т Тасева, Милјана Тодоровска н., Верица Костова) go to the owner via Settings → Teams → unmapped queue (sales_person_add_identity back-stamps orders). Memory marks several of these pairs as needing a human call.
- [major] **Teleshop/Other sales: most have no person, and no team exists for them** — September collabBox (teleshop 2.497 + social 147): 1.394 sales / €46.281,64 have no sold_by_person_id (c02.sql). Unmapped authors (c09.sql): Александра Чима 334, Марија Темелкова 234, Милјана Тодоровска н. 121, Ангела Ристеска 119, Соња Т Тасева 106, Валентина Богдановска н. 102, Татјана Кипровска 82, Адела Нуманович 61, Ангела Филиповска 60, Аида Кајевич 55, Тамара Радович 51 … Another 379 have a person but no team (Sofija Kuculovska 51, Marina Filipovska 30, Milijana Todorovska …). sales_teams only has crm_prediction / altercpa_leads / management. There are also 40 zero-price collabBox rows in sale statuses.
  - Fix: Show a 'No team' group and a 'No person' reconciliation line so nothing disappears. Owner decision: add a Teleshop team (sales_teams row, leaderboard_mode NULL) and map the authors. Prediction agents who also sell teleshop keep their team; the row shows a per-source split.
- [major] **AlterCPA sales with no decider (MEX overrode an AlterCPA cancel) and unstamped live approvals are not shown** — 793 September AlterCPA sales have no person (c03/c04.sql). 791 are ledger 'cancelled'/'trashed' leads that MEX delivered (643 paid, 1.952.536 ден COD) or returned (135). Two are unstamped approvals. The 20260939000000_leaderboard_day header notes that scripts/backfill-order-deciders.mjs is not scheduled, so today's AlterCPA approvals read sold_at NULL until someone runs it. The overview teams block (ps CTE) silently omits all such sales: its September team total is 3.547 sales against a 5.734 source total.
  - Fix: In the reconciliation card, show 'AlterCPA: MEX-proven sale, AlterCPA says cancelled (no decider)' and 'approvals awaiting attribution'. For unstamped rows, reuse leaderboard_day's live credit (altercpa_leads.decided_at + v_sales_work sale row). Schedule the decider stamp (separate task).
- [major] **Web shop and MEX-only sales are absent with no reconciliation line, so the totals cannot match the Overview** — September has 514 web_orders (1.068.262 ден) and 1.512 MEX-only non-web parcels (3.417.126 ден; 1.160 delivered, 2.556.958 ден) (c07.sql). None of them has an agent, and the tab gives no line saying so. Tab totals (paid 2.871) match no Overview figure (source total 5.734 sales).
  - Fix: Add a reconciliation card: Σ persons + 'no person' rows per source = Overview kpis per source (altercpa 2.402, elyon_crm 688, teleshop_other 2.644 orders + MEX-only, web mirror 514). Web and MEX-only are labelled 'no agent by nature' and link to the Overview.
- [major] **Source filter uses legacy source_type; 'Внесена историја' mixes AlterCPA history and collabBox teleshop** — AgentsTab.tsx:258-268 offers altercpa/manual/import on orders.source_type (p_source, rollup:72). 'import' = 80.318 AlterCPA history + 8.207 collabBox. 'manual' = ElyonCRM including 6.885 disposition rows (migration 20260935000000 header). There is no ElyonCRM, Teleshop or web option.
  - Fix: Filter by the four owner sources on orders.sale_source (altercpa+affiliate / elyon_crm with detail prediction_list|direct / collabbox+legacy + MEX-only as Teleshop-Other / web). Add a team filter (sales_teams).
- [major] **The status filter only applies to the created window; the paid window ignores it** — p_status is tested only in branch (1) (rollup:77), and branch (2) adds every paid-in-window order regardless. Choosing 'Потврдени' therefore still adds paid rows. It also filters by current status, which conflicts with the cohort model.
  - Fix: Replace it with a cohort bucket filter (paid · at courier · packed · to pack · returned · cancelled after confirm) that uses the Overview's bucket predicates and GET /orders?outcome drill-down.
- [major] **'Paid' is status/paid_at, not MEX proof** — is_earn = status='paid' with coalesce(paid_at,created_at) (rollup:135-141). In the September cohort, 43 AlterCPA sales are paid without a MEX delivery (17 Pending team, 26 Management; c02.sql). Today they are dropped only because they have no owner; once attributed they would count as paid. Rule 2 says MEX decides.
  - Fix: Paid means mex_delivered_at IS NOT NULL (cash = mex_cod_mkd). Paid-without-proof is its own labelled 'unproven' count and never goes into cash.
- [major] **A second profit definition that disagrees with Pure Profit** — total_profit = Σprice − Σ current products.cost_price×qty; net_contribution = (paid−returned) − costs (index.ts:10147-10198, rollup:102-120). There is no VAT, delivery or return loss, and it uses today's cost rather than a snapshot. The Pure Profit tab has the owner's waterfall.
  - Fix: Remove Добивка / Нето придонес / Добивка по лид from Agents. If per-person profit is wanted, add a 'person' dimension to the Pure Profit/channel P&L RPC (owners only) so there is one definition.
- [major] **No team, presence or work ledger, so the tab disagrees with the Overview teams board** — The tab never reads sales_teams, sales_team_members, agent_presence_days or v_sales_work. insights_overview's teams block (migration 20260936000000:874-987) already joins roster × work × sales × presence. agent_presence_days holds data only from 28.09.2026 (2 rows; c06.sql). The one AlterCPA person without a login (AlterCPA #4531 (unnamed), 2 sales) never shows in the tab.
  - Fix: Rebuild on the Overview teams definitions (see the proposal). Show presence as '—' before 28.09.2026 with a note. People with no login get presence 'n/a' and an 'AlterCPA only' badge.
- [minor] **The Overview teams block credits a person to every team they overlapped in the window, not the team on the sale day** — mem = DISTINCT ON (team_key, person_id) of memberships overlapping [fd,td] (20260936000000:880-888). A person who moved teams mid-window has all of their sales counted in both teams. Prediction memberships start between 02.09 and 16.09, so 01.09 sales fall outside. Today the effect is small.
  - Fix: One shared definition in the new SQL (primary team valid on the Skopje sale day), used by both the Overview teams block and the Agents tab.
- [minor] **Rows of deactivated or deleted accounts vanish** — missingIds is looked up with .eq('is_active', true) (index.ts:10011-10015), and idByIdentity is built from active profiles only. All-time, 14 rows / 3 paid / €72,69 are dropped (Sashka Simonovska's inactive duplicate login + 3 ids with no profile; fold.mjs on b05_alltime).
  - Fix: The new model keys on sales_people, which keeps inactive people. Show them with an 'inactive' badge.
- [minor] **Hardcoded English strings** — AgentsTab.tsx:320 'Sales Activity', :340 'Sales Quality', :357 'Financial Impact', :212 'to', :298 'Clear', :465 '(N pkg)', :37 CSV header row, :46 file name 'agent-performance-…'. These break rule 4 (mk/en/sq/bg).
  - Fix: Put every string under agentsTab.* in all four locales, including localized CSV headers.
- [minor] **Number and date formatting not in Macedonian style** — Counts use String(n) with no thousands separator (e.g. '3393', AgentsTab.tsx:325-331). Rates use `${value}%` with a '.' decimal (RateBadge :502). fmt() uses a '.' decimal and a 'k' suffix. Custom dates are native <input type=date> (browser-locale format, not dd.mm.yyyy).
  - Fix: Use the Overview's useOverviewFormat (mk grouping, comma decimals, dd.mm.yyyy) and the shared DateRangePicker.
- [minor] **Bonus/payout display (flag only, out of scope)** — Исплата (payout_earned), Пакети (packages_sold), Чекаат (packages_awaiting) and Прос./пак. (avg_per_package) come from the rollup's bonus_earn/pkgs_* with the exact-name bonus gate (index.ts:9976-9983, 10210-10240). They are shown to admins/managers and to the agent's self view, as bare EUR via fmt(), and they include the 9 ghost disposition rows.
  - Fix: LEAVE THE MATH AS IS (owner: payouts and bonus come later). In the upgraded tab, keep the column sourced unchanged from /agent-performance, joined by profile user_id, and add a unit label only.
- [minor] **The legacy engine twin must move in lockstep or be retired** — ?engine=legacy streams rows (index.ts:9845-9871, 10108-10193) with the same semantics as the SQL twin. Any definition change has to land in both, or the rollback path silently shows old numbers. scripts/verify-agent-perf-parity.mjs gates both.
  - Fix: Build the new tab on a new route/RPC and leave /agent-performance (both engines) frozen for the bonus columns. Retire the Agents usage of its legacy engine when payouts are redone.

### Upgrade proposal
UPGRADED 'Агенти' TAB: people and teams on the Overview's definitions, the four sources, cohort + MEX proof. The audit wrote only scratchpad SQL; no repo file was edited.

DEFINITIONS (shared with insights_overview; one SQL source):
- Person = orders.sold_by_person_id → sales_people. Team = that person's primary sales_team_members row valid on the Skopje sale day (Pending — AlterCPA · Prediction — ElyonCRM · Management · 'Без тим').
- Source = orders.sale_source, in 4 groups: AlterCPA (altercpa+affiliate), ElyonCRM (elyon_crm; prediction_list|direct), Teleshop/Other (collabbox+legacy + MEX-only parcels), Web (web_orders mirror). Disposition rows are never sales.
- Base = the SOLD clock (sold_at, else confirmed_at, else created_at) inside the Skopje window from the page DateRangePicker (dd.mm.yyyy).
- Each sale sits in exactly one current bucket: paid (MEX delivered) · at courier · packed · to pack · returned · cancelled after confirm. Buckets sum to the total.
- Cash = mex_cod_mkd of parcels delivered in the window (formatDenari), shown as a separate, labelled 'Готовина по ден на испорака (MEX)' figure. Sold value = price EUR via formatMoney.
- Work = v_sales_work decisions; conversion = sale decisions / worked.
- Presence = agent_presence_days (from 28.09.2026; '—' before; 'n/a' without a login).
- Money is owners only.

WIDGETS:
1. Filter row: shared page DateRangePicker (Skopje days), team, source (the 4 above), person search, 'Прикажи и без продажби' (the whole roster), CSV. Money columns go into the CSV only when meta.money; headers use i18n.
2. Attribution/freshness strip:
   - 'Одлуките се доделени до …' (last sold_* stamp)
   - 'N AlterCPA одобрувања чекаат доделување' (live-credited)
   - 'Присуство се мери од 28.09.2026'
   - link to Settings → Teams → unmapped.
3. Team cards (reuse overview TeamsBoard): online now / on break, people, worked, sale decisions, conversion, sales, MEX-proven paid, return rate. Owners also see sold value (ден) and MEX cash (ден).
4. Cohort outcome bar per team (reuse OutcomeBar + DrillLink → GET /orders?sold_from&sold_to&team_key&outcome, which already exists at index.ts:5511-5643).
5. People table: name, team badge, 'без најава / само AlterCPA' badge, presence (online/active/idle minutes, idle alerts), worked, sale decisions, conversion, sales split by source (AlterCPA · ElyonCRM · Телешоп), paid (MEX), at courier, to pack/packed, returned, cancelled after sale, collection = paid/(sales − still open), return rate = returned/(paid+returned). Owners also see sold value, MEX cash and AOV. The bonus column (Исплата/Пакети) stays exactly as today, fetched unchanged from /agent-performance and joined by user_id (flagged, not redesigned). Each number drills to /orders?sold_by_person_id=…
6. 'Продажби без агент' reconciliation card, so Σ people + this card = Overview source totals (with a ✓/✗ check):
   - AlterCPA: MEX-proven sale where AlterCPA says cancelled, no decider (791 in September); approvals awaiting a stamp.
   - Teleshop: unmapped collabBox authors, listed with counts (1.394 in September), plus MEX-only parcels (1.512).
   - Web shop: 514 (no agent by nature).
   - Ghost disposition rows (9) as an attention line.
7. Cash-flow panel (owners only): MEX COD delivered in the window per team and 'без лице', labelled as a different clock from the cohort.

BACKEND:
(a) New migration 2026094xxxxxx_insights_agents.sql. Extract insights_overview's teams CTE (vw/mem/wk/ps/pr/pn/una) into public.insights_people_block(p_from text, p_to_end text) → jsonb:
   - sale-day team rule;
   - per-person × source cohort buckets with counts, eur and mkd;
   - worked/sale/cancel/trash/callback from v_sales_work;
   - presence;
   - cash by MEX delivery;
   - an 'unattributed' section per source (MEX-over-AlterCPA-cancel, unstamped approvals with leaderboard_day's live credit, unmapped collabBox authors with sold_by_ext, web count/mkd from web_orders, MEX-only parcels).
   Security: SECURITY DEFINER, service_role only, SET TimeZone, Skopje bounds, disposition excluded. Have insights_overview's teams block (and later leaderboard_day) call it, so the numbers cannot diverge.
(b) New edge route GET /insights/agents in index.ts, with pure mapping in a new supabase/functions/api/agents.ts: overviewWindows() for bounds; isBusinessOwner gate; a stripOverviewMoney-style whitelist for admins/managers; agents get only their own person (sales_people.user_id = uid), without money.
(c) Leave GET /agent-performance and agent_performance_rollup untouched; only the bonus column reads them.
(d) Owner actions, not code: map the missing collabbox_author identities; decide on a Teleshop team; schedule scripts/backfill-order-deciders.mjs (or a cron) so AlterCPA approvals are stamped live.
(e) Tests: agents.test.ts (strip + mapping); a harness check that Σ people + unattributed = insights_overview sources per source for a window, e.g. September: 5.734 sales / 10.296.849 ден proven cash.

### Files the fix touches
- D:\Dev\archives\elyon-natura\src\components\insights\AgentsTab.tsx
- D:\Dev\archives\elyon-natura\src\pages\ManagementInsightsPage.tsx
- D:\Dev\archives\elyon-natura\src\lib\api.ts
- D:\Dev\archives\elyon-natura\src\i18n\locales\mk.json
- D:\Dev\archives\elyon-natura\src\i18n\locales\en.json
- D:\Dev\archives\elyon-natura\src\i18n\locales\sq.json
- D:\Dev\archives\elyon-natura\src\i18n\locales\bg.json
- D:\Dev\archives\elyon-natura\src\components\insights\overview\TeamsBoard.tsx
- D:\Dev\archives\elyon-natura\src\components\insights\overview\OutcomeBar.tsx
- D:\Dev\archives\elyon-natura\src\components\insights\overview\DrillLink.tsx
- D:\Dev\archives\elyon-natura\src\components\insights\overview\model.ts
- D:\Dev\archives\elyon-natura\src\components\insights\overview\useOverviewFormat.ts
- D:\Dev\archives\elyon-natura\supabase\functions\api\index.ts
- D:\Dev\archives\elyon-natura\supabase\functions\api\overview.ts
- D:\Dev\archives\elyon-natura\supabase\functions\api\agents.ts (new)
- D:\Dev\archives\elyon-natura\supabase\functions\api\agents.test.ts (new)
- D:\Dev\archives\elyon-natura\supabase\migrations\2026094xxxxxx_insights_agents.sql (new; would also CREATE OR REPLACE insights_overview to call the shared people block)
- D:\Dev\archives\elyon-natura\scripts\verify-insights-parity.mjs
- D:\Dev\archives\elyon-natura\.grok\skills\elyon-agent-commissions\SKILL.md (doc note only; no bonus math change)

## profit — Pure Profit; Маржи (Margin Lab)

**Live engine:** INSIGHTS_ENGINE = sql. I checked this by comparing the secret digest from the Management API /secrets against sha256('sql'); no value was printed. AGENT_PERF_ENGINE and PAYOUT_SUMMARY_ENGINE are also sql.

Live path: GET /management-insights (index.ts, handler at ~17050; the file is being edited by another session and moved about 205 lines while I worked) runs useSql=true and calls four RPCs:
- insights_orders_rollup: scalars.paid_revenue and the logistics counts
- insights_paid_basis: by_product, cogs_units, paid_packages and the realized percentiles
- insights_products
- insights_calls_and_m

### Issues
- [critical] **Cash comes from order prices, not MEX COD** — index.ts ~18111 `cash_collected: r2(paidRevenue)`. paidRevenue = insights_orders_rollup sc.paid_revenue = sum(price) FILTER (status='paid'). Sept (pp04/06/09): the tile shows 10.176.707 ден (price × 61,5), but the same orders' MEX COD is 10.288.989 ден. The figure includes 40 AlterCPA 'paid' orders with no parcel (95.743 ден) and misses 208.025 ден of COD above price (252 parcels at price + 150 ден). A 0-price paid 'Alpha Male' order has COD 3.000 ден and counts as 0.
  - Fix: Cash = Σ orders.mex_cod_mkd WHERE mex_delivered_at IS NOT NULL (formatDenari, no ×61,5), plus MEX-only parcel cod_mkd. Show paid-without-MEX-proof as a separate grey line that is excluded from profit, the same as Overview's unproven_paid.
- [critical] **Web shop and MEX-only sales are missing** — Every insights RPC reads public.orders only. The live insights_overview for the same window shows MEX cash 15.540.678 ден vs Pure Profit's 10.176.707. MEX-only delivered parcels: 1.832 / 3.835.309 ден (9102 631/1.435.290; 9100 530/1.055.240; NTMK web 280/477.803; 9110 117/340.770; 9103 110/322.117; 9108 67/126.280). The web_orders cohort is 444 orders / 911.707 ден (collected 618.589). None of this appears on either tab.
  - Fix: Build the P&L over the four sources exactly as insights_overview does: sale_source CASE for orders, the mf CTE for MEX-only parcels (NTMK/claimed → web), and web_orders/web_order_items through web_order_outcome.
- [critical] **Numbers disagree with the Overview (three clocks, one label)** — Pure Profit windows on orders.created_at: the RPC base plus `channel_pl.basis.window: "created_at"` (~18154). For Sept, Pure Profit shows 10.176.707 ден, the Overview hero (MEX-proven by delivered day) 15.439.008, and the Overview cohort 13.938.945 (5.734 sales). 433 AlterCPA orders created in August were delivered in September (1.177.437 ден). They appear in August's Pure Profit, never in September's cash.
  - Fix: Use the Overview's two clocks and label them: cohort (sale_at = coalesce(sold_at, confirmed_at, created_at), disposition excluded) as the base, and cash flow by mex_delivered_at as a separate, labelled view. Both totals must equal the Overview's kpis.confirmed and kpis.delivered.proven_cod_mkd.
- [critical] **Phantom courier cost on MEX parcels (BG €3,50/€6,00 fallback)** — index.ts:1642-1643 set BLENDED_DELIVER_COST 3.5 and BLENDED_RETURN_COST 6.0. resolveCourierService (index.ts:1657) and the SQL CASE twins only read delivery_type/home_courier. Sept: 3.822 shipped/paid and 519 returned orders (AlterCPA and collabBox imports, home_courier NULL, every one with a mex_tracking_id) are charged the fallback. Live delivery is €14.618,45 vs a correct €10.563,31; return loss €3.114 vs €0 (courier_rates mex = 2,439 / 0). Phantom cost: 440.902 ден in September. This is the 08-19 MEX bug again, in a new form.
  - Fix: Treat any order with mex_tracking_id or mex_account as MEX in resolveCourierService AND in the SQL twins (insights_orders_rollup, insights_paid_basis, insights_channel_pl, plus the new profit RPC). Take the unknown-courier fallback from courier_rates 'mex' instead of the BG constants. Charge 150 ден on MEX-only parcels too.
- [critical] **COGS covers 32% of paid packages, so profit is heavily overstated** — pp11/12/28. Costed packages: 5.570 of 17.219 (collabBox 29 of 11.131, 0,3%). products has cost_price for 69 of 234. collabBox items have no product_id (0 of 6.373); cost is matched by exact name only. Top uncosted: MAGNESIUM CITRAT 325mg 150/1 tab 1.487 (no catalogue row by that name), ПРОСТАТОЛ КОМПЛЕКС 1.047, СНАИЛ КОМПЛЕКС 987, АЛОЕ ВЕРА 1Л 720, БРАИН АКТИВ 693. The shown clear profit is ≈6,42 M ден (63% margin). At the costed average of €2,94 per package, the ~10.233 real uncosted packages would add roughly €30k (≈1,85 M ден) of COGS.
  - Fix: Data (owner): enter cost_price for the teleshop/Bionatural catalogue and merge duplicates. Code: resolve cost by product_id, then by folded name through a product_aliases table (web SKUs included). Show coverage as a prominent badge, and make 'profit on costed packages' vs 'uncosted revenue' explicit instead of silently costing unknown products at 0.
- [critical] **Channel P&L breaks the owner's source rule, and the affiliate card contradicts it** — The 4-arg order_channel is prediction-first: `WHEN coalesce(p_ordered_before,false) THEN 'prediction'` (migration 20260932000000). Sept (pp19): the Prediction row shows 4.747.518 ден, of which 2.127.326 are AlterCPA ad leads (745 paid) and 1.376.290 are teleshop/social re-buyers; real ElyonCRM prediction_list is 1.243.902. The Affiliate row shows 1.747.631, yet the 'По афилијатор' card on the same tab sums to 3.874.956 because it groups on cpa_webmaster_id regardless of channel. Only 3 rows exist: no web row, no teleshop/MEX-only row.
  - Fix: Replace channel_pl with P&L by the four sources: altercpa (incl. returning customers) · elyon_crm (prediction_list|direct, disposition excluded from money) · web · teleshop_other (teleshop|social|leads|leads_out|MEX-only). Nest the per-webmaster card under the AlterCPA row so Σ webmasters equals that row. Stop using order_channel() for money.
- [major] **Loyalty points, delivery lines and notes counted as products and packages** — collabBox imports write 'ПОЕН-150/350/200/…', 'ДОСТАВА', 'ЗАБЕЛЕШКА…' and 'Флаер-Програма за лојалност' as order_items. Sept: 1.416 fake packages (8,2%), 114 of 332 product rows, and 86.134 ден of order revenue allocated to them (weight = qty when ppu=0). Effects: Margin Lab min = 0 ден; p25 = 60 ден (562 without junk); average 591 vs 639 ден; teleshop packages/order 4,70 vs 4,14. The same rows appear in the Pure Profit Product Breakdown, the simulator dropdown and the missing-cost banner.
  - Fix: Add a line-kind classifier (product | points | delivery | note | flyer), for example order_line_kind(name) SQL plus a TS twin. Exclude non-product lines from packages, products and the realized distribution. Report zero-priced gift units (2.171 collabBox, 231 ElyonCRM in Sept) as a separate 'бесплатни пакети' figure.
- [major] **Ghost 'paid' disposition rows are counted** — 5 elyon_crm/disposition 0 ден rows are status='paid' in Sept (the mex-reconcile single-candidate fallback, memory 09-27). They count as paid orders and packages ('No prior product on file'), are charged delivery, and their parcels' COD (9.640 ден) is lost from revenue. They also inflate the channel P&L Prediction row's paid count.
  - Fix: Exclude sale_source_detail='disposition' from every money figure (the Overview's is_sale already does this). Once cash comes from MEX COD per parcel, the parcel money lands where the parcel is linked. The ghost repair itself waits for the owner's decision.
- [major] **The page says 'Pure Profit stays paid day', but it is created day** — i18n insights.workClockFromAugust (all 4 locales), shown under the date picker: 'Cash/Pure Profit stays paid day'. The code windows on created_at (index.ts insights RPC calls; channel_pl.basis.window 'created_at').
  - Fix: Delete the note. Put a clock label on each block instead ('Продажби потврдени во периодот' / 'Паричен тек по ден на испорака во MEX').
- [major] **Headline and per-product net use different cost bases; unknown cost reads as 'над целта'** — Headline: realized.net_profit_per_pkg = clear_profit / paid_packages (~18025), with commission applied only to agent-owned sales (451 of 4.148 paid orders). Per product: netNow deducts packageBonusRate(avgPrice) on EVERY package (~18005), and cogsUnit = 0 when cost is unknown, so uncosted products can show 'над целта'. The floor also uses the €3,50 NULL-courier delivery share, and the simulator default delivery is courierFallback.deliver = €3,50 (MarginLabTab.tsx:33, index ~18018).
  - Fix: Compute both on one basis. Apply the (unchanged) commission rule only to the commissionable share of each product's packages. Take the delivery share from the MEX 150 ден rate. When cost is unknown, show status 'без набавна' and never 'clears'. Default the simulator delivery to the courier_rates mex deliver cost. The commission tier math is not touched.
- [major] **Lead cost is zero, so AlterCPA profit is shown without its biggest cost** — insights_channel_pl base: `0::float8 AS payout` (migration 20260932000000:143). The KPI 'Чисти / Pure Profit' and the channel rows show AlterCPA clear profit unqualified; only a footnote explains.
  - Fix: Label the profit 'пред трошок за лидови' until per-webmaster rates exist, with a visible 'цени за лидови не се внесени' chip on the AlterCPA row and the KPI. Keep the slot wired.
- [major] **VAT 18% applied flat, still unconfirmed** — index.ts:1651 `const VAT_RATE = 0.18` with TODO(mk) (supplements may be 5%/10%). Sept VAT line: 1.552.441 ден on gross cash. UI fallback `pp?.vat_rate ?? 0.2` (ManagementInsightsPage.tsx:282, BG 20%). mlFloorHelp says 'Floor = 1.2 × …' (BG) while the code uses 1,18.
  - Fix: Keep one VAT source, returned by the API, and show a 'стапка за потврда' badge until the accountant confirms. Remove the 0.2 fallback. Make mlFloorHelp use {{gross}} (1,18). If the rate differs per product class, move VAT to a per-product field.
- [major] **Duplicate product names split rows and lose costs** — pp26/27: 'Alpha Male' (cost €2,93, AlterCPA offer name) vs 'ALPHA MALE 60 cps' and 'ALPHA  MALE 60 cps' (cost 0); 'ВИТАМИН Ц-1000 60 cps' vs a double-space variant; 4 case variants of 'Флаер-Програма за лојалност'. by_product keys on the raw item name.
  - Fix: Fold names (trim, collapse whitespace, case, Latin/Cyrillic via transliterate) and map them through product_aliases to one product_id for both grouping and cost.
- [major] **Courier card shows its biggest row as raw 'unknown_—' and still lists BG couriers** — The TS stores service '—' for unknown (index.ts ~17766 and the SQL coalesce(service,'—')). The UI key `${l.courier}_${l.service}` = 'unknown_—' never matches courierServiceLabel's 'unknown' key (ManagementInsightsPage.tsx:268-273, 511-514). In Sept that row holds 3.822 delivered / 519 returned MEX parcels. The label map still carries Econt/Speedy.
  - Fix: After the courier fix, split rows by MEX account (bio_natural / natura) from mex_parcels. Use a 'не е запишан' row only for true unknowns, keyed correctly. Drop the Econt/Speedy labels.
- [minor] **Hardcoded English and untranslated labels** — ManagementInsightsPage.tsx: 360 'Pure Profit Breakdown', 430 'Product Breakdown (paid orders)', 433-434 'paid orders · packages · per order', 494 'Logistics Spend by Courier', 543 'Agent Earnings (Payouts)'. PureProfitExportDialog: 'Export', SECTIONS labels/hints, 'Period: … all time', and English sheet/column headers; the 'MKD' column also carries counts and percentages. mk/sq tabPureProfit = 'Pure Profit'; mk noPureProfit and kpiClear contain 'Pure Profit'.
  - Fix: Move every string into insights.* / ppExport.* in mk/en/sq/bg (mk e.g. 'Чиста добивка'). Use a separate 'Вредност' column for counts in the export.
- [minor] **Numbers and dates not in Macedonian format** — toLocaleString() with no locale, toFixed(1) ('4.2'), pct() '63.1%'. ChannelPLCard passes attrFrom as ISO 'yyyy-mm-dd' into channelAttributionCutoff. The export 'Period' is ISO.
  - Fix: Use useOverviewFormat (dm(), mk grouping, comma decimals) on both tabs; dates dd.mm.yyyy.
- [minor] **Stale BG texts and comments** — cashBasisNote says a return loses '~370 ден' round-trip (BG €6; MEX return = 0 on the rate card). Comments: Money 'Dual EUR/LEV' (ManagementInsightsPage.tsx:258); 'gross ÷ 6 at 20%' (~18113); 'P − P/6 … 1.2·' (~17981); 'Calibrated from the BigArena fee ledger' (index.ts:1640).
  - Fix: Rewrite the note from the rate card (MEX 150 ден delivery, 0 return, goods return to stock) and fix the comments.
- [minor] **Tables unbounded; coverage banner is a wall of names** — Sept by_product has 332 rows in both Product Breakdown and the Margin floor table; the simulator dropdown has 332 entries, junk included. The missing-cost banner joins all uncosted names (~260) into one sentence.
  - Fix: Show the top 20 plus 'Останати' with search. List the top 10 uncosted by packages, linked to Settings → Products.
- [minor] **No EUR on screen: rule passes** — Both tabs render only formatMoney (ден) and the export has MKD columns; nothing leaks EUR. Money is owners-only: client need 'business' plus server isBusinessOwner (index.ts ~17052).
  - Fix: Keep. When switching cash to MEX COD, use formatDenari (already denars) and never formatMoney on a COD value.

### Upgrade proposal
DEFINITIONS (shared with the Overview; same predicates, so the totals must tie)
- **Source:** the insights_overview CASE on orders.sale_source: altercpa (+affiliate) · elyon_crm · web · teleshop_other (collabbox/legacy).
  - MEX-only delivered parcels (mex_parcels.order_id NULL, status_id 2): NTMK or web-claimed → web, else teleshop_other.
  - Web shop: web_orders/web_order_items through web_order_outcome.
  - Disposition rows are never money.
- **Sale instant:** sale_at = coalesce(sold_at, confirmed_at, created_at) for is_sale rows. The cohort = sales whose sale_at falls in the Skopje range; web = placed in range; MEX-only = created_at_mex in range.
- **Buckets:** paid · кај курир · спакувано · за пакување · вратено · откажано по потврда. The buckets sum to the cohort total.
- **Cash:** MEX COD only (orders.mex_cod_mkd with mex_delivered_at; mex_parcels.cod_mkd for MEX-only; web collected_mkd), in denari, via formatDenari. Paid without MEX proof is shown separately and never counted.
- **Cash flow:** the same money by mex_delivered_at, a separate labelled view. Its total equals the Overview's kpis.delivered.proven_cod_mkd.
- **Costs:**
  - VAT = cash × r/(1+r), r = VAT_RATE, badge until the accountant confirms.
  - COGS = Σ packages × cost, resolved by product_id → product_aliases (folded name / web SKU). Gifts are included, points/delivery/notes excluded. Coverage % is shown.
  - Courier = courier_rates by MEX account for every dispatched parcel (MEX-only too); anything with a mex_tracking_id is MEX.
  - Return = rate-card return fee (MEX 0); goods return to stock.
  - Agent commissions: the current rule, unchanged and deferred.
  - Lead cost: slot kept at 0, labelled 'пред трошок за лидови'.

PURE PROFIT (Чиста добивка), owners only
1. **Filter row:** the Overview FilterBar (presets, Skopje, dd.mm.yyyy, source chips), plus a clock toggle: Кохорта (default) | Паричен тек по MEX.
2. **Cohort strip:** the reused OutcomeBar per the six buckets (count + ден, links through ordersHref/sourceDrill). The total equals Overview 'Потврдени'.
3. **Waterfall KPIs on the paid bucket (MEX-proven):**
   - Наплатено (MEX)
   - − ДДВ
   - − Набавна (coverage badge)
   - − MEX испорака
   - − Враќања
   - − Провизии (unchanged)
   - − Лидови (not entered)
   - = Чиста добивка + маржа %
   - Side chips: 'Отворено' = courier + to-pack value in ден, 'Изгубено' = returned + cancelled after confirm, 'Платено без MEX доказ' (grey).
4. **Profit by source:** replaces ChannelPLCard. Four fixed rows (SOURCE_ORDER palette); each row shows sales, paid, cash, VAT, COGS, courier, commissions, lead cost, clear profit, margin and cost coverage. Row expanders:
   - altercpa new|returning, with the per-webmaster table nested (Σ = row)
   - elyon_crm prediction_list|direct (disposition shown only as 'обработени')
   - web shop|MEX-only
   - teleshop_other teleshop|social|leads|leads_out|MEX-only (by series)
   - Σ rows = the KPI.
5. **Product P&L:** top 20 + Останати, real products only, folded names, all four sources. Columns: platени пакети, of which free, realized ден/pkg, набавна/pkg, MEX share/pkg, net/pkg, margin, cost known.
6. **Courier costs by MEX account:** bio_natural / natura; delivered and returned counts, 150 ден × n, return fee. A 'не е запишан' row that should read about 0.
7. **Data-quality rail:**
   - cost coverage % + the top 10 uncosted products (link to Settings → Products)
   - unproven paid
   - lead-cost pending
   - VAT pending confirmation
   - junk lines excluded (count)
8. **Export:** the same blocks, i18n headers, dd.mm.yyyy period, a ден column plus a separate count column.

The Agent-earnings card stays untouched (payouts later).

MARGINS (Маржи)
1. **Basis:** the cohort paid bucket from the Pure Profit RPC, all four sources. Web items give real realized prices.
2. **KPIs:** avg · median (p25–p75) · min · max ден/pkg over real products only; the free-package share as its own KPI. Net/pkg on exactly the same cost basis as the per-product rows.
3. **Floor table:** top N + search; floor = (1+r)·(target + cogs + MEX share + commission share for that product's commissionable packages). Unknown cost → 'без набавна', never 'над целта'. mlFloorHelp shows {{gross}}.
4. **Simulator:** product list = real products; source selector (AlterCPA/ElyonCRM/Web/Teleshop) turns commission and lead cost on or off; delivery default = courier_rates mex (150 ден).
5. **'By source' mini-table:** realized ден/pkg and net/pkg per source.

BACKEND
- **(a) New migration 2026094x_insights_profit.sql** (read-only, SECURITY DEFINER, service_role and the harness role):
  - order_line_kind(text) classifier
  - product_aliases(folded_name text PK, product_id uuid, source text) table (seeded only with the owner's OK)
  - insights_profit(p_from, p_to_end, p_clock 'cohort'|'cash'), reusing insights_overview's src/bucket/sale_at/cash_at CASEs and its mf CTE, plus the web block. It returns raw rows at (src, split, bucket, product_key, mex_account) grain: counts, cod_mkd, packages, free_packages, cogs_units, parcels, returned parcels, bonus_sum (at owner_raw grain so the TS agent gate stays as is).
- **(b) SQL-twin courier fix:** add `WHEN o.mex_tracking_id IS NOT NULL THEN 'mex'` to the CASE in insights_orders_rollup, insights_paid_basis and insights_channel_pl; mirror it in TS resolveCourierService; take the unknown fallback from courier_rates 'mex' instead of BLENDED 3,5/6,0.
- **(c) Edge function:** a new module supabase/functions/api/profit.ts (+ profit.test.ts) with GET /insights/profit (isBusinessOwner, overviewWindows bounds). The management-insights pure_profit/margin_lab/channel_pl blocks stay until the UI switches, then the channel_pl block is retired.
- **(d) Parity harness:** update verify-insights-parity.mjs / check-insights-vs-truth.mjs with a tie test: profit.cohort.total == overview.kpis.confirmed and profit.cash.total == overview.kpis.delivered.proven_cod_mkd.

DATA PREREQUISITES (owner OK needed; no writes in this audit)
- Cost prices for the teleshop/Bionatural catalogue.
- Merge 'Alpha Male' / 'ALPHA MALE 60 cps'.
- Web SKU → product map.
- Accountant VAT confirmation.
- Per-webmaster lead rates.
- The ghost-paid disposition repair.

### Files the fix touches
- D:\Dev\archives\elyon-natura\supabase\functions\api\index.ts
- D:\Dev\archives\elyon-natura\supabase\functions\api\profit.ts
- D:\Dev\archives\elyon-natura\supabase\functions\api\profit.test.ts
- D:\Dev\archives\elyon-natura\supabase\functions\api\overview.ts
- D:\Dev\archives\elyon-natura\supabase\migrations\2026094x_insights_profit.sql
- D:\Dev\archives\elyon-natura\supabase\migrations\2026094x_mex_courier_in_sql_twins.sql
- D:\Dev\archives\elyon-natura\src\pages\ManagementInsightsPage.tsx
- D:\Dev\archives\elyon-natura\src\components\insights\MarginLabTab.tsx
- D:\Dev\archives\elyon-natura\src\components\insights\ChannelPLCard.tsx
- D:\Dev\archives\elyon-natura\src\components\insights\AffiliateBreakdownCard.tsx
- D:\Dev\archives\elyon-natura\src\components\insights\PureProfitExportDialog.tsx
- D:\Dev\archives\elyon-natura\src\components\insights\KpiCard.tsx
- D:\Dev\archives\elyon-natura\src\components\insights\overview\OutcomeBar.tsx
- D:\Dev\archives\elyon-natura\src\components\insights\overview\useOverviewFormat.ts
- D:\Dev\archives\elyon-natura\src\components\insights\overview\palette.ts
- D:\Dev\archives\elyon-natura\src\lib\api.ts
- D:\Dev\archives\elyon-natura\src\i18n\locales\mk.json
- D:\Dev\archives\elyon-natura\src\i18n\locales\en.json
- D:\Dev\archives\elyon-natura\src\i18n\locales\sq.json
- D:\Dev\archives\elyon-natura\src\i18n\locales\bg.json
- D:\Dev\archives\elyon-natura\scripts\verify-insights-parity.mjs
- D:\Dev\archives\elyon-natura\scripts\check-insights-vs-truth.mjs
- D:\Dev\archives\elyon-natura\.grok\skills\elyon-logistics-costs

## lists — Прогнозни списоци / Prediction lists (/insights?tab=prediction-lists) — ManagementInsightsPage.tsx:57 (tab def), :197 (render), :572-680 (PredictionLists component)

**Live engine:** INSIGHTS_ENGINE=sql is live. I checked this read-only through the Management API secrets list: the stored digest equals sha256('sql'); no value was printed. AGENT_PERF_ENGINE and PAYOUT_SUMMARY_ENGINE are also sql. The live path for this tab is GET /management-insights -> rpc insights_orders_rollup(p_from,p_to_end) -> 'prediction' (plists CTE). The live body is identical to supabase/migrations/20260928000100_mex_in_sql_rollups.sql:19-203 (line-by-line diff against a pg_get_functiondef dump). TS then merges it into plMap (index.ts:17419-17429), adds members from rpc prediction_list_member_count

### Issues
- [critical] **'Нето' double-subtracts returns** — Revenue is is_sold = confirmed/shipped/delivered/paid, so returned orders are already excluded (SQL 20260928000100:58,170; TS index.ts:17090,17416). Net = revenue - refund_value then subtracts them again (index.ts:17446). 01.09-27.09: Revenue 28.150,75 EUR = 1.731.271 ден, Refunds 3.075,94 EUR = 189.170 ден, so Net shows 25.074,81 EUR = 1.542.101 ден. That is 189.170 ден below the real still-good sale value (1.731.271 ден, which matches the Overview split of 28.191,40 EUR less the 40,65 dup).
  - Fix: Drop 'Net' in its current form. In the cohort model, 'Sales' is the gross base (incl. returned and cancelled-after-confirm). 'Still good' = Sales - returned - cancelled after confirm. 'MEX cash' is a separate figure. Remove net_revenue from the new endpoint so it cannot come back.
- [critical] **'Нарачки' and 'Конв.' count 0-ден call-outcome rows as orders** — plists counts count(*) of every list-attributed row (SQL :165, TS :17411), and conv = paid/orders (index.ts:17450). 01.09-27.09: the tab shows 6.998 'orders'. Of those, 6.311 are elyon_crm/disposition rows (4.540 cancelled + 1.763 trashed + 8 other, price 0, mostly synthetic names). Only 687 are real list sales. Totals give 6,4 % (451/6.998). Real sale conversion is 686 sales / 6.526 worked customers = 10,5 %. Per list: '57d 26+ (1-3 orders)' shows 8,1 % (129/1.585) but the real rate is 11,5 % (175/1.523).
  - Fix: Key sales on sale_source='elyon_crm' AND sale_source_detail='prediction_list'. Count dispositions only as 'worked - no sale' (distinct phone8), never as orders or money. Conversion = sales / worked customers. Show paid rate = paid / sales separately.
- [critical] **Paid/Returned/Confirmed include mex-reconcile 'ghost' dispositions, which also carry real MEX COD** — 9 disposition rows in sold/returned statuses sit on the tab (b_split.sql): 5 paid, 3 returned, 1 confirmed. Examples: ORD-91484/92603/94110 'No prior product on file', ORD-93612 'Adenofrin' at 0,00, ORD-107420 0,00 paid. So Paid shows 451 where the real count is 446, and Returned shows 70 where it is 67. These rows hold 9.640 ден delivered COD + 9.000 ден returned COD (+20.025 ден on 7 cancelled rows) that belongs to other orders. A naive MEX-cash column would add that 9.640 ден. verify-attribution C3 (01.09-27.09) = WARN 7: tab-only 6 / 0,00 EUR are exactly these. C10 FAILs 57 such rows company-wide.
  - Fix: Exclude sale_source_detail='disposition' from every count and cash sum on the tab. List them under an attention item '0-ден call-outcome rows holding a MEX parcel' that links to C10. The mex-reconcile single-candidate fallback fix itself is still undecided (memory 09-27) and stays out of this tab.
- [critical] **Cross-tab: Pure Profit's Channel P&L 'prediction' is 3,4x this tab (old order_channel rule)** — The live order_channel() still returns 'prediction' whenever the phone ordered before (def_order_channel.sql; migrations/20260932000000:79-92,144). insights_channel_pl uses it, and ChannelPLCard renders it on Pure Profit (ManagementInsightsPage.tsx:422). 01.09-27.09 created, sold statuses (w_channel.sql): 'prediction' = 2.249 / 5.831.460 ден. That splits into AlterCPA 973 / 2.680.201 ден, collabBox 652 / 1.417.488 ден and ElyonCRM 624 / 1.733.771 ден. This tab shows about 1.731.271 ден. This breaks owner rule 1: an ad lead from an existing client is AlterCPA.
  - Fix: Owned by the Pure Profit tab. Re-point insights_channel_pl channel to orders.sale_source (altercpa|elyon_crm|web|teleshop_other, as insights_overview does) and drop order_channel. Add a verify-attribution check: channel 'elyon_crm' prediction_list = this tab's total.
- [major] **No MEX money; 'Приход' counts claims incl. stale unshipped sales** — Revenue = list price of confirmed+shipped+paid. For the 01.09-27.09 sale cohort (687 sales / 1.928.441 ден) that includes 112 'to pack' (322.420 ден; 83 older than 3 days, 46 older than 7 days, none with a parcel) and 59 at courier (167.449 ден). MEX-proven cash for the same cohort is 1.246.939 ден (447 of 447 paid have mex_delivered_at). Cash flow by MEX delivery day in the window is 449 parcels / 1.252.939 ден (2 sold before 01.09 = 6.000 ден; 13 COD≠price). The tab shows neither.
  - Fix: Add per-list and total 'MEX cash' = Sum mex_cod_mkd (formatDenari, never x61.5) for paid sales with mex_delivered_at. Keep 'cash flow by MEX delivery day' as a separately labelled figure. Show 'Sales (list price)' as a claim, never as 'Приход'.
- [major] **No cohort buckets; 'Откажани' mixes call outcomes with real cancels; trashed invisible** — The 4.542 'Cancelled' in the window are 4.540 disposition 'no' rows + 2 real cancels after confirm (89,43 EUR = 5.500 ден). Trashed (1.763) appears in no column. Buckets are not shown: paid 447 · at courier 59 · packed 0 · to pack 112 · returned 67 · cancelled after confirm 2 = 687.
  - Fix: Show the owner's cohort: base = list sales with sale_at (sold_at -> confirmed_at -> created_at) in the window. Six buckets that sum to the total, with the same bucket CASE as insights_overview (preparing/packed/courier/delivered/returned/cancelled+trashed with sold_at).
- [major] **Time basis is PLACED (created_at), and the end bound drops the last second** — SQL :36-37 and index.ts:16857 use skopjeRangeEnd = next Skopje midnight - 1 s (...21:59:59.000Z). The Overview uses ...21:59:59.999999Z (overview.ts:101-104). Today all 729 list sales have sold_at on the same Skopje day as created_at (u_clock.sql), so the totals agree now (22.09: tab = Overview = 104.102 ден; 01.09-27.09: 28.150,75 vs 28.191,40 EUR, the diff fully explained by C3). By definition they will drift from the Overview 'confirmed' clock and the owner's sold_at cohort.
  - Fix: Use the SOLD clock with OV.overviewWindows bounds (Skopje 00:00 to 23:59:59.999999) so the tab and the Overview answer from the same instants.
- [major] **Duplicates drop list attribution, so the same sale can be counted twice** — The duplicate insert (index.ts:~7475-7507) does not copy prediction_list_id/name/type/category. trg_orders_sale_source_fill still makes the copy inherit elyon_crm/prediction_list (migration 20260935000000:230-247). ORD-92536 (paid, 40,65 EUR, COD 2.500 ден) is a duplicate of ORD-92231 (same phone, 'Neurofix x3'). It is in the Overview but not on the tab (C3 overview-only 1). ORD-92231 has sat 'confirmed', never packed, with no parcel for 19 days, so the Overview ElyonCRM list portion counts this sale twice.
  - Fix: Copy prediction_list_* from src in the duplicate endpoint. In SQL, resolve a missing list via duplicated_from and fall back to a '(list not recorded)' row so Σ lists always equals the Overview split. Surface 'original still confirmed while its duplicate shipped' as attention.
- [major] **Stale 'to pack' list sales; the packed bucket is structurally empty** — All-time, 92 confirmed list sales have no parcel after more than 3 days = 4.390,40 EUR = 270.010 ден (p_stale_match.sql). Of these, 29 have some later parcel on the same phone (10 unlinked, 4 unlinked delivered) and 12 have a later shipped/paid order on the same phone. packed_at is NULL on 0/729 list sales. These rows are counted in 'Приход'.
  - Fix: Show 'to pack' with age chips (>3 d, >7 d) and a drill-down. Add attention 'list sale confirmed >7 d with no parcel' plus a candidate-parcel hint by phone8. The no-parcel cancel rule is AlterCPA-only today; extending it to ElyonCRM is an owner decision, not part of this tab.
- [major] **Tab does not tie to the Overview or show the whole ElyonCRM source** — The tab only lists lists that have attributed orders in range (40 of 59 lists ever did; 19 active lists with members, e.g. '1-2yr ≤26 (1-3 orders)' 1.029 members, never appear). No ElyonCRM 'direct' line: 5 all-time, 4 sold = 235,77 EUR. No statement that Σ lists = Overview ElyonCRM prediction_list split.
  - Fix: Add a footer 'ElyonCRM direct (no list)' and 'Σ = Overview ElyonCRM card'. Show every active list (members now, worked, sales 0). Change C3 in scripts/verify-attribution.mjs to compare the new RPC with the Overview on the sold clock and PASS on exact equality.
- [major] **EUR on screen: chart Y axis** — ManagementInsightsPage.tsx:664-669: Bar dataKey='revenue' (EUR) with a bare <YAxis/>. The axis reads e.g. 7.410 (EUR) while the tooltip reads 455.772 ден.
  - Fix: Chart denari: pass eurToDen(value) values or a tickFormatter using groupMk. Name the series through i18n.
- [major] **Managers and admins who run the lists see nothing** — The tab is need:'business' (ManagementInsightsPage.tsx:57) and rides the owners-only GET /management-insights (index.ts:16845-16851). Rule 5 allows admins/managers operational counts, as the Overview does with meta.money=false.
  - Fix: A dedicated endpoint returns counts to admin/manager with every money field removed by whitelist (as overview.ts stripOverviewMoney does), and full money to owners.
- [minor] **Tab pulls the whole money aggregate** — Rendering one block triggers insights_orders_rollup + insights_products + insights_paid_basis + insights_calls_and_movement + insights_channel_pl + loadCourierRates (index.ts:17045-17077).
  - Fix: Give the tab its own light endpoint and RPC, lazily fetched like OverviewTab.
- [minor] **Hardcoded English strings** — ManagementInsightsPage.tsx:605 'Money generated per prediction list'; :629 badge 'campaign'/'segment'; :676-678 footnote; :669 Bar name='revenue' (tooltip label).
  - Fix: Add i18n keys in mk/en/sq/bg (insights.predictionLists.*).
- [minor] **Number format not Macedonian** — :632-640 use toLocaleString() without locale (browser locale). pct() gives toFixed(1)+'%' (6.4%). mk expects 6,4 % and '.' thousands.
  - Fix: Use groupMk / Intl.NumberFormat(i18n.language) and a shared percent formatter. Show dates as dd.mm.yyyy wherever a date appears (first attribution, stale ages).
- [minor] **List names are English technical strings with EUR thresholds** — Names like '57d 26+ (1-3 orders)', 'Current Cancels', 'Trash List', 'NEWCOMERS (7+ orders)'. '26+'/'≤26' is an EUR unit-price threshold. No drift found: all 40 snapshot names equal the current prediction_segment_lists.name, and no list is gone (k_drift.sql).
  - Fix: Display-only localized label built from prediction_segment_lists columns (recency_months_min/max, single_price_min/max -> ден, min_paid_count, category). Keep the raw name in a tooltip. NEVER rename the DB names: the engine resolves by exact name and wipes members on drift.
- [minor] **BG leftovers** — type 'uploaded' -> 'campaign' badge (:629; api.ts:1947). prediction_leads is 0 rows and its page has been hidden since 08-19. prediction_list_member_counts still UNIONs prediction_leads. Same file :258 comment 'Dual EUR/LEV money display'.
  - Fix: Drop the uploaded/campaign branch and the prediction_leads union in the new RPC; delete the lev comment.
- [minor] **Members mixes a live snapshot into period columns; failure reads as 0** — Members counts all prediction_segment_members incl. is_completed (e.g. Trash List 13.136, 57d 26+ 1.728 with 117 completed). The RPC error is swallowed (index.ts:17438-17441), so members silently become 0.
  - Fix: Label the column 'Members now' (active = not completed). On failure return null and show '—'.
- [minor] **Empty state hides that attribution starts 14.08.2026** — The first list-attributed sale is 14.08.2026 (l_alltime.sql). Earlier ranges show 'no sales' with no reason. channel_pl already carries first_prediction_attr_at.
  - Fix: Show 'Attribution starts 14.08.2026' (dd.mm.yyyy) whenever the range starts earlier.
- [minor] **Harness cannot run the tab's RPC** — insights_orders_rollup cannot be EXECUTEd by the read-only harness role: 'permission denied for function insights_orders_rollup' in this audit. So C3's 'tab RPC = tab SQL' row is always skipped (canRollup=false).
  - Fix: GRANT EXECUTE on the new insights_prediction_lists (and the rollup) to supabase_read_only_user, conditionally as 20260936000000:1323-1330 does.
- [minor] **Bonus KPI and column: deferred, note only** — 'Исплатени бонуси' (:600, :619, :639) comes from plists.bonus_sum. The 5 ghost paid dispositions also feed it. Per the owner ruling, payouts and bonus math come later.
  - Fix: No change now. Revisit with the payouts/bonus work; the new endpoint does not compute bonus.

### Upgrade proposal
**Goal.** The tab becomes the ElyonCRM prediction-list slice of the owner's cohort model. It must equal the Overview's ElyonCRM / prediction_list portion by construction.

**Definitions (one place, SQL)**
- **Scope:** orders.sale_source = 'elyon_crm' AND sale_source_detail = 'prediction_list' (not monadon_legacy).
- **List key:** coalesce(o.prediction_list_id, dup_src.prediction_list_id via duplicated_from), else a '(list not recorded)' row.
- **Dispositions** (detail = 'disposition') count only as 'worked – no sale' per list: distinct phone8, no money, never paid or returned even when mex-reconcile ghosted them.
- **Clock:** SOLD, with sale_at = coalesce(sold_at, confirmed_at, created_at) in [Skopje 00:00, Skopje 23:59:59.999999]. Use the same bounds as OV.overviewWindows.
- **Buckets** (same CASE as insights_overview) sum to Sales:
  - paid: status paid or delivered; proven when mex_delivered_at is set, otherwise shown as 'paid – no MEX proof'
  - at courier: shipped
  - packed: confirmed with packed_at
  - to pack: confirmed without packed_at, with age >3 d and >7 d
  - returned
  - cancelled after confirm: cancelled or trashed with sold_at set
- **Money:**
  - Sales value and bucket values = price (EUR), shown with formatMoney.
  - MEX cash (cohort) = Σ mex_cod_mkd of proven paid, shown with formatDenari (never ×61,5).
  - Cash flow = Σ mex_cod_mkd where mex_delivered_at is in the window, whatever the sale day. It gets its own label.
- **Rates:** conversion = sales ÷ worked customers; paid rate = paid ÷ sales.
- **Members now** = active (not completed) prediction_segment_members, labelled 'now'.

**Widgets** (component src/components/insights/PredictionListsTab.tsx, fetching its own data like OverviewTab)
1. **KPI strip.** Sales (count · ден); MEX cash collected (ден · proven n/N); At courier (n · ден); To pack (n · ден, warning chip for >7 d); Returned (n · ден, 'not collected'); Conversion (sales ÷ worked). Under it, one labelled line: 'Cash flow by MEX delivery day: N parcels / X ден'.
2. **Cohort bar.** Stacked bar of the 6 buckets, reusing the Overview bucket component and the sources[].buckets shape. Clicking a segment opens /orders?sold_from&sold_to&sale_source=elyon_crm&detail=prediction_list&outcome=<bucket>.
3. **Per-list table,** grouped by family from prediction_segment_lists.category and recency (value lists 21d/57d/4-6m/6-12m/1-2yr/2yr+; holding pens Current Cancels / Current Returns / NEWCOMERS / Never-Converted / Trash List, display only, sticky trash untouched).
   - Columns: List (localized label, raw name in tooltip) · Members now · Worked · Sales · Sales ден · Paid · MEX cash ден · At courier · To pack (stale) · Returned · Cxl after confirm · Conv % · Paid rate.
   - Every active list is shown, including those with 0 sales.
   - Footer: Σ lists (= Overview ElyonCRM prediction_list) + 'ElyonCRM direct (no list)' + 'Σ ElyonCRM (= Overview card)'.
   - Every number drills to /orders.
4. **Recency × price-band matrix** (heatmap of conv % and sales ден). Built from segment definition columns, never by parsing names.
5. **Daily trend.** List sales on the SOLD clock as bars, MEX cash by delivery day as a line. Dates dd.mm.yyyy, axis in ден.
6. **Attention rail:**
   - to pack >7 d with no parcel (with a phone8 candidate-parcel hint)
   - 0-ден call-outcome rows holding a MEX parcel (links to C10)
   - duplicate shipped while its original is still confirmed
   - COD ≠ price
7. **Note:** 'Attribution starts 14.08.2026' when the range starts earlier.

The bonus column and KPI are left as they are, out of scope until the payouts/bonus work.

**Backend**
- **New migration** public.insights_prediction_lists(p_from text, p_to_end text) → jsonb {meta{first_attr_at}, totals{…buckets, cash_cohort_mkd, cashflow_mkd, worked}, lists[], direct{}, matrix[], trend[], attention{}}.
  - plpgsql with EXECUTE…USING and real bounds; SECURITY DEFINER; SET search_path and TimeZone=UTC; Skopje day buckets.
  - EXECUTE for service_role, plus a conditional GRANT to supabase_read_only_user.
  - Preferably, factor the bucket CASE and sale_at/cash_at into IMMUTABLE helpers used by insights_overview, insights_pivot and this RPC, coordinated with the Overview rebuild. Otherwise copy them verbatim and rely on C3.
- **New route** GET /api/insights/prediction-lists?from&to in index.ts (or a new predictionLists.ts):
  - OV.overviewWindows bounds
  - owner → full payload
  - admin/manager → the same payload with money removed by whitelist (as stripOverviewMoney does)
  - everyone else → 403
- **Duplicate endpoint** (index.ts ~7475-7507): copy prediction_list_id/name/type/category. Backfill ORD-92536 in a separate, owner-approved repair.
- **After the UI switches:** stop reading data.prediction_lists. Keep the rollup 'prediction' block only as long as bonus_paid needs it (payouts, later), then drop the plists CTE and index.ts:17395-17452.
- **scripts/verify-attribution.mjs C3:** compare the new RPC with the Overview on the SOLD clock (count, sales EUR, MEX cash) and PASS on exact equality. Add a check that Σ list rows = totals.
- **Cross-tab (Pure Profit owner):** re-point insights_channel_pl to sale_source so its 'prediction' channel equals this tab.

### Files the fix touches
- supabase/migrations/2026094xxxxxxx_insights_prediction_lists.sql (new RPC + read-only grant; optional shared bucket/sale_at helpers)
- supabase/functions/api/index.ts (new GET insights/prediction-lists route; duplicate endpoint ~7475-7507 copies prediction_list_*; later remove prediction block 17395-17452 and response key 17942)
- supabase/functions/api/predictionLists.ts (new, optional: windows + money whitelist strip, reusing overview.ts helpers)
- supabase/functions/api/overview.ts (read-only reuse of overviewWindows / money-strip pattern; edit only if helpers are shared)
- src/pages/ManagementInsightsPage.tsx (lines 57, 197, 572-680 only: swap inline PredictionLists for the new component)
- src/components/insights/PredictionListsTab.tsx (new)
- src/lib/predictionListLabel.ts (new, display-only localized list labels from segment definition)
- src/lib/api.ts (type at ~1944-1960 + new apiGetInsightsPredictionLists)
- src/i18n/locales/mk.json
- src/i18n/locales/en.json
- src/i18n/locales/sq.json
- src/i18n/locales/bg.json
- scripts/verify-attribution.mjs (C3 rewrite + list-sum check)
- supabase/migrations/20260932000000_channel_rule_prediction_first.sql successor (Pure Profit owner: insights_channel_pl by sale_source — cross-tab, not this tab's edit)

## stock — Производи и залихи (Products & stock) — ?tab=stock, component Stock() in src/pages/ManagementInsightsPage.tsx:683-728; Враќања (Returns) — ?tab=returns, component Returns() in src/pages/ManagementInsightsPage.tsx:730-748

**Live engine:** INSIGHTS_ENGINE = sql (verified 28.09.2026 by comparing the function-secret digest to sha256('sql'), no value printed; AGENT_PERF_ENGINE and PAYOUT_SUMMARY_ENGINE are also sql). Stock and Returns are therefore served by the live SQL functions insights_orders_rollup (status distribution, ret_reason, ret_city, can_reason, span_days), insights_products (prod, ret_product) and insights_calls_and_movement (movement), plus a TS map over the products table (index.ts:17660) that runs under both engines. The legacy TS twin has the same semantics (created_at basis, orders table only, exact-name keys). D

### Issues
- [critical] **Returns cover only the `orders` table: MEX-only (Teleshop/Other) and web-shop returns are missing** — insights_orders_rollup/insights_products read public.orders only. MEX register, returned in September by MEX return day: 1.096 parcels / 2.915.309 ден, of which 806 are order-linked (2.212.308 ден), 269 are MEX-only non-web (79 bio_natural + 190 natura, 658.209 ден) and 21 are web (NTMK/claimed, 44.792 ден). The web_orders outcome shows the same 21 returned. The tab shows 586. The Overview also can't see MEX-only returns: its `mf` CTE takes only `p.status_id = 2` (def_insights_overview line ~150).
  - Fix: Build returns from the MEX parcel register (mex_parcels status_id=7, both accounts) left-joined to orders/web_orders, and classify the source with the Overview's rules: orders.sale_source → altercpa/elyon_crm/teleshop_other; NTMK sender_reference or a claimed web tracking id → web; unlinked → teleshop_other ('mex_only_unlinked'). Also add status 7 MEX-only parcels to insights_overview's `mf` (as a returned bucket) so both tabs total the same.
- [critical] **Wrong clock: returns are counted by order created_at, not by the cohort or by MEX return day** — Every CTE filters `o.created_at BETWEEN p_from AND p_to_end`. September: 586 'returned' orders created in the month, against 806 order-linked parcels MEX returned in the month (all of them status 'returned'). By source, created vs returned-in-month: AlterCPA bridge 289 vs 482, AlterCPA history 0 vs 27. 135 of the 289 AlterCPA rows have sold_at and confirmed_at both NULL. The current month is right-censored: most September returns haven't happened yet.
  - Fix: Show two labelled clocks, as rule 3 requires. (a) Cohort (default): the Overview's base, i.e. is_sale = detail<>'disposition' AND (sold_at IS NOT NULL OR status IN real), sale_at = coalesce(sold_at, confirmed_at, created_at). Keep the created_at fallback so the 135 unstamped AlterCPA rows stay in. Returned = MEX-proven, labelled 'so far'. (b) 'Returned in period' = mex_returned_at / mex_parcels.returned_at in Skopje days.
- [critical] **'Value lost' is EUR list price × 61,5, not MEX COD, and it isn't a loss** — returns.value_lost = Σ orders.price of status='returned' → formatMoney. September (tab basis): 1.546.327 ден shown, while the MEX COD on the same 586 parcels is 1.583.078 ден. 85 of 586 have COD ≠ price×61,5, and 3 zero-price rows carry 9.000 ден COD. Goods come back in a COD business, so this is uncollected value, not money lost.
  - Fix: Rename to 'Uncollected COD (returned parcels)' and sum mex_cod_mkd / mex_parcels.cod_mkd rendered with formatDenari (never ×61,5). Show the real loss separately as Round-trip loss (see the next issue).
- [critical] **Round-trip loss is missing here and wrong everywhere else: BG fallback €6,00 per return instead of the MEX rate** — index.ts:1642-1643 BLENDED_DELIVER_COST=3.5 / BLENDED_RETURN_COST=6.0 (Bulgarian Speedy/Econt blend). The SQL CASE in insights_orders_rollup/insights_paid_basis/insights_channel_pl only recognises courier when home_courier='mex' or delivery_type='mex_office'. In September 519 of 586 returns and 3.822 of 4.331 delivered rows have home_courier NULL, so they get the fallback: 191.511 ден phantom return loss plus 249.391 ден phantom delivery overcharge (flows into Pure Profit and Channel P&L). courier_rates says mex deliver €2,4390 (150 ден), return 0. MEX is the only MK carrier.
  - Fix: In MK, treat an unknown courier as MEX: set the fallback to the courier_rates mex row, in TS and in the three SQL twins. Add a 'Round-trip loss' KPI on Returns = returned parcels × courier_rates(mex).return_cost. Owner question: does MEX bill the 150 ден outbound for a parcel that comes back? The card and memory say 0. If it does, set return_cost = 2,4390. Also update the BG-only .grok/skills/elyon-logistics-costs rate table.
- [major] **'Returns by reason' is one bar, '(unspecified)', for 100% of returns** — return_reason is NULL on 586/586 September returns and 3.505/3.505 all time. mex-reconcile sets 'returned' without a reason, and the MEX raw payload carries only current_status (keys: cod, created_at, current_status_id/name, last_update_at, receiver_*, sender_reference, tracking_id). The card also uses cap(), which prints English.
  - Fix: Use a MEX-derived reason proxy. Have mex-reconcile record the last pre-return MEX status (13 Rejected → returnReason.refused_at_door, 9 Delivery attempted → not_picked_up, 3 Problematic → undeliverable_address; these keys already exist in all 4 locales). Show agent-recorded return_reason where present, and 'days at courier before return'. Render with returnReasonLabel, not cap().
- [major] **Cities split across Latin and Cyrillic spellings** — September returns by city (tab basis) produce 58 raw strings: Skopje 212 + Скопје 116, Strumica 14 + Струмица 15, Bitola 11 + Битола 19, Veles 13 + Велес 11, Tetovo 9 + Тетово 6, Kumanovo 5 + Куманово 11, Ohrid 4 + Охрид 18, Kočani 4 + Кочани 6, Shtip 2 + Штип 4, plus English 'Unknown' (11), 'Grenoble', and 'Злетово, општ. Пробиштип'-style strings. mex_parcels.receiver_city is a single canonical Cyrillic spelling with 1.093/1.096 coverage (53 distinct). insights_pivot (Overview drill) has the same split (raw customer_city).
  - Fix: Key city on mex_parcels.receiver_city for anything MEX-proven. Otherwise add a SQL mk_city_key(text) (MK transliteration + unaccent + lower, cut at ',', sh→s, ch→c, zh→z) joined to mk_settlements.name_norm, displaying mk_settlements.name / name_lat / name_sq by locale. Use the same function in insights_pivot and Sales so the tabs agree.
- [major] **Returns by product counts item lines (including free gifts), raw names in two scripts, no web items** — September: 967 line hits for 586 returned orders, 119 names. The top entries include gift lines 'ZINC 120/1 tab' 50, 'ZINC 120/1 tab ФИЗИЧКИ' 48 and 'VITAMIN D3 120/1 tab' 40 (these sell for ~0 ден: ZINC 476 units / 923 ден in the month). The #1 'MAGNESIUM CITRAT 325mg 150/1 tab' (60) has no catalogue row. Web returned lines (59 SALE + 7 GIFT units) are absent.
  - Fix: Count returned UNITS per catalogue product via a product alias map (see the stock issues), with gift units in their own column, notes and loyalty points excluded, web_order_items included, and an explicit 'MEX-only parcel (no product data)' row.
- [major] **Cancellations / Trashed KPIs are pre-sale lead outcomes, not returns** — September cancelled (created basis) = 6.297. That is 4.542 ElyonCRM cold-call dispositions (not_interested 1.225, will_call_back 825, still_using_product 689, other 518, no_money 472, not_satisfied 445, changed_mind 208, bought_elsewhere 149, price_too_high 11), about 1.527 AlterCPA lead rejections decided in AlterCPA's panel, and only about 388 cancelled after a confirmed sale (228 no_parcel_7d). Trashed 2.350 = junk leads.
  - Fix: On Returns keep only the cohort bucket 'cancelled after confirm' (sold_at/confirmed_at set, then cancelled/trashed; the Overview's lost_after_confirm) with its reasons. Move lead dispositions to Agents / Call activity / the Overview funnel.
- [major] **CRM-cancelled orders whose MEX parcel is still moving are counted as cancellations** — 96 September orders (119 all time) are status cancelled/trashed while their linked MEX parcel is live: Shipment created 40+1, Delivery attempted 15+2, In delivery 13+1, Problematic 10, Rejected 8, In transit 5, Picked up 1. That is about 298.000 ден COD with the courier. None has a delivered or returned parcel yet.
  - Fix: Rule 2 (MEX decides): bucket these by the parcel as 'at courier' (they become returned/paid when MEX says 7/2). List them on the attention rail with a link to /orders. Don't count them as cancellations.
- [major] **Return-rate denominator differs from the Overview's sales definition** — Tab: 586 / 5.314 'real orders created' = 11,0%. The denominator includes 3 disposition ghost rows and excludes rows sold in the period but created earlier. Overview cohort for September: 5.734 sales → returned 586 so far (AlterCPA 292/2.402, ElyonCRM 67/688, Teleshop collabBox 227/2.644) = 10,2%, plus MEX-only 122 returned of 1.512 created and web 21 returned.
  - Fix: Use the Overview's is_sale/sale_at base per source. Show the rate as 'so far' with the share of the cohort still open (at courier / to pack) so an immature month isn't read as final.
- [major] **Zero-price 'No prior product on file' disposition rows are counted as returns (known ghost-link bug)** — September: 3 elyon_crm/disposition rows with product 'No prior product on file', price 0, status returned, carrying 9.000 ден MEX COD (and 3 more marked paid, 6.640 ден). mex-reconcile's single-candidate fallback linked the parcel to the cancel row (memory 09-27, fix not decided).
  - Fix: Exclude sale_source_detail='disposition' from every returns/sales count (as the Overview already does). Surface the ghost links on the attention rail until the mex-reconcile fallback is fixed.
- [major] **No split by source, MEX account or day; admins/managers see no operational return numbers** — The tab is under need:'business' and fed only by the owners-only /management-insights (ManagementInsightsPage.tsx:52-59). Non-owner admins/managers lose return counts entirely, although rule 5 lets them see operational numbers. There's no per-source, per-account (bio_natural/natura) or per-day view.
  - Fix: Serve the tab from a new /insights/returns that follows the Overview gate: owners get the full payload, admins/managers the same payload with money stripped (whitelist, like overview.ts stripOverviewMoney). Add source, account and trend (Skopje dd.mm.yyyy) blocks.
- [minor] **Hardcoded English and BG leftovers** — cap() on reason keys (ManagementInsightsPage.tsx:741); server labels 'Unknown', '(unknown)', '(unspecified)', 'Others' (topN). Filter `source_type <> 'monadon_legacy'` matches 0 MK rows, and status 'delivered' has 0 MK rows (both BG leftovers in every CTE).
  - Fix: Return keys, not labels (e.g. city_key null → i18n 'insights.unknownCity', 'others' → i18n). Drop the monadon filter and the 'delivered' status branches in the new RPCs.
- [critical] **Stock quantities are placeholders: the ledger has been silent since 20.08** — inventory_logs holds 88 manual_adjust rows (06.08, +88.000 = the 1.000 placeholder per product) and 55 order_deduction rows on 20.08 (−130 units). Nothing since, and 0 rows in September, while 5.236 order-linked MEX parcels were created in September carrying about 11.284 units with a product_id. Stock is deducted only when the CRM API moves an order to 'shipped' (index.ts ~6385-6450, ~7244-7300). mex-reconcile, altercpa-sync and web-sync never touch stock, and MEX returns never restock (order_return only on a manual CRM transition). Result: 'Adenofrin 996 on hand, 1.553 sold in September → ≈17 days of cover' is fiction, and 74 products still sit at exactly 1.000.
  - Fix: Owner decision needed. Drive stock from MEX events: deduct on parcel created (or on packed_at once packing is used), restock on MEX status 7, idempotent by tracking_id. Load a physical count to replace the placeholders. Until then the tab must show 'Stock not verified since 06.08.2026' and hide days-of-cover and valuation.
- [major] **'Out of stock 85' is really 'not warehouse-tracked'; the catalogue has cross-script duplicates** — Active products 174: 84 were created on 12.08 by the teleshop/BIONATURAL catalogue import with 0 stock and 0 cost (plus 1 on 19.08), and none of those were ever stocked. Low stock = 0. There are likely duplicate pairs: 'ADENOFRIN 20/1 cps' (0) vs 'Adenofrin' (996), 'ALPHA MALE 60 cps' vs 'Alpha Male', 'NEUROFIX BIONATURAL 30/1' vs 'Neurofix', 'БРАИН АКТИВ 30cps' vs 'Brain active (30cps)', 'АРТРО БЛУ ГЕЛ 200 МЛ,' vs 'Arthro Blue', 'Р и Р Мелем 100 мл.' / 'МЕЛЕМ R&R 30МЛ' vs 'R&R Melem'. Names are 81 Latin / 93 Cyrillic.
  - Fix: Add products.tracked (warehouse-tracked vs shipped elsewhere) and compute Out/Low over tracked products only. The owner confirms the duplicate pairs, which get merged through an alias map. Give each product one Macedonian display name.
- [major] **Sold units matched to the catalogue by exact name: top seller invisible, collabBox lines have no product_id** — September sold lines: collabBox 6.523 lines with 0 product_id, only 4.079 name-matching the catalogue, 302 names. Total 18.874 units across 350 names; only 14.627 units / 126 names match an active catalogue row. #1 by revenue 'MAGNESIUM CITRAT 325mg 150/1 tab' (1.498 units, 997.954 ден) has no catalogue row, so it never appears in the stock table.
  - Fix: Create product_aliases(source, raw_key, product_id, kind) seeded from distinct collabBox names and web SKUs (scripts/map-collabbox-skus.mjs is a starting point). Key every product aggregate on product_id and show an 'unmapped' row with units so the gap stays visible.
- [major] **Loyalty points and free-text notes are counted as product units** — collabBox writes 'ПОЕН-150/200/350/120' loyalty lines (1.211 units in September, 0 ден) and 'ЗАБЕЛЕШКА …' note lines (99, e.g. 'ке врати 3 артро фикс') as order_items. That's 6,9% phantom units in September. Gift lines (0 price, 2.553 units) are mixed with paid units.
  - Fix: Classify at import (scripts/import-collabbox-teleshop.mjs): notes go to order notes, points to a separate field. Backfill the kind via the alias map. In the tab, show gift units separately; they leave the warehouse but earn nothing.
- [major] **Top sellers and 'Sold (range)' omit the web shop and MEX-only sales and use the wrong clock and value** — Orders only: the tab shows 11.648.837 ден for September top sellers. Web shop September delivered SALE lines = 844 units / 583.104 ден (+143 preparing, +43 at courier, +122 gift units), and web items can't be joined today (0/35.639 SKU matches, 0 name matches; SKUs are free text like 'FEMME7'). MEX-only parcels (1.512 created in September) have no product data. The basis is created_at plus status-now, so a later-returned sale drops out and cancelled-after-confirm is ignored. Value is EUR item total ×61,5, not MEX COD.
  - Fix: Units shipped = MEX parcel created day. Sales = cohort sold_at (Overview base) + web_order_items via alias map, with an explicit 'MEX-only (no product data)' line. Value: formatMoney of EUR price for sold value, formatDenari of MEX COD for delivered cash, labelled separately.
- [major] **Warehouse packing substate is unused, so 'to pack' / 'packed waiting courier' can't be shown** — orders.packed_at is non-null on 0 rows all time (feature live since 17.08). 925 orders sit in 'confirmed', 553 of them older than 14 days (€30.237,45 ≈ 1.859.603 ден), and none has a tracking id.
  - Fix: Show the warehouse queue on this tab: preparing / packed / at courier, the same bucket CASE as insights_overview. Show the count and the oldest date (dd.mm.yyyy) to admins/managers/warehouse; the value is owners only. Flag the 553 stale confirmed orders.
- [major] **Stock valuation not shown, and cost data too thin to make it meaningful** — No valuation widget exists (cost_price/price are shipped in the payload and dropped). 105 of 174 active products have cost_price 0. On today's placeholders it would read €210.533,63 at cost (≈12.947.818 ден) and €1.461.355,73 at retail. Separately, src/pages/WarehousePage.tsx:793-794 shows cost_price and price to the warehouse role as bare EUR numbers (toFixed(2)), which breaks rules 2 and 5.
  - Fix: Add an owners-only valuation KPI (formatMoney of Σ qty × cost_price) with cost-coverage %, shown only when the stock count is verified. Hide cost from non-owners on WarehousePage and render price with formatMoney.
- [minor] **Top-sellers ranking, title and bar disagree** — The server returns the top 20 by revenue (index.ts topSellers). The UI re-sorts by units (ManagementInsightsPage.tsx:724) under the title 'Најпродавани (парчиња)', and the bar length is proportional to revenue. High-unit, low-value items (ZINC 476 units / 923 ден) never make the list.
  - Fix: Offer two explicit rankings (by units / by value) computed server-side, with the bar on the ranked column.
- [minor] **Hardcoded English, dead payload, BG leftovers, odd day span** — 'Stock report' (ManagementInsightsPage.tsx:693) and badges 'Out'/'Low'/'OK' (713) are hardcoded; days-of-cover has no unit. products_stock.movement is computed and never rendered, and the api still writes a BG 'bigarena_import' inventory reason (index.ts:9230). spanDays = first→last order timestamp in the range, not calendar days.
  - Fix: Put everything through i18n (4 locales) and render the movement ledger by day with translated reasons. Remove the BigArena path. Use calendar Skopje days (td−fd+1) as the Overview does.
- [minor] **Legacy vs SQL twin differences for these tabs (for the record)** — Both engines share the same semantics (created_at basis, orders only, exact-name keys). Only tiny differences: retProduct NULL item name groups as SQL NULL vs JS 'null' key; spanDays SQL truncates µs to ms like V8. Live engine = sql (INSIGHTS_ENGINE digest matched 'sql').
  - Fix: The new RPCs replace both paths for these tabs. Drop products_stock/returns/cancellations from /management-insights once the new endpoints ship, and update scripts/verify-insights-parity.mjs to the new shape.

### Upgrade proposal
GOAL: both tabs read from the same base as the Overview (insights_overview: srcs altercpa/elyon_crm/web/teleshop_other; bucket CASE awaiting/preparing/packed/courier/delivered/returned/cancelled/trashed; is_sale / sale_at = coalesce(sold_at, confirmed_at, created_at), detail<>'disposition'; MEX-only = mex_parcels.order_id IS NULL minus NTMK/claimed-by-web; web = insights_web_block / web_orders + web_order_outcome). Money only for owners (strip whitelist like overview.ts), counts for admins/managers (and warehouse for the stock queue). Skopje days, dd.mm.yyyy, all strings in mk/en/sq/bg.

BACKEND (one migration, e.g. 20260940000000_insights_returns_stock.sql + a module supabase/functions/api/returnsStock.ts with tests, routes GET /insights/returns and GET /insights/stock mirroring the /insights/overview gate):
1. public.mk_city_key(text) → canonical settlement: MK translit + unaccent + lower, cut at ',', map to mk_settlements.name_norm → returns id + name/name_lat/name_sq. For MEX-proven rows use mex_parcels.receiver_city first. Reuse it in insights_pivot (city) and the Sales tab.
2. public.product_aliases(source text, raw_key text, product_id uuid null, kind text check in ('product','gift','loyalty_point','note')) seeded from distinct collabBox item names, web_order_items.sku/name and AlterCPA offer names, plus a SQL helper product_key(source, raw) → product_id/kind. Add products.tracked boolean (warehouse-tracked).
3. public.insights_returns(p_from, p_to_end, p_basis 'cohort'|'returned'):
   - Cohort: the Overview f base per source, plus MEX-only parcels by created_at_mex, plus web orders by created. Each sale in exactly one bucket: delivered(MEX 2) · at courier (MEX live, INCLUDING CRM-cancelled rows with a live parcel) · packed · to pack · returned (MEX 7 only) · cancelled after confirm. Buckets sum to the total.
   - Returned-in-period: mex_parcels status 7 by returned_at, both accounts, classified to the 4 sources.
   - Blocks: kpis, by_source, by_account (bio_natural/natura), by_product (units via alias, gift units separate, 'mex_only_no_product' row), by_city (key + localized names), by_signal (last pre-return MEX status + recorded return_reason), days_at_courier histogram, trend by Skopje day, attention lists (CRM-cancelled with live parcel, status-returned-without-MEX, disposition ghost links).
   - Money: uncollected COD = Σ mex cod_mkd (denars, formatDenari); round-trip loss = returned × courier_rates(mex).return_cost (0 today; owner to confirm whether MEX bills the 150 ден outbound on returns).
4. public.insights_products_stock(p_from, p_to_end):
   - per product_id: on_hand, tracked, reserved (units on preparing+packed orders), shipped_units (MEX parcel created in the period), returned_units (MEX 7 in the period), sold_units (cohort) and gift_units split by 4 sources incl. web lines via alias; unmapped raw names with units; days_of_cover over calendar days, only when tracked AND count verified; last_count_at (last manual_adjust/restock); value_at_cost and value_at_price (owners only) with cost coverage.
   - warehouse queue: preparing/packed/courier counts + oldest dd.mm.yyyy (value owners only).
   - movement by day and reason.
5. Fixes outside the new RPCs:
   - MK courier fallback = MEX rate, in index.ts BLENDED_* and in the courier CASE of insights_orders_rollup/insights_paid_basis/insights_channel_pl (cross-tab with Pure Profit).
   - insights_overview `mf` should also carry status 7 MEX-only parcels as 'returned', so the Overview and Returns agree.
   - mex-reconcile: record the pre-return status and (owner decision) restock on 7 / deduct on parcel created.
   - collabBox importer: stop writing ЗАБЕЛЕШКА/ПОЕН as order_items.
   - Remove products_stock/returns/cancellations from /management-insights after cut-over (and update the parity harness).

UPGRADED 'Враќања' (Returns) widgets:
(1) Clock switch: 'Продажби во периодот (кохорта)' default vs 'Вратени во периодот (MEX ден)'.
(2) KPI row: Returned parcels (MEX-proven) · Return rate so far (+ % of cohort still open) · Uncollected COD (ден) · Round-trip loss (ден) · Cancelled after confirm · Still at courier (count/COD).
(3) Outcome bar per source (4 rows, same buckets as the Overview SourceRows / OutcomeBar components) → rows open /orders drill.
(4) Returns by product (units, gift units, uncollected value).
(5) Returns by city (canonical, localized).
(6) Return signal (MEX pre-return status → refused_at_door / not_picked_up / undeliverable_address) + days at courier.
(7) By MEX account + daily trend.
(8) Attention: CRM-cancelled with live parcel (96 in Sept), unproven returns, ghost links.
Removed: Trashed KPI and lead-stage 'Cancellations by reason'.
Expected September figures: returned-in-period 1.096 parcels / 2.915.309 ден (806 orders + 269 MEX-only + 21 web). Cohort so far: 586 orders returned of 5.734 sales + 122 MEX-only + 21 web.

UPGRADED 'Производи и залихи' (Products & stock) widgets:
(1) Banner if the stock count is unverified ('последна проверка 06.08.2026').
(2) KPIs: tracked products · out / low (tracked only) · units shipped in period · units returned in period · stock value at cost (owners, with coverage %).
(3) Warehouse queue: to pack / packed waiting courier / at courier with oldest date (reuses the Overview bucket CASE).
(4) Product table (MK display name): on hand · reserved · available · shipped · returned · sold by source (AlterCPA/ElyonCRM/Web/Teleshop) · gift units · days of cover · state · value at cost (owners).
(5) Top sellers by units and by value (cohort) with source split; unmapped-names row.
(6) Movement ledger by day.
(7) Data-quality card: unmapped names (units), duplicate catalogue pairs to merge, products without cost, loyalty/note lines found.

### Files the fix touches
- src/pages/ManagementInsightsPage.tsx (remove inline Stock()/Returns() at 683-748, mount new components; shared with the Sales-tab agent, so extract first to avoid conflicts)
- src/components/insights/StockTab.tsx (new)
- src/components/insights/ReturnsTab.tsx (new)
- src/components/insights/returnsStockModel.ts + tests (new)
- src/components/insights/overview/SourceRows.tsx / OutcomeBar.tsx (reuse, possibly small prop additions)
- src/lib/api.ts (InsightsResponse types; apiGetInsightsReturns / apiGetInsightsStock)
- src/i18n/locales/mk.json, en.json, sq.json, bg.json
- src/pages/WarehousePage.tsx (cost_price/price EUR display and non-owner cost exposure, lines ~793-794)
- supabase/functions/api/index.ts (new routes /insights/returns and /insights/stock; BLENDED_DELIVER_COST/BLENDED_RETURN_COST at 1642-1643 → MEX; later drop products_stock/returns/cancellations from /management-insights ~17659-18090; remove bigarena_import path ~9230)
- supabase/functions/api/returnsStock.ts + returnsStock.test.ts (new module, money strip whitelist)
- supabase/functions/api/overview.ts (reuse window parsing / strip helper)
- supabase/migrations/20260940000000_insights_returns_stock.sql (new: mk_city_key, product_aliases, products.tracked, insights_returns, insights_products_stock; courier CASE fallback in insights_orders_rollup / insights_paid_basis / insights_channel_pl; status 7 MEX-only in insights_overview mf; city key in insights_pivot)
- supabase/functions/mex-reconcile/index.ts (record pre-return MEX status; owner decision: restock on 7 / deduct on parcel created)
- scripts/import-collabbox-teleshop.mjs and scripts/map-collabbox-skus.mjs (stop writing ЗАБЕЛЕШКА/ПОЕН as order_items; seed aliases)
- scripts/verify-insights-parity.mjs (response shape change)
- .grok/skills/elyon-logistics-costs/SKILL.md (BG rate card → MEX 150 ден / return rule)

## calls — Активност на повици (call-activity); Page shell: tab bar and per-tab access gating (useInsightsAccess), the shared date filter bar, loading/empty/error states, i18n leftovers across ALL tabs, formatting that bypasses the money/number/date helpers, Bulgarian leftovers

**Live engine:** All three report engines are live on sql: INSIGHTS_ENGINE, AGENT_PERF_ENGINE and PAYOUT_SUMMARY_ENGINE. I checked via the Management API by comparing each secret's digest with sha256('sql'); no value was printed.
- The Call Activity KPIs run on rpc insights_calls_and_movement (20260911000000:453; live md5 349acbe9…). It filters call_logs.created_at with TimeZone=UTC; the bounds are already Skopje-pinned instants.
- The timeline runs on GET /agent-activity. That is TypeScript only, with no SQL twin and no engine switch, and it filters started_at.
- Where the twins differ: by_outcome treats NULL

### Issues
- [critical] **'Повици' counts every 'Не се јавува' button click as a call, so the answer rate reads 0,8% and the average per call reads 0** — insights_calls_and_movement (live, md5 349acbe9…) counts every call_logs row by created_at. CallsPage.tsx:979-990 handleAnswerDidntAnswer writes a call_logs row with outcome no_answer and no started_at/connected_at/ended_at. SQL c1/c2 for 01–27.09.2026: 4.409 rows = 4.373 untimed standalone no_answer clicks + 35 timed answered calls + 1 OrderModal cancel. answered = 35 (0,8%). talk = 1.997 s, so 'Прос. / повик' = round(1997/4409) = 0 and shows '0m'. All-time, 5.023 of 5.099 rows are untimed. Per agent (c9): Anita Koligova shows 380 calls at 0,0%, yet made 331 CRM decisions with 43 confirms.
  - Fix: Split call_logs into (a) timed calls (started_at NOT NULL), labelled 'пријавено време од агентот' while VITE_USE_REAL_VOIP=false, and (b) no-answer dispositions (outcome='no_answer'). Replace the answer rate with a reach rate = CRM decisions ÷ (CRM decisions + no-answers): 7.118 ÷ 11.491 = 61,9% for Sept. Rename talk time to agent-reported handling time.
- [critical] **The same tab shows two contradictory numbers for the same day** — The range KPIs filter call_logs.created_at (index.ts ~17148 → RPC). The timeline filters started_at (index.ts:11437) and builds its agent list from callers ∪ shift_assignments (index.ts:11474). For 17.09.2026 (c12): range KPI says 419 calls, 3 answered (0,7%). Timeline tiles say 47 agents, 3 calls, 100% answered. Real work that day: 671 decisions by 26 people (572 via the CRM).
  - Fix: Use one data source per concept. Drop the timeline's own KPI tiles and its own date state, and drive both blocks from the shared page filter. Timeline rows = only people with events.
- [major] **The real work ledger and the whole AlterCPA team are missing; per-person numbers disagree with the Overview teams block** — The tab reads only call_logs. v_sales_work 01–27.09 (c4/c5) has 11.801 human decisions. CRM: 7.118 (confirmed 702, cancelled 4.612, trashed 1.804; 28 people). AlterCPA: 4.683 (approved 1.420, cancel_other 242, cancelled 2.316, trashed 705; 13 people). Nina (404 decisions, 334 approved), Zaklina Denik (490), Sashka Simonovska (364) and Dragana (83) have 0 call_logs rows, so they are invisible here. The Overview (insights_overview vw/wk CTEs) reports 'worked' from v_sales_work, so no person reads the same on both tabs.
  - Fix: Rebuild the tab on v_sales_work + call_logs no-answers + agent_presence_days, keyed by sales_people and using the same rollup as the Overview teams block. call_logs.agent_id maps to sales_people.user_id for 28 of 28 callers (100%).
- [major] **Timeline lists every shift-assigned user and never draws dispositions or decisions, so it reads as 'everyone idle all day'** — /agent-activity (index.ts:11440-11474) adds every shift_assignments user. Sept has 1.604 assignments on 62 shifts; 17.09 alone has 47. Only 35 calls in the whole month have started_at, so the 4.373 no-answer clicks and 11.801 decisions never appear. Per day, timed calls run 0–7 while untimed no-answer rows run 15–416.
  - Fix: Rows = people with ≥1 decision, no-answer, timed call or presence record. Draw decision ticks (v_sales_work.at, coloured by outcome), no-answer ticks (call_logs.created_at) and the timed call segments, plus presence/break bands (agent_presence_days from 28.09.2026, shift_breaks).
- [major] **The note under the date bar (insights.workClockFromAugust) is false** — ManagementInsightsPage.tsx:152 shows it on every range tab, including Call Activity: 'from August work numbers follow the confirm/cancel/trash day … Cash/Pure Profit stays paid day'. Live pg_get_functiondef shows insights_orders_rollup, insights_products, insights_paid_basis and insights_channel_pl all filter o.created_at (20260928000100:36-37 and 227-228). So the paid basis and cash are windowed by lead-created day, not paid day. None of them use Europe/Skopje (they SET TimeZone=UTC).
  - Fix: Delete the note. Give each widget its own clock caption from the shared filter model: по ден на внес / по ден на одлука / по ден на достава (MEX).
- [major] **Four period controls and three defaults on one page; switching tabs wipes the Overview filters** — (1) The Overview FilterBar keeps range/from/to/cmp/src/team in the URL, defaults to 'week' (rolling 7 days) and uses Skopje today. (2) The page DateRangePicker keeps its range in component state, defaults to 'today', uses the browser-local date, and offers Денес / 1 месец / from–to. (3) AgentsTab getDateRange (AgentsTab.tsx:22-31) uses the UTC toISOString date; 'today' sends to=tomorrow, week spans 8 days, and the default is 'month'. (4) CallActivityTimeline has its own single-day picker. ManagementInsightsPage.tsx:175 calls setSearchParams({ tab: v }), which drops every Overview param, so tabs never show the same period (rule 6).
  - Fix: One page-level InsightsFilterBar: Денес/Недела/Месец/Година/Прилагодено, dd.mm.yyyy period label, Skopje today, URL keys shared with the Overview. Switching tabs merges params instead of replacing them. Agents takes its period from the shared bar. Payout keeps its own controls until the payout pass.
- [major] **Managers cannot open Call Activity; the tab's permission still hangs on a stale agent_activity key** — role_permissions has no call_activity row, so only admins get it (via the admin bypass). manager:agent_activity and admin:agent_activity are true; agent_activity was the key of the old page this tab replaced. App.tsx:139 still lists agent_activity in moduleKeysAny. useInsightsAccess.calls reads only call_activity (PermissionsContext.tsx), while ManagementInsightsPage.tsx:105 canCallsSlice and the server comments assume admins and managers. Result: 6 non-owner managers lose the tab, yet they see team presence on the Overview.
  - Fix: Owner decision. Recommended: calls = the Overview rule (owners + admins/managers with insights). Migrate manager:agent_activity to call_activity, then drop agent_activity from the route, module_settings and role_permissions.
- [major] **Money reaches non-owner admins/managers on the Agents tab (rule 5)** — AgentsTab.tsx:55 sets canSeeFinance = isAdmin || isManager. With it the tab shows Outstanding and Profit (lines 419-420); Paid revenue (418) and AOV (422) show unconditionally. GET /agent-performance (index.ts ~9754) has no isBusinessOwner gate. Non-owners: 4 of 10 admins and 6 of 12 managers.
  - Fix: Add money = business to useInsightsAccess. /agent-performance strips money fields for non-owners (a meta.money flag, as /insights/overview does). AgentsTab renders money columns only when money is true.
- [major] **Chart axes print raw EUR values next to tooltips in denari** — ManagementInsightsPage.tsx:239 (XAxis type=number over revenue in EUR) and :667 (YAxis over list revenue) have no tickFormatter. The tooltips use formatMoney, so the axis reads 61,5× smaller than the tooltip. That puts EUR on screen, which rule 2 forbids.
  - Fix: Set tickFormatter to formatMoney in compact form (useOverviewFormat.compact on denari).
- [minor] **Outcome names are untranslated** — ManagementInsightsPage.tsx:793 passes by_outcome through transformName={cap}, which prints 'No answer' / 'Answered' on a Macedonian UI. outcome.* keys already exist in mk/en/sq/bg, and AgentTimeline uses them.
  - Fix: Use t('outcome.' + key).
- [minor] **Hardcoded English strings (AST scan)** — ManagementInsightsPage.tsx: 234 'Top products by revenue', 253 source note, 360 'Pure Profit Breakdown', 430-434 'Product Breakdown (paid orders)… paid orders · packages · per order', 494 'Logistics Spend by Courier', 543 'Agent Earnings (Payouts)', 605 'Money generated per prediction list', 629 'campaign'/'segment', 676-677 paragraph, 693 'Stock report', 713 'Out'/'Low'/'OK', 795 'Calls by agent', 241 series name 'revenue'. CallActivityTimeline.tsx: 87/107 aria-label 'Previous day'/'Next day', 143 'Call timeline', 145 'today · live'. AgentTimeline.tsx:245 'talk · call/calls' plus its local fmtDur h/m/s. AgentsTab.tsx: 212 'to', 298 'Clear', 320 'Sales Activity', 340 'Sales Quality', 357 'Fi
  - Fix: Add keys to mk/en/sq/bg (mk default) and route every string through t().
- [minor] **Server-generated English labels are rendered verbatim** — normAgent returns 'Unknown operator' (index.ts:1116 and ~17102); topN adds 'Others' (~17115); '(none)', '(unspecified)', '(unknown)'; city 'Unknown'; agent-activity full_name 'Unknown' (~11500).
  - Fix: Return sentinel keys (__unknown__, __others__, __none__) and map them with t() in the UI.
- [minor] **Bulgarian leftovers** — courierServiceLabel econt/speedy (ManagementInsightsPage.tsx:268-273), plus insights.econt*/speedy* in all 4 locales, plus speedy/econt branches in insights_paid_basis (20260928000100:216-222). VAT fallback 0.2 (ManagementInsightsPage.tsx:282) while the server VAT_RATE is 0.18 (index.ts:1651). 'Dual EUR/LEV' comment and the vestigial Money component (258-266). 'Sofia' and '+120/+180' comments (AgentTimeline.tsx:33,73; index.ts:11383) and 'Skopje is +2 in winter, +3 in summer' (index.ts:1478); Skopje is UTC+1/+2, though the code computes the offset correctly. Dead ChannelStrip.tsx (never imported) with the retired 'inbound' channel. The Sales note ('mostly manual imports… webhook/lead orders'
  - Fix: Remove or correct each item. Delete ChannelStrip.tsx and the econt/speedy keys once no rows use them.
- [minor] **Number, percent, duration and date formatting bypasses the locale helpers** — About 40 .toLocaleString() calls with no locale. pct() uses toFixed with a '.' decimal (ManagementInsightsPage.tsx:41). fmtDuration uses English units and returns '0m' for 0 (design-utils.ts:132). CallActivityTimeline uses date-fns 'EEE, d MMM yyyy' / 'd MMM yyyy' (English, not dd.mm.yyyy). The export dialog prints 'Period: 2026-09-01 → today'. KpiCard tones (bg-blue-100 text-blue-700, …) are light-only.
  - Fix: Use the useOverviewFormat helpers (int/pct/minutes via presence.hm/m, period/dm → dd.mm.yyyy) on every tab, and themed tokens for the KPI tones.
- [minor] **Owners and admins see different per-agent tables** — The owner path builds per_agent from agMap (people who own an order in range, sorted by revenue; index.ts ~18097). ?scope=calls lists every caller, sorted by calls. Both use the normAgent(profile name) identity, not sales_people. Live check: on 11.09 one caller with one call is dropped for owners.
  - Fix: Build one per-person block on sales_people (see the proposal).
- [minor] **The SQL engine and its TS twin can disagree on by_outcome** — insights_calls_and_movement groups the raw outcome and applies coalesce afterwards, so NULL and '' become two '(none)' rows. The TS consumer overwrites instead of adding (byOutcome[r.outcome] = r.count, index.ts ~17152 and ~17508), while the legacy loop merges them. There are 0 such rows today, so this is latent.
  - Fix: Group by coalesce(nullif(outcome,''),'(none)') and use += in TS, or retire the calls half of the RPC with the rebuild.
- [minor] **For owners, Call Activity loads the full money aggregate just to draw four call tiles** — ManagementInsightsPage.tsx:92 enables fullQ on onCalls, which runs insights_orders_rollup, insights_products, insights_paid_basis and insights_channel_pl. Any money RPC error (e.g. 'insights_channel_pl: …') blanks the call tiles. Non-owners get the light ?scope=calls slice instead.
  - Fix: Every role reads the work/calls endpoint on this tab.
- [minor] **Missing loading state on Call Activity** — ManagementInsightsPage.tsx:213: on first load callsBlock is undefined and there is no error, so the KPI area renders nothing while only the timeline shows a spinner.
  - Fix: Show skeleton tiles or a table while the query is pending.
- [minor] **(Observation only, no change proposed; the owner deferred payouts) Payout money is visible to any insights holder** — useInsightsAccess.payout = canInsights, so non-owner admins and managers see agent payout amounts.
  - Fix: Record this for the later payout/bonus pass; do not change it now.

### Upgrade proposal
This was a read-only audit. No repository file was edited; the only files written are the scratchpad SQL and scan scripts in scratchpad/audit.

UPGRADED TAB: 'Работа и повици' (keeps the route key call-activity, so /agent-activity still redirects to it)
- Audience: owners, admins and managers (with insights). The tab has no money at all, so it needs no money gate. Plain agents keep the self-only day view.
- Everything counts on Skopje days and is keyed on the sales_people identity, the same one the Overview TeamsBoard uses. That makes this tab and the Overview agree by construction.

WIDGETS
1. Caveat and freshness strip. It says 'Телефонијата не е поврзана — времињата се пријавени од агентот' and shows the AlterCPA feed's last sync (reuse the FreshnessStrip altercpa row).
2. KPI row, with compare against the previous period and a daily sparkline. Expected Sept 01–27 values:
   - Одлуки (worked): 11.801
   - Продажни одлуки (confirmed + approved + cancel_other): 2.364
   - Конверзија: 20,0%
   - Не се јавува (no-answers): 4.373
   - Достигнати % (CRM decisions ÷ (CRM decisions + no-answers)): 61,9%
   - Активни луѓе: 41
   - Онлајн / активно време, from agent_presence_days (data only since 28.09.2026; earlier shows '—' with a note)
   - Secondary tile: 'Повици со тајмер' 35, 33 min of agent-reported handling time.
3. Teams, then one row per person: team, worked, sales, cancels, trash, callbacks, no-answers, reach %, conversion %, first/last decision (HH:mm Skopje), online/active/idle/break minutes, idle alerts, timed calls and handling time. Sorted by worked. Sales counts link to /orders?sold_by_person_id=… (reuse DrillLink).
4. Hour-of-day heatmap (Skopje 07–22 × weekday, filterable by team): decisions per hour. It shows shift coverage and night approvals.
5. Outcome mix per team: sale / cancel / trash / callback / no-answer, with translated outcome.* labels.
6. Day swimlane, shown only when the period is a single day (‹ › step the shared filter). This is AgentTimeline fed with decision ticks, no-answer ticks, timed call segments and presence/break bands. Rows = people with events, not every shift assignment.

Removed: the range KPI block (Повици / Стапка на одговорени / Време на разговор / Прос.), 'Calls by agent', and the timeline's own date picker and tiles.

BACKEND
a) New migration with public.insights_work(p_from date, p_to date, p_teams text[] DEFAULT NULL) RETURNS jsonb.
   - SECURITY DEFINER, EXECUTE for service_role only.
   - Windows are explicit: (day::timestamp AT TIME ZONE 'Europe/Skopje').
   - Sources:
     - v_sales_work (decisions, via crm and altercpa)
     - call_logs: outcome='no_answer' gives no-answers; started_at NOT NULL gives timed calls, with handling = total_seconds; agent_id maps to sales_people.user_id (100% mapped in Sept)
     - agent_presence_days and shift_breaks (presence)
     - sales_team_members valid_from/valid_to (team at the time)
   - Returns: {totals, prev, per_day[], teams[{team_key, members[]}], by_hour[{dow, h, team_key, n}], outcomes[{team_key, outcome, n}], meta{voip:false, presence_since:'2026-09-28'}}. No money keys.
   - Factor the per-person rollup into one helper (a view or function) that insights_overview's teams CTE also reads, re-created in the same migration. Add a fixture test asserting Overview teams 'worked' equals the Work tab's worked for 01–27.09.2026.
b) Edge function: new GET /api/insights/work?from&to&team.
   - Gate: isBusinessOwner OR (isAdminOrManager AND the call_activity or insights module).
   - SQL only, with no TS twin, so no engine secret or parity case is needed. Add a vitest over the response shaper.
c) GET /agent-activity?date: add decisions[] and no_answers[] per person, switch identity to sales_people, and restrict rows to people with events or presence. Align its gate with the tab gate.
d) Retire the calls parts of /management-insights: the ?scope=calls branch, the legacy call_logs stream, the calls block and agents[].calls/answered/talk_seconds. Split insights_calls_and_movement so the Stock tab keeps 'movement'. Update scripts/verify-insights-parity.mjs to match.
e) Permissions migration: grant manager call_activity (copying agent_activity), then delete the agent_activity module and its grants. App.tsx: drop agent_activity from moduleKeysAny. useInsightsAccess: calls = owners + admins/managers with insights (or the call_activity grant); add money = business, for the Agents money strip.

ONE SHARED FILTER ROW (all tabs)
- Extract the period group of overview/FilterBar.tsx into src/components/insights/InsightsFilterBar.tsx:
  - presets Денес / Недела / Месец / Година / Прилагодено, using model.presetRange (rolling 1/7/30/365 days) and skopjeToday
  - period label from useOverviewFormat.period (e.g. '01.09 – 27.09.2026')
  - custom from/to with an Apply button (no per-keystroke queries), max span 400 days
  - optional compare switch
  - slow-loading indicator with Cancel
- ManagementInsightsPage owns the bar, and the period lives in the URL under the Overview's keys (range, from, to, cmp), so the Overview and every tab read the same period.
- Tab switch becomes setSearchParams(prev => { const n = new URLSearchParams(prev); n.set('tab', v); return n; }).
- Tab-specific chips go in a second row: Overview sources/teams; Work teams and person; Agents search/agent/source/status.
- AgentsTab drops getDateRange (UTC, to=tomorrow) and reads the shared Skopje range. DateRangePicker leaves /insights; the Dashboard keeps it. Payout keeps its own controls until the payout pass.
- Replace the false workClockFromAugust note with per-widget clock captions: 'по ден на внес', 'по ден на одлука', 'по ден на достава (MEX)'.

SHELL SWEEP (all tabs)
- Route every visible string through t() in mk/en/sq/bg, including tabPureProfit in mk and sq.
- Server sentinels become translation keys.
- Outcome names use outcome.*.
- Use the useOverviewFormat int/pct/minutes/dd.mm.yyyy helpers everywhere, and put a formatMoney tickFormatter on every money axis.
- Delete the Bulgarian leftovers: econt/speedy labels and keys, the VAT 0.2 fallback, the EUR/LEV comment and Money stub, the Sofia and +120/+180 comments, and ChannelStrip.tsx.
- Show skeletons while loading; use themed KPI tones.

GATING MATRIX (proposed)
- Overview: owners with money, admins/managers with counts (unchanged).
- Sales, Pure Profit, Margins, Prediction lists, Stock, Returns: owners only (unchanged).
- Agents: owners see everything; admins/managers get counts only, with money stripped on the server; agents see themselves.
- Payout: unchanged, deferred by the owner.
- Работа и повици: owners, admins and managers.

### Files the fix touches
- src/pages/ManagementInsightsPage.tsx (shell: shared filter, tab-switch param merge, remove the calls block and the false note, i18n/format sweep, axis tickFormatter, BG leftovers)
- src/components/insights/CallActivityTimeline.tsx (replaced by a new src/components/insights/WorkActivityTab.tsx)
- src/components/activity/AgentTimeline.tsx (decision/no-answer ticks, presence bands, i18n, Sofia comments)
- src/components/insights/InsightsFilterBar.tsx (new; extracted from overview/FilterBar.tsx)
- src/components/insights/overview/FilterBar.tsx, model.ts, useOverviewFormat.ts (reuse/extract the period group; shared URL keys)
- src/components/insights/overview/TeamsBoard.tsx (reused by the Work tab)
- src/components/insights/KpiCard.tsx (themed tones)
- src/components/insights/ChannelStrip.tsx (delete; dead, retired 'inbound')
- src/components/insights/AgentsTab.tsx (shared range, money gate, English strings; shared with the Agents auditor)
- src/components/insights/PureProfitExportDialog.tsx (i18n; shared with the Pure Profit auditor)
- src/contexts/PermissionsContext.tsx (useInsightsAccess: calls rule, money flag)
- src/App.tsx (ProtectedRoute moduleKeysAny: drop agent_activity)
- src/lib/api.ts (apiGetInsightsWork + types; agent-activity types; later drop InsightsCallsResponse)
- src/lib/design-utils.ts (fmtDuration: localized units, or replace with presence.hm/m)
- src/i18n/locales/mk.json, en.json, sq.json, bg.json (new keys; tabPureProfit; remove econt/speedy)
- supabase/functions/api/index.ts (new GET /insights/work; /agent-activity additions; retire ?scope=calls and the calls block; server sentinels; comment fixes)
- supabase/migrations/<new>_insights_work.sql (insights_work + shared person-work rollup; re-create the insights_overview teams CTE on it; split insights_calls_and_movement; role_permissions manager call_activity; drop agent_activity)
- scripts/verify-insights-parity.mjs (drop the calls fields once the calls block is retired)

