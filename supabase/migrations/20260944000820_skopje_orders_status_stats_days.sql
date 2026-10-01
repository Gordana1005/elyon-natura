-- Skopje time everywhere (owner 01.10.2026: "we need to match everywhere that it's the same time").
--
-- orders_status_stats (GET /api/orders/stats) — `dailyCounts` bucketed orders by their UTC date, so
-- an order placed 00:00–02:00 Skopje was counted under the day before. The window itself was
-- already Skopje (the api pins bare dates with skopjeMidnight / skopjeRangeEnd); only the per-day
-- buckets were UTC. Now Skopje days, like every other day bucket in the CRM.
--
-- ONE line changed; the rest is the live body as of 01.10.2026. statusCounts / agentCounts / total
-- do not move. (No SPA screen reads dailyCounts today; scripts and the api still do.)

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.orders_status_stats(text,text,boolean)')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('2dbd6e63550d85599c14f4dc76e47613', 'ae8f991cf9b1de7167dcb5caf880b781')) THEN
    RAISE EXCEPTION 'orders_status_stats changed since this migration was written — re-emit it from the live body';
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.orders_status_stats(p_from text DEFAULT NULL::text, p_to text DEFAULT NULL::text, p_exclude_duplicated boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
AS $function$
  WITH base AS (
    SELECT o.status::text AS status,
           o.assigned_agent_name,
           o.created_at
    FROM public.orders o
    WHERE (o.source_type IS NULL OR o.source_type::text <> 'monadon_legacy')
      AND (NULLIF(p_from, '') IS NULL OR o.created_at >= NULLIF(p_from, '')::timestamptz)
      AND (NULLIF(p_to,   '') IS NULL OR o.created_at <= NULLIF(p_to,   '')::timestamptz)
      AND (NOT p_exclude_duplicated OR o.duplicated_from IS NULL)
  )
  SELECT jsonb_build_object(
    'statusCounts', COALESCE((SELECT jsonb_object_agg(status, n)
                                FROM (SELECT status, COUNT(*)::int AS n
                                        FROM base GROUP BY status) s), '{}'::jsonb),
    'agentCounts',  COALESCE((SELECT jsonb_object_agg(assigned_agent_name, n)
                                FROM (SELECT assigned_agent_name, COUNT(*)::int AS n
                                        FROM base
                                       WHERE assigned_agent_name IS NOT NULL
                                         AND assigned_agent_name <> ''
                                       GROUP BY assigned_agent_name) a), '{}'::jsonb),
    'dailyCounts',  COALESCE((SELECT jsonb_object_agg(day, n)
                                FROM (SELECT to_char(created_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD') AS day,
                                             COUNT(*)::int AS n
                                        FROM base GROUP BY 1) d), '{}'::jsonb),
    'total',        (SELECT COUNT(*)::int FROM base)
  );
$function$;

COMMIT;
