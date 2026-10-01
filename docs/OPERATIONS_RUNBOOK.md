# Operations runbook — Macedonia

> Deploy, migrate, schedule, repair, verify, unbreak. Rewritten 29.09.2026 against the live
> project (cron table read from `cron.job` at ~04:30 Skopje, after `20260942001300`). Credentials:
> [VAULT.md](VAULT.md) (gitignored — never copy a value out of it). Constitution: `../CLAUDE.md`.
>
> 🛑 **Bulgaria is off limits.** Supabase `sxymaloycddnoxudxaqp`, `elyoncall.com`, the Vercel project
> `elyoncrm` and the folder `C:\Users\Mile\Desktop\elyoncrm` are the LIVE Bulgarian system. The
> access token in `.env` can write to BOTH projects — only the command line protects Bulgaria.

---

## 1. Where everything runs

| Thing | Where | Identifier |
|---|---|---|
| Frontend (React SPA) | Vercel | project `elyon-natura` (`prj_cwxmm4jb74hUHmAb6YzbUG7PuDy3`), scope `gordanas-projects-a53c0208` → https://elyon-natura.vercel.app (legacy alias `elyon-macedonia.vercel.app`); push to `main` = production |
| DB + Auth + Edge Functions | Supabase | ref **`bmfxhgznttcnnlqloqzp`** — Pro plan, Small compute (t4g.small, 2 GB) since 18.08, daily backups, disk 8 GB since 28.09 |
| Edge Functions | Supabase | `api` (the one REST router — ONE deployable shared by every screen), `altercpa-sync`, `mex-reconcile`, `web-sync`, `collabbox-sync` |
| Repo | GitHub | `Gordana1005/elyon-natura`, branch `main`; local folder `D:\Dev\archives\elyon-natura` |
| AlterCPA | api.cpa.moe | read by `altercpa-sync` (+ the manual CPA push) |
| MEX Poshta | JSON API, two accounts | BIO NATURAL (`MEX_API_KEY`) and NATURA (`MEX_API_KEY_2`), read by `mex-reconcile` |
| naturatherapy.mk shop | Supabase `kctgthpoeysmhmkrnkil` — **not ours** | read only through schema `crm_export` as `elyon_crm_reader` (`web-sync`) |
| collabBox (Accent Computers) | plain-HTTP Tomcat | read only by `collabbox-sync` / `scripts/collabbox-fetch.mjs` |
| Telephony | — | deferred (Phase 2); `VITE_USE_REAL_VOIP=false` |

## 2. Before any write

1. `node scripts/assert-mk-target.mjs` — checks `supabase/config.toml`, `.env`,
   `.vercel/project.json` and the remote row counts; exits non-zero on anything Bulgarian.
2. **Pass the target explicitly.** The shell's working directory resets between tool calls
   (often to the BG repo): `git -C "D:\Dev\archives\elyon-natura" …`,
   `vercel … --cwd "D:\Dev\archives\elyon-natura" --scope gordanas-projects-a53c0208`,
   `--project-ref bmfxhgznttcnnlqloqzp`. Read back the target the tool echoes.
3. **Several sessions work on this repo at once.** `git status` and the file's mtime before editing
   shared files (`supabase/functions/api/index.ts`, `src/lib/api.ts`, the locales, CLAUDE.md), and
   deploy `api` only when `index.ts` holds finished work.
4. **Read-only SQL** for any check: POST
   `https://api.supabase.com/v1/projects/bmfxhgznttcnnlqloqzp/database/query` with
   `{query, read_only: true}`, or `sqlRead` from `scripts/lib/repair-kit.mjs`.

## 3. Local development and gates

```bash
npm install
npm run dev          # Vite → http://localhost:8080
npm test             # vitest (the real unit gate; also enforces i18n parity)
npm run build        # the real type/bundle gate — `tsc` alone is a NO-OP here (root tsconfig "files": [])
node scripts/smoke-render.mjs   # render every route headless; fails on a white screen (a missing import / TDZ read passes the build)
npm run lint         # eslint — not a CI gate
```

`.env` holds the `VITE_*` values (public) and `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_ACCESS_TOKEN`
(server-only, for scripts and the CLI). CI (`.github/workflows/ci.yml`) runs build + test on `main`.

## 4. Deploy

**Frontend** — push to `main`; Vercel builds and deploys. The cached git credential gets 403: push
with the repo-scoped PAT from VAULT §4 inline and filter it out of the output; never write it into
`.git/config`.

