# Elyon CRM — Macedonia (Natura Therapy MK)

This repo is a **hard fork** of the live Bulgarian Elyon CRM, run as a separate Macedonian
operation. It shares **nothing at runtime** with Bulgaria (own repo / own Supabase / own Vercel).

> **Why the infrastructure says "macedonia".** The fork was stood up on 2026-06-30 for Macedonia, then
> re-aimed at **Macedonia** on 2026-07-31 because that project was already clean. The Supabase
> ref, Vercel project and GitHub repo names were deliberately kept — renaming them buys nothing
> and breaks the deploy links. **The market is Macedonia.** (Supersedes `MACEDONIA-FORK-STATUS.md`.)

> 🛑 Never run any command in this repo against the live BG Supabase ref
> `sxymaloycddnoxudxaqp` or the domain `elyoncall.com`. Run
> **`node scripts/assert-mk-target.mjs`** before any state-changing command.

---

## 🟢 Current state: 29.09.2026

> Where to continue: **`docs/handoff/2026-09-29/CONTINUE-HERE.md`**. The owner's open decisions (in
> Macedonian): **`docs/handoff/2026-09-29/PRASHANJA-ZA-MILE.md`**. Verified facts:
> `docs/handoff/2026-09-29/FACTS.md`.

- **Supabase:** 261 migrations, latest `20260942001870`. Since the 28.09 release:
  - `…0900` collabBox sync (live);
  - `…1000` six departments;
  - `…1100` departments by folder;
  - `…1200` leaderboard v2;
  - `…1300` every source every 15 min;
  - `…1400` freshness follows the schedules;
  - `…1500` `order_departments`;
  - `…1600` `order_origin`;
  - `…1700` Customer 360 names each order's department;
  - `…1800` the agent-team department rule, WITHDRAWN the same morning. `…1850` reset it, and it
    keeps the `orders.dept_override` slot and the 4-arg `cohort_order_source`;
  - `…1860` **the MEX profile decides**: a CRM-made sale on BIO NATURAL → Affiliate – Lead out; on
    NATURA → by series; a MEX-only BIO NATURAL parcel is always affiliate;
  - `…1870` hygiene: `paid_basis = 'mex'` on 14.674 MEX-delivered paid orders (no figure moved).
  - `…1900` collabBox bookings in the cohort: being built, not applied yet.
- **Edge functions:**
  - `api` redeployed 29.09 (after `…1860`);
  - `mex-reconcile` 29.09 05:05 (folder guard);
  - `collabbox-sync` 28.09;
  - `altercpa-sync` / `web-sync` unchanged.
- **Frontend, 29.09 afternoon:**
  - login lands agents on /calls and admins/managers on /insights (`/start`, `homePath`), fixing
    the permission-loading race that sent agents to /assigned into a white loop;
  - "Assigned to me" retired;
  - no-access screen + error boundary + chunk-reload guard;
  - the grey void below the Insights tabs is fixed (`relative` on the layout frame).
- **Six departments, by the collabBox FOLDER and the MEX profile** (owner law 28–29.09, whole history):
  Affiliate – Lead in · Affiliate – Lead out · Телешоп – Lead out · Телешоп – Lead in · Социјални мрежи ·
  Web. See CLAUDE.md and the skill `elyon-departments-and-sources`.
  - September 01–28 (cohort re-read 29.09 12:44, after `…1860` and the collabBox history backfill;
    bookings not yet counted):

    | Department | Sales | Денари |
    |---|---:|---:|
    | Affiliate in | 2.416 | 7.234.431 |
    | Affiliate out | 842 | 2.393.446 |
    | Телешоп out | 2.292 | 5.246.701 |
    | Телешоп in | 1.447 | 2.998.655 |
    | Social | 227 | 425.710 |
    | Web | 472 | 999.054 |
    | **Total** | **7.696** | **19.297.997** |
- **Every source at least every 15 min, MEX both accounts = final proof:**
  - MEX: every 15 min, 06:00–22:59;
  - collabBox: a full pass every 15 min, 07:00–22:59, plus 00:00;
  - AlterCPA: every 2 min, and every 5 min for statuses;
  - web: every 15 min.
- **One calculation everywhere:**
  - Табла for admins = the Insights Overview;
  - Операции counts today from the cohort and the TV board;
  - TV leaderboard v2 = one row per agent split by department, managers shown not ranked, no bonus;
  - Orders list shows each order's seller and department;
  - the order window shows "Origin and proof";
  - Customer 360 badges show the department.
- **Data, 29.09 night–morning:**
  - collabBox history 06.04 → 26.09 read through the sync (0 errors);
  - AlterCPA 90-day sweep;
  - MEX 60-day sweep, both accounts.
- **Repairs, 29.09:**
  - `cross-channel-parcels` `a057bc52`: 145 AlterCPA leads that the old reconcile had revived on
    NATURA teleshop / social parcels were reverted;
  - their 125 collabBox documents were re-applied as their own orders (run `4cdb427f`);
  - Pure Profit cache refreshed.
- **Checks, 29.09 09:00, September and July:** engine fixture, insights-ties, every verify-tab and
  verify-leaderboard-v2 PASS. The only open ones:
  - `verify-attribution` C7 / C8b are the known AlterCPA leftovers and the 11.08 ruling;
  - lists L8 flickers while lists recompute.

  1.169 tests pass (7 Insights tests time out only under parallel load).
- **Deferred by the owner:** payouts / bonus (new metrics coming); costs and lead cost; stock count
  (placeholder 1.000).

## 🟢 Earlier state: 28.09.2026 release

> How the system works now: **`docs/how-it-works.md`**. Steps still to do and what to check:
> **`docs/handoff/2026-09-28/FINISH-FROM-VSCODE.md`**.

- **Supabase:** 243 migrations applied, latest `20260942000300` (teleshop import ledger). Applied 28.09:
  - stamping cron `20260939000300`;
  - test-phone list `…000700`;
  - Insights foundation `20260940000000`;
  - resumable AlterCPA sweeps `…0100`;
  - MEX upsell revive `…0200`.
