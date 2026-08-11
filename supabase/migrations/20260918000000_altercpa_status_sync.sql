-- AlterCPA bridge — the status-sync scheduler (kind 'status').
--
-- The windowed kinds filter on CREATION time (proven by
-- scripts/probe-altercpa-window.mjs, 2026-08-06), so they can never observe a
-- phase change on a lead created outside their window. The 'status' kind in the
-- altercpa-sync edge function inverts the question: it takes OUR still-open
-- mirrored orders and re-reads exactly those ids via comp/list.json?oid=…,
-- resolving them forward-only (B′ map: paid only on their Completed).
--
-- The user requirement is "every 5 minutes, 07:00–21:00 Skopje". pg_cron fires
-- in UTC and Europe/Skopje flips CET/CEST, so the local-hours gate lives INSIDE
-- the wrapper, not in the cron expression — the job fires around the clock and
-- returns without HTTP outside the window.

-- 1) 'status' joins the run-log kind vocabulary.
ALTER TABLE public.altercpa_sync_runs
  DROP CONSTRAINT IF EXISTS altercpa_sync_runs_kind_check;
ALTER TABLE public.altercpa_sync_runs
  ADD CONSTRAINT altercpa_sync_runs_kind_check
  CHECK (kind IN ('rolling','nightly','weekly','backfill','manual','dry','status'));

-- 2) Scheduler wrapper. Delegates to invoke_altercpa_sync('status'), which
-- already holds the Vault read, the hardcoded MACEDONIA project URL and the
-- fail-silent contract.
CREATE OR REPLACE FUNCTION public.invoke_altercpa_status_sync()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- BETWEEN 7 AND 20 → fires 07:00–20:55 local time, so the day's last
  -- resolution lands before 21:00 (BETWEEN 7 AND 21 would run until 21:55).
  IF extract(hour from now() AT TIME ZONE 'Europe/Skopje') NOT BETWEEN 7 AND 20 THEN
    RETURN;
  END IF;

  -- Cheaper pre-gate than the generic one: the status kind is defined to be a
  -- no-op unless some account actually mirrors statuses, so don't even wake
  -- the edge function while the feature is switched off.
  IF NOT EXISTS (
    SELECT 1 FROM public.altercpa_accounts
    WHERE is_active AND status_mirror <> 'off'
  ) THEN
    RETURN;
  END IF;

  PERFORM public.invoke_altercpa_sync('status');
EXCEPTION WHEN OTHERS THEN
  RETURN;  -- the scheduler must never error the cron job
END;
$fn$;

REVOKE ALL ON FUNCTION public.invoke_altercpa_status_sync() FROM PUBLIC, anon, authenticated;

-- Idempotent: replace any previous schedule with this name.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'altercpa-sync-status') THEN
    PERFORM cron.unschedule('altercpa-sync-status');
  END IF;
END
$cron$;

-- */5: the user asked for 5-10 minutes; */1 is the postback drain's slot and
-- */2 the rolling import's. Sharing a minute with them is benign — pg_net posts
-- are async and the two edge-function runs only race on ledger rows, where both
-- writers are idempotent.
SELECT cron.schedule(
  'altercpa-sync-status', '*/5 * * * *',
  $job$SELECT public.invoke_altercpa_status_sync();$job$
);