```bash
PAT=$(grep -oE 'github_pat_[A-Za-z0-9_]+' docs/VAULT.md | head -1)
git -C "D:/Dev/archives/elyon-natura" push "https://x-access-token:${PAT}@github.com/Gordana1005/elyon-natura.git" main 2>&1 | sed -E "s|${PAT}|***|g"
```

**Edge Functions** (after the tripwire):
```bash
npx supabase functions deploy <api|altercpa-sync|mex-reconcile|web-sync|collabbox-sync> --project-ref bmfxhgznttcnnlqloqzp --use-api
```
The CLI reads `SUPABASE_ACCESS_TOKEN` from the environment; a stale `supabase login` for another
account gives 403. Every function except `api` is called by pg_cron with a shared-secret header and
has `verify_jwt = false` in `supabase/config.toml`.

**Migrations** — `supabase db push` cannot run (the DB password was never recorded). One file = one
transaction through the Management API:
```bash
node scripts/assert-mk-target.mjs
node scripts/apply-migration-mk.mjs supabase/migrations/<file>.sql      # --dry-run to preview
node scripts/engine-fixture-mk.mjs                                     # after EVERY bundle
```
Recent migrations re-emit live function bodies behind an md5 **drift guard** — a refusal means
another session changed the function since: re-emit from the live body and merge, never force.
Finished-but-paused work lives in `supabase/paused/` (never applied; the collabBox file there is
superseded). **260 migrations applied on 29.09, latest `20260942001860`** (~12:00 Skopje). The
28–29.09 bundle: `…0900` collabBox sync · `…1000` six departments · `…1100` departments by folder ·
`…1200` leaderboard v2 · `…1300` every source every 15 min · `…1400` freshness · `…1500`
`order_departments` · `…1600` `order_origin` · `…1700` Customer 360 names each order's department ·
`…1800` `orders.dept_override` + the 4-argument `cohort_order_source` in 15 report functions (its
agent-team rule withdrawn by `…1850`) · `…1860` a CRM-made sale follows its MEX profile (BIO
NATURAL = affiliate, NATURA = by series). The `api` runs v83 (29.09 11:37, `edfa901`).

**Secrets** (names only — values in VAULT): function secrets `WEBHOOK_SECRET`,
`ALTERCPA_SYNC_SECRET` + the AlterCPA token named by `altercpa_accounts.token_secret_name`
(`ALTERCPA_PUSH_TOKEN_DRAGANA` since 18.09), `MEX_API_KEY`, `MEX_API_KEY_2`, `MEX_SYNC_SECRET`,
`WEB_SHOP_DB_URL`, `WEB_SYNC_SECRET` (+ `WEB_SHOP_DB_CA`), `COLLABBOX_USER`, `COLLABBOX_PASS`,
`COLLABBOX_SYNC_SECRET`. Each cron-called function's secret is ALSO a DB Vault row that
`invoke_*()` reads: `altercpa_sync_secret`, `mex_sync_secret`, `web_sync_secret`,
`collabbox_sync_secret` (+ `postback_drain_secret`). A missing Vault row = the cron silently does
nothing. Set with `npx supabase secrets set NAME=… --project-ref bmfxhgznttcnnlqloqzp` (Vercel env:
the REST API, never PowerShell-piped stdin).

## 5. Every cron job (pg_cron, verified live 29.09)

pg_cron runs in **UTC**. Skopje is CEST (UTC+2) until **25.10.2026**, then CET (UTC+1). Jobs with a
gate check Skopje time inside the function, so their local hours never shift; the others move one
hour earlier in Skopje in winter. A `succeeded` `invoke_*` run only means the HTTP call was queued —
the feed's own run table says whether the sync worked. Owner rule 29.09: every source at least
every 15 minutes; MEX (both accounts) is the final proof.

