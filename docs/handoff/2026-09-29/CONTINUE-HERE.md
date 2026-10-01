# CONTINUE HERE — 29.09.2026 (written ~05:00 Skopje, before the 08:00 shift)

> **Updated 01.10.2026:** the newest work is § "DONE 30.09–01.10" and § "🔜 NEXT" (what waits for the owner).

The owner's order (29.09, ~04:30), in his sequence:

1. Finish the open tasks first.
2. Make every source refresh at least every 15 minutes, with MEX (NATURA + BIO NATURAL) as the
   final proof.
3. Import everything from everywhere.
4. Verify everything live, then test again.
5. Only then rewrite the docs:
   - `CLAUDE.md` (= agents.md);
   - `MEMORY.md`;
   - `docs/`;
   - the skills.
6. Audit the Insights, Табла (Dashboard) and Операции tabs: synced, accurate, in the new style.
   Fix or remove the outdated parts.
7. Stock is NOT a focus: the placeholder of 1.000 stays until he sends the count.

Verified facts for the docs are in `docs/handoff/2026-09-29/FACTS.md`.

---

## ✅ Done and pushed

**Migrations (MK, 254 applied):**
- `20260942000900`: the collabBox sync, live.
- `20260942001000`: six departments.
- `20260942001100`: departments by folder, no team override.
- `20260942001300`: every source every 15 min.
  - MEX runs both accounts every 15 min, 06:00–22:59.
  - collabBox runs a full pass every 15 min, 07:00–22:59, plus the nightly at 00:00.
  - The headers-only `collabbox-live` job is retired.
- `20260942001400`: freshness follows the new schedules.
  - `collabbox_feed_state`: stale = the run that should have finished did not.
  - `integrations_health`: MEX expect `daytime_15m`; the collabBox card gets its run log.
  - `insights_overview`: the MEX window uses the new schedule.

**Commits:** `20ad77d`, `b073008`, `29a2ca1` and `d058832` (the CLAUDE.md department law + the 15-min rule).

**Data pulled by hand, 04:34–04:50:**
- MEX 60-day sweep, both accounts:
  - 17.986 parcels;
  - 32 → shipped;
  - 2 → paid.
- AlterCPA status sync: 755 scanned, 18 callbacks.
- AlterCPA weekly 90-day sweep: started 04:48. The `altercpa-sync-continue` cron works through it.
  - It is the first weekly since the resumable sweep. The Sunday runs had failed since 16.08.

**Checks, 01–28.09, 04:40:** all PASS:
- `engine-fixture-mk`;
- `verify-insights-ties`;
- `verify-tab-sales`, `-agents`, `-profit`, `-lists`, `-returns` and `-work`.

`verify-attribution` passes except C7 (37) and C8b (14), the known AlterCPA leftovers (owner items below).

**September 01–28 cohort by department** (sale day; includes MEX-only parcels and web):

| Department | Sales | Денари |
|---|---:|---:|
| Affiliate – Lead in | 2.391 | 7.153.500 |
| Affiliate – Lead out | 834 | 2.367.046 |
| Телешоп – Lead out | 2.172 | 4.987.661 |
| Телешоп – Lead in | 1.387 | 2.864.465 |
| Социјални мрежи | 225 | 424.560 |
| Web | 447 | 940.504 |
| **Total** | **7.456** | **18.737.736** |

## ✅ Done since (29.09, 05:00 → 09:10) — all applied, deployed and pushed

- **05:10 Leaderboard v2 LIVE** (`145645c`, migration `20260942001200`): one row per agent split by
  department; `verify-leaderboard-v2` 22–29.09 PASS on the live function; live smoke 28.09 → 65 people,
  109 sales (108 credited + 1 no seller). Integrations words for the 15-min schedules in the same commit.