- **Edge functions:** `api`, `altercpa-sync` and `mex-reconcile` redeployed 28.09. `web-sync` and `collabbox-sync` (probe only) unchanged.
- **Frontend:** the Insights/Overview cohort UI is on branch `claude/epic-ride-8fhxhs`. It goes live when that branch is merged to `main`.
- **Cron:** new jobs `stamp-order-deciders` (`1-59/5`), `stamp-order-deciders-full` (02:23 UTC) and `altercpa-sync-continue` (`1-59/2`). The full table is in `docs/how-it-works.md` §8.
- **Numbers, 28.09** (cohort, sale day, Skopje):
  - 22–28.09 (partial): 1.321 sales · 3.247.209 ден, of which paid 704 · 1.685.032;
  - 15–21.09: 1.629 · 4.138.998;
  - 01–27.09: 7.176 · 17.968.541.
- **No-parcel rule: 10 DAYS** (the owner changed it from 7 on 28.09), APPLY mode. First real run
  by hand 28.09 ~06:40 Skopje: 516 candidates → **473 cancelled (€12.757)**, 43 needs_linking;
  818 `no_parcel_7d` cancels in total. The nightly 21:10 run continues.
- **Done 28.09 ~06:30–06:45 Skopje** (owner: "why not run everything now"):
  - Lazar Delev added (owner, management team, never earns);
  - 28 collabBox authors mapped: 6 to their CRM agents' Cyrillic spellings, 22 as placeholders
    named exactly as collabBox writes them — ≈8.540 orders got a seller;
  - 6 test-phone orders deleted (run `becf69c8`);
  - 478 orders re-priced to the MEX COD (run `1220de9c`, 372 of them paid);
  - ORD-82442 linked by hand (same customer, CRM city was wrong), and the 3 MEX-delivered hand
    links (ORD-82442, ORD-89633, ORD-105252) set to paid with MEX's delivery date.
