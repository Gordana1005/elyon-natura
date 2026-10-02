-- ============================================================================
-- Insights → Наплата (MEX) — what MEX collected, per day and per MEX account
-- (owner, 02.10.2026).
--
-- The owner: "Прилив од MEX" on the Overview / Табла read as money received that
-- day, while MEX pays out in lumps. The report's first page is the call centre
-- now; MEX's collections get their own place — every day, per account, and per
-- MEX settlement period.
--
-- What is proven (Sigma, 02.10.2026 — the MEX fee invoices of partner 000217
-- МЕКС ПОШТА, 2025–2026): MEX settles per HALF-MONTH (1–15 and 16–end of month),
-- one invoice per account (NATURA = НАТУРА ТЕРАПИ, BIO NATURAL = АД Астра), and
-- the parcels it bills = the parcels mex_parcels shows delivered (MEX 2) in that
-- half-month, to the parcel (BIO NATURAL 10 of 10 half-months 16.04–15.09). So
-- the half-month rows here are MEX's own periods. The PAYOUT dates are NOT in
-- any data we hold (the Sigma dump has no ledger / bank statement tables; the
-- MEX API has no payout field) — this function shows what MEX collected, never
-- what reached the bank.
--
-- One function, read-only:
--   public.insights_mex_cash(p_from, p_to_end, p_money)
--     days    every Skopje day of the window: per account the parcels MEX
--             delivered and collected (delivered_at, MEX 2) + their COD, and the
--             parcels returned to us (returned_at, MEX 7)
--     total   the window per account
--     halves  the last 6 MEX settlement periods (independent of the window):
--             per account parcels + COD; `complete` = the period is over
--     now     what MEX holds right now (no clock): at the courier (MEX 1 / 3 / 4
--             / 9 / 10 / 13) and labelled, not picked up yet (MEX 8)
--     data_through  the newest MEX sweep (max last_seen_at)
--   Test phones (report_excluded_phone8s) are never counted (owner, 28.09).
--   Money keys end in _mkd (денари — MEX COD is already денари); p_money =
--   false strips them (insights_strip_money), and the api strips again by
--   whitelist for a non-owner.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.insights_mex_cash(
  p_from   timestamp with time zone,
  p_to_end timestamp with time zone,
  p_money  boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET "TimeZone" TO 'UTC'
SET jit TO 'off'
AS $function$
DECLARE
  v_ex    text[] := public.report_excluded_phone8s();
  v_fd    date;
  v_td    date;
  v_today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_j     jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_mex_cash: bad window' USING ERRCODE = '22023';
  END IF;
  v_fd := (p_from AT TIME ZONE 'Europe/Skopje')::date;
  v_td := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;

  WITH
  dl AS (      -- delivered + collected (MEX 2) in the window, by Skopje day × account
    SELECT (p.delivered_at AT TIME ZONE 'Europe/Skopje')::date AS d, p.account,
           count(*) AS n, coalesce(sum(p.cod_mkd), 0) AS cod
    FROM public.mex_parcels p
    WHERE p.delivered_at BETWEEN p_from AND p_to_end
      AND NOT public.insights_excluded8(p.phone8, v_ex)
    GROUP BY 1, 2
  ),
  rt AS (      -- returned to us (MEX 7) in the window
    SELECT (p.returned_at AT TIME ZONE 'Europe/Skopje')::date AS d, p.account,
           count(*) AS n, coalesce(sum(p.cod_mkd), 0) AS cod
    FROM public.mex_parcels p
    WHERE p.returned_at BETWEEN p_from AND p_to_end
      AND p.status_id = 7
      AND NOT public.insights_excluded8(p.phone8, v_ex)
    GROUP BY 1, 2
  ),
  acc AS (SELECT unnest(ARRAY['natura', 'bio_natural']) AS account),
  dd AS (SELECT g::date AS d FROM generate_series(v_fd::timestamp, v_td::timestamp, interval '1 day') g),
  dj AS (
    SELECT coalesce(jsonb_agg(x.j ORDER BY x.d), '[]'::jsonb) AS j
    FROM (
      SELECT dd.d, jsonb_build_object('d', to_char(dd.d, 'YYYY-MM-DD')) ||
             jsonb_object_agg(acc.account, jsonb_build_object(
               'parcels',      coalesce(dl.n, 0),
               'cod_mkd',      coalesce(dl.cod, 0),
               'returned',     coalesce(rt.n, 0),
               'returned_cod_mkd', coalesce(rt.cod, 0))) AS j
      FROM dd
      CROSS JOIN acc
      LEFT JOIN dl ON dl.d = dd.d AND dl.account = acc.account
      LEFT JOIN rt ON rt.d = dd.d AND rt.account = acc.account
      GROUP BY dd.d
    ) x
  ),
  tj AS (
    SELECT jsonb_object_agg(acc.account, jsonb_build_object(
             'parcels',  coalesce((SELECT sum(dl.n)   FROM dl WHERE dl.account = acc.account), 0),
             'cod_mkd',  coalesce((SELECT sum(dl.cod) FROM dl WHERE dl.account = acc.account), 0),
             'returned', coalesce((SELECT sum(rt.n)   FROM rt WHERE rt.account = acc.account), 0),
             'returned_cod_mkd', coalesce((SELECT sum(rt.cod) FROM rt WHERE rt.account = acc.account), 0))) AS j
    FROM acc
  ),
  hv AS (      -- the last 6 half-months (MEX's settlement periods) up to today's
    SELECT h.hs, h.he
    FROM (
      SELECT m::date AS hs, (m + interval '14 days')::date AS he
      FROM generate_series(date_trunc('month', v_today::timestamp) - interval '3 months', v_today::timestamp, interval '1 month') m
      UNION ALL
      SELECT (m + interval '15 days')::date, (m + interval '1 month' - interval '1 day')::date
      FROM generate_series(date_trunc('month', v_today::timestamp) - interval '3 months', v_today::timestamp, interval '1 month') m
    ) h
    WHERE h.hs <= v_today
    ORDER BY h.hs DESC
    LIMIT 6
  ),
  hd AS (
    SELECT hv.hs, p.account, count(*) AS n, coalesce(sum(p.cod_mkd), 0) AS cod
    FROM hv
    JOIN public.mex_parcels p
      ON p.delivered_at >= (hv.hs::timestamp AT TIME ZONE 'Europe/Skopje')
     AND p.delivered_at <  ((hv.he + 1)::timestamp AT TIME ZONE 'Europe/Skopje')
    WHERE NOT public.insights_excluded8(p.phone8, v_ex)
    GROUP BY 1, 2
  ),
  hj AS (
    SELECT coalesce(jsonb_agg(x.j ORDER BY x.hs DESC), '[]'::jsonb) AS j
    FROM (
      SELECT hv.hs, jsonb_build_object(
               'from', to_char(hv.hs, 'YYYY-MM-DD'),
               'to',   to_char(hv.he, 'YYYY-MM-DD'),
               'complete', hv.he < v_today) ||
             jsonb_object_agg(acc.account, jsonb_build_object(
               'parcels', coalesce(hd.n, 0),
               'cod_mkd', coalesce(hd.cod, 0))) AS j
      FROM hv
      CROSS JOIN acc
      LEFT JOIN hd ON hd.hs = hv.hs AND hd.account = acc.account
      GROUP BY hv.hs, hv.he
    ) x
  ),
  nw AS (      -- what MEX holds right now (no clock)
    SELECT p.account,
           count(*) FILTER (WHERE p.status_id IN (1, 3, 4, 9, 10, 13))                     AS courier,
           coalesce(sum(p.cod_mkd) FILTER (WHERE p.status_id IN (1, 3, 4, 9, 10, 13)), 0)  AS courier_cod,
           count(*) FILTER (WHERE p.status_id = 8)                                          AS label,
           coalesce(sum(p.cod_mkd) FILTER (WHERE p.status_id = 8), 0)                       AS label_cod
    FROM public.mex_parcels p
    WHERE p.status_id IN (1, 3, 4, 8, 9, 10, 13)
      AND NOT public.insights_excluded8(p.phone8, v_ex)
    GROUP BY p.account
  ),
  nj AS (
    SELECT jsonb_object_agg(acc.account, jsonb_build_object(
             'courier',         coalesce(nw.courier, 0),
             'courier_cod_mkd', coalesce(nw.courier_cod, 0),
             'label',           coalesce(nw.label, 0),
             'label_cod_mkd',   coalesce(nw.label_cod, 0))) AS j
    FROM acc
    LEFT JOIN nw ON nw.account = acc.account
  )
  SELECT jsonb_build_object(
           'meta',   jsonb_build_object('accounts', jsonb_build_array('natura', 'bio_natural'),
                                        'today', to_char(v_today, 'YYYY-MM-DD'),
                                        'data_through', (SELECT max(p.last_seen_at) FROM public.mex_parcels p)),
           'days',   (SELECT j FROM dj),
           'total',  (SELECT j FROM tj),
           'halves', (SELECT j FROM hj),
           'now',    (SELECT j FROM nj))
  INTO v_j;

  RETURN CASE WHEN coalesce(p_money, false) THEN v_j ELSE public.insights_strip_money(v_j) END;
END;
$function$;

-- ── who sees it ─────────────────────────────────────────────────────────────
-- A short NAMED list, not every owner (owner, 02.10.2026: "what we expect should
-- be shown to 2–3 people only" — Mile Stoev + Hedi; "we would set rules and
-- permissions about who can see what later"). app_settings.mex_cash.viewers =
-- user ids; a viewer must also be a business owner (money). Everyone else — the
-- other admins included — gets 403 from GET /insights/mex-cash and no tab.
INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('mex_cash',
        jsonb_build_object('viewers', jsonb_build_array(
          '27f13f6e-fd19-44bb-a3c8-a6855a887cc7',    -- Mile Stoev
          '461ad748-04cd-4218-8ebb-a688835708d6')),  -- Hedi
        now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.can_see_mex_cash(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT p_uid IS NOT NULL
     AND public.is_business_owner(p_uid)
     AND EXISTS (
       SELECT 1
       FROM public.app_settings s
       CROSS JOIN LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(s.value -> 'viewers') = 'array' THEN s.value -> 'viewers' ELSE '[]'::jsonb END) v(id)
       WHERE s.key = 'mex_cash' AND v.id = p_uid::text)
$$;
REVOKE ALL ON FUNCTION public.can_see_mex_cash(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_see_mex_cash(uuid) TO service_role;

-- The caller's own answer (the Insights page asks it to show or hide the tab).
CREATE OR REPLACE FUNCTION public.my_can_see_mex_cash()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$ SELECT public.can_see_mex_cash((SELECT auth.uid())) $$;
REVOKE ALL ON FUNCTION public.my_can_see_mex_cash() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_can_see_mex_cash() TO authenticated, service_role;

-- 'mex_cash' joins the owner keys: never written from the browser.
CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at', 'mex_push', 'link_lead_parcels', 'leads_parcel_orders', 'stock_v2', 'shops_reader', 'call_scripts', 'collab_entry_rule', 'bonus_rules', 'mex_cash'];
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
$function$;

REVOKE ALL ON FUNCTION public.insights_mex_cash(timestamptz, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_mex_cash(timestamptz, timestamptz, boolean) TO service_role;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.insights_mex_cash(timestamptz, timestamptz, boolean) TO supabase_read_only_user';
  END IF;
END
$g$;

COMMIT;
