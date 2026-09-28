-- READ-ONLY (run with read_only: true) — before deploying mex-reconcile with the upsell revive
-- (supabase/functions/mex-reconcile/match.ts pickCandidate 'upsell_revive', migration
-- 20260940000200). How many registered parcels / orders the new path would revive if every
-- parcel were matched now. Mirrors pickCandidate: BIO NATURAL 9110, COD > 0, window
-- [−3 d … +75 d] of the order's created_at, exactly ONE unlinked real sale in the window whose
-- COD does not fit, that sale cancelled 'no_parcel_7d' and AlterCPA-sourced.
-- with_linked_sibling: the phone ALSO has another real sale that already holds a parcel — the
-- stricter reading of "exactly one real sale on the phone" would NOT revive these; inspect each
-- row before deploying. revive_parcels > revive_orders: an order with two qualifying parcels
-- (a live run links the first by last update, reports the second 'unmatched').
WITH p AS (
  SELECT m.tracking_id, m.status_id, m.cod_mkd, m.created_at_mex, m.last_update_at,
         (SELECT CASE WHEN length(d) BETWEEN 8 AND 9 THEN '+389' || d END
            FROM (SELECT regexp_replace(CASE WHEN x LIKE '389%' THEN substr(x, 4) ELSE x END, '^0+', '') AS d
                    FROM (SELECT regexp_replace(coalesce(m.receiver_phone_raw, ''), '\D', '', 'g') AS x) s1) s2) AS e164
    FROM public.mex_parcels m
   WHERE m.account = 'bio_natural' AND m.series = '9110'
     AND m.order_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.orders h WHERE h.mex_tracking_id = m.tracking_id)
     AND coalesce(m.cod_mkd, 0) >= 0
     AND m.created_at_mex IS NOT NULL
), c AS (
  SELECT p.tracking_id, o.id AS order_id,
         o.price > 0 AND NOT public.is_synthetic_product_name(o.product_name) AS real_sale,
         round(o.price * 61.5) <> 0
           AND (abs(coalesce(p.cod_mkd, 0) - round(o.price * 61.5)) <= 3
             OR abs(coalesce(p.cod_mkd, 0) - round(o.price * 61.5) - 150) <= 3) AS cod_fits
    FROM p
    JOIN public.orders o
      ON o.customer_phone = p.e164
     AND o.status <> 'duplicated'
     AND o.created_at >= now() - interval '200 days'
     AND o.mex_tracking_id IS NULL
     AND p.created_at_mex - o.created_at BETWEEN interval '-3 days' AND interval '75 days'
), lone AS (
  SELECT tracking_id, (array_agg(order_id) FILTER (WHERE real_sale))[1] AS order_id
    FROM c GROUP BY tracking_id
  HAVING count(*) FILTER (WHERE real_sale) = 1
     AND count(*) FILTER (WHERE real_sale AND cod_fits) = 0
), r AS (
  SELECT p.*, o.id AS order_id, o.display_id, o.price AS price_eur,
         CASE p.status_id WHEN 2 THEN 'paid' WHEN 7 THEN 'returned' ELSE 'shipped' END AS target,
         EXISTS (SELECT 1 FROM public.orders s
                  WHERE s.customer_phone = p.e164 AND s.id <> o.id AND s.mex_tracking_id IS NOT NULL
                    AND s.status <> 'duplicated' AND s.price > 0
                    AND NOT public.is_synthetic_product_name(s.product_name)
                    AND p.created_at_mex - s.created_at BETWEEN interval '-3 days' AND interval '75 days') AS linked_sibling
    FROM lone
    JOIN p ON p.tracking_id = lone.tracking_id
    JOIN public.orders o ON o.id = lone.order_id
   WHERE o.status = 'cancelled' AND o.cancellation_reason = 'no_parcel_7d'
     AND (o.source_type = 'altercpa' OR o.external_source = 'altercpa')
)
SELECT count(*) FILTER (WHERE cod_mkd > 0) AS revive_parcels,
       count(DISTINCT order_id) FILTER (WHERE cod_mkd > 0) AS revive_orders,
       count(*) FILTER (WHERE cod_mkd > 0 AND target = 'shipped') AS to_shipped,
       count(*) FILTER (WHERE cod_mkd > 0 AND target = 'paid') AS to_paid,
       count(*) FILTER (WHERE cod_mkd > 0 AND target = 'returned') AS to_returned,
       coalesce(sum(cod_mkd) FILTER (WHERE cod_mkd > 0), 0) AS cod_mkd_total,
       coalesce(sum(price_eur) FILTER (WHERE cod_mkd > 0), 0) AS crm_price_eur_total,
       count(*) FILTER (WHERE cod_mkd > 0 AND last_update_at >= now() - interval '60 days') AS in_weekly_sweep_reach,
       count(*) FILTER (WHERE cod_mkd > 0 AND linked_sibling) AS with_linked_sibling,
       count(*) FILTER (WHERE coalesce(cod_mkd, 0) = 0) AS excluded_cod_0,
       (SELECT count(*) FROM public.orders x WHERE x.status = 'cancelled' AND x.cancellation_reason = 'no_parcel_7d') AS no_parcel_7d_cancels_now,
       coalesce(jsonb_agg(jsonb_build_object('order', display_id, 'order_id', order_id, 'tracking', tracking_id,
                  'mex_status', status_id, 'target', target, 'cod_mkd', cod_mkd, 'price_eur', price_eur,
                  'parcel_created', created_at_mex, 'linked_sibling', linked_sibling)
                ORDER BY created_at_mex) FILTER (WHERE cod_mkd > 0), '[]'::jsonb) AS rows
  FROM r;
