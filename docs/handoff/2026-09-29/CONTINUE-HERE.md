# CONTINUE HERE — 29.09.2026 (written ~05:00 Skopje, before the 08:00 shift)

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

## 🔜 STILL TO DO

1. Owner questions document — `docs/handoff/2026-09-29/PRASHANJA-ZA-MILE.md` (Macedonian; draft
   written, finish + commit at the end).
2. Insights tabs audit (the audit agent died on the rate limit, no report): check each tab against the
   six-department model; remove outdated widgets.
3. Hygiene (no figure changes): 14.797 paid orders with a delivered MEX parcel have `paid_basis`
   NULL; `scripts/data/c8a-accepted-duplicates.json` has 3 stale exceptions.
4. **Docs LAST** (owner: "we leave the docs for the end"). The docs agent was STOPPED at ~05:00; its
   partial edits are uncommitted in the working tree — never commit them together with code; review
   them at the end. `CLAUDE.md` is current (`d058832`) except: add the new functions
   (order_departments, order_origin), the Табла = Overview change, Operations, the reconcile guard.
   Then: `MACEDONIA-STATUS.md` (new 29.09 section), `docs/how-it-works.md` (§8 crons),
   `docs/OPERATIONS_RUNBOOK.md`, the `elyon-presence-and-leaderboard` skill (leaderboard v2),
   FACTS `## Leaderboard`, `MEMORY.md`. Partially rewritten by the stopped agent (uncommitted):
   skills `elyon-departments-and-sources` + `elyon-collabbox-sync` (new), `altercpa-bridge`,
   `customer360-and-integrations`, `logistics-costs`, `segments-and-prediction`, README;
   `docs/ALTERCPA-BRIDGE.md`, `docs/IMPORT_EXPORT.md`, `docs/INSIGHTS_ANALYTICS.md`,
   `docs/ARCHITECTURE.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/PRODUCTS_STOCK_WAREHOUSE.md`.

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
- Teams for the Lead-in callers: Чима, Ристеска, Кипровска.
- 5 logins have no team.
- AlterCPA #4531: who is it?
- Is Milijana = "Милјана Тодоровска н."?
- Should the manager accounts (Nina / Dragana) appear on the board?

**Catalogue and costs**
- 16 unsure catalogue groups.
- ~53 older aliases map to a product of the wrong pack size.
- Cost prices, the lead price per webmaster, the MEX return fee.
- The stock count (deferred).

**collabBox**
- The komitent-card lookup returns 0. Phones come from the parcel.
- Social history before March has no MEX data and was not imported.
