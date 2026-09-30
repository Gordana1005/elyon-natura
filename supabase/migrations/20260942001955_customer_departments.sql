-- ============================================================================
-- THE BUYER'S DEPARTMENT — a cache for the Assigner (30.09.2026)
--
-- Owner decision 29.09 (plan "Assigner redesign", Part A2): the prediction lists
-- are split by the department of the customer's LAST PURCHASE. The lists stay
-- exactly as the engine builds them; the Assigner's department chips filter
-- them (assigner_lists / assigner_distribute, 20260942001957 / …1960).
--
-- WHAT A ROW SAYS
--   customer_phone  the EXACT orders.customer_phone (the segment engine keys
--                   members the same way — no last-8 folding here)
--   department      public.cohort_order_source(sale_source, sale_source_detail,
--                   mex_tracking_id, dept_override) — the 4-argument form every
--                   report uses (20260942001860) — of the customer's LATEST SALE:
--                   status confirmed / shipped / delivered / paid / returned
--                   (packing is a substate of confirmed, not a status), latest by
--                   coalesce(sold_at, confirmed_at, created_at).
--                   No sale at all → the latest order of any status (same key).
--                   No order → no row; the Assigner reads a missing row as
--                   'unknown'.
--   order_id        the order that decided it
--   sale_at         that sale's time; NULL when the department comes from a
--                   non-sale order (the "no sale yet" fallback)
--   refreshed_at    when the row last CHANGED (unchanged rows are not rewritten)
--
-- WEB. Web-shop purchases live in web_orders, not in orders (CLAUDE.md: "the
-- web_orders mirror … NOT orders"), and the engine builds the lists from orders
-- only — so 'web' appears here only for an order row whose department is web.
--
-- HOW IT STAYS FRESH (no trigger on the hot orders table)
--   refresh_customer_departments(false)  every 10 minutes (pg_cron
--       'customer-departments-refresh', at :03/:13/…): recomputes every phone
--       with an order whose updated_at > (last watermark − 10 minutes). The
--       10-minute overlap catches writers whose transaction started before the
--       previous run. ~0,1 s: one pass over orders.updated_at (no index on
--       purpose — an updated_at index would end HOT updates on orders).
--       Before the first full fill the watermark is NULL and this is a no-op.
--   refresh_customer_departments(true)   nightly at 01:10 Skopje (pg_cron
--       'customer-departments-nightly' fires 23:10 and 00:10 UTC; the wrapper
--       runs only in the Skopje hour 1 — DST-proof like invoke_collabbox_sync).
--       Rebuilds every phone and deletes rows whose phone has no order left.
--       It also catches what updated_at cannot show: writes made under
--       elyon.keep_updated_at = 'on' (e.g. stamp_order_deciders' sold_at),
--       deleted orders and a changed customer_phone.
--   One run at a time (advisory lock); a second caller returns 0.
--   It reads orders and writes only this table — no order, no member moves.
--
-- Access: service role only (RLS on, no policies). Read by the SECURITY DEFINER
-- functions of the Assigner.
--
-- The INITIAL FILL is the last statement of this file, after COMMIT.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.customer_departments (
  customer_phone text        PRIMARY KEY,
  department     text        NOT NULL,
  order_id       uuid,
  sale_at        timestamptz,
  refreshed_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.customer_departments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_departments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_departments TO service_role;

COMMENT ON TABLE public.customer_departments IS
  'The buyer''s department for the Assigner (20260942001955): per EXACT orders.customer_phone, cohort_order_source(4-arg) of the latest sale (confirmed/shipped/delivered/paid/returned, by coalesce(sold_at, confirmed_at, created_at)), else of the latest order; no row = unknown. sale_at NULL = no sale yet. Refreshed by refresh_customer_departments() — every 10 min incremental, nightly 01:10 Skopje full. Service role only.';

-- the watermark and the last run, one row
CREATE TABLE IF NOT EXISTS public.customer_departments_state (
  id           boolean     PRIMARY KEY DEFAULT true CHECK (id),
  watermark    timestamptz,
  last_run_at  timestamptz,
  last_full_at timestamptz,
  last_mode    text,
  last_phones  integer,
  last_rows    integer,
  last_deleted integer,
  last_ms      integer
);
INSERT INTO public.customer_departments_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.customer_departments_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_departments_state FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_departments_state TO service_role;

COMMENT ON TABLE public.customer_departments_state IS
  'refresh_customer_departments() bookkeeping (20260942001955): the orders.updated_at watermark of the last run (NULL = the full fill never ran — the incremental run is then a no-op) and what the last run did.';

-- The six department keys, and 'unknown' for anything else (no row, or a value
-- a later migration might add before the Assigner knows it). Inlinable.
CREATE OR REPLACE FUNCTION public.assigner_dept_key(p_department text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN p_department IN ('altercpa', 'elyon_crm', 'teleshop_out',
                                    'teleshop_other', 'social', 'web')
              THEN p_department ELSE 'unknown' END
$$;
COMMENT ON FUNCTION public.assigner_dept_key(text) IS
  'The Assigner''s department key: one of the six departments, else ''unknown'' (20260942001955).';

CREATE OR REPLACE FUNCTION public.refresh_customer_departments(p_full boolean DEFAULT false)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
AS $fn$
DECLARE
  v_mark    timestamptz := now();          -- this transaction's start: the next watermark
  v_t0      timestamptz := clock_timestamp();
  v_since   timestamptz;
  v_phones  integer := 0;
  v_rows    integer := 0;
  v_deleted integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('public.refresh_customer_departments', 0)) THEN
    RAISE NOTICE 'refresh_customer_departments: another run holds the lock — skipped';
    RETURN 0;
  END IF;

  SELECT s.watermark INTO v_since FROM public.customer_departments_state s WHERE s.id;

  IF NOT p_full AND v_since IS NULL THEN
    RAISE NOTICE 'refresh_customer_departments: no full fill yet — run refresh_customer_departments(true) first';
    RETURN 0;
  END IF;

  IF p_full THEN
    WITH pick AS (
      SELECT DISTINCT ON (o.customer_phone)
             o.customer_phone, o.id,
             (o.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')) AS is_sale,
             coalesce(o.sold_at, o.confirmed_at, o.created_at) AS at,
             o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override
      FROM public.orders o
      WHERE o.customer_phone IS NOT NULL AND o.customer_phone <> ''
      ORDER BY o.customer_phone,
               (o.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')) DESC,
               coalesce(o.sold_at, o.confirmed_at, o.created_at) DESC,
               o.created_at DESC, o.id DESC
    ),
    up AS (
      INSERT INTO public.customer_departments AS cd
             (customer_phone, department, order_id, sale_at, refreshed_at)
      SELECT p.customer_phone,
             public.cohort_order_source(p.sale_source, p.sale_source_detail, p.mex_tracking_id, p.dept_override),
             p.id,
             CASE WHEN p.is_sale THEN p.at END,
             v_mark
      FROM pick p
      ON CONFLICT (customer_phone) DO UPDATE
         SET department   = EXCLUDED.department,
             order_id     = EXCLUDED.order_id,
             sale_at      = EXCLUDED.sale_at,
             refreshed_at = EXCLUDED.refreshed_at
       WHERE (cd.department, cd.order_id, cd.sale_at)
             IS DISTINCT FROM (EXCLUDED.department, EXCLUDED.order_id, EXCLUDED.sale_at)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM pick), (SELECT count(*) FROM up) INTO v_phones, v_rows;

    DELETE FROM public.customer_departments cd
     WHERE NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.customer_phone = cd.customer_phone);
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  ELSE
    WITH ph AS (
      SELECT DISTINCT o.customer_phone
      FROM public.orders o
      WHERE o.updated_at > v_since - interval '10 minutes'
        AND o.customer_phone IS NOT NULL AND o.customer_phone <> ''
    ),
    pick AS (
      SELECT DISTINCT ON (o.customer_phone)
             o.customer_phone, o.id,
             (o.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')) AS is_sale,
             coalesce(o.sold_at, o.confirmed_at, o.created_at) AS at,
             o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override
      FROM public.orders o
      JOIN ph ON ph.customer_phone = o.customer_phone
      ORDER BY o.customer_phone,
               (o.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')) DESC,
               coalesce(o.sold_at, o.confirmed_at, o.created_at) DESC,
               o.created_at DESC, o.id DESC
    ),
    up AS (
      INSERT INTO public.customer_departments AS cd
             (customer_phone, department, order_id, sale_at, refreshed_at)
      SELECT p.customer_phone,
             public.cohort_order_source(p.sale_source, p.sale_source_detail, p.mex_tracking_id, p.dept_override),
             p.id,
             CASE WHEN p.is_sale THEN p.at END,
             v_mark
      FROM pick p
      ON CONFLICT (customer_phone) DO UPDATE
         SET department   = EXCLUDED.department,
             order_id     = EXCLUDED.order_id,
             sale_at      = EXCLUDED.sale_at,
             refreshed_at = EXCLUDED.refreshed_at
       WHERE (cd.department, cd.order_id, cd.sale_at)
             IS DISTINCT FROM (EXCLUDED.department, EXCLUDED.order_id, EXCLUDED.sale_at)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ph), (SELECT count(*) FROM up) INTO v_phones, v_rows;
  END IF;

  UPDATE public.customer_departments_state s
     SET watermark    = v_mark,
         last_run_at  = clock_timestamp(),
         last_full_at = CASE WHEN p_full THEN clock_timestamp() ELSE s.last_full_at END,
         last_mode    = CASE WHEN p_full THEN 'full' ELSE 'incremental' END,
         last_phones  = v_phones,
         last_rows    = v_rows,
         last_deleted = v_deleted,
         last_ms      = (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::int
   WHERE s.id;

  RETURN v_rows;
END;
$fn$;

COMMENT ON FUNCTION public.refresh_customer_departments(boolean) IS
  'Refreshes public.customer_departments (20260942001955). p_full = false: the phones with an order updated since the last watermark − 10 min (a no-op until the first full fill); p_full = true: every phone, and rows whose phone has no order left are deleted. Returns the rows inserted or changed. One run at a time (a second caller returns 0). Reads orders, writes only customer_departments(_state).';

-- The nightly full rebuild: 01:10 Skopje whatever the season (cron fires at
-- 23:10 and 00:10 UTC; only the run that lands in the Skopje hour 1 works).
CREATE OR REPLACE FUNCTION public.refresh_customer_departments_nightly()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF extract(hour FROM now() AT TIME ZONE 'Europe/Skopje') <> 1 THEN
    RETURN NULL;
  END IF;
  RETURN public.refresh_customer_departments(true);
END;
$fn$;

COMMENT ON FUNCTION public.refresh_customer_departments_nightly() IS
  'pg_cron wrapper (20260942001955): the full refresh_customer_departments(true) at 01:10 Europe/Skopje — returns NULL outside the Skopje hour 1.';

REVOKE ALL ON FUNCTION public.refresh_customer_departments(boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_customer_departments_nightly() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_customer_departments(boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_customer_departments_nightly() TO service_role;

DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job
   WHERE jobname IN ('customer-departments-refresh', 'customer-departments-nightly');
END
$cron$;

SELECT cron.schedule(
  'customer-departments-refresh',
  '3-59/10 * * * *',
  $job$SELECT public.refresh_customer_departments(false);$job$
);

SELECT cron.schedule(
  'customer-departments-nightly',
  '10 23,0 * * *',
  $job$SELECT public.refresh_customer_departments_nightly();$job$
);

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- INITIAL FILL — the one full rebuild, run as the LAST statement when this file
-- is applied. It reads orders and inserts ~112.600 rows into the NEW table
-- above; it updates no order and no list member. Measured in a rolled-back
-- transaction on 30.09.2026: see the report / scripts/verify-assigner.mjs.
-- To defer it (e.g. to the quiet window after 20:55 Skopje), delete this
-- statement before applying: the nightly 01:10 job would then do the first fill,
-- and until it runs every buyer reads as 'unknown' in the Assigner.
-- ============================================================================
SELECT public.refresh_customer_departments(true) AS customer_departments_initial_fill;
