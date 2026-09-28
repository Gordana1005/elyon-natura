The migration is written: `D:\Dev\archives\elyon-natura\supabase\migrations\20260939000300_stamp_deciders_cron.sql`. Nothing was applied, committed or pushed. It re-derives every real sale in the database exactly as `scripts/backfill-order-deciders.mjs` does, with 0 row differences on live data.

**One thing to know before reading the numbers:** someone ran `backfill-order-deciders.mjs --apply` by hand after the task was written. Nina's approval (ORD-108886) now carries altercpa / 3917 / 00:25:40. So right now nothing is waiting to be stamped, and a first cron run on today's data would write 0 rows. That is why I also ran the comparison on already-stamped orders.

**What the file adds**
- `order_decider_plan(p_since)`: read-only. One row per order in scope, each marked stamp, no_time, unresolved (with the script's bucket text) or fill_person. Plain SQL with no temp tables, so it runs in a read-only transaction.
- `stamp_order_deciders(p_since '14 days', p_dry_run false, p_limit 5000)` returns jsonb: `{candidates, resolvable, stamped, stamped_by_rule, person_filled, by_rule, by_via, unresolved_by_bucket, decider_without_person, plan_ms, ms, …}`.
  - SECURITY DEFINER, search_path pinned, one run at a time.
  - Apply is a single guarded UPDATE. Rows another writer has locked are skipped and picked up next run. Person ids are re-checked.
  - The dry run is SELECTs only. Apply refuses read-only sessions and `supabase_read_only_user`.
  - Execute is granted to service_role, plus `supabase_read_only_user` for dry runs (only if that role exists).
- pg_cron job `stamp-order-deciders` at `1-59/5 * * * *` (every 5 minutes, one minute after altercpa-sync-status). The schedule block is idempotent, like the no-parcel migration.

**Rules ported (same order as the script)**
1. collabbox_author
2. history_import (''/Import/System fall back to assigned_agent_name)
3. crm_decided (first human transition into a sale) or crm_decided_pushed (a non-noop `order.altercpa_push` 15 min before to 5 min after an approved/cancel_other decision)
4. crm_push_only / altercpa_ledger (identity of kind altercpa_user, per ledger account)
5. crm_confirmer (no history, not an AlterCPA order)

The candidate filter is also the script's: price > 0, not a synthetic product, not duplicated, and a sale now, in history, or approved/cancel_other in AlterCPA. `sold_by_ext` is kept even when no person matches.

**Name matching has no transliteration fold, on purpose.** The fold runs once, human-reviewed, when `seed-sales-people.mjs` registers each spelling as its own identity. The script, the live trigger and `v_sales_work` all match names exactly, so this does too.

**Scope and person fills**
- Stamps: orders with no `sold_at` that were created or updated in the window. I also added two cases that don't bump `updated_at`: a history transition into a sale, or the order's ledger row being decided or changing phase in the window.
- Fills: any stamped order with no person whose `sold_by_ext` now resolves, with no time limit. The resolution follows the script (and `sales_backstamp_orders`). `p_limit` writes stamps first, newest first, then fills.

**How `updated_at` is kept (not replica mode)**
- `has_parameter_privilege('postgres','session_replication_role','SET')` is false on the live Macedonian database. The script's top-level `SET` only works because supautils lifts that one statement for its privileged role, and `set_config()` inside a function doesn't get that.
- Instead, `update_updated_at_column()` now skips the bump when the transaction sets `elyon.keep_updated_at = 'on'`. The function sets it LOCAL around its UPDATE and clears it afterwards.
- This is the shared function behind 21 triggers (orders plus 20 others). Its behaviour only changes when that setting is on.
- Only three things fire when the sold columns alone are written: the updated_at trigger, the write-once trigger and the foreign key. The last two stay on.

**Parity (live, read-only, same scope clause given to the script's `planPageSql`, compared row by row)**

The script's own full dry run: 5,381 candidates, 0 resolvable. CSV: `D:\Dev\archives\elyon-natura\exports\attribution\order-deciders-2026-09-27T23-55-41-928Z.csv`.

| Scope | Mine / script | Per rule (identical in both) | Row diffs |
|---|---|---|---|
| 14 days, unstamped (what the cron sees) | 1,129 / 1,129 | all unresolved: 1,061 AlterCPA cancelled then delivered via MEX · 33 trashed · 32 repair · 3 open | 0 |
| 14 days, including stamped | 6,575 / 6,575 | collabbox_author 2,622 · altercpa_ledger 2,019 · crm_decided 560 · history_import 242 · crm_decided_pushed 3 · unresolved 1,129 | 0 |
| All time, unstamped | 5,381 / 5,381 | buckets match the CSV | 0 |
| All time, including stamped | 47,917 / 47,917 | history_import 30,428 · collabbox_author 8,047 · altercpa_ledger 3,106 · crm_decided 923 · crm_decided_pushed 31 · crm_confirmer 1 · unresolved 5,381; with a person 27,704 in both | 0 |

- Against the stamps already stored, via, ext and person match on every order. The 953 crm/crm_push rows differ in `sold_at` by under 1 ms, because the script passes timestamps through a JS Date; the function keeps microseconds.
- I also built the three migrations in a throwaway in-memory Postgres (PGlite) and ran 39 checks, all passing. They cover: the function's apply giving the same sold columns as the script's `--apply` on identical data, `updated_at` untouched, the setting cleared afterwards, idempotency, fills, `p_limit`, a mixed stamp-and-fill run, read-only refusals, grants and the cron re-run.

**Performance (server-side, pg_stat_statements)**
- The full 14-day dry-run SELECT, plan plus summary: 208–215 ms, mean 211 ms. The plan alone: mean 231 ms.
- The main costs are a scan of orders (~55 ms), the scope check (~91 ms) and the fill scan (~41 ms).
- No index is added. That is roughly 210 ms every 5 minutes, and trying the scope first was slower (534 ms).

**Worth flagging**
- `sales_backstamp_orders` in `20260939000200` (another session's file, which I didn't touch) turns on replica mode with `set_config('session_replication_role', …)`. Given that privilege is false, this is likely to fail quietly and fall back to triggers on, which bumps `updated_at` on the orders it back-stamps. Once this migration is in, it could use `set_config('elyon.keep_updated_at','on',true)` instead.
- Once the cron runs, the leaderboard's ledger fallback becomes a safety net only; `live_credited_sales` should stay near 0.

Test harnesses are in the scratchpad: `stamp\parity.mjs` and `pgparse\stamp_sandbox.mjs`.