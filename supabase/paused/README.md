# Paused migrations — NOT applied, do not apply

Files here are finished-but-paused work. They live outside `supabase/migrations/` on purpose,
so no `db push` or `apply-migration-mk.mjs` run can pick them up by accident.

| File | Why it is paused | Before it may move back to `migrations/` |
|---|---|---|
| `20260939000350_collabbox_sync.sql` | **SUPERSEDED — never apply.** The owner resumed collabBox on 28.09.2026 (~23:30) with different rules; the nightly sync is `supabase/migrations/20260942000900_collabbox_nightly_sync.sql` (its own `collabbox_documents` / `collabbox_customers` / `collabbox_sync_runs`, `invoke_collabbox_sync(text)` and the `collabbox-sync` cron). This file would re-create those names with the old design and rewrite `trg_orders_recompute_segments`. | Never. Kept only as design history (`docs/handoff/2026-09-28/collabbox-pipeline.md` §1–§7). |

The `collabbox-sync` Edge Function is the real sync now (see `docs/handoff/2026-09-28/collabbox-pipeline.md` §8).
