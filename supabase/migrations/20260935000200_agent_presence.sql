-- ============================================================================
-- AGENT PRESENCE — time on the CRM, and the 30-minute idle alert
-- (owner ask, Mile 2026-09-27)
--
--   "On the leaderboard it should show everything: who was online and working,
--    who wasn't; people who logged in and didn't make any sales are still
--    shown. The system needs to count time. Every 30 minutes, if nothing is
--    done on the screen and the tab is open, the user needs to get a
--    notification that it has been 30 minutes inactive doing nothing, and the
--    superadmins should get those too."
--
-- "Superadmins" there = the business owners (public.business_owners /
-- is_business_owner(), migration 20260934000000) — NOT the admin role, which
-- fans out to eight roles and nine logins.
--
-- WHAT THIS ADDS
--   agent_presence_days            one row per person per Europe/Skopje day:
--                                  minutes online / active / idle / on break,
--                                  first & last seen, the running idle streak
--                                  and how many idle alerts it produced
--   presence_heartbeat(state)      the ONLY writer a browser can reach. The
--                                  SPA calls it through the api edge function
--                                  (POST /presence/activity) about once a
--                                  minute while the app is open — visible tab
--                                  or not — with 'active' (keyboard/mouse/
--                                  touch in the last 60 s, or a call in
--                                  progress) or 'idle'
--   presence_record_beat(...)      the engine behind it, with an explicit
--                                  clock. Service role only (tests, tooling)
--   presence_alert_recipients()    resolves the recipients setting
--   presence_close_stale_sessions  pg_cron, every 2 min: no beat for > 3 min
--                                  → last_state 'offline', idle streak dropped
--
-- DESIGN NOTES
--   * NOT profiles.last_seen_at. That column is the lead-distribution
--     engine's "online" signal (2-minute window, 20260921000000 /
--     20260931000001), bumped by POST /presence/heartbeat from VISIBLE tabs
--     only. These beats also run in hidden tabs, so they must never feed it —
--     a forgotten background tab would start receiving leads.
--   * The break button is the truth for breaks. While shift_breaks has an
--     open row for the person (break_end IS NULL, started in the last 16 h),
--     every beat counts as 'break' whatever the browser reports. Break time
--     never starts or extends an idle streak, so it can never alert. A browser
--     claiming 'break' with no open row is counted as 'idle'.
--   * One minute per beat, deduplicated on the last COUNTED beat: a beat less
--     than 50 s after it adds nothing (two open tabs, a double fire). 110-180 s
--     after it credits 2 minutes (one beat lost to background-tab throttling;
--     presence was continuous — the sweep closes a session only after 3 min).
--     Any longer gap credits only the current minute and starts a NEW session
--     (idle streak dropped) — the same outcome as the sweep, so a late or
--     missed cron run can never stretch an old streak across the gap.
--   * Active wins: a second tab that saw input inside a minute an idle tab
--     already counted moves that minute from idle to active and resets the
--     streak. online = active + idle + break, always (CHECK below).
--   * The idle streak starts 60 s before the first idle beat — the SPA only
--     reports idle after 60 s without input. It carries over Skopje midnight
--     while the session is continuous, and is dropped when the session goes
--     offline (a closed laptop is not "tab open doing nothing").
--   * Alerts fire when the streak crosses each multiple of the threshold
--     (30, 60, 90 … minutes) exactly once — idle_alerted_multiple remembers
--     the last one. Each alert = one notification to the person + one to each
--     recipient (default: the business owners), never the person twice.
--   * Who can trigger an alert (presence_idle_alert_scope, default 'agents'):
--     people holding an agent role who are NOT admin, manager or business
--     owner. Admin fans out to every agent role, so "has an agent role" alone
--     would put all nine admins and the owners themselves on the alert list;
--     warehouse staff pack parcels away from the screen. Their minutes are
--     still counted — they just never alert. 'all' alerts for every staff
--     login.
--   * When (presence_idle_alert_hours, default 07:00-21:59 Skopje): a tab left
--     open overnight must not pile two alerts an hour into six owners' bells.
--     Outside the hours minutes are still counted and the alert marker is left
--     alone, so the first beat inside the hours sends ONE catch-up alert.
--   * Notifications contract (elyon-notifications skill): English
--     title/message in the row + meta.i18n ('notif.inactivity' /
--     'notif.inactivitySelf') with the interpolation vars. notifications.type
--     is free text — verified live 2026-09-27 the table carries no CHECK on it
--     (only notifications_pkey), so the new 'inactivity' type needs no
--     constraint change.
--   * A failed notification insert never costs the minute just counted: the
--     inserts run in their own subtransaction and only RAISE WARNING.
--
-- KNOBS (app_settings, jsonb — editable by admins like the unpaid chase ones)
--   presence_idle_alert_minutes     30        alert every N idle minutes; 0 = off
--   presence_idle_alert_recipients  "owners"  who else is told: "owners",
--                                             "admins", "none", a user uuid, or
--                                             an array mixing them
--   presence_idle_alert_scope       "agents"  "agents" | "all"
--   presence_idle_alert_hours       {"from":7,"to":22}  Skopje hours [from,to);
--                                             from > to wraps midnight,
--                                             from = to = all day
--
-- Security: the table is readable by the person themself and by the business
-- owners; nobody writes it except these functions. presence_heartbeat is the
-- one function `authenticated` may execute, and it refuses non-staff
-- (is_internal_staff) and deactivated profiles on its own, so a direct
-- PostgREST call is no stronger than the edge route.
--
-- Deploy order: this migration → the api edge function (POST
-- /presence/activity, GET /presence/day) → the SPA.
-- ============================================================================

