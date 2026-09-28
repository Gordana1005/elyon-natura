-- ============================================================================
-- LEADERBOARD DAY — the TV board as one read: team roster × work ledger ×
-- sales × presence, per Skopje day, per board (owner rules, Mile 2026-09-28)
--
--   "On the leaderboard it should be shown everything literally, who was
--    online and working, who wasn't… if people logged and didn't make any
--    sales, they are still shown. The system needs to count time."
--   "The leaderboard can also have option to switch between prediction or
--    pending, the agents need to be mapped who works what."
--
-- Adds, read-side only (no table, no trigger, no backfill, nothing written):
--   leaderboard_day(p_day date, p_mode text) → jsonb
--       everything GET /api/leaderboard needs except the bonus rules and the
--       call counts; the pure mapping (bonus projection, legacy fields, sort)
--       lives in supabase/functions/api/leaderboard.ts
--
-- ── THE RULES (law, owner 2026-09-27/28) ────────────────────────────────────
-- 1 SOURCE WINS, TEAM IS SHOWN TOO. Which board an order feeds is decided by
--   orders.sale_source (migration 20260935000000), never by who sold it:
--     prediction  sale_source = 'elyon_crm'  (our agent made it in the CRM —
--                 a cold call of an existing client)
--     pending     sale_source IN ('altercpa', 'affiliate')  (it arrived
--                 through a lead intake)
--   A pending-team person who sells from a prediction list is on the
--   PREDICTION board as a guest; her badge still says her own (primary) team.
-- 2 EVERYONE ON THE TEAM ROSTER IS SHOWN, every day, sales or not:
--     members  active sales_people with a sales_team_members row valid on
--              p_day in a team whose sales_teams.leaderboard_mode = p_mode
--              (a closed membership keeps showing on its own past days even
--              after the person is deactivated)
--     guests   anyone else credited with a sale of this board's source that
--              day, or who WORKED it (a decision in the work ledger) — on
--              24.09 a pending-team agent made 24 prediction decisions without
--              a sale and would otherwise have been on neither board. Managers
--              land here too — management has no board of its own
--              (the per-package bonus still needs a sale; see leaderboard.ts)
--     extras   leaderboard_roster rows for (p_day, p_mode): Settings →
--              Leaderboard now only ADDS people; it can no longer hide anyone
-- 3 TIME per person per day from agent_presence_days (20260935000200):
--   online / active / idle / break minutes, first/last seen and active, idle
--   alerts; plus the first login of the day (shift_login_logs /
--   admin_login_logs), which is all there is for days before presence went
--   live on 2026-09-28. The live state (today only) is insights_overview's
--   rule, verbatim: a beat within 3 minutes → online (active) / idle / break,
--   otherwise offline; 'n/a' when the person has no CRM login at all.
-- 4 AlterCPA-only operators have no presence to see; the ledger's
--   last_decision_at (this board, this day) stands in for it.
-- 5 is_manager = sales_people.is_manager OR an admin/manager role — the
--   commission skill's "super-admin", who never earns. The bonus projection
--   itself is NOT computed here (leaderboard.ts, with the edge function's own
--   packageBonusRate / tierBonus — rule 6: the formulas do not move).
--
-- ── NUMBERS — the same definitions as insights_overview (20260936000000) ────
--   worked / sale_decisions / cancelled / trashed / callbacks
--            v_sales_work rows of the day for this board's source (CRM
--            decisions on elyon_crm orders for prediction; AlterCPA ledger
--            decisions + CRM decisions on lead orders for pending);
--            conversion = sale_decisions / worked
--   confirmed / sold_value_eur
--            sales on the SOLD clock: sold_at, else (unstamped) confirmed_at,
--            else created_at — disposition rows and monadon_legacy excluded,
--            credited to orders.sold_by_person_id
--   net_confirmed / net_value_eur / packages / bonus_orders
--            the subset still in confirmed / shipped / delivered / paid —
--            exactly the orders the old handler fed its bonus (returned and
--            cancelled-after-sale reverse themselves)
--   shipped / delivered / returned / lost / delivered_cash_mkd
--            where that day's sales stand now; cash = MEX COD of the
--            delivered ones that carry a MEX delivery (proven only)
--
-- ⚠ LIVE CREDIT FOR ALTERCPA APPROVALS (found 2026-09-28): the sold_* stamp
--   is written live only for CRM decisions (trg_orders_stamp_sold). An
--   AlterCPA approval is stamped by scripts/backfill-order-deciders.mjs,
--   which nothing schedules — so today's approvals carry sold_at NULL (and
--   confirmed_at NULL) until someone runs it. Without help the pending board
--   would read 0 all day. For an UNSTAMPED order only, this function dates the
--   sale by its AlterCPA approval (altercpa_leads.decided_at) and credits the
--   person on the day's v_sales_work sale row. Once the backfill stamps it,
--   the stamp wins (same person, by the backfill's own ledger rule). Counted
--   in summary.live_credited_sales so the gap stays visible.
--
-- Security: SECURITY DEFINER (the people/teams tables are owners-only under
-- RLS), EXECUTE for service_role only — the public TV route calls it from the
-- api edge function after validating its ?key= token. Aggregates and names
-- only: no phone, no address, no customer. Plus the read-only harness role,
-- like insights_overview (scripts/verify-attribution.mjs C4/C5).
--
-- plpgsql + EXECUTE … USING (the insights_overview pattern): every call is
-- planned with its real day bounds and mode, so the one-day index ranges are
-- used. Measured on live data 2026-09-28: 70–110 ms per board (22.09, 27.09,
-- 28.09, both modes).
-- ============================================================================

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.leaderboard_day(p_day date, p_mode text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  v_day   date := coalesce(p_day, (now() AT TIME ZONE 'Europe/Skopje')::date);
  v_today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_from  timestamptz;
  v_to    timestamptz;
  v_out   jsonb;
BEGIN
  IF p_mode IS NULL OR p_mode NOT IN ('prediction', 'pending') THEN
    RAISE EXCEPTION 'leaderboard_day: mode must be prediction or pending' USING ERRCODE = '22023';
  END IF;
  -- Skopje 00:00 of the day and the last microsecond before the next one
  -- (DST-exact: the timestamp is read as Europe/Skopje wall-clock time).
  v_from := v_day::timestamp AT TIME ZONE 'Europe/Skopje';
  v_to   := ((v_day + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond';

  EXECUTE $core$
WITH

-- ── the work ledger of the day, this board's source only ───────────────────
vw AS MATERIALIZED (
  SELECT v.at, v.person_id, v.via, v.order_id, v.outcome
  FROM public.v_sales_work v
  WHERE v.at BETWEEN $1::timestamptz AND $2::timestamptz
    AND CASE WHEN $4::text = 'prediction'
             THEN v.via = 'crm' AND v.sale_source = 'elyon_crm'
             ELSE v.via = 'altercpa' OR v.sale_source IN ('altercpa', 'affiliate') END
),
wk AS (
  SELECT vw.person_id,
         count(*)                                         AS worked,
         count(*) FILTER (WHERE vw.outcome = 'sale')      AS sale_decisions,
         count(*) FILTER (WHERE vw.outcome = 'cancel')    AS cancelled,
         count(*) FILTER (WHERE vw.outcome = 'trash')     AS trashed,
         count(*) FILTER (WHERE vw.outcome = 'callback')  AS callbacks,
         max(vw.at)                                       AS last_at
  FROM vw WHERE vw.person_id IS NOT NULL GROUP BY 1
),

-- ── the day's sales, on insights_overview's SOLD clock, this board's source ─
cand AS MATERIALIZED (
  SELECT o.id, o.status::text AS status, coalesce(o.price, 0)::numeric AS price, o.quantity,
         o.sold_at, o.sold_by_person_id, o.confirmed_at, o.created_at,
         o.mex_delivered_at, o.mex_cod_mkd
  FROM public.orders o
  WHERE (o.source_type IS NULL OR o.source_type <> 'monadon_legacy')
    AND CASE WHEN $4::text = 'prediction' THEN o.sale_source = 'elyon_crm'
             ELSE o.sale_source IN ('altercpa', 'affiliate') END
    AND coalesce(o.sale_source_detail, '') <> 'disposition'
    AND (o.sold_at IS NOT NULL OR o.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))
    AND (   o.sold_at BETWEEN $1::timestamptz AND $2::timestamptz
         OR (o.sold_at IS NULL AND o.confirmed_at BETWEEN $1::timestamptz AND $2::timestamptz)
         OR (o.sold_at IS NULL AND o.confirmed_at IS NULL AND o.created_at BETWEEN $1::timestamptz AND $2::timestamptz)
         OR (o.sold_at IS NULL AND o.id IN (
               SELECT l.order_id FROM public.altercpa_leads l
               WHERE l.decision IN ('approved', 'cancel_other') AND l.order_id IS NOT NULL
                 AND l.decided_at BETWEEN $1::timestamptz AND $2::timestamptz)))
),
sl AS MATERIALIZED (
  SELECT c.*, (c.sold_at IS NOT NULL) AS stamped,
         c.status IN ('confirmed', 'shipped', 'delivered', 'paid') AS net
  FROM (
    SELECT c0.*,
           CASE WHEN c0.sold_at IS NOT NULL THEN c0.sold_at
                ELSE coalesce(
                  (SELECT min(l.decided_at) FROM public.altercpa_leads l
                    WHERE l.order_id = c0.id AND l.decision IN ('approved', 'cancel_other')
                      AND upper(coalesce(l.geo, '')) = 'MK'
                      AND l.skip_reason IS DISTINCT FROM 'test_order'),
                  c0.confirmed_at, c0.created_at) END AS sale_at,
           CASE WHEN c0.sold_at IS NOT NULL THEN c0.sold_by_person_id
                ELSE (SELECT vw.person_id FROM vw
                       WHERE vw.order_id = c0.id AND vw.outcome = 'sale' AND vw.person_id IS NOT NULL
                       ORDER BY vw.at LIMIT 1) END AS pid
    FROM cand c0
  ) c
  WHERE c.sale_at BETWEEN $1::timestamptz AND $2::timestamptz
),
it AS (
  SELECT oi.order_id,
         jsonb_agg(jsonb_build_array(oi.price_per_unit, oi.quantity) ORDER BY oi.created_at, oi.id) AS lines,
         sum(coalesce(oi.quantity, 0)) AS units
  FROM public.order_items oi
  WHERE oi.order_id IN (SELECT sl.id FROM sl)
  GROUP BY 1
),
ps AS (
  SELECT sl.pid AS person_id,
         count(*)                                                  AS confirmed,
         coalesce(sum(sl.price), 0)                                AS sold_eur,
         count(*) FILTER (WHERE sl.net)                            AS net_confirmed,
         coalesce(sum(sl.price) FILTER (WHERE sl.net), 0)          AS net_eur,
         coalesce(sum(CASE WHEN it.order_id IS NOT NULL THEN it.units
                           ELSE coalesce(nullif(sl.quantity, 0), 1) END) FILTER (WHERE sl.net), 0) AS net_packages,
         count(*) FILTER (WHERE sl.status = 'shipped')             AS shipped,
         count(*) FILTER (WHERE sl.status IN ('paid', 'delivered')) AS delivered,
         count(*) FILTER (WHERE sl.status = 'returned')            AS returned,
         count(*) FILTER (WHERE sl.status IN ('cancelled', 'trashed')) AS lost,
         coalesce(sum(sl.mex_cod_mkd) FILTER (WHERE sl.status IN ('paid', 'delivered')
                                               AND sl.mex_delivered_at IS NOT NULL), 0) AS delivered_cash_mkd,
         count(*) FILTER (WHERE NOT sl.stamped)                    AS live_credited,
         coalesce(jsonb_agg(jsonb_build_object('p', sl.price, 'q', sl.quantity, 'i', coalesce(it.lines, '[]'::jsonb))
                            ORDER BY sl.sale_at, sl.id) FILTER (WHERE sl.net), '[]'::jsonb) AS bonus_orders
  FROM sl LEFT JOIN it ON it.order_id = sl.id
  WHERE sl.pid IS NOT NULL
  GROUP BY 1
),

-- ── who is on the board ────────────────────────────────────────────────────
mem AS (
  SELECT DISTINCT m.person_id
  FROM public.sales_team_members m
  JOIN public.sales_teams st ON st.key = m.team_key
  JOIN public.sales_people sp ON sp.id = m.person_id
  WHERE st.leaderboard_mode = $4::text
    AND m.valid_from <= $3::date AND coalesce(m.valid_to, 'infinity'::date) >= $3::date
    AND (sp.is_active OR m.valid_to IS NOT NULL)
),
pteam AS (
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, st.name AS team_name, st.leaderboard_mode AS team_mode
  FROM public.sales_team_members m
  JOIN public.sales_teams st ON st.key = m.team_key
  WHERE m.valid_from <= $3::date AND coalesce(m.valid_to, 'infinity'::date) >= $3::date
  ORDER BY m.person_id, m.is_primary DESC, m.valid_from DESC
),
extra AS (
  SELECT r.agent_id AS user_id, sp.id AS person_id
  FROM public.leaderboard_roster r
  LEFT JOIN public.sales_people sp ON sp.user_id = r.agent_id
  WHERE r.roster_date = $3::date AND r.mode = $4::text
),
ppl AS (
  SELECT x.person_id, max(x.user_id::text)::uuid AS user_id,
         bool_or(x.src = 'member') AS is_member,
         bool_or(x.src = 'guest')  AS guest,
         bool_or(x.src = 'extra')  AS is_extra
  FROM (
    SELECT mem.person_id, sp.user_id, 'member'::text AS src
      FROM mem JOIN public.sales_people sp ON sp.id = mem.person_id
    UNION ALL
    SELECT ps.person_id, sp.user_id, 'guest'
      FROM ps JOIN public.sales_people sp ON sp.id = ps.person_id
     WHERE ps.confirmed > 0
    UNION ALL
    SELECT wk.person_id, sp.user_id, 'guest'
      FROM wk JOIN public.sales_people sp ON sp.id = wk.person_id
     WHERE wk.worked > 0
    UNION ALL
    SELECT e.person_id, coalesce(sp.user_id, e.user_id), 'extra'
      FROM extra e LEFT JOIN public.sales_people sp ON sp.id = e.person_id
  ) x
  GROUP BY x.person_id, CASE WHEN x.person_id IS NULL THEN x.user_id END
),

-- ── time on the CRM that day (agent_presence_days) + the first login ───────
lg AS (
  SELECT u.user_id, min(u.at) AS first_login
  FROM (SELECT s.user_id, s.login_time AS at FROM public.shift_login_logs s WHERE s.shift_date = $3::date
        UNION ALL
        SELECT a.user_id, a.login_time FROM public.admin_login_logs a WHERE a.login_time BETWEEN $1::timestamptz AND $2::timestamptz) u
  WHERE u.user_id IN (SELECT ppl.user_id FROM ppl WHERE ppl.user_id IS NOT NULL)
  GROUP BY 1
),
rows0 AS (
  SELECT p.person_id, p.user_id,
         coalesce(sp.display_name, pf.full_name, 'Agent') AS name,
         pt.team_key, pt.team_name, pt.team_mode,
         p.is_member,
         (p.guest AND NOT p.is_member)                      AS is_guest,
         (p.is_extra AND NOT p.is_member)                   AS is_extra,
         (coalesce(sp.is_manager, false)
          OR EXISTS (SELECT 1 FROM public.user_roles r
                      WHERE r.user_id = p.user_id AND r.role::text IN ('admin', 'manager'))) AS is_manager,
         CASE WHEN p.user_id IS NULL THEN 'n/a'
              WHEN $5::boolean AND pr.last_state IN ('active', 'idle', 'break')
                   AND pr.last_seen_at >= now() - interval '3 minutes'
              THEN CASE pr.last_state WHEN 'active' THEN 'online' ELSE pr.last_state END
              ELSE 'offline' END                            AS state,
         pr.online_minutes, pr.active_minutes, pr.idle_minutes, pr.break_minutes,
         pr.first_seen_at, pr.last_seen_at, pr.first_active_at, pr.last_active_at, pr.idle_alerts,
         CASE WHEN $5::boolean AND pr.last_state = 'idle' AND pr.idle_streak_started_at IS NOT NULL
                   AND pr.last_seen_at >= now() - interval '3 minutes'
              THEN greatest(0, floor(extract(epoch FROM now() - pr.idle_streak_started_at) / 60))::int END AS idle_streak_min,
         lg.first_login,
         coalesce(wk.worked, 0) AS worked, coalesce(wk.sale_decisions, 0) AS sale_decisions,
         coalesce(wk.cancelled, 0) AS cancelled, coalesce(wk.trashed, 0) AS trashed,
         coalesce(wk.callbacks, 0) AS callbacks, wk.last_at,
         coalesce(ps.confirmed, 0) AS confirmed, coalesce(ps.sold_eur, 0) AS sold_eur,
         coalesce(ps.net_confirmed, 0) AS net_confirmed, coalesce(ps.net_eur, 0) AS net_eur,
         coalesce(ps.net_packages, 0) AS net_packages,
         coalesce(ps.shipped, 0) AS shipped, coalesce(ps.delivered, 0) AS delivered,
         coalesce(ps.returned, 0) AS returned, coalesce(ps.lost, 0) AS lost,
         coalesce(ps.delivered_cash_mkd, 0) AS delivered_cash_mkd,
         coalesce(ps.live_credited, 0) AS live_credited,
         coalesce(ps.bonus_orders, '[]'::jsonb) AS bonus_orders
  FROM ppl p
  LEFT JOIN public.sales_people sp ON sp.id = p.person_id
  LEFT JOIN public.profiles pf ON pf.user_id = p.user_id
  LEFT JOIN pteam pt ON pt.person_id = p.person_id
  LEFT JOIN public.agent_presence_days pr ON pr.user_id = p.user_id AND pr.day = $3::date
  LEFT JOIN lg ON lg.user_id = p.user_id
  LEFT JOIN wk ON wk.person_id = p.person_id
  LEFT JOIN ps ON ps.person_id = p.person_id
)
SELECT jsonb_build_object(
  'day', $3::date,
  'mode', $4::text,
  'is_today', $5::boolean,
  'generated_at', now(),
  'window', jsonb_build_object('from', $1::timestamptz, 'to_end', $2::timestamptz),
  'summary', jsonb_build_object(
    'people',           (SELECT count(*) FROM rows0),
    'members',          (SELECT count(*) FROM rows0 WHERE rows0.is_member),
    'guests',           (SELECT count(*) FROM rows0 WHERE rows0.is_guest),
    'extras',           (SELECT count(*) FROM rows0 WHERE rows0.is_extra),
    'managers',         (SELECT count(*) FROM rows0 WHERE rows0.is_manager),
    'online_now',       (SELECT count(*) FROM rows0 WHERE rows0.state IN ('online', 'idle')),
    'idle',             (SELECT count(*) FROM rows0 WHERE rows0.state = 'idle'),
    'on_break',         (SELECT count(*) FROM rows0 WHERE rows0.state = 'break'),
    'offline',          (SELECT count(*) FROM rows0 WHERE rows0.state = 'offline'),
    'no_login',         (SELECT count(*) FROM rows0 WHERE rows0.state = 'n/a'),
    'was_online',       (SELECT count(*) FROM rows0 WHERE coalesce(rows0.online_minutes, 0) > 0),
    'zero_sale_people', (SELECT count(*) FROM rows0 WHERE rows0.confirmed = 0),
    'worked',           (SELECT count(*) FROM vw),
    'unmapped_decisions', (SELECT count(*) FROM vw WHERE vw.person_id IS NULL),
    'sales',            (SELECT count(*) FROM sl),
    'sold_value_eur',   (SELECT round(coalesce(sum(sl.price), 0), 2) FROM sl),
    'unattributed_sales',     (SELECT count(*) FROM sl WHERE sl.pid IS NULL),
    'unattributed_value_eur', (SELECT round(coalesce(sum(sl.price), 0), 2) FROM sl WHERE sl.pid IS NULL),
    'live_credited_sales',    (SELECT count(*) FROM sl WHERE NOT sl.stamped AND sl.pid IS NOT NULL)),
  'rows', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'person_id',       r.person_id,
      'user_id',         r.user_id,
      'name',            r.name,
      'team_key',        r.team_key,
      'team_name',       r.team_name,
      'team_mode',       r.team_mode,
      'is_member',       r.is_member,
      'is_guest',        r.is_guest,
      'is_extra',        r.is_extra,
      'is_manager',      r.is_manager,
      'worked',          r.worked,
      'sale_decisions',  r.sale_decisions,
      'cancelled',       r.cancelled,
      'trashed',         r.trashed,
      'callbacks',       r.callbacks,
      'conversion',      CASE WHEN r.worked > 0 THEN round(r.sale_decisions::numeric / r.worked, 4) END,
      'confirmed',       r.confirmed,
      'sold_value_eur',  round(r.sold_eur, 2),
      'avg_order_value', CASE WHEN r.confirmed > 0 THEN round(r.sold_eur / r.confirmed, 2) ELSE 0 END,
      'net_confirmed',   r.net_confirmed,
      'net_value_eur',   round(r.net_eur, 2),
      'packages',        r.net_packages,
      'shipped',         r.shipped,
      'delivered',       r.delivered,
      'returned',        r.returned,
      'lost',            r.lost,
      'delivered_cash_mkd', round(r.delivered_cash_mkd),
      'live_credited',   r.live_credited,
      'bonus_orders',    r.bonus_orders,
      'last_decision_at', r.last_at,
      'presence', jsonb_build_object(
        'state',          r.state,
        'online_min',     coalesce(r.online_minutes, 0),
        'active_min',     coalesce(r.active_minutes, 0),
        'idle_min',       coalesce(r.idle_minutes, 0),
        'break_min',      coalesce(r.break_minutes, 0),
        'first_seen',     r.first_seen_at,
        'last_seen',      r.last_seen_at,
        'first_active',   r.first_active_at,
        'last_active',    r.last_active_at,
        'idle_alerts',    coalesce(r.idle_alerts, 0),
        'idle_streak_min', r.idle_streak_min,
        'first_login',    r.first_login))
      ORDER BY r.sold_eur DESC, r.confirmed DESC, r.worked DESC, coalesce(r.active_minutes, 0) DESC, r.name)
    FROM rows0 r), '[]'::jsonb)
)

  $core$
  INTO v_out
  USING v_from, v_to, v_day, p_mode, (v_day = v_today);

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.leaderboard_day(date, text) IS
  'TV leaderboard for one Europe/Skopje day and one board (prediction = sale_source elyon_crm, pending = altercpa/affiliate): team members of that board + guests who worked or sold its source + Settings extras, each with the day''s work-ledger counts, sales on the SOLD clock, where those sales stand now, presence minutes/state and last decision. Read-only. The bonus projection is done by the api (leaderboard.ts). Contract: migration 20260939000000.';

REVOKE ALL ON FUNCTION public.leaderboard_day(date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leaderboard_day(date, text) TO service_role;

-- The read-only verification harness (scripts/verify-attribution.mjs C4/C5)
-- calls this through the Management API with read_only: true, which runs as
-- supabase_read_only_user (pg_read_all_data). EXECUTE on a function that only
-- reads widens nothing. Conditional so a fresh local database still migrates.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.leaderboard_day(date, text) TO supabase_read_only_user;
  END IF;
END
$grant$;

NOTIFY pgrst, 'reload schema';
