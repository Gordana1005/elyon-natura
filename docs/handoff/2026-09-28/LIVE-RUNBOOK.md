# LIVE RUNBOOK — cloud session 2 (28.09.2026)

Session 1 had **no network** (its container predates the "Full" network setting), so it did all
code offline: every change below is reviewed, tested (`npm test` 724/724 + `npm run build` before
TODO 4 landed) and pushed to **`claude/epic-ride-8fhxhs`**. Nothing below is applied or deployed
yet. This session has the network and the keys: **do these steps in order, verify each, and record
the results in the Log at the bottom (commit it).** Read `CLAUDE.md` and `HANDOFF.md` (same folder)
first — the GOLDEN RULE and the money rules apply to every step.

**Stop rules.** Never touch Bulgaria (`sxymaloycddnoxudxaqp`, elyoncall.com, Vercel `elyoncrm`).
Run `node scripts/assert-mk-target.mjs` (must print **Target confirmed: Macedonia**) before EVERY
migration, deploy or write. If a verification fails: stop THAT track, do not run the steps that
depend on it, fix or report. Never print secrets. Payouts/bonus math, VAT/costs, collabBox sync:
deferred by the owner — don't touch.

## 0. Setup
```bash
git checkout claude/epic-ride-8fhxhs && git pull --ff-only
printenv | grep -E '^(SUPABASE_|VITE_|ALTERCPA_)' > .env && cut -d= -f1 .env   # names only; expect the 6 keys
npm ci
node scripts/assert-mk-target.mjs
```
Deploys: `npx supabase functions deploy <fn> --project-ref bmfxhgznttcnnlqloqzp --use-api`
(`--use-api` bundles server-side; no Docker needed; `supabase/config.toml` sets `verify_jwt=false`).
Migrations: `node scripts/apply-migration-mk.mjs <file>.sql` (one file = one transaction; records
`supabase_migrations.schema_migrations`). Read-only SQL: POST
`https://api.supabase.com/v1/projects/bmfxhgznttcnnlqloqzp/database/query` with
`{query, read_only: true}` (or `sqlRead` from `scripts/lib/repair-kit.mjs`).

## 1. Snapshot the live state (read-only) → Log
```sql
select version, name from supabase_migrations.schema_migrations order by version desc limit 12;
select jobname, schedule, active from cron.job order by jobname;
select j.jobname, d.status, count(*), max(d.start_time)
  from cron.job_run_details d join cron.job j using (jobid)
 where d.start_time > now() - interval '24 hours' group by 1,2 order by 1,2;
select value from public.app_settings where key = 'no_parcel_rule';
select run_day, mode, candidates, to_cancel, needs_linking, cancelled, ran_at
  from public.no_parcel_rule_runs order by ran_at desc limit 5;
select kind, status, started_at, finished_at, left(error,120) from public.altercpa_sync_runs
 where kind in ('nightly','weekly') order by started_at desc limit 6;
```
Functions: `GET https://api.supabase.com/v1/projects/bmfxhgznttcnnlqloqzp/functions` (slug, version,
updated_at). **Expected:** latest applied = `20260939000500`; NOT applied: `20260939000300`,
`20260939000700`, `20260940000000`, `…0100`, `…0200`; no-parcel mode = `apply`. Anything else →
stop and reconcile first.

Quiet-window rule for bulk writes: after 20:55 Skopje, never while `recompute_all_segments` runs
(`select pid, state, query_start from pg_stat_activity where query ilike '%recompute_all_segments%'`).
Nightly jobs (UTC): segment recompute 00:00 · altercpa nightly 01:15 · web-sync nightly 01:01–01:51 ·
stamp full sweep 02:23 (new). The 7-day rule applies at 21:10 Skopje.

## 2. TODO 1 — seller-stamping cron (`20260939000300`)
1. `node scripts/verify-stamp-parity.mjs` → **PARITY OK** (0 row diffs in both comparisons) and
   "stored stamps … differ 0" (a few rows edited by hand after stamping may differ — list them).
   Any diff in the plan comparison → STOP (the migration and the script disagree).
2. Tripwire → `node scripts/apply-migration-mk.mjs 20260939000300_stamp_deciders_cron.sql`
   → `node scripts/engine-fixture-mk.mjs` (must pass).
3. `select public.stamp_order_deciders(interval '14 days', true);` (dry) → record candidates /
   resolvable / unresolved_by_bucket.
