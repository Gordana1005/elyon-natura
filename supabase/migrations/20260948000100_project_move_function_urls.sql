-- 20260948000100_project_move_function_urls.sql
-- Project move (03.10.2026): the cron callers no longer hardcode the project URL.
--
-- Until now 7 SQL functions (the pg_cron → edge-function callers) carried
-- 'https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/…' in their bodies. A restored copy of this database in ANOTHER
-- Supabase project would therefore drive the OLD project's functions from its cron — split-brain by default.
--
-- From here: one reader, public.project_functions_base_url(), returns the vault secret
-- `project_functions_base_url` (the project's OWN host, e.g. https://<ref>.supabase.co; later a custom domain) or
-- NULL. Every caller builds url := _base || '/functions/v1/<fn>' and RETURNS with a WARNING when the base is NULL:
-- fail closed, never a call to another project. The vault row is project-local by design (vault does not travel
-- with a dump) — a copy of this database calls nothing until an operator creates the row on it.
--
-- Guards: (1) refuses to run unless the vault secret exists and is a bare https host on THIS project;
-- (2) refuses if any of the 7 live bodies differs from the md5 recorded when this file was generated
-- (scripts/db-move/gen-move-migration.mjs from exports/db-move/2026-10-03/invoke-functions-old.json).
-- Historical migrations stay untouched (supabase/functions/collabbox-sync/*.test.ts read them by name).
-- Generated — edit the generator, not this file.

SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  _u text;
BEGIN
  SELECT decrypted_secret INTO _u FROM vault.decrypted_secrets WHERE name = 'project_functions_base_url';
  IF _u IS NULL OR rtrim(_u, '/') !~ '^https://[a-z0-9.-]+$' THEN
    RAISE EXCEPTION 'project move: create the vault secret project_functions_base_url (https://<this project>.supabase.co) on THIS project first — this migration re-points every cron caller';
  END IF;
END
$guard$;

DO $drift$
DECLARE
  _expected jsonb := jsonb_build_object(
    'invoke_affiliate_postback_drain', 'b7e780dd4b32d6f6f9d831489f76b00c',
    'invoke_altercpa_sync', '8ee4d4b70ad246d4d74a60e7e7688603',
    'invoke_collabbox_shops', 'a365d6594e5d34ad316131baf57301b4',
    'invoke_collabbox_sync', '40973037fa7a16b5e03826561a275488',
    'invoke_mex_reconcile', '970ea7f6973808c68c6d20eb90128522',
    'invoke_mex_reconcile_sweep', '0522b35443ad7717074ed0e2f97dabd5',
    'invoke_web_sync', '3240993c921b66a7858207a1d31cb850'
  );
  _r record;
BEGIN
  FOR _r IN
    SELECT p.proname, md5(replace(p.prosrc, chr(13), '')) AS live
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('invoke_affiliate_postback_drain', 'invoke_altercpa_sync', 'invoke_collabbox_shops', 'invoke_collabbox_sync', 'invoke_mex_reconcile', 'invoke_mex_reconcile_sweep', 'invoke_web_sync')
  LOOP
    IF _expected ->> _r.proname IS DISTINCT FROM _r.live THEN
      RAISE EXCEPTION 'project move: public.%() changed since this migration was generated (live md5 %, expected %) — regenerate it',
        _r.proname, _r.live, _expected ->> _r.proname;
    END IF;
  END LOOP;
END
$drift$;

-- The one place the URL lives.
CREATE OR REPLACE FUNCTION public.project_functions_base_url()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _u text;
BEGIN
  SELECT decrypted_secret INTO _u FROM vault.decrypted_secrets WHERE name = 'project_functions_base_url';
  _u := rtrim(_u, '/');
  IF _u IS NULL OR _u !~ '^https://[a-z0-9.-]+$' THEN
    RETURN NULL;
  END IF;
  RETURN _u;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.project_functions_base_url() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_functions_base_url() TO service_role;
COMMENT ON FUNCTION public.project_functions_base_url() IS
  'The base URL of THIS project''s edge functions (https://<ref>.supabase.co, from the vault secret project_functions_base_url), or NULL. Every pg_cron caller builds its URL from it — migration 20260948000100.';

-- invoke_affiliate_postback_drain() — body as live on 2026-10-03 (md5 b7e780dd4b32d6f6f9d831489f76b00c), URL from the vault.
CREATE OR REPLACE FUNCTION public.invoke_affiliate_postback_drain()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _base text;
  _secret text;
BEGIN
  -- Cheap gate: no due work → no HTTP call (keeps the every-minute job free).
  IF NOT EXISTS (
    SELECT 1 FROM public.affiliate_postbacks
    WHERE status = 'pending' AND next_attempt_at <= now()
  ) THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets
  WHERE name = 'postback_drain_secret';
  IF _secret IS NULL THEN
    RETURN;  -- vault not configured yet → no-op
  END IF;

  -- MACEDONIA. Upstream (Bulgaria) hardcodes its own project ref here; this URL
  -- must always be THIS project. Pointing it at another deployment makes this
  -- database drain that deployment's postback queue once a minute, silently.
  _base := public.project_functions_base_url();
  IF _base IS NULL THEN
    RAISE WARNING 'invoke_affiliate_postback_drain: vault secret project_functions_base_url missing or invalid — no call made';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := _base || '/functions/v1/api/cpa/postbacks/process',
    headers := jsonb_build_object('x-postback-secret', _secret, 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;  -- the scheduler must never error the cron job
END;
$function$;
COMMENT ON FUNCTION public.invoke_affiliate_postback_drain() IS 'Project move 2026-10-03: the URL comes from public.project_functions_base_url() (vault secret project_functions_base_url) — migration 20260948000100.';

-- invoke_altercpa_sync(_kind text) — body as live on 2026-10-03 (md5 8ee4d4b70ad246d4d74a60e7e7688603), URL from the vault.
CREATE OR REPLACE FUNCTION public.invoke_altercpa_sync(_kind text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _base text;
  _secret text;
BEGIN
  -- Cheap gate: nothing configured → no HTTP at all.
  IF NOT EXISTS (SELECT 1 FROM public.altercpa_accounts WHERE is_active) THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets
  WHERE name = 'altercpa_sync_secret';
  IF _secret IS NULL THEN
    RETURN;  -- vault not configured yet → no-op
  END IF;

  -- MACEDONIA. This URL must always be THIS project. Pointed anywhere else,
  -- this database would drive another deployment's lead intake on a timer.
  _base := public.project_functions_base_url();
  IF _base IS NULL THEN
    RAISE WARNING 'invoke_altercpa_sync: vault secret project_functions_base_url missing or invalid — no call made';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := _base || '/functions/v1/altercpa-sync',
    headers := jsonb_build_object(
      'x-altercpa-sync-secret', _secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('kind', _kind),
    -- Generous: a sweep fans out to a third-party API and may split windows.
    -- pg_net is async, so this bounds the response wait, not the cron slot.
    timeout_milliseconds := 60000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;  -- the scheduler must never error the cron job
END;
$function$;
COMMENT ON FUNCTION public.invoke_altercpa_sync(_kind text) IS 'Project move 2026-10-03: the URL comes from public.project_functions_base_url() (vault secret project_functions_base_url) — migration 20260948000100.';

-- invoke_collabbox_shops(_mode text) — body as live on 2026-10-03 (md5 a365d6594e5d34ad316131baf57301b4), URL from the vault.
CREATE OR REPLACE FUNCTION public.invoke_collabbox_shops(_mode text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _base text;
  _set    jsonb;
  _secret text;
  _local  timestamp := now() AT TIME ZONE 'Europe/Skopje';
BEGIN
  SELECT s.value INTO _set FROM public.app_settings s WHERE s.key = 'shops_reader';
  IF NOT coalesce((_set->>'enabled')::boolean, false) THEN
    RETURN;   -- the reader is off
  END IF;
  IF _mode IN ('sales', 'docs') THEN
    IF _local::time < time '07:00' OR NOT coalesce((_set->>_mode)::boolean, true) THEN RETURN; END IF;
  ELSIF _mode = 'nightly' THEN
    IF extract(hour FROM _local) <> 23 OR NOT coalesce((_set->>'nightly')::boolean, true) THEN RETURN; END IF;
    IF EXISTS (SELECT 1 FROM public.shops_reader_runs r
                WHERE r.mode = 'nightly' AND r.status <> 'failed'
                  AND (r.started_at AT TIME ZONE 'Europe/Skopje')::date = _local::date) THEN
      RETURN;   -- once a day
    END IF;
  ELSIF _mode = 'backfill' THEN
    IF _local::time < time '00:25' OR _local::time > time '05:35' THEN RETURN; END IF;
    IF NOT coalesce((_set->'backfill'->>'enabled')::boolean, false) THEN RETURN; END IF;
  ELSE
    RETURN;
  END IF;

  SELECT decrypted_secret INTO _secret FROM vault.decrypted_secrets WHERE name = 'collabbox_sync_secret';
  IF _secret IS NULL THEN
    RETURN;   -- vault not configured → no-op
  END IF;

  _base := public.project_functions_base_url();
  IF _base IS NULL THEN
    RAISE WARNING 'invoke_collabbox_shops: vault secret project_functions_base_url missing or invalid — no call made';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := _base || '/functions/v1/collabbox-shops',
    headers := jsonb_build_object('x-collabbox-sync-secret', _secret, 'Content-Type', 'application/json'),
    body := jsonb_build_object('mode', _mode, 'trigger', 'cron'),
    timeout_milliseconds := 60000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;   -- the scheduler must never error the cron job
END;
$function$;
COMMENT ON FUNCTION public.invoke_collabbox_shops(_mode text) IS 'pg_cron → collabbox-shops (POST, header x-collabbox-sync-secret from the vault secret collabbox_sync_secret): sales (07:05–23:50 Skopje, :05/:20/:35/:50) · docs (hourly :25, 07–23) · nightly (23:30, once a day) · backfill (00:30–05:30 every 30 min, only with shops_reader.backfill.enabled). No-op while app_settings.shops_reader.enabled is false. Migration 20260946000300. Project move 2026-10-03: the URL comes from public.project_functions_base_url() (vault secret project_functions_base_url) — migration 20260948000100.';

-- invoke_collabbox_sync(_mode text) — body as live on 2026-10-03 (md5 40973037fa7a16b5e03826561a275488), URL from the vault.
CREATE OR REPLACE FUNCTION public.invoke_collabbox_sync(_mode text DEFAULT 'nightly'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _base text;
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
    -- 07:00–22:59 Skopje: yesterday + today in full (20260942001300) + the documents DATED the next
    -- 14 days, which are booked already (one header search + one line-items request; 20260944000500)
    IF _local::time < time '07:00' OR _local::time >= time '23:00' THEN
      RETURN;
    END IF;
    _body := jsonb_build_object('mode', 'manual', 'trigger', 'cron',
                                'from', to_char(_local::date - 1, 'YYYY-MM-DD'),
                                'to',   to_char(_local::date, 'YYYY-MM-DD'),
                                'ahead_days', 14);
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

  _base := public.project_functions_base_url();
  IF _base IS NULL THEN
    RAISE WARNING 'invoke_collabbox_sync: vault secret project_functions_base_url missing or invalid — no call made';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := _base || '/functions/v1/collabbox-sync',
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
COMMENT ON FUNCTION public.invoke_collabbox_sync(_mode text) IS 'pg_cron → collabbox-sync: nightly (00:00 Skopje, last 3 days) · frequent (every 15 min 07:00–22:59 Skopje, yesterday + today in full + the documents dated the next 14 days, ahead_days — 20260944000500) · live (headers only — retired from the schedule by 20260942001300, kept callable). No-op until the vault secret collabbox_sync_secret exists. Migrations 20260942000900, 20260942001300, 20260944000500. Project move 2026-10-03: the URL comes from public.project_functions_base_url() (vault secret project_functions_base_url) — migration 20260948000100.';

-- invoke_mex_reconcile() — body as live on 2026-10-03 (md5 970ea7f6973808c68c6d20eb90128522), URL from the vault.
CREATE OR REPLACE FUNCTION public.invoke_mex_reconcile()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _base text;
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
  _base := public.project_functions_base_url();
  IF _base IS NULL THEN
    RAISE WARNING 'invoke_mex_reconcile: vault secret project_functions_base_url missing or invalid — no call made';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := _base || '/functions/v1/mex-reconcile',
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
COMMENT ON FUNCTION public.invoke_mex_reconcile() IS 'Project move 2026-10-03: the URL comes from public.project_functions_base_url() (vault secret project_functions_base_url) — migration 20260948000100.';

-- invoke_mex_reconcile_sweep() — body as live on 2026-10-03 (md5 0522b35443ad7717074ed0e2f97dabd5), URL from the vault.
CREATE OR REPLACE FUNCTION public.invoke_mex_reconcile_sweep()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _base text;
  _secret text;
BEGIN
  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets
  WHERE name = 'mex_sync_secret';
  IF _secret IS NULL THEN
    RETURN;
  END IF;

  -- MACEDONIA. This URL must always be THIS project.
  _base := public.project_functions_base_url();
  IF _base IS NULL THEN
    RAISE WARNING 'invoke_mex_reconcile_sweep: vault secret project_functions_base_url missing or invalid — no call made';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := _base || '/functions/v1/mex-reconcile',
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
$function$;
COMMENT ON FUNCTION public.invoke_mex_reconcile_sweep() IS 'Project move 2026-10-03: the URL comes from public.project_functions_base_url() (vault secret project_functions_base_url) — migration 20260948000100.';

-- invoke_web_sync(_body jsonb) — body as live on 2026-10-03 (md5 3240993c921b66a7858207a1d31cb850), URL from the vault.
CREATE OR REPLACE FUNCTION public.invoke_web_sync(_body jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _base text;
  _secret text;
BEGIN
  SELECT decrypted_secret INTO _secret
  FROM vault.decrypted_secrets
  WHERE name = 'web_sync_secret';
  IF _secret IS NULL THEN
    RETURN;  -- vault not configured yet → no-op
  END IF;

  -- MACEDONIA. This URL must always be THIS project.
  _base := public.project_functions_base_url();
  IF _base IS NULL THEN
    RAISE WARNING 'invoke_web_sync: vault secret project_functions_base_url missing or invalid — no call made';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := _base || '/functions/v1/web-sync',
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
$function$;
COMMENT ON FUNCTION public.invoke_web_sync(_body jsonb) IS 'Project move 2026-10-03: the URL comes from public.project_functions_base_url() (vault secret project_functions_base_url) — migration 20260948000100.';

-- Proof: no caller names the old host any more.
DO $check$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosrc LIKE '%bmfxhgznttcnnlqloqzp.supabase.co%';
  IF _n > 0 THEN
    RAISE EXCEPTION 'project move: % function(s) still name the old host', _n;
  END IF;
END
$check$;
