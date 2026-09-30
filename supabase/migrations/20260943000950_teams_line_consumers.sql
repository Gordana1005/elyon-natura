-- ============================================================================
-- TEAMS = BUSINESS LINES — the readers (owner ruling 30.09.2026, plan "Фаза 3")
--
-- Apply AFTER 20260943000900_teams_business_lines.sql (sales_teams.kind /
-- sort_order, sales_team_members.lane). Every function below is re-created from
-- its LIVE definition (pg_get_functiondef, 01.10.2026) with small, named edits;
-- the drift guard refuses to run if any of them changed since. Signatures,
-- grants and every NUMBER are unchanged — only team labels / lanes / order:
--
--   sales_team_filter_matches(filter, team_key, lane)   NEW, IMMUTABLE: one
--       place that reads a board's team filter — a team key, 'team:lane',
--       'none', or a legacy alias: altercpa_leads → the old team's rows + affiliate
--       lane in; crm_prediction → the old team's rows + lane out on every line
--       (old TV links ?team= / ?mode= keep working).
--   insights_people   'kind' = 'team' for EVERY key in sales_teams; the groups of
--       sellers outside a team are renamed teleshop_unassigned / social_unassigned
--       (a real team key 'teleshop' would have collided with the old pseudo-group);
--       teams ordered by sales_teams.sort_order; + team_kind, sort_order, lanes
--       (people per lane) on a team, lane on its members, team_lane / team_kind on
--       a person, lane / kind on a drill's memberships.
--   leaderboard_day_v2   p_team also takes 'team:lane' and the legacy aliases;
--       teams by sort_order, each with its lanes; rows carry team_lane / team_kind;
--       a member of a management team is shown, never ranked (as is_manager).
--   assigner_board    each agent's team_lane (display only).
--   insights_work     teams carry kind / sort_order (ordered by sort_order);
--       people carry team_lane.
--   sales_teams_admin_overview   teams carry kind / sort_order (ordered by it);
--       memberships carry lane (Settings → Teams).
-- Departments are NOT touched: no department function reads a team
-- (scripts/verify-teams.mjs, T3).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
DECLARE
  _f record;
BEGIN
  FOR _f IN
    SELECT * FROM (VALUES
      ('public.insights_people(timestamptz,timestamptz,timestamptz,timestamptz,uuid)', '5e414eb23f34fd584e57b134bbda13ef'),
      ('public.leaderboard_day_v2(date,text,text)',                                     '766f11de86dce386231f7ea3b93d6727'),
      ('public.assigner_board()',                                                       'ad21e65be9b4e3c270368b136877d609'),
      ('public.insights_work(timestamptz,timestamptz,timestamptz,timestamptz,uuid)',   'f207466fafef25fc599fd4f7b92ae089'),
      ('public.sales_teams_admin_overview()',                                           '308acc152ddf588907ad060341635265')
    ) v(sig, md5)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = to_regprocedure(_f.sig)
                      AND md5(replace(p.prosrc, chr(13), '')) = _f.md5) THEN
      RAISE EXCEPTION 'teams line consumers: % changed since this migration was written (want md5 %)', _f.sig, _f.md5;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'sales_team_members' AND column_name = 'lane')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'sales_teams' AND column_name = 'sort_order') THEN
    RAISE EXCEPTION 'teams line consumers: apply 20260943000900_teams_business_lines.sql first';
  END IF;
END
$drift$;