4. After the next `:01/:06/…` tick: `cron.job_run_details` for `stamp-order-deciders` = succeeded;
   `select * from public.order_decider_runs order by id desc limit 3;` has rows; and
   `select count(*) from orders where sold_at > now() - interval '15 minutes' and updated_at > now() - interval '15 minutes' and sold_via in ('altercpa','crm_push');`
   is 0 or explained (stamping must not bump `updated_at`).
5. Tomorrow: `stamp-order-deciders-full` (02:23 UTC) succeeded.

## 3. TODO 2 — resumable AlterCPA sweeps (`20260940000100`) + the test-phone guard
1. Tripwire → apply `20260940000100_altercpa_sweep_resume.sql`.
2. Deploy `altercpa-sync` (carries BOTH the sweep code and the test-phone guard that TODO 5 needs).
3. Right after: the next `altercpa-sync-rolling` runs are `ok`; `cron.job` lists
   `altercpa-sync-continue` (`1-59/2 * * * *`).
4. After tonight's nightly (01:15 UTC) run the verification query in `docs/ALTERCPA-BRIDGE.md` →
   "Sweeps" (the `altercpa_sweeps s LEFT JOIN altercpa_sync_runs r` query) plus
   `select j->>'job', j->>'status', j->>'last_ok_at', j->>'last_error' from jsonb_array_elements(public.integrations_health()->'feeds'->0->'jobs') j where j->>'job' in ('nightly','weekly');`
   Expected: sweep `status='done'`, `close_reason='complete'`, `walked=true`; all slices `ok`; no
   new "stale: still running" rows; nightly `ok`.

## 4. TODO 3 — mex-reconcile upsell revive (`20260940000200`)
1. Pre-flight fingerprint — expect `2e8e3881b2de77ac2b98dd4e29fb2cce`:
   ```sql
   SELECT md5(btrim(regexp_replace(regexp_replace(prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g')))
     FROM pg_proc WHERE oid = to_regprocedure('public.mex_link_parcel(text,uuid,text,boolean)');
   ```
2. Run `scripts/sql/upsell-revive-dryrun.sql` (read-only) — record `revive_orders`,
   `to_paid/to_shipped/to_returned`, `with_linked_sibling`, `excluded_cod_0`.
   **Inspect every `with_linked_sibling` row by hand**; if any looks like a different sale, switch
   the rule to the strict reading (count the phone's linked real sales too, `match.ts`
   pickCandidate) before deploying.
3. Tripwire → apply `20260940000200_mex_upsell_revive.sql` **away from :07/:37**.
4. Deploy `mex-reconcile`. Next runs: `mex_sync_runs.skipped` shows `upsell_revive` counts; no new
   `link_error`.

## 5. TODO 4 — Insights foundation + Overview cohort (`20260939000700`, `20260940000000`)
1. Tripwire → apply `20260939000700_report_excluded_phones.sql` (the ONE test-phone list:
   `report_excluded_phones`, `is_report_excluded_phone()`, `report_excluded_phone8s()`). The
   foundation refuses to apply without it.
2. Tripwire → apply `20260940000000_insights_foundation.sql` → `node scripts/engine-fixture-mk.mjs`.
3. Read-only spot checks:
   - `SELECT sale_source, count(*) FROM public.orders WHERE sale_source_detail IS DISTINCT FROM 'disposition' GROUP BY 1;`
     → only altercpa / affiliate / elyon_crm / web / collabbox / legacy, no NULL.
   - `SELECT public.insights_cohort_order_exceptions('2026-09-21T22:00:00Z','2026-09-28T21:59:59.999999Z');`
     → ≈6 web claims, ≈2 ledger entries, the 2 test phones (0 test orders once step 6.4 ran).
4. `node scripts/verify-insights-ties.mjs --from 2026-09-22 --to 2026-09-28` → exit 0 (Σ buckets =
   total in count AND value, Σ sources = total, order part = the /orders drill, test phones absent).
   Also `--from 2026-09-15 --to 2026-09-21` and `--from 2026-09-01 --to 2026-09-27`. Compare the
   headlines with `research-cohort-numbers.md` (measured 28.09 01:40, older rules): 22–28.09 ≈
   1.343 · 3.239.584 ден (expect ≤ 1.337: COD ≤ 0 parcels are replacements now, test phones out;
   value lower by the shared parcels no longer counted twice; 28.09 itself keeps growing) ·
   15–21.09 ≈ 1.701 · 4.233.908 · 01–27.09 ≈ 7.666 · 18.659.256. Record every difference and
   its cause in the Log; an unexplained one is a STOP for the api deploy.
