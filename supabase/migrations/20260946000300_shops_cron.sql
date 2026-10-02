-- ============================================================================
-- Shops (Продавници) 3/3 — the switch and the schedule of the collabBox shops reader
-- ============================================================================
-- app_settings.shops_reader (an OWNER key — tg_app_settings_guard_owner_keys is re-emitted from the LIVE
-- body with 'shops_reader' added; drift-guarded):
--   {"enabled": false,                 ← the lead / owner switches the reader on after review
--    "sales": true, "docs": true, "nightly": true,
--    "snapshot_keep_days": 62,
--    "backfill": {"enabled": false, "sales_from": "2026-01-01", "docs_from": "2026-01-01", "lnp_from": "2025-01",
--                 "max_requests": 60, "sales_days_per_run": 25, "lnp_per_run": 4}}
--
-- invoke_collabbox_shops(mode) → POST /functions/v1/collabbox-shops (header x-collabbox-sync-secret = the vault
-- secret collabbox_sync_secret — the SAME secret collabbox-sync uses; no new secret). A silent no-op while the
-- switch is off, outside its Skopje window, or before the vault secret exists.
--
-- SCHEDULE (pg_cron is UTC; the gates are Skopje — DST-proof; off the collabbox-sync minutes :00/:15/:30/:45):
--   collabbox-shops-sales     '5,20,35,50 4-22 * * *'   07:05 … 23:50 Skopje: today's receipts + returns (1 lines request)
--   collabbox-shops-docs      '25 4-22 * * *'           07:25 … 23:25 Skopje hourly: goods documents of the last 2 days
--   collabbox-shops-nightly   '30 21,22 * * *'          23:30 Skopje once a day: stock of every shop (infollc), the day's
--                                                       receipts once more, the trade book + 10018 controls, prune
--   collabbox-shops-backfill  '0,30 22,23,0-4 * * *'    00:30 … 05:30 Skopje every 30 min while backfill.enabled:
--                                                       yesterday closed, then history in chunks (resumable)
-- The reader keeps one run at a time (shops_reader_runs, 409) and skips while a collabbox-sync run is running.
--
-- Request budget (collabBox requests per run): sales ≤ 6 (login 2 + form 1 + lines 1, a re-login 2) · docs ≤ 8 ·
-- nightly ≤ 40 (login 2 + 3 forms + 1 lines + 22 infollc + 2 trade book + 1 searchdoc) · backfill ≤ backfill.max_requests.
-- Daily ≈ 4 × 68 sales + 5 × 17 docs + 31 nightly ≈ 390 requests, ≥ 1,5 s apart, never in parallel.
--
-- Rollback: SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'collabbox-shops-%';
--           (the setting may stay; the guard keeps 'shops_reader' harmlessly)
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $dep$
BEGIN
  IF to_regclass('public.shops_reader_runs') IS NULL THEN
    RAISE EXCEPTION '20260946000300: apply 20260946000100 / 0200 (shops) first';
  END IF;
  IF to_regprocedure('public.tg_app_settings_guard_owner_keys()') IS NULL THEN
    RAISE EXCEPTION '20260946000300: tg_app_settings_guard_owner_keys() missing';
  END IF;
END
$dep$;

-- ── 0. drift guard: the owner-keys guard is re-emitted below ────────────────
DO $drift$
DECLARE v_md5 text;
BEGIN
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.tg_app_settings_guard_owner_keys()');
  IF v_md5 IS NULL OR v_md5 NOT IN (
       'b0fa4b0bafa78151cdac7a72df5420b9',   -- 20260945000100 Stock v2 (… leads_parcel_orders, stock_v2) — live 02.10.2026
       '6f463680dc3a60f264e7e702bb1e748c',   -- 20260944000970 (… leads_parcel_orders) — live before Stock v2
       '20972a5a1ac9b1d0d60c515b95bbbe28')                       -- this migration (re-run)
  THEN
    RAISE EXCEPTION 'shops: tg_app_settings_guard_owner_keys changed since this migration was written (md5 %) — re-emit it from the live body', v_md5;
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at', 'mex_push', 'link_lead_parcels', 'leads_parcel_orders', 'stock_v2', 'shops_reader'];
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (CASE WHEN TG_OP = 'DELETE' THEN OLD.key ELSE NEW.key END = ANY (_guarded)
          OR (TG_OP = 'UPDATE' AND OLD.key = ANY (_guarded))) THEN
    RAISE EXCEPTION 'app_settings.% is changed only through its owners'' switch in the app',
                    CASE WHEN TG_OP = 'INSERT' THEN NEW.key ELSE OLD.key END
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

-- ── 1. the switch (off) ─────────────────────────────────────────────────────
INSERT INTO public.app_settings (key, value)
VALUES ('shops_reader', jsonb_build_object(
  'enabled', false, 'sales', true, 'docs', true, 'nightly', true, 'snapshot_keep_days', 62,
  'backfill', jsonb_build_object('enabled', false, 'sales_from', '2026-01-01', 'docs_from', '2026-01-01', 'lnp_from', '2025-01',
                                 'max_requests', 60, 'sales_days_per_run', 25, 'lnp_per_run', 4)))
ON CONFLICT (key) DO NOTHING;

-- ── 2. the invoker ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.invoke_collabbox_shops(_mode text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
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

  PERFORM net.http_post(
    url := 'https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/collabbox-shops',
    headers := jsonb_build_object('x-collabbox-sync-secret', _secret, 'Content-Type', 'application/json'),
    body := jsonb_build_object('mode', _mode, 'trigger', 'cron'),
    timeout_milliseconds := 60000
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;   -- the scheduler must never error the cron job
END;
$fn$;

REVOKE ALL ON FUNCTION public.invoke_collabbox_shops(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_collabbox_shops(text) TO service_role;

COMMENT ON FUNCTION public.invoke_collabbox_shops(text) IS
  'pg_cron → collabbox-shops (POST, header x-collabbox-sync-secret from the vault secret collabbox_sync_secret): sales (07:05–23:50 Skopje, :05/:20/:35/:50) · docs (hourly :25, 07–23) · nightly (23:30, once a day) · backfill (00:30–05:30 every 30 min, only with shops_reader.backfill.enabled). No-op while app_settings.shops_reader.enabled is false. Migration 20260946000300.';

-- ── 3. the schedule ─────────────────────────────────────────────────────────
DO $sched$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'collabbox-shops-%';
  PERFORM cron.schedule('collabbox-shops-sales',    '5,20,35,50 4-22 * * *', $job$SELECT public.invoke_collabbox_shops('sales');$job$);
  PERFORM cron.schedule('collabbox-shops-docs',     '25 4-22 * * *',         $job$SELECT public.invoke_collabbox_shops('docs');$job$);
  PERFORM cron.schedule('collabbox-shops-nightly',  '30 21,22 * * *',        $job$SELECT public.invoke_collabbox_shops('nightly');$job$);
  PERFORM cron.schedule('collabbox-shops-backfill', '0,30 22,23,0-4 * * *',  $job$SELECT public.invoke_collabbox_shops('backfill');$job$);
END
$sched$;

COMMIT;

NOTIFY pgrst, 'reload schema';