-- ── 0. the team filter, in one place ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sales_team_filter_matches(p_filter text, p_team text, p_lane text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE
    WHEN p_filter IS NULL OR btrim(p_filter) = '' THEN true
    WHEN p_filter = 'none'           THEN p_team IS NULL
    -- legacy aliases (the teams before 30.09.2026): the old key, or the lane it became
    WHEN p_filter = 'altercpa_leads' THEN coalesce(p_team = 'altercpa_leads' OR (p_team = 'affiliate' AND p_lane = 'in'), false)
    WHEN p_filter = 'crm_prediction' THEN coalesce(p_team = 'crm_prediction' OR p_lane = 'out', false)
    WHEN strpos(p_filter, ':') > 0   THEN coalesce(p_team = split_part(p_filter, ':', 1)
                                                   AND p_lane = split_part(p_filter, ':', 2), false)
    ELSE coalesce(p_team = p_filter, false)
  END
$fn$;

COMMENT ON FUNCTION public.sales_team_filter_matches(text, text, text) IS
  'A board''s team filter (owner ruling 30.09.2026, 20260943000950): NULL = everyone · ''none'' = no team · ''team:lane'' · a team key · the legacy aliases altercpa_leads (→ the old team + affiliate lane in) and crm_prediction (→ the old team + lane out on every line). Display only — never a department.';

REVOKE ALL ON FUNCTION public.sales_team_filter_matches(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_team_filter_matches(text, text, text) TO authenticated, service_role;
DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.sales_team_filter_matches(text, text, text) TO supabase_read_only_user';
  END IF;
END
$g$;

-- ── 1. insights_people ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.insights_people(p_from timestamp with time zone, p_to_end timestamp with time zone, p_prev_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_prev_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_person uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_pf       timestamptz;
  v_pt       timestamptz;
  v_fd       date;
  v_td       date;
  v_gran     text;
  v_lo       timestamptz;
  v_presence text;
  v_stamped  timestamptz;
  v_out      jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_people: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_people: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL
     AND p_prev_to_end >= p_prev_from AND p_prev_to_end - p_prev_from <= interval '800 days' THEN
    v_pf := p_prev_from;
    v_pt := p_prev_to_end;
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_gran := CASE WHEN v_td - v_fd + 1 <= 62 THEN 'day' ELSE 'month' END;
  v_lo   := least(p_from, coalesce(v_pf, p_from));
  SELECT to_char(min(a.day), 'YYYY-MM-DD') INTO v_presence FROM public.agent_presence_days a;
  -- when the seller stamping last ran (20260939000300; absent → NULL)
  IF to_regclass('public.order_decider_runs') IS NOT NULL THEN
    EXECUTE 'SELECT max(r.finished_at) FROM public.order_decider_runs r' INTO v_stamped;
  END IF;

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 from day ·
  -- $6 to day · $7 person · $8 the earliest instant (prev) · $9 today
  -- (Skopje) · $10 granularity · $11 the test phones' last-8 digits ·
  -- $12 presence recorded since · $13 last seller-stamping run
  -- The EXECUTE text below is byte-identical to the body tested
  -- read-only against live data (scratchpad run-body.mjs, 2026-09-28).
  EXECUTE $pp$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt,
         $5::date AS fd, $6::date AS td, $7::uuid AS person, $9::date AS today, $10::text AS gran,
         CASE WHEN $10::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS sfmt
),
-- the owner's test phones: their parcels, and every order that holds one or
-- is on one (a decision on such an order is no work — insights_overview's xto)
xtp AS MATERIALIZED (
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($11::text[])
),
xto AS MATERIALIZED (
  SELECT x.id FROM public.orders x
   WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ($11::text[])
  UNION
  SELECT x.id FROM public.orders x JOIN xtp ON xtp.tr = x.mex_tracking_id
),
-- THE sale cohort (insights_sale_rows), current and previous window in ONE
-- scan, with what its row does not carry, for the window's order sales:
--   sold_*  why a sale has no seller (read for the unattributed orders only)
--   units   PACKAGES of a credited sale = units on its lines priced >= 1 EUR
--           (gifts, loyalty points and 0,01 EUR samples are not packages: 18k
--           of 96k units in the last year); an order with no such line is its
--           own quantity when that is a plausible 1-24, else 1 (597 x 0,05 EUR
--           is one package typed as cents). Display only: the bonus block
--           keeps its own package rule, untouched.
-- Looked up row by row through the primary keys, on purpose: a join of two
-- materialised CTEs has no statistics and was planned as a nested loop (a
-- year: 50k x 40k rows, > 100 s); and only for the rows that need it (a
-- lateral over every row costs its loop even when it finds nothing).
srr AS MATERIALIZED (
  SELECT r.kind, r.source, r.split, r.bucket, r.in_total, r.value_mkd, r.cod_mkd,
         r.sale_day, r.person_id, r.order_id, r.display_id,
         (r.sale_at BETWEEN prm.f AND prm.t)                  AS cur,
         coalesce(r.sale_at BETWEEN prm.pf AND prm.pt, false) AS prev
  FROM public.insights_sale_rows($8::timestamptz, $2::timestamptz, false) r
  CROSS JOIN prm
),
sr AS MATERIALIZED (
  -- credited order sales of the window: their packages
  SELECT r.*, NULL::timestamptz AS sold_at, NULL::text AS sold_via, NULL::text AS sold_by_ext,
         coalesce(u.units,
                  (SELECT CASE WHEN x.quantity BETWEEN 1 AND 24 THEN x.quantity ELSE 1 END
                     FROM public.orders x WHERE x.id = r.order_id), 1)::numeric AS units
  FROM srr r
  LEFT JOIN LATERAL (
    SELECT sum(oi.quantity) AS units
    FROM public.order_items oi
    WHERE oi.order_id = r.order_id AND oi.price_per_unit >= 1 AND oi.quantity > 0
    HAVING count(*) > 0) u ON true
  WHERE r.cur AND r.kind = 'order' AND r.person_id IS NOT NULL
  UNION ALL
  -- unattributed order sales of the window: their sold_* stamp
  SELECT r.*, o.sold_at, o.sold_via, o.sold_by_ext, NULL::numeric
  FROM srr r
  LEFT JOIN LATERAL (
    SELECT x.sold_at, x.sold_via, x.sold_by_ext FROM public.orders x WHERE x.id = r.order_id) o ON true
  WHERE r.cur AND r.kind = 'order' AND r.person_id IS NULL
  UNION ALL
  -- everything else (web, MEX-only, the previous window) as is
  SELECT r.*, NULL::timestamptz, NULL::text, NULL::text, NULL::numeric
  FROM srr r
  WHERE NOT (r.cur AND r.kind = 'order')
),
-- primary team memberships (at most one per person per day — EXCLUDE)
mem AS MATERIALIZED (
  SELECT m.person_id, m.team_key, m.valid_from, coalesce(m.valid_to, 'infinity'::date) AS valid_to, m.role
  FROM public.sales_team_members m
  WHERE m.is_primary
),
-- the work ledger: every human decision (CRM + AlterCPA), test orders out
vw AS MATERIALIZED (
  SELECT v.at, (v.at AT TIME ZONE 'Europe/Skopje')::date AS d, v.person_id, v.via, v.order_id,
         v.outcome, v.actor_ext,
         (v.at BETWEEN prm.f AND prm.t)                  AS cur,
         coalesce(v.at BETWEEN prm.pf AND prm.pt, false) AS prev
  FROM public.v_sales_work v
  CROSS JOIN prm
  WHERE v.at BETWEEN $8::timestamptz AND $2::timestamptz
    AND (v.order_id IS NULL OR v.order_id NOT IN (SELECT xto.id FROM xto))
),
-- time on the CRM (agent_presence_days, Skopje days; recorded since 28.09.2026)
pr AS MATERIALIZED (
  SELECT a.user_id, a.day, a.online_minutes, a.active_minutes, a.idle_minutes, a.break_minutes,
         a.idle_alerts, a.first_active_at, a.last_active_at
  FROM public.agent_presence_days a
  CROSS JOIN prm
  WHERE a.day BETWEEN prm.fd AND prm.td
),
-- the live state now: insights_overview's rule, verbatim
pn AS (
  SELECT a.user_id,
         CASE WHEN a.last_state IN ('active', 'idle', 'break') AND a.last_seen_at >= now() - interval '3 minutes'
              THEN CASE a.last_state WHEN 'active' THEN 'online' ELSE a.last_state END
              ELSE 'offline' END AS st
  FROM public.agent_presence_days a
  WHERE a.day = (now() AT TIME ZONE 'Europe/Skopje')::date
),
-- ONE event table. grp = the team the person was in ON THAT DAY (primary
-- membership); with none: a teleshop sale — Телешоп – Lead in (teleshop_other)
-- or Телешоп – Lead out (teleshop_out, 20260942001000) → 'teleshop_unassigned', a
-- social-media sale → 'social_unassigned', anything else → 'none' (20260943000950:
-- 'teleshop' is a real team key now — a business line). k: s sale · w decision · p presence day · r roster.
ev AS MATERIALIZED (
  SELECT 's'::text AS k, s.person_id,
         coalesce(m.team_key, CASE s.source WHEN 'teleshop_other' THEN 'teleshop_unassigned'
                                            WHEN 'teleshop_out' THEN 'teleshop_unassigned'
                                            WHEN 'social' THEN 'social_unassigned' ELSE 'none' END) AS grp,
         s.sale_day AS d, s.cur, s.prev,
         s.source, s.bucket, s.in_total, s.value_mkd, s.cod_mkd, s.units,
         NULL::text AS outcome, NULL::text AS via, false AS pday,
         NULL::integer AS online, NULL::integer AS active, NULL::integer AS idle, NULL::integer AS brk,
         NULL::integer AS alerts, NULL::timestamptz AS first_at, NULL::timestamptz AS last_at,
         s.kind AS skind
  FROM sr s
  LEFT JOIN mem m ON m.person_id = s.person_id AND s.sale_day BETWEEN m.valid_from AND m.valid_to
  WHERE s.person_id IS NOT NULL AND (s.cur OR s.prev)
  UNION ALL
  SELECT 'w', v.person_id, coalesce(m.team_key, 'none'), v.d, v.cur, v.prev,
         NULL, NULL, NULL, NULL, NULL, NULL,
         v.outcome, v.via, (pd.user_id IS NOT NULL),
         NULL, NULL, NULL, NULL, NULL, v.at, v.at, NULL
  FROM vw v
  LEFT JOIN mem m ON m.person_id = v.person_id AND v.d BETWEEN m.valid_from AND m.valid_to
  LEFT JOIN public.sales_people sp ON sp.id = v.person_id
  LEFT JOIN pr pd ON pd.user_id = sp.user_id AND pd.day = v.d
  WHERE v.person_id IS NOT NULL
  UNION ALL
  SELECT 'p', sp.id, coalesce(m.team_key, 'none'), a.day, true, false,
         NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, false,
         a.online_minutes, a.active_minutes, a.idle_minutes, a.break_minutes, a.idle_alerts,
         a.first_active_at, a.last_active_at, NULL
  FROM pr a
  JOIN public.sales_people sp ON sp.user_id = a.user_id
  LEFT JOIN mem m ON m.person_id = sp.id AND a.day BETWEEN m.valid_from AND m.valid_to
  UNION ALL
  -- the roster: everyone on a team in the window is shown, sales or not
  -- (a closed membership keeps its past days even after deactivation)
  SELECT 'r', m.person_id, m.team_key, NULL::date, true, false,
         NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, false,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM mem m
  JOIN public.sales_people sp ON sp.id = m.person_id
  CROSS JOIN prm
  WHERE m.valid_from <= prm.td AND m.valid_to >= prm.fd
    AND (sp.is_active OR m.valid_to < 'infinity'::date)
),
-- ONE pass over the events (grp × person), then the person and team rows
-- summed from those ~200 rows: a GROUPING SETS over the ~50k events ran
-- every one of the 50 aggregates three times.
ag0 AS MATERIALIZED (
  SELECT e.grp, e.person_id,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total)                                             AS sales,
         count(*) FILTER (WHERE e.k = 's' AND e.cur)                                                            AS sale_rows,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.skind = 'booking')                     AS booked,
         count(*) FILTER (WHERE e.k = 's' AND e.prev AND e.in_total)                                            AS prev_sales,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'paid')                                      AS b_paid,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'paid_legacy')                               AS b_paid_legacy,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'paid_unproven')                             AS b_paid_unproven,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'courier')                                   AS b_courier,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'courier_problem')                           AS b_courier_problem,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'label')                                     AS b_label,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'to_pack')                                   AS b_to_pack,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'returned')                                  AS b_returned,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'cancelled_after_sale')                      AS o_cancelled,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'trashed_after_sale')                        AS o_trashed,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'replacement')                               AS o_replacement,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'altercpa')                   AS src_altercpa,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'elyon_crm')                  AS src_elyon_crm,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'teleshop_out')               AS src_teleshop_out,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'teleshop_other')             AS src_teleshop_other,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'social')                     AS src_social,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'web')                        AS src_web,
         coalesce(sum(e.value_mkd) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total), 0)                        AS value_mkd,
         coalesce(sum(e.cod_mkd)   FILTER (WHERE e.k = 's' AND e.cur AND e.in_total), 0)                        AS cod_mkd,
         coalesce(sum(e.value_mkd) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'paid'), 0)                 AS paid_mkd,
         coalesce(sum(e.value_mkd) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'returned'), 0)             AS returned_mkd,
         coalesce(sum(e.value_mkd) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'cancelled_after_sale'), 0) AS cancelled_mkd,
         coalesce(sum(e.units)     FILTER (WHERE e.k = 's' AND e.cur AND e.in_total), 0)                        AS packages,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur)                                                            AS worked,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.outcome = 'sale')                                     AS sale_d,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.outcome = 'cancel')                                   AS cancel_d,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.outcome = 'trash')                                    AS trash_d,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.outcome = 'callback')                                 AS callback_d,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.via = 'crm')                                          AS via_crm,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.via = 'altercpa')                                     AS via_altercpa,
         count(*) FILTER (WHERE e.k = 'w' AND e.prev)                                                           AS prev_worked,
         count(*) FILTER (WHERE e.k = 'w' AND e.prev AND e.outcome = 'sale')                                    AS prev_sale_d,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.outcome = 'sale' AND e.pday)                          AS sale_d_tracked,
         min(e.first_at) FILTER (WHERE e.k = 'w' AND e.cur)                                                     AS first_decision_at,
         max(e.last_at)  FILTER (WHERE e.k = 'w' AND e.cur)                                                     AS last_decision_at,
         sum(e.online)   FILTER (WHERE e.k = 'p')                                                               AS online_min,
         sum(e.active)   FILTER (WHERE e.k = 'p')                                                               AS active_min,
         sum(e.idle)     FILTER (WHERE e.k = 'p')                                                               AS idle_min,
         sum(e.brk)      FILTER (WHERE e.k = 'p')                                                               AS break_min,
         sum(e.alerts)   FILTER (WHERE e.k = 'p')                                                               AS idle_alerts,
         count(*)        FILTER (WHERE e.k = 'p')                                                               AS presence_days,
         min(e.first_at) FILTER (WHERE e.k = 'p')                                                               AS first_active_at,
         max(e.last_at)  FILTER (WHERE e.k = 'p')                                                               AS last_active_at
  FROM ev e
  GROUP BY e.grp, e.person_id
),
ag AS MATERIALIZED (
  SELECT 0 AS g_grp, 0 AS g_person, a.grp, a.person_id,
         a.sales, a.sale_rows, a.booked, a.prev_sales, a.b_paid, a.b_paid_legacy, a.b_paid_unproven,
        a.b_courier, a.b_courier_problem, a.b_label, a.b_to_pack, a.b_returned, a.o_cancelled,
        a.o_trashed, a.o_replacement, a.src_altercpa, a.src_elyon_crm, a.src_teleshop_out, a.src_teleshop_other,
        a.src_social, a.src_web, a.value_mkd, a.cod_mkd, a.paid_mkd, a.returned_mkd, a.cancelled_mkd, a.packages,
        a.worked, a.sale_d, a.cancel_d, a.trash_d, a.callback_d, a.via_crm, a.via_altercpa,
        a.prev_worked, a.prev_sale_d, a.sale_d_tracked, a.first_decision_at, a.last_decision_at,
        a.online_min, a.active_min, a.idle_min, a.break_min, a.idle_alerts, a.presence_days,
        a.first_active_at, a.last_active_at
  FROM ag0 a
  UNION ALL
  SELECT 1 AS g_grp, 0 AS g_person, NULL::text AS grp, a.person_id AS person_id,
         sum(a.sales)::bigint AS sales,
         sum(a.sale_rows)::bigint AS sale_rows,
         sum(a.booked)::bigint AS booked,
         sum(a.prev_sales)::bigint AS prev_sales,
         sum(a.b_paid)::bigint AS b_paid,
         sum(a.b_paid_legacy)::bigint AS b_paid_legacy,
         sum(a.b_paid_unproven)::bigint AS b_paid_unproven,
         sum(a.b_courier)::bigint AS b_courier,
         sum(a.b_courier_problem)::bigint AS b_courier_problem,
         sum(a.b_label)::bigint AS b_label,
         sum(a.b_to_pack)::bigint AS b_to_pack,
         sum(a.b_returned)::bigint AS b_returned,
         sum(a.o_cancelled)::bigint AS o_cancelled,
         sum(a.o_trashed)::bigint AS o_trashed,
         sum(a.o_replacement)::bigint AS o_replacement,
         sum(a.src_altercpa)::bigint AS src_altercpa,
         sum(a.src_elyon_crm)::bigint AS src_elyon_crm,
         sum(a.src_teleshop_out)::bigint AS src_teleshop_out,
         sum(a.src_teleshop_other)::bigint AS src_teleshop_other,
         sum(a.src_social)::bigint AS src_social,
         sum(a.src_web)::bigint AS src_web,
         sum(a.value_mkd) AS value_mkd,
         sum(a.cod_mkd) AS cod_mkd,
         sum(a.paid_mkd) AS paid_mkd,
         sum(a.returned_mkd) AS returned_mkd,
         sum(a.cancelled_mkd) AS cancelled_mkd,
         sum(a.packages) AS packages,
         sum(a.worked)::bigint AS worked,
         sum(a.sale_d)::bigint AS sale_d,
         sum(a.cancel_d)::bigint AS cancel_d,
         sum(a.trash_d)::bigint AS trash_d,
         sum(a.callback_d)::bigint AS callback_d,
         sum(a.via_crm)::bigint AS via_crm,
         sum(a.via_altercpa)::bigint AS via_altercpa,
         sum(a.prev_worked)::bigint AS prev_worked,
         sum(a.prev_sale_d)::bigint AS prev_sale_d,
         sum(a.sale_d_tracked)::bigint AS sale_d_tracked,
         min(a.first_decision_at) AS first_decision_at,
         max(a.last_decision_at) AS last_decision_at,
         sum(a.online_min)::bigint AS online_min,
         sum(a.active_min)::bigint AS active_min,
         sum(a.idle_min)::bigint AS idle_min,
         sum(a.break_min)::bigint AS break_min,
         sum(a.idle_alerts)::bigint AS idle_alerts,
         sum(a.presence_days)::bigint AS presence_days,
         min(a.first_active_at) AS first_active_at,
         max(a.last_active_at) AS last_active_at
  FROM ag0 a
  GROUP BY a.person_id
  UNION ALL
  SELECT 0 AS g_grp, 1 AS g_person, a.grp AS grp, NULL::uuid AS person_id,
         sum(a.sales)::bigint AS sales,
         sum(a.sale_rows)::bigint AS sale_rows,
         sum(a.booked)::bigint AS booked,
         sum(a.prev_sales)::bigint AS prev_sales,
         sum(a.b_paid)::bigint AS b_paid,
         sum(a.b_paid_legacy)::bigint AS b_paid_legacy,
         sum(a.b_paid_unproven)::bigint AS b_paid_unproven,
         sum(a.b_courier)::bigint AS b_courier,
         sum(a.b_courier_problem)::bigint AS b_courier_problem,
         sum(a.b_label)::bigint AS b_label,
         sum(a.b_to_pack)::bigint AS b_to_pack,
         sum(a.b_returned)::bigint AS b_returned,
         sum(a.o_cancelled)::bigint AS o_cancelled,
         sum(a.o_trashed)::bigint AS o_trashed,
         sum(a.o_replacement)::bigint AS o_replacement,
         sum(a.src_altercpa)::bigint AS src_altercpa,
         sum(a.src_elyon_crm)::bigint AS src_elyon_crm,
         sum(a.src_teleshop_out)::bigint AS src_teleshop_out,
         sum(a.src_teleshop_other)::bigint AS src_teleshop_other,
         sum(a.src_social)::bigint AS src_social,
         sum(a.src_web)::bigint AS src_web,
         sum(a.value_mkd) AS value_mkd,
         sum(a.cod_mkd) AS cod_mkd,
         sum(a.paid_mkd) AS paid_mkd,
         sum(a.returned_mkd) AS returned_mkd,
         sum(a.cancelled_mkd) AS cancelled_mkd,
         sum(a.packages) AS packages,
         sum(a.worked)::bigint AS worked,
         sum(a.sale_d)::bigint AS sale_d,
         sum(a.cancel_d)::bigint AS cancel_d,
         sum(a.trash_d)::bigint AS trash_d,
         sum(a.callback_d)::bigint AS callback_d,
         sum(a.via_crm)::bigint AS via_crm,
         sum(a.via_altercpa)::bigint AS via_altercpa,
         sum(a.prev_worked)::bigint AS prev_worked,
         sum(a.prev_sale_d)::bigint AS prev_sale_d,
         sum(a.sale_d_tracked)::bigint AS sale_d_tracked,
         min(a.first_decision_at) AS first_decision_at,
         max(a.last_decision_at) AS last_decision_at,
         sum(a.online_min)::bigint AS online_min,
         sum(a.active_min)::bigint AS active_min,
         sum(a.idle_min)::bigint AS idle_min,
         sum(a.break_min)::bigint AS break_min,
         sum(a.idle_alerts)::bigint AS idle_alerts,
         sum(a.presence_days)::bigint AS presence_days,
         min(a.first_active_at) AS first_active_at,
         max(a.last_active_at) AS last_active_at
  FROM ag0 a
  GROUP BY a.grp
),
-- the same measures as one jsonb (people, team members and teams share it)
agj AS MATERIALIZED (
  SELECT a.g_grp, a.g_person, a.grp, a.person_id, a.sales, a.sale_rows, a.worked,
         jsonb_build_object(
           'sales',           a.sales,
           'booked',          a.booked,
           'value_mkd',       round(a.value_mkd),
           'cod_mkd',         round(a.cod_mkd),
           'paid_mkd',        round(a.paid_mkd),
           'returned_mkd',    round(a.returned_mkd),
           'cancelled_mkd',   round(a.cancelled_mkd),
           'packages',        a.packages,
           'buckets', jsonb_build_object(
              'paid', a.b_paid, 'paid_legacy', a.b_paid_legacy, 'paid_unproven', a.b_paid_unproven,
              'courier', a.b_courier, 'courier_problem', a.b_courier_problem, 'label', a.b_label,
              'to_pack', a.b_to_pack, 'returned', a.b_returned),
           'outside', jsonb_build_object(
              'cancelled_after_sale', a.o_cancelled, 'trashed_after_sale', a.o_trashed,
              'replacement', a.o_replacement),
           'by_source', jsonb_build_object(
              'altercpa', a.src_altercpa, 'elyon_crm', a.src_elyon_crm, 'teleshop_out', a.src_teleshop_out,
              'teleshop_other', a.src_teleshop_other, 'social', a.src_social, 'web', a.src_web),
           'worked',           a.worked,
           'sale_decisions',   a.sale_d,
           'cancel_decisions', a.cancel_d,
           'trash_decisions',  a.trash_d,
           'callback_decisions', a.callback_d,
           'via_crm',          a.via_crm,
           'via_altercpa',     a.via_altercpa,
           'conversion',       CASE WHEN a.worked > 0 THEN round(a.sale_d::numeric / a.worked, 4) END,
           'first_decision_at', a.first_decision_at,
           'last_decision_at', a.last_decision_at,
           'presence', CASE WHEN a.presence_days > 0 THEN jsonb_build_object(
              'days', a.presence_days, 'online_min', a.online_min, 'active_min', a.active_min,
              'idle_min', a.idle_min, 'break_min', a.break_min, 'idle_alerts', a.idle_alerts,
              'first_active_at', a.first_active_at, 'last_active_at', a.last_active_at,
              'sale_decisions', a.sale_d_tracked) END,
           'prev', CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE jsonb_build_object(
              'sales', a.prev_sales, 'worked', a.prev_worked, 'sale_decisions', a.prev_sale_d) END
         ) AS m
  FROM ag a
),
pid AS (SELECT DISTINCT a.person_id FROM ag a WHERE a.person_id IS NOT NULL),
pinfo AS (
  SELECT sp.id AS person_id, sp.display_name, sp.user_id, sp.is_active,
         (sp.is_manager OR EXISTS (SELECT 1 FROM public.user_roles r
                                    WHERE r.user_id = sp.user_id AND r.role::text IN ('admin', 'manager'))) AS is_manager,
         coalesce((SELECT jsonb_agg(DISTINCT i.kind) FROM public.sales_person_identities i WHERE i.person_id = sp.id),
                  '[]'::jsonb) AS kinds
  FROM public.sales_people sp
  WHERE sp.id IN (SELECT pid.person_id FROM pid)
),
-- the team a person's row is shown under: the primary membership on the
-- window's last elapsed day, else any membership in the window, else the
-- group most of their activity fell in
pt AS (
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, m.role, m.lane
  FROM public.sales_team_members m
  CROSS JOIN prm
  WHERE m.person_id IN (SELECT pid.person_id FROM pid)
    AND m.valid_from <= prm.td AND coalesce(m.valid_to, 'infinity'::date) >= prm.fd
  ORDER BY m.person_id, m.is_primary DESC,
           (least(prm.td, prm.today) BETWEEN m.valid_from AND coalesce(m.valid_to, 'infinity'::date)) DESC,
           m.valid_from DESC
),
pg AS (
  SELECT DISTINCT ON (a.person_id) a.person_id, a.grp
  FROM agj a
  WHERE a.g_grp = 0 AND a.g_person = 0
  ORDER BY a.person_id, (a.sales + a.worked) DESC, a.grp
),
pj AS (
  SELECT coalesce(jsonb_agg(a.m || jsonb_build_object(
           'person_id',      a.person_id,
           'name',           pi.display_name,
           'has_login',      pi.user_id IS NOT NULL,
           'is_manager',     pi.is_manager,
           'is_active',      pi.is_active,
           'identity_kinds', pi.kinds,
           'team_key',       coalesce(pt.team_key, pg.grp, 'none'),
           'team_role',      pt.role,
           'team_lane',      pt.lane,
           'team_kind',      (SELECT st.kind FROM public.sales_teams st WHERE st.key = coalesce(pt.team_key, pg.grp)),
           'online_state',   CASE WHEN pi.user_id IS NULL THEN 'n/a' ELSE coalesce(pn.st, 'offline') END,
           'groups',         (SELECT jsonb_agg(x.grp ORDER BY x.grp) FROM agj x
                               WHERE x.g_grp = 0 AND x.g_person = 0 AND x.person_id = a.person_id))
         ORDER BY a.sales DESC, a.worked DESC, pi.display_name), '[]'::jsonb) AS j
  FROM agj a
  JOIN pinfo pi ON pi.person_id = a.person_id
  LEFT JOIN pt ON pt.person_id = a.person_id
  LEFT JOIN pg ON pg.person_id = a.person_id
  LEFT JOIN pn ON pn.user_id = pi.user_id
  WHERE a.g_grp = 1 AND a.g_person = 0
    AND ($7::uuid IS NULL OR a.person_id = $7::uuid)
),
-- GET /orders?team_key=T lists the sales of T's PRIMARY members over the
-- window (index.ts): exact only when that is this group's sales, row for row
rost AS (
  SELECT DISTINCT m.team_key, m.person_id
  FROM public.sales_team_members m
  CROSS JOIN prm
  WHERE m.is_primary AND m.valid_from <= prm.td AND coalesce(m.valid_to, 'infinity'::date) >= prm.fd
),
tdx AS (
  SELECT r.team_key, count(*) AS n_link
  FROM rost r
  JOIN sr s ON s.person_id = r.person_id AND s.cur AND s.kind = 'order'
  GROUP BY r.team_key
),
sk AS (
  SELECT to_char(g, prm.sfmt) AS b
  FROM prm, generate_series(date_trunc(prm.gran, prm.fd::timestamp), date_trunc(prm.gran, prm.td::timestamp),
                            ('1 ' || prm.gran)::interval) g
),
tsp AS MATERIALIZED (
  SELECT e.grp, to_char(date_trunc(prm.gran, e.d::timestamp), prm.sfmt) AS b,
         count(*) FILTER (WHERE e.k = 's' AND e.in_total)          AS sales,
         count(*) FILTER (WHERE e.k = 'w' AND e.outcome = 'sale')  AS sale_d,
         count(*) FILTER (WHERE e.k = 'w')                         AS worked
  FROM ev e CROSS JOIN prm
  WHERE e.cur AND e.k IN ('s', 'w') AND e.d IS NOT NULL
  GROUP BY 1, 2
),
tl AS (
  SELECT DISTINCT ON (m.person_id, m.team_key) m.person_id, m.team_key, m.lane
  FROM public.sales_team_members m
  CROSS JOIN prm
  WHERE m.valid_from <= prm.td AND coalesce(m.valid_to, 'infinity'::date) >= prm.fd
  ORDER BY m.person_id, m.team_key, m.is_primary DESC, m.valid_from DESC
),
tj AS (
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.ord, x.key), '[]'::jsonb) AS j
  FROM (
    SELECT g.grp AS key,
           -- sales_teams.sort_order (teleshop 10 · affiliate 20 · legacy 40/41 · management 90), then
           -- the groups outside a team
           coalesce(st.sort_order, CASE g.grp WHEN 'teleshop_unassigned' THEN 60 WHEN 'social_unassigned' THEN 61
                                              WHEN 'none' THEN 99 ELSE 70 END) AS ord,
           g.m || jsonb_build_object(
             'key',   g.grp,
             'name',  st.name,
             'mode',  st.leaderboard_mode,
             -- a key in sales_teams is a TEAM (never a pseudo-group, 20260943000950)
             'kind',  CASE WHEN st.key IS NOT NULL THEN 'team' ELSE g.grp END,
             'team_kind', st.kind,
             'sort_order', st.sort_order,
             'lanes', (SELECT jsonb_build_object(
                         'in',     count(*) FILTER (WHERE tl.lane = 'in'),
                         'out',    count(*) FILTER (WHERE tl.lane = 'out'),
                         'social', count(*) FILTER (WHERE tl.lane = 'social'),
                         'none',   count(*) FILTER (WHERE tl.lane IS NULL))
                         FROM agj x
                         LEFT JOIN tl ON tl.person_id = x.person_id AND tl.team_key = x.grp
                        WHERE x.g_grp = 0 AND x.g_person = 0 AND x.grp = g.grp),
             'people', (SELECT count(*) FROM agj x WHERE x.g_grp = 0 AND x.g_person = 0 AND x.grp = g.grp),
             'online_now', (SELECT count(*) FROM agj x
                              JOIN public.sales_people sp ON sp.id = x.person_id
                              JOIN pn ON pn.user_id = sp.user_id
                             WHERE x.g_grp = 0 AND x.g_person = 0 AND x.grp = g.grp AND pn.st IN ('online', 'idle')),
             'break_now', (SELECT count(*) FROM agj x
                             JOIN public.sales_people sp ON sp.id = x.person_id
                             JOIN pn ON pn.user_id = sp.user_id
                            WHERE x.g_grp = 0 AND x.g_person = 0 AND x.grp = g.grp AND pn.st = 'break'),
             'drill_exact', st.key IS NOT NULL AND coalesce(tdx.n_link, 0) = g.sale_rows,
             'members', coalesce((SELECT jsonb_agg(x.m || jsonb_build_object('person_id', x.person_id,
                                                                    'lane', (SELECT tl.lane FROM tl
                                                                              WHERE tl.person_id = x.person_id
                                                                                AND tl.team_key = x.grp))
                                                    ORDER BY x.sales DESC, x.worked DESC, x.person_id)
                                    FROM agj x WHERE x.g_grp = 0 AND x.g_person = 0 AND x.grp = g.grp), '[]'::jsonb),
             'spark', (SELECT jsonb_agg(jsonb_build_object('d', sk.b, 'sales', coalesce(p.sales, 0),
                                                           'sale_decisions', coalesce(p.sale_d, 0),
                                                           'worked', coalesce(p.worked, 0)) ORDER BY sk.b)
                         FROM sk LEFT JOIN tsp p ON p.grp = g.grp AND p.b = sk.b)
           ) AS j
    FROM agj g
    LEFT JOIN public.sales_teams st ON st.key = g.grp
    LEFT JOIN tdx ON tdx.team_key = g.grp
    WHERE g.g_grp = 0 AND g.g_person = 1
  ) x
),
-- sales with no seller: why, per source (Σ people + this = the cohort total)
np AS MATERIALIZED (
  SELECT s.kind, s.source, s.split, s.bucket, s.value_mkd, s.cod_mkd, s.order_id,
         s.sold_at, s.sold_by_ext, s.sold_via, s.display_id
  FROM sr s
  WHERE s.cur AND s.in_total AND s.person_id IS NULL
),
-- the AlterCPA ledger's latest word on each unattributed ORDER (an index
-- probe per order; web / MEX-only rows need none)
nsr AS MATERIALIZED (
  SELECT np.kind, np.source, np.split, np.bucket, np.value_mkd, np.cod_mkd,
         np.sold_by_ext, np.sold_via, ld.decided_by_altercpa_user, ld.account_id,
         CASE WHEN np.sold_by_ext IS NOT NULL THEN 'unmapped'
              WHEN np.sold_at IS NULL AND ld.decision IN ('approved', 'cancel_other') THEN 'awaiting_stamp'
              WHEN np.sold_at IS NULL AND ld.decision IN ('cancelled', 'trashed') THEN 'altercpa_cancelled'
              ELSE 'no_decider' END AS reason,
         CASE WHEN np.sold_by_ext IS NOT NULL THEN coalesce(np.sold_via, 'other') END AS detail
  FROM np
  LEFT JOIN LATERAL (
    SELECT l.decision, l.decided_by_altercpa_user, l.account_id
    FROM public.altercpa_leads l
    WHERE np.sold_by_ext IS NULL AND l.order_id = np.order_id
    ORDER BY l.decided_at DESC NULLS LAST, l.id
    LIMIT 1) ld ON true
  WHERE np.kind = 'order'
  UNION ALL
  SELECT np.kind, np.source, np.split, np.bucket, np.value_mkd, np.cod_mkd,
         -- a collabBox booking nobody is credited with: its author is a handle
         -- no person holds yet (20260942001900)
         CASE WHEN np.kind = 'booking' THEN
           (SELECT d.author FROM public.collabbox_documents d WHERE d.doc_number = np.display_id) END,
         CASE WHEN np.kind = 'booking' THEN 'collabbox' END,
         NULL, NULL,
         CASE WHEN np.kind = 'web' THEN 'web_shop' WHEN np.kind = 'booking' THEN 'unmapped' ELSE 'mex_only' END,
         CASE WHEN np.kind = 'booking' THEN 'collabbox' ELSE np.split END
  FROM np
  WHERE np.kind <> 'order'
),
nsj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'reason', x.reason, 'source', x.source, 'detail', x.detail,
           'count', x.n, 'value_mkd', round(x.v), 'cod_mkd', round(x.c),
           'buckets', jsonb_build_object(
              'paid', x.paid, 'paid_legacy', x.paid_legacy, 'paid_unproven', x.paid_unproven,
              'courier', x.courier, 'courier_problem', x.courier_problem, 'label', x.label,
              'to_pack', x.to_pack, 'returned', x.returned))
         ORDER BY CASE x.source WHEN 'altercpa' THEN 1 WHEN 'elyon_crm' THEN 2 WHEN 'teleshop_out' THEN 3
                           WHEN 'teleshop_other' THEN 4 WHEN 'social' THEN 5 WHEN 'web' THEN 6 ELSE 7 END,
                  x.n DESC, x.reason, x.detail), '[]'::jsonb) AS j
  FROM (
    SELECT n.reason, n.source, n.detail, count(*) AS n,
           coalesce(sum(n.value_mkd), 0) AS v, coalesce(sum(n.cod_mkd), 0) AS c,
           count(*) FILTER (WHERE n.bucket = 'paid')            AS paid,
           count(*) FILTER (WHERE n.bucket = 'paid_legacy')     AS paid_legacy,
           count(*) FILTER (WHERE n.bucket = 'paid_unproven')   AS paid_unproven,
           count(*) FILTER (WHERE n.bucket = 'courier')         AS courier,
           count(*) FILTER (WHERE n.bucket = 'courier_problem') AS courier_problem,
           count(*) FILTER (WHERE n.bucket = 'label')           AS label,
           count(*) FILTER (WHERE n.bucket = 'to_pack')         AS to_pack,
           count(*) FILTER (WHERE n.bucket = 'returned')        AS returned
    FROM nsr n
    GROUP BY 1, 2, 3
  ) x
),
-- the handles nobody has named yet (Settings → Teams → unmapped)
hnd AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('via', x.via, 'handle', x.handle, 'count', x.n,
                                               'value_mkd', round(x.v)) ORDER BY x.n DESC, x.handle), '[]'::jsonb) AS j
  FROM (SELECT n.sold_via AS via, n.sold_by_ext AS handle, count(*) AS n, coalesce(sum(n.value_mkd), 0) AS v
          FROM nsr n WHERE n.reason = 'unmapped'
         GROUP BY 1, 2 ORDER BY 3 DESC, 2 LIMIT 25) x
),
-- whose AlterCPA decision (cancel / trash) MEX overruled by delivering anyway
cby AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('person_id', x.person_id, 'name', sp.display_name,
                                               'altercpa_user', x.ext, 'count', x.n, 'value_mkd', round(x.v))
                            ORDER BY x.n DESC, x.ext), '[]'::jsonb) AS j
  FROM (SELECT i.person_id, n.decided_by_altercpa_user AS ext, count(*) AS n, coalesce(sum(n.value_mkd), 0) AS v
          FROM nsr n
          LEFT JOIN public.sales_person_identities i
                 ON i.kind = 'altercpa_user' AND i.account_id = n.account_id
                AND i.value = n.decided_by_altercpa_user::text
         WHERE n.reason = 'altercpa_cancelled'
         GROUP BY 1, 2 ORDER BY 3 DESC, 2 LIMIT 12) x
  LEFT JOIN public.sales_people sp ON sp.id = x.person_id
),
-- decisions the ledger could not put on a person
uwj AS (
  SELECT (SELECT count(*) FROM vw WHERE vw.cur AND vw.person_id IS NULL) AS n,
         coalesce(jsonb_agg(jsonb_build_object('via', x.via, 'actor', coalesce(pf.full_name, x.actor_ext), 'count', x.n)
                            ORDER BY x.n DESC, x.actor_ext), '[]'::jsonb) AS j
  FROM (SELECT v.via, v.actor_ext, count(*) AS n FROM vw v
         WHERE v.cur AND v.person_id IS NULL GROUP BY 1, 2 ORDER BY 3 DESC, 2 LIMIT 20) x
  LEFT JOIN public.profiles pf ON pf.user_id::text = x.actor_ext
),
tot AS (
  SELECT count(*) FILTER (WHERE s.cur AND s.in_total)                                   AS sales,
         count(*) FILTER (WHERE s.cur AND s.in_total AND s.person_id IS NOT NULL)       AS with_person,
         count(*) FILTER (WHERE s.cur AND s.in_total AND s.kind = 'booking')            AS booked,
         coalesce(sum(s.value_mkd) FILTER (WHERE s.cur AND s.in_total), 0)              AS value_mkd,
         coalesce(sum(s.value_mkd) FILTER (WHERE s.cur AND s.in_total AND s.person_id IS NOT NULL), 0) AS with_person_mkd,
         coalesce(sum(s.cod_mkd)   FILTER (WHERE s.cur AND s.in_total), 0)              AS cod_mkd,
         coalesce(sum(s.value_mkd) FILTER (WHERE s.cur AND s.bucket = 'paid'), 0)       AS paid_mkd,
         count(*) FILTER (WHERE s.prev AND s.in_total)                                  AS prev_sales,
         count(*) FILTER (WHERE s.prev AND s.in_total AND s.person_id IS NOT NULL)      AS prev_with_person
  FROM sr s
),
tsrc AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', x.source, 'sales', x.n, 'with_person', x.wp,
           'value_mkd', round(x.v), 'with_person_mkd', round(x.wv)) ORDER BY x.ord), '[]'::jsonb) AS j
  FROM (SELECT s0.key AS source, s0.ord,
               count(s.source) AS n, count(s.person_id) AS wp,
               coalesce(sum(s.value_mkd), 0) AS v,
               coalesce(sum(s.value_mkd) FILTER (WHERE s.person_id IS NOT NULL), 0) AS wv
          FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('teleshop_out', 3), ('teleshop_other', 4),
                       ('social', 5), ('web', 6)) s0(key, ord)
          LEFT JOIN sr s ON s.source = s0.key AND s.cur AND s.in_total
         GROUP BY 1, 2) x
),
twk AS (
  SELECT count(*) FILTER (WHERE v.cur)                               AS worked,
         count(*) FILTER (WHERE v.cur AND v.outcome = 'sale')        AS sale_d,
         count(*) FILTER (WHERE v.cur AND v.outcome = 'cancel')      AS cancel_d,
         count(*) FILTER (WHERE v.cur AND v.outcome = 'trash')       AS trash_d,
         count(*) FILTER (WHERE v.cur AND v.outcome = 'callback')    AS callback_d,
         count(*) FILTER (WHERE v.cur AND v.person_id IS NULL)       AS unmapped,
         count(*) FILTER (WHERE v.prev)                              AS prev_worked,
         count(*) FILTER (WHERE v.prev AND v.outcome = 'sale')       AS prev_sale_d
  FROM vw v
),
bsp AS (
  SELECT to_char(date_trunc(prm.gran, s.sale_day::timestamp), prm.sfmt) AS b,
         count(*) AS sales, count(s.person_id) AS with_person, coalesce(sum(s.value_mkd), 0) AS v
  FROM sr s CROSS JOIN prm
  WHERE s.cur AND s.in_total
  GROUP BY 1
),
wsp AS (
  SELECT to_char(date_trunc(prm.gran, v.d::timestamp), prm.sfmt) AS b,
         count(*) AS worked, count(*) FILTER (WHERE v.outcome = 'sale') AS sale_d
  FROM vw v CROSS JOIN prm
  WHERE v.cur
  GROUP BY 1
),
spj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'd', sk.b, 'sales', coalesce(b.sales, 0), 'with_person', coalesce(b.with_person, 0),
           'value_mkd', round(coalesce(b.v, 0)), 'worked', coalesce(w.worked, 0),
           'sale_decisions', coalesce(w.sale_d, 0)) ORDER BY sk.b), '[]'::jsonb) AS j
  FROM sk
  LEFT JOIN bsp b ON b.b = sk.b
  LEFT JOIN wsp w ON w.b = sk.b
),
-- ── one person, in depth (only when p_person is given) ─────────────────────
dday AS (
  SELECT sk.b,
         count(*) FILTER (WHERE x.k = 's' AND x.in_total)            AS sales,
         coalesce(sum(x.value_mkd) FILTER (WHERE x.k = 's' AND x.in_total), 0) AS v,
         count(*) FILTER (WHERE x.k = 's' AND x.bucket = 'paid')     AS paid,
         count(*) FILTER (WHERE x.k = 's' AND x.bucket = 'returned') AS returned,
         count(*) FILTER (WHERE x.k = 'w')                           AS worked,
         count(*) FILTER (WHERE x.k = 'w' AND x.outcome = 'sale')    AS sale_d,
         count(*) FILTER (WHERE x.k = 'w' AND x.outcome = 'cancel')  AS cancel_d,
         count(*) FILTER (WHERE x.k = 'w' AND x.outcome = 'trash')   AS trash_d,
         count(*) FILTER (WHERE x.k = 'w' AND x.outcome = 'callback') AS callback_d,
         sum(x.online) FILTER (WHERE x.k = 'p')                      AS online_min,
         sum(x.active) FILTER (WHERE x.k = 'p')                      AS active_min
  FROM sk
  LEFT JOIN (SELECT to_char(date_trunc(prm.gran, e.d::timestamp), prm.sfmt) AS b, e.*
               FROM ev e CROSS JOIN prm
              WHERE $7::uuid IS NOT NULL AND e.person_id = $7::uuid AND e.cur AND e.k <> 'r') x ON x.b = sk.b
  WHERE $7::uuid IS NOT NULL
  GROUP BY sk.b
),
dj AS (
  SELECT CASE WHEN $7::uuid IS NULL THEN NULL ELSE jsonb_build_object(
    'person_id', $7::uuid,
    'days', (SELECT coalesce(jsonb_agg(jsonb_build_object(
               'd', d.b, 'sales', d.sales, 'value_mkd', round(d.v), 'paid', d.paid, 'returned', d.returned,
               'worked', d.worked, 'sale_decisions', d.sale_d, 'cancel_decisions', d.cancel_d,
               'trash_decisions', d.trash_d, 'callback_decisions', d.callback_d,
               'online_min', d.online_min, 'active_min', d.active_min) ORDER BY d.b), '[]'::jsonb) FROM dday d),
    'products', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'count', p.n, 'value_mkd', round(p.v))
                                           ORDER BY p.n DESC, p.name), '[]'::jsonb)
                   FROM (SELECT coalesce(nullif(btrim(x.product_name), ''), '__unknown__') AS name,
                                count(*) AS n, coalesce(sum(s.value_mkd), 0) AS v
                           FROM sr s JOIN public.orders x ON x.id = s.order_id
                          WHERE s.cur AND s.in_total AND s.person_id = $7::uuid
                          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10) p),
    'identities', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'value', i.value)
                                             ORDER BY i.kind, i.value), '[]'::jsonb)
                     FROM public.sales_person_identities i WHERE i.person_id = $7::uuid),
    'memberships', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                       'team_key', m.team_key, 'name', st.name, 'from', m.valid_from, 'to', m.valid_to,
                       'role', m.role, 'primary', m.is_primary, 'lane', m.lane, 'kind', st.kind)
                       ORDER BY m.valid_from DESC), '[]'::jsonb)
                      FROM public.sales_team_members m
                      LEFT JOIN public.sales_teams st ON st.key = m.team_key
                     WHERE m.person_id = $7::uuid)) END AS j
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'from',           to_char(prm.fd, 'YYYY-MM-DD'),
    'to',             to_char(prm.td, 'YYYY-MM-DD'),
    'granularity',    prm.gran,
    'clock',          'sale',
    'presence_since', $12::text,
    'stamped_at',     $13::timestamptz,
    'person',         $7::uuid),
  'totals', (SELECT jsonb_build_object(
    'sales',           t.sales,
    'value_mkd',       round(t.value_mkd),
    'cod_mkd',         round(t.cod_mkd),
    'paid_mkd',        round(t.paid_mkd),
    'with_person',     t.with_person,
    'booked',          t.booked,
    'with_person_mkd', round(t.with_person_mkd),
    'without_person',  t.sales - t.with_person,
    'without_person_mkd', round(t.value_mkd - t.with_person_mkd),
    'by_source',       (SELECT j FROM tsrc),
    'worked',          w.worked,
    'sale_decisions',  w.sale_d,
    'cancel_decisions', w.cancel_d,
    'trash_decisions', w.trash_d,
    'callback_decisions', w.callback_d,
    'unmapped_decisions', w.unmapped,
    'conversion',      CASE WHEN w.worked > 0 THEN round(w.sale_d::numeric / w.worked, 4) END,
    'prev', CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE jsonb_build_object(
       'sales', t.prev_sales, 'with_person', t.prev_with_person,
       'worked', w.prev_worked, 'sale_decisions', w.prev_sale_d) END)
    FROM tot t CROSS JOIN twk w),
  'teams',        (SELECT j FROM tj),
  'people',       (SELECT j FROM pj),
  'no_seller', (SELECT jsonb_build_object(
    'count',     (SELECT count(*) FROM nsr),
    'value_mkd', (SELECT round(coalesce(sum(nsr.value_mkd), 0)) FROM nsr),
    'reasons',   (SELECT j FROM nsj),
    'handles',   (SELECT j FROM hnd),
    'cancelled_by', (SELECT j FROM cby))),
  'unmapped_work', (SELECT jsonb_build_object('count', u.n, 'actors', u.j) FROM uwj u),
  'spark',        (SELECT j FROM spj),
  'detail',       (SELECT j FROM dj))