5. Deploy `api` (tripwire first): the `/insights/cohort` route, the `cohort` embed in
   `/insights/overview`, the `/orders?cohort_bucket=…&sold_from=…&sold_to=…` drill, courier
   fallback = the MEX rate. Right after: `GET https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/api/insights/cohort`
   without a token → 401 (routing alive).
6. UI (after the merge to `main` deploys): this session has no staff login, so ask Mile to open
   Insights → Overview as an owner and as a manager and check: the headline + one bar whose parts
   add up; the manager sees no "ден" anywhere; each drill link and "N во Нарачки" opens /orders
   with the same count; no `cohort_filter_too_long` error.
Known, not in this pass: the older `insights_overview` / `insights_web_block` / `insights_pivot`
blocks (trend, teams, pivot, attention) still include the test phones' web orders and parcels —
tiny, listed as a follow-up.

## 6. TODO 5 — the owner's leftover answers
1. **C8a** (any time): `node scripts/verify-attribution.mjs --c8a-template` → put ONLY the 3
   owner-accepted double-held parcels into `scripts/data/c8a-accepted-duplicates.json` (reason:
   "owner 28.09: keep both orders — both accurate"), commit, re-run `verify-attribution` → C8a PASS.
2. **People** (after step 2 is applied — the fixed back-stamp keeps `updated_at`):
   - Lazar Delev (owner; management; never earns): find his login
     `select user_id, full_name from profiles where full_name ilike '%lazar%' or full_name ilike '%лазар%';`
     then `select public.sales_person_create('Lazar Delev', '<user_id or NULL>'::uuid, true,
     'Owner — management team, never earns (owner 28.09)', 'management', current_date, 'member', '[]'::jsonb);`
     (if he already has a sales_people row: `sales_person_update` / `sales_person_move_team` instead).
   - Unmapped collabBox authors: `select public.sales_teams_unmapped(90);` → the `collabbox_author`
     spellings (≈15, ≈1.364 orders). For EACH, exactly as shown:
     `select public.sales_person_create('<name>', NULL, false, 'collabBox author (placeholder, no login) — owner 28.09', NULL, NULL, 'member', jsonb_build_array(jsonb_build_object('kind','collabbox_author','value','<name>')));`
     → record `backstamped` per person; re-run `sales_teams_unmapped(90)` → no collabBox authors left.
3. **Dry runs (daytime):** `node scripts/repair-test-phones.mjs` and
   `node scripts/repair-cod-price.mjs` → record counts, the PAID line and exclusions in the Log
   (no PII). Send Mile the COD summary (CSV stays in `exports/`).
4. **Applies — tonight 21:20–01:45 Skopje** (after the 21:10 no-parcel run; pg_stat_activity
   clear). Prerequisites: step 2 applied, `20260939000700` applied (step 5), altercpa-sync deployed
   (step 3). Then: tripwire → `node scripts/repair-test-phones.mjs --apply --run <id>` →
   `node scripts/engine-fixture-mk.mjs` → `node scripts/repair-cod-price.mjs` (fresh dry run) →
   `--apply --run <id>` with the same flags → `node scripts/engine-fixture-mk.mjs`,
   `node scripts/verify-attribution.mjs`, `node scripts/report-cod-mismatch.mjs`.
   Undo: `node scripts/rollback-repair.mjs --run <cod-run> [--apply]`,
   `node scripts/repair-test-phones.mjs --restore <tp-run> [--apply]`.
5. **The 47 `needs_linking`:** run `scripts/sql/needs-linking-analysis.sql` (read-only); link ONLY
   `provable = true` rows whose names/cities also agree, with the statements in the file's header;
   record how many were linked and why the rest were not.
6. **NATURA "M…" COD-0 parcels:** run `scripts/sql/natura-m-parcels-vs-web.sql` (read-only) →
   record the breakdown (card-paid web orders vs unexplained) for Mile. No writes.

