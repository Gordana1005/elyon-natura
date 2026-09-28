# Paused migrations — NOT applied, do not apply

Files here are finished-but-paused work. They live outside `supabase/migrations/` on purpose,
so no `db push` or `apply-migration-mk.mjs` run can pick them up by accident.

| File | Why it is paused | Before it may move back to `migrations/` |
|---|---|---|
| `20260939000350_collabbox_sync.sql` | The collabBox daily sync was **paused by the owner (28.09.2026)**. It adds the collabBox ledger tables, crons, `orders.not_counted_reason`, and **rewrites the segment trigger `trg_orders_recompute_segments`** (bulk-mode queue). Never applied on MK. | The owner resumes collabBox. Then: give it a fresh migration timestamp (later than every applied file), re-read `docs/handoff/2026-09-28/collabbox-*.md`, and add `AND o.not_counted_reason IS NULL` to `order_decider_plan()` / the stamp fill (stamp review defect 5). |

The deployed `collabbox-sync` Edge Function is only a **probe** (one GET to the collabBox login page); it
needs none of this.