- **Done 28.09 ~07:10–07:35 Skopje** (owner: "treat everything how you think it's accurate"):
  - `altercpa-unproven-paid` (run `c1a90c3d`, `--evidence-guards`): the 132 "paid without MEX
    proof" → 45 cancelled (no parcel anywhere), 9 took their MEX status, 3 parcels moved back;
    **C7 132 → 74** (all manual — the phone's parcels fit another order, or are held by a real sale).
  - `ghost-manual` (run `5edf77ba`): 18 ambiguous ghost parcels decided from collabBox document
    times (6 moved, 12 unlinked); `--include-zero-price` re-price of 5 real zero-price orders
    (run `456038d9`); ORD-93612 restamped disposition → prediction_list. **C10 90 → 0 FAIL**
    (the 67 collabBox replacements are INFO: price 0 + COD 0 = not an order).
  - Web shop: **2.751 web orders linked to their NATURA "M…" (old OpenCart) parcels** — about 2.430
    March–August sales had been counted twice (web order + MEX-only parcel). web-sync links new
    ones by phone + amount (`20260940000300`).
  - 18 AlterCPA orders "shipped" on a MEX label that no longer exists (deleted before pickup) →
    back to confirmed → the 10-day rule cancelled 16, ORD-82400 → needs_linking, ORD-104951 decides
    tonight.
  - Денари everywhere is live (staff screens, charts, exports, notifications); the foreign
    affiliate payout stays EUR (08-10 exception).
- **28.09 afternoon — every Insights tab rebuilt** on the foundation (`insights_sale_rows`), Overview
  style, migrations `20260941000100`–`0600`, api deployed, commit `d1f324a`:
  Продажби · Агенти · Pure Profit + Маржи · Прогнозни списоци · Враќања + Залихи · Активност.
  Every tab ties to `insights_cohort` (`scripts/verify-tab-<tab>.mjs`, all PASS for 22–28.09 and
  01–27.09); managers get the same pages without money; payout/bonus math untouched.
  Open owner questions from the rebuild:
  - no-parcel rule for ElyonCRM too;
  - Teleshop team;
  - managers' access to Активност;
  - product-name mapping (233 names) and line rules (ПОЕН / ДОСТАВА / gift);
  - cost prices (33% coverage; the AlterCPA €2,93 placeholder);
  - VAT; MEX return fee; lead price per webmaster;
  - stock count plus MEX-driven stock movements;
  - return reason capture;
  - 928 MEX-shipped AlterCPA cancels credited to nobody;
  - year windows in Pure Profit take 7–10 s.
- **Review later (not errors):** C7 74 manual; C8b 54 tracking ids unknown to MEX; C8c 2 WARN
  (re-sends whose first parcel came back); 424 NATURA M parcels with no web order (198 COD-0
  deliveries to our own shops/dm, 101 no web order on the phone, 60 from the 18.08–04.09 mirror
  gap, 38 ambiguous, 27 other); 7 old AlterCPA leads that mex-reconcile reopened on a parcel
  created > 30 days after the lead (possible re-sales).
- **Open:** `verify-attribution` C7 (132), C8b (56) and C10 (90) predate this release; the full list is in FINISH-FROM-VSCODE §E.
- **28.09 evening — the whole teleshop history is in the CRM** (`scripts/import-teleshop-collabbox.mjs`,
  run `8bb49e8e`, ledger migration `20260942000300`, applied 17:10–19:40 Skopje; the owner decided
  every rule before the run):
  - **247.001 orders** from the collabBox Нарачка in/out documents (series 9100/9102), 01.2023 → 27.09.2026,
    `sale_source = collabbox / teleshop`, seller only in `sold_*` (no agent-facing fields):
    - 214.700 **paid – history** (`paid_basis = legacy_import`, before MEX coverage). Insights shows them as
      `paid_legacy`, never as MEX-proven.
    - 28.577 paid with MEX proof, 3.311 returned, 413 in transit. These follow their MEX parcel;
      32.301 parcels linked.
  - Per year: 2023 67.794 · 2024 69.134 · 2025 63.660 · 2026 46.413.
  - Customers:
    - 56.699 new customers with a profile;
    - 1.903 profiles created for existing CRM customers who had none;
    - 6.763 existing profiles filled (empty fields only);
    - 632 komitenti skipped (deceased, employees, companies, test/junk names, no valid phone). The 1.052
      documents of deceased customers were never imported.
  - Do-not-contact: **598 trash markers**, reason `other`, reversible. 584 are «Не се јавувај (collabBox)»
    (imported with their orders); 14 are deceased customers already in the CRM. All 598 are in the
    Trash List, 0 in a calling list.
  - Other fixes in the run: 713 mislabelled `teleshop` orders relabelled; 117 existing collabBox
    orders linked to their own parcel.
  - Not created, for a reason in the ledger:
    - 1.432 conflicts: a twin of a CRM sale, or a parcel held by another order. Never forced.
    - 7.777 skipped: 5.515 zero-value replacements, stornos, 9103/9110/9108 series, no valid phone,
      employees, companies.
  - The disk was 2 GB (the DB went read-only at chunk 212) → **raised to 8 GB with the owner's OK**;
    the apply resumed from the ledger with the dry-run hash check. DB is now ≈1,25 GB.
  - After the run:
    - segment queue drained (70.036 phones, 0 failed); memberships 54.145 → **112.148**;
    - Pure Profit monthly cache refreshed by hand for 09.2024–08.2026.
  - Checks after the run:
    - `engine-fixture-mk` ✓;
    - verify-insights-ties and all verify-tab-* ✓: 01–27.09, Pure Profit 09.2025–08.2026, Sales 2024;
    - `verify-attribution` 01–27.09: C1–C5, C10, C12–C14 PASS. C7 37 and C8b 14 are AlterCPA
      leftovers from before the run.
  - `audit-segments-integrity` reports 230 out-of-band, 86 zero-price and 3 trash mismatches.
    Only 1 of these involves a teleshop phone (an old 0-price AlterCPA row). The rest are day-boundary
    drift since last night's recompute and 21-day parks that expired today; the 02:00 recompute
    clears them.
  - **Independent audit** (80-order stratified sample + sweeps over all 247.001 orders against the
    crawl, items, komitenti registry and MEX): 0 mismatches in date, amount, phone, seller, lines and
    status. Follow-ups (none fixed yet):
    - 2 prices ≠ MEX COD (ORD-347575 is an exchange, COD 200 ден; ORD-335325 3.000 vs COD 3.660). They
      are in the COD re-price dry run `8e059bfe`, 34 orders. That run is NOT applied: it also re-prices
      10 LEADS-OUT orders from 03–04.2026 that differ by exactly +100 ден (an old delivery fee?) —
      owner's call.
    - 1 document (002-9102-177395/2026) moved after the dry run; the next run creates it.
    - Article 600087 «Термос» is mapped to «МАТАЛКА ЗА НЕС» (1.581 gift lines, stock only).
    - 57 twin conflicts from the MEX era leave their parcel unlinked. 9 AlterCPA twins are "paid"
      while their parcel returned, and 8 are "confirmed" while their parcel moved. Linking needs a
      decision, because some twins are 0-price rows.
    - 10 do-not-contact phones were already permanently trashed and got no «Не се јавувај» note.
    - 1 komitent has two parcel phones; the second phone has no profile.
  - Rollback: `--rollback --run 8bb49e8e-…` deletes exactly what the run created and restores the
    filled profiles.
- **28.09 late evening — sale sources are the DEPARTMENTS, every sale once** (owner rulings
  ~21:00–23:30, whole history approved). Migrations `20260942000500` (five sources), `…0600`,
  `…0700`; `scripts/reclass-department-sources.mjs` moved 168.564 history rows (log in
  `sale_source_reclass`, `--rollback`):
  - **AlterCPA**: affiliate leads, collabBox 9110 LEADS, and EVERY sale an AlterCPA-team agent makes
    (team_prediction / team_collabbox_*): "their prediction stays counted in AlterCPA".
  - **Телешоп – Lead out** (key `elyon_crm`): CRM sales + collabBox 9102 "Нарачка out" + 9103
    LEADS-OUT, whoever booked them.
  - **Телешоп – Lead in** (key `teleshop_other`): only collabBox 9100 "Нарачка in" (the TV lead-in).
  - **Социјални мрежи**: its own department (9108 / 1300).
  - **Web** is unchanged.
  - MEX parcels with no order go by series (9110 → AlterCPA, 9102/9103 → Lead out, 9100 → Lead in,
    9108 → Social); the neutral "Elyon account — unlinked" split is gone.
  - The 10-day no-parcel rule keeps its population (team_prediction excluded in its three twins).
  - The evidence the owner overruled (in/out trace, 01–27.09):
    - 9102 buyers are teleshop's own repeat customers (98,6% repeat, 73% never Elyon), booked by 16
      CRM agents in the same shift as their CRM work;
    - 9100 is the TV lead-in (noon peak, Sundays, 39% new), mostly booked by 3 people without a login;
    - neither goes through AlterCPA (1,2–1,5% incidental).
  - Who works in the CRM is recorded in `sales_people.crm_since` / `crm_until` (information, not a
    gate). A login but no CRM work: Sofija Kuculovska, Verica Kostovska, Milijana Todorovska. No
    login: Milјana Todorovska н., Valentina Bogdanovska н., Mirjana Stefanovski, Vesna Filipovska.
  - **LEADS-OUT booked only in collabBox:** `scripts/import-leads-out-collabbox.mjs` (run `954707fd`)
    created 64 orders from the fresh collabBox fetch; re-running it picks up the remaining authors.
  - September 01–27 before the history move: Lead out 2.260 sales / 5.583.535 ден (was 687 / 1,93M). The
    final per-department numbers are in the report of 28.09 night.
  - Every CRM-made sale counts (`20260942000400`):
    - a call-outcome (disposition) row that becomes a real sale, or a duplicate of one, is now a sale
      (ORD-109265);
    - the admin attribution correction re-points `sold_by` for CRM sales (6 fixed).
  - Double counts removed / links made (all repair-kit runs with rollback):
    - `crm-collabbox-twins` 3c32f8d3: 6 CRM orders take their collabBox copy's parcel; the copies are
      marked duplicated;
    - `teleshop-twin-links` c8dc9345: 57 MEX-era teleshop twins linked to their AlterCPA/CRM order;
    - `link-elyon-parcels` 8db253cc: 141 BIO NATURAL parcels linked. 55 are AlterCPA cancel-then-ship
      (43 fit only the lead price edited in AlterCPA), 10 are open orders with malformed phones, 76 are
      re-shipments after a return; 17 are listed for a human.
  - **Prices follow the MEX COD** (owner: "Поправи"):
    - runs 8e059bfe (34) and f29eb4dd (325);
    - `cod-price` now trusts a teleshop parcel on an AlterCPA order when the collabBox document with
      that DocNumber names the order (`collab_twin`).
  - **Sellers:**
    - 40 former teleshop authors (2023–2024) added as people;
    - 40.702 history orders filled by the stamping function;
    - `backfill-sellers-collabbox` 5b29ca75 credited 506 more from the fresh September fetch
      (`exports/collabbox/merged-2026-09-28`).
  - The Overview's teleshop card no longer shows a lead funnel (every collabBox document is a sale).
  - Open for the owner:
    - 10 new AlterCPA offers unmapped since 17.09 (GlucoCare 202 leads, MenCare, ProstaCare,
      NeuroCare, Arthriva, Collagen Peptides, Neurofix 1+1, Prostafix 1+1, Urofix thrush) — their leads
      never enter the CRM;
    - the process "every lead out in the CRM first" (then nothing needs importing);
    - live counting of today's lead out needs either that or a daily collabBox import (the sync is
      paused).