## 7. Gates, merge to `main`, production
1. `npm test` and `npm run build` on the branch → both pass.
2. `git fetch origin main`; if `main` moved, merge it into the branch and re-run the gates.
3. Merge the branch into `main` and push (`main` = Vercel production). Then: GitHub Actions CI on
   the new `main` commit = success (it was red for 7c462cf…d91b0a9 — fixed in 63d0eb9), and
   https://elyon-natura.vercel.app serves the new build (HTTP 200, new asset hash).
4. Deploy `api` only after its migrations (step 5) are applied and the gates pass.

## 8. Docs (last, with the real numbers)
- `MACEDONIA-STATUS.md`: rewrite the current state — applied migrations (latest version), deployed
  functions + versions, cron schedule, the 28.09 numbers from steps 2–6, open items.
- `docs/how-it-works.md` (new): the whole system as it runs now — the four sources, the cohort,
  AlterCPA / MEX / web / collabBox (paused) flows, the crons, who sees money, stamping/presence.
- Confirm every CLAUDE.md per-market rule is now TRUE (e.g. test phones deleted and excluded).

## 9. Report to Mile (English, brief)
What is live · the key numbers (cohort 22–28.09, stamps, sweeps, revives, repairs) · what's next:
the Insights tabs rebuild (WP1–6, needs a talk with him), payouts/bonus, collabBox sync, VAT/costs,
and the follow-ups in the Log.

---
## Log (fill in as you go; commit with the docs)

### Known follow-ups found in session 1 (not fixed in this pass — report them to Mile)
- Older Overview blocks (`insights_overview` trend/teams/attention, `insights_web_block`,
  `insights_pivot`) still include the test phones' web orders and parcels (tiny).
- Bell: `altercpa_rate`, `altercpa_rate_below`, `affiliate_lead` missing from the type maps (render
  grey); the `order_paid` notification prints the price as `€NN.NN` (EUR in the UI);
  `altercpa_rate_verdict_sweep()` swallows every error; `syncAgeHours` still measures the removed
  BigArena upload.
- `financial_visibility` is editable in Settings but nothing reads it; `altercpa_lead_events`'
  comment says the sync writes it (nothing does); chase-job comments still say "Sofia".
- Agents tab shows bare EUR (`fmt()`) — part of the Insights tabs rebuild (WP2), payouts deferred.
- Staff EUR displays outside the affiliate pages: `MirrorTab.tsx`, `LeadDistributionPage.tsx`.

### Session 2 — 28.09.2026 (times UTC; Skopje = UTC+2)
**§0 Setup (03:08)** — .env from the environment (6 keys: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
SUPABASE_ACCESS_TOKEN, VITE_SUPABASE_URL, VITE_SUPABASE_PROJECT_ID, VITE_SUPABASE_PUBLISHABLE_KEY; no
ALTERCPA_*), `npm ci`, tripwire → Target confirmed: Macedonia (105.496 orders, 0 on +359).

**§1 Snapshot (03:09)** — as expected: latest applied `20260939000500`; no-parcel mode `apply`
(days 7, hour 21, sources altercpa+affiliate, from 2026-08-01); last rule run 27.09 23:13 report:
569 candidates / 522 to_cancel / 47 needs_linking. Every cron job in the last 24 h `succeeded`. AlterCPA
nightly/weekly: every run since 24.09 `failed` "stale: still running after 10 minutes". Functions:
api v68, altercpa-sync v28, mex-reconcile v12, web-sync v1, collabbox-sync v2.

**§2 Stamping (03:09–03:14)** — `verify-stamp-parity`: unstamped fn 5.381 = script 5.381, all real
sales 47.917 = 47.917, 0 row diffs; stored stamps 42.536, differ 0 → PARITY OK. Applied
`20260939000300`; engine fixture intact. Dry run (14 d): 1.129 candidates, 0 resolvable, all
unresolved (AlterCPA cancelled 1.061 / trashed 33 / open 3 with "System (mex)" as first sale, 32 with
"System (repair)"). Cron `stamp-order-deciders` (`1-59/5`) first tick 03:11 succeeded,
`order_decider_runs` id 1 logged (1.129 / 0 stamped); `stamp-order-deciders-full` = `23 2 * * *`.
Orders sold+updated in the last 15 min via altercpa/crm_push: 0 (no `updated_at` bump).

**§3 AlterCPA sweeps (03:10)** — applied `20260940000100`, deployed `altercpa-sync`.
`altercpa-sync-continue` (`1-59/2`) listed and succeeding; rolling runs 03:06–03:14 all `ok`.

