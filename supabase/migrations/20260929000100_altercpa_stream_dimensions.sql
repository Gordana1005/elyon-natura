-- Streams (publisher/traffic-source codes) join the attribution read surfaces.
-- Two functions, split on purpose:
--
--   1. altercpa_attribution_dimensions() — re-emitted with a MINIMAL third key.
--      /orders fetches this for its filter popovers (react-query staleTime
--      5 min), so the streams block stays an index-only scan over
--      idx_orders_cpa_stream (20260929000000) — no statuses, no timestamps.
--
--   2. altercpa_stream_distribution() — NEW, the CRM's counterpart of
--      AlterCPA's "Lead distribution by affiliate traffic sources" panel, for
--      the read-only Sources tab on /altercpa. Per-status counts and
--      first/last-seen need heap access (status/created_at are in no stream
--      index), which is fine once per tab open but must not ride along on
--      every /orders filter fetch. Same one-RPC-per-surface split as
--      altercpa_summary vs altercpa_attribution_dimensions.
--
-- Streams carry wm_id in the grain (see the idx comment in 20260929000000):
-- codes are only guaranteed unique within one webmaster.

-- ── 1. Dimensions, re-emitted (webmasters/offers blocks unchanged) ───────────
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
    ), '[]'::jsonb),
    'streams', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x->>'orders')::bigint DESC)
        FROM (
          SELECT jsonb_build_object(
                   'stream_id', o.cpa_stream_id,
                   'wm_id',     o.cpa_webmaster_id,
                   'orders',    count(*)
                 ) AS x
            FROM public.orders o
           WHERE o.cpa_stream_id IS NOT NULL
           GROUP BY o.cpa_stream_id, o.cpa_webmaster_id
        ) s
    ), '[]'::jsonb)
  );
$$;

-- ACLs survive CREATE OR REPLACE, but re-stated so this file reads complete.
REVOKE ALL ON FUNCTION public.altercpa_attribution_dimensions() FROM public, anon, authenticated;

-- ── 2. The per-status distribution for the /altercpa Sources tab ─────────────
CREATE OR REPLACE FUNCTION public.altercpa_stream_distribution()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'total_orders',      (SELECT count(*) FROM public.orders WHERE external_source = 'altercpa'),
    'attributed_orders', (SELECT count(*) FROM public.orders WHERE cpa_stream_id IS NOT NULL),
    'streams', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x->>'orders')::bigint DESC)
        FROM (
          SELECT jsonb_build_object(
                   'stream_id',  o.cpa_stream_id,
                   'wm_id',      o.cpa_webmaster_id,
                   'orders',     count(*),
                   'paid',       count(*) FILTER (WHERE o.status = 'paid'),
                   'confirmed',  count(*) FILTER (WHERE o.status = 'confirmed'),
                   'shipped',    count(*) FILTER (WHERE o.status = 'shipped'),
                   'cancelled',  count(*) FILTER (WHERE o.status = 'cancelled'),
                   'trashed',    count(*) FILTER (WHERE o.status = 'trashed'),
                   'returned',   count(*) FILTER (WHERE o.status = 'returned'),
                   'first_seen', min(o.created_at),
                   'last_seen',  max(o.created_at)
                 ) AS x
            FROM public.orders o
           WHERE o.cpa_stream_id IS NOT NULL
           GROUP BY o.cpa_stream_id, o.cpa_webmaster_id
        ) s
    ), '[]'::jsonb)
  );
$$;

-- ⚠️ Mandatory on a NEW function: Postgres grants EXECUTE to PUBLIC by default,
-- and this one aggregates every partner's per-status volumes — the same
-- commercially-sensitive data that keeps altercpa_* tables admin/manager only.
-- Called only through the api edge function, which gates on admin/manager.
REVOKE ALL ON FUNCTION public.altercpa_stream_distribution() FROM public, anon, authenticated;
