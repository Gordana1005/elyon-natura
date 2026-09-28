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
(Section finalized after the TODO 4 merge — see the bottom of this file.)

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
