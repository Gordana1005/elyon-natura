# /insights audit: completeness review (critic), 01.09–27.09.2026, MK only

This audit was read-only. I edited no repo file and changed no state. The SQL I ran is in `C:\Users\Mile\AppData\Local\Temp\claude\d--Dev-archives-elyon-natura\ba6c6515-0d2a-4518-b77a-a3e01748e84d\scratchpad\audit\critic\x1.sql` through `x10.sql`. The time window is Skopje days: [2026-08-31 22:00Z, 2026-09-27 21:59:59.999999Z].

## 1. Same month on every tab

| Figure (clock, basis) | Count | ден |
|---|---|---|
| Sales tab (created day, status confirmed/shipped/paid, price ×61,5) | 4.728 | 11.648.755 |
| Stock "top sellers" (same basis, item totals) | – | 11.648.837 |
| **Overview "confirmed"** (sale day, orders only, disposition rows excluded) | **5.733** | **13.937.455** (auditors saw 5.734 / 13.938.945; live data moved by 1) |
| Overview buckets on the placed clock (created day, sales only) | 5.693 | – (40 fewer than its own "confirmed" total) |
| Pure Profit cash (created day, status paid, price) | 4.148 | 10.176.707 (MEX COD on the same orders: 10.288.989) |
| Agents tab paid (paid window, UTC bounds) | 2.871 | €104.104,33 shown as "104.1k" (= 6.402.416 ден). 1.692 paid / €79.997,98 are silently dropped |
| Prediction lists "revenue" (created day, has a list id) | 623 | 1.731.271. Net shown 1.542.101. The ElyonCRM list cohort is 687 / 1.928.441 |
| Returns tab (created day, status returned, price) | 586 | 1.546.327 (COD 1.583.078). MEX returned in the period, all sources: 1.096 / 2.915.309 |
| MEX cash by delivery day, all parcels (= Overview delivered.proven_cod_mkd) | 6.376 | 15.439.008 |
| … of which linked to orders | 4.544 | 11.603.699 |
| … of which web shop (NTMK or claimed by a web order) | 280 | 477.803 |
| … of which MEX-only, not web | 1.552 | 3.357.506 |
| Web shop placed (card_unpaid excluded) / web shop sales (preparing, courier, delivered, returned, no_record) | 444 / 364 | 911.707 / 764.996 |
| MEX-only parcels created in September (not web) | 1.512 | 3.417.126 = delivered 1.160 / 2.556.958 + in flight 230 / 522.679 + returned 122 / 337.489 |

The true four-source sold value for September is about **18,12 M ден**: 13.937.455 from orders + 764.996 web + 3.417.126 MEX-only. The Sales tab shows 11,65 M, about 64% of that.

No two tabs agree on any figure. The only one that ties is Overview MEX cash (15.439.008) against the MEX register.

## 2. What the auditors missed (new findings)

**N1 [critical] — The cohort ignores MEX on cancelled AlterCPA orders.**
- 99 AlterCPA orders are cancelled or trashed in the CRM with no sold_at (69 "changed_mind", 30 with no reason). Each has an in-flight MEX parcel created in September (statuses 1/3/4/8/9/10/13), worth 299.940 ден.
- `is_sale` excludes them, so they are missing from every cohort, the Overview included.
- They only appear, back-dated, once mex-reconcile flips them to paid.
- Rule 2 (MEX decides) makes them "at courier" sales.
- Fix, in the shared cohort definition: a sale is also any row that is not disposition and has a linked MEX parcel; the bucket comes from the parcel status whenever a parcel exists.
- Inside the cohort, CRM status and MEX status agree today (x2.sql: 0 conflicts).

**N2 [critical] — Card payments in the web shop break the "cash = MEX COD" rule.**
- September has 48 web orders paid by card and delivered: shop total 108.721 ден, but MEX COD only 8.890 ден.
- Cash-on-delivery web orders tie exactly: 236 orders / 475.703 ден = MEX COD.
- Every proposal that says "cash = MEX COD only" loses about 100k ден a month.
- The Overview already contradicts itself here: web "cash" = 477.803 (MEX), web "collected" = 618.589 (shop).
- Needs an owner rule. Recommended: cash = MEX COD for cash-on-delivery; for card, the shop total when the payment status is PAID and MEX status is 2. Show card money as its own line.

