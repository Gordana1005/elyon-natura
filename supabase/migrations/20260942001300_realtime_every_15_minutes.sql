-- Every source at least every 15 minutes (owner, 29.09.2026 ~04:30): "all sources exact to the
-- detail and updated at least every 15 minutes by cron — web, affiliate lead in/out, teleshop in/out,
-- social … MEX stays the final proof; we have the APIs of both NATURA and BIO NATURAL, follow them
-- regularly."
--
-- Before: AlterCPA every 2 min (rolling) / 5 min (status) · web every 15 min · MEX every 30 min
-- (07:00–20:55) · collabBox nightly 00:00 + a headers-only "live" read every 30 min.
-- After:
--   collabBox  'collabbox-sync-frequent' every 15 min, 07:00–22:59 Skopje: a FULL pass of yesterday +
--              today (headers, line items, orders once the MEX parcel exists, seller credit, awaiting
--              rows the leaderboard reads) — the headers-only 'collabbox-live' job is retired (the
--              frequent pass records the same bookings and more). The 00:00 nightly (last 3 days)
--              stays.
--   MEX        'mex-reconcile' every 15 min (:07/:22/:37/:52) for BOTH accounts, 06:00–22:59 Skopje
--              (was every 30 min, 07:00–20:55). The Sunday full sweep stays.
--   web / AlterCPA unchanged (already ≤ 15 min).
-- The cron decisions of 2026-08-12 ("cronjobs stay as they are") are superseded by this instruction.

BEGIN;

-- ── collabBox: the frequent full pass ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.invoke_collabbox_sync(_mode text DEFAULT 'nightly'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _secret text;
  _local  timestamp := now() AT TIME ZONE 'Europe/Skopje';
  _body   jsonb;
BEGIN
  IF _mode = 'nightly' THEN
    IF extract(hour FROM _local) <> 0 THEN
      RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.collabbox_sync_runs r
                WHERE r.kind = 'nightly' AND r.run_day = _local::date) THEN
      RETURN;
    END IF;
    _body := jsonb_build_object('mode', 'nightly', 'trigger', 'cron');
  ELSIF _mode = 'frequent' THEN
    -- 07:00–22:59 Skopje: yesterday + today in full (20260942001300)
    IF _local::time < time '07:00' OR _local::time >= time '23:00' THEN
      RETURN;
    END IF;
    _body := jsonb_build_object('mode', 'manual', 'trigger', 'cron',
                                'from', to_char(_local::date - 1, 'YYYY-MM-DD'),
                                'to',   to_char(_local::date, 'YYYY-MM-DD'));
  ELSIF _mode = 'live' THEN
    IF _local::time < time '08:00' OR _local::time >= time '20:15' THEN
      RETURN;
    END IF;
    _body := jsonb_build_object('mode', 'live', 'trigger', 'cron');
  ELSE
    RETURN;
  END IF;

  SELECT decrypted_secret INTO _secret
    FROM vault.decrypted_secrets
   WHERE name = 'collabbox_sync_secret';
  IF _secret IS NULL THEN
    RETURN;  -- vault not configured yet → no-op
  END IF;

  PERFORM net.http_post(
    url := 'https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/collabbox-sync',
    headers := jsonb_build_object(
      'x-collabbox-sync-secret', _secret,
      'Content-Type', 'application/json'
    ),
    body := _body,
    timeout_milliseconds := 60000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;  -- the scheduler must never error the cron job
END;
$function$;

COMMENT ON FUNCTION public.invoke_collabbox_sync(text) IS
  'pg_cron → collabbox-sync: nightly (00:00 Skopje, last 3 days) · frequent (every 15 min 07:00–22:59 Skopje, yesterday + today in full) · live (headers only — retired from the schedule by 20260942001300, kept callable). No-op until the vault secret collabbox_sync_secret exists. Migrations 20260942000900, 20260942001300.';

DO $sched$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN ('collabbox-live', 'collabbox-sync-frequent');
  -- every 15 minutes, 05:00–21:59 UTC (covers 07:00–22:59 Skopje in summer and winter; the gate trims)
  PERFORM cron.schedule('collabbox-sync-frequent', '*/15 4-21 * * *', $job$SELECT public.invoke_collabbox_sync('frequent');$job$);
END
$sched$;

-- ── MEX: both accounts every 15 minutes, 06:00–22:59 Skopje ──────────────────
CREATE OR REPLACE FUNCTION public.invoke_mex_reconcile()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _secret text;
BEGIN
  -- 06:00–22:59 Europe/Skopje, DST-proof (pg_cron fires in UTC). Was 07:00–20:55 (20260942001300).
  IF extract(hour from now() AT TIME ZONE 'Europe/Skopje') NOT BETWEEN 6 AND 22 THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets
  WHERE name = 'mex_sync_secret';
  IF _secret IS NULL THEN
    RETURN;  -- vault not configured yet → no-op
  END IF;

  -- MACEDONIA. This URL must always be THIS project.
  PERFORM net.http_post(
    url := 'https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/mex-reconcile',
    headers := jsonb_build_object(
      'x-mex-sync-secret', _secret,
      'Content-Type', 'application/json'
    ),
    body := '{"kind":"rolling"}'::jsonb,
    timeout_milliseconds := 60000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;  -- the scheduler must never error the cron job
END;
$function$;

DO $sched2$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'mex-reconcile';
  PERFORM cron.schedule('mex-reconcile', '7,22,37,52 * * * *', $job$SELECT public.invoke_mex_reconcile();$job$);
END
$sched2$;

COMMIT;