- **05:10 cross-channel parcels** (`3ed28e4`): mex-reconcile guard deployed (a dead lead is revived
  only by its own folder's parcel — AlterCPA 9110, CRM 9103) + repair run `a057bc52`: 145 AlterCPA
  leads the old reconcile had revived on NATURA teleshop / social parcels went back to cancelled /
  trashed. **08:46: their 125 collabBox documents re-applied** (run `4cdb427f`) → each is now its own
  teleshop / social order with its seller (16 more were created by the backfill). Listed for the owner:
  47 same-day + 84 imported links (CSV `exports/repairs/cross-channel-parcels-2026-09-29T03-04-29-167Z.csv`).
- **AlterCPA weekly 90-day sweep** done 05:11; **collabBox history backfill 06.04 → 26.09** done 08:03
  (0 errors); crons every 15 min running since 06:07 (MEX) / 07:00 (collabBox, AlterCPA status).
- **08:53 Orders list** (`6e8bd8f`, migration `20260942001500` order_departments): every order shows its
  SELLER (the sold_* stamp — a collabBox order was "confirmed by System (collabbox-sync)") and its
  DEPARTMENT as the source chip (intake under it). confirmed_by_* untouched (payouts deferred).
- **Operations day boundary** fixed (Skopje day, same commit).
- **09:00 Табла for admins = the Insights Overview** (`981051b`): the old CEO view (CRM statuses by
  created UTC day, "revenue" = shipped + paid, assigned-agent rankings, paging all orders) is gone.
- **09:02 Операции** (`3463311`): today = the sale cohort of the Skopje day (sales by department, to
  pack, MEX money collected), MEX returns today; per agent the day's credited sales + worked decisions
  from leaderboard_day_v2. Money tiles only for owners.
- **09:06 Order window "Origin and proof"** (`b406bc4`, `703976b`, migration `20260942001600`
  order_origin): department, intake, seller, sold at, AlterCPA decision, collabBox document, CRM price
  vs MEX COD, MEX profile / tracking / status / created / delivered / returned / receiver.
- **Pure Profit cache** force-refreshed (6 months) after the backfill.
- **09:18 collabBox nightly-mode run** (26–28.09, ok) — every feed green (AlterCPA, MEX ×2, web, collabBox).
- **09:25 Customer 360** (`b19a069`, migration `20260942001700`): order badges show the department.
- **Checks 09:00:** September + July — engine fixture, insights-ties, tab sales / agents / profit /
  returns / work, leaderboard-v2: PASS. verify-attribution: only the known C7 (Sep 37; Jul 655 = the
  11.08 "cancel(other) before August = paid" ruling, report only) and C8b (Sep 14, Jul 1).
  tab-lists L8 off by 1 member = the live recompute (flicker).

## ✅ Done 29.09 afternoon (after the second usage limit; all pushed + deployed)
- **09:25–09:40** layout grey void fixed (`81f4182`); login lands agents on /calls, admins/managers on
  /insights — the permission-loading race that sent every agent to /assigned (and prediction agents
  into a white redirect loop) fixed; /start + homePath + no-access screen + AppErrorBoundary + chunk
  reload; "Assigned to me" retired → /calls (`6fbbcd5`).
- **11:40 → 12:20 department rule, final: the MEX PROFILE decides.** The agent-team rule (`c7c6e42`,
  `…1800`) was WITHDRAWN once the owner saw the CRM sales ship 98% via BIO NATURAL: BIO NATURAL = affiliate
  in/out, NATURA = teleshop / social / web. `…1850` reset the overrides; `…1860` (`1f4d928`): a CRM-made
  sale follows its parcel profile (BIO NATURAL → Affiliate – Lead out, NATURA → by series, no parcel →
  Affiliate – Lead out until MEX), MEX-only BIO NATURAL parcels always affiliate. The Prediction-lists tab
  holds the list sales of every department (kept from `…1800`). September: Affiliate – Lead out 842 /
  2.393.446 ден, Телешоп – Lead out 2.292 / 5.246.701 ден, total unchanged.
- **11:45** order origin money owner-only (`edfa901`).

- **12:05 docs + skills** (`1726025`): CLAUDE.md (MEX-profile law, one calculation, 15-min rule,
  collabbox-sync live, stock deferred), new skills `elyon-departments-and-sources` + `elyon-collabbox-sync`,
  8 skills and 7 docs brought to 29.09. Integrations collabBox card reads like the other feeds (`4e3ad2e`).
- **12:20 owner questions** (`8d9efb8`, `PRASHANJA-ZA-MILE.md`): + 1ж, the seller names with no person
  (Dance Krstevska 188, Simona Krstevska 132 — old AlterCPA, collabBox names another author; Kristina
  Ilievska 122 social). The stamping-gap probe found NO gap in the LEADS / LEADS-OUT credit.
- **12:40 hygiene** (`5cd01e9`, migration `20260942001870`, applied): 14.674 paid orders with their own
  delivered MEX parcel now carry `paid_basis = 'mex'` — the DO block refused on any bucket move; none
  moved. Left NULL on purpose: 3 web-claimed + 4 fact-less parcels (their basis decides their bucket).
  C8a: a date-narrowed run no longer calls the 3 owner-accepted August pairs "stale".

- **13:05 collabBox BOOKINGS count the moment they are booked** (`aabc5f5`, migration `…1900`, api
  deployed first): a document booked without its MEX parcel is a cohort sale (kind 'booking', to pack,
  folder's department, its author, document amount, ≤ 14 days old, never a CRM/AlterCPA sale's copy — phone
  + amount within 14 days back / 2 forward, or the author's own sale within 10 min). `total.orders` stays
  real orders, so /orders drills stay exact. Today 275 sales / 675.081 ден of which 138 booked; September
  7.973 / 19.977.478 ден of which 140 booked. Remaining risk: a no-phone LEADS-OUT copy booked > 10 min
  after its CRM sale counts twice until the parcel (~180 of 685 since 15.08) → owner question А6.
- **13:30 Call activity lists booking authors** (`e7db35f`, migration `…1910`): a seller whose only sales
  are bookings gets her row (Sofija Kuculovska, 5 bookings, no team).
- **Checks after 1900/1910:** engine fixture, insights-ties, every tab-* (Sep + today), leaderboard-v2
  22–28, attribution C1 01–28: PASS. Today-window failures were live races by one decision (W2/W8/L1/C1)
  and pass on closed days. Open: C7 37 / C8b 14 (owner items А1 / М3).
- **13:20 the owner's questions by department** — PDF `exports/prashanja/Prashanja-po-oddeli-2026-09-29.pdf`
  (17 pages, 45 questions: Affiliate · Телешоп · Социјални · Магацин · Финансии · Надворешни · За тебе),
  generated from `scratchpad/prashanja/content.mjs` + `gen.mjs` together with its Markdown twin
  `PRASHANJA-ZA-MILE.md`; the review lists per question in `exports/prashanja/Prilozi-prashanja-2026-09-29.xlsx`
  (customer PII — gitignored).

- **13:40 attachment workbook** `exports/prashanja/Prilozi-prashanja-2026-09-29.xlsx` (11 sheets, one per
  question; scripts `scratchpad/prilozi/build.mjs --refresh`). The PDF was regenerated with its numbers:
  - wrong-size aliases: 64 (30 with sales, 804.851 ден), plus 39 set/gift names and 8 different-measure
    names to confirm;
  - М4: 37 re-sent orders / 38 old parcels;
  - М5: zero-COD parcels are web 41 · teleshop 75 · affiliate 12 · social 2;
  - the two NEGATIVE CODs are refunds: 3369589 −2.500 ден = ORD-94295, which still counts as paid;
  - 28 zero-COD web-series parcels went to shops (СТОРС, ДМ), i.e. B2B;
  - А2: only 4 of 23 have a collabBox author.
- **14:10 Overview on one calculation** (`2c29907`, migrations `…1920` + `…1930`, both applied):
  - source trends = the cohort's sales per department by sale day (the spark carries `by_source`);
  - teams board = the Agents tab's TeamsPanel on the same query;
  - drill-down hidden until it is rebuilt on the cohort;
  - old fallback tiles gone;
  - attention amounts in денари from the MEX COD, and collabBox judged by its live feed state;
  - the compare request is gone;
  - the lists tie note is fixed and dead files are removed.

  Checks: npm test 1.199 pass, build OK, insights-ties Sep + today PASS, tab-lists PASS, engine fixture intact;
  attribution only C7 37 / C8b 14 (owner items А1 / М3).

## ✅ Done 29.09 evening (all pushed + deployed)
- TV board fits every screen: cards below 1024 px (`c29a027`); "+N чекаат пратка" (`8cd53e3`).
- TV board Web view: the shop itself, live (`818ba48`, `…1940` `leaderboard_web_live`, `…1945` Integrations web
  "every 5 min"); web-sync every 5 minutes.

## ✅ DONE 30.09 — the APPROVED plan is LIVE (`1982b0e` backend + `9a2978b` UI; DB 277 migrations, latest `…1970`)
Owner 29.09: Assigner redesign + live agent board + lists by BUYER department + web counted like the shop + /users.
- **Assigner:** live board of ALL profiles (online first; pendings · call-agains · list clients; 5 s poll + Realtime
  `assigner`), department chips, KPI tiles, tabs with one DistributeBar (count 20/50/100/200/Сите/друго, total shared
  or per agent, newest/oldest/random, server dry-run preview, confirm). SQL `assigner_board` / `customer_departments`
  / `assigner_lists` / `assigner_list_members` / `assigner_distribute` / `assigner_call_agains` (`…1950`–`…1970`);
  api `GET /assigner/board`, `GET /assigner/lists`, `POST /assigner/distribute`. `scripts/verify-assigner.mjs` 8/8.
- **Web:** "чека потврда" counts everywhere (`…1965`); TV web view = the cohort's web part every day since
  01.01.2026, gap 30.07–03.09 from MEX parcels (`…1967`); TV date picker; web-sync every 5 min.
- **/users:** Insights-style page, search Cyrillic ⇄ Latin, filters, cards below 1280 px.
- **Every screen:** phone sidebar = ☰ drawer; compact top bar below 1024 px.
- Checks: 1.307 tests, build, Playwright 360–1920 px (0 overflow), a production smoke test (dry-run only — the first
  REAL distribution is Mile's). Skills `elyon-assigner` + `elyon-web-shop-bridge` and CLAUDE.md updated.
- Known, not ours: `GET /voip/health` answers 500 (telephony deferred; the superadmin banner calls it). *(Fixed
  30.09: the banner no longer polls while VOIP is off.)*

## ✅ DONE 30.09–01.10 — the plan "CRM-от по аудитот од 30.09" is LIVE (DB 299 migrations, latest `…1700`)

Plan `~/.claude/plans/revert-the-421-unproven-encapsulated-brook.md` (12 phases from an 11-agent read-only audit;
owner decisions of 30.09). Built overnight by parallel worktree agents, each branch merged, applied, deployed and
checked live by the lead. Commits `47620bd` → `82755b4` on `main`.

- **Phase 0** (`47620bd`, `…0100` / `…0200`): **shifts are the login gate** (kept by the owner) — `shifts_roll_forward`
  / `shifts_runway` / `shifts_runway_alert` (cron `shifts-runway-alert`, 17:05 Skopje); **October rolled forward: 33
  agents, 1.005 person-days** (the September roster ended 30.09; from 03.10 nobody could have logged in). `POST /orders`
  fills the product of a /calls cancel / trash record from `last_sale_product` (last-8). Warehouse PATCH refuses
  status; DELETE admin-only + audited.
- **Phase 1** (`bb9d015`): `scripts/repair-disposition-products.mjs` repaired **7.116** records (run `1c8ee475`).
- **Phase 2** (`1b2d535`): menu cleanup — hidden (routes kept): missed-calls, voip-health (shown only with
  `useRealVoip`), inbound-leads, webhooks, lead-distribution, affiliates-admin; /import-orders → /orders (`POST
  /orders/import` kept for scripts), /search-prediction → /, /predictions → /segments; dead page files deleted; the
  VOIP banner no longer polls while VOIP is off. М6 in `PRASHANJA-ZA-MILE.md` corrected (the MEX push was never built
  before 01.10).
- **Phase 3** (`bc4bad0`, `…0900` / `…0950`): **teams = business lines** — `sales_teams.kind` / `sort_order`, teams
  `teleshop` / `affiliate`, `sales_team_members.lane` (in / out / social), `sales_team_line_proposal` /
  `sales_team_lines_apply`, `sales_team_filter_matches` (team:lane, legacy aliases); `apply-team-lines.mjs`,
  `verify-teams.mjs`. 82 people re-keyed for the whole history; 17 wait for the owner. Departments are NEVER decided
  by team (T3). TV links per line and lane (`64222c1`).
- **Phase 4 + Производи 2.0** (`d3e3358`, `f77c161`, `2d84a15`, `8a8508f`; `…1300` / `…1400` / `…1410`):
  `products.brand_line` (natura_therapy / bio_natural / ad_astra / dr_becker) + `mex_profile_for_line()`;
  `products.kind` (product / bundle / gift / other); the audited writers `products_set_brand_line` /
  `products_set_kind` behind guard triggers; scripts `apply-brand-lines`, `map-web-catalogue`, `apply-product-kinds`,
  `clear-product-machine-text` (493 machine descriptions cleared, backup `products_description_backup_20261001`).
  Owner rule: everything on naturatherapy.mk is Natura Therapy or Ad Astra (`/adastra-nutrition`); Bio Natural never on
  the web. /products opens on active products of kind "product". Live: lines NT 438 · AA 123 · BN 27 · undecided 118;
  kinds product 359 · bundle 244 · other 68 · undecided 35.
- **Phases 5–7** (`bdd6527`, `b6ec0ff`, `396b406`, `9f50c12`; `…0500`, `…0600`, `…0700`, `…0710`, `…0711`):
  `mk_settlements` fixes, `orders.settlement_id` + `mex_zone_basis`; ONE resolver `mex_zone_for_settlement` /
  `mex_zone_for_name` (altercpa-sync uses it too, redeployed); `customer_profile_merge` (fill-only). The new Create /
  Confirm / Edit order modal: city required, district required for Скопје, automatic postcode, "За курирот" = MEX
  Opis, an internal note, birthday / gift removed; the address locks once a parcel exists. `verify-address-routing.mjs`.
  `scripts/repair-open-order-zones.mjs` NOT applied (below).
- **Phase 8** (`ca3dbed`, `…1000` / `…1100`): one "Смени" page — `shift_assignments.shift_date` UNIQUE per
  person-day (700 double-booked days cleaned, backup `shift_assignments_removed_20261001`), `shift_login_logs` SET NULL;
  RPCs `shifts_grid` / `set_cells` / `copy_range` / `shift_update` / `statistics` / `login_activity`; check-login writes
  the login log itself and returns refusal codes (tested live with `pregled.agent`, cleaned up); logouts now record;
  `/my-shifts` → `/shifts`; `verify-shifts.mjs`.
- **Phase 9** (`83b32a4`, `db69801`, `26d8328`; `…1200`, `…1210`, `…1220`): `mex_push_attempts` ledger,
  `orders.mex_sent_at`, link method `push`; **`app_settings.mex_push` OFF** (0 attempts); `warehouse_queue` (send /
  pack). **MEX 8 = за пакување:** reconcile never ships at 8, the collabBox writer makes an at-8 document a confirmed
  order with `mex_sent_at`, the Overview "packed" = MEX 8. /warehouse = Испрати до MEX · За пакување · Залихи · Попис ·
  Движења; no printing (the MEX portal does it). The 11:00 auto-send is built, not scheduled.
  `scripts/repair-shipped-at-mex8.mjs` NOT applied (below).
- **Phase 10** (`5b6756e`, `…1500`): `/settings/:section` with grouped sections; audited api writes (`PUT
  /settings/modules`, `/role-permissions`, `/privacy`); the browser write policies dropped, `app_settings` /
  `courier_rates` writes narrowed to admin; the MEX courier rate is saveable.
- **Phase 11A** (`11ad7b3`; `…1600` / `…1610` indexes, `…1620` cron `active-call-views-cleanup`): /orders opens on
  "Нарачки"; chips Нарачки / Отворени лидови / Откажани / Во корпа / Сите; department, seller and MEX filters; last-8
  phone search; Skopje days; one active-views read per page.
- **Phase 11B** (`0711fb7`, `…1700`): `POST /calls/outcome` (status + one `call_logs` row `source='handset'` +
  obligation + list member); the one-tap outcome bar (Не одговара with Undo / Повторно / Откажа / Корпа / Потврди, keys
  1–5); a `tel:` link on phones while VOIP is off; `/call-again` → `/calls?queue=call-again`; `GET /calls/call-again`,
  `GET /calls/progress`. `CallAgainPage` and `ChooseAnswerButton` removed.
- **Today + arrows** (`c31d7c8`): Insights (Табла included) and /orders default to TODAY with ← / → (`stepRange`,
  `PeriodStepper`).
- **Terminology** (`42318d3`, `82755b4`): prediction = "предикција" (never "прогноза"); a leads team / queue =
  "лидови" (never "на чекање"); "На чекање" only for the order status pending.
- **Docs + skills** brought to 01.10: CLAUDE.md, MACEDONIA-STATUS.md, this file, 8 skills and the new
  `elyon-products-catalogue`.
- Not built from the plan: the `…0400_idle_crons` migration (the `lead-auto-distribute` cron still ticks every minute;
  the engine is stopped, `is_active = false` since 16.09) and `scripts/verify-dispositions.mjs`.

## 🔜 NEXT

### Waits for the owner (built — nothing is applied or switched on without his OK)

1. **The 17 team decisions** — Settings → Teams → **Предлог** (`sales_team_line_proposal`; the sure rows were applied,
   the likely / decide rows are his). Proposed Телешоп лидови: Чима, Кипровска, Марија Темелковска, Ангела Ристеска.
2. **The MEX 8 repair (~260 orders)** — orders still `shipped` while their parcel is at MEX 8 (260 on 01.10):
   `node --env-file=.env scripts/repair-shipped-at-mex8.mjs --preview` → dry run (CSV) → his OK → `--apply --run <id>`
   in the quiet window (after 20:55) → `--rollback <id>` if needed. The Overview already counts them as packed.
3. **Turning the MEX push on, plus the mixed-basket rule** — the admin card on /warehouse
   (`app_settings.mex_push`, global + per account). Before: his rule for a basket with Bio Natural AND Natura products;
   collabBox gets NO document when the CRM ships directly; add `mex_push` to `trg_app_settings_guard_owner_keys`; a
   NATURA push carries our order number (no series), so it lands in Телешоп – Lead out (`elyon-departments-and-sources`
   §3c). The 11:00 auto-send stays unscheduled until he says so.
4. **The open-order zone repair, from 03.10** — `scripts/repair-open-order-zones.mjs`: dry run → his OK → `--apply
   --run <id>` (touches only `district_fix` + `cross_city_fix`: 6 + 17 in the rolled-back run of 01.10); the 425
   `needs_pick` (Скопје with no district) are for people to pick, never the script.
5. **The 30 postcode outliers** — `verify-address-routing.mjs` R4 WARN: settlements whose code no neighbour shares
   (GeoNames same-name codes; MEX routes by zone, not postcode). His review.
6. **The 35 uncertain gift products** — /products → Предлог → Вид (60–90 % free, or too few lines).
7. **The 22 products that are Bio Natural by parcels only** — /products → Предлог (also the mixed / conflict rows and
   which products are Dr.Becker; none is yet).
8. **Карпош / Драчево postcodes** — the plain "Карпош" row is Кичево's neighbourhood (67 km from Skopje) and stays
   there; Драчево is now 1020 (was 2436) — GeoNames also lists 1050 "Skopje-Dracevo": if he confirms 1050, the whole
   Dračevo cluster moves together.
9. **The 10.08 no-cooldown rule vs callback parking** — the lead rules (`docs/LEADS_PORT_GUIDE_MK.md` D12,
   `elyon-assigner` #9–10: on a lead the customer waits for us — no cooldown, call-backs stay visible) against
   "Повторно" with a time on /calls (`next_call_after`). Nothing hides a callback today; he decides before any "ready
   only" filter.

### Then

0. **The rest of the CRM in the Insights style, page by page** (owner 30.09). Rebuilt so far: the Assigner, /users,
   /orders, /calls, /warehouse, /settings, /shifts, /products, the order form. Apply the UI law (cards below md, zero
   overflow, screenshots 360–1920 px). The admin password `mile@elyon.com` is still the VAULT one marked ROTATE —
   remind Mile.
1. **The owner's answers** to `PRASHANJA-ZA-MILE.md` / the PDF. Apply them: А1 cancel/link, А2 credit, А3/А4
   department, А5 link, teams (Т1, С3), catalogue (М2), stock count (М1), costs (Ф1–Ф3), etc. (О12 hide pages: done
   30.09.)
2. **Bonus / payouts:** the owner sends the new rules. Nothing was changed.
3. **Tidy-ups found by the audit (no figure changes):**
   - slim `insights_overview` (it still computes teams / KPIs / sources / placed series the UI no longer
     reads, costing DB time on every Overview and Табла view);
   - remove `GET /management-insights` and the old `apiGetManagementInsights` / `InsightsResponse`;
   - prune the unused `overview.*` locale keys, listed in the agent report (`overview.sources.*`,
     `overview.pivot.*`, `overview.kpi*`, `overview.teams.col.*` …);
   - fix the `insights_lists` SQL comment about the withdrawn team rule;
   - the Overview drill-down: `DrillPivot` was deleted 30.09 — rebuild it on the cohort only if wanted;
   - the stale docblock in `src/pages/Orders.tsx` (~L129) still says "last 7 Skopje days" (the default is today);
   - the `lead-auto-distribute` cron is a no-op while the engine is stopped — unschedule it if the owner agrees.
4. **Data anomaly to check:** ORD-95297 (AlterCPA, cancelled) holds the web-shop parcel NTMK62345 (COD 4.400).
5. Bookings have no product lines or city (Sales / Stock tabs show them under "no line" / unknown city).

## 🧑‍💼 Open owner items (decisions only he can make)

**AlterCPA orders**
- **C7: 74 AlterCPA "paid" without MEX proof.**
  - 68 are "manual": the phone's parcels belong to another order and the COD does not fit.
  - 6 now have a parcel. A dry run exists: `exports/repairs/altercpa-unproven-paid-2026-09-29T02-40-46-103Z.csv`, script `scripts/repair-altercpa-catchup-paid.mjs --population unproven-paid`.
  - The Insights show them as `paid_unproven`, never as cash.
- **AlterCPA "cancelled, then shipped by MEX": 73 September sales have no seller.**
  - The operator cancelled the lead in AlterCPA and MEX then shipped it.
  - The seller rule is pending (Александра Христовска case).
  - The backfilled collabBox LEADS documents may credit some of them; re-check after the backfill.
- **C8b: 14** orders point at a tracking id MEX never reported. 17 parcels are listed for a human.

**People and teams**
- Teams are business lines since 30.09; the open team / lane choices (the Lead-in callers Чима, Ристеска,
  Кипровска included) are the 17 rows in Settings → Teams → Предлог (NEXT 1).
- 5 logins had no team on 29.09 — re-check after those decisions (`verify-teams.mjs` T1).
- AlterCPA #4531: who is it?
- Is Milijana = "Милјана Тодоровска н."?
- Should the manager accounts (Nina / Dragana) appear on the board?

**Catalogue and costs**
- Product kinds and brand lines: NEXT 6 and 7.
- 16 unsure catalogue groups.
- ~53 older aliases map to a product of the wrong pack size.
- Cost prices, the lead price per webmaster, the MEX return fee.
- The stock count (deferred).

**collabBox**
- The komitent-card lookup returns 0. Phones come from the parcel.
- Social history before March has no MEX data and was not imported.