**N3 [critical, coordinate with the Overview agent] — The Overview itself fails the cohort model.**
- Its MEX-only CTE (`mf`) keeps only `status_id=2`. It therefore drops 230 in-flight and 122 returned MEX-only parcels (860.168 ден) from Teleshop/Other.
- Its to-collect, at-courier and lost tiles run on the placed clock, while "confirmed" runs on the sale clock (5.693 vs 5.733), so its buckets cannot sum to its total.
- The auditors' guard "tab == Overview confirmed" would tie tabs to an orders-only number that excludes web and MEX-only.
- The tie target must be the new shared foundation, and the Overview rebuild should adopt it.

**N4 [major] — Unlinked BIO NATURAL parcels are filed as Teleshop.**
- BIO NATURAL is the Elyon account (series 9110 LEADS and 9103 LEADS-OUT). Its unlinked parcels go into teleshop_other: 301 created in September / 901.565 ден (229 / 663.387 by delivery day).
- Of the 173 in series 9110, 109 match a CRM order by phone within 21 days, and 43 match a CRM-cancelled AlterCPA order. These are most likely AlterCPA sales.
- 13 parcels across series match an open "to pack" sale with no parcel, so that sale is counted twice.
- Fix: split MEX-only by account and series on every tab. Label these "Elyon LEADS — unlinked", and add a phone-match candidate queue that stays read-only (no cron change).
- Owner decision: count them as AlterCPA?

**N5 [major] — Zero-value MEX-only parcels count as sales.**
- 80 MEX-only parcels created in September have COD ≤ 0, one of them −2.500. By delivery day it is 85.
- They count as sales at 0 ден. Exclude them from sale counts and show them as "0 ден пратки (замена)".

**N6 [minor, coordination] — Other sessions are already doing work the auditors proposed.**
- Another session is building `supabase/functions/collabbox-sync/` and `20260939000300_stamp_deciders_cron.sql`.
  - Do not duplicate the Agents proposal to schedule `backfill-order-deciders`.
  - Once collabBox imports resume, the collabBox / MEX-only split will shift. The foundation must dedupe by `mex_parcels.order_id`.
- Another session has modified `scripts/verify-attribution.mjs`, so new checks should go in a new script.
- The next free migration slot is **20260940000000** (20260939000000–000300 are taken).

**N7 [info] — Checks that passed.**
- Web: 351 of 351 September web parcels are claimed by a web order, and no web order is delivered without a MEX link, so there is no web double count today.
- /agent-performance is used only by AgentsTab. The `?scope=calls` slice carries no money. The courier fallback constants are used only by /management-insights.

## 3. Proposed fixes I challenge

1. **Pure Profit: "fix the courier CASE in 3 SQL twins".**
   - The SQL twins already return an "unknown" count, and TypeScript applies the rate.
   - Change only the `loadCourierRates` fallback (index.ts:1642-1692) to the `courier_rates` 'mex' row. Both engines stay in parity.
   - Do not replace `insights_orders_rollup`, `insights_paid_basis`, `insights_products` or `insights_channel_pl` in this pass: they feed the Payout tab (the agents/bonus block) and the parity harness. Build new RPCs instead.
2. **Sales: "exclude price ≤ 0".**
   - That drops a real MEX-proven 3.000 ден "Alpha Male" sale.
   - Rule instead: always exclude disposition rows. For other rows with price ≤ 0, value them at MEX COD when COD > 0 (flag "no price"); otherwise they are replacements, not sales. September cohort: 42 zero-price rows, 1 with COD.
3. **Sales and Profit: "cash = MEX COD only"** — see N2; it needs the card rule.
4. **Profit: MEX-only delivered 1.832 includes NTMK 280.** Web money must come from exactly one of the shop mirror or the claimed parcels, never both.
5. **Sales: MEX-only status 13 counted as returned.** "Rejected" is still at the courier until it becomes 7. The Returns audit and the CRM (7 shipped orders at parcel status 13) already treat it that way.
6. **Agents: join the bonus column into the new person rows by user_id.**
   - The 41 historic "name:" operators have no user_id, so the displayed bonus would change. Payouts are out of scope.
   - Keep the existing bonus table as a separate block, fed unchanged from /agent-performance.
   - Strip only revenue, profit, net and AOV for non-owners. Keep `payout_earned` exactly as it is today.
