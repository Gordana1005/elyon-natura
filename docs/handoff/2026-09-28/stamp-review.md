**Verifier B: adversarial review of `20260939000300_stamp_deciders_cron.sql`**

Everything I ran was read-only SQL or an in-memory PGlite database. Nothing was applied or committed.

Current state: the 14-day plan built from the migration text gives 1,129 unresolved rows and nothing to stamp. The all-time plan gives 5,381 unresolved, 0 to stamp and 0 person fills. Re-deriving the stamps already stored in the 14-day window matches via, ext, person and sold_at (within 1 ms) on all 5,446 rows. So a first run today writes 0 rows.

**Defects**

**1. MEDIUM (not triggered yet): a push by a manager can make that manager the seller of an AlterCPA approval.**
- The `push` CTE counts any non-noop `order.altercpa_push` in the window from 15 minutes before to 5 minutes after AlterCPA's decision. It never looks at what kind of push it was.
- The rule `crm_push_only` then credits the person who pressed the button (`push_by`). The fill path does the same through "the pusher whose profile name it is".
- Live push payloads come in three kinds: approval (`params.accept='1'`, 35 rows), callback (`params.status='3'`, 30 rows) and cancel (`params.status='5'`, 242 rows).
- Every push was made by Kalina Tajkovska (277), Dragana (26) or Mile Stoev (4). All three are sales_people with `is_manager = true`.
- The deciding agent is written in `params.comment` ("Agent: Iva — …"), but nothing reads it.
- I ran a PGlite demo (`...\scratchpad\pgparse\vb_push_demo.mjs`) with the live payload shapes. Nina (#3917) approves in their panel. Kalina's push is either a callback 12 minutes before, a cancel 3 minutes after, or an approval. In all three cases the order is stamped `crm_push`, `ext='Kalina Tajkovska'`, person Kalina (a manager). Without a push it goes to Nina.
- The engineer's own sandbox asserts the same outcome: a `{status:3}` push gives `pushOnly → Dragana` (`stamp_sandbox.mjs` line 219).
- Live data today: `crm_push_only` has 0 rows. All 31 `crm_decided_pushed` rows came from approval pushes. The closest cases are ORD-89691 and ORD-89705: a callback push 170 minutes after the approval, outside the window only by timing.
- The 5-minute cron plus write-once would make any such case permanent.
- Fix (keep the script's `planPageSql` in step, and update the sandbox assertion):
  - In `push`, add `AND a.payload->'params'->>'accept' = '1'`.
  - Extract `agent_name := nullif(btrim(split_part(substring(a.payload->'params'->>'comment' FROM '^Agent: (.*)$'), ' — ', 1)), '')`.
  - For `crm_push_only`, use person = the `order_name` identity of `agent_name` and ext = `coalesce(agent_name, push_name)`.
  - In the fill's `crm_push` branch, drop the "pusher's profile name" lookup.
  - Impact on live rows today: 0.

**2. LOW: the locks taken are stronger than needed, and a full batch holds them for a while.**
- `lk` uses `FOR UPDATE OF o SKIP LOCKED`. `FOR UPDATE` conflicts with the `FOR KEY SHARE` that every foreign-key check takes.
- Eleven tables reference `orders(id)`, including `order_history`, `altercpa_leads.order_id`, `mex_parcels`, `order_items`, `order_notes` and `prediction_segment_members.trigger_order_id`.
- So while the cron holds a row, inserts into those tables for that order wait. That covers `altercpa-sync` and `mex-reconcile` history rows, agents' status changes, and `recompute_all_segments` member inserts. The cron itself never waits on them.
- `orders` has 51 indexes, and 3 of them include sold_* columns. Every stamp and every fill is therefore a non-HOT update.
- For scale: the script's `--apply` chunks of up to 2,000 rows, with triggers off, took 480 ms on average (764 ms max) and wrote about 60k WAL records each. A 5,000-row run, as in a catch-up after an AlterCPA outage, would hold locks for a few seconds. Agent sessions give up after an 8 s lock timeout.
- Fix: use `FOR NO KEY UPDATE OF o SKIP LOCKED`; no key column changes, so it is correct. Lower the default `p_limit` to 1000, which still clears 12k rows an hour.

**3. LOW: the 14-day window is the only thing that decides which orders get stamped.**
- Orders outside the window are never revisited. That includes:
  - writes made with the new `elyon.keep_updated_at` (the pending `20260939000350` already uses it for data fills), so `updated_at` no longer shows the order changed;
  - replica-mode repairs;
  - a ledger `order_id` linked late;
  - a cron outage longer than 14 days.
- The all-time plan costs about 0.8 s against about 0.55 s for 14 days (round trip minus a 0.35 s baseline), so the window saves little.
- Fix: add a nightly sweep. The advisory lock already prevents overlap with the 5-minute job.
  ```sql
  SELECT cron.schedule('stamp-order-deciders-full', '23 2 * * *',
    $job$SELECT public.stamp_order_deciders(interval '10 years');$job$);
  ```
  Wrap it in the same unschedule-if-exists block the migration already uses.

**4. LOW: the result of each run is not kept anywhere.**
- Failures do show: they appear as `failed` in `cron.job_run_details` and in the live `integrations_health()`, which lists every job.
- But pg_cron throws away the returned jsonb (stamped, unresolved buckets, decider without a person).
- A manual call left open in a transaction keeps the advisory lock. With `idle_in_transaction_session_timeout = 0` that can last forever, and every run then "succeeds" with `skipped`.
- Fix: log each non-dry run's result to a small run table, and make a skipped run show as failed rather than succeeded.

**5. Interaction: `sales_backstamp_orders` from `20260939000200` is already live and will bump `updated_at`.**
- `has_parameter_privilege('postgres','session_replication_role','SET')` is false.
- supautils only lifts `SET` statements, not `set_config()` calls. The function catches the error and falls back to triggers on.
- The audit log has no Settings → Teams actions yet, so it has not happened so far.
- Fix (that session's file): use `set_config('elyon.keep_updated_at','on',true)` and clear it afterwards.
- Also: `20260939000350` adds `orders.not_counted_reason`. The plan and fill should exclude those rows once it lands. Today that affects 0 rows, because only price-0 rows carry it.

**6. Corrections to the engineer's report.**
- 20 tables use `update_updated_at_column()` including orders, not 21.
- All 17 cron jobs run as `postgres`. The statement timeout that applies is therefore 120 s (from `/etc/postgresql-custom/platform-defaults.conf`), not service_role's 30 s.

**Answers to the checklist**
- **Overwriting an existing stamp:** no. Stamps are guarded by `sold_at IS NULL`, fills by person NULL plus the same via and ext. These are rechecked on the latest row version, the write-once trigger stays on, and 0 live rows are partially stamped.
- **Crediting a warehouse user who moved an order to shipped:** no new path.
  - All 912 human first-sale transitions on MK go into `confirmed`; none go into shipped, delivered, paid or returned.
  - AlterCPA orders start with a `System (altercpa)` row.
  - `crm_confirmer` excludes AlterCPA orders.
  - The live trigger's "first confirmer set" branch is older behaviour, outside this migration.
  - Optional hardening: count only human transitions into `confirmed` (0 live rows change).
- **Crediting an admin who pressed the push:** yes, see defect 1.
- **Stamping 0-price, 'No prior product on file' or duplicated rows:** no. The filter needs price > 0, and `is_synthetic_product_name` matches `'^(Cancelled|Trashed|No prior product on file)'`, excluding the ghost-paid rows. Status must not be `duplicated`, and all 6,885 disposition rows are unstamped.
- **Bumping `updated_at`:** no, and segments are not recomputed.
  - Of the 24 triggers on orders, a sold_*-only update fires just three things: `trg_orders_sold_write_once`, `trg_orders_updated_at` (which keeps NEW when the setting is on), and the foreign-key check on `sold_by_person_id`.
  - `trg_orders_segments_status` fires only on `status, price, customer_phone`, and `trg_orders_stamp_sold` only on `status, confirmed_by_*`, so neither runs.
  - The setting is local and cleared afterwards.
- **Deadlocks:** none found with altercpa-sync, mex-reconcile, web-sync, agents or `recompute_all_segments`.
  - The cron never waits on their row locks. It only waits on table-level DDL locks and on `sales_people` rows for the foreign-key check.
  - The nightly recompute runs 00:00:00–00:00:25 UTC; the cron ticks at :01.
  - The only theoretical cycle is a login re-link in Settings → Teams (a key update on `sales_people.user_id`) plus its back-stamp. That is negligible and resolves itself.
- **DST or timezone:** no issue. The window is pure timestamptz arithmetic, pg_cron runs in GMT, and the JSON round trip keeps offsets and microseconds.
- **Statement timeout:** no risk. The limit is 120 s and a run takes about 0.2–0.8 s.
- **Leaks through grants:** none. Execute is revoked from PUBLIC, anon and authenticated. Apply refuses the read-only role by `session_user`, even inside a READ WRITE transaction.
- **Silent failure:** errors surface in `cron.job_run_details` and in `integrations_health()`. Successful run details do not (defect 4).

My queries are in `C:\Users\Mile\AppData\Local\Temp\claude\d--Dev-archives-elyon-natura\ba6c6515-0d2a-4518-b77a-a3e01748e84d\scratchpad\stamp\vb\` (`t1`–`t44.sql`, `mkplan.mjs`, `plan*.sql`). The PGlite demo is `C:\Users\Mile\AppData\Local\Temp\claude\d--Dev-archives-elyon-natura\ba6c6515-0d2a-4518-b77a-a3e01748e84d\scratchpad\pgparse\vb_push_demo.mjs`.