-- ============================================================================
-- INSIGHTS PEOPLE — the Агенти (Agents) tab on the sale cohort (2026-09-28)
--
-- The owner (Mile, 28.09): "Go through all the tabs, find out if everything is
-- accurate … make them more comprehensive." The old Agents tab (GET
-- /agent-performance → agent_performance_rollup) keyed people by
-- confirmed_by / assigned name folding, so the AlterCPA team was invisible
-- (2.400 September sales, 9 attributed), the same human showed up twice, its
-- "leads" were the confirmed set (conversion 100 % for everyone), it mixed
-- the created and the paid clock under UTC bounds (a custom range lost its
-- last day), and it showed catalogue EUR as bare numbers.
--
-- Adds, read-side only (no table, no trigger, no backfill, no cron):
--   insights_people(p_from, p_to_end, p_prev_from, p_prev_to_end, p_person)
--       → jsonb, the body of GET /api/insights/agents
-- Nothing else changes: agent_performance_rollup and GET /agent-performance
-- stay as they are — the tab still shows their bonus figures, apart and
-- unchanged (the payout / bonus / commission math is deferred by the owner).
--
-- ── DEFINITIONS (one each, shared with the Overview and the leaderboard) ───
--   SALE      a row of public.insights_sale_rows (THE cohort, migration
--             20260940000000): sale day in the window (Skopje), MEX-first
--             bucket, value = COD | price × 61,5 | shop total. The people's
--             sales + "sales with no seller" = insights_cohort's total,
--             exactly, per source (scripts/verify-tab-agents.mjs).
--   SELLER    insights_sale_rows.person_id = orders.sold_by_person_id (the
--             write-once decider stamp — CRM decision, AlterCPA ledger,
--             collabBox author, history import; stamped every 5 minutes by
--             20260939000300). Web-shop orders and MEX parcels with no order
--             have no seller by nature.
--   TEAM      the person's PRIMARY sales_team_members row valid on the Skopje
--             day of the event (sale day / decision day / presence day). No
--             team that day: a Teleshop/Other sale (a collabBox document) →
--             the pseudo-group 'teleshop' (the collabBox authors, placeholders
--             since 28.09, and anyone selling teleshop outside a team), any
--             other event → 'none'. A person who moved teams mid-window is
--             split across both, so a team's members add up to the team.
--             A person's own row shows the team of the window's last elapsed
--             day (else any membership in the window, else the group most of
--             their activity fell in).
--   WORK      public.v_sales_work — every human decision, CRM + AlterCPA
--             (sale | cancel | trash | callback), decisions on the owner's test
--             orders excluded. conversion = sale decisions ÷ worked decisions
--             (the Overview's and the leaderboard's definition). Sales (the
--             cohort) and sale decisions are different counts on purpose: a
--             sale later cancelled is a decision but no longer a sale.
--   TIME      public.agent_presence_days (recorded since 28.09.2026): online /
--             active / idle / break minutes; people without a CRM login have
--             no presence ('n/a'). presence.sale_decisions counts only the
--             decisions of days that HAVE a presence row, so "sales per active
--             hour" never divides old work by new minutes.
--   PACKAGES  units on the lines priced >= 1 EUR (gifts, loyalty points and
--             0,01 EUR samples are not packages); display only — the bonus
--             block keeps its own rule.
--   MONEY     *_mkd keys, whole denari; the api strips every one of them for a
--             non-owner (insightsPeople.ts whitelist). Never × 61,5 again.
--
-- ── SALES WITH NO SELLER (why, per source) ─────────────────────────────────
--   web_shop            web_orders — no agent by nature (split cod | card)
--   mex_only            MEX parcels with no order (split = channel series)
--   altercpa_cancelled  AlterCPA's ledger says cancelled / trashed (so no one
--                       is credited), but MEX shipped the parcel: MEX decides
--                       it is a sale (September: 882, 656 of them paid).
--                       `cancelled_by` names whose decision MEX overruled.
--   awaiting_stamp      approved in AlterCPA, not stamped yet (the stamping
--                       cron runs every 5 minutes)
--   unmapped            the decider is known by a handle nobody has named yet
--                       (Settings → Teams → unmapped): `handles` lists them
--   no_decider          nothing names a decider (e.g. pre-ledger history)
--
-- ── /orders links ───────────────────────────────────────────────────────────
--   A person's numbers: /orders?cohort_bucket=…&sold_by_person_id=…&sold_from
--   &sold_to (exact: every credited sale is an order). A team's numbers:
--   /orders?cohort_bucket=…&team_key=…, which lists the sales of the team's
--   PRIMARY members over the window — `drill_exact` says whether that is
--   exactly this group's sales (false when a member also sold outside the
--   team's days, e.g. before joining).
--
-- Security: SECURITY DEFINER (the people / teams tables are owners-only under
-- RLS), EXECUTE for service_role only (+ the read-only verification role).
-- plpgsql + EXECUTE … USING (the insights_cohort pattern): planned with the
-- real bounds; jit off (a wide, cheap plan). Measured read-only on live data
-- 2026-09-28 (EXPLAIN ANALYZE, server side): a week 0,6 s · a month 1,1 s ·
-- a year 3,1–3,6 s, of which insights_sale_rows itself is 1,3–2,0 s (the
-- Overview's insights_cohort takes 2,8–3,2 s for the same year at the same
-- moments). Five builders were running queries meanwhile; quiet-time numbers
-- are the lower ends.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $dep$
BEGIN
  IF to_regprocedure('public.insights_sale_rows(timestamptz, timestamptz, boolean)') IS NULL
     OR to_regprocedure('public.report_excluded_phone8s()') IS NULL
     OR to_regclass('public.v_sales_work') IS NULL
     OR to_regclass('public.agent_presence_days') IS NULL THEN
    RAISE EXCEPTION 'apply 20260940000000_insights_foundation.sql (and its prerequisites) first';
  END IF;
