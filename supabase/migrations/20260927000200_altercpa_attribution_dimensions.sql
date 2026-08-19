-- The two /orders filter dropdowns: which affiliates and which offers actually
-- appear on orders, with volumes.
--
-- An RPC rather than two PostgREST queries for the same reason altercpa_summary
-- is one: counting 82k rows must happen in Postgres, not by pulling them into
-- the edge function. Both aggregates are index-only scans over the partial
-- indexes from 20260927000100.
--
-- Affiliate names come from altercpa_webmasters, so a rename is reflected the
-- moment the dropdown is reopened. Offer names are read off the orders
-- themselves — they are a historical record, not a live lookup.

CREATE OR REPLACE FUNCTION public.altercpa_attribution_dimensions()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'webmasters', COALESCE((
      SELECT jsonb_agg(x ORDER BY x->>'name' NULLS LAST, (x->>'orders')::bigint DESC)
        FROM (
          SELECT jsonb_build_object(
                   'wm_id',  o.cpa_webmaster_id,
                   'name',   w.name,
                   'orders', count(*)
                 ) AS x
            FROM public.orders o
            LEFT JOIN public.altercpa_webmasters w ON w.wm_id = o.cpa_webmaster_id
           WHERE o.cpa_webmaster_id IS NOT NULL
           GROUP BY o.cpa_webmaster_id, w.name
        ) s
    ), '[]'::jsonb),
    'offers', COALESCE((
      SELECT jsonb_agg(x ORDER BY x->>'name')
        FROM (
          SELECT jsonb_build_object(
                   'offer_id', o.cpa_offer_id,
                   -- One id has always mapped to one name in the live data, but
                   -- max() keeps this total rather than erroring if that ever
                   -- stops being true.
                   'name',     max(o.cpa_offer_name),
                   'orders',   count(*)
                 ) AS x
            FROM public.orders o
           WHERE o.cpa_offer_id IS NOT NULL
           GROUP BY o.cpa_offer_id
        ) s
    ), '[]'::jsonb)
  );
$$;

-- Called only through the api edge function, which gates on admin/manager
-- before invoking it. SECURITY DEFINER + no direct grant means a staff JWT
-- cannot reach it via PostgREST.
REVOKE ALL ON FUNCTION public.altercpa_attribution_dimensions() FROM public, anon, authenticated;