7. **Agents: "insights_overview teams block calls insights_people_block"** and **Returns: "add status 7 to the Overview mf"** — both edit an Overview being rebuilt by another agent. Hand them over as requests; do not build them in these packages.
8. **Changes to state or crons, all owner decisions, none of them build items:**
   - schedule the decider stamping (already in flight elsewhere);
   - mex-reconcile: record the pre-return status, restock or deduct stock;
   - the ghost-link fix (undecided);
   - collabBox importer changes;
   - backfill ORD-92536;
   - migrate `role_permissions` manager:agent_activity → call_activity.

   Standing rule: the cron jobs stay as they are. Until then the tabs show each gap on an attention rail.
9. **Margin Lab: "apply commission only to the commissionable share".** This changes how commission cost is modelled, and bonus work is deferred. For now keep today's commission total and label the floor "assumes commission on every package".
10. **Returns reason from the last pre-return MEX status.** That status is not recorded (the raw data holds only the current status), so this needs mex-reconcile changes (owner decision). Until then drop the reason card rather than show 100% "(unspecified)".
11. **Sales and Returns each propose a city key, and three packages propose different `product_aliases` schemas.** Use one of each:
    - `mk_city_key(text)`: MK transliteration, then `mk_settlements.name_norm`; prefer `mex_parcels.receiver_city` when a parcel exists.
    - `product_aliases(source, alias_norm, product_id NULL, kind product|gift|loyalty_point|delivery|note|flyer, reviewed_by, reviewed_at, PK(source, alias_norm))`, plus `product_key()` and `order_line_kind()`. It ships unseeded; seeding waits for owner review.

## 4. Fix list, de-duplicated (critical → minor)

**Critical**

| ID | Tabs | Fix | Package |
|---|---|---|---|
| C1 | All | One shared sale/cohort definition. Sale day = coalesce(sold_at, confirmed_at, created_at). Buckets are MEX-first (paid, at courier, packed, to pack, returned, cancelled after confirm) and sum to the total. Tabs use it instead of created_at + status. | WP0 |
| C2 | Sales, Profit, Margins, Returns, Stock; Agents via a reconciliation card | Include web shop and MEX-only (all statuses), split by account and series. | WP0 + each |
| C3 | Sales, Profit, Returns, Agents, Lists | Money: cash = MEX COD shown with formatDenari, plus the card rule (N2). Sold value = price via formatMoney. Unproven paid (43 / 101.670) on its own line. | WP0 + each |
| C4 | All | Disposition rows are never sales, orders, cancellations or money. The 9 ghost rows (9.640 + 9.000 ден COD) go on the attention rail. | WP0 |
| C5 | Profit, Margins | The BG courier fallback is replaced by the MEX rate: 440.902 ден of phantom cost removed in September. | WP0 (one line) |
| C6 | Profit | Cost coverage is 32% of packages. Add a coverage badge, "profit on costed packages", and aliases. | WP3 |
| C7 | Profit | Channel P&L is built on the prediction-first `order_channel` (the prediction row is 3,4× the lists figure; the affiliate card contradicts the affiliate row). Use P&L by the four sale sources. | WP3 |
| C8 | Lists | "Net" subtracts returns twice (−189.170). Remove it and use cohort buckets. | WP4 |
| C9 | Agents | The AlterCPA team is invisible; conversion shows 100%; clocks are mixed and bounded in UTC, and a custom range drops its last day. Rebuild on sales_people, sold_by_person_id and v_sales_work. | WP2 |
| C10 | Agents | Money reaches non-owners through /agent-performance, the UI gate and the CSV. Gate it on is_business_owner (bonus kept as is). | WP2 |
| C11 | Call activity | Untimed no-answer clicks count as calls (0,8% answered); the two blocks contradict each other. Rebuild on v_sales_work + no-answers + presence. | WP6 |
| C12 | Sales, Returns | Cities are split Latin/Cyrillic. Fold them with mk_city_key. | WP0 + each |
| C13 | Stock | Stock is placeholder data (ledger silent since 20.08). Show an "unverified since 06.08.2026" banner and hide days-of-cover and valuation. | WP5 |
| C14 | All (= N1) | 99 AlterCPA orders in flight at MEX (299.940 ден) are outside the cohort. | WP0 |
| C15 | Overview (= N3) | Coordination request to the Overview agent. | – |

