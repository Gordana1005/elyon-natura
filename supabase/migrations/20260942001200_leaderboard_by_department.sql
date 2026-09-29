-- ============================================================================
-- LEADERBOARD BY DEPARTMENT — one row per agent, the day split over the six
-- departments (owner, Mile, 28–29.09.2026)
--
--   "The Leaderboard must be accurate for each agent — how much she made that
--    day. We must know which agent worked in which department and how much she
--    made from her own orders."
--   Decisions: ALL departments are shown (Teleshop – Lead in too: Чима,
--   Ристеска, Кипровска); one row per agent with a split by department; the
--   board reads what happens live in the CRM (CRM orders + the AlterCPA sync
--   that writes into it) AND the collabBox bookings (read every 30 minutes then;
--   since 20260942001300 the full collabbox-sync pass runs every 15 minutes,
--   07:00–22:59 Skopje); managers are shown but never ranked.
--
-- Adds, read-side only (no table, no trigger, no backfill, no cron):
--   leaderboard_day_v2(p_day date, p_department text, p_team text) → jsonb
--       the body of GET /api/leaderboard?v=2 (supabase/functions/api/
--       leaderboardV2.ts maps it; the TV page src/pages/TvLeaderboardPage.tsx).
-- leaderboard_day(date, text) (20260939000000) is NOT touched: the old
-- response stays the api's default and verify-attribution C4/C5 keep reading it.
--
-- ── WHAT A ROW IS ───────────────────────────────────────────────────────────
-- One row per HUMAN (sales_people) who is on a team that day, or sold, booked,
-- decided, was online or logged in that day:
--   members  every sales_team_members row valid on p_day, any team (management
--            too — managers are shown, never ranked); a closed membership still
--            shows on its own past days, like leaderboard_day
--   others   anyone credited with a sale / a collabBox booking, anyone with a
--            decision in the work ledger, anyone with CRM presence minutes or a
--            login record that day (the five logins with no team show up here,
--            with no badge)
--   badge    the PRIMARY team valid that day (a badge only — the department of a
--            sale is never decided by the team)
--   manager  sales_people.is_manager OR an admin / manager role (leaderboard_day's
--            rule) — shown, never ranked, listed after everyone else
--
-- ── THE NUMBERS (every sale counted ONCE) ───────────────────────────────────
-- SALES     the day's ORDER rows of THE cohort, public.insights_sale_rows (the
--           Overview's own rows, migrations 20260940000000 / 20260942001000):
--           sale day = sold_at, else the AlterCPA approval, else confirmed_at,
--           else created_at (Skopje); dispositions and the owner's test phones
--           out; in the total = confirmed / packed / shipped / paid + returned
--           (cancels and trash are never orders); value = the parcel COD when a
--           MEX parcel is linked (a shared parcel: the holder's share), else
--           price × 61,5, in денари; the DEPARTMENT is the row's cohort source =
--           cohort_order_source(sale_source, detail, mex_tracking_id) — THE
--           mapping, never re-implemented here.
--           Credited to orders.sold_by_person_id. An UNSTAMPED sale (sold_at
--           NULL — an AlterCPA approval the 5-minute stamping cron has not
--           reached yet, a CRM confirm the live stamp could not name) is credited
--           by leaderboard_day's live rule: the order's first 'sale' decision of
--           the day in v_sales_work that names a person. Stamp OR ledger, never
--           both. Nobody → the "no seller" bucket, with insights_people's reason.
-- CANCELLED_AFTER_SALE  the day's sales that are cancelled / trashed now (the
--           cohort's cancelled_after_sale / trashed_after_sale buckets): shown
--           apart, never in sales or value.
-- BOOKED    collabBox documents booked that day that no order holds yet —
--           public.collabbox_booked_today(p_day) (20260942000900), department by
--           the document type (collabbox_department → cohort_order_source).
--           Counted into the person's total ONLY for the order types (10036
--           Нарачка in · 10050 Нарачка out · 10106 Социјални мрежи): those
--           become orders of their own once their parcel exists (the booking
--           drops out the moment an order holds its DocNumber, and that order —
--           sold_at = the document time — counts instead, same day, same author).
--           NOT counted (booked_twin, shown apart):
--             · 10111 Нарачка LEADS (role 'credit') and 10114 LEADS-OUT (role
--               'order_unless_held'): the shipping document of a CRM / AlterCPA
--               sale that is already on the board — the owner's own roles: a
--               LEADS document never becomes an order, a LEADS-OUT only when no
--               order takes its parcel. Measured 28.09: 30 LEADS-OUT bookings by
--               19 CRM agents — 17 of the 23 with a known phone have the SAME
--               agent's CRM sale on that phone minutes apart (ORD-108959 09:17 ↔
--               002-9103-177566 09:16 …); counting them would double those
--               agents. The ones with no CRM twin reach the board when the
--               nightly sync creates their order (dated at the booking).
--             · an order-type booking whose customer (komitent card / teleshop
--               registry / its parcel) already has a CRM / AlterCPA SALE with no
--               parcel of its own, created 1 day before … 2 days after, at a
--               price that fits — the writer's own 'possible_twin_crm_sale' rule
--               (collabbox_apply_one): that sale is already on the board.
--           A booking with no person (author not named in Settings → Teams) sits
--           in the no-seller bucket.
-- TOTAL     sales + counted bookings (count and денари) — what ranks.
-- WORK      v_sales_work decisions of the day (CRM + AlterCPA ledger, the
--           decisions on the owner's test orders out), the WHOLE day, every
--           department: worked, sale / cancel / trash / callback decisions,
--           conversion = sale decisions ÷ worked (the leaderboard's and the
--           Overview's definition); per department as well.
-- TIME      agent_presence_days of the day + the live state (today only) —
--           leaderboard_day's rule verbatim; 'n/a' without a CRM login.
-- RANK      non-managers with a total > 0, by total денари, then total count
--           (rank(): equal numbers share a place) — within the filter shown.
--
-- ── FILTERS ─────────────────────────────────────────────────────────────────
--   p_department  one of the six keys: every number of a row is that
--                 department's; the rows are the people with anything in it
--                 (sale, cancel, booking, decision). NULL = all departments.
--   p_team        a sales_teams key or 'none' (no team that day): the people
--                 whose badge it is. NULL = everyone.
--   day_totals is never filtered: the whole day by department, so
--   Σ credited + no seller (+ web shop / MEX-only parcels, which no person can
--   hold) = the cohort's total of every department (scripts/
--   verify-leaderboard-v2.mjs proves it, and every person × department).
--
-- ── MONEY ───────────────────────────────────────────────────────────────────
-- Every amount is a *_mkd key, whole денари. The api decides who receives them
-- (leaderboardV2.ts: a whitelist strip for any caller without money access —
-- the TV token keeps the board's existing access rule).
--
-- Security: SECURITY DEFINER (people / teams / collabBox tables are owners-only
-- under RLS), EXECUTE for service_role only — the public TV route calls it from
-- the api after validating its ?key= token — plus the read-only verification
-- role. Aggregates and names only: no phone, no address, no customer.
-- plpgsql + EXECUTE … USING (the leaderboard_day / insights pattern): planned
-- with the real day bounds. THE COHORT IS READ, NOT COPIED: insights_sale_rows
-- for one day is ~0,35 s on live data (28.09.2026), the rest a few ms.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. What this builds on ──────────────────────────────────────────────────
DO $dep$
BEGIN
  IF to_regprocedure('public.cohort_order_source(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'apply 20260942001000_six_departments.sql first (cohort_order_source(sale_source, detail, tracking))';
  END IF;
  IF to_regprocedure('public.collabbox_booked_today(date)') IS NULL
     OR to_regprocedure('public.collabbox_department(text,text,uuid,timestamptz)') IS NULL
     OR to_regprocedure('public.collabbox_doc_role(text)') IS NULL
     OR to_regclass('public.collabbox_documents') IS NULL THEN
    RAISE EXCEPTION 'apply 20260942000900_collabbox_nightly_sync.sql first';
  END IF;
  IF to_regprocedure('public.insights_sale_rows(timestamptz,timestamptz,boolean)') IS NULL
     OR to_regprocedure('public.report_excluded_phone8s()') IS NULL
     OR to_regclass('public.v_sales_work') IS NULL
     OR to_regclass('public.agent_presence_days') IS NULL
     OR to_regclass('public.sales_team_members') IS NULL THEN
    RAISE EXCEPTION 'apply the insights / people / presence migrations (20260935000100 … 20260940000000) first';
  END IF;
END
$dep$;

CREATE OR REPLACE FUNCTION public.leaderboard_day_v2(p_day date, p_department text DEFAULT NULL, p_team text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET jit = off
AS $fn$
DECLARE
  v_day   date := coalesce(p_day, (now() AT TIME ZONE 'Europe/Skopje')::date);
  v_today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_dept  text := nullif(btrim(coalesce(p_department, '')), '');
  v_team  text := nullif(btrim(coalesce(p_team, '')), '');
  v_from  timestamptz;
  v_to    timestamptz;
  v_out   jsonb;
BEGIN
  IF v_dept IS NOT NULL
     AND v_dept NOT IN ('altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web') THEN
    RAISE EXCEPTION 'leaderboard_day_v2: unknown department %', v_dept USING ERRCODE = '22023';
  END IF;
  IF v_team IS NOT NULL AND v_team <> 'none'
     AND NOT EXISTS (SELECT 1 FROM public.sales_teams t WHERE t.key = v_team) THEN
    RAISE EXCEPTION 'leaderboard_day_v2: unknown team %', v_team USING ERRCODE = '22023';
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
              THEN public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id)
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
  SELECT r.kind, r.source AS dept, r.sale_source, r.bucket, r.in_total, r.value_mkd, r.order_id
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

-- ── 3. collabBox bookings no order holds yet (collabbox_booked_today) ──────
-- per person × type (two spellings of one author are one person)
bka AS (
  SELECT b.person_id, b.doc_type, sum(b.docs)::bigint AS docs, coalesce(sum(b.value_mkd), 0) AS value_mkd
  FROM public.collabbox_booked_today($3::date) b
  GROUP BY 1, 2
),
-- the same bookings one document at a time (collabbox_booked_today's own
-- filter), only to find the TWINS of an order-type booking: its customer's
-- CRM / AlterCPA SALE with no parcel of its own (the writer's
-- 'possible_twin_crm_sale' rule). day_totals.checks.bookings_filter_drift = 0
-- proves the two filters agree.
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
bkt AS (
  SELECT d.author_person_id AS person_id, d.doc_type_id AS doc_type,
         count(*)::bigint AS docs, coalesce(sum(d.amount_mkd), 0) AS value_mkd
  FROM bkd d
  CROSS JOIN LATERAL (
    -- the customer's phone: the komitent card, the teleshop registry, the
    -- document's own parcel, any stored card (collabbox_apply_one's order)
    SELECT coalesce(
             (SELECT c.phone8 FROM public.collabbox_customers c
               WHERE c.komitent_id = d.komitent_id AND c.source = 'card' AND c.phone8 ~ '^[0-9]{8}$'),
             (SELECT t.phone8 FROM public.teleshop_import_customers t
               WHERE t.komitent_id = d.komitent_id AND t.phone8 ~ '^[0-9]{8}$'),
             (SELECT p.phone8 FROM public.mex_parcels p
               WHERE p.tracking_id = d.doc_number AND p.phone8 ~ '^[0-9]{8}$'),
             (SELECT c.phone8 FROM public.collabbox_customers c
               WHERE c.komitent_id = d.komitent_id AND c.phone8 ~ '^[0-9]{8}$')) AS p8
  ) ph
  WHERE public.collabbox_doc_role(d.doc_type_id) = 'order'
    AND ph.p8 IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.orders o
       WHERE right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = ph.p8
         AND o.external_source IS DISTINCT FROM 'collabbox'
         AND o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
         AND o.mex_tracking_id IS NULL
         AND o.price > 0
         AND NOT public.is_synthetic_product_name(o.product_name)
         AND o.sale_source_detail IS DISTINCT FROM 'disposition'
         AND o.created_at >= d.doc_at - interval '1 day'
         AND o.created_at <= d.doc_at + interval '2 days'
         AND (abs(round(o.price * 61.5) - d.amount_mkd) <= 3
              OR abs(round(o.price * 61.5) + 150 - d.amount_mkd) <= 3))
  GROUP BY 1, 2
),
-- counted (booked) vs not counted (booked_twin), per person × department
bkc AS (
  SELECT a.person_id, a.doc_type,
         public.cohort_order_source(dp.d[1], dp.d[2], NULL::text) AS dept,
         (dp.d IS NULL) AS no_dept,
         CASE WHEN rl.role = 'order' THEN a.docs - least(a.docs, coalesce(t.docs, 0)) ELSE 0 END AS booked,
         CASE WHEN rl.role = 'order' THEN greatest(a.value_mkd - coalesce(t.value_mkd, 0), 0) ELSE 0 END AS booked_mkd,
         CASE WHEN rl.role = 'order' THEN least(a.docs, coalesce(t.docs, 0)) ELSE a.docs END AS twin,
         CASE WHEN rl.role = 'order' THEN least(a.value_mkd, coalesce(t.value_mkd, 0)) ELSE a.value_mkd END AS twin_mkd,
         CASE WHEN rl.role = 'order' THEN 0 ELSE a.docs END AS twin_by_role
  FROM bka a
  CROSS JOIN LATERAL (SELECT public.collabbox_doc_role(a.doc_type) AS role) rl
  CROSS JOIN LATERAL (SELECT public.collabbox_department(a.doc_type, NULL::text, a.person_id, NULL::timestamptz) AS d) dp
  LEFT JOIN bkt t ON t.person_id IS NOT DISTINCT FROM a.person_id AND t.doc_type = a.doc_type
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
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, st.name AS team_name
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
         pt.team_key, pt.team_name,
         EXISTS (SELECT 1 FROM mem WHERE mem.person_id = p.person_id) AS is_member,
         (coalesce(sp.is_manager, false)
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
rf AS (
  SELECT r0.* FROM r0
  WHERE ($4::text IS NULL OR r0.f_any)
    AND ($5::text IS NULL OR coalesce(r0.team_key, 'none') = $5::text)
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
  -- the teams on the (department-filtered) board, for the filter bar
  'teams', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', t.k, 'name', t.nm, 'people', t.n)
                                      ORDER BY t.ord, t.k), '[]'::jsonb)
              FROM (SELECT coalesce(r0.team_key, 'none') AS k, max(r0.team_name) AS nm, count(*) AS n,
                           min(CASE coalesce(r0.team_key, 'none') WHEN 'altercpa_leads' THEN 1
                                    WHEN 'crm_prediction' THEN 2 WHEN 'management' THEN 8
                                    WHEN 'none' THEN 9 ELSE 5 END) AS ord
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
$fn$;

COMMENT ON FUNCTION public.leaderboard_day_v2(date, text, text) IS
  'TV leaderboard v2 for one Europe/Skopje day (owner 28–29.09.2026): one row per person (team members that day + anyone who sold, booked, decided, was online or logged in) with the day split over the six departments — sales = the cohort''s order rows (insights_sale_rows: sold clock, MEX-first bucket, COD | price × 61,5 денари, department = cohort_order_source) credited to sold_by_person_id, an unstamped sale by the day''s v_sales_work sale decision (never both); cancelled after the sale apart; collabBox bookings no order holds yet (collabbox_booked_today) counted for the order types 10036 · 10050 · 10106 unless the customer''s CRM sale already is (twin), LEADS / LEADS-OUT bookings shown apart (their sale is the CRM / AlterCPA order); work and conversion over the whole day; presence; rank among non-managers by total денари then count. Filters p_department (six keys) / p_team (a team key or none). day_totals: the whole day by department (credited + no seller + web + MEX-only = the cohort), no-seller reasons, no-department safety counters. Money in *_mkd keys — the api decides who receives them. Read-only. Contract: migration 20260942001200.';

REVOKE ALL ON FUNCTION public.leaderboard_day_v2(date, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_day_v2(date, text, text) TO service_role;

-- The read-only verification harness (scripts/verify-leaderboard-v2.mjs) calls
-- this through the Management API with read_only: true, which runs as
-- supabase_read_only_user. EXECUTE on a function that only reads widens
-- nothing. Conditional so a fresh local database still migrates.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.leaderboard_day_v2(date, text, text) TO supabase_read_only_user;
  END IF;
END
$grant$;

NOTIFY pgrst, 'reload schema';

COMMIT;
