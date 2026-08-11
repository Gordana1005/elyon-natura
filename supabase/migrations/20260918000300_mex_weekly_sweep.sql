-- MEX reconciliation — the weekly safety net (operator requirement 2026-08-11:
-- "we must never lose or skip an order").
--
-- The rolling run only sees shipments whose status CHANGED since the cursor. A
-- shipment that failed to match (its order imported late, a phone typo fixed
-- afterwards, an ambiguity that resolved when another order consumed its rival)
-- is retried on its next status change — but one that went terminal while still
-- unmatched would never be retried. This sweep re-reads the last 60 days of
-- shipments once a week, so every miss gets re-attempted with fresh data.
-- Idempotent by construction: matched-and-correct orders are skipped.
CREATE OR REPLACE FUNCTION public.invoke_mex_reconcile_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _secret text;
BEGIN
  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets
  WHERE name = 'mex_sync_secret';
  IF _secret IS NULL THEN
    RETURN;
  END IF;

  -- MACEDONIA. This URL must always be THIS project.
  PERFORM net.http_post(
    url := 'https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/mex-reconcile',
    headers := jsonb_build_object(
      'x-mex-sync-secret', _secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'kind', 'backfill',
      'from', to_char(now() - interval '60 days', 'YYYY-MM-DD')
    ),
    timeout_milliseconds := 60000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;
END;
$fn$;

REVOKE ALL ON FUNCTION public.invoke_mex_reconcile_sweep() FROM PUBLIC, anon, authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mex-reconcile-weekly') THEN
    PERFORM cron.unschedule('mex-reconcile-weekly');
  END IF;
END
$cron$;

-- Sunday 08:15 UTC = 10:15 Skopje in summer, 09:15 in winter — inside working
-- hours either way, and off the busy slots of the other jobs.
SELECT cron.schedule(
  'mex-reconcile-weekly', '15 8 * * 0',
  $job$SELECT public.invoke_mex_reconcile_sweep();$job$
);