**Major**

| ID | Tabs | Issue → fix | Package |
|---|---|---|---|
| M1 | All (= N4, N5) | Show MEX-only by account and series; exclude zero-COD parcels; add a double-count attention item. | WP0 |
| M2 | All | The page note `workClockFromAugust` is false. Delete it and put a clock caption on each widget. | WP0 |
| M3 | All | There are 4 period controls and 3 defaults; Agents uses UTC; dates show as mm/dd; "1 месец" is 32 days; switching tabs wipes the filters. Use one Skopje filter bar (dd.mm.yyyy) with URL params merged. | WP0 |
| M4 | Sales, Profit, Margins, Stock, Returns | Product names are not folded: loyalty points, notes and flyers count as packages (1.416 fake packages), gifts are mixed in, and there is no "unmapped" row. | WP0 schema + each |
| M5 | Returns | Reason is 100% unspecified (drop the card); cancellations are pre-sale lead outcomes (keep only "cancelled after confirm"); 269 MEX-only + 21 web returns are missing. Add a clock toggle: cohort vs MEX return day. | WP5 |
| M6 | Lists | No MEX cash and no buckets; a duplicate order loses its list (fix the duplicate endpoint); stale to-pack rows; no tie to the Overview; EUR on the chart axis. | WP4 |
| M7 | Agents | The same human appears twice; teleshop sellers have no person or team; no "sales without an agent" reconciliation; legacy source filter; a second profit definition; the status filter only covers one window. | WP2 |
| M8 | Call activity | The AlterCPA work ledger is missing; the timeline lists everyone on shift; managers have no access (owner decision). | WP6 |
| M9 | Sales, Lists, Agents, Warehouse | EUR on screen: chart axes in Sales and Lists, bare EUR in Agents' `fmt()`, and WarehousePage:793-794 showing cost and price to the warehouse role. | Each |
| M10 | Margins, Profit | Headline and per-product use different cost bases; unknown cost reads "над целта"; VAT fallback 0.2 and help text "1.2"; lead cost 0 unlabelled; VAT badge "pending confirmation". | WP3 |
| M11 | Stock | "Out of stock" really means not tracked; duplicate catalogue rows; packing queue unused (553 confirmed orders older than 14 days); valuation owners-only. | WP5 |
| M12 | Sales | Legacy `source_type` "По извор"; delivery-type card carries no information (replace with MEX account/series); ListCard hides counts and the "Others" row. | WP1 |
| M13 | Sales, Lists, Returns, Stock | Admins and managers get no operational counts; add a counts-only payload (stripOverviewMoney pattern). | Each + WP0 helper |

**Minor**
- Hardcoded English on every tab, including mk/sq `tabPureProfit`.
- Server returns English sentinel labels ("Unknown", "Others", "(unspecified)"); switch to `__unknown__` / `__others__` keys.
- Numbers use `toLocaleString` / `toFixed`; switch to the useOverviewFormat helpers.
- Range end is 1 s short (skopjeRangeEnd).
- No loading state on Call activity.
- KpiCard tones are light-only.
- Money tabs fetch the full aggregate.
- Harness role cannot EXECUTE the new RPCs; add the grants.
- List labels are English/EUR-coded: localize them for display, never rename in the DB.
- Lists: show "attribution starts 14.08.2026" and label members as "members now".
- BG leftovers to remove:
  - econt/speedy labels and keys
  - "Dual EUR/LEV" comment and the dead Money component
  - Sofia comments
  - ChannelStrip.tsx (dead)
  - `bigarena_import` reason (index.ts:9230)
  - `monadon_legacy` filter and "delivered" status branches in the new RPCs
  - stale `agent_activity` module key (owner decision)

## 5. Work packages (build in parallel after WP0)

**WP0 — Foundation and shell. Lands first; the others depend on it.**
- New migration `20260940000000_insights_foundation.sql`:
  - `insights_sale_rows(p_from, p_to_end)` over orders ∪ web_orders ∪ MEX-only, with C1/C3/C4/C14/M1 and the card rule: source, split, sale_at, MEX-first bucket, proven, value_eur, value_mkd, cod_mkd, cash_at, person, list, city_key, quality flags;
  - `insights_cash_rows`;
  - `mk_geo_norm`, `mk_city_key`;
  - `product_aliases` (unseeded), `product_key`, `order_line_kind`;
  - grants to service_role plus the read-only role, conditionally.
