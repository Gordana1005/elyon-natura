-- ============================================================================
-- CALL-AGAINS FOR THE ASSIGNER — one sorted, filtered, counted page; the expiry
-- on a schedule (30.09.2026, plan "Assigner redesign", Part A5)
--
-- GET /api/call-agains (the Assigner's Call-agains tab) pulled up to 2000 lead
-- orders and 2000 member callbacks through PostgREST, merged and paged them in
-- the edge function: the total was the TRUNCATED count, the merge put a missing
-- call_again_since first while the queries put it last, there was no newest /
-- oldest choice and no department filter, and every GET first ran
-- expire_call_again_window() — a WRITE on every read.
--
-- assigner_call_agains(p_agent, p_source, p_departments, p_order, p_limit,
--                      p_offset) → jsonb {total, total_orders, total_members, items}
--   the pool      lead orders in 'call_again' (is_lead_source) + prediction
--                 members with call_again_since set and NOT is_completed — the
--                 same pool as the board totals and assigner_distribute('call_agains')
--   p_agent       NULL / 'all' = everyone · 'unassigned' · a user id
--   p_source      'all' | 'order' | 'prediction'
--   p_departments the order's own department for an order, the buyer's
--                 (customer_departments; no row = 'unknown') for a member
--   p_order       'oldest' (default) | 'newest' by call_again_since; a missing
--                 time sorts last either way
--   total         true counts (no truncation); items = the page, each with
--                 `department` and the old GET /call-agains fields (the api adds
--                 the real last call of an order from bulk_last_calls())
--
-- pg_cron 'call-again-expiry' runs expire_call_again_window() every 5 minutes,
-- outside 00:00–00:59 UTC (the nightly segment recompute) — the api no longer
-- calls it from GET /call-agains. (GET /call-again-queue still calls it; with
-- this job in place that call can go too.)
-- Access: service role only.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.assigner_call_agains(
  p_agent       text    DEFAULT NULL,
  p_source      text    DEFAULT 'all',
  p_departments text[]  DEFAULT NULL,
  p_order       text    DEFAULT 'oldest',
  p_limit       integer DEFAULT 50,
  p_offset      integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c_keys   CONSTANT text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other',
                                    'social', 'web', 'unknown'];
  v_agent  text    := lower(btrim(coalesce(p_agent, 'all')));
  v_aid    uuid;
  v_source text    := lower(btrim(coalesce(p_source, 'all')));
  v_order  text    := lower(btrim(coalesce(p_order, 'oldest')));
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_sel    text[];
  v_bad    text;
  v_out    jsonb;
BEGIN
  IF v_source NOT IN ('all', 'order', 'prediction') THEN
    RAISE EXCEPTION 'invalid source: %', p_source USING ERRCODE = '22023';
  END IF;
  IF v_order NOT IN ('oldest', 'newest') THEN
    RAISE EXCEPTION 'invalid order: %', p_order USING ERRCODE = '22023';
  END IF;
  IF v_agent NOT IN ('all', 'unassigned') THEN
    IF v_agent !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid agent: %', p_agent USING ERRCODE = '22023';
    END IF;
    v_aid := v_agent::uuid;
  END IF;
  IF p_departments IS NOT NULL AND cardinality(p_departments) > 0 THEN
    SELECT x INTO v_bad FROM unnest(p_departments) x WHERE x IS NULL OR NOT (x = ANY (c_keys)) LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'invalid department: %', coalesce(v_bad, 'null') USING ERRCODE = '22023';
    END IF;
    v_sel := p_departments;
  END IF;

  WITH
  o AS (
    SELECT 'order'::text AS source_kind, ('order:' || o.id::text) AS list_id, o.id AS order_id,
           o.customer_phone, o.customer_name, o.call_again_since,
           NULL::timestamptz AS last_call_at, 'no_answer'::text AS last_call_outcome,
           NULL::timestamptz AS in_call_again_until,
           o.assigned_agent_id, o.assigned_agent_name,
           o.price AS lifetime_value, NULL::integer AS paid_count, o.price AS avg_package_price,
           o.product_name AS list_name, 'order'::text AS list_category,
           public.assigner_dept_key(public.cohort_order_source(
             o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)) AS department,
           o.id::text AS tb
    FROM public.orders o
    WHERE v_source IN ('all', 'order')
      AND o.status = 'call_again'
      AND o.source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')
      AND (v_agent = 'all'
           OR (v_agent = 'unassigned' AND o.assigned_agent_id IS NULL)
           OR o.assigned_agent_id = v_aid)
  ),
  m AS (
    SELECT 'prediction'::text AS source_kind, m.list_id::text AS list_id, NULL::uuid AS order_id,
           m.customer_phone, m.customer_name, m.call_again_since,
           m.last_call_at, m.last_call_outcome, m.in_call_again_until,
           m.assigned_agent_id, m.assigned_agent_name,
           m.lifetime_value, m.paid_count, m.avg_package_price,
           l.name AS list_name, l.category AS list_category,
           public.assigner_dept_key(cd.department) AS department,
           m.list_id::text || '|' || m.customer_phone AS tb
    FROM public.prediction_segment_members m
    LEFT JOIN public.prediction_segment_lists l ON l.id = m.list_id
    LEFT JOIN public.customer_departments cd ON cd.customer_phone = m.customer_phone
    WHERE v_source IN ('all', 'prediction')
      AND m.call_again_since IS NOT NULL
      AND NOT m.is_completed
      AND (v_agent = 'all'
           OR (v_agent = 'unassigned' AND m.assigned_agent_id IS NULL)
           OR m.assigned_agent_id = v_aid)
  ),
  u AS (
    SELECT * FROM o WHERE v_sel IS NULL OR o.department = ANY (v_sel)
    UNION ALL
    SELECT * FROM m WHERE v_sel IS NULL OR m.department = ANY (v_sel)
  ),
  pg AS (
    SELECT u.*
    FROM u
    ORDER BY CASE WHEN v_order = 'oldest' THEN u.call_again_since END ASC NULLS LAST,
             CASE WHEN v_order = 'newest' THEN u.call_again_since END DESC NULLS LAST,
             u.tb
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'total',         (SELECT count(*) FROM u),
    'total_orders',  (SELECT count(*) FROM u WHERE u.source_kind = 'order'),
    'total_members', (SELECT count(*) FROM u WHERE u.source_kind = 'prediction'),
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'source_kind',         p.source_kind,
               'list_id',             p.list_id,
               'order_id',            p.order_id,
               'customer_phone',      p.customer_phone,
               'customer_name',       p.customer_name,
               'call_again_since',    p.call_again_since,
               'last_call_at',        p.last_call_at,
               'last_call_outcome',   p.last_call_outcome,
               'in_call_again_until', p.in_call_again_until,
               'assigned_agent_id',   p.assigned_agent_id,
               'assigned_agent_name', p.assigned_agent_name,
               'lifetime_value',      p.lifetime_value,
               'paid_count',          p.paid_count,
               'avg_package_price',   p.avg_package_price,
               'list_name',           p.list_name,
               'list_category',       p.list_category,
               'department',          p.department)
             ORDER BY CASE WHEN v_order = 'oldest' THEN p.call_again_since END ASC NULLS LAST,
                      CASE WHEN v_order = 'newest' THEN p.call_again_since END DESC NULLS LAST,
                      p.tb)
      FROM pg p), '[]'::jsonb)
  ) INTO v_out;

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.assigner_call_agains(text, text, text[], text, integer, integer) IS
  'GET /api/call-agains (20260942001962): lead call_again orders + member callbacks (call_again_since, not completed), filtered by agent (all / unassigned / id), source, department (order''s own / buyer''s), sorted by call_again_since (oldest | newest, missing last), paged (limit ≤ 500) with true totals. Read-only. Service role only.';

REVOKE ALL ON FUNCTION public.assigner_call_agains(text, text, text[], text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assigner_call_agains(text, text, text[], text, integer, integer) TO service_role;

-- the call-again expiry leaves the GETs: every 5 minutes, not while the nightly
-- segment recompute runs (00:00 UTC)
DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'call-again-expiry';
END
$cron$;

SELECT cron.schedule(
  'call-again-expiry',
  '*/5 1-23 * * *',
  $job$SELECT public.expire_call_again_window();$job$
);

COMMIT;

NOTIFY pgrst, 'reload schema';
