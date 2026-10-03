-- ============================================================================
-- The collabBox entry rule goes LIVE: mode apply, 5 days, every sale (owner, Mile, 03.10.2026 — "ГО")
-- ============================================================================
-- Owner: "… ако порачката ја нема во collab 5 дена, тогаш одиме cancel со причина, нема внесено порачка во Collab.
--   Барем се додека не почнат од кај нас да испраќаат со пошта."
-- Nothing is cancelled by this migration. The first real run is the cron collab-entry-rule at 21:20 Skopje on
-- 03.10.2026 (19:20 UTC; the job runs hourly at :20 UTC and acts only in the Skopje hour 21, so CEST → CET on 25.10
-- needs no change), after the no-parcel rule (21:10).
-- Dry run 03.10 ~03:00 (read-only, exports/collab5/dryrun_2026-10-03.csv): 228 sales in scope — cancel 162
-- (126 with a bell, 36 silent: sale day > 14 days old) ≈ 359.684 ден, warn 35 (sales of 29.09), in_collab 29,
-- postponed 2. ~23 of the cancels are AlterCPA approvals of 23.09 that the 10-day no-parcel rule takes at 21:10 first.
-- The apply branch was exercised in a transaction that was rolled back (132 cancels from 17.09, history + note + bell
-- each, updated_at kept, the undo restored all 132) — nothing persisted.
-- from_date stays 2026-08-01 (the dry run shows nothing absurd: 9 August sales, 60.832 ден, all silent).
-- Undo a run: SELECT public.collab_entry_rule_undo('<run id>');  Back to the ledger only: mode 'report'.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $drift$
BEGIN
  IF to_regprocedure('public.sale_collab_evidence(uuid,integer)') IS NULL
     OR to_regprocedure('public.collab_entry_rule_plan(integer)') IS NULL THEN
    RAISE EXCEPTION 'collab entry rule apply: 20260947001900 is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'collab_entry_rule' AND (value->>'days')::int = 5) THEN
    RAISE EXCEPTION 'collab entry rule apply: app_settings.collab_entry_rule.days is not 5';
  END IF;
END
$drift$;

UPDATE public.app_settings
   SET value = value || jsonb_build_object('mode', 'apply', 'days', 5, 'hour', 21, 'warn', true,
                                           'from_date', '2026-08-01', 'scope', 'all'),
       updated_at = now()
 WHERE key = 'collab_entry_rule';

DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'collab-entry-rule' AND j.schedule = '20 * * * *'
                   AND j.command = 'SELECT public.apply_collab_entry_rule();' AND j.active) THEN
    PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'collab-entry-rule';
    PERFORM cron.schedule('collab-entry-rule', '20 * * * *', 'SELECT public.apply_collab_entry_rule();');
  END IF;
END
$cron$;

COMMIT;