FROM prm

$pp$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_fd, v_td, p_person, v_lo,
        (now() AT TIME ZONE 'Europe/Skopje')::date, v_gran, public.report_excluded_phone8s(),
        v_presence, v_stamped;

  RETURN v_out;
END;
$function$;

-- ── 2. leaderboard_day_v2 ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.leaderboard_day_v2(p_day date, p_department text DEFAULT NULL::text, p_team text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET jit TO 'off'
AS $function$
DECLARE
  v_day   date := coalesce(p_day, (now() AT TIME ZONE 'Europe/Skopje')::date);
  v_today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_dept  text := nullif(btrim(coalesce(p_department, '')), '');
  v_team  text := nullif(btrim(coalesce(p_team, '')), '');
  v_tkey  text;
  v_tlane text;
  v_from  timestamptz;
  v_to    timestamptz;
  v_out   jsonb;
BEGIN
  IF v_dept IS NOT NULL
     AND v_dept NOT IN ('altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web') THEN
    RAISE EXCEPTION 'leaderboard_day_v2: unknown department %', v_dept USING ERRCODE = '22023';
  END IF;
  -- p_team: a team key · 'team:lane' (a line's lane: in | out | social) · 'none' · the legacy
  -- aliases altercpa_leads / crm_prediction (sales_team_filter_matches, 20260943000950 — old TV
  -- links keep working after the teams became business lines)
  IF v_team IS NOT NULL AND v_team <> 'none' THEN
    v_tkey  := split_part(v_team, ':', 1);
    v_tlane := nullif(split_part(v_team, ':', 2), '');
    IF v_team LIKE '%:%:%' OR (v_team LIKE '%:%' AND v_tlane IS NULL)
       OR (v_tlane IS NOT NULL AND v_tlane NOT IN ('in', 'out', 'social'))
       OR NOT EXISTS (SELECT 1 FROM public.sales_teams t WHERE t.key = v_tkey)
       OR (v_tlane IS NOT NULL AND EXISTS (SELECT 1 FROM public.sales_teams t
                                            WHERE t.key = v_tkey AND t.kind <> 'line')) THEN
      RAISE EXCEPTION 'leaderboard_day_v2: unknown team %', v_team USING ERRCODE = '22023';
    END IF;
  END IF;
  -- Skopje 00:00 of the day and the last microsecond before the next one
  -- (DST-exact: the timestamp is read as Europe/Skopje wall-clock time).
  v_from := v_day::timestamp AT TIME ZONE 'Europe/Skopje';
  v_to   := ((v_day + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond';

  -- $1 from · $2 to_end · $3 day · $4 department · $5 team · $6 is today ·
  -- $7 the test phones' last-8 digits. Every use carries its cast, so
  -- scripts/verify-leaderboard-v2.mjs can run this body inline, read-only.
  EXECUTE $lb2$
WITH
-- ── the owner's test phones: in no report (orders holding one, or its parcel) ─
xtp AS MATERIALIZED (
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($7::text[])
),
xto AS MATERIALIZED (
  SELECT x.id FROM public.orders x
   WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ($7::text[])
  UNION
  SELECT x.id FROM public.orders x JOIN xtp ON xtp.tr = x.mex_tracking_id
),

-- ── 1. the work ledger of the day: every human decision, CRM + AlterCPA ────
-- dept = the decided order's department (THE mapping); an AlterCPA decision on
-- a lead with no order is Affiliate – Lead in.
vw AS MATERIALIZED (
  SELECT v.at, v.person_id, v.order_id, v.outcome,
         CASE WHEN o.id IS NOT NULL
              THEN public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)
              WHEN v.via = 'altercpa' THEN 'altercpa' END AS dept,
         (o.id IS NOT NULL AND o.sale_source IS NULL) AS unclassified
  FROM public.v_sales_work v
  LEFT JOIN public.orders o ON o.id = v.order_id
  WHERE v.at BETWEEN $1::timestamptz AND $2::timestamptz
    AND (v.order_id IS NULL OR v.order_id NOT IN (SELECT xto.id FROM xto))
),
wk AS (
  SELECT vw.person_id,
         count(*)                                         AS worked,
         count(*) FILTER (WHERE vw.outcome = 'sale')      AS sale_d,
         count(*) FILTER (WHERE vw.outcome = 'cancel')    AS cancel_d,
         count(*) FILTER (WHERE vw.outcome = 'trash')     AS trash_d,
         count(*) FILTER (WHERE vw.outcome = 'callback')  AS callback_d,
         max(vw.at)                                       AS last_at
  FROM vw WHERE vw.person_id IS NOT NULL GROUP BY 1
),

-- ── 2. THE sale cohort of the day (insights_sale_rows — read, never copied) ─
sr AS MATERIALIZED (
  SELECT r.kind, r.source AS dept, r.sale_source, r.bucket, r.in_total, r.value_mkd, r.order_id,
         r.person_id, r.display_id
  FROM public.insights_sale_rows($1::timestamptz, $2::timestamptz, false) r
),
-- the ORDER sales of the day (+ the ones cancelled / trashed since) and who is
-- credited: the stamp; unstamped → the order's first 'sale' decision of the day
-- that names a person (leaderboard_day's live rule). Stamp or ledger, never both.
so AS MATERIALIZED (
  SELECT s.dept, s.sale_source, s.bucket, s.in_total, s.value_mkd, s.order_id,
         o.sold_at, o.sold_by_ext,
         CASE WHEN o.sold_at IS NOT NULL THEN o.sold_by_person_id
              ELSE (SELECT w.person_id FROM vw w
                     WHERE w.order_id = s.order_id AND w.outcome = 'sale' AND w.person_id IS NOT NULL
                     ORDER BY w.at LIMIT 1) END AS pid,
         (o.sold_at IS NULL) AS unstamped
  FROM sr s
  JOIN public.orders o ON o.id = s.order_id
  WHERE s.kind = 'order'
    AND (s.in_total OR s.bucket IN ('cancelled_after_sale', 'trashed_after_sale'))
),
-- why a sale has no seller (insights_people's reasons, 20260941000200)
nsr AS (
  SELECT so.dept, so.value_mkd,
         CASE WHEN so.sold_by_ext IS NOT NULL THEN 'unmapped'
              WHEN so.sold_at IS NULL AND ld.decision IN ('approved', 'cancel_other') THEN 'awaiting_stamp'
              WHEN so.sold_at IS NULL AND ld.decision IN ('cancelled', 'trashed') THEN 'altercpa_cancelled'
              ELSE 'no_decider' END AS reason
  FROM so
  LEFT JOIN LATERAL (
    SELECT l.decision FROM public.altercpa_leads l
     WHERE so.sold_by_ext IS NULL AND l.order_id = so.order_id
     ORDER BY l.decided_at DESC NULLS LAST, l.id
     LIMIT 1) ld ON true
  WHERE so.in_total AND so.pid IS NULL
),

-- ── 3. collabBox bookings (20260942001900): THE cohort's booking rows ──────
-- A document booked in collabBox whose parcel does not exist yet is a sale of
-- the day in the cohort (insights_sale_rows kind 'booking': its folder's
-- department, its author, "to pack") — counted ONCE, from those rows. The
-- day's other collabBox documents no order holds yet (collabbox_booked_today's
-- filter, one document at a time) are shown apart, never counted: the copy of
-- a CRM / AlterCPA sale, a 10111 LEADS document (the shipping document of an
-- AlterCPA sale), a document whose parcel already exists (the parcel counts),
-- … day_totals.checks.bookings_filter_drift = 0 proves the two copies of
-- collabbox_booked_today's filter agree.
bka AS (
  SELECT b.person_id, b.doc_type, sum(b.docs)::bigint AS docs, coalesce(sum(b.value_mkd), 0) AS value_mkd
  FROM public.collabbox_booked_today($3::date) b
  GROUP BY 1, 2
),
bkd AS MATERIALIZED (
  SELECT b.doc_number, b.doc_type_id, b.author_person_id, b.amount_mkd, b.doc_at, b.komitent_id
  FROM public.collabbox_documents b
  WHERE b.doc_at BETWEEN $1::timestamptz AND $2::timestamptz
    AND b.outcome IN ('booked', 'awaiting_parcel')
    AND b.vanished_at IS NULL
    AND NOT b.is_storno
    AND b.amount_mkd > 0
    AND b.doc_type_id IN ('10036', '10050', '10111', '10114', '10106')
    AND NOT EXISTS (SELECT 1 FROM public.orders o
                     WHERE o.external_source = 'collabbox' AND o.external_order_id = b.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.mex_tracking_id = b.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.mex_parcels p
                     WHERE p.tracking_id = b.doc_number AND p.order_id IS NOT NULL)
),
-- counted (booked: the cohort's rows) vs not counted (booked_twin: the rest),
-- per person × department
bkc AS (
  SELECT x.person_id, x.dept, bool_or(x.no_dept) AS no_dept,
         sum(x.booked) AS booked, sum(x.booked_mkd) AS booked_mkd,
         sum(x.twin) AS twin, sum(x.twin_mkd) AS twin_mkd, sum(x.twin_by_role) AS twin_by_role
  FROM (
    SELECT s.person_id, s.dept, false AS no_dept,
           1 AS booked, s.value_mkd AS booked_mkd, 0 AS twin, 0::numeric AS twin_mkd, 0 AS twin_by_role
    FROM sr s
    WHERE s.kind = 'booking'
    UNION ALL
    SELECT d.author_person_id, public.cohort_order_source(dp.d[1], dp.d[2], d.doc_number), (dp.d IS NULL),
           0, 0::numeric, 1, d.amount_mkd,
           CASE WHEN public.collabbox_doc_role(d.doc_type_id) = 'credit' THEN 1 ELSE 0 END
    FROM bkd d
    CROSS JOIN LATERAL (SELECT public.collabbox_department(d.doc_type_id, d.doc_number, d.author_person_id, d.doc_at) AS d) dp
    WHERE d.doc_number NOT IN (SELECT s.display_id FROM sr s WHERE s.kind = 'booking')
  ) x
  GROUP BY 1, 2
),

-- ── 4. person × department ─────────────────────────────────────────────────
pd AS MATERIALIZED (
  SELECT x.person_id, x.dept,
         sum(x.sales) AS sales, sum(x.value_mkd) AS value_mkd, sum(x.returned) AS returned,
         sum(x.cas) AS cas, sum(x.cas_mkd) AS cas_mkd, sum(x.live) AS live,
         sum(x.booked) AS booked, sum(x.booked_mkd) AS booked_mkd,
         sum(x.twin) AS twin, sum(x.twin_mkd) AS twin_mkd,
         sum(x.worked) AS worked, sum(x.sale_d) AS sale_d
  FROM (
    SELECT so.pid AS person_id, so.dept,
           CASE WHEN so.in_total THEN 1 ELSE 0 END AS sales,
           CASE WHEN so.in_total THEN so.value_mkd ELSE 0 END AS value_mkd,
           CASE WHEN so.in_total AND so.bucket = 'returned' THEN 1 ELSE 0 END AS returned,
           CASE WHEN so.in_total THEN 0 ELSE 1 END AS cas,
           CASE WHEN so.in_total THEN 0 ELSE so.value_mkd END AS cas_mkd,
           CASE WHEN so.in_total AND so.unstamped THEN 1 ELSE 0 END AS live,
           0 AS booked, 0 AS booked_mkd, 0 AS twin, 0 AS twin_mkd, 0 AS worked, 0 AS sale_d
      FROM so WHERE so.pid IS NOT NULL
    UNION ALL
    SELECT bkc.person_id, bkc.dept, 0, 0, 0, 0, 0, 0,
           bkc.booked, bkc.booked_mkd, bkc.twin, bkc.twin_mkd, 0, 0
      FROM bkc WHERE bkc.person_id IS NOT NULL
    UNION ALL
    SELECT vw.person_id, vw.dept, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
           1, CASE WHEN vw.outcome = 'sale' THEN 1 ELSE 0 END
      FROM vw WHERE vw.person_id IS NOT NULL AND vw.dept IS NOT NULL
  ) x
  GROUP BY 1, 2
),
-- a person's numbers: all departments (a) and the filter's department (f)
pa AS (
  SELECT pd.person_id,
         sum(pd.sales) AS sales, sum(pd.value_mkd) AS value_mkd, sum(pd.returned) AS returned,
         sum(pd.cas) AS cas, sum(pd.cas_mkd) AS cas_mkd, sum(pd.live) AS live,
         sum(pd.booked) AS booked, sum(pd.booked_mkd) AS booked_mkd,
         sum(pd.twin) AS twin, sum(pd.twin_mkd) AS twin_mkd,
         sum(pd.worked) AS worked,
         jsonb_object_agg(pd.dept, jsonb_build_object(
           'sales', pd.sales, 'value_mkd', round(pd.value_mkd),
           'booked', pd.booked, 'booked_value_mkd', round(pd.booked_mkd),
           'booked_twin', pd.twin, 'booked_twin_value_mkd', round(pd.twin_mkd),
           'cancelled_after_sale', pd.cas, 'cancelled_value_mkd', round(pd.cas_mkd),
           'returned', pd.returned, 'live_credited', pd.live,
           'worked', pd.worked, 'sale_decisions', pd.sale_d)) AS depts
  FROM pd
  WHERE pd.dept IS NOT NULL                       -- jsonb_object_agg refuses a NULL key
    AND ($4::text IS NULL OR pd.dept = $4::text)
  GROUP BY 1
),

-- ── 5. who is on the board ─────────────────────────────────────────────────
mem AS (
  SELECT DISTINCT m.person_id
  FROM public.sales_team_members m
  JOIN public.sales_people sp ON sp.id = m.person_id
  WHERE m.valid_from <= $3::date AND coalesce(m.valid_to, 'infinity'::date) >= $3::date
    AND (sp.is_active OR m.valid_to IS NOT NULL)
),
pteam AS (
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, st.name AS team_name,
         m.lane AS team_lane, st.kind AS team_kind, st.sort_order AS team_sort
  FROM public.sales_team_members m
  JOIN public.sales_teams st ON st.key = m.team_key
  WHERE m.valid_from <= $3::date AND coalesce(m.valid_to, 'infinity'::date) >= $3::date
  ORDER BY m.person_id, m.is_primary DESC, m.valid_from DESC
),
pr AS MATERIALIZED (
  SELECT a.user_id, a.online_minutes, a.active_minutes, a.idle_minutes, a.break_minutes,
         a.first_seen_at, a.last_seen_at, a.first_active_at, a.last_active_at, a.idle_alerts,
         a.last_state, a.idle_streak_started_at
  FROM public.agent_presence_days a
  WHERE a.day = $3::date
),
lg AS (
  SELECT u.user_id, min(u.at) AS first_login
  FROM (SELECT s.user_id, s.login_time AS at FROM public.shift_login_logs s WHERE s.shift_date = $3::date
        UNION ALL
        SELECT a.user_id, a.login_time FROM public.admin_login_logs a
         WHERE a.login_time BETWEEN $1::timestamptz AND $2::timestamptz) u
  WHERE u.user_id IS NOT NULL
  GROUP BY 1
),
ppl AS (
  SELECT mem.person_id FROM mem
  UNION SELECT pd.person_id FROM pd
  UNION SELECT sp.id FROM public.sales_people sp JOIN pr ON pr.user_id = sp.user_id
         WHERE coalesce(pr.online_minutes, 0) > 0
  UNION SELECT sp.id FROM public.sales_people sp JOIN lg ON lg.user_id = sp.user_id
),
r0 AS MATERIALIZED (
  SELECT p.person_id, sp.user_id,
         coalesce(sp.display_name, pf.full_name, 'Agent') AS name,
         pt.team_key, pt.team_name, pt.team_lane, pt.team_kind, pt.team_sort,
         EXISTS (SELECT 1 FROM mem WHERE mem.person_id = p.person_id) AS is_member,
         -- management (sales_teams.kind) is shown, never ranked — like is_manager / admin / manager
         (coalesce(sp.is_manager, false)
          OR coalesce(pt.team_kind = 'management', false)
          OR EXISTS (SELECT 1 FROM public.user_roles r
                      WHERE r.user_id = sp.user_id AND r.role::text IN ('admin', 'manager'))) AS is_manager,
         CASE WHEN sp.user_id IS NULL THEN 'n/a'
              WHEN $6::boolean AND pr.last_state IN ('active', 'idle', 'break')
                   AND pr.last_seen_at >= now() - interval '3 minutes'
              THEN CASE pr.last_state WHEN 'active' THEN 'online' ELSE pr.last_state END
              ELSE 'offline' END AS state,
         pr.online_minutes, pr.active_minutes, pr.idle_minutes, pr.break_minutes,
         pr.first_seen_at, pr.last_seen_at, pr.first_active_at, pr.last_active_at, pr.idle_alerts,
         CASE WHEN $6::boolean AND pr.last_state = 'idle' AND pr.idle_streak_started_at IS NOT NULL
                   AND pr.last_seen_at >= now() - interval '3 minutes'
              THEN greatest(0, floor(extract(epoch FROM now() - pr.idle_streak_started_at) / 60))::int END AS idle_streak_min,
         lg.first_login,
         coalesce(wk.worked, 0) AS worked, coalesce(wk.sale_d, 0) AS sale_d,
         coalesce(wk.cancel_d, 0) AS cancel_d, coalesce(wk.trash_d, 0) AS trash_d,
         coalesce(wk.callback_d, 0) AS callback_d, wk.last_at,
         coalesce(pa.sales, 0) AS f_sales, coalesce(pa.value_mkd, 0) AS f_value,
         coalesce(pa.returned, 0) AS f_ret, coalesce(pa.cas, 0) AS f_cas, coalesce(pa.cas_mkd, 0) AS f_cas_mkd,
         coalesce(pa.live, 0) AS f_live,
         coalesce(pa.booked, 0) AS f_booked, coalesce(pa.booked_mkd, 0) AS f_booked_mkd,
         coalesce(pa.twin, 0) AS f_twin, coalesce(pa.twin_mkd, 0) AS f_twin_mkd,
         coalesce(pa.sales, 0) + coalesce(pa.booked, 0) AS f_total,
         coalesce(pa.value_mkd, 0) + coalesce(pa.booked_mkd, 0) AS f_total_mkd,
         (coalesce(pa.sales, 0) + coalesce(pa.cas, 0) + coalesce(pa.booked, 0)
          + coalesce(pa.twin, 0) + coalesce(pa.worked, 0)) > 0 AS f_any,
         coalesce(pa.depts, '{}'::jsonb) AS depts
  FROM ppl p
  JOIN public.sales_people sp ON sp.id = p.person_id
  LEFT JOIN public.profiles pf ON pf.user_id = sp.user_id
  LEFT JOIN pteam pt ON pt.person_id = p.person_id
  LEFT JOIN pr ON pr.user_id = sp.user_id
  LEFT JOIN lg ON lg.user_id = sp.user_id
  LEFT JOIN wk ON wk.person_id = p.person_id
  LEFT JOIN pa ON pa.person_id = p.person_id
),
-- the filter: a department keeps the people with anything in it; a team keeps its badge holders
-- ('team:lane' → that lane's; the legacy aliases → sales_team_filter_matches)
rf AS (
  SELECT r0.* FROM r0
  WHERE ($4::text IS NULL OR r0.f_any)
    AND ($5::text IS NULL OR public.sales_team_filter_matches($5::text, r0.team_key, r0.team_lane))
),
rk AS (
  SELECT rf.*,
         CASE WHEN NOT rf.is_manager AND rf.f_total > 0
              THEN rank() OVER (PARTITION BY (NOT rf.is_manager AND rf.f_total > 0)
                                ORDER BY rf.f_total_mkd DESC, rf.f_total DESC) END AS rnk,
         CASE rf.state WHEN 'online' THEN 0 WHEN 'idle' THEN 1 WHEN 'break' THEN 2 WHEN 'offline' THEN 3 ELSE 4 END AS st_ord
  FROM rf
),

-- ── 6. the whole day by department (never filtered) — the tie-out ──────────
dk AS (
  SELECT d.key, d.ord
  FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('teleshop_out', 3),
               ('teleshop_other', 4), ('social', 5), ('web', 6)) d(key, ord)
),
sagg AS (
  SELECT so.dept,
         count(*) FILTER (WHERE so.in_total)                                        AS sales,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total), 0)                  AS value_mkd,
         count(*) FILTER (WHERE so.in_total AND so.pid IS NOT NULL)                 AS credited,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total AND so.pid IS NOT NULL), 0) AS credited_mkd,
         count(*) FILTER (WHERE so.in_total AND so.pid IS NULL)                     AS no_seller,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total AND so.pid IS NULL), 0) AS no_seller_mkd,
         count(*) FILTER (WHERE so.in_total AND so.unstamped AND so.pid IS NOT NULL) AS live,
         count(*) FILTER (WHERE NOT so.in_total)                                    AS cas,
         coalesce(sum(so.value_mkd) FILTER (WHERE NOT so.in_total), 0)              AS cas_mkd,
         count(*) FILTER (WHERE so.in_total AND so.sale_source IS NULL)             AS unclassified,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total AND so.sale_source IS NULL), 0) AS unclassified_mkd
  FROM so GROUP BY 1
),
oagg AS (   -- the cohort's sales no person can hold: the web shop and MEX parcels with no order
  SELECT sr.dept,
         count(*) FILTER (WHERE sr.kind = 'web')                           AS web,
         coalesce(sum(sr.value_mkd) FILTER (WHERE sr.kind = 'web'), 0)     AS web_mkd,
         count(*) FILTER (WHERE sr.kind = 'mex')                           AS mex_only,
         coalesce(sum(sr.value_mkd) FILTER (WHERE sr.kind = 'mex'), 0)     AS mex_only_mkd
  FROM sr WHERE sr.in_total AND sr.kind <> 'order' GROUP BY 1
),
bagg AS (
  SELECT bkc.dept,
         sum(bkc.booked)                                                   AS booked,
         sum(bkc.booked_mkd)                                               AS booked_mkd,
         coalesce(sum(bkc.booked) FILTER (WHERE bkc.person_id IS NULL), 0)     AS booked_no_person,
         coalesce(sum(bkc.booked_mkd) FILTER (WHERE bkc.person_id IS NULL), 0) AS booked_no_person_mkd,
         sum(bkc.twin)                                                     AS twin,
         sum(bkc.twin_mkd)                                                 AS twin_mkd,
         sum(bkc.twin_by_role)                                             AS twin_by_role
  FROM bkc GROUP BY 1
),
wagg AS (
  SELECT vw.dept,
         count(*)                                         AS worked,
         count(*) FILTER (WHERE vw.outcome = 'sale')      AS sale_d,
         count(*) FILTER (WHERE vw.person_id IS NULL)     AS unmapped
  FROM vw GROUP BY 1
)
SELECT jsonb_build_object(
  'version', 2,
  'day', $3::date,
  'is_today', $6::boolean,
  'generated_at', now(),
  'window', jsonb_build_object('from', $1::timestamptz, 'to_end', $2::timestamptz),
  'filter', jsonb_build_object('department', $4::text, 'team', $5::text),
  'departments', (SELECT jsonb_agg(dk.key ORDER BY dk.ord) FROM dk),
  -- the teams on the (department-filtered) board, for the filter bar: sales_teams.sort_order,
  -- each line with its lanes ('team:lane' is a filter value)
  'teams', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'key', t.k, 'name', t.nm, 'people', t.n, 'kind', t.kd, 'sort_order', t.ord,
                     'lanes', (SELECT coalesce(jsonb_agg(jsonb_build_object('lane', l.lane, 'key', t.k || ':' || l.lane,
                                                                            'people', l.n)
                                                         ORDER BY CASE l.lane WHEN 'in' THEN 1 WHEN 'out' THEN 2 ELSE 3 END),
                                               '[]'::jsonb)
                                 FROM (SELECT r1.team_lane AS lane, count(*) AS n
                                         FROM r0 r1
                                        WHERE r1.team_key = t.k AND r1.team_lane IS NOT NULL
                                          AND ($4::text IS NULL OR r1.f_any)
                                        GROUP BY 1) l))
                                      ORDER BY t.ord, t.k), '[]'::jsonb)
              FROM (SELECT coalesce(r0.team_key, 'none') AS k, max(r0.team_name) AS nm, count(*) AS n,
                           max(r0.team_kind) AS kd,
                           min(coalesce(r0.team_sort, CASE WHEN r0.team_key IS NULL THEN 99 ELSE 70 END)) AS ord
                      FROM r0 WHERE $4::text IS NULL OR r0.f_any
                     GROUP BY 1) t),
  -- the people shown (after the filters)
  'summary', (SELECT jsonb_build_object(
      'people',           count(*),
      'members',          count(*) FILTER (WHERE rk.is_member),
      'managers',         count(*) FILTER (WHERE rk.is_manager),
      'ranked',           count(*) FILTER (WHERE rk.rnk IS NOT NULL),
      'online_now',       count(*) FILTER (WHERE rk.state IN ('online', 'idle')),
      'idle',             count(*) FILTER (WHERE rk.state = 'idle'),
      'on_break',         count(*) FILTER (WHERE rk.state = 'break'),
      'offline',          count(*) FILTER (WHERE rk.state = 'offline'),
      'no_login',         count(*) FILTER (WHERE rk.state = 'n/a'),
      'was_online',       count(*) FILTER (WHERE coalesce(rk.online_minutes, 0) > 0),
      'zero_sale_people', count(*) FILTER (WHERE NOT rk.is_manager AND rk.f_total = 0),
      'worked',           coalesce(sum(rk.worked), 0),
      'sale_decisions',   coalesce(sum(rk.sale_d), 0),
      'sales',            coalesce(sum(rk.f_sales), 0),
      'value_mkd',        round(coalesce(sum(rk.f_value), 0)),
      'booked',           coalesce(sum(rk.f_booked), 0),
      'booked_value_mkd', round(coalesce(sum(rk.f_booked_mkd), 0)),
      'total_count',      coalesce(sum(rk.f_total), 0),
      'total_value_mkd',  round(coalesce(sum(rk.f_total_mkd), 0)),
      'cancelled_after_sale', coalesce(sum(rk.f_cas), 0),
      'returned',         coalesce(sum(rk.f_ret), 0),
      'live_credited',    coalesce(sum(rk.f_live), 0),
      'booked_twin',      coalesce(sum(rk.f_twin), 0),
      'booked_twin_value_mkd', round(coalesce(sum(rk.f_twin_mkd), 0)),
      -- the department's (or the day's) sales no person is credited with
      'no_seller',        (SELECT coalesce(sum(sagg.no_seller), 0) FROM sagg
                            WHERE $4::text IS NULL OR sagg.dept = $4::text),
      'no_seller_value_mkd', (SELECT round(coalesce(sum(sagg.no_seller_mkd), 0)) FROM sagg
                               WHERE $4::text IS NULL OR sagg.dept = $4::text),
      'booked_no_person', (SELECT coalesce(sum(bagg.booked_no_person), 0) FROM bagg
                            WHERE $4::text IS NULL OR bagg.dept = $4::text))
    FROM rk),
  'day_totals', jsonb_build_object(
    'by_department', (SELECT jsonb_object_agg(dk.key, jsonb_build_object(
        'sales',            coalesce(s.sales, 0),
        'value_mkd',        round(coalesce(s.value_mkd, 0)),
        'credited',         coalesce(s.credited, 0),
        'credited_value_mkd', round(coalesce(s.credited_mkd, 0)),
        'no_seller',        coalesce(s.no_seller, 0),
        'no_seller_value_mkd', round(coalesce(s.no_seller_mkd, 0)),
        'live_credited',    coalesce(s.live, 0),
        'cancelled_after_sale', coalesce(s.cas, 0),
        'cancelled_value_mkd', round(coalesce(s.cas_mkd, 0)),
        'booked',           coalesce(b.booked, 0),
        'booked_value_mkd', round(coalesce(b.booked_mkd, 0)),
        'booked_no_person', coalesce(b.booked_no_person, 0),
        'booked_no_person_value_mkd', round(coalesce(b.booked_no_person_mkd, 0)),
        'booked_twin',      coalesce(b.twin, 0),
        'booked_twin_value_mkd', round(coalesce(b.twin_mkd, 0)),
        'booked_twin_by_role', coalesce(b.twin_by_role, 0),
        'web',              coalesce(o.web, 0),
        'web_value_mkd',    round(coalesce(o.web_mkd, 0)),
        'mex_only',         coalesce(o.mex_only, 0),
        'mex_only_value_mkd', round(coalesce(o.mex_only_mkd, 0)),
        'worked',           coalesce(w.worked, 0),
        'sale_decisions',   coalesce(w.sale_d, 0),
        'unmapped_decisions', coalesce(w.unmapped, 0)))
      FROM dk
      LEFT JOIN sagg s ON s.dept = dk.key
      LEFT JOIN bagg b ON b.dept = dk.key
      LEFT JOIN oagg o ON o.dept = dk.key
      LEFT JOIN wagg w ON w.dept = dk.key),
    'sales',            (SELECT count(*) FROM so WHERE so.in_total),
    'value_mkd',        (SELECT round(coalesce(sum(so.value_mkd), 0)) FROM so WHERE so.in_total),
    'credited',         (SELECT count(*) FROM so WHERE so.in_total AND so.pid IS NOT NULL),
    'live_credited',    (SELECT count(*) FROM so WHERE so.in_total AND so.unstamped AND so.pid IS NOT NULL),
    'worked',           (SELECT count(*) FROM vw),
    'unmapped_decisions', (SELECT count(*) FROM vw WHERE vw.person_id IS NULL),
    'no_seller', jsonb_build_object(
      'sales',     (SELECT count(*) FROM nsr),
      'value_mkd', (SELECT round(coalesce(sum(nsr.value_mkd), 0)) FROM nsr),
      'reasons',   (SELECT coalesce(jsonb_agg(jsonb_build_object('reason', x.reason, 'department', x.dept,
                                                                 'count', x.n, 'value_mkd', round(x.v))
                                              ORDER BY x.n DESC, x.reason, x.dept), '[]'::jsonb)
                      FROM (SELECT nsr.reason, nsr.dept, count(*) AS n, coalesce(sum(nsr.value_mkd), 0) AS v
                              FROM nsr GROUP BY 1, 2) x),
      'booked',    (SELECT coalesce(sum(bkc.booked), 0) FROM bkc WHERE bkc.person_id IS NULL),
      'booked_value_mkd', (SELECT round(coalesce(sum(bkc.booked_mkd), 0)) FROM bkc WHERE bkc.person_id IS NULL)),
    -- safety: 0 everywhere, or a mapping has a gap
    'no_department', jsonb_build_object(
      'orders',           (SELECT coalesce(sum(sagg.unclassified), 0) FROM sagg),
      'orders_value_mkd', (SELECT round(coalesce(sum(sagg.unclassified_mkd), 0)) FROM sagg),
      'bookings',         (SELECT coalesce(sum(bkc.booked + bkc.twin), 0) FROM bkc WHERE bkc.no_dept),
      'work',             (SELECT count(*) FROM vw WHERE vw.dept IS NULL OR vw.unclassified)),
    'checks', jsonb_build_object(
      'bookings_filter_drift', (SELECT coalesce(sum(bka.docs), 0) FROM bka) - (SELECT count(*) FROM bkd))),
  'rows', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'person_id',        rk.person_id,
      'user_id',          rk.user_id,
      'name',             rk.name,
      'team_key',         rk.team_key,
      'team_name',        rk.team_name,
      'team_lane',        rk.team_lane,
      'team_kind',        rk.team_kind,
      'is_member',        rk.is_member,
      'is_manager',       rk.is_manager,
      'rank',             rk.rnk,
      'sales',            rk.f_sales,
      'value_mkd',        round(rk.f_value),
      'booked',           rk.f_booked,
      'booked_value_mkd', round(rk.f_booked_mkd),
      'total_count',      rk.f_total,
      'total_value_mkd',  round(rk.f_total_mkd),
      'cancelled_after_sale', rk.f_cas,
      'cancelled_value_mkd', round(rk.f_cas_mkd),
      'returned',         rk.f_ret,
      'live_credited',    rk.f_live,
      'booked_twin',      rk.f_twin,
      'booked_twin_value_mkd', round(rk.f_twin_mkd),
      'worked',           rk.worked,
      'sale_decisions',   rk.sale_d,
      'cancelled',        rk.cancel_d,
      'trashed',          rk.trash_d,
      'callbacks',        rk.callback_d,
      'conversion',       CASE WHEN rk.worked > 0 THEN round(rk.sale_d::numeric / rk.worked, 4) END,
      'last_decision_at', rk.last_at,
      'departments',      rk.depts,
      'presence', jsonb_build_object(
        'state',           rk.state,
        'online_min',      coalesce(rk.online_minutes, 0),
        'active_min',      coalesce(rk.active_minutes, 0),
        'idle_min',        coalesce(rk.idle_minutes, 0),
        'break_min',       coalesce(rk.break_minutes, 0),
        'first_seen',      rk.first_seen_at,
        'last_seen',       rk.last_seen_at,
        'first_active',    rk.first_active_at,
        'last_active',     rk.last_active_at,
        'idle_alerts',     coalesce(rk.idle_alerts, 0),
        'idle_streak_min', rk.idle_streak_min,
        'first_login',     rk.first_login))
      ORDER BY CASE WHEN rk.rnk IS NOT NULL THEN 0 WHEN NOT rk.is_manager THEN 1 ELSE 2 END,
               rk.rnk, rk.f_total_mkd DESC, rk.f_total DESC, rk.worked DESC, rk.st_ord,
               coalesce(rk.active_minutes, 0) DESC, rk.name, rk.person_id)
    FROM rk), '[]'::jsonb)
)
  $lb2$
  INTO v_out
  USING v_from, v_to, v_day, v_dept, v_team, (v_day = v_today), public.report_excluded_phone8s();

  RETURN v_out;
