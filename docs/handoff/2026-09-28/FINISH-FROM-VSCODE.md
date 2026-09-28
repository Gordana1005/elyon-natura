# FINISH FROM VS CODE: what's done, what's left, what to check (28.09.2026)

The cloud session finished everything it was allowed to do. Its permission guard then blocked
three things: **pushing to `main`**, **scheduling the 21:20 wake-up for tonight's repairs**, and
(near the end) **more live SQL**. This file takes you through the rest from your PC.

All times are UTC unless marked Skopje (Skopje = UTC+2). Run every command from the repo root:
`D:\Dev\archives\elyon-natura`. In Git Bash, prefix with `git -C "D:\Dev\archives\elyon-natura"`,
or open that folder in VS Code and use its terminal.

> ✅ **Update 28.09 ~06:45 Skopje (VS Code session):** section B (frontend merge) and ALL of
> section C are DONE — on the owner's order ("why not run everything now") they ran at 06:30–06:45
> instead of 21:20, and the no-parcel rule is now **10 days** (was 7): 473 cancelled by a manual run.
> Lazar + 28 collabBox authors mapped, 6 test-phone orders deleted, 478 re-priced, ORD-82442 linked.
> See MACEDONIA-STATUS.md. Section D (the night checks) still applies.

> 🛑 Before EVERY migration, deploy or write, run `node scripts/assert-mk-target.mjs`. It must print
> **Target confirmed: Macedonia**. Never touch `sxymaloycddnoxudxaqp` / elyoncall.com / Vercel `elyoncrm`.

## ⚡ What still needs deploying: ONE thing

| Piece | State |
|---|---|
| Migrations `20260939000300`, `…000700`, `20260940000000`, `…0100`, `…0200` | ✅ applied (nothing to do) |
| Edge functions `api`, `altercpa-sync`, `mex-reconcile` | ✅ deployed 28.09 03:10–03:15 UTC (nothing to do) |
| `web-sync`, `collabbox-sync` | unchanged, no deploy needed |
| **Frontend (Vercel)** | ❌ **NOT live.** Merge the branch into `main` and push (section B). This is the only deploy left. |

Tonight's repairs (section C) are data fixes, not deploys.

---

## ✅ A. Already DONE and LIVE on Supabase (checked by the cloud session, 28.09 03:08–03:30)

| # | What | Result |
|---|---|---|
| §0 | Setup + tripwire | Target confirmed: Macedonia (105.496 orders, 0 on +359) |
| §1 | Snapshot | As expected: latest was `20260939000500`, no-parcel mode `apply`, every cron job succeeded in the last 24 h, AlterCPA nightly/weekly failing "stale" since 24.09 (this release fixes it) |
| §2 | **Stamping cron** `20260939000300` | Parity OK (5.381 = 5.381, 47.917 = 47.917, 0 diffs; 42.536 stored stamps, 0 differ). Applied; engine fixture OK. First tick 03:11 succeeded; `order_decider_runs` id 1: 1.129 candidates, 0 resolvable (all AlterCPA cancelled/trashed with "System (mex)" or "System (repair)" as first sale). 0 orders had `updated_at` bumped |
| §3 | **Resumable AlterCPA sweeps** `20260940000100` + `altercpa-sync` deployed | `altercpa-sync-continue` (`1-59/2`) is live and succeeding; rolling runs `ok` |
| §4 | **Upsell revive** `20260940000200` + `mex-reconcile` deployed | Fingerprint matched. Dry run: 0 to revive today (345 `no_parcel_7d` cancels, none has an upsell parcel yet) |
| §5 | **Insights foundation** `20260939000700` + `20260940000000` + `api` deployed | Engine fixture OK. `verify-insights-ties` exit 0 on 3 windows. `/insights/cohort` without a token returns 401 (routing works). `npm test` 734/734, `npm run build` OK |
| §6.1 | C8a owner exceptions | The 3 double-held parcels are in `scripts/data/c8a-accepted-duplicates.json`; C8a PASS |
| §6.5 | 47 `needs_linking` | **2 linked** (ORD-89633, ORD-105252: 9110, COD fits, the only candidate, name and city agree, note added). 1 more is provable by COD, but its city differs (ORD-82442: Skopje vs Свети Николе), so it was not linked. You decide. The other 44 are not provable: 21 COD doesn't fit (upsells), 20 only 9102/9103 parcels, 1 has no free parcel, 2 mixed |
| §6.6 | NATURA "M…" parcels | 3.175 M parcels, but only **564** have COD 0 (the other 2.611 carry COD). Of the 564: **324** match a web order on the same phone (shop says COD/PAID, 668.032 ден; web-sync never linked the parcel), 4 COD/UNPAID, **232 have no web order on the phone** (unexplained). None are card-paid |

