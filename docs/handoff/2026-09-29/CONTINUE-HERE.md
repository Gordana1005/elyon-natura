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

## ⏳ Running when this was written

- **collabBox history backfill 06.04 → 26.09**, in 4-day windows through the sync:
  - log `%TEMP%\claude\cbx-backfill3.log`, which ends with `BACKFILL DONE`;
  - at 27–30.07 on 05:00; ETA ~05:20.
  - It must end before 07:00, because only one run is allowed at a time: the frequent cron would get 409.
- **AlterCPA weekly sweep**: `altercpa_sweeps` kind `weekly`, status `open` → `done`.

## 🔜 NEXT — in this order

1. **Leaderboard v2** was built by an agent and is **NOT applied and NOT committed**. It is in the working tree:
   - `supabase/migrations/20260942001200_leaderboard_by_department.sql`, which adds `leaderboard_day_v2(p_day, p_department, p_team)`;
   - `supabase/functions/api/leaderboardV2.ts` (+ test) and `index.ts`, which adds `GET /leaderboard?v=2`;
   - `src/lib/leaderboardV2.ts` (+ test), `src/components/tvboard/*` and `src/pages/TvLeaderboardPage.tsx` (+ test);
   - the locales (`leaderboard2.*`);
   - `scripts/verify-leaderboard-v2.mjs`.

   Finish it:
   1. Review it.
   2. Run `node scripts/assert-mk-target.mjs`.
   3. Run `node scripts/apply-migration-mk.mjs --dry-run …1200…`, then apply it.
   4. Run `npx supabase functions deploy api --project-ref bmfxhgznttcnnlqloqzp`.
   5. Run `npm run build` and `npm test`.
   6. Commit and push, with the VAULT §4 PAT.
   7. Run `node scripts/verify-leaderboard-v2.mjs --from 2026-09-22 --to 2026-09-28`.
   8. Open `/tv/leaderboard` live.

   The design is one row per agent, split by department, with the collabBox bookings of the day. Managers are shown but not ranked. No bonus math.
2. **After the backfill ends:**
   1. Run the collabBox sync in mode `nightly`, trigger `manual`, to cover 26–28.09. Post to the function with the vault secret, like `invoke_collabbox_sync`; the hour gate only lives in the invoke function. This also clears the `nightly: failing` card: the cron's first real nightly is 30.09 00:00, because the job was created after the 29.09 slot.
   2. Run mode `manual`, from `2026-09-28` to `2026-09-29`.
   3. Run `select public.insights_profit_refresh_nightly(true, 30)`. The backfill created social and LEADS-OUT history orders in Apr–Sep, so the Pure Profit months are stale.
   4. Re-run the verification suite for 01–28.09 and for one earlier month.
3. **Integrations words.** Apply them once the leaderboard's locale edits are committed: `node docs/handoff/2026-09-29/patch-locales-1400.mjs`. It updates `feedDesc.mex_bio_natural`, `mex_natura` and `collabbox`, and adds `expect.daytime_15m` and `expect.cbx_15m` in mk/en/sq/bg. Until then the Integrations tab shows the raw key for those two expects.
4. **Audit fixes.** A read-only audit agent produces the fix list for the Dashboard, Operations and Insights. Found already on Operations (`GET /operations-center`, `OperationsPage.tsx`):
   - "today" is `setHours(0)` / `toISOString()`: a UTC day, 02:00 Skopje;
   - the KPIs are CRM-status transitions, not the cohort or MEX;
   - agent activity uses `assigned_agent_id`, not the `sold_*` stamps.
5. **Order modal: "Origin & proof" section** (the owner's 29.09 ask: "where from, how, who made it, how much; MEX is the final proof — delivered, when, where, to whom, from whom, at what price"). `GET /orders/:id` already returns every `orders` column, so the missing pieces are:
   - the seller's name (`sales_people`, which needs the admin client);
   - the parcel row (`mex_parcels`: receiver name/city, status name, `created_at_mex`);
   - the UI in `OrderModal.tsx`: department label (`insights.common.source.*`), how (`sold_via`), who, when (`sold_at`), price vs MEX COD, MEX account, tracking, status, delivered/returned at, city.
6. **Hygiene (no figure changes):** 14.797 paid orders with a delivered MEX parcel have `paid_basis` NULL. Setting `'mex'` + a writer fix would make "how it was proven" explicit.
7. **07:15–07:45:**
   1. Check the freshness of every feed: `integrations_health()` and `collabbox_feed_state()`. MEX's first 15-min run is at 06:07; collabBox's is at 07:00.
   2. Run the full suite again.
   3. Report to the owner.
8. **Docs LAST** (owner, 29.09 ~05:00: "we leave the docs for the end once everything is done —
   first fixes and all that"). The docs agent was STOPPED at ~05:00; its partial edits (below) are
   uncommitted in the working tree — never commit them together with code; review them at the end.
   `CLAUDE.md` is already current (commit `d058832`). Then:
   - `MACEDONIA-STATUS.md`: a new 29.09 section, and "Current state" set to 29.09;
   - `docs/how-it-works.md` (§8 is the cron table);
   - `docs/OPERATIONS_RUNBOOK.md`;
   - the `elyon-presence-and-leaderboard` skill (leaderboard v2);
   - the `## Leaderboard` section of FACTS;
   - `MEMORY.md`.

   Partially rewritten by the stopped docs agent (uncommitted — review, finish, then commit):
   - skills:
     - new: `elyon-departments-and-sources` and `elyon-collabbox-sync`;
     - updated: `altercpa-bridge`, `customer360-and-integrations`, `logistics-costs`, `segments-and-prediction` and the README;
   - `docs/ALTERCPA-BRIDGE.md`, `docs/IMPORT_EXPORT.md` and `docs/INSIGHTS_ANALYTICS.md`.

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