END;
$function$;

-- ── 3. assigner_board ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.assigner_board()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH
win AS MATERIALIZED (
  SELECT z.t, z.d
  FROM (SELECT now() AS t, (now() AT TIME ZONE 'Europe/Skopje')::date AS d) z
),
rl AS MATERIALIZED (
  SELECT r.user_id, array_agg(r.role::text ORDER BY r.role::text) AS roles
  FROM public.user_roles r
  GROUP BY r.user_id
),
ppl AS MATERIALIZED (
  SELECT p.user_id, p.full_name, p.last_seen_at, p.voip_state, p.voip_state_at,
         coalesce(rl.roles, '{}'::text[]) AS roles,
         (p.last_seen_at IS NOT NULL AND p.last_seen_at > w.t - interval '2 minutes') AS online
  FROM public.profiles p
  CROSS JOIN win w
  LEFT JOIN rl ON rl.user_id = p.user_id
  WHERE p.is_active
    AND p.user_id IS NOT NULL
    -- an affiliate-only login is an external partner, never staff
    AND NOT (cardinality(coalesce(rl.roles, '{}'::text[])) > 0
             AND coalesce(rl.roles, '{}'::text[]) <@ ARRAY['affiliate']::text[])
),
tm AS (
  SELECT DISTINCT ON (sp.user_id) sp.user_id, m.team_key, t.name AS team_name, m.lane AS team_lane
  FROM public.sales_people sp
  JOIN public.sales_team_members m ON m.person_id = sp.id
  CROSS JOIN win w
  LEFT JOIN public.sales_teams t ON t.key = m.team_key
  WHERE sp.user_id IS NOT NULL
    AND m.valid_from <= w.d AND coalesce(m.valid_to, 'infinity'::date) >= w.d
  ORDER BY sp.user_id, m.is_primary DESC, m.valid_from DESC
),
sh AS (
  SELECT sa.user_id, min(s.start_time) AS st, max(s.end_time) AS en
  FROM public.shift_assignments sa
  JOIN public.shifts s ON s.id = sa.shift_id
  CROSS JOIN win w
  WHERE s.date = w.d
    AND NOT (to_char(s.start_time, 'HH24:MI') = '00:00' AND to_char(s.end_time, 'HH24:MI') = '00:00')
  GROUP BY sa.user_id
),
-- the canonical lead load (assigned_pending_counts: same statuses, same sources)
pend AS (
  SELECT o.assigned_agent_id AS aid,
         count(*)::int                                          AS pendings,
         count(*) FILTER (WHERE o.status = 'pending')::int      AS pendings_pending,
         count(*) FILTER (WHERE o.status = 'take')::int         AS pendings_take,
         count(*) FILTER (WHERE o.status = 'call_again')::int   AS ca_orders
  FROM public.orders o
  WHERE o.assigned_agent_id IS NOT NULL
    AND o.status IN ('pending', 'take', 'call_again')
    AND o.source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')
  GROUP BY 1
),
mem AS (
  SELECT m.assigned_agent_id AS aid,
         count(*)::int                                                          AS list_assigned,
         count(*) FILTER (WHERE NOT m.is_completed)::int                        AS list_open,
         count(*) FILTER (WHERE NOT m.is_completed
                            AND m.in_call_again_until IS NOT NULL
                            AND m.in_call_again_until > w.t)::int               AS list_parked,
         count(*) FILTER (WHERE NOT m.is_completed
                            AND m.call_again_since IS NOT NULL)::int            AS ca_members
  FROM public.prediction_segment_members m
  CROSS JOIN win w
  WHERE m.assigned_agent_id IS NOT NULL
  GROUP BY 1
),
-- the day bounds are written out (not joined from win): only a plain stable
-- expression lets the planner push the filter into both branches of the view
-- (order_history.changed_at / altercpa_leads.decided_at indexes); joined from a
-- CTE it scanned both tables whole (~230 ms)
wk AS (
  SELECT sp.user_id, count(*)::int AS worked
  FROM public.v_sales_work v
  JOIN public.sales_people sp ON sp.id = v.person_id
  WHERE v.at >= ((now() AT TIME ZONE 'Europe/Skopje')::date::timestamp AT TIME ZONE 'Europe/Skopje')
    AND v.at <  (((now() AT TIME ZONE 'Europe/Skopje')::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje')
    AND sp.user_id IS NOT NULL
  GROUP BY 1
),
ag AS (
  SELECT p.user_id, p.full_name, p.roles,
         ('admin' = ANY (p.roles))   AS is_admin,
         ('manager' = ANY (p.roles)) AS is_manager,
         tm.team_key, tm.team_name, tm.team_lane,
         p.online,
         (p.online
          AND p.voip_state IN ('dialing', 'in_call')
          AND p.voip_state_at IS NOT NULL
          AND p.voip_state_at > w.t - interval '3 minutes')     AS in_call,
         p.last_seen_at,
         CASE WHEN sh.user_id IS NULL THEN NULL
              ELSE jsonb_build_object('start', to_char(sh.st, 'HH24:MI'),
                                      'end',   to_char(sh.en, 'HH24:MI')) END AS shift,
         coalesce(pe.pendings, 0)          AS pendings,
         coalesce(pe.pendings_pending, 0)  AS pendings_pending,
         coalesce(pe.pendings_take, 0)     AS pendings_take,
         coalesce(pe.ca_orders, 0)         AS ca_orders,
         coalesce(me.ca_members, 0)        AS ca_members,
         coalesce(me.list_open, 0)         AS list_open,
         coalesce(me.list_parked, 0)       AS list_parked,
         coalesce(me.list_assigned, 0)     AS list_assigned,
         coalesce(wk.worked, 0)            AS worked_today
  FROM ppl p
  CROSS JOIN win w
  LEFT JOIN tm   ON tm.user_id = p.user_id
  LEFT JOIN sh   ON sh.user_id = p.user_id
  LEFT JOIN pend pe ON pe.aid  = p.user_id
  LEFT JOIN mem  me ON me.aid  = p.user_id
  LEFT JOIN wk   ON wk.user_id = p.user_id
),
tot AS (
  SELECT
    (SELECT count(*) FROM public.orders o
      WHERE o.assigned_agent_id IS NULL AND o.status = 'pending'
        AND o.source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned'))::int AS pendings_unassigned,
    co.n::int AS ca_orders_unassigned,
    cm.n::int AS ca_members_unassigned,
    least(co.oldest, cm.oldest) AS oldest
  FROM (SELECT count(*) AS n, min(o.call_again_since) AS oldest
          FROM public.orders o
         WHERE o.assigned_agent_id IS NULL AND o.status = 'call_again'
           AND o.source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')) co,
       -- idx_segment_members_open_call_again (above)
       (SELECT count(*) AS n, min(m.call_again_since) AS oldest
          FROM public.prediction_segment_members m
         WHERE m.call_again_since IS NOT NULL AND NOT m.is_completed
           AND m.assigned_agent_id IS NULL) cm
)
SELECT jsonb_build_object(
  'generated_at', (SELECT w.t FROM win w),
  'agents', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
             'user_id',             a.user_id,
             'full_name',           a.full_name,
             'roles',               to_jsonb(a.roles),
             'is_admin',            a.is_admin,
             'is_manager',          a.is_manager,
             'team_key',            a.team_key,
             'team_name',           a.team_name,
             'team_lane',           a.team_lane,
             'online',              a.online,
             'in_call',             a.in_call,
             'last_seen_at',        a.last_seen_at,
             'shift',               a.shift,
             'pendings',            a.pendings,
             'pendings_pending',    a.pendings_pending,
             'pendings_take',       a.pendings_take,
             'call_agains',         a.ca_orders + a.ca_members,
             'call_agains_orders',  a.ca_orders,
             'call_agains_members', a.ca_members,
             'list_open',           a.list_open,
             'list_parked',         a.list_parked,
             'list_assigned',       a.list_assigned,
             'worked_today',        a.worked_today)
           ORDER BY a.online DESC, a.in_call DESC,
                    (a.pendings + a.ca_members + a.list_open) DESC,
                    a.full_name, a.user_id)
    FROM ag a), '[]'::jsonb),
  'totals', (
    SELECT jsonb_build_object(
             'agents',                         (SELECT count(*) FROM ag),
             'online',                         (SELECT count(*) FROM ag WHERE ag.online),
             'in_call',                        (SELECT count(*) FROM ag WHERE ag.in_call),
             'pendings_unassigned',            t.pendings_unassigned,
             'call_agains_unassigned',         t.ca_orders_unassigned + t.ca_members_unassigned,
             'call_agains_unassigned_orders',  t.ca_orders_unassigned,
             'call_agains_unassigned_members', t.ca_members_unassigned,
             'oldest_call_again_since',        t.oldest,
             'worked_today',                   (SELECT coalesce(sum(ag.worked_today), 0) FROM ag))
    FROM tot t)
);
$function$;