**§4 Upsell revive (03:10)** — fingerprint `2e8e3881b2de77ac2b98dd4e29fb2cce` ✓. Dry run: revive 0
parcels / 0 orders (to_paid/shipped/returned 0, with_linked_sibling 0, excluded_cod_0 0;
no_parcel_7d cancels now 345). Applied `20260940000200` at 03:10, deployed `mex-reconcile`.

**§5 Insights foundation (03:11–03:15)** — applied `20260939000700` + `20260940000000`; fixture intact.
Sources (non-disposition): altercpa 89.670 · collabbox 8.207 · elyon_crm 734, no NULL. Exceptions
22–28.09: 6 web claims, 0 ledger rows, test_orders [], phones 23123123/70123456.
`verify-insights-ties` exit 0 on all three windows (T1–T5, D1, D2, D4–D6 PASS):
| window | now | research 01:40 (old rules) |
|---|---|---|
| 22–28.09 (partial) | 1.321 · 3.247.209 ден (paid 704 · 1.685.032) | 1.343 · 3.239.584 (paid 723 · 1.685.032) |
| 15–21.09 | 1.629 · 4.138.998 | 1.701 · 4.233.908 |
| 01–27.09 | 7.176 · 17.968.541 | 7.666 · 18.659.256 |
Causes: the contract puts "cancelled after sale" OUTSIDE the total (old totals included it: 0 / 60 ·
113.410 / 421 · 728.490 → now 0 / 54 · 99.940 / 412 · 706.530) and COD ≤ 0 replacements outside
(26 / 27 / 124, value 0 — same paid value 1.685.032 for the week with 19 fewer rows); 22 test-phone web
orders out of 22–28.09 and 01–27.09; the rest = parcels that moved and COD updates since 01:40 (e.g.
15–21.09 without cancels: 1.641 · 4.120.498 then vs 1.629 · 4.138.998 now, +0,4%). No unexplained diff.
Gates 734/734 + build ✓ → deployed `api`; `/insights/cohort` without token → 401.

**§6.1 C8a** — the 3 owner-accepted parcels (002-9110-158918/2026, …159096/2026, …161364/2026) in
`scripts/data/c8a-accepted-duplicates.json` → C8a PASS. Same run (default range): C7 FAIL 132 (paid
without MEX proof), C8b FAIL 56 (tracking id not in `mex_parcels`), C10 FAIL 90 (ghost parcels), C3 WARN 7,
C6 WARN 470, C9 WARN 1.344 — pre-existing, not part of this pass; follow-up.

**§6.2 People** — NOT run (it back-stamps ≈1.364 orders, so it belongs in the quiet window). Lazar =
user 0b4b9f0f-…, no sales_people row; 15 collabBox spellings / 1.364 orders confirmed. Steps in
FINISH-FROM-VSCODE §C1.
**§6.3 Dry runs** — test phones: 6 to delete (1 paid, 1 cancelled, 4 trashed; 18 dependents), 2 kept
(other_prefix). COD→price: 760 mismatches → 478 re-price (Σ 870.676 → 1.456.425 ден), 282 excluded
(suspect_link 237, not_a_sale_status 24, disposition 14, zero_price 7); 372 PAID change price
(Δ 457.344 ден; under the deferred bonus rule, +495 € on 275 orders). Not applied.
**§6.5 needs_linking** — 47 orders, 3 provable; linked 2 (ORD-89633, ORD-105252; link_method
`repair` + note). ORD-82442 not linked (city differs). Not provable: cod_nofit 21, 9102/9103 only 20,
mixed 2, no free parcel 1 (+ the 3 above = 47).
**§6.6 NATURA M** — 3.175 M parcels; COD 0 = 564 (not 3.176); 324 match a COD/PAID web order that
has no parcel link (668.032 ден), 4 COD/UNPAID, 232 no web order on the phone. None card-paid.
**§6.4 / §7 / checks** — blocked in the cloud session: the push to `main` and the 19:20 UTC
wake-up were denied by the session's permission guard, as was further live SQL. Everything left is
in `FINISH-FROM-VSCODE.md`. Check-ins are scheduled for 01:50 and 02:40 UTC 29.09.
**§8 Docs** — `docs/how-it-works.md` (new), `MACEDONIA-STATUS.md` current-state section.
