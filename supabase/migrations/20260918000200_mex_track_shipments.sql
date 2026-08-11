-- MEX tracking, full lifecycle (operator decision 2026-08-11): an order that
-- APPEARS at MEX is `shipped` — the parcel exists and is with the courier —
-- and the terminal statuses then settle it as paid or returned. mex-reconcile
-- now pulls every status, not just the terminal two.
ALTER TABLE public.mex_sync_runs
  ADD COLUMN IF NOT EXISTS shipped_applied integer NOT NULL DEFAULT 0;