-- ── 4. insights_work ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.insights_work(p_from timestamp with time zone, p_to_end timestamp with time zone, p_prev_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_prev_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_pf        timestamptz;
  v_pt        timestamptz;
  v_me        uuid;
  v_excluded  text[];
  v_out       jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_work: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_work: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL
     AND p_prev_to_end >= p_prev_from AND p_prev_to_end - p_prev_from <= interval '800 days' THEN
    v_pf := p_prev_from;
    v_pt := p_prev_to_end;
  END IF;

  -- The self view (a login holding call_activity that is not admin/manager/
  -- owner): only that login's person, calls and presence.
  IF p_user_id IS NOT NULL THEN
    SELECT sp.id INTO v_me FROM public.sales_people sp WHERE sp.user_id = p_user_id;
  END IF;

  -- The owner's test phones (public.report_excluded_phones): read once, a
  -- constant for the planner — the foundation's rule.
  v_excluded := public.report_excluded_phone8s();

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 test phones ·
  -- $6 self login (NULL = everyone) · $7 the self login's person
  EXECUTE $core$
WITH
w AS (
  SELECT z.f, z.t, z.pf, z.pt,
         (z.f AT TIME ZONE 'Europe/Skopje')::date  AS fd,
         (z.t AT TIME ZONE 'Europe/Skopje')::date  AS td,
         (z.pf AT TIME ZONE 'Europe/Skopje')::date AS pfd,
         (z.pt AT TIME ZONE 'Europe/Skopje')::date AS ptd,
         CASE WHEN (z.t AT TIME ZONE 'Europe/Skopje')::date - (z.f AT TIME ZONE 'Europe/Skopje')::date + 1 <= 62
              THEN 'day' ELSE 'week' END AS gran
  FROM (SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt) z
),
-- the owner's test phones: their orders are in no number (insights_overview's xto)
xtp AS MATERIALIZED (
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($5::text[])
),
xto AS MATERIALIZED (
  SELECT x.id FROM public.orders x
   WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ($5::text[])
  UNION
  SELECT x.id FROM public.orders x JOIN xtp ON xtp.tr = x.mex_tracking_id
),
-- ── the ledgers, both windows at once (cur = this period) ──────────────────
vw AS MATERIALIZED (
  SELECT v.at, v.person_id, v.via, v.outcome, v.actor_ext,
         (v.at AT TIME ZONE 'Europe/Skopje') AS lt,
         (v.at BETWEEN w.f AND w.t)          AS cur
  FROM public.v_sales_work v, w
  WHERE (v.at BETWEEN w.f AND w.t OR v.at BETWEEN w.pf AND w.pt)
    AND (v.order_id IS NULL OR v.order_id NOT IN (SELECT xto.id FROM xto))
    AND ($6::uuid IS NULL OR v.person_id = $7::uuid)
),
cl AS MATERIALIZED (
  SELECT c.agent_id, sp.id AS person_id, c.outcome, c.started_at,
         coalesce(c.total_seconds, 0)                                 AS total_seconds,
         coalesce(c.started_at, c.created_at)                         AS at,
         (coalesce(c.started_at, c.created_at) AT TIME ZONE 'Europe/Skopje') AS lt,
         (coalesce(c.started_at, c.created_at) BETWEEN w.f AND w.t)   AS cur
  FROM public.call_logs c
  CROSS JOIN w
  LEFT JOIN public.sales_people sp ON sp.user_id = c.agent_id
  WHERE (coalesce(c.started_at, c.created_at) BETWEEN w.f AND w.t
         OR coalesce(c.started_at, c.created_at) BETWEEN w.pf AND w.pt)
    AND NOT public.insights_excluded8(public.insights_phone8(c.customer_phone), $5::text[])
    AND ($6::uuid IS NULL OR c.agent_id = $6::uuid)
),
pr AS MATERIALIZED (
  SELECT sp.id AS person_id, a.day, a.online_minutes, a.active_minutes, a.idle_minutes,
         a.break_minutes, a.idle_alerts, a.first_active_at, a.last_active_at,
         (a.day BETWEEN w.fd AND w.td) AS cur
  FROM public.agent_presence_days a
  CROSS JOIN w
  JOIN public.sales_people sp ON sp.user_id = a.user_id
  WHERE (a.day BETWEEN w.fd AND w.td OR a.day BETWEEN w.pfd AND w.ptd)
    AND ($6::uuid IS NULL OR a.user_id = $6::uuid)
),
brk AS MATERIALIZED (
  SELECT sp.id AS person_id,
         greatest(0, extract(epoch FROM (least(coalesce(b.break_end, now()), w.t) - b.break_start)) / 60.0) AS mins
  FROM public.shift_breaks b
  CROSS JOIN w
  JOIN public.sales_people sp ON sp.user_id = b.user_id
  WHERE b.break_start BETWEEN w.f AND w.t
    AND ($6::uuid IS NULL OR b.user_id = $6::uuid)
),
-- ONE team per person for the window (see the header)
mem AS MATERIALIZED (
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, m.role, m.lane
  FROM public.sales_team_members m, w
  WHERE m.valid_from <= w.td AND coalesce(m.valid_to, 'infinity'::date) >= w.fd
  ORDER BY m.person_id, m.is_primary DESC, m.valid_from DESC
),
-- ── per person, this period ─────────────────────────────────────────────────
d_p AS (
  SELECT vw.person_id,
         count(*)                                                  AS worked,
         count(*) FILTER (WHERE vw.via = 'crm')                    AS via_crm,
         count(*) FILTER (WHERE vw.via = 'altercpa')               AS via_altercpa,
         count(*) FILTER (WHERE vw.outcome = 'sale')               AS sale,
         count(*) FILTER (WHERE vw.outcome = 'cancel')             AS cancel,
         count(*) FILTER (WHERE vw.outcome = 'trash')              AS trash,
         count(*) FILTER (WHERE vw.outcome = 'callback')           AS callback,
         max(vw.at)                                                AS last_decision_at
  FROM vw WHERE vw.cur AND vw.person_id IS NOT NULL GROUP BY 1
),
c_p AS (
  SELECT cl.person_id,
         count(*)                                                        AS call_logs,
         count(*) FILTER (WHERE cl.outcome = 'no_answer')                AS no_answer,
         count(*) FILTER (WHERE cl.started_at IS NOT NULL)               AS timed_calls,
         coalesce(sum(cl.total_seconds) FILTER (WHERE cl.started_at IS NOT NULL), 0) AS handling_sec
  FROM cl WHERE cl.cur AND cl.person_id IS NOT NULL GROUP BY 1
),
ev AS (                    -- every event a person made this period
  SELECT vw.person_id, vw.at, vw.lt FROM vw WHERE vw.cur AND vw.person_id IS NOT NULL
  UNION ALL
  SELECT cl.person_id, cl.at, cl.lt FROM cl WHERE cl.cur AND cl.person_id IS NOT NULL
),
evd AS (
  SELECT ev.person_id, ev.lt::date AS d, min(ev.lt) AS lo, max(ev.lt) AS hi
  FROM ev GROUP BY 1, 2
),
e_p AS (                   -- first / last event, days active, the average day's start and end
  SELECT a.person_id, a.first_at, a.last_at, b.days_active, b.avg_start_min, b.avg_end_min
  FROM (SELECT ev.person_id, min(ev.at) AS first_at, max(ev.at) AS last_at FROM ev GROUP BY 1) a
  JOIN (SELECT evd.person_id, count(*) AS days_active,
               round(avg(extract(epoch FROM evd.lo::time) / 60)) AS avg_start_min,
               round(avg(extract(epoch FROM evd.hi::time) / 60)) AS avg_end_min
        FROM evd GROUP BY 1) b ON b.person_id = a.person_id
),
t_p AS (                   -- decisions on days the person HAS presence (rates per active hour)
  SELECT vw.person_id,
         count(*)                                    AS worked_tracked,
         count(*) FILTER (WHERE vw.outcome = 'sale') AS sale_tracked
  FROM vw
  JOIN pr ON pr.cur AND pr.person_id = vw.person_id AND pr.day = vw.lt::date
  WHERE vw.cur
  GROUP BY 1
),
p_p AS (
  SELECT pr.person_id, count(*) AS presence_days,
         sum(pr.online_minutes) AS online_min, sum(pr.active_minutes) AS active_min,
         sum(pr.idle_minutes) AS idle_min, sum(pr.break_minutes) AS break_min,
         sum(pr.idle_alerts) AS idle_alerts,
         min(pr.first_active_at) AS first_active, max(pr.last_active_at) AS last_active
  FROM pr WHERE pr.cur GROUP BY 1
),
b_p AS (
  SELECT brk.person_id, count(*) AS breaks, round(sum(brk.mins)) AS break_logged_min
  FROM brk GROUP BY 1
),
sold AS (                  -- people a sale was credited to this period (sold_at is the stamp's
  SELECT DISTINCT o.sold_by_person_id AS person_id   -- own clock): they get a row even with no other
  FROM public.orders o, w                            -- trace; the COUNT comes from insights_work_credited
  WHERE o.sold_at BETWEEN w.f AND w.t AND o.sold_by_person_id IS NOT NULL
    AND ($6::uuid IS NULL OR o.sold_by_person_id = $7::uuid)
  UNION                      -- … and the authors of the period's collabBox bookings (cohort kind
  SELECT DISTINCT b.author_person_id                 -- 'booking', 20260942001900): a seller whose only
  FROM public.collabbox_documents b, w               -- sales are still waiting for their parcel gets
  WHERE b.doc_at BETWEEN w.f AND w.t                 -- her row (a superset: a booking that is a CRM
    AND b.author_person_id IS NOT NULL               -- sale's copy just shows 0 credited)
    AND b.outcome IN ('booked', 'awaiting_parcel') AND b.vanished_at IS NULL
    AND ($6::uuid IS NULL OR b.author_person_id = $7::uuid)
),
pn AS (                    -- the live state, the Overview's rule
  SELECT a.user_id,
         CASE WHEN a.last_state IN ('active', 'idle', 'break') AND a.last_seen_at >= now() - interval '3 minutes'
              THEN CASE a.last_state WHEN 'active' THEN 'online' ELSE a.last_state END
              ELSE 'offline' END AS st
  FROM public.agent_presence_days a
  WHERE a.day = (now() AT TIME ZONE 'Europe/Skopje')::date
),
ppl AS (                   -- anyone with a trace this period + every team member of the window
  SELECT d_p.person_id FROM d_p
  UNION SELECT c_p.person_id FROM c_p
  UNION SELECT p_p.person_id FROM p_p
  UNION SELECT b_p.person_id FROM b_p
  UNION SELECT sold.person_id FROM sold
  UNION SELECT mem.person_id FROM mem WHERE $6::uuid IS NULL
  UNION SELECT $7::uuid WHERE $7::uuid IS NOT NULL
),
pj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'person_id',        sp.id,
           'name',             sp.display_name,
           'has_login',        sp.user_id IS NOT NULL,
           'is_manager',       sp.is_manager,
           'is_active',        sp.is_active,
           'team_key',         coalesce(mem.team_key, 'unassigned'),
           'team_lane',        mem.lane,
           'role',             coalesce(mem.role, 'member'),
           'online_state',     CASE WHEN sp.user_id IS NULL THEN 'n/a' ELSE coalesce(pn.st, 'offline') END,
           'worked',           coalesce(d.worked, 0),
           'via_crm',          coalesce(d.via_crm, 0),
           'via_altercpa',     coalesce(d.via_altercpa, 0),
           'sale',             coalesce(d.sale, 0),
           'cancel',           coalesce(d.cancel, 0),
           'trash',            coalesce(d.trash, 0),
           'callback',         coalesce(d.callback, 0),
           'no_answer',        coalesce(c.no_answer, 0),
           'call_logs',        coalesce(c.call_logs, 0),
           'timed_calls',      coalesce(c.timed_calls, 0),
           'handling_sec',     coalesce(c.handling_sec, 0),
           'days_active',      coalesce(e.days_active, 0),
           'first_at',         e.first_at,
           'last_at',          e.last_at,
           'avg_start_min',    e.avg_start_min,
           'avg_end_min',      e.avg_end_min,
           'last_decision_at', d.last_decision_at,
           'worked_tracked',   coalesce(tt.worked_tracked, 0),
           'sale_tracked',     coalesce(tt.sale_tracked, 0),
           'presence_days',    coalesce(p.presence_days, 0),
           'online_min',       p.online_min,
           'active_min',       p.active_min,
           'idle_min',         p.idle_min,
           'break_min',        p.break_min,
           'idle_alerts',      p.idle_alerts,
           'first_active',     p.first_active,
           'last_active',      p.last_active,
           'breaks',           coalesce(b.breaks, 0),
           'break_logged_min', coalesce(b.break_logged_min, 0))
         ORDER BY coalesce(d.worked, 0) DESC, coalesce(c.call_logs, 0) DESC, sp.display_name), '[]'::jsonb) AS j
  FROM ppl
  JOIN public.sales_people sp ON sp.id = ppl.person_id
  LEFT JOIN mem ON mem.person_id = sp.id
  LEFT JOIN pn ON pn.user_id = sp.user_id
  LEFT JOIN d_p d ON d.person_id = sp.id
  LEFT JOIN c_p c ON c.person_id = sp.id
  LEFT JOIN e_p e ON e.person_id = sp.id
  LEFT JOIN t_p tt ON tt.person_id = sp.id
  LEFT JOIN p_p p ON p.person_id = sp.id
  LEFT JOIN b_p b ON b.person_id = sp.id
),
tj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('team_key', st.key, 'name', st.name, 'mode', st.leaderboard_mode,
                                                'kind', st.kind, 'sort_order', st.sort_order)
                            ORDER BY st.sort_order, st.key), '[]'::jsonb) AS j
  FROM public.sales_teams st
),
-- ── totals, this period and the previous one ────────────────────────────────
totj AS (
  SELECT jsonb_build_object(
    'worked',        (SELECT count(*) FROM vw WHERE vw.cur),
    'via_crm',       (SELECT count(*) FROM vw WHERE vw.cur AND vw.via = 'crm'),
    'via_altercpa',  (SELECT count(*) FROM vw WHERE vw.cur AND vw.via = 'altercpa'),
    'sale',          (SELECT count(*) FROM vw WHERE vw.cur AND vw.outcome = 'sale'),
    'cancel',        (SELECT count(*) FROM vw WHERE vw.cur AND vw.outcome = 'cancel'),
    'trash',         (SELECT count(*) FROM vw WHERE vw.cur AND vw.outcome = 'trash'),
    'callback',      (SELECT count(*) FROM vw WHERE vw.cur AND vw.outcome = 'callback'),
    'no_answer',     (SELECT count(*) FROM cl WHERE cl.cur AND cl.outcome = 'no_answer'),
    'call_logs',     (SELECT count(*) FROM cl WHERE cl.cur),
    'timed_calls',   (SELECT count(*) FROM cl WHERE cl.cur AND cl.started_at IS NOT NULL),
    'handling_sec',  (SELECT coalesce(sum(cl.total_seconds), 0) FROM cl WHERE cl.cur AND cl.started_at IS NOT NULL),
    'people',        (SELECT count(DISTINCT ev.person_id) FROM ev),
    'people_crm',    (SELECT count(DISTINCT vw.person_id) FROM vw WHERE vw.cur AND vw.via = 'crm'),
    'people_altercpa', (SELECT count(DISTINCT vw.person_id) FROM vw WHERE vw.cur AND vw.via = 'altercpa'),
    'worked_tracked', (SELECT coalesce(sum(t_p.worked_tracked), 0) FROM t_p),
    'sale_tracked',  (SELECT coalesce(sum(t_p.sale_tracked), 0) FROM t_p),
    'presence_people', (SELECT count(*) FROM p_p),
    'online_min',    (SELECT sum(p_p.online_min) FROM p_p),
    'active_min',    (SELECT sum(p_p.active_min) FROM p_p),
    'idle_min',      (SELECT sum(p_p.idle_min) FROM p_p),
    'break_min',     (SELECT sum(p_p.break_min) FROM p_p),
    'idle_alerts',   (SELECT sum(p_p.idle_alerts) FROM p_p),
    'breaks',        (SELECT count(*) FROM brk),
    'break_logged_min', (SELECT coalesce(round(sum(brk.mins)), 0) FROM brk),
    'days_active',   (SELECT count(DISTINCT x.d) FROM (SELECT vw.lt::date AS d FROM vw WHERE vw.cur
                                                     UNION ALL SELECT cl.lt::date FROM cl WHERE cl.cur) x)
  ) AS j
),
prvj AS (
  SELECT CASE WHEN w.pf IS NULL THEN NULL ELSE jsonb_build_object(
    'worked',        (SELECT count(*) FROM vw WHERE NOT vw.cur),
    'via_crm',       (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.via = 'crm'),
    'via_altercpa',  (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.via = 'altercpa'),
    'sale',          (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.outcome = 'sale'),
    'cancel',        (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.outcome = 'cancel'),
    'trash',         (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.outcome = 'trash'),
    'callback',      (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.outcome = 'callback'),
    'no_answer',     (SELECT count(*) FROM cl WHERE NOT cl.cur AND cl.outcome = 'no_answer'),
    'call_logs',     (SELECT count(*) FROM cl WHERE NOT cl.cur),
    'timed_calls',   (SELECT count(*) FROM cl WHERE NOT cl.cur AND cl.started_at IS NOT NULL),
    'people',        (SELECT count(DISTINCT x.person_id) FROM (
                        SELECT vw.person_id FROM vw WHERE NOT vw.cur AND vw.person_id IS NOT NULL
                        UNION ALL SELECT cl.person_id FROM cl WHERE NOT cl.cur AND cl.person_id IS NOT NULL) x),
    'worked_tracked', (SELECT count(*) FROM vw JOIN pr ON NOT pr.cur AND pr.person_id = vw.person_id AND pr.day = vw.lt::date
                        WHERE NOT vw.cur),
    'sale_tracked',  (SELECT count(*) FROM vw JOIN pr ON NOT pr.cur AND pr.person_id = vw.person_id AND pr.day = vw.lt::date
                        WHERE NOT vw.cur AND vw.outcome = 'sale'),
    'presence_people', (SELECT count(DISTINCT pr.person_id) FROM pr WHERE NOT pr.cur),
    'online_min',    (SELECT sum(pr.online_minutes) FROM pr WHERE NOT pr.cur),
    'active_min',    (SELECT sum(pr.active_minutes) FROM pr WHERE NOT pr.cur),
    'idle_alerts',   (SELECT sum(pr.idle_alerts) FROM pr WHERE NOT pr.cur)
  ) END AS j
  FROM w
),
-- ── per day (or week) × team ────────────────────────────────────────────────
pd_ev AS (
  SELECT CASE WHEN w.gran = 'day' THEN vw.lt::date ELSE date_trunc('week', vw.lt)::date END AS b,
         CASE WHEN vw.person_id IS NULL THEN '__none__' ELSE coalesce(mem.team_key, 'unassigned') END AS team_key,
         vw.person_id, vw.outcome AS k
  FROM vw CROSS JOIN w LEFT JOIN mem ON mem.person_id = vw.person_id
  WHERE vw.cur
  UNION ALL
  SELECT CASE WHEN w.gran = 'day' THEN cl.lt::date ELSE date_trunc('week', cl.lt)::date END,
         CASE WHEN cl.person_id IS NULL THEN '__none__' ELSE coalesce(mem.team_key, 'unassigned') END,
         cl.person_id, CASE WHEN cl.outcome = 'no_answer' THEN 'no_answer' ELSE 'call' END
  FROM cl CROSS JOIN w LEFT JOIN mem ON mem.person_id = cl.person_id
  WHERE cl.cur
),
pd_pr AS (
  SELECT CASE WHEN w.gran = 'day' THEN pr.day ELSE date_trunc('week', pr.day)::date END AS b,
         coalesce(mem.team_key, 'unassigned') AS team_key,
         sum(pr.online_minutes) AS online_min, sum(pr.active_minutes) AS active_min
  FROM pr CROSS JOIN w LEFT JOIN mem ON mem.person_id = pr.person_id
  WHERE pr.cur
  GROUP BY 1, 2
),
pd AS (
  SELECT coalesce(e.b, p.b) AS b, coalesce(e.team_key, p.team_key) AS team_key,
         coalesce(e.worked, 0) AS worked, coalesce(e.sale, 0) AS sale, coalesce(e.cancel, 0) AS cancel,
         coalesce(e.trash, 0) AS trash, coalesce(e.callback, 0) AS callback,
         coalesce(e.no_answer, 0) AS no_answer, coalesce(e.calls, 0) AS calls,
         coalesce(e.people, 0) AS people,
         p.online_min, p.active_min
  FROM (
    SELECT pd_ev.b, pd_ev.team_key,
           count(*) FILTER (WHERE pd_ev.k IN ('sale', 'cancel', 'trash', 'callback')) AS worked,
           count(*) FILTER (WHERE pd_ev.k = 'sale')      AS sale,
           count(*) FILTER (WHERE pd_ev.k = 'cancel')    AS cancel,
           count(*) FILTER (WHERE pd_ev.k = 'trash')     AS trash,
           count(*) FILTER (WHERE pd_ev.k = 'callback')  AS callback,
           count(*) FILTER (WHERE pd_ev.k = 'no_answer') AS no_answer,
           count(*) FILTER (WHERE pd_ev.k IN ('no_answer', 'call')) AS calls,
           count(DISTINCT pd_ev.person_id)               AS people
    FROM pd_ev GROUP BY 1, 2
  ) e
  FULL JOIN pd_pr p ON p.b = e.b AND p.team_key = e.team_key
),
pdj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'd', to_char(pd.b, 'YYYY-MM-DD'), 'team_key', pd.team_key,
           'worked', pd.worked, 'sale', pd.sale, 'cancel', pd.cancel, 'trash', pd.trash,
           'callback', pd.callback, 'no_answer', pd.no_answer, 'call_logs', pd.calls,
           'people', pd.people,
           'online_min', pd.online_min, 'active_min', pd.active_min)
         ORDER BY pd.b, pd.team_key), '[]'::jsonb) AS j
  FROM pd
),
-- ── hour of day (Skopje) × person: the heat grid ───────────────────────────
hj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('p', x.person_id, 'h', x.h, 'd', x.dec, 'c', x.calls)
                            ORDER BY x.person_id, x.h), '[]'::jsonb) AS j
  FROM (
    SELECT e.person_id, extract(hour FROM e.lt)::int AS h,
           count(*) FILTER (WHERE e.src = 'd') AS dec,
           count(*) FILTER (WHERE e.src = 'c') AS calls
    FROM (SELECT vw.person_id, vw.lt, 'd'::text AS src FROM vw WHERE vw.cur
          UNION ALL SELECT cl.person_id, cl.lt, 'c'::text FROM cl WHERE cl.cur) e
    GROUP BY 1, 2
  ) x
),
-- ── the call-again queues, NOW (the Call Agains pool; 6-day window) ────────
cbj AS (
  SELECT jsonb_build_object(
    'leads', (
      SELECT jsonb_build_object(
        'total',        count(*),
        'unassigned',   count(*) FILTER (WHERE o.assigned_agent_id IS NULL),
        'over_24h',     count(*) FILTER (WHERE o.call_again_since < now() - interval '24 hours'),
        'expiring_24h', count(*) FILTER (WHERE o.call_again_since < now() - interval '5 days'),
        'no_since',     count(*) FILTER (WHERE o.call_again_since IS NULL),
        'oldest_since', min(o.call_again_since))
      FROM public.orders o
      WHERE o.status = 'call_again'
        AND public.is_lead_source(o.source_type)
        AND NOT public.insights_excluded8(public.insights_phone8(o.customer_phone), $5::text[])
        AND ($6::uuid IS NULL OR o.assigned_agent_id = $6::uuid)),
    'prediction', (
      SELECT jsonb_build_object(
        'total',        count(*),
        'unassigned',   count(*) FILTER (WHERE m.assigned_agent_id IS NULL),
        'over_24h',     count(*) FILTER (WHERE m.call_again_since < now() - interval '24 hours'),
        'expiring_24h', count(*) FILTER (WHERE m.call_again_since < now() - interval '5 days'),
        'no_since',     0,
        'oldest_since', min(m.call_again_since))
      FROM public.prediction_segment_members m
      WHERE m.call_again_since IS NOT NULL
        AND m.is_completed = false
        AND ($6::uuid IS NULL OR m.assigned_agent_id = $6::uuid)),
    'window_days', 6) AS j
),
-- ── data quality ────────────────────────────────────────────────────────────
pres_since AS (SELECT min(a.day) AS d FROM public.agent_presence_days a),
qj AS (
  SELECT CASE WHEN $6::uuid IS NOT NULL THEN NULL ELSE jsonb_build_object(
    'no_person',        (SELECT count(*) FROM vw WHERE vw.cur AND vw.person_id IS NULL),
    'no_person_top',    (SELECT coalesce(jsonb_agg(jsonb_build_object('via', y.via, 'ext', y.actor_ext, 'n', y.n)
                                                   ORDER BY y.n DESC, y.actor_ext), '[]'::jsonb)
                         FROM (SELECT vw.via, vw.actor_ext, count(*) AS n FROM vw
                               WHERE vw.cur AND vw.person_id IS NULL
                               GROUP BY 1, 2 ORDER BY 3 DESC, 2 LIMIT 5) y),
    'unmapped_calls',   (SELECT count(*) FROM cl WHERE cl.cur AND cl.person_id IS NULL),
    'unmapped_callers', (SELECT count(DISTINCT cl.agent_id) FROM cl WHERE cl.cur AND cl.person_id IS NULL),
    -- days of the window before presence tracking existed
    'days_before_presence', (SELECT greatest(0, least(w.td + 1, coalesce(ps.d, w.td + 1)) - w.fd) FROM w, pres_since ps),
    -- person-days worked by someone WITH a login, after tracking began, with no presence row
    'presence_gap_days', (SELECT count(*) FROM evd
                            JOIN public.sales_people sp ON sp.id = evd.person_id AND sp.user_id IS NOT NULL
                            CROSS JOIN pres_since ps
                           WHERE evd.d >= ps.d
                             AND NOT EXISTS (SELECT 1 FROM pr WHERE pr.cur AND pr.person_id = evd.person_id AND pr.day = evd.d)),
    -- AlterCPA-only operators: they decide in THEIR panel, no CRM presence exists for them
    'people_no_login',  (SELECT count(DISTINCT vw.person_id) FROM vw
                           JOIN public.sales_people sp ON sp.id = vw.person_id AND sp.user_id IS NULL
                          WHERE vw.cur)
  ) END AS j
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'gran',           (SELECT w.gran FROM w),
    'presence_since', (SELECT to_char(ps.d, 'YYYY-MM-DD') FROM pres_since ps),
    'work_since',     least((SELECT min(h.changed_at) FROM public.order_history h),
                            (SELECT min(l.decided_at) FROM public.altercpa_leads l WHERE l.decision IS NOT NULL)),
    'calls_since',    (SELECT min(c.created_at) FROM public.call_logs c),
    'self',           $6::uuid IS NOT NULL,
    'credited_via',   'insights_work_credited'),
  'totals',    (SELECT totj.j FROM totj),
  'prev',      (SELECT prvj.j FROM prvj),
  'teams',     (SELECT tj.j FROM tj),
  'people',    (SELECT pj.j FROM pj),
  'per_day',   (SELECT pdj.j FROM pdj),
  'by_hour',   (SELECT hj.j FROM hj),
  'callbacks', (SELECT cbj.j FROM cbj),
  'quality',   (SELECT qj.j FROM qj))