-- Fail fast rather than queue other sessions behind this migration's locks
-- (the auth.users FK below briefly locks auth.users). Transaction-scoped.
SET LOCAL lock_timeout = '5s';

-- ── 1. Knobs ────────────────────────────────────────────────────────────────
INSERT INTO public.app_settings (key, value) VALUES
  ('presence_idle_alert_minutes',    '30'::jsonb),
  ('presence_idle_alert_recipients', '"owners"'::jsonb),
  ('presence_idle_alert_scope',      '"agents"'::jsonb),
  ('presence_idle_alert_hours',      '{"from": 7, "to": 22}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 2. The table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_presence_days (
  user_id                uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day                    date        NOT NULL,           -- Europe/Skopje calendar day
  online_minutes         integer     NOT NULL DEFAULT 0, -- = active + idle + break
  active_minutes         integer     NOT NULL DEFAULT 0,
  idle_minutes           integer     NOT NULL DEFAULT 0,
  break_minutes          integer     NOT NULL DEFAULT 0,
  first_seen_at          timestamptz,
  last_seen_at           timestamptz,                    -- last COUNTED beat
  first_active_at        timestamptz,
  last_active_at         timestamptz,
  last_state             text,
  idle_streak_started_at timestamptz,
  idle_alerted_multiple  integer     NOT NULL DEFAULT 0, -- last threshold multiple alerted in this streak
  idle_alerts            integer     NOT NULL DEFAULT 0, -- alerts raised this day
  PRIMARY KEY (user_id, day),
  CONSTRAINT agent_presence_days_state_check
    CHECK (last_state IS NULL OR last_state IN ('active', 'idle', 'break', 'offline')),
  CONSTRAINT agent_presence_days_minutes_check
    CHECK (active_minutes >= 0 AND idle_minutes >= 0 AND break_minutes >= 0
           AND online_minutes = active_minutes + idle_minutes + break_minutes)
)
-- Rewritten about once a minute per person: leave room on the page so those
-- updates stay HOT (no indexed column ever changes).
WITH (fillfactor = 80);

