-- ============================================================================
-- Idle alerts follow the access levels: "owners" = can_see_revenue + the agent's department admins
-- (owner's decisions, 02.10.2026 evening — access levels 20260947001600)
-- ============================================================================
-- What:
--   1. presence_alert_recipients(jsonb) — the "owners" group of presence_idle_alert_recipients (live
--      value: "owners") is now every ACTIVE profile with can_see_revenue(uid): super_admin / owner /
--      finance / administrator, company-wide. Was: public.business_owners + every active admin
--      (20260939000500). "admins" and a user uuid resolve exactly as before.
--   2. NEW presence_alert_recipients(jsonb, uuid, timestamptz) — the same set, plus, for "owners", the
--      department admins (user_access.level = 'dept_admin') whose dept_scope() holds the idle
--      person's department: their team at the beat (sales_people.user_id → sales_person_team_at):
--        teleshop:out → teleshop_out · teleshop:in → teleshop_other · teleshop:social → social ·
--        any other teleshop lane → all three (Тим Центар) · affiliate:* → altercpa + elyon_crm
--        (Тим Маџари In and Out, the same people) · management → management. No team → no dept admin.
--   3. presence_record_beat re-emitted from its LIVE body (pg_get_functiondef, 02.10.2026 = the body of
--      20260935000200, byte-identical) with ONE edited line: the alert now calls the 3-argument
--      resolver with the idle person (p_uid) and the beat time (p_now). The edit sits inside the
--      existing EXCEPTION block, so a failure there still only RAISEs a WARNING and never costs the
--      minute just counted. Drift-guarded both ways (md5 of the live bodies before, of the new ones after).
--   The setting key, the engine's eligibility rule (agents only, never admin / manager / revenue
--   viewers), the alert text and the in-window rule are unchanged.
--
-- Why: since 20260947001600 the money gate is the person's LEVEL, not the admin role. Teodora
--   Krstevska (dept admin, Тим Центар) lost the admin role in 20260947001610 and with it every idle
--   alert of her own agents; Ema (finance, a manager login) was never told.
--
-- Who is told (measured read-only, 02.10.2026, after 1600–1630):
--   before  Dragana, Dzenet Ramadani, Hedi, Lazar Delev, Mile Stoev, Mitrov, Mr Tony, Nina,
--           Radislava Maneska (9)
--   after   the same 9 + Ema (finance), for every idle agent; plus
--           Тим Центар agents (20 teleshop:out, 1 teleshop:in) → Teodora Krstevska, Mirjana Stefanovski
--           Тим Маџари agents (9 affiliate:in)                  → Martina Bundova, Simona Krstevska,
--                                                                 Kalina Tajkovska
--           10 eligible agents have no team today → the company-wide 10 only.
--
-- Grants: as live — service_role only on all three (presence_heartbeat is SECURITY DEFINER, so the
--   engine and the resolvers run as postgres); + EXECUTE on the two resolvers to
--   supabase_read_only_user (read-only verification), like 20260947001600 does for its readers.
--
-- Rollback: re-run presence_alert_recipients(jsonb) from 20260939000500 and presence_record_beat from
--   20260935000200 (both byte-identical to the live bodies this replaced), then
--   DROP FUNCTION public.presence_alert_recipients(jsonb, uuid, timestamptz);
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── 0. Drift guard: the live bodies must be the ones this was written from (or already this one) ──
DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.presence_alert_recipients(jsonb)',                           '91f2080b591a0302eed172e92a7d243b', 'fd425b3e410f5c263bc7147d8cfa3e87'),
    ('public.presence_record_beat(uuid,text,timestamp with time zone)',   '74693e4b5b92ff9119738d47ea98d519', '5e3c40a91dce45ae098c96ddbaff45a6')
  ) e(sig, md5_old, md5_new)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.md5_old, e.md5_new);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'presence alert recipients: % changed since this migration was written — re-emit from the live body', v_bad;
  END IF;
  IF to_regprocedure('public.can_see_revenue(uuid)') IS NULL OR to_regprocedure('public.dept_scope(uuid)') IS NULL
     OR to_regclass('public.user_access') IS NULL OR to_regprocedure('public.sales_person_team_at(uuid,timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'presence alert recipients: needs the access levels (20260947001600) and sales_person_team_at (20260947001000)';
  END IF;
END
$drift$;

-- ── 1. "owners" = can_see_revenue ──────────────────────────────────────────
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
  -- "owners" = everyone who sees the company-wide revenue: can_see_revenue() — super_admin / owner /
  -- finance / administrator with an active profile (20260947001710; was business_owners + active admins).
  SELECT pr.user_id
    FROM public.profiles pr
   WHERE pr.is_active
     AND EXISTS (SELECT 1 FROM items WHERE v = 'owners')
     AND public.can_see_revenue(pr.user_id)
  UNION
  -- "admins" = the admin role, active profile (unchanged).
  SELECT ur.user_id
    FROM public.user_roles ur
    JOIN public.profiles pr ON pr.user_id = ur.user_id AND pr.is_active
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
  'Resolves presence_idle_alert_recipients ("owners" = every active profile with can_see_revenue — super_admin / owner / finance / administrator — since 20260947001710 | "admins" | user uuid, or an array) to user ids. The engine calls the 3-argument form, which adds the idle person''s department admins. Internal to the presence engine.';

-- ── 2. + the idle person's department admins ───────────────────────────────
CREATE OR REPLACE FUNCTION public.presence_alert_recipients(p_spec jsonb, p_subject uuid, p_at timestamptz)
RETURNS TABLE (user_id uuid)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH owners_asked AS (
    SELECT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(p_spec) = 'array' THEN p_spec
                    ELSE jsonb_build_array(p_spec) END
             ) AS x
       WHERE jsonb_typeof(x) = 'string'
         AND lower(btrim(x #>> '{}')) = 'owners'
    ) AS yes
  ),
  -- The idle person's department(s): their team on the Skopje day of p_at (line team or Менаџмент,
  -- sales_person_team_at — the reader order_dept_by_team uses). Тим Центар by lane; Тим Маџари In and
  -- Out are the same people (leads and re-sales), so an affiliate agent is both keys. No team → none.
  subject AS (
    SELECT CASE
             WHEN t.team = 'teleshop:out'    THEN ARRAY['teleshop_out']
             WHEN t.team = 'teleshop:in'     THEN ARRAY['teleshop_other']
             WHEN t.team = 'teleshop:social' THEN ARRAY['social']
             WHEN t.team LIKE 'teleshop:%'   THEN ARRAY['teleshop_out', 'teleshop_other', 'social']
             WHEN t.team LIKE 'affiliate:%'  THEN ARRAY['altercpa', 'elyon_crm']
             WHEN t.team LIKE 'management:%' THEN ARRAY['management']
           END AS depts
      FROM (SELECT public.sales_person_team_at(sp.id, coalesce(p_at, now())) AS team
              FROM public.sales_people sp
             WHERE p_subject IS NOT NULL
               AND sp.user_id = p_subject) t
  )
  -- the spec itself ("owners" = can_see_revenue, "admins", uuids)
  SELECT r.user_id
    FROM public.presence_alert_recipients(p_spec) r
  UNION
  -- "owners" also reaches the department admins whose departments (dept_scope, valid today) hold
  -- the idle person's department. user_access is the only source of level dept_admin.
  SELECT ua.user_id
    FROM public.user_access ua
    JOIN subject s ON s.depts IS NOT NULL
   WHERE ua.level = 'dept_admin'
     AND (SELECT yes FROM owners_asked)
     AND public.dept_scope(ua.user_id) && s.depts;
