# scripts/db-move — the move to the new Supabase project (03.10.2026)

The Macedonian CRM moves from `bmfxhgznttcnnlqloqzp` (org `naturatherapykosovo`, Ireland) to
**`oufoazmnbwugtfldkwsn` = `naturall`** (org `elyongroup`, Frankfurt). Plan and decisions:
`exports/db-move/checklist-2026-10-02.md` (inventory, appendices) and the approved plan of 03.10.
Everything here is pinned to those two refs and refuses the live Bulgarian project by name.

## Phase 1 (done on the night of 03.10) — a complete, verified replica, cron INACTIVE

| Step | Script | Notes |
|---|---|---|
| secrets | `collect-secrets.mjs` | the 15 function secrets from `docs/VAULT.md`, each proven by SHA-256 against the source project's digests → `exports/db-move/<date>/secrets.env` |
| new project prep | `prep-new.mjs` | signups OFF first, the source's auth settings copied (allow-list), extensions (`pg_trgm` in `public`!), PostgREST compared |
| functions | `deploy-functions.mjs` | 15 secrets → `POST /secrets`; 6 × `supabase functions deploy … --use-api --no-verify-jwt`; proof |
| dump | `dump-old.mjs` | source read with the Management API `cli/login-role` (5-minute `cli_login_postgres`, `--role postgres`); `--schema public` only — cron / net / vault never travel; `auth.users` + `auth.identities` data; `supabase_migrations`; `--from <step>` resumes |
| restore | `restore-new.mjs` | schema → data (replica mode, one transaction) → history → fixes (role timeouts, publication, auth trigger, 5 vault rows) → migration `20260948000100` → cron (41, inactive) → `check` vs `baseline-old.json` → `report.json`; `--from <step>` resumes |
| migration | `gen-move-migration.mjs` | generates `supabase/migrations/20260948000100_project_move_function_urls.sql` from the live bodies of the 7 cron callers |
| data | `load-data.mjs` | the table-by-table loader (autocommit per COPY, resumable; the big tables' plain indexes dropped and rebuilt) — the single-transaction load of `orders` crashed the Small instance |
| **privileges** | `sync-acls.mjs` | **run after EVERY schema restore**: pg_dump writes ACLs relative to the built-in defaults, but Supabase's ALTER DEFAULT PRIVILEGES hand anon / authenticated EXECUTE on every restored function (and ALL on every table) — 544 objects came back more open than the source. Dry run, then `--apply`; verify-address-routing R7 is the canary |
| chain test | `invoke-fn.mjs` | calls one sync function on the new project with its secret header (web-sync, mex-reconcile, altercpa-sync rolling, collabbox-sync live, collabbox-shops sales) |

**Verification on 03.10 (new project, cron inactive):** every verify script was run on BOTH projects; the only
failures specific to the replica are the checks that expect an ACTIVE cron job (verify-collab-entry-rule E1/D1,
verify-stock-v2 S1) — intended until the cutover. verify-shifts S1, verify-assigner L1, verify-booking-day B4b,
verify-attribution C3/C7/C8b, verify-leaderboard-v2 L3, shops H2 fail identically on the old project (pre-existing,
for the owner). engine-fixture passes; a real password login + `api/me` + `get_my_permissions` work on the new project.

Credentials never leave `.env` / `docs/VAULT.md` / `exports/db-move/<date>/` (all gitignored). `pgpass.conf` holds the
new project's `postgres` password (reset through the API 03.10) and the short-lived source login.

## Aiming any script at either project

`scripts/lib/target.mjs` decides the target: `supabase/config.toml`, or `ELYON_TARGET_REF` during the move. With the
override set to the new ref, every `KEY_NEW` of `.env` replaces `KEY` (token, service role, URLs).

```
node scripts/with-target.mjs new -- node scripts/verify-shifts.mjs
ELYON_TARGET_REF=oufoazmnbwugtfldkwsn node scripts/assert-mk-target.mjs
```

## The cutover — DONE Saturday 03.10.2026, live 21:34 Skopje

| Step | Tool | Took |
|---|---|---|
| parity (functions, columns, indexes, triggers, policies, constraints, migrations) | `cutover.mjs parity` | 15 s |
| freeze the old project after the 21:02–21:20 rule jobs (cron off, drain, read-only, terminate) | `cutover.mjs freeze` | 10 s (21:22:18) |
| fresh dump (1,07 GB, 170 tables, auth users, history) | `dump-old.mjs <dir> --postgres` | 2 min |
| wipe + load table by table, indexes rebuilt, counts = dump | `load-data.mjs <dir> --fresh` | 4 min |
| counts / sequences = freeze baseline, privileges, no writes after the freeze, parity incl. settings | `restore-new.mjs --from check`, `sync-acls.mjs`, `cutover.mjs writes-since`, `parity` | 1 min |
| functions redeployed from main | `deploy-functions.mjs` | 1 min |
| Vercel Production env → new project (read-back) | `cutover.mjs vercel-env` | 5 s |
| repo: config.toml, `.env`, RETIRED_REFS, preconnect, refs in scripts / docs, CLAUDE.md | `switch-repo.mjs --apply` + commit `abb6496` | 1 min |
| production build, live bundle names only the new host | `cutover.mjs vercel-wait <sha>` | 2 min |
| smoke on naturall.mk: admin login, Табла, /orders, /calls, /warehouse — 62 requests, all to the new host, 0 errors | Playwright | 2 min |
| cron ON (41/41), first runs of altercpa / web / mex / shops ok | `cutover.mjs cron-on` | 21:34:14 |

Downtime (no logins, no writes): **12 minutes**. Everyone logs in once more with the same password.

Learned that night:
- PostgREST opens its transactions READ WRITE, so `default_transaction_read_only` does not stop API writes; the freeze
  holds because cron is off and logins / session refresh fail (existing sessions die within the hour). `writes-since`
  proves nothing was written.
- The platform's `cli/login-role` needs a writable database: a frozen source is dumped as `postgres` (password set
  through `PATCH /v1/projects/<ref>/database/password`, kept in VAULT §1), hence `dump-old.mjs --postgres`.
