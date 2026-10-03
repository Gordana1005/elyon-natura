-- 20260947001810 — the forward pass of the sale-day rule (owner, 03.10.2026 "ДА"; 20260947001800)
--
-- Applied AFTER the one-time backfill run (sale_day_revive_apply(false, 'backfill')), so the first
-- tick finds only what was revived since. Every 15 minutes at :07 / :22 / :37 / :52 — never on the
-- nightly segment recompute (00:00 / 00:30 UTC, ~1 minute each) — the same plan re-times an order
-- that mex-reconcile (rule C, the 9110 upsell revive), link-lead-parcels, leads-parcel-orders, the
-- stamping cron or the collabBox writer revived or credited while it was dead. Idempotent: a moved
-- order is on its booking day and no longer in the plan. The switch app_settings.sale_day_revive
-- ('apply' | 'report' | 'off') stops it; every applied tick is a run in sale_day_revive_runs with
-- its moves in sale_day_revive_moves; sale_day_revive_undo(run [, actor, basis]) undoes one, and an
-- undone order is never moved again by the cron (the plan skips it).
DO $cron$
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'sale-day-revive';
  PERFORM cron.schedule('sale-day-revive', '7-59/15 * * * *',
                        $$SELECT public.sale_day_revive_apply(false, 'cron', '2026-01-01 00:00:00+01', 500, 'cron');$$);
END
$cron$;