-- The owners' day view and the stale sweep both read by day.
CREATE INDEX IF NOT EXISTS idx_agent_presence_days_day
  ON public.agent_presence_days (day);

COMMENT ON TABLE public.agent_presence_days IS
  'Per person per Europe/Skopje day: minutes with Elyon CRM open (online = active + idle + break), first/last seen, the running idle streak and idle alerts raised. Written ONLY by presence_heartbeat()/presence_record_beat() and the presence-stale-sweep cron (migration 20260935000200). Readable by the person and by the business owners.';
COMMENT ON COLUMN public.agent_presence_days.last_seen_at IS
  'Instant of the last COUNTED beat (beats < 50 s apart are deduplicated). Not profiles.last_seen_at, which is the lead-distribution online signal.';
COMMENT ON COLUMN public.agent_presence_days.idle_streak_started_at IS
  'Start of the current uninterrupted idle stretch (60 s before the first idle beat). NULL while active, on break or offline.';
COMMENT ON COLUMN public.agent_presence_days.idle_alerted_multiple IS
  'Highest threshold multiple (1 = 30 min, 2 = 60 min …) already alerted in the current idle streak. Reset with the streak.';

-- ── 3. RLS — the person sees their own days, the owners see everyone ────────
ALTER TABLE public.agent_presence_days ENABLE ROW LEVEL SECURITY;

-- Default privileges hand every new public table to anon/authenticated in
-- full; take that back so SELECT (through the policies) is all that remains.
-- PUBLIC too — `authenticated` inherits it.
REVOKE ALL ON public.agent_presence_days FROM PUBLIC;
REVOKE ALL ON public.agent_presence_days FROM anon, authenticated;
GRANT SELECT ON public.agent_presence_days TO authenticated;
GRANT ALL ON public.agent_presence_days TO service_role;

DROP POLICY IF EXISTS agent_presence_days_select_own ON public.agent_presence_days;
CREATE POLICY agent_presence_days_select_own ON public.agent_presence_days
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS agent_presence_days_select_owners ON public.agent_presence_days;
CREATE POLICY agent_presence_days_select_owners ON public.agent_presence_days
  FOR SELECT TO authenticated
  -- Scalar sub-select: evaluated once per statement, not per row.
  USING ((SELECT public.is_business_owner(auth.uid())));