$core$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_excluded, p_user_id, v_me;

  RETURN v_out;
END;
$function$;

-- ── 5. sales_teams_admin_overview ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sales_teams_admin_overview()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH act AS (
  SELECT w.person_id,
         max(w.at)                                                                    AS last_at,
         count(*) FILTER (WHERE w.at > now() - interval '30 days')                   AS n30,
         count(*) FILTER (WHERE w.at > now() - interval '30 days' AND w.outcome = 'sale') AS sales30
    FROM public.v_sales_work w
   WHERE w.person_id IS NOT NULL
   GROUP BY w.person_id
),
roles AS (
  SELECT r.user_id, array_agg(DISTINCT r.role::text ORDER BY r.role::text) AS roles
    FROM public.user_roles r
   GROUP BY r.user_id
)
SELECT jsonb_build_object(
  'today', (now() AT TIME ZONE 'Europe/Skopje')::date,
  'teams', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'key', t.key, 'name', t.name, 'leaderboard_mode', t.leaderboard_mode,
                     'kind', t.kind, 'sort_order', t.sort_order)
                   ORDER BY t.sort_order, t.name), '[]'::jsonb)
              FROM public.sales_teams t),
  'accounts', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                        'id', a.id, 'name', a.name, 'is_active', a.is_active) ORDER BY a.name), '[]'::jsonb)
                 FROM public.altercpa_accounts a),
  'people', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'id', sp.id,
                'display_name', sp.display_name,
                'user_id', sp.user_id,
                'login_name', p.full_name,
                'login_email', p.email,
                'login_active', p.is_active,
                'login_roles', to_jsonb(coalesce(ro.roles, ARRAY[]::text[])),
                'is_active', sp.is_active,
                'is_manager', sp.is_manager,
                'notes', sp.notes,
                'created_at', sp.created_at,
                'last_activity_at', a.last_at,
                'decisions_30d', coalesce(a.n30, 0),
                'sales_30d', coalesce(a.sales30, 0),
                'identities', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                  'id', i.id, 'kind', i.kind, 'account_id', i.account_id,
                                  'value', i.value, 'note', i.note, 'created_at', i.created_at)
                                ORDER BY i.kind, i.value), '[]'::jsonb)
                                 FROM public.sales_person_identities i WHERE i.person_id = sp.id),
                'memberships', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                   'id', m.id, 'team_key', m.team_key, 'valid_from', m.valid_from,
                                   'valid_to', m.valid_to, 'role', m.role, 'is_primary', m.is_primary,
                                   'lane', m.lane,
                                   'note', m.note, 'created_at', m.created_at)
                                 ORDER BY m.valid_from DESC, m.created_at DESC), '[]'::jsonb)
                                  FROM public.sales_team_members m WHERE m.person_id = sp.id))
              ORDER BY lower(sp.display_name)), '[]'::jsonb)
               FROM public.sales_people sp
               LEFT JOIN public.profiles p ON p.user_id = sp.user_id
               LEFT JOIN roles ro ON ro.user_id = sp.user_id
               LEFT JOIN act a ON a.person_id = sp.id),
  -- Staff logins for the "link a CRM login" picker. A login whose ONLY role is
  -- `affiliate` is an external partner and never offered (the hard wall).
  'logins', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'user_id', p.user_id, 'full_name', p.full_name, 'email', p.email,
                'is_active', p.is_active, 'roles', to_jsonb(coalesce(ro.roles, ARRAY[]::text[])),
                'person_id', sp.id)
              ORDER BY p.is_active DESC, lower(coalesce(p.full_name, p.email, ''))), '[]'::jsonb)
               FROM public.profiles p
               LEFT JOIN roles ro ON ro.user_id = p.user_id
               LEFT JOIN public.sales_people sp ON sp.user_id = p.user_id
              WHERE ro.roles IS NULL OR EXISTS (SELECT 1 FROM unnest(ro.roles) r WHERE r <> 'affiliate'))
);
$function$;

NOTIFY pgrst, 'reload schema';

COMMIT;
