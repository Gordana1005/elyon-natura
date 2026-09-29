-- The TV board's WEB view (owner, 29.09.2026): "in Web there is nothing — there are no agents there; it
-- should show, in real time, how much the web shop has right now".
--
-- leaderboard_web_live(day) = the web shop's day for the board, from the web_orders mirror:
--   · orders / value_mkd — EXACTLY the cohort's web part of that Skopje day (the rows insights_sale_rows
--     counts: the shop's own classifier web_order_outcome → cohort_web_bucket, in-total buckets only,
--     round(total) денари, test phones and shop-deleted orders out) — so the board, the Overview and the
--     leaderboard's day_totals.by_department.web say the same number;
--   · by_outcome — every order of the day by the shop's outcome (awaiting · preparing · courier ·
--     delivered · returned · cancelled · card_unpaid), counted or not;
--   · latest — the 12 newest orders: time, number, city, the main product, pieces, payment, outcome,
--     traffic source. No customer name or phone (a wall screen).
--   · last_order_at, synced_at (the last good web-sync run).
-- web-sync now runs every 5 minutes (was 15) so the view follows the shop closely; read-only against the
-- shop as before (crm_export views), and still "every source at least every 15 minutes".

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.leaderboard_web_live(p_day date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH b AS (
  SELECT (p_day::timestamp AT TIME ZONE 'Europe/Skopje')       AS f,
         ((p_day + 1)::timestamp AT TIME ZONE 'Europe/Skopje') AS t,
         public.report_excluded_phone8s()                         AS ex
),
w AS (
  SELECT w.shop_order_id, w.order_number, w.payment_method, w.total, w.created_at,
         coalesce(nullif(btrim(p.receiver_city), ''), nullif(btrim(w.city), ''))                          AS city,
         coalesce(nullif(btrim(w.traffic_source), ''), nullif(btrim(w.channel), ''), nullif(btrim(w.source), '')) AS src,
         public.web_order_outcome(w.status, w.payment_status, w.payment_method)                           AS outcome,
         public.cohort_web_bucket(public.web_order_outcome(w.status, w.payment_status, w.payment_method),
                                  w.is_legacy, w.total, p.status_id, p.tracking_id IS NOT NULL)          AS bucket
  FROM public.web_orders w
  CROSS JOIN b
  LEFT JOIN public.mex_parcels p ON p.tracking_id = w.mex_tracking_id
  WHERE w.deleted_in_shop_at IS NULL
    AND w.created_at >= b.f AND w.created_at < b.t
    AND NOT public.insights_excluded8(w.phone8, b.ex)
    AND NOT public.insights_excluded8(p.phone8, b.ex)
),
x AS (
  -- the cohort's in-total buckets (insights_cohort) — what the Overview counts as the web's sales
  SELECT w.*, coalesce(w.bucket IN ('paid', 'paid_unproven', 'paid_legacy', 'courier', 'courier_problem',
                                    'label', 'to_pack', 'returned'), false) AS counted
  FROM w
),
oc AS (
  SELECT x.outcome AS key, count(*) AS n, sum(round(x.total)) AS v
  FROM x GROUP BY 1
),
lt AS (
  SELECT x.* FROM x ORDER BY x.created_at DESC, x.shop_order_id DESC LIMIT 12
)
SELECT jsonb_build_object(
  'day',           p_day,
  'orders',        (SELECT count(*) FROM x WHERE x.counted),
  'value_mkd',     (SELECT coalesce(sum(round(x.total)), 0) FROM x WHERE x.counted),
  'all_orders',    (SELECT count(*) FROM x),
  'card',          (SELECT count(*) FROM x WHERE x.counted AND x.payment_method = 'CARD'),
  'cod',           (SELECT count(*) FROM x WHERE x.counted AND x.payment_method IS DISTINCT FROM 'CARD'),
  'by_outcome',    (SELECT coalesce(jsonb_agg(jsonb_build_object('key', oc.key, 'count', oc.n, 'value_mkd', oc.v)
                                              ORDER BY array_position(ARRAY['awaiting', 'preparing', 'courier', 'delivered',
                                                                            'no_record', 'returned', 'cancelled', 'card_unpaid'], oc.key)),
                                    '[]'::jsonb) FROM oc),
  'latest',        (SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'at',        lt.created_at,
                      'number',    lt.order_number,
                      'city',      lt.city,
                      'total_mkd', round(lt.total),
                      'outcome',   lt.outcome,
                      'payment',   CASE WHEN lt.payment_method = 'CARD' THEN 'card' ELSE 'cod' END,
                      'counted',   lt.counted,
                      'source',    lt.src,
                      'item',      (SELECT i.name FROM public.web_order_items i
                                     WHERE i.shop_order_id = lt.shop_order_id AND i.kind = 'SALE'
                                     ORDER BY i.price * i.quantity DESC, i.shop_item_id LIMIT 1),
                      'items',     (SELECT coalesce(sum(i.quantity), 0) FROM public.web_order_items i
                                     WHERE i.shop_order_id = lt.shop_order_id AND i.kind = 'SALE'))
                    ORDER BY lt.created_at DESC, lt.shop_order_id DESC), '[]'::jsonb) FROM lt),
  'last_order_at', (SELECT max(x.created_at) FROM x),
  'synced_at',     (SELECT max(r.finished_at) FROM public.web_sync_runs r WHERE r.status IN ('ok', 'partial'))
)
$fn$;

COMMENT ON FUNCTION public.leaderboard_web_live(date) IS
  'The TV board''s web view (29.09.2026): the web shop''s Skopje day — orders / value_mkd = the cohort''s web part exactly (web_order_outcome → cohort_web_bucket, in-total buckets), by_outcome, the 12 newest orders (no name / phone), last_order_at, synced_at. Migration 20260942001940.';

REVOKE ALL ON FUNCTION public.leaderboard_web_live(date) FROM PUBLIC;
DO $g$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.leaderboard_web_live(date) TO service_role';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.leaderboard_web_live(date) TO supabase_read_only_user';
  END IF;
END
$g$;

-- web-sync every 5 minutes (was 3,18,33,48): the board's web view follows the shop within minutes
DO $c$
DECLARE v_job bigint;
BEGIN
  SELECT jobid INTO v_job FROM cron.job WHERE jobname = 'web-sync';
  IF v_job IS NULL THEN
    RAISE EXCEPTION 'web-sync cron job not found';
  END IF;
  PERFORM cron.alter_job(v_job, schedule := '1-59/5 * * * *');
END
$c$;

COMMIT;