-- ── 4. Recipients ───────────────────────────────────────────────────────────
-- Resolves presence_idle_alert_recipients: a string or an array of strings,
-- each "owners" (public.business_owners), "admins" (the admin role) or a user
-- uuid. Anything else — "none", garbage — resolves to nobody.
CREATE OR REPLACE FUNCTION public.presence_alert_recipients(p_spec jsonb)
RETURNS TABLE (user_id uuid)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH items AS (
    SELECT lower(btrim(x #>> '{}')) AS v
      FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(p_spec) = 'array' THEN p_spec
                  ELSE jsonb_build_array(p_spec) END
           ) AS x
     WHERE jsonb_typeof(x) = 'string'
  )
  SELECT b.user_id
    FROM public.business_owners b
   WHERE EXISTS (SELECT 1 FROM items WHERE v = 'owners')
  UNION
  SELECT ur.user_id
    FROM public.user_roles ur
   WHERE ur.role = 'admin'
     AND EXISTS (SELECT 1 FROM items WHERE v = 'admins')
  UNION
  -- CASE, not a bare cast: a cast in the select list is not guaranteed to run
  -- only on rows the WHERE kept.
  SELECT CASE WHEN v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN v::uuid END
    FROM items
   WHERE v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$fn$;

COMMENT ON FUNCTION public.presence_alert_recipients(jsonb) IS
  'Resolves the presence_idle_alert_recipients setting ("owners" | "admins" | user uuid, or an array of them) to user ids. Internal to the presence engine.';

REVOKE ALL ON FUNCTION public.presence_alert_recipients(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.presence_alert_recipients(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.presence_alert_recipients(jsonb) TO service_role;

-- ── 5. The engine ───────────────────────────────────────────────────────────
-- One beat for one person at an explicit instant. presence_heartbeat() is the
-- only caller a browser can reach (it passes auth.uid() and now()); the clock
-- parameter exists so the rules can be tested deterministically, which is why
-- EXECUTE stays with service_role.
CREATE OR REPLACE FUNCTION public.presence_record_beat(
  p_uid   uuid,
  p_state text,
  p_now   timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _day        date;
  _hour       integer;
  _on_break   boolean;
  _state      text;
  _row        public.agent_presence_days%ROWTYPE;
  _prev       public.agent_presence_days%ROWTYPE;
  _inserted   boolean;
  _gap        interval;
  _credit     integer := 0;
  _resumed    boolean := false;
  _upgrade    boolean := false;
  _streak     timestamptz;
  _done       integer;
  _streak_min integer := 0;
  _raw        text;
  _threshold  integer;
  _multiple   integer;
  _alert_min  integer;
  _should     boolean := false;
  _scope      text;
  _eligible   boolean;
  _hours      jsonb;
  _from       integer;
  _to         integer;
  _in_window  boolean;
  _recipients jsonb;
  _name       text;
BEGIN
  IF p_uid IS NULL OR p_now IS NULL THEN
    RAISE EXCEPTION 'presence_record_beat: user and clock are required'
      USING ERRCODE = '22004';
  END IF;
  IF p_state IS NULL OR p_state NOT IN ('active', 'idle', 'break') THEN
    RAISE EXCEPTION 'presence: invalid state %', COALESCE(p_state, 'NULL')
      USING ERRCODE = '22023';
  END IF;

  _day  := (p_now AT TIME ZONE 'Europe/Skopje')::date;
  _hour := extract(hour FROM (p_now AT TIME ZONE 'Europe/Skopje'))::integer;

  -- 1. Effective state — the break button decides breaks. The 16 h bound
  --    keeps a break somebody forgot to end from hiding them for ever.
  --    (idx_shift_breaks_one_open_per_user makes this an index probe.)
  _on_break := EXISTS (
    SELECT 1
      FROM public.shift_breaks b
     WHERE b.user_id = p_uid
       AND b.break_end IS NULL
       AND b.break_start <= p_now
       AND b.break_start >  p_now - interval '16 hours'
  );
  _state := CASE
    WHEN _on_break          THEN 'break'
    WHEN p_state = 'break'  THEN 'idle'  -- a break the button never recorded is not a break
    ELSE p_state
  END;

  -- 2. Today's row. The first beat of a Skopje day carries a still-running
  --    idle streak over midnight, so the streak (and its alert marker) stay
  --    true for a session that simply crossed 00:00.
  INSERT INTO public.agent_presence_days (user_id, day)
  VALUES (p_uid, _day)
  ON CONFLICT (user_id, day) DO NOTHING;
  _inserted := FOUND;

  IF _inserted THEN
    SELECT * INTO _prev
      FROM public.agent_presence_days
     WHERE user_id = p_uid AND day = _day - 1;
    IF FOUND
       AND _prev.last_state = 'idle'
       AND _prev.idle_streak_started_at IS NOT NULL
       AND _prev.last_seen_at > p_now - interval '3 minutes'
    THEN
      UPDATE public.agent_presence_days
         SET idle_streak_started_at = _prev.idle_streak_started_at,
             idle_alerted_multiple  = _prev.idle_alerted_multiple
       WHERE user_id = p_uid AND day = _day;
    END IF;
  END IF;

  -- Serialise concurrent beats of one person (two tabs firing together).
  SELECT * INTO _row
    FROM public.agent_presence_days
   WHERE user_id = p_uid AND day = _day
     FOR UPDATE;

  -- 3. How many minutes does this beat credit?
  IF _row.last_seen_at IS NULL THEN
    _credit := 1;
  ELSE
    _gap := p_now - _row.last_seen_at;
    IF _gap < interval '50 seconds' THEN
      _credit := 0;                              -- deduplicated
    ELSIF _gap < interval '110 seconds' THEN
      _credit := 1;
    ELSIF _gap < interval '180 seconds' THEN
      _credit := 2;                              -- one beat lost, still continuous
    ELSE
      _credit  := 1;                             -- back after a gap: this minute only,
      _resumed := true;                          -- and it is a NEW session
    END IF;
  END IF;

  -- 4. The idle streak. A session that resumes after > 3 min of silence
  --    starts clean — exactly what the stale sweep would have done, so a late
  --    or missed sweep can never stretch an old streak across the gap.
  _streak := CASE WHEN _resumed THEN NULL ELSE _row.idle_streak_started_at END;
  _done   := CASE WHEN _resumed THEN 0    ELSE _row.idle_alerted_multiple  END;

  IF _credit = 0 THEN
    -- Inside the dedupe window nothing is counted, but input still matters.
    IF _state IN ('active', 'break') THEN
      _streak := NULL;
      _done   := 0;
    END IF;
    IF _state = 'active' AND _row.last_state = 'idle' AND _row.idle_minutes > 0 THEN
      _upgrade := true;  -- active wins the minute an idle tab already counted
    END IF;
  ELSIF _state = 'idle' THEN
    _streak := COALESCE(_streak, p_now - interval '60 seconds');
  ELSE
    _streak := NULL;
    _done   := 0;
  END IF;

  IF _state = 'idle' AND _streak IS NOT NULL THEN
    _streak_min := GREATEST(floor(extract(epoch FROM (p_now - _streak)) / 60)::integer, 0);
  END IF;

  -- 5. Alert? Settings are read defensively: a hand-edited value that is not
  --    a number must never make every beat of every agent fail.
  SELECT value #>> '{}' INTO _raw
    FROM public.app_settings WHERE key = 'presence_idle_alert_minutes';
  _threshold := CASE WHEN _raw ~ '^\s*\d{1,5}\s*$' THEN btrim(_raw)::integer ELSE 30 END;

  IF _threshold > 0 AND _state = 'idle' AND _streak_min >= _threshold THEN
    _multiple := _streak_min / _threshold;
    IF _multiple > _done THEN
      SELECT lower(btrim(value #>> '{}')) INTO _scope
        FROM public.app_settings WHERE key = 'presence_idle_alert_scope';
      _eligible := CASE
        WHEN COALESCE(_scope, 'agents') = 'all' THEN true
        ELSE EXISTS (
               SELECT 1 FROM public.user_roles r
                WHERE r.user_id = p_uid
                  AND r.role IN ('agent', 'pending_agent', 'prediction_agent', 'inbound_agent')
             )
             AND NOT EXISTS (
               SELECT 1 FROM public.user_roles r
                WHERE r.user_id = p_uid AND r.role IN ('admin', 'manager')
             )
             AND NOT public.is_business_owner(p_uid)
      END;

      SELECT value INTO _hours
        FROM public.app_settings WHERE key = 'presence_idle_alert_hours';
      _from := CASE WHEN (_hours ->> 'from') ~ '^\s*\d{1,2}\s*$'
                    THEN LEAST(btrim(_hours ->> 'from')::integer, 24) ELSE 0 END;
      _to   := CASE WHEN (_hours ->> 'to') ~ '^\s*\d{1,2}\s*$'
                    THEN LEAST(btrim(_hours ->> 'to')::integer, 24) ELSE 24 END;
      _in_window := CASE
        WHEN _from < _to THEN _hour >= _from AND _hour < _to
        WHEN _from > _to THEN _hour >= _from OR  _hour < _to   -- wraps midnight
        ELSE true                                              -- from = to: all day
      END;

      IF NOT _eligible THEN
        _done := _multiple;          -- never alerts; keep the marker current
      ELSIF _in_window THEN
        _should    := true;
        _done      := _multiple;
        _alert_min := _multiple * _threshold;
      END IF;
      -- Eligible but outside the hours: the marker stays put, so the first
      -- beat inside the hours sends one catch-up alert.
    END IF;
  END IF;

  -- 6. Write the day.
  UPDATE public.agent_presence_days d SET
    online_minutes  = d.online_minutes + _credit,
    active_minutes  = d.active_minutes
                      + CASE WHEN _state = 'active' THEN _credit ELSE 0 END
                      + CASE WHEN _upgrade THEN 1 ELSE 0 END,
    idle_minutes    = d.idle_minutes
                      + CASE WHEN _state = 'idle' THEN _credit ELSE 0 END
                      - CASE WHEN _upgrade THEN 1 ELSE 0 END,
    break_minutes   = d.break_minutes
                      + CASE WHEN _state = 'break' THEN _credit ELSE 0 END,
    first_seen_at   = COALESCE(d.first_seen_at, p_now),
    last_seen_at    = CASE WHEN _credit > 0 THEN p_now ELSE d.last_seen_at END,
    first_active_at = CASE WHEN _state = 'active' THEN COALESCE(d.first_active_at, p_now)
                           ELSE d.first_active_at END,
    last_active_at  = CASE WHEN _state = 'active' THEN p_now ELSE d.last_active_at END,
    -- Latest state wins, except that a deduplicated idle beat never overrides
    -- the minute another tab already counted.
    last_state      = CASE WHEN _credit > 0 OR _state <> 'idle' THEN _state
                           ELSE d.last_state END,
    idle_streak_started_at = _streak,
    idle_alerted_multiple  = _done,
    idle_alerts     = d.idle_alerts + CASE WHEN _should THEN 1 ELSE 0 END
  WHERE d.user_id = p_uid AND d.day = _day;

  -- 7. Tell them — the person, and the recipients (default: the owners).
  IF _should THEN
    BEGIN
      SELECT NULLIF(btrim(p.full_name), '') INTO _name
        FROM public.profiles p WHERE p.user_id = p_uid;
      _name := COALESCE(_name, 'A team member');

      INSERT INTO public.notifications (user_id, type, title, message, link, meta)
      VALUES (
        p_uid,
        'inactivity',
        'Inactive for ' || _alert_min || ' minutes',
        'Nothing has been done on the screen for ' || _alert_min
          || ' minutes. If you are on a break, press Take Break.',
        NULL,
        jsonb_build_object(
          'i18n',      'notif.inactivitySelf',
          'minutes',   _alert_min,
          'self',      true,
          'subjectId', p_uid,
          'day',       _day
        )
      );

      SELECT value INTO _recipients
        FROM public.app_settings WHERE key = 'presence_idle_alert_recipients';

      INSERT INTO public.notifications (user_id, type, title, message, link, meta)
      SELECT r.user_id,
             'inactivity',
             _name || ' — inactive ' || _alert_min || ' min',
             _name || ' has had Elyon CRM open with nothing done on the screen for '
               || _alert_min || ' minutes.',
             NULL,
             jsonb_build_object(
               'i18n',      'notif.inactivity',
               'name',      _name,
               'minutes',   _alert_min,
               'subjectId', p_uid,
               'day',       _day
             )
        FROM public.presence_alert_recipients(COALESCE(_recipients, '"owners"'::jsonb)) r
       WHERE r.user_id IS NOT NULL
         AND r.user_id <> p_uid
         AND EXISTS (
               SELECT 1 FROM public.profiles p
                WHERE p.user_id = r.user_id AND p.is_active
             );
    EXCEPTION WHEN OTHERS THEN
      -- The alert must never cost the minute that was just counted.
      RAISE WARNING 'presence alert for % failed: % (%)', p_uid, SQLERRM, SQLSTATE;
    END;
  END IF;

  RETURN jsonb_build_object(
    'day',                 _day,
    'state',               _state,
    'on_break',            _on_break,
    'counted_minutes',     _credit,
    'idle_minutes_streak', _streak_min,
    'should_alert',        _should,
    'alert_minutes',       _alert_min,
    'threshold_minutes',   _threshold
  );
END;
$fn$;

COMMENT ON FUNCTION public.presence_record_beat(uuid, text, timestamptz) IS
  'Presence engine: records one beat for one person at an explicit instant (see migration 20260935000200 for the rules). Service role only — browsers reach it through presence_heartbeat(), which passes auth.uid() and now().';

REVOKE ALL ON FUNCTION public.presence_record_beat(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.presence_record_beat(uuid, text, timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.presence_record_beat(uuid, text, timestamptz) TO service_role;

-- ── 6. The browser's door ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.presence_heartbeat(p_state text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'presence_heartbeat: not signed in' USING ERRCODE = '28000';
  END IF;
  -- Staff only. An affiliate-only login is an external partner with no
  -- presence to count; the edge function's hard wall already refuses it, this
  -- covers a direct PostgREST call.
  IF NOT public.is_internal_staff(_uid) THEN
    RAISE EXCEPTION 'presence_heartbeat: staff only' USING ERRCODE = '42501';
  END IF;
  -- A deactivated login is not counted (its session may outlive the switch).
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.user_id = _uid AND p.is_active
  ) THEN
    RETURN jsonb_build_object('skipped', 'inactive_profile', 'should_alert', false);
  END IF;
  RETURN public.presence_record_beat(_uid, p_state, now());
END;
$fn$;

COMMENT ON FUNCTION public.presence_heartbeat(text) IS
  'The SPA''s once-a-minute activity beat (via POST /api/presence/activity): p_state = active | idle | break. Counts the minute for auth.uid(), honours the break button, and raises the idle alerts. Staff only. Returns {state, idle_minutes_streak, should_alert, alert_minutes, …}.';

REVOKE ALL ON FUNCTION public.presence_heartbeat(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.presence_heartbeat(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.presence_heartbeat(text) TO authenticated, service_role;

-- ── 7. Closing sessions nobody closed ──────────────────────────────────────
-- A closed tab, a sleeping laptop or a dropped network sends no "goodbye";
-- after 3 minutes without a beat the session is offline and its idle streak
-- is over. Cheap: the day index narrows it to the last few days' rows.
CREATE OR REPLACE FUNCTION public.presence_close_stale_sessions(p_now timestamptz DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _now timestamptz := COALESCE(p_now, now());
  _n   integer;
BEGIN
  UPDATE public.agent_presence_days
     SET last_state             = 'offline',
         idle_streak_started_at = NULL,
         idle_alerted_multiple  = 0
   WHERE day >= (_now AT TIME ZONE 'Europe/Skopje')::date - 2
     AND last_state IN ('active', 'idle', 'break')
     AND last_seen_at < _now - interval '3 minutes';
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$fn$;

COMMENT ON FUNCTION public.presence_close_stale_sessions(timestamptz) IS
  'pg_cron presence-stale-sweep (every 2 min): marks sessions with no beat for > 3 min offline and drops their idle streak. Returns the number closed.';

REVOKE ALL ON FUNCTION public.presence_close_stale_sessions(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.presence_close_stale_sessions(timestamptz) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.presence_close_stale_sessions(timestamptz) TO service_role;

-- ── 8. Schedule ────────────────────────────────────────────────────────────
-- Every 2 minutes, all day: no local-time gate, so nothing here depends on
-- DST (the rule is "3 minutes since the last beat", an absolute interval).
-- No pg_net — this job calls nothing external.
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'presence-stale-sweep') THEN
    PERFORM cron.unschedule('presence-stale-sweep');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'presence-stale-sweep', '*/2 * * * *',
  $job$SELECT public.presence_close_stale_sessions();$job$
);

NOTIFY pgrst, 'reload schema';