- **28.09 night — the collabBox FOLDER MAP (evidence, owner's question "is one of the outs affiliate?")**:
  the document TYPE decides, not the series or the MEX profile.
  | Type | Name | Series | What it is |
  |---|---|---|---|
  | 10036 | Нарачка in | 9100 | Teleshop in (TV), NATURA |
  | 10050 | Нарачка out | 9102 | Teleshop out: teleshop's own repeat customers, NATURA |
  | 10111 | Нарачка LEADS | 9110 | Affiliate lead (in), BIO NATURAL |
  | 10114 | LEADS-OUT | 9103 (703 numbered 9102) | **Affiliate out**: 97% had an AlterCPA lead first, BIO NATURAL since 02.04.2026 |
  | 10106 / 10055 | Social | 9108 / 1300 | Social |
  | 10107 | Продавници | — | Shop orders, not at MEX |
  - **Our CRM orders are affiliate out too** (580/606 September parcels = BIO NATURAL 9103; 98,5%
    AlterCPA leads before).
  - The current grouping "Lead out = CRM + 9102 + 9103" mixes affiliate out with teleshop out. The
    owner decides the model (a separate "Affiliate – Lead out"? inside AlterCPA?) and the grey zone
    (~14% of 9102 are re-sales to recent affiliate customers).
  - ~1.100 collabBox orders are labelled by series against their type.
- **28.09 night — products:** 8 new AlterCPA products (GlucoCare, MenCare, ProstaCare, NeuroCare,
  Arthriva, Collagen Peptides Bionatural, Neurofix 1+1, Prostafix 1+1; stock placeholder 1000, no
  cost price) and 10 MK offers mapped. Their leads now enter the CRM. The catalogue run `01d83713`
  added 170 aliases (September 99,6 % / history 96 % resolved). Activating the sold-but-inactive
  products and creating the rest: in progress (`scripts/complete-catalogue.mjs`).
- **28.09 night — leaderboard audit** (22–28.09): the boards show 72% of sales (1.166 of 1.612).
  - Gaps:
    - Lead in is on no board;
    - collabBox bookings reach the CRM only via imports (no cron);
    - managers (Nina, Dragana) are ranked;
    - AlterCPA agents are split across boards;
    - roster gaps.
  - Fixed tonight:
    - a MEX revival is no longer credited to "now" and the old agent (`20260942000800`);
    - 8 wrong twin links undone;
    - 3 cross-channel revivals undone (one web order was counted twice).
  - Needs the owner: Lead in / social on the board; teams for Чима / Ристеска / Кипровска and 5
    no-team logins; #4531; the manager accounts; a daytime collabBox header fetch for the live board.
- **collabBox nightly sync (00:00 Skopje) — being built** (owner 28.09 23:30). It was never built:
  only the paused design and a login probe existed. Edge function + migration `20260942000900`,
  tested with `dry_run` on a real day before the cron is switched on.

The sections below are the history up to 19.08.

### Earlier state (19.08)

- **Frontend (Vercel):** https://elyon-natura.vercel.app (`gordanas-projects-a53c0208/elyon-natura`, GitHub-connected → **push to `main` auto-deploys production**)
- **Backend (Supabase):** `bmfxhgznttcnnlqloqzp` — **206 migrations applied** (repo and remote in step, latest `20260928000100`), edge function `api` deployed (v52, 2026-08-19), `WEBHOOK_SECRET` set, `pg_cron` on, **`INSIGHTS_ENGINE=sql`**.
- **Data (2026-08-05): the historical order book is LOADED.** 80.360 orders · 47.231 customers ·
  56.807 prediction-list memberships. 0 call logs. **88 products** (67 + 21 created for the import),
  46 carrying a real unit cost.

  | | |
  |---|---|
  | Source | AlterCPA `api.cpa.moe`, 81.657 MK orders 2025-04-14 → 2026-08-05 |
  | Imported | 80.360 — paid **27.276** · cancelled 35.328 · trashed 17.714 · pending 42 |
  | Paid revenue | **€665k** (≈40,9M ден) across 16 months |
  | Excluded | 977 unusable phones · 314 AlterCPA smoke-test orders · 6 remaining ids |
  | Corrections | **2.609 orders proven paid by collabBox** and flipped from cancelled/trash |
  | Idempotency | `external_source = 'altercpa'`, `external_order_id` = the AlterCPA id. **Re-running the importer is a no-op** (verified: 600 re-posted → 600 duplicates, 0 created). |

  Scripts: `export-altercpa-mk.mjs` → `analyze-altercpa-mk.mjs` → `build-product-map.mjs` →
  `match-collabbox.mjs` → `import-altercpa-mk.mjs` → `verify-altercpa-import.mjs`.
  Raw export and every audit file live in `scripts/data/`.

  > ⚠️ **collabBox holds ~40.000 more paid orders we could not import.** Its export carries no
  > phone and no product, so only 10,8% of its 45.227 documents could be matched to AlterCPA by
  > name + date. The fix is a re-export with those two columns — the request is written and ready
  > to send at `docs/COLLABBOX-EXPORT-BARANJE.md`.
- **Logins (3, verified live 2026-08-05):**
  | Login | Role | Notes |
  |---|---|---|
  | `mile@elyon.com` | admin | typed in full |
  | `hedi@naturatherapy.mk` | admin ("Суперадмин") | typed in full |
  | `dragana@naturatherapy.mk` | manager | typed in full |

  Any address containing `@` is typed **in full** at the login box — the form only appends
  `elyon-mk.local` when the input has no `@`, and the field is labelled "Username".
  All three still use seeded/simple passwords — **rotate**.
- **Public signup is disabled** (2026-08-04). Accounts are created only by an admin, via the
  `/users` screen or `node scripts/create-user-mk.mjs`.
- **Secrets:** `docs/VAULT.md` (gitignored).

### Code parity with Bulgaria — done 2026-07-31

Brought forward 28 migrations and ~33 files that shipped upstream after the fork: segment engine
v3.4 → v3.6, assigner truth RPCs + mass-unassign, `shipped_at`/`paid_at` + agent "My Orders",
call-listened mark + recording reconciler, the **affiliate/CPA system**, duplicated-order status,
agent payouts, the RLS lockdown set, `notifications.meta` + unpaid-delivery chase, Macedonian
locale, VOIP minutes + live agent state.

Merged 3-way against the fork point (BG@`25561ef`): 69 fast-forwards, 21 merges, 33 new files,
**3 conflict hunks**. The fork's own delta survived intact.

**Deliberately NOT ported:** the BigArena stock-sync upload — its parser reads the Bulgarian
fulfilment panel's Cyrillic headers (`Свободна наличност`, `Баркод`) and MK uses a different
provider. Its parser lib (`src/lib/bigarenaStock.ts`) is still present for the products
stock-sync path. (`BigArenaStatusSync` itself was deleted 2026-08-18 — statuses come from the
MEX reconcile cron.)

### Pendings queue + sticky trash + full stock — done 2026-08-06

Ported BG's `875abaa` (trash reasons everywhere, Pendings queue on /calls) and rewrote its engine
v3.7 for Macedonia. Migrations `20260913000000` … `20260913000300`, edge function v18.

- **Pendings are visible in the /calls queue strip.** A virtual entry, **always first**,
  auto-selected, fed by the new `GET /my-pendings-summary` (own book only, no `agent_id` param).
  Picking a prediction list pins it; waiting leads then show as an amber badge instead of hijacking
  the screen. No segment list was created — the entry is synthetic (`PENDINGS_QUEUE_ID`).
- **Trash is STICKY (engine v3.7-mk).** Every reason now removes the phone from every calling band,
  and a later pending/cancel/return no longer releases it. **Two deliberate deviations from BG:**
  a **paid order after the trash releases** the customer, and **`duplicate_order`** is housekeeping
  (stays callable, never in the Trash List). Live impact: calling members **38.307 → 35.812**,
  Trash List **9.528 → 11.398**. `not_reachable` still parks only 21 days.
- ⚠️ **`orders.trashed_at` needed a correction migration** (`20260913000300`). The generic backfill
  chain is `order_history → updated_at → created_at`, and all 17.714 imported trashes have zero
  history rows, so they all collapsed onto the import timestamp — which would have silently
  disabled the paid-release test for the entire historical book. Any future bulk import must stamp
  `trashed_at` from the real order date.
- **Warehouse: all 88 products set to 1.000 packages** via `scripts/set-stock-mk.mjs` (absolute set
  + one paired `inventory_logs` row each; the additive `POST /api/restock` cannot do this). Snapshot
  for rollback: `scripts/data/stock-before-2026-08-06.json`.
- **Cancel list needed no change** — the 14-day park and the automatic return to the band computed
  from last-paid date + order count already worked; verified live (`0 overdue`, cron `0 0 * * *`
  active) and pinned by the new fixture.
- New verifier: **`node scripts/verify-sticky-trash-mk.mjs`** (8 behavioural cases). Live↔shadow
  parity **0**.
- **Zero-price paid orders: 1.199 → 738** (`scripts/recover-zero-prices-mk.mjs`, +€6.896 revenue,
  audit check 705 → 461 members). AlterCPA recorded no price on these; every source was exhausted
  first (raw export, its line items, CRM `order_items`, collabBox — all empty or not sale prices).
  461 were recovered where the source **did** record a quantity and the same offer+quantity sold at
  one settled price (≥90% of ≥10 paid peers, ±1 month); each carries a `System (Price Recovery)`
  note so a reconstructed figure is never mistaken for a recorded one. The remaining **738 stay at
  0 on purpose** — they recorded neither price nor quantity (662 are Alpha Male, whose
  1.490/3.000/4.000 ден "spread" is pack size 1/3/4, so there is nothing to price). Audit is
  therefore **13/14** by design. Rollback: `scripts/data/zero-price-recovery-2026-08-06.json`.

### Channel P&L + per-affiliator breakdown — done 2026-08-19

Commit `334fe27`, migrations `20260928000000` + `20260928000100`, edge fn v52. Insights now says
**where the money came from**, not just how much. Ported from BG (`f522cdc`/`8a4e44b` there) but
re-based on this market's reality: the affiliate world here is the **AlterCPA bridge**
(`orders.cpa_webmaster_id` / `external_source='altercpa'`), NOT BG's `affiliate_leads` sidecar —
which is EMPTY here and must never be joined for MK money.

- **Overview** gains the order-basis channel strip (confirmed value + confirms/cancels/trashes per
  channel, in ден). It deliberately leads with confirmed value, never cash-basis profit — BG's
  lesson: the profit-led version read 0 ден all day under a live Revenue tile.
- **Pure Profit** gains the channel waterfall table + **"By affiliator"** (per AlterCPA webmaster,
  named from `altercpa_webmasters`; unnamed → "WM <id>"). Since 2026-07-01: Fomikch €116k
  confirmed / €107k cash · KMA.biz 44/39k · ezaff.com 20/17k · LeadBit 3,9/3,1k.
- **Lead cost is a wired-but-ZERO slot everywhere** (operator, 2026-08-19: rates come later, per
  affiliator). When they arrive: add a rates table and replace the single `0::float8 AS payout`
  line in the RPC's `base` CTE — RPC → edge fn → cards already carry every lead_cost field.
- **Channel truth:** affiliate = 100% AlterCPA (every order carries a webmaster id — verified 0
  exceptions); prediction = 100% `prediction_list_id`-stamped, **which exists only since
  2026-08-14** (the UI warns on earlier ranges); **manual = the collabBox register imports**
  (437 since July — outbound Predikcii book + lost-inbound, real warehouse-dispatched sales worked
  OUTSIDE the CRM, no attribution possible) **plus genuine hand-typed orders** (~35, incl. the 14
  `duplicated` copies, which carry NO attribution by design — a confirmed copy counts as manual,
  not the original's channel). Going forward manual ≈ hand-entries only. Possible refinement,
  not done: the collabBox source files split LeadIn/LeadOut, so the 437 could be back-tagged.
- **Found + fixed a real money bug** (`20260928000100`): the SQL engine's courier CASEs
  (`insights_orders_rollup`, `insights_paid_basis`, from `20260911000000`) predate MEX — every MEX
  order was costed at the €3,50 fallback instead of MEX €2,439 and Logistics showed one 'unknown'
  bucket. Caught because the new channel RPC (MEX-aware from birth) refused to tie by exactly
  €95,49 = 90 delivered MEX orders × 1,061. All seven waterfall terms now reconcile to the cent
  (real clear profit since July: **96.060,06**, not 95.964,57). Lesson: when a courier/enum is
  added, grep the SQL twins in migrations, not just the TS.
- Verified live end-to-end post-deploy: RPC paid count = direct DB count (4.068), Σ channel
  confirmed value = Overview revenue to the cent, channels × affiliators reconcile.

### Call-agains pushable to AlterCPA (status 3 Callback) — done 2026-08-19

Operator request: agents' call-backs must reach AlterCPA like every other disposition. Three
pieces, all shipped together:

- **`call_again` joined the CPA push map** (`ALTERCPA_PUSH_STATUS`, edge fn `api`) → their
  status **3 Callback**, via the same two-POST transport, Dragana write token and read-back
  verification as every other push. It had been deliberately excluded until the read-back loop
  was verified live — that happened 08-18. Comment = `Agent: <name>` only (no reason pair; leads
  never carry `next_call_after`, and their API has no callback-time param anyway).
- **Two guards:** the route 422s unless the ledger row exists AND shows phase ≤ 2 — status 3
  lives inside their open phase, so pushing it onto an accepted/resolved order would REGRESS it
  (ledger-less = pre-08-05 historical imports, long decided there). And uniquely for this push,
  the read-back verifies `status` actually reads 3 — their API answers success even when a
  transition rule swallows the change.
- **The callback-mirror revert was fixed to make this usable** (`altercpa-sync`): it used to
  flip ANY `call_again` whose remote wasn't 3 back to `pending` — undoing every agent-set
  call-back within 5 minutes and leaving the new push nothing to send. It now fires only on an
  **observed 3→non-3 transition** (pre-run ledger snapshot 3, remote now non-3), i.e. exactly
  when THEY clear an acknowledged callback — bridge rule 6 preserved to the letter, agent work
  no longer destroyed. `/orders` gate: `CPA_PUSHABLE` + `call_again`; no new i18n (the dialog
  renders `Call Again → 3` from existing keys).

### Publisher (traffic-source) attribution — done 2026-08-19

Third CPA dimension after affiliate + offer: **which media buyer under the partner** sent the
lead. The code is AlterCPA's `tracking.exts` (undocumented in their API; verified: the hashes in
Mile's panel screenshot sit verbatim in our ledger payloads). KMA.biz is a reseller network, so
this is the only way to tell its buyers apart. **Raw code, no names, on purpose** (operator:
"the publisher code is okay.. no needed names") — no registry, no naming UI; even AlterCPA's own
panel shows the bare hashes.

- `orders.cpa_stream_id` (migration `20260929000000`, composite partial index on
  `(stream, wm)` — codes are only unique within one webmaster). Sync writes it via
  `cpaAttribution()`; agents never see it (`stripCpaAttribution`, all three order endpoints).
- Surfaces: /orders expand "Publisher: <code>" + mobile + XLSX PUBLISHER column + a publisher
  filter popover; **/altercpa → Traffic sources** tab = read-only per-source distribution
  (orders/paid/confirmed/cancelled/trashed + first/last seen, affiliate names resolved) via new
  `altercpa_stream_distribution()` RPC; the dimensions RPC gained a minimal `streams` key
  (`20260929000100`).
- Backfill `scripts/backfill-cpa-stream.mjs` (clone of the wm/offer one; ledger wins only when
  non-null — a null ledger observation must not clobber a dump code): **70.550 / 82.622 orders**
  now carry a code, 195 distinct (wm, stream) pairs, 12.072 genuinely have no exts (stay NULL),
  collision probe 0, `updated_at` untouched (replica-role batches).
- **Never `tracking.extu`** — per-lead click id. `tracking.source` = UTM axis (KMA only),
  possible 4th dimension, not built. Insights per-source money: not built (follow-up).
- ⚠️ Their panel counts LEADS across ALL geos; our surfaces count MK ORDERS. The circled
  `drkbu8aj7hhbps6n` is KMA's **Serbian** Prostatol traffic (837 ledger leads, 85 today —
  panel showed 83 at screenshot time ✓) and correctly shows 0 orders here.

### Market layer (Macedonia)

| Area | State |
|---|---|
| Currency | **MKD only** in the UI. Stored EUR; `MKD_PER_EUR = 61.5` is **frozen** (see below). `formatMoney` is the money formatter; `formatLev`/`eurToLev`/`BGN_PER_EUR` are deleted. |
| COD | `codFor()` returns amount **and** currency together; rounds once to the nearest 10 ден. |
| Timezone | `Europe/Skopje` throughout (DB functions, edge fn, frontend). |
| Phone | `+389`, 8 subscriber digits (national `0`+8=9, E.164 `389`+8=11). `normalizeMkPhone`. |
| VAT | **18%** — ⚠️ unconfirmed, see below. |
| Language | Default `mk`; `en`/`sq`/`bg` also shipped. Call-script + promo base language = `mk`. |
| Login | `elyon-mk.local` |
| Webhook | Accepts **EUR or MKD only** — anything else is a 400. |
| Couriers/cities | **Still Bulgarian** (Speedy/Econt + `bg_settlements`) — deferred. |
| Telephony | Deferred (Phase 2). `VITE_USE_REAL_VOIP=false`; A1-Bulgaria DIDs left in place, marked `TODO(mk)`. VOIP minutes bundle seeded at **0** (no MK carrier contract). |

Search for `TODO(mk)` to find every spot still needing a real value.

---

## ⚠️ The frozen peg — read before touching money

`MKD_PER_EUR = 61.5` in `src/lib/currency.ts` is an **internal accounting constant, not a rate to
keep current.** The Bulgarian lev is legally fixed to the euro forever, so deriving it at render
time is safe. The denar is a *managed* NBRM peg. The moment someone "updates it to today's rate",
every historical order, every closed agent payout, every past revenue report and every COD already
collected from a customer silently re-prices — with no audit trail and no way to tell which figure
was actually quoted on the phone.

**If the market moves, re-price the CATALOGUE in EUR** (`scripts/reprice-catalogue-mk.mjs`).
`src/lib/currency.test.ts` pins the constant so an edit fails CI.

---

## ⏳ Before go-live

**Needs your input:**
1. ~~**Denar shelf prices.**~~ **Done 2026-08-04** — the catalogue was re-priced off the Bulgarian
   EUR points onto clean denar shelf prices (2.490 / 1.890 / 1.490 / 1.290 / 950 / 790 / 590 / 450 /
   150 ден). Every price now ends in 0, so the COD collected equals the advertised figure. Map kept
   at `scripts/data/reprice-2026-08.json`, pre-change state at `…-before.txt`.
   **Still open:** the **29 products with no price at all.** They are not free in practice — the
   order form silently defaults them to `max(cost × 3, €15)`. Price them or deactivate them.
   **Also open (2026-08-05):** the **21 products created for the AlterCPA import** were given a
   flat **180 ден (€2,93)** unit cost on request, so gross margin on the paid history reads 77,9%
   instead of 100%. It is a placeholder, not a measurement — and those 21 carry 49.190 of the
   80.360 orders, including the three biggest earners ProstaFix, GlucoFix and ArthroFix. Replace it
   with real per-product costs before trusting any profit figure. Mapping and proposed shelf prices:
   `scripts/data/altercpa-product-map.json`, reviewed in `…-review.md`.
2. **VAT rate.** 18% is Macedonia's standard rate, but food supplements may fall under the
   preferential 5%/10% band. `VAT_RATE` (edge fn) feeds every profit report.
3. **Commission tiers.** Still `<25€→1, 25–35€→2, ≥35€→3`. Note the hero band is now **tier 3**:
   twelve products sit at 2.490 ден (€40.49), i.e. €3/package, not the €2 assumed when this was
   written. A comp-plan decision, not a port decision. `MarginLabTab.tsx` duplicates the tier
   logic — change both.
4. **Macedonian couriers + city list**, replacing Speedy/Econt and `bg_settlements`.
5. **Confirm the imported unit costs.** `products.cost_price` was populated on 2026-08-04 from the
   Bulgarian catalogue (46 of 67 matched by name; the other 21 have no cost recorded in BG either).
   These are **Bulgarian sourcing figures** — check them against real Macedonian supplier invoices,
   because they now drive Pure Profit, Margin Lab and the floor-price calculator.
   Re-run with `node scripts/import-costs-from-bg.mjs` (dry run) to see the current mapping.

**✅ Resolved (2026-08-18):** the fulfilment CSV is now the **MEX Poshta client-portal import
file** — MEX's own 8-column template (`Kod na pratka … Tezina`), Latin, integer denari, contract
in `src/lib/mexImportCsv.ts` (+ pinned tests). The BigArena Status upload button was removed from
/orders and /warehouse (courier outcomes come from the `mex-reconcile` cron). Validate with a
small real import into the MEX portal before the first big batch.

**Also pending:** rotate the seeded admin passwords and the credentials in `docs/VAULT.md`
(**still open — see H2 in the security audit**); a real production domain (the `elyon-mk.com`
placeholders were *removed* from the CORS allowlist on 2026-08-04 because we do not own that
domain — a real one must be **added** when registered, and it also replaces `EMAIL_DOMAIN`);
Phase-2 telephony.

---

## 🔐 Security — audit of 2026-08-04

Full findings, evidence and verification: **`docs/SECURITY-AUDIT-2026-08-04.md`**.

**Fixed:** manager→admin privilege escalation via PostgREST (`user_roles` had a `FOR ALL` policy
with no `WITH CHECK`); customer phone numbers readable by any logged-in account, affiliates
included (`personal_list_holds`); **public self-registration, which was enabled**; affiliate API
keys readable by managers; the CORS allowlist (legacy alias was missing, unowned placeholder was
present); admin/manager logins now recorded in `admin_login_logs`; webhook slug-enumeration oracle;
missing REVOKEs on service-role-only tables; and a full set of HTTP security headers including CSP.

**Knowingly accepted:** the live admin password committed in `scripts/create-superadmin-mile.mjs`
(H2). Rotating it is a one-line change whenever you want it — note that rotation does not scrub
git history.

**Deferred:** webhook replay protection, durable rate limiting, SSRF hardening on affiliate
postback URLs, server-side shift enforcement, MFA, and an RLS conformance test in CI. That last one
is the recommended next project — three lockdown sweeps have each missed tables the next one found.

⚠️ **Adding a column to `public.affiliates`** now requires adding it to the explicit column GRANT in
`20260909000000_security_quickwins_lockdown.sql`, or it will be invisible to PostgREST readers.
⚠️ **Adding a custom domain or a second Supabase project** requires updating `connect-src` in
`vercel.json`, or every API call will fail silently in the browser.

---

## 🧩 What we still lack (consolidated, 2026-08-04)

Everything above is the *market* layer. These are the gaps found while auditing the whole system —
mostly small, but each one bites somebody eventually.

**Role and permission plumbing**
- **`inbound_agent` cannot be assigned through the API.** It is missing from `validRoles` in both
  `createUserSchema` and `PUT /users/:id/roles`, although the enum has it and both original accounts
  hold it (granted by the admin trigger, not by the API).
- **The admin UI's role list omits `agent`, `inbound_agent` and `affiliate`** — three of the nine
  enum values are invisible on the `/users` screen.
- **Hardcoded module fallbacks were never seeded** into `module_settings`: `calls`, `missed_calls`,
  `segments`, `recordings`, `products`, `webhooks`. The code comment says to remove them once the
  seed lands; they still ship. Side effect: `warehouse` and `ads_admin` see call surfaces that were
  never granted to them.

**Documentation that actively misleads**
- `.grok/skills/elyon-currency/SKILL.md` documents the **opposite of the shipped code** — it says
  "Macedonia is euro-native, display EUR only" and references `formatEur`/`formatLev`, none of which
  exist. Anyone following it would break the denar display. **Rewrite before relying on it.**
- `.grok/skills/elyon-logistics-costs/SKILL.md` teaches **VAT 20%** and the lev peg (Bulgarian).
  The code is 18%.
- `docs/USERS_ROLES_PERMISSIONS.md` describes "the 7 roles" (there are nine) and the Bulgarian
  `@elyoncrm.local` login domain.
- `docs/SECURITY.md` describes the **Bulgarian** Supabase project's auth settings, not this one —
  which is exactly how the open-signup misconfiguration went unnoticed for a month.
- `docs/VAULT.md` is still titled "Kosovo" and its §3 lists three accounts that do not exist.
- `CLAUDE.md` says a repo-root `MEMORY.md` is loaded each session; **no such file exists** here.
- `RESUME.md` was retired on 2026-08-04 — it was the pre-fork Bulgarian handoff doc and instructed
  the reader to run commands in the forbidden BG folder.
- `.grok/memory/INITIAL_PROJECT_MEMORY_SEED.md` is Bulgarian-era content and describes live A1
  two-way calling as "what's live". It is not.

**Product data**
- 29 products have **no shelf price** and 8 have neither price nor cost.
- Several product names are still **Bulgarian**, not Macedonian — e.g. `CHIA THERAPY - с вкус на
  диня`, `IMMUNO BOOST - с вкус на къпина, лимон и лайм`, `Whey Protein 1.5 kg с вкус на ванилия`.
  They are customer-visible on the agent screen and in the fulfilment CSV.
- A few names carry typos that matter only because matching is by name:
  `ELIXY-Дневенкрем снаил 50ml` and `ELIXY Серум со 20%снаил екстракт` are missing spaces.

**Telephony (Phase 2, deferred)**
- `docs/SIP-TRUNK-PLAN.md` holds the decision (build our own Asterisk PBX) and the ready-to-send
  Macedonian procurement emails. The one gating unknown is whether A1 sells a bare SIP trunk.
- Nine Bulgarian values are still hardcoded in the edge function, including
  `REC_HOST = pbx.elyoncall.com` and 20 Sofia DIDs. Latent while `VITE_USE_REAL_VOIP=false`, but
  they contradict "shares nothing at runtime with Bulgaria" and must be resolved before Phase 2.

---

## Operating notes

- **Migrations:** the DB password was never recorded, so `supabase db push` cannot open a direct
  Postgres connection. Use `node scripts/apply-migration-mk.mjs <file.sql>` (Management API, same
  `postgres` role). Recording the password in VAULT §1 restores the normal path.
- **`npx tsc --noEmit` is a NO-OP here** — the root `tsconfig.json` has `"files": []`. The real
  gate is `npm run build`.
- **After any migration bundle**, run `node scripts/engine-fixture-mk.mjs`. The segment engine
  resolves its target list by exact name match and deletes memberships *before* resolving, so a
  drifted list name wipes members silently, with no error.
- Legacy one-off scripts in `scripts/` (`import-monadon-csv`, `import-cpa-xlsx`,
  `cost-report-since-18may`, `finance/build-finance-pdfs`, …) are **Bulgarian** tooling carried
  over with the fork. They still hardcode the lev peg and 20% VAT. They are dormant — do not run
  them against Macedonia without converting them first. (`import-cpa-xlsx.mjs` in particular is
  **not** the AlterCPA importer — that is `import-altercpa-mk.mjs`.)
- **Before any bulk order load, go through `scripts/segment-trigger-mk.mjs --disable`.** Six
  `FOR EACH ROW` triggers on `orders` make a large import wrong, not just slow:
  `trg_orders_segments_insert` recomputes a customer's whole band membership per row (80k inserts
  = 80k recomputes, all but the last per phone discarded), and the four `orders_set_*_at` triggers
  stamp `now()` on insert — which would date every historical order to the day of the import and
  leave the real history blank. Finish with `--backfill-timestamps`, `--enable`, `--recompute`.
  The `--status` output is deliberately loud, because a trigger left disabled fails silently.

### Migration replay fixes (kept — never take BG's versions of these)
Guarded the `missed_calls` trigger in `20260604130000` + recreated it in `…0614120000`; dropped
the colliding `4-6m` rows before the rename in `…0605120000`; renamed two duplicate-version files
(`…0710000001`/`…0711000001` → `…0710010000`/`…0711010000`). BG never replays from scratch, so it
never hit these.
