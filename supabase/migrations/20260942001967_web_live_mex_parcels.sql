-- The TV board's web view shows every day since 01.01.2026 — the MEX web parcels fill the gap
-- (owner, 29.09.2026).
--
-- The shop mirror (web_orders) has no orders from 30.07 to 03.09.2026 except 14–18.08: the old shop was
-- never fully migrated. MEX has the parcels of those days — NATURA, M… / NTMK… (e.g. 19.08: 49 web
-- parcels; 33 belong to web orders of 14–18.08 and count on their order's day, 16 have no web order).
-- The cohort (insights_sale_rows' mo / mr, split 'mex_web') already counts the MEX-only ones as web
-- sales, so the Overview had them; the TV's web view (leaderboard_web_live, 20260942001940) read only
-- web_orders and showed nothing for those days.
--
-- leaderboard_web_live(p_day) now = the cohort's web part of the Skopje day EXACTLY:
--   · the shop's orders as before (web_order_outcome → cohort_web_bucket; since 20260942001965 the
--     shop's "чека потврда" counts, as on its own panel), and
--   · the day's MEX-only web parcels — the same rows as the cohort's mo CTE: web split
--     (cohort_parcel_split = 'mex_web'), not claimed by a live web order, not held by a real order,
--     no test phone; bucket cohort_parcel_bucket (COD 0 = a replacement, not counted), value = COD.
-- New keys: awaiting / awaiting_value_mkd (counted web orders still waiting for the shop's
-- confirmation — the cohort's web 'awaiting'), mex_only / mex_only_value_mkd, latest[].kind
-- ('web' | 'mex'). A parcel row: at = created_at_mex, number = the tracking id, city = the receiver's
-- city, total_mkd = COD, outcome from the MEX status (2 delivered · 7 returned · 8 preparing · else
-- courier), payment cod, source 'MEX', no item. by_outcome includes the parcels.
-- Also: EXECUTE revoked from anon / authenticated (Supabase's default privileges had granted it; the
-- api calls it as service_role). md5 drift guard on the 20260942001940 body.

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.leaderboard_web_live(date)')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('11729bc776dfb8288dd5c43bee857488', 'a2fa54fe784d89ae92e039168d16b57d')) THEN
    RAISE EXCEPTION 'leaderboard_web_live changed since this migration was written — re-emit it from the live body';
  END IF;
END
$drift$;

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
-- the shop's orders of the day (insights_sale_rows' wo / wb / wr): its own classifier, the cohort's bucket
w AS (
  SELECT 'web'::text AS kind, w.shop_order_id, w.order_number AS number, w.payment_method,
         round(w.total) AS total_mkd, w.created_at AS at,
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
-- the day's MEX-only web parcels (NATURA M… / NTMK…) — the SAME rows the cohort counts as 'mex_web'
-- (insights_sale_rows' mo / mr): not claimed by a live web order, not held by a real order (a test
-- order's parcel is that order's: counted nowhere), not a test phone. They fill the days the shop
-- mirror has no orders for (30.07–03.09.2026). No product: MEX does not say what was in the parcel.
m AS (
  SELECT 'mex'::text AS kind, NULL::integer AS shop_order_id, p.tracking_id AS number, NULL::text AS payment_method,
         CASE WHEN coalesce(p.cod_mkd, 0) > 0 THEN p.cod_mkd::numeric ELSE 0::numeric END AS total_mkd,
         p.created_at_mex AS at,
         nullif(btrim(p.receiver_city), '') AS city,
         'MEX'::text AS src,
         -- the MEX status in the words the shop's outcomes use
         CASE WHEN p.status_id = 2 THEN 'delivered'
              WHEN p.status_id = 7 THEN 'returned'
              WHEN p.status_id = 8 THEN 'preparing'
              ELSE 'courier' END AS outcome,
         public.cohort_parcel_bucket(p.status_id, p.cod_mkd) AS bucket
  FROM public.mex_parcels p
  CROSS JOIN b
  WHERE p.created_at_mex >= b.f AND p.created_at_mex < b.t
    AND public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference) = 'mex_web'
    AND NOT public.insights_excluded8(p.phone8, b.ex)
    AND NOT EXISTS (SELECT 1 FROM public.web_orders wo
                     WHERE wo.mex_tracking_id = p.tracking_id AND wo.deleted_in_shop_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM public.orders x
                     WHERE x.mex_tracking_id = p.tracking_id
                       AND x.sale_source_detail IS DISTINCT FROM 'disposition')
    AND (p.order_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.orders x
                         WHERE x.id = p.order_id
                           AND x.sale_source_detail IS DISTINCT FROM 'disposition'))
),
x AS (
  -- counted = the cohort's in-total buckets (insights_cohort) — what the Overview counts as the web's sales
  SELECT u.*, public.cohort_in_total(u.bucket) AS counted,
         -- still waiting for the shop's confirmation (20260942001965): the cohort's web 'awaiting'
         (u.kind = 'web' AND u.bucket = 'to_pack' AND u.outcome = 'awaiting') AS awaiting
  FROM (SELECT * FROM w UNION ALL SELECT * FROM m) u
),
oc AS (
  SELECT x.outcome AS key, count(*) AS n, sum(x.total_mkd) AS v
  FROM x GROUP BY 1
),
lt AS (
  SELECT x.* FROM x ORDER BY x.at DESC, x.number DESC LIMIT 12
)
SELECT jsonb_build_object(
  'day',           p_day,
  'orders',        (SELECT count(*) FROM x WHERE x.counted),
  'value_mkd',     (SELECT coalesce(sum(x.total_mkd), 0) FROM x WHERE x.counted),
  'all_orders',    (SELECT count(*) FROM x),
  'card',          (SELECT count(*) FROM x WHERE x.counted AND x.payment_method = 'CARD'),
  'cod',           (SELECT count(*) FROM x WHERE x.counted AND x.payment_method IS DISTINCT FROM 'CARD'),
  'awaiting',      (SELECT count(*) FROM x WHERE x.counted AND x.awaiting),
  'awaiting_value_mkd', (SELECT coalesce(sum(x.total_mkd), 0) FROM x WHERE x.counted AND x.awaiting),
  'mex_only',      (SELECT count(*) FROM x WHERE x.counted AND x.kind = 'mex'),
  'mex_only_value_mkd', (SELECT coalesce(sum(x.total_mkd), 0) FROM x WHERE x.counted AND x.kind = 'mex'),
  'by_outcome',    (SELECT coalesce(jsonb_agg(jsonb_build_object('key', oc.key, 'count', oc.n, 'value_mkd', oc.v)
                                              ORDER BY array_position(ARRAY['awaiting', 'preparing', 'courier', 'delivered',
                                                                            'no_record', 'returned', 'cancelled', 'card_unpaid'], oc.key)),
                                    '[]'::jsonb) FROM oc),
  'latest',        (SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'kind',      lt.kind,
                      'at',        lt.at,
                      'number',    lt.number,
                      'city',      lt.city,
                      'total_mkd', lt.total_mkd,
                      'outcome',   lt.outcome,
                      'payment',   CASE WHEN lt.payment_method = 'CARD' THEN 'card' ELSE 'cod' END,
                      'counted',   lt.counted,
                      'source',    lt.src,
                      'item',      (SELECT i.name FROM public.web_order_items i
                                     WHERE i.shop_order_id = lt.shop_order_id AND i.kind = 'SALE'
                                     ORDER BY i.price * i.quantity DESC, i.shop_item_id LIMIT 1),
                      'items',     (SELECT coalesce(sum(i.quantity), 0) FROM public.web_order_items i
                                     WHERE i.shop_order_id = lt.shop_order_id AND i.kind = 'SALE'))
                    ORDER BY lt.at DESC, lt.number DESC), '[]'::jsonb) FROM lt),
  'last_order_at', (SELECT max(x.at) FROM x),
  'synced_at',     (SELECT max(r.finished_at) FROM public.web_sync_runs r WHERE r.status IN ('ok', 'partial'))
)
$fn$;

COMMENT ON FUNCTION public.leaderboard_web_live(date) IS
  'The TV board''s web view: the web shop''s Skopje day = the cohort''s web part exactly — the shop''s orders (web_order_outcome → cohort_web_bucket; "чека потврда" counts, 20260942001965) + the day''s MEX-only web parcels (the cohort''s mex_web rows, 20260942001967) — orders / value_mkd (in-total buckets), awaiting (waiting for the shop''s confirmation), mex_only, by_outcome, the 12 newest rows (kind web | mex; no name / phone), last_order_at, synced_at.';

-- 20260942001940 revoked from PUBLIC only; Supabase's default privileges had also granted anon /
-- authenticated EXECUTE on this SECURITY DEFINER function (the api calls it as service_role)
REVOKE ALL ON FUNCTION public.leaderboard_web_live(date) FROM PUBLIC, anon, authenticated;
DO $g$
BEGIN
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.leaderboard_web_live(date) TO service_role';
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.leaderboard_web_live(date) TO supabase_read_only_user';
  END IF;
END
$g$;

COMMIT;