END
$dep$;

-- ── insights_people — GET /api/insights/agents ─────────────────────────────
-- { meta:{from,to,granularity,clock:'sale',presence_since,stamped_at,person},
--   totals:{sales,value_mkd,cod_mkd,paid_mkd,with_person,with_person_mkd,
--           without_person,without_person_mkd,by_source:[{key,sales,with_person,
--           value_mkd,with_person_mkd}],worked,sale_decisions,cancel_decisions,
--           trash_decisions,callback_decisions,unmapped_decisions,conversion,
--           prev:{sales,with_person,worked,sale_decisions}|null},
--   teams:[{key,name,mode,kind:'team'|'teleshop'|'none',people,online_now,
--           break_now,drill_exact,<measures>,members:[{person_id,<measures>}],
--           spark:[{d,sales,sale_decisions,worked}]}],
--   people:[{person_id,name,has_login,is_manager,is_active,identity_kinds,
--            team_key,team_role,online_state,groups,<measures>}],
--   no_seller:{count,value_mkd,reasons:[{reason,source,detail,count,value_mkd,
--              cod_mkd,buckets}],handles:[{via,handle,count,value_mkd}],
--              cancelled_by:[{person_id,name,altercpa_user,count,value_mkd}]},
--   unmapped_work:{count,actors:[{via,actor,count}]},
--   spark:[{d,sales,with_person,value_mkd,worked,sale_decisions}],
--   detail: null | {person_id,days:[{d,sales,value_mkd,paid,returned,worked,
--           sale_decisions,cancel_decisions,trash_decisions,callback_decisions,
--           online_min,active_min}],products:[{name,count,value_mkd}],
--           identities:[{kind,value}],memberships:[{team_key,name,from,to,role,
--           primary}]} }
-- <measures> = sales, value_mkd, cod_mkd, paid_mkd, returned_mkd,
--   cancelled_mkd, packages, buckets{paid,paid_legacy,paid_unproven,courier,
--   courier_problem,label,to_pack,returned} (Σ = sales), outside{
--   cancelled_after_sale,trashed_after_sale,replacement}, by_source{altercpa,
--   elyon_crm,teleshop_other,web} (Σ = sales), worked, sale_decisions,
--   cancel_decisions, trash_decisions, callback_decisions, via_crm,
--   via_altercpa, conversion, first_decision_at, last_decision_at,
--   presence{days,online_min,active_min,idle_min,break_min,idle_alerts,
--   first_active_at,last_active_at,sale_decisions}|null, prev{sales,worked,
--   sale_decisions}|null.
-- p_person: people[] holds only that person and `detail` is filled (the
-- person drill, and an agent's own view). Spark / detail days: daily up to 62
-- days, monthly beyond.
CREATE OR REPLACE FUNCTION public.insights_people(
  p_from        timestamptz,
  p_to_end      timestamptz,
  p_prev_from   timestamptz DEFAULT NULL,
  p_prev_to_end timestamptz DEFAULT NULL,
  p_person      uuid        DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
SET jit = off
AS $fn$
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
         r.sale_day, r.person_id, r.order_id,
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
-- membership); with none: a teleshop_other (collabBox) sale → 'teleshop',
-- anything else → 'none'. k: s sale · w decision · p presence day · r roster.
ev AS MATERIALIZED (
  SELECT 's'::text AS k, s.person_id,
         coalesce(m.team_key, CASE WHEN s.source = 'teleshop_other' THEN 'teleshop' ELSE 'none' END) AS grp,
         s.sale_day AS d, s.cur, s.prev,
         s.source, s.bucket, s.in_total, s.value_mkd, s.cod_mkd, s.units,
         NULL::text AS outcome, NULL::text AS via, false AS pday,
         NULL::integer AS online, NULL::integer AS active, NULL::integer AS idle, NULL::integer AS brk,
         NULL::integer AS alerts, NULL::timestamptz AS first_at, NULL::timestamptz AS last_at
  FROM sr s
  LEFT JOIN mem m ON m.person_id = s.person_id AND s.sale_day BETWEEN m.valid_from AND m.valid_to
  WHERE s.person_id IS NOT NULL AND (s.cur OR s.prev)
  UNION ALL
  SELECT 'w', v.person_id, coalesce(m.team_key, 'none'), v.d, v.cur, v.prev,
         NULL, NULL, NULL, NULL, NULL, NULL,
         v.outcome, v.via, (pd.user_id IS NOT NULL),
         NULL, NULL, NULL, NULL, NULL, v.at, v.at
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
         a.first_active_at, a.last_active_at
  FROM pr a
  JOIN public.sales_people sp ON sp.user_id = a.user_id
  LEFT JOIN mem m ON m.person_id = sp.id AND a.day BETWEEN m.valid_from AND m.valid_to
  UNION ALL
  -- the roster: everyone on a team in the window is shown, sales or not
  -- (a closed membership keeps its past days even after deactivation)
  SELECT 'r', m.person_id, m.team_key, NULL::date, true, false,
         NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, false,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL
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
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'teleshop_other')             AS src_teleshop_other,
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
         a.sales, a.sale_rows, a.prev_sales, a.b_paid, a.b_paid_legacy, a.b_paid_unproven,
        a.b_courier, a.b_courier_problem, a.b_label, a.b_to_pack, a.b_returned, a.o_cancelled,
        a.o_trashed, a.o_replacement, a.src_altercpa, a.src_elyon_crm, a.src_teleshop_other,
        a.src_web, a.value_mkd, a.cod_mkd, a.paid_mkd, a.returned_mkd, a.cancelled_mkd, a.packages,
        a.worked, a.sale_d, a.cancel_d, a.trash_d, a.callback_d, a.via_crm, a.via_altercpa,
        a.prev_worked, a.prev_sale_d, a.sale_d_tracked, a.first_decision_at, a.last_decision_at,
        a.online_min, a.active_min, a.idle_min, a.break_min, a.idle_alerts, a.presence_days,
        a.first_active_at, a.last_active_at
  FROM ag0 a
  UNION ALL
  SELECT 1 AS g_grp, 0 AS g_person, NULL::text AS grp, a.person_id AS person_id,
         sum(a.sales)::bigint AS sales,
         sum(a.sale_rows)::bigint AS sale_rows,
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
         sum(a.src_teleshop_other)::bigint AS src_teleshop_other,
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
         sum(a.src_teleshop_other)::bigint AS src_teleshop_other,
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
              'altercpa', a.src_altercpa, 'elyon_crm', a.src_elyon_crm,
              'teleshop_other', a.src_teleshop_other, 'web', a.src_web),
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
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, m.role
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
tj AS (
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.ord, x.key), '[]'::jsonb) AS j
  FROM (
    SELECT g.grp AS key,
           CASE g.grp WHEN 'altercpa_leads' THEN 1 WHEN 'crm_prediction' THEN 2 WHEN 'teleshop' THEN 3
                      WHEN 'management' THEN 4 WHEN 'none' THEN 9 ELSE 5 END AS ord,
           g.m || jsonb_build_object(
             'key',   g.grp,
             'name',  st.name,
             'mode',  st.leaderboard_mode,
             'kind',  CASE WHEN g.grp IN ('teleshop', 'none') THEN g.grp ELSE 'team' END,
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
             'members', coalesce((SELECT jsonb_agg(x.m || jsonb_build_object('person_id', x.person_id)
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
         s.sold_at, s.sold_by_ext, s.sold_via
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
         NULL, NULL, NULL, NULL,
         CASE WHEN np.kind = 'web' THEN 'web_shop' ELSE 'mex_only' END,
         np.split
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
         ORDER BY CASE x.source WHEN 'altercpa' THEN 1 WHEN 'elyon_crm' THEN 2 WHEN 'web' THEN 3 ELSE 4 END,
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
          FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('web', 3), ('teleshop_other', 4)) s0(key, ord)
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
                       'role', m.role, 'primary', m.is_primary) ORDER BY m.valid_from DESC), '[]'::jsonb)
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
$fn$;

COMMENT ON FUNCTION public.insights_people(timestamptz, timestamptz, timestamptz, timestamptz, uuid) IS
  'GET /api/insights/agents (owner rules 2026-09-28): people and teams on the sale cohort — sales credited to orders.sold_by_person_id (insights_sale_rows) with MEX-first buckets, the work ledger (v_sales_work: decisions, conversion = sale decisions / worked), time on the CRM (agent_presence_days), team = primary membership on the event day (else teleshop | none), sales with no seller by reason (Σ people + no seller = insights_cohort total), spark, and one person in depth (p_person). Money in *_mkd keys (the api strips them for non-owners). Contract: migration 20260941000200.';

REVOKE ALL ON FUNCTION public.insights_people(timestamptz, timestamptz, timestamptz, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_people(timestamptz, timestamptz, timestamptz, timestamptz, uuid)
  TO service_role;

-- The read-only verification harness (scripts/verify-tab-agents.mjs) runs
-- through the Management API as supabase_read_only_user (pg_read_all_data);
-- EXECUTE on a function that only reads widens nothing. Conditional so a fresh
-- local database without the platform role migrates.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.insights_people(timestamptz, timestamptz, timestamptz, timestamptz, uuid)
      TO supabase_read_only_user;
  END IF;
END
$grant$;

NOTIFY pgrst, 'reload schema';