| Job | UTC | Skopje (summer / winter) | Gate | What |
|---|---|---|---|---|
| `altercpa-sync-rolling` | `*/2 * * * *` | every 2 min | — | new AlterCPA leads (creation-time window) |
| `altercpa-sync-status` | `*/5 * * * *` | acts 07:00–20:55 | Skopje hour 7–20 | outcomes of our open mirrored orders by `oid` (B′ map) |
| `altercpa-sync-continue` | `1-59/2 * * * *` | odd minutes | only while a sweep is open and unleased | works an open resumable sweep |
| `altercpa-sync-nightly` | `15 1 * * *` | 03:15 / 02:15 | — | opens a 7-day sweep |
| `altercpa-sync-weekly` | `45 2 * * 0` | Sun 04:45 / 03:45 | — | opens a 90-day sweep |
| `altercpa-rate-verdicts` | `5 * * * *` | acts 10:05 and 23:05 | Skopje hour 10 / 23 | AlterCPA confirm-rate bells |
| `mex-reconcile` | `7,22,37,52 * * * *` | **every 15 min 06:00–22:59** | Skopje hour 6–22 | both MEX accounts in one sweep → `mex_parcels` → links → shipped / paid / returned, rule C, upsell revive; a cancelled / trashed order is revived only by its own folder's parcel (29.09) (`20260942001300`; was :07/:37, 07:00–20:55) |
| `mex-reconcile-weekly` | `15 8 * * 0` | Sun 10:15 / 09:15 | — | 60-day MEX re-sweep |
| `web-sync` | `3,18,33,48 * * * *` | every 15 min, 24/7 | — | incremental shop mirror |
| `web-sync-nightly` | `1,11,21,31,41,51 1 * * *` | 03:01–03:51 / 02:01–02:51 | — | resumable full sweep, deletions, parcel links |
| `collabbox-sync-frequent` | `*/15 4-21 * * *` | **every 15 min 07:00–22:59** | 07:00–22:59 | full collabBox pass of yesterday + today (`20260942001300`) |
| `collabbox-sync` | `0 22,23 * * *` | **00:00** | 00:xx, once per Skopje day | nightly pass, last 3 days (catch-up ≤ 14) |
| ~~`collabbox-live`~~ | — | — | — | retired by `20260942001300` (headers-only mode still callable) |
| `link-lead-parcels` | `2 * * * *` | acts **21:02** | the no-parcel rule's hour, once a day | phone + date links of orphan BIO NATURAL 9110/9103 parcels (owner law 01.10.2026, `20260944000950`); `app_settings.link_lead_parcels.mode` report (seeded) · apply · off; every run in `data_repair_runs` (key `link-lead-parcels`), undo `scripts/rollback-repair.mjs --run <id>` |
| `leads-parcel-orders` | `6 * * * *` | acts **21:06** | the no-parcel rule's hour, once a day, only after tonight's `link-lead-parcels` run is in the ledger (waits for its lock; waits ≤ 60 s for a running collabBox pass) | a 9110 parcel MEX delivered / returned whose 10111 LEADS document no order holds → ONE order made from the document (owner 01.10.2026, `20260944000970`); `app_settings.leads_parcel_orders.mode` report (seeded) · apply · off; one `collabbox_sync_runs` row (manual, trigger cron) per apply carries the writer's re-applies; every run in `data_repair_runs` (key `leads-parcel-orders`), undo `scripts/repair-leads-parcel-orders.mjs --rollback <id>` (NOT rollback-repair) |
| `no-parcel-rule` | `10 * * * *` | acts **21:10** | `settings.hour` 21, once a day | the 10-day no-parcel rule, APPLY mode; spares `needs_linking`, `in_collab` and `postponed` (`20260944000960`) |
| `nightly-segment-recompute` | `0 0 * * *` | 02:00 / 01:00 | — | `recompute_all_segments()` (engine v3.7-mk) |
| `nightly-segment-recompute-shadow` | `30 0 * * *` | 02:30 / 01:30 | — | the v4 shadow engine |
| `insights-profit-monthly` | `40 1,2 * * *` | 03:40 | 03:xx Skopje | Pure Profit monthly cache (version 4) |
| `stamp-order-deciders` | `1-59/5 * * * *` | every 5 min | — | `sold_*` stamps for the last 14 days (≤ 1.000 rows) |
| `stamp-order-deciders-full` | `23 2 * * *` | 04:23 / 03:23 | — | the whole book (≤ 5.000 rows) |
| `lead-auto-distribute` | `* * * * *` | every minute | 09:00–19:59 only if `working_hours_only` (ships OFF) | `distribute_pending_leads(500)` |
| `presence-stale-sweep` | `*/2 * * * *` | every 2 min | — | closes presence sessions with no beat for > 3 min |
| `unpaid-delivery-chase` | `0 * * * *` | acts 09:00–11:59 | Skopje hour 9–11 | `shipped_unpaid` bells + one digest per admin (age = hours since the last ok MEX run) |
| `stock-mex-apply` | `12,42 * * * *` | :12 / :42 | returns at once while the setting is off | dark (stock is the placeholder until the owner's count) |
| `affiliate-postback-drain` | `* * * * *` | every minute | — | BG-inherited partner postback queue; nothing to send here |
| `reconcile-recording-links` | `*/10 * * * *` | every 10 min | — | recordings reconciler; idle while VOIP is off |

No Vercel crons. Check a job: `select * from cron.job_run_details where jobid = (select jobid from
cron.job where jobname = '<name>') order by start_time desc limit 5;` — then the feed's run table
(`altercpa_sync_runs` / `altercpa_sweeps`, `mex_sync_runs`, `web_sync_runs`,
`collabbox_sync_runs`) or **Settings → Integrations**.

**The night, Skopje summer:** 21:02 phone + date links → 21:06 LEADS documents become orders (MEX delivered / returned) → 21:10 no-parcel rule → MEX and collabBox passes until 22:52 / 22:45 →
23:05 rate verdicts → **00:00 collabBox nightly** → 02:00 segment recompute → 02:30 shadow →
03:01–03:51 web nightly (03:15 AlterCPA nightly sweep opens, continued every 2 min) → 03:40 profit
cache → 04:23 full stamp → Sunday 04:45 AlterCPA weekly → 06:00 MEX resumes → 07:00 AlterCPA status
and collabBox frequent resume. Always on: AlterCPA rolling, web-sync, stamping, distribution,
presence.

## 6. Bulk writes

- **Never move `orders.updated_at`** in bookkeeping or repair writes (GET /call-agains reads it as
  `last_call_at`): `SET LOCAL elyon.keep_updated_at = 'on'` (honoured since `20260939000300`).
  `session_replication_role` is refused inside functions on this project.
- Silence alert triggers with `SET LOCAL elyon.bulk_repair = 'on'`; a `sale_source` move needs
  `elyon.allow_source_change`, a seller correction `elyon.allow_sold_change`, a bulk order load
  `elyon.defer_segments` (then `segment_recompute_drain()`). All transaction-local — never a
  session SET on a pooled connection.
- **When.** The repair-kit refuses to start while `recompute_all_segments` or
  `apply_no_parcel_rule` runs, and (unless `--outside-quiet-window`) outside its quiet window
  **20:55–07:00 Skopje**. That window predates `20260942001300`: `mex-reconcile` now writes every
  15 minutes until 22:59 (and from 06:00) and `collabbox-sync-frequent` until 22:59. The calm
  stretches are **23:00–23:55** and **00:15 until the 02:00 recompute** (01:00 in winter); check
  `pg_stat_activity` and the run tables first. The 02:00 recompute once deadlocked a repair.
- Before a big import check the disk (`node scripts/db-size-mk.mjs`): the teleshop import filled the
  2 GB disk on 28.09 and the DB went read-only until it was raised to 8 GB.
- Measure database load by diffing `sum(total_exec_time)` in `pg_stat_statements`, never by a top-N
  listing.

## 7. The repair protocol and every repair

Protocol (`scripts/lib/repair-kit.mjs`): **dry run** (default — CSVs in `exports/repairs/`, a
`data_repair_runs` row with a `candidate_hash`, prints the run id) → **`--apply --run <id>`**
(refuses unless the set still hashes the same; ≤ 200-order transactions; `data_repair_rows` before /
after / evidence; an order note; an `audit_log` row; quiet window) → **rollback**
`node scripts/rollback-repair.mjs --run <id> [--apply]` (restores an order only while it still
equals `after`; `--only ORD-1,ORD-2` restricts to those orders' units; `--loose` compares status,
timestamps, reasons, tracking id and `paid_basis` but not the `mex_*` facts the cron refreshes). The
rollback is itself a recorded run (`rollback-<key>`).

| Script (key) | What it repairs | Applied runs |
|---|---|---|
| `repair-mex-ghost-links.mjs` (`mex-ghost-links`) | MEX parcels taken back off 0 ден "ghost" rows and given to the order they shipped for | `7d59b83a` 27.09 — 290 |
| `repair-altercpa-catchup-paid.mjs` (`altercpa-catchup-paid`; `--population unproven-paid` → `altercpa-unproven-paid`) | the 18.09 AlterCPA "paid" catch-up proven or cancelled; the "paid without MEX proof" population | `e3f23a0c` 27.09 — 1.128 · `c1a90c3d` 28.09 (`--evidence-guards`) — 132 → 45 cancelled, C7 132 → 74 |
| `repair-ghost-manual.mjs` (`ghost-manual`) | ghost-parcel leftovers decided case by case (collabBox document times) | `5edf77ba` 28.09 — 18 |
| `repair-test-phones.mjs` (`test-phones`) | deletes the CRM orders of the owner's two test phones (snapshot first) | `becf69c8` 28.09 — 6; undo `--restore <run>` |
| `repair-cod-price.mjs` (`cod-price`) | CRM price := MEX COD when they differ (not COD = price × 61,5 + 150, not COD 0; `order_items` scaled; `--include-zero-price`; trusts a teleshop parcel on another order only when the collabBox document names it — `collab_twin`) | `1220de9c` — 478 · `456038d9` (`--include-zero-price`) — 5 · `8e059bfe` — 34 · `f29eb4dd` — 325 |
| `repair-teleshop-twin-links.mjs` (`teleshop-twin-links`) | teleshop-import conflicts whose sale is already a CRM/AlterCPA order: link the document's parcel to that order, status from MEX | `c8dc9345` — 57; 8 rolled back (the parcel was older than the order) |
| `repair-crm-collabbox-twins.mjs` (`crm-collabbox-twins`) | one sale booked twice (CRM order + collabBox copy): the CRM order takes the parcel, the copy → `duplicated` | `3c32f8d3` — 6 |
| `repair-link-elyon-parcels.mjs` (`link-elyon-parcels`) | BIO NATURAL 9110 / 9103 parcels no order held although the sale is in the CRM (cancel-then-ship, malformed phones, re-sends) — COD-based; since 01.10 run it AFTER `repair-link-lead-parcels` for its re-ships | `8db253cc` — 141; 17 listed for a human |
| `repair-link-lead-parcels.mjs` (`link-lead-parcels`) | owner law 01.10.2026: an orphan 9110 / 9103 parcel → its order by phone + date, amount ignored (the one definition is `link_lead_parcels_plan()`, the same SELECT the 21:02 cron runs); dry run works before the migration (inline), the apply needs `20260944000950`; `--switch apply|report|off` flips the cron | dry run `54f47d5e` 01.10 — 98 link (323.820 ден), 46 manual; not applied |
| `collabbox-recredit.mjs` (`collabbox-recredit`) | LEADS documents stuck at `credit_pending` older than `collabbox_retry_open`'s 14 days, re-run through the LIVE writer once their parcel has a holder; undo `--rollback <run>` (not rollback-repair) | dry run 01.10 — 251 pending in 01.09–01.10, 79 get a holder from the backfill; not applied |
| `repair-revived-cross-channel.mjs` (`revived-cross-channel`) | old AlterCPA leads MEX revived on another channel's parcel (teleshop 9102 / web NTMK) — unlinked | `de9f07ca` — 3 |
| `repair-cross-channel-parcels.mjs` (`cross-channel-parcels`) | the whole class: AlterCPA leads the pre-guard reconcile revived out of a cancel / trash on a NATURA teleshop / social parcel (9102 · 9100 · 9108 · 1300) more than 2 days from the lead → back to their pre-flip status, parcel unlinked; same-day parcels and imported links only listed | `a057bc52` 29.09 — 145; their 125 collabBox documents then re-applied by the sync as their own orders (run `4cdb427f`) |
| `repair-folder-decides.mjs` (`folder-decides`) | owner 01.10.2026 "the collabBox folder decides" — ALL AlterCPA orders still holding a NATURA 9102 / 9100 / 9108 / 1300 parcel: per parcel one sub-transaction — the AlterCPA order back to its pre-parcel cancel / trash, or (never cancelled) cancelled by the system with reason `other` + note; the parcel unlinked; the LIVE writer re-applies its document, which must become its own Телешоп / Социјални order (else the unit rolls back). One `collabbox_sync_runs` row (manual) per apply. Listed: payout orders, LEADS-document orders, COD-0 replacements, labels stuck at MEX 8 > 14 days. Undo: its own `--rollback <run>` (deletes the made order; rollback-repair refuses the key) | dry run `b3c20364` 01.10 — 127 move (292.350 ден), 7 listed; not applied |
| `repair-leads-parcel-orders.mjs` (`leads-parcel-orders`) | owner 01.10.2026: a 9110 parcel MEX delivered / returned + its 10111 LEADS document, no order and no candidate → one order from the document (the one definition is `leads_parcel_orders_plan()`, the same SELECT the 21:06 cron runs; inline before `20260944000970`); `--switch apply|report|off`; undo `--rollback <run>` | dry run `aa562ee1` 01.10 — 121 orders (410.929 ден), 92 listed; not applied — dry-run again after `folder-decides` is applied |

Imports and reclasses have their own rollbacks — see [IMPORT_EXPORT.md](IMPORT_EXPORT.md) and
`.grok/skills/elyon-departments-and-sources`. **After any apply:** `engine-fixture-mk`, the ties
(§8), and — when sources or prices moved in closed months — a Pure Profit cache refresh.

## 8. The checks and what a FAIL means

All read-only (exit 0 = no FAIL, 1 = FAIL, 2 = refused / unreachable) except `engine-fixture-mk`,
which writes two throwaway customers and removes them. **State 29.09 09:00, September and July:**
engine fixture, `verify-insights-ties`, every `verify-tab-*` and `verify-leaderboard-v2` PASS;
`verify-attribution` shows only the standing leftovers noted below (C7 July 655 is the 11.08
"cancel(other) before August = paid" ruling, report only). After `…1800` (11:44, `40f1425`):
`verify-tab-lists` L1–L8 and the board 22–29.09 PASS (before the `…1850` / `…1860` reversal).

| Check | A FAIL means |
|---|---|
| `node scripts/engine-fixture-mk.mjs` | the segment engine's list-name contract broke — a drifted list name wipes members silently. Stop and fix before anything else |
| `node scripts/verify-insights-ties.mjs --from … --to …` | T1–T5: the cohort no longer adds up (a bucket / department rule broke) · D1: a sale in two buckets or a parcel owned twice · D2/D3: the `/orders` twin drifted from the SQL (change both) · D4: a test phone leaked into a figure · D5: cash ≠ the MEX register · D6: a shared parcel valued twice |
| `node scripts/verify-attribution.mjs [--from … --to …]` | C1: Overview tiles ≠ Σ departments / SQL truth · C2: MEX-only cash by series does not tie (a parcel rule changed without the checker) · C3: the Lists tab ≠ Σ departments · prediction_list, or its footer ≠ the Affiliate – Lead out card · C6: proven cash ≠ Σ COD · C7: paid without MEX proof (**standing 37** pre-existing AlterCPA rows — a list for a human, not a mass fix) · C8a: one parcel on 2+ live orders (3 owner-accepted pairs in `scripts/data/c8a-accepted-duplicates.json`) · C8b: a tracking id MEX does not know (**standing 14**) · C8c: link disagrees (WARN for re-sends) · C9: AlterCPA wrote money · C10: a ghost parcel · C12: an order without `sale_source` (the insert classifier failed) · C13: < 99 % of decisions have a person · C14: the web block ≠ the shop's classifier · C4 / C5: the two legacy v1 boards (`leaderboard_day`, still the api's default response) no longer tie to the sales ledger |
| `node scripts/verify-leaderboard-v2.mjs [--from … --to …]` | the TV board v2 (`leaderboard_day_v2`): L1 a person × department cell ≠ the truth recomputed from orders + `v_sales_work` + collabBox bookings · L2 Σ board per department ≠ `insights_cohort` · L3 a sale counted twice or missed · L4 rank / a manager ranked · L5 a team member or an active login missing · L6 `no_department` or `bookings_filter_drift` ≠ 0 (the booking filter copy drifted from `collabbox_booked_today`) · L7 a filter shows the wrong people |
| `node scripts/verify-tab-sales.mjs` · `-agents` · `-profit [--cache]` · `-lists` · `-returns [--year]` · `-work` | that tab's RPC no longer ties to the cohort for the same window. `verify-tab-lists` L8 flickers only while the lists recompute (02:00) |
| `node scripts/verify-parcel-link-rules.mjs [--list]` | L1 the plan hash ≠ the repair-kit's (the ledger contract broke) · L2–L4 a planned link breaks the owner's rules 1–3 (checked by an independent query) · L5 the 72 h product rule · L6 a status target is not the MEX law · L7 a payout / affiliate order planned · L8 the name fold · L9 the live plan / cron / switch differ from the migration · N1 the postponement regex · N2 (info) today's no-parcel candidates per exemption |
| `node scripts/verify-folder-orders.mjs [--from … --to …] [--list]` | B1 the LEADS plan hash ≠ the repair-kit's · B2 a parcel / document breaks rule 1–2 (independent query) · B3 a TWIN: the linker has a row, a living Affiliate sale is on the phone, or the writer's twin rule fits · B4 an order ≠ its document (price rule, MEX status, author) · B5 a made order is not Affiliate – Lead in · A1 a folder unit would leave its holder alive or send a parcel outside Телешоп / Социјални · C1 a moved parcel counted twice in the cohort (the per-department before / after table prints; Σ moves only by sales crossing the window edge) · L1 an applied run's order lost its parcel / ledger / department · W1 the live plan / cron / switch / guard differ from the migration, or the two writer helpers the plan spells out changed |
| `node scripts/verify-stamp-parity.mjs` | the stamping cron and `backfill-order-deciders.mjs` disagree |
| `node scripts/verify-altercpa-bridge.mjs --days 7` · `verify-altercpa-status.mjs` | the ledger / orders miss leads the API has, a foreign lead has an order, or outcomes disagree |
| `node scripts/verify-sticky-trash-mk.mjs` | one of the 8 sticky-trash / cancel behaviour cases broke |
| `node scripts/audit-segments-integrity.mjs` | engine drift, label / band violations, pollution, missing customers, dead cron (baselines in `.grok/skills/elyon-segments-and-prediction`) |
| `node scripts/verify-stock.mjs` | meaningful once the owner's stock count exists |