- New `supabase/functions/api/insightsCommon.ts` (+ test): windows via `overview.ts` overviewWindows, owner gate, money-strip whitelist.
- `index.ts`, edited by WP0 only:
  - route stubs for insights/sales, agents, profit, prediction-lists, returns, stock and work, each delegating to its per-tab module file (created empty here);
  - the courier fallback line.
- `src/pages/ManagementInsightsPage.tsx`, edited by WP0 only:
  - move every inline tab verbatim into its own file: `sales/SalesTab.tsx`, `PureProfitTab.tsx`, `PredictionListsTab.tsx`, `StockTab.tsx`, `ReturnsTab.tsx`, `CallActivityTab.tsx`;
  - mount the new `InsightsFilterBar.tsx`;
  - delete the page note.
- `src/contexts/PermissionsContext.tsx`: add a `money` flag.
- `src/lib/api.ts`: export `apiFetch` (one line). Tab clients then live in `src/lib/insightsApi/<tab>.ts`.
- Shared UI in `src/components/insights/shared/`: CohortBar, ClockCaption, QualityRail, SourceTable. They reuse overview/OutcomeBar and useOverviewFormat read-only.
- KpiCard dark tones.
- Common locale keys: sources, buckets, clocks, sentinels.
- New `scripts/verify-insights-ties.mjs`: Σ buckets = total; each tab's source totals = foundation totals; the orders part = Overview "confirmed".

**WP1 — Sales.** `supabase/functions/api/insightsSales.ts` (+test), migration `…0100_insights_sales.sql`, `src/components/insights/sales/*`.

**WP2 — Agents and teams.**
- `agentsInsights.ts` (+test), migration `…0200_insights_people.sql`, `AgentsTab.tsx`.
- In index.ts, only the /agent-performance handler region (~9750-10290), for the money strip. The bonus block stays untouched.

**WP3 — Pure Profit and Margins.**
- `profit.ts` (+test), migration `…0300_insights_profit.sql`.
- `PureProfitTab.tsx`, `MarginLabTab.tsx`, `ChannelPLCard.tsx` (→ P&L by source), `AffiliateBreakdownCard.tsx`, `PureProfitExportDialog.tsx`.
- `.grok/skills/elyon-logistics-costs`.

**WP4 — Prediction lists.**
- `predictionLists.ts` (+test), migration `…0400`, `PredictionListsTab.tsx`, `src/lib/predictionListLabel.ts`.
- Optional: the duplicate endpoint in index.ts (~7475-7507), so a duplicate copies `prediction_list_*`.

**WP5 — Returns and stock.** `returnsStock.ts` (+test), migration `…0500`, `ReturnsTab.tsx`, `StockTab.tsx`, `src/pages/WarehousePage.tsx`.

**WP6 — Work and calls.** `work.ts` (+test), migration `…0600_insights_work.sql`, `CallActivityTab.tsx`, `CallActivityTimeline.tsx`, `src/components/activity/AgentTimeline.tsx`.

**Shared files that cannot be avoided**
- `supabase/functions/api/index.ts`, `src/lib/api.ts`, the four locale files and `scripts/verify-attribution.mjs` are currently being modified by another session. Check `git status` before editing.
- index.ts regions: WP0 routes and courier fallback; WP2 /agent-performance; WP4 duplicate endpoint.
- Locale edits: serialize them, or give each package its own `insights.<tab>.*` namespace, merged by the orchestrator.
- Read-only for every package: `overview/*` components and `insights_overview` (Overview agent).
- Nobody edits the old rollup RPCs. /management-insights stays for Payout and the parity harness until all tabs have switched.

**Owner decisions, not build items**
1. Card-paid web cash rule (N2).
2. Whether unlinked BIO NATURAL 9110/9103 parcels count as AlterCPA (N4).
3. VAT rate.
4. Cost prices, alias seed review, duplicate catalogue merges.
5. Lead-cost rates.
6. A Teleshop team and mapping of the unmapped collabBox authors.
7. mex-reconcile: ghost fix, pre-return status recording, stock from MEX events.
8. Managers' access to Call activity.
9. Whether agents may see their own sold value.
10. Whether MEX bills the outbound fee on returns.
11. Calendar-month presets.