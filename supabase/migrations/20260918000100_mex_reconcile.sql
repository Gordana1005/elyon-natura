-- MEX Poshta reconciliation — automatic courier ground truth.
--
-- The 2026-08-11 CSV reconciliation proved AlterCPA statuses are systematically
-- wrong (4.184 "cancelled" orders were delivered; 888 "paid" had returned).
-- list_shipments.php supports updated_from + status_id filters, so the same
-- correction can run on a timer with no portal exports: the mex-reconcile edge
-- function polls terminal shipments (Delivered / Returned to sender), matches
-- them to orders (phone → E.164, COD ×61.5 ±150 достава, nearest date), and
-- applies delivered → paid / returned → returned.
--
-- One-time setup (values in docs/VAULT.md §6, NEVER committed):
--   npx supabase secrets set MEX_API_KEY=<key> MEX_SYNC_SECRET=<64-hex> --project-ref bmfxhgznttcnnlqloqzp
--   SELECT vault.create_secret('<same 64-hex>', 'mex_sync_secret');

-- 1) The permanent order ↔ shipment link. A match is decided once and
-- remembered; later runs look the tracking id up instead of re-guessing.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS mex_tracking_id text;
CREATE INDEX IF NOT EXISTS idx_orders_mex_tracking
  ON public.orders (mex_tracking_id) WHERE mex_tracking_id IS NOT NULL;
COMMENT ON COLUMN public.orders.mex_tracking_id IS
  'MEX Poshta tracking id this order shipped under (latest shipment on re-sends). Written by mex-reconcile and the CSV reconciliation script.';

-- 2) Run log, same shape idea as altercpa_sync_runs but courier-scoped.
CREATE TABLE IF NOT EXISTS public.mex_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'rolling' CHECK (kind IN ('rolling','backfill','manual','dry')),
  window_from date,
  window_to date,
  fetched integer NOT NULL DEFAULT 0,
  matched integer NOT NULL DEFAULT 0,
  paid_applied integer NOT NULL DEFAULT 0,
  returned_applied integer NOT NULL DEFAULT 0,
  skipped jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','failed')),
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer
);
ALTER TABLE public.mex_sync_runs ENABLE ROW LEVEL SECURITY;
-- Same audience as the AlterCPA bridge surfaces: admin/manager only.
DROP POLICY IF EXISTS mex_sync_runs_select ON public.mex_sync_runs;
CREATE POLICY mex_sync_runs_select ON public.mex_sync_runs
  FOR SELECT USING (
    public.has_role(auth.uid(), 'admin'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
  );
-- No INSERT/UPDATE policies: only the service role (edge function) writes.

-- 3) Scheduler. Every 30 minutes inside working hours — couriers deliver during
-- the day, and a delivery confirmed 30 minutes late moves no money incorrectly.
CREATE OR REPLACE FUNCTION public.invoke_mex_reconcile()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _secret text;
BEGIN
  -- 07:00–20:55 Europe/Skopje, DST-proof (pg_cron fires in UTC).
  IF extract(hour from now() AT TIME ZONE 'Europe/Skopje') NOT BETWEEN 7 AND 20 THEN
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
$fn$;

REVOKE ALL ON FUNCTION public.invoke_mex_reconcile() FROM PUBLIC, anon, authenticated;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'mex-reconcile') THEN
    PERFORM cron.unschedule('mex-reconcile');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'mex-reconcile', '7,37 * * * *',
  $job$SELECT public.invoke_mex_reconcile();$job$
);