$fn$;

COMMENT ON FUNCTION public.presence_alert_recipients(jsonb, uuid, timestamptz) IS
  'presence_alert_recipients(p_spec) plus, when the spec holds "owners", the department admins (user_access.level dept_admin) whose dept_scope() holds the department of p_subject''s team on the Skopje day of p_at (teleshop:out/in/social → teleshop_out/teleshop_other/social, affiliate → altercpa + elyon_crm, management → management). Internal to the presence engine. 20260947001710.';

-- ── 3. The engine: the LIVE body, one line changed (the resolver call) ─────
CREATE OR REPLACE FUNCTION public.presence_record_beat(p_uid uuid, p_state text, p_now timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
        FROM public.presence_alert_recipients(COALESCE(_recipients, '"owners"'::jsonb), p_uid, p_now) r  -- + the agent's dept admins (20260947001710)
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
$function$;

-- ── 4. Grants (as live; the new overload like its sibling) ─────────────────
REVOKE ALL ON FUNCTION public.presence_alert_recipients(jsonb)                    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.presence_alert_recipients(jsonb, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.presence_record_beat(uuid, text, timestamptz)       FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.presence_alert_recipients(jsonb)                    TO service_role;
GRANT EXECUTE ON FUNCTION public.presence_alert_recipients(jsonb, uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.presence_record_beat(uuid, text, timestamptz)       TO service_role;

DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.presence_alert_recipients(jsonb), public.presence_alert_recipients(jsonb, uuid, timestamptz) TO supabase_read_only_user';
  END IF;
END
$g$;

-- ── 5. Post-check: exactly the bodies written here ─────────────────────────
DO $chk$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.presence_alert_recipients(jsonb)',                                     'fd425b3e410f5c263bc7147d8cfa3e87'),
    ('public.presence_alert_recipients(jsonb,uuid,timestamp with time zone)',       '784091b21e06247a2552d9b237a8fb30'),
    ('public.presence_record_beat(uuid,text,timestamp with time zone)',             '5e3c40a91dce45ae098c96ddbaff45a6')
  ) e(sig, md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) <> e.md5;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'presence alert recipients: % did not land as written', v_bad;
  END IF;
END
$chk$;

COMMIT;