- `.env` after the switch: the main keys are the new project's; the old project's stay as `*_OLD` (the db-move scripts
  read both layouts).

**The old project `bmfxhgznttcnnlqloqzp` is frozen: read-only, cron off, the rollback copy.** Rollback (only meaningful
before staff write on the new project): `cutover.mjs cron-off` → `cutover.mjs vercel-env-old` + revert `abb6496` and push →
`cutover.mjs unfreeze`. Delete it (and cancel Pro on `naturatherapykosovo`) only with the owner's sign-off, ~30 days on.

## How the cutover was planned (kept for the next move)

1. Every migration applied to the OLD project after the dump is applied to the NEW one the same day
   (`node scripts/with-target.mjs new -- node scripts/apply-migration-mk.mjs <file>`).
2. Quiet window: pause the 41 cron jobs on OLD (checklist appendix B), read-only, baseline.
3. Fresh data: `dump-old.mjs --from data` (data + auth), then on NEW truncate `public` + auth tables and load
   `auth-data.sql` + `data.sql` in replica mode (or a full re-run of `restore-new.mjs` on a wiped project);
   counts = baseline, sequences ≥ baseline.
4. Vercel Production env (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`) →
   redeploy; the CSP already allows both hosts.
5. Smoke as admin + agent → GO: `select cron.alter_job(jobid, active := true) from cron.job;` on NEW, 0 active on OLD.
6. Repo cutover commit: `supabase/config.toml`, `.env` main keys, `RETIRED_REFS = [old]` in `target.mjs`,
   CLAUDE.md, VAULT, memory, `index.html` preconnect.
7. Rollback R1: Vercel Instant Rollback + cron back on OLD, off on NEW. Never both active.
