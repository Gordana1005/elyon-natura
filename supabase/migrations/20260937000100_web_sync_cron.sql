-- ============================================================================
-- WEB SYNC — the schedulers (naturatherapy.mk mirror, 2026-09-28)
--
-- Apply LAST: after 20260937000000_web_orders.sql, after the web-sync
-- function is deployed, its secrets are set and the first backfill finished.
-- Until the vault row below exists every job is a silent no-op.
--
-- Same pg_cron + pg_net + Vault pattern as invoke_mex_reconcile /
-- invoke_altercpa_sync: the shared secret lives in Vault, never in SQL.
--
-- One-time setup (values in docs/VAULT.md §8, NEVER committed) — done by
--   node scripts/apply-shop-crm-export.mjs --set-function-secrets
-- which is equivalent to:
--   npx supabase secrets set WEB_SHOP_DB_URL=… WEB_SYNC_SECRET=… --project-ref bmfxhgznttcnnlqloqzp
--   SELECT vault.create_secret('<WEB_SYNC_SECRET>', 'web_sync_secret');
--
-- Jobs (pg_cron runs in UTC):
--   web-sync          every 15 min, round the clock (the shop sells 24/7):
--                     incremental by the shop's updatedAt, 10 min overlap.
--   web-sync-nightly  six slots in the 01:xx UTC hour (02:xx–03:xx Skopje):
--                     continues/finishes ONE full backfill per night — that
--                     is what catches orders the shop deleted and edits made
--                     by raw SQL (which do not move updatedAt). A slot that
--                     finds tonight's sweep already done returns at once.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.invoke_web_sync(_body jsonb DEFAULT '{}'::jsonb)
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
  WHERE name = 'web_sync_secret';
  IF _secret IS NULL THEN
    RETURN;  -- vault not configured yet → no-op
  END IF;

  -- MACEDONIA. This URL must always be THIS project.
  PERFORM net.http_post(
    url := 'https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/web-sync',
    headers := jsonb_build_object(
      'x-web-sync-secret', _secret,
      'Content-Type', 'application/json'
    ),
    body := coalesce(_body, '{}'::jsonb),
    -- A backfill slot may run for a couple of minutes; pg_net is async, so
    -- this bounds the response wait, not the cron slot.
    timeout_milliseconds := 300000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;  -- the scheduler must never error the cron job
END;
$fn$;

REVOKE ALL ON FUNCTION public.invoke_web_sync(jsonb) FROM PUBLIC, anon, authenticated;

DO $cron$
DECLARE
  _job text;
BEGIN
  FOREACH _job IN ARRAY ARRAY['web-sync', 'web-sync-nightly'] LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = _job) THEN
      PERFORM cron.unschedule(_job);
    END IF;
  END LOOP;
END
$cron$;

-- Off the minutes other jobs already use (:00, :05, :07, :37, even minutes are
-- shared with the 2-minute jobs either way).
SELECT cron.schedule(
  'web-sync', '3,18,33,48 * * * *',
  $job$SELECT public.invoke_web_sync('{}'::jsonb);$job$
);

SELECT cron.schedule(
  'web-sync-nightly', '1,11,21,31,41,51 1 * * *',
  $job$SELECT public.invoke_web_sync('{"backfill": true, "nightly": true}'::jsonb);$job$
);
