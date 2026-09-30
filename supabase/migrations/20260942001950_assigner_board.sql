-- ============================================================================
-- THE ASSIGNER'S LIVE AGENT BOARD — assigner_board() (30.09.2026)
--
-- Owner decisions 29.09 (plan "Assigner redesign", Part A1): the agent grid on
-- /assigner shows ALL profiles, online first, with live counts that drop within
-- seconds as agents work. GET /api/assigner/board polls this every 5 s (and on
-- every `assigner` realtime broadcast), so it must stay cheap: every count below
-- rides an existing partial index over a tiny assigned set.
--
-- assigner_board() → jsonb
--   generated_at
--   agents[]  EVERY active profile holding a staff role (an affiliate-only partner
--             login is not staff and is left out; admins and managers are in):
--     user_id, full_name, roles[], is_admin, is_manager,
--     team_key / team_name   the sales-team membership valid today (Skopje date),
--                            primary first (the insights_work rule)
--     online                 last_seen_at within 2 minutes (GET /agents/online)
--     in_call                online AND voip_state in (dialing, in_call) AND
--                            voip_state_at within 3 minutes (GET /agents/online)
--     last_seen_at
--     shift {start, end}     today's shift by the SKOPJE date ("HH:MM"), the
--                            00:00-00:00 "no active shift" marker dropped; with two
--                            shifts the envelope (earliest start, latest end)
--     pendings               THE canonical lead load — assigned_pending_counts():
--                            pending | take | call_again on lead sources
--       pendings_pending, pendings_take      its pending / take parts
--     call_agains            call_agains_orders (lead orders in call_again — the
--                            call_again part of `pendings`) + call_agains_members
--                            (members with call_again_since, not completed)
--     list_open              assigned members not completed (includes the
--                            call-again members above)
--     list_parked            … of them parked: in_call_again_until > now()
--     list_assigned          every member stamped with the agent (done included)
--     worked_today           decisions today (Skopje day) — public.v_sales_work,
--                            the one "Обработени" ledger (CRM + AlterCPA panel),
--                            mapped to the login through sales_people.user_id
--   totals
--     agents, online, in_call
--     pendings_unassigned            lead sources, status pending, no agent
--     call_agains_unassigned         = _orders (lead call_again, no agent)
--                                      + _members (open call-again, no agent)
--     oldest_call_again_since        the oldest of those unassigned call-agains
--     worked_today                   Σ agents.worked_today (people with a login)
--
-- Also here:
--   idx_segment_members_open_call_again   tiny partial index (≈400 rows) for the
--       unassigned member call-agains (board totals, GET /call-agains, the
--       distribute pool) — without it each poll scanned all 113k members
--   agent_workloads() re-emitted: orders_open now counts LEAD SOURCES only — the
--       one load definition (lead rule 6); it counted every source, e.g. a
--       prediction agent's `manual` pendings. Its only caller is GET
--       /agents/online. Drift-guarded against the live body.
--
-- Access: service role only (the api gates the route: module assigner + admin /
-- manager).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS idx_segment_members_open_call_again
  ON public.prediction_segment_members (call_again_since)
  WHERE call_again_since IS NOT NULL AND NOT is_completed;

CREATE OR REPLACE FUNCTION public.assigner_board()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
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
  SELECT DISTINCT ON (sp.user_id) sp.user_id, m.team_key, t.name AS team_name
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
         tm.team_key, tm.team_name,
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
$fn$;

COMMENT ON FUNCTION public.assigner_board() IS
  'GET /api/assigner/board (20260942001950): every active staff profile with presence (online = last_seen 2 min, in_call = voip_state 3 min), roles, team, today''s Skopje shift, the canonical lead load (pending|take|call_again on lead sources, as assigned_pending_counts), call-agains (lead orders + member callbacks), list open / parked / assigned, decisions today (v_sales_work); totals: unassigned lead pendings, unassigned call-agains (orders + members, oldest), online / in call. Polled every 5 s.';

REVOKE ALL ON FUNCTION public.assigner_board() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assigner_board() TO service_role;

-- ── agent_workloads(): orders_open = the canonical LEAD load ───────────────
DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.agent_workloads()')
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('9ecf0277397d4a80762a4e154dd26374', 'f518c173a75b9e500bd15c51f1f966ed')) THEN
    RAISE EXCEPTION 'agent_workloads() changed since this migration was written — re-emit it from the live body';
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.agent_workloads()
 RETURNS TABLE(agent_id uuid, orders_open integer, members_assigned integer, members_open integer, members_parked integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH o AS (
    SELECT assigned_agent_id AS aid, COUNT(*)::int AS orders_open
    FROM public.orders
    WHERE assigned_agent_id IS NOT NULL
      AND status IN ('pending', 'take', 'call_again')
      -- lead sources only: the one load definition (20260942001950)
      AND source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')
    GROUP BY 1
  ),
  m AS (
    SELECT assigned_agent_id AS aid,
           COUNT(*)::int                                            AS members_assigned,
           COUNT(*) FILTER (WHERE NOT is_completed)::int            AS members_open,
           COUNT(*) FILTER (WHERE NOT is_completed
                              AND in_call_again_until IS NOT NULL
                              AND in_call_again_until > now())::int AS members_parked
    FROM public.prediction_segment_members
    WHERE assigned_agent_id IS NOT NULL
    GROUP BY 1
  )
  SELECT COALESCE(o.aid, m.aid) AS agent_id,
         COALESCE(o.orders_open, 0),
         COALESCE(m.members_assigned, 0),
         COALESCE(m.members_open, 0),
         COALESCE(m.members_parked, 0)
  FROM o FULL OUTER JOIN m ON m.aid = o.aid;
$function$;

COMMENT ON FUNCTION public.agent_workloads() IS
  'Per-agent load for GET /agents/online: orders_open = assigned INBOUND LEADS still in the lifecycle (pending|take|call_again on lead sources — the one definition, as assigned_pending_counts(); lead-source filter added 20260942001950), and prediction members assigned / open / parked.';

COMMIT;

NOTIFY pgrst, 'reload schema';