**Cohort numbers (sale day, Skopje; each set of parts sums exactly to its total):**

| Window | Sales · value | Paid | Notes |
|---|---|---|---|
| 22–28.09 (partial, at 05:15 Skopje) | **1.321 · 3.247.209 ден** | 704 · 1.685.032 | courier 109 · problem 122 · label 105 · to pack 267 · returned 14 |
| 15–21.09 | **1.629 · 4.138.998 ден** | 1.209 · 3.026.424 | returned 151 · 426.380 |
| 01–27.09 | **7.176 · 17.968.541 ден** | 5.440 · 13.449.891 | returned 731 · 1.971.559 |

Why these differ from the research doc (1.343 / 1.701 / 7.666): the new contract leaves out
"cancelled after sale" (60 and 421 rows sat in the old totals) and COD ≤ 0 replacements (26/27/124).
It also drops 22 test-phone web orders. The rest is parcels that moved since 01:40.

**Dry runs, recorded but NOT applied:**
- Test phones: **6 CRM orders to delete** (1 paid, 1 cancelled, 4 trashed; 18 dependent rows). 2 kept: they only share the last 8 digits.
- COD → price: 760 mismatches. **478 to re-price** (Σ 870.676 → 1.456.425 ден, Δ +585.749) and 282 excluded (237 suspect links, 24 not a sale status, 14 dispositions, 7 zero price).
  ⚠️ **372 PAID orders change price.** Under today's (deferred) bonus rule, that moves +495 € of bonus across 275 orders. Look at the CSVs before applying.

---

## 🚀 B. PUSH: put the frontend live (do this first)

The branch `claude/epic-ride-8fhxhs` is already pushed and fast-forwards onto `main`. The Supabase
side (migrations + `api`) is ALREADY live, so the old frontend is now running against the new API.
Merge soon.

```bash
git fetch origin
git checkout claude/epic-ride-8fhxhs && git pull --ff-only
npm ci && npm test && npm run build          # expect 734 passed, build OK
git checkout main && git pull --ff-only
git merge --ff-only claude/epic-ride-8fhxhs
git push origin main                          # = Vercel production
```
Check afterwards:
- GitHub → Actions: CI on the new `main` commit is green.
- https://elyon-natura.vercel.app returns 200 with new asset hashes. Hard refresh: Ctrl+F5.

---

## 🌙 C. TONIGHT — run after 21:20 Skopje (19:20 UTC), after the 21:10 no-parcel run

**C0. Pre-flight.** Paste these into the Supabase SQL editor for `bmfxhgznttcnnlqloqzp`:
```sql
-- tonight's 7-day rule run: expect mode apply, cancelled ≈ 520, needs_linking ≈ 45
select run_day, mode, candidates, to_cancel, needs_linking, cancelled, ran_at
  from public.no_parcel_rule_runs order by ran_at desc limit 2;
-- must return 0 rows before you start
select pid, state, query_start from pg_stat_activity
 where query ilike '%recompute_all_segments%' or query ilike '%apply_no_parcel_rule%';
```

**C1. People (§6.2).** Run in the SQL editor:
```sql
-- Lazar Delev: owner, management team, never earns
select public.sales_person_create('Lazar Delev', '0b4b9f0f-010a-4f67-84fc-93da65f4578e'::uuid, true,
  'Owner — management team, never earns (owner 28.09)', 'management', current_date, 'member', '[]'::jsonb);
-- list the unmapped collabBox authors (expect 15 spellings, 1.364 orders)
select public.sales_teams_unmapped(90);
```
Then run this once for EACH of the 15 `collabbox_author` names, **copied exactly** from that output.
Some names contain double spaces, e.g. `Милјана  Тодоровска н.`:
```sql
select public.sales_person_create('<name>', NULL, false,
  'collabBox author (placeholder, no login) — owner 28.09', NULL, NULL, 'member',
  jsonb_build_array(jsonb_build_object('kind','collabbox_author','value','<name>')));
```
The 15 names: Александра Чима (334) · Марија Темелкова (234) · Милјана  Тодоровска н. (124) ·
Ангела Ристеска (119) · Соња Т Тасева (106) · Валентина  Богдановска н. (102) · Татјана  Кипровска (82) ·
Адела Нуманович (61) · Ангела Филиповска (60) · Аида Кајевич (56) · Тамара Радович (52) ·
Верица Костова (13) · Мирјана  Стефановски (13) · Весна Филиповска (4) · Николина Ѓоргиевска (4).
Note each person's `backstamped` count. Re-run `sales_teams_unmapped(90)`: no collabBox authors should be left.

