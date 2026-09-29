-- Call activity (insights_work) lists the authors of the period's collabBox BOOKINGS (29.09.2026).
--
-- Since 20260942001900 a collabBox document booked without its MEX parcel is a cohort sale of its
-- author (kind 'booking'), and insights_work_credited counts it for her. insights_work listed only
-- the people orders.sold_at credits, so a seller whose only sales that day are bookings — e.g. a
-- teleshop seller with no team and no CRM decisions (Sofija Kuculovska, 29.09: 5 bookings) — had no
-- row: her sales fell into "unassigned" (quality.credited_unlisted) and verify-tab-work W4 failed.
-- The 'sold' CTE now also takes the booking authors of the window (a superset: a booking that is a
-- CRM sale's copy shows 0 credited). No figure changes — the credited counts come from
-- insights_work_credited as before; only the row appears.

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.insights_work(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid)')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('2459bda21091a380c737c4b24ebc7e00', 'f207466fafef25fc599fd4f7b92ae089')) THEN
    RAISE EXCEPTION 'insights_work changed since this migration was written — re-emit it from the live body';
  END IF;
END
$drift$;

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
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, m.role
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
  SELECT coalesce(jsonb_agg(jsonb_build_object('team_key', st.key, 'name', st.name, 'mode', st.leaderboard_mode)
                            ORDER BY st.key), '[]'::jsonb) AS j
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

COMMIT;