## 9. Routine operations

| Task | How |
|---|---|
| Is a feed alive? | Settings → Integrations (owners), or `select public.collabbox_feed_state();` and the run tables — never the cron's green tick |
| collabBox: dry-run a day, run a window, pause | below, and `.grok/skills/elyon-collabbox-sync` §Runbook (windows ≤ 4 days per call; never across 00:00 Skopje) |
| Phone + date links | preview `node scripts/verify-parcel-link-rules.mjs` (read-only, L1–L9 + today's no-parcel exemptions) or `select public.link_lead_parcels_plan(75);` · one-off backfill `scripts/repair-link-lead-parcels.mjs` · switch `--switch apply` · undo `scripts/rollback-repair.mjs --run <id> [--loose]` |
| LEADS documents → orders (MEX delivered / returned) | preview `node scripts/verify-folder-orders.mjs` or `select public.leads_parcel_orders_plan(75);` · backfill `scripts/repair-leads-parcel-orders.mjs` · switch `--switch apply` · undo `--rollback <id>` |
| The no-parcel rule | preview `select public.apply_no_parcel_rule(false, true);` (answers `in_collab` / `postponed` too) · mode switch only in Settings → Integrations (audited; a trigger blocks direct `app_settings` edits) · report CSV `GET /api/integrations/no-parcel-rule/report` |
| Refresh the Pure Profit cache | owners' button, or `POST /api/insights/profit/refresh?from&to` — after any reclass or department-rule change that reaches a closed month (they keep `updated_at`, so the nightly refresh does not see them) |
| Recompute the lists | the nightly cron; by hand in batches (111k phones) — never concurrently with a bulk writer |
| Create a user | /users, or `node scripts/create-user-mk.mjs` (public signup is off). Suspend does NOT block sign-in — ban in auth to lock someone out |
| Unpaid-delivery chase | automatic 09:00–11:59; preview `select public.notify_unpaid_shipped_orders(true, true);`; pause `select cron.unschedule('unpaid-delivery-chase');` |

### A manual collabBox window (catch-up or backfill)

The crons already re-read yesterday + today every 15 minutes (07:00–22:59) and the last 3 days at
00:00, and `collabbox_retry_open` retries open rows of the last 14 days. Run a window by hand only
for older days — a missed stretch, open rows older than 14 days, or a history backfill.

1. **When:** 23:00–23:55, or after the 00:00 nightly has finished and before 07:00 Skopje. Only
   one nightly/manual run at a time: a second one — and every frequent pass meanwhile — gets
   **409 `already_running`**. Never let a window run across 00:00 (the nightly waits a day) or into
   07:00 (the day's passes are skipped).
2. **Dry-run one day first** — it writes nothing (no order, ledger or run row); the output holds
   customer data, keep it out of git:
   ```bash
   curl -s -X POST https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/collabbox-sync \
     -H "x-collabbox-sync-secret: $COLLABBOX_SYNC_SECRET" -H "Content-Type: application/json" \
     -d '{"mode":"manual","from":"2026-09-20","to":"2026-09-20","dry_run":true}' > exports/collabbox/dry-2026-09-20.json
   ```
   The secret is the function secret `COLLABBOX_SYNC_SECRET` (= Vault `collabbox_sync_secret`,
   value in VAULT) — keep it in an environment variable, never on a command line you paste.
3. **Run windows of at most 4 days**, one after another, synchronously so each answers with its
   summary:
   ```bash
   curl -s -X POST https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/collabbox-sync \
     -H "x-collabbox-sync-secret: $COLLABBOX_SYNC_SECRET" -H "Content-Type: application/json" \
     -d '{"mode":"manual","from":"2026-09-17","to":"2026-09-20","wait":true}'
   ```
   A run stops at its time budget (115 s synchronous, 330 s in the background without `wait`,
   which answers `202` + `run_id`) or at 100 requests; a longer window ends `partial` with
   `stopped before <day> (…)` — start the next window from that day. `to` may not be in the
   future; the code refuses more than 14 days.
4. **Check** each run before the next: `select kind, trigger_kind, status, window_from, window_to,
   created, updated, conflicts, credited, pending, errors, warning from collabbox_sync_runs order by
   started_at desc limit 5;` — `failed` / `errors > 0` → read `error` / `stats` before going on.
   Conflicts are listed for a human, never forced. When a window moved sales in closed months,
   refresh the Pure Profit cache for them.

## 10. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Every API call CORS-errors | a new frontend origin not in the api's `ALLOWED_ORIGINS` → edit + deploy `api` |
| `functions deploy` → 403 | stale `supabase login` for another account → rely on `SUPABASE_ACCESS_TOKEN` |
| `git push` → 403 | the cached credential → push with the VAULT §4 PAT (§4) |
| A feed card is red / stale | read its run table's `error` / `warning`; a `running` row older than its limit was killed (collabBox 20 min, others 10–15 min) |
| "No AlterCPA leads came" | usually wrong: compare `altercpa_leads` with `orders`; check `skip_reason` (`unmapped_offer` → map the offer on /altercpa); the token goes as `?id=` |
| collabBox run `failed` "… layout changed?" | a draft document without a number is tolerated (≤ max(3, 5 %) incomplete rows a day since `20ad77d`); more means collabBox changed its page — read the warning, do not loosen blindly |
| collabBox 409 `already_running` | a manual / nightly run is in progress — wait; frequent passes skip themselves meanwhile |
| A department figure moved but Pure Profit did not | the monthly cache: refresh the months (a reclass does not bump `updated_at`) |
| White screen after a deploy | a missing import or a TDZ read that `npm run build` let through → `node scripts/smoke-render.mjs`. Since `6fbbcd5` a render error shows a Reload button (`AppErrorBoundary`) and a tab that asks for a lazy chunk of an older deploy reloads itself once (`vite:preloadError` in `main.tsx`) |
| A login lands on the wrong page, loops, or sees "no page" | the landing rule is `homePath()` (`src/lib/homePath.ts`: admins / managers / owners → /insights, call agents → /calls, warehouse → /warehouse, ads admin → /webhooks, else the first page they may open); the login goes to `/start`, which waits for the permissions. "No page" = the login may open nothing → give the role a module in Settings. `/assigned` is retired → /calls |
| An empty grey area below a page (the window scrolls, the sidebar is cut off) | an absolutely positioned element escaped the app frame: `AppLayout`'s frame and `<main>` must stay `position: relative` (`81f4182`) |
| Order creation fails on the display id | the `LPAD` trap (fixed in `20260933000000`) — any new id code must not truncate |
| The DB went read-only | disk full → raise it in the dashboard (owner's OK), resume the importer from its ledger |
| `db push` refuses / asks for a password | expected — use `apply-migration-mk.mjs` |

## 11. Backups, ledgers, disaster recovery

- Supabase Pro daily backups. Every data change of consequence has its own ledger:
  `data_repair_runs` / `data_repair_rows` (repairs, catalogue runs), `teleshop_import_documents` /
  `_customers`, `collabbox_documents` / `collabbox_sync_runs`, `sale_source_reclass`,
  `no_parcel_rule_runs` / `_items`, `order_decider_runs`, `altercpa_sync_runs`, `mex_sync_runs`,
  `web_sync_runs`; `audit_log` and `order_history` are append-only.
- Output files of dry runs (`exports/…`) hold customer data: gitignored, never committed.
- A fresh environment: a new Supabase project → apply every migration in order
  (`apply-migration-mk.mjs`, or `db push` with a recorded password) → deploy the five functions →
  set the function secrets AND the Vault rows → `config.toml` / `.env` / Vercel env / the api's
  `ALLOWED_ORIGINS` → `create-user-mk.mjs` → the address stack (`import-mk-settlements.mjs`,
  `import-mk-streets-osm.mjs`, `fetch-mex-cities.mjs`, `map-settlements-to-mex.mjs`). Point
  `assert-mk-target.mjs` at the new ref first.