**C2. Repairs (§6.4).** In the terminal. Make sure `.env` exists; it needs `SUPABASE_ACCESS_TOKEN`.
```bash
node scripts/assert-mk-target.mjs
node scripts/repair-test-phones.mjs                        # fresh dry run → prints a run id (expect 6 to delete)
node scripts/repair-test-phones.mjs --apply --run <id>
node scripts/engine-fixture-mk.mjs                         # must end "contract intact"

node scripts/assert-mk-target.mjs
node scripts/repair-cod-price.mjs                          # fresh dry run → run id (expect ≈478)
#   decide on the 372 PAID re-prices first (CSV in exports/repairs/)
node scripts/repair-cod-price.mjs --apply --run <id>
node scripts/engine-fixture-mk.mjs
node scripts/verify-attribution.mjs
node scripts/report-cod-mismatch.mjs
```
Undo, if needed: `node scripts/rollback-repair.mjs --run <cod-run> --apply` ·
`node scripts/repair-test-phones.mjs --restore <tp-run> --apply`.

**C3.** After the 522 cancels, re-run the upsell dry run in the SQL editor: paste
`scripts/sql/upsell-revive-dryrun.sql`. Record `revive_orders` and the other counts.
Tomorrow's `mex-reconcile` runs then revive those.

---

## 🔍 D. CHECKS (what to look at, and when)

| When | Check | Expected |
|---|---|---|
| any :07/:37 (07:00–20:55 Skopje) | `select skipped, started_at from mex_sync_runs order by started_at desc limit 3;` | the `skipped` JSON shows `upsell_revive` counts; no new `link_error` |
| tomorrow after 01:15 UTC (03:15 Skopje) | AlterCPA nightly sweep: the `altercpa_sweeps s LEFT JOIN altercpa_sync_runs r` query in `docs/ALTERCPA-BRIDGE.md` → "Sweeps" | `status='done'`, `close_reason='complete'`, `walked=true`, every slice `ok`, no new "stale: still running" rows |
| tomorrow after 02:23 UTC | `select * from order_decider_runs order by id desc limit 3;` plus `cron.job_run_details` for `stamp-order-deciders-full` | succeeded; one row with since = 10 years, limit 5000 |
| after the merge | Log in as an owner → Insights → Overview | headline + bars whose parts add up; "N во Нарачки" opens /orders with the same count; no `cohort_filter_too_long` |
| after the merge | Log in as a manager → Insights → Overview | no "ден" anywhere |
| anytime | `node scripts/verify-insights-ties.mjs --from 2026-09-22 --to 2026-09-28` | exit 0 |

The cloud session has one-shot wake-ups set for 01:50 and 02:40 UTC to do the two night checks.
If its permission guard blocks live SQL again, run them yourself.

---

## 📋 E. Open findings / follow-ups (for Mile)
- `verify-attribution` (default range) still FAILs 3 older checks. These predate this release and are not fixed yet:
  - **C7:** 132 marked paid with no MEX proof.
  - **C8b:** 56 orders whose tracking id is not in `mex_parcels`.
  - **C10:** 90 ghost parcels.
  - Warnings: C3 (7), C6 (470), C9 (1.344).
- 1 provable `needs_linking` with a different city (ORD-82442): link it by hand if it's the same customer.
- 232 NATURA M parcels with COD 0 and no web order on the phone: unexplained. 324 are web orders that web-sync never linked to their parcel; fix that in the web-sync matcher, not by hand.
- Older Overview blocks (`insights_overview` trend/teams/attention, `insights_web_block`, `insights_pivot`) still include the test phones' web orders and parcels. Small.
- Bell: `altercpa_rate`, `altercpa_rate_below` and `affiliate_lead` are missing from the type maps. `order_paid` prints `€NN.NN`. `altercpa_rate_verdict_sweep()` swallows errors. `syncAgeHours` still measures the removed BigArena upload.
- `financial_visibility` is editable but nothing reads it. The comment on `altercpa_lead_events` is wrong. Chase-job comments still say "Sofia".
- The Agents tab shows bare EUR (part of WP2). Staff EUR also shows in `MirrorTab.tsx` and `LeadDistributionPage.tsx`.
- **Next, needs a talk with Mile:** the Insights tabs rebuild (WP1–6, `audit-critic.md`); payouts/bonus; collabBox daily sync; VAT/costs/lead cost.

## 📁 F. Files
- `docs/handoff/2026-09-28/LIVE-RUNBOOK.md`: the full runbook, plus the Log of what ran.
- `docs/how-it-works.md`: the system as it runs now.
- `MACEDONIA-STATUS.md`: the current-state section is updated at the top.
- `exports/repairs/*.csv`: dry-run CSVs with PII. Local to the cloud container only, gitignored; your fresh dry runs tonight create your own.
