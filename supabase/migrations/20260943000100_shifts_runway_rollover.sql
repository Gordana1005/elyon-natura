-- Shifts: roll a month's roster forward, and warn before the roster runs out (owner, 30.09.2026).
--
-- Why: a shift is the LOGIN GATE here — GET /shifts/check-login refuses every non-admin/manager
-- who has no shift covering "now" (Skopje) today. The September roster ("Септември", 07:00–21:00,
-- every day) ended on 30.09 and nobody had copied it forward: from 03.10 no agent could have
-- logged in. The owner kept the gate (30.09) and asked for (a) a one-step "roll the month over"
-- and (b) a warning ≥5 days before the roster runs out, so this never happens again.
--
--   shifts_roll_forward(src_from, src_to, dst_from, dst_to, user_ids, apply, actor, name)
--       Each ACTIVE agent (not admin/manager — they bypass the gate) who had shifts in the source
--       window gets the same pattern in the destination window:
--         · hours    = the most frequent DAILY WINDOW (earliest start → latest end of that day's
--                      shifts, because the gate lets you in when ANY shift covers now),
--         · weekdays = the ISO weekdays worked on ≥ half of that weekday's dates since the
--                      person's first source day (fewer than 7 source days → every day).
--       A person-day is skipped when an existing shift that day already covers the window, so a
--       re-run is idempotent and a manager's wider/equal shift is never duplicated.
--       apply=false (default) only returns the preview; apply=true writes one shifts row per
--       (date, start, end) named after the destination month (e.g. "Октомври") + the
--       assignments, and one audit_log row.
--   shifts_runway(warn_days)   who runs out of shifts within warn_days (read-only).
--   shifts_runway_alert()      daily 17:00 Skopje: notify active admins + managers when anyone who
--                              worked in the last 14 days has no shift ≥ warn_days ahead.
-- Service role only; the api/owner calls them.

CREATE OR REPLACE FUNCTION public.shifts_roll_forward(
  p_src_from date,
  p_src_to   date,
  p_dst_from date,
  p_dst_to   date,
  p_user_ids uuid[]  DEFAULT NULL,
  p_apply    boolean DEFAULT false,
  p_actor    uuid    DEFAULT NULL,
  p_name     text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _name   text;
  _people jsonb;
  _excl   jsonb;
  _rows   int := 0;
  _shifts int := 0;
  _skip   int := 0;
BEGIN
  IF p_src_from IS NULL OR p_src_to IS NULL OR p_dst_from IS NULL OR p_dst_to IS NULL
     OR p_src_to < p_src_from OR p_dst_to < p_dst_from THEN
    RAISE EXCEPTION 'shifts_roll_forward: bad date range';
  END IF;
  IF p_dst_to - p_dst_from > 62 THEN
    RAISE EXCEPTION 'shifts_roll_forward: destination longer than 62 days';
  END IF;
  IF p_apply AND p_actor IS NULL THEN
    RAISE EXCEPTION 'shifts_roll_forward: apply needs an actor';
  END IF;

  _name := COALESCE(NULLIF(btrim(p_name), ''),
    (ARRAY['Јануари','Февруари','Март','Април','Мај','Јуни','Јули','Август',
           'Септември','Октомври','Ноември','Декември'])[extract(month FROM p_dst_from)::int]);

  DROP TABLE IF EXISTS _plan;
  CREATE TEMP TABLE _plan ON COMMIT DROP AS
  WITH src AS (          -- one row per person-day: the day's allowed window
    SELECT sa.user_id, s.date, min(s.start_time) AS st, max(s.end_time) AS en
      FROM shift_assignments sa
      JOIN shifts s ON s.id = sa.shift_id
     WHERE s.date BETWEEN p_src_from AND p_src_to
       AND NOT (s.start_time = '00:00' AND s.end_time = '00:00')
       AND s.end_time > s.start_time
     GROUP BY 1, 2
  ),
  elig AS (
    SELECT p.user_id, p.full_name
      FROM profiles p
     WHERE p.is_active
       AND NOT EXISTS (SELECT 1 FROM user_roles r
                        WHERE r.user_id = p.user_id AND r.role IN ('admin', 'manager'))
       AND (p_user_ids IS NULL OR p.user_id = ANY (p_user_ids))
  ),
  hrs AS (
    SELECT DISTINCT ON (user_id) user_id, st, en
      FROM (SELECT user_id, st, en, count(*) AS n, max(date) AS lastd FROM src GROUP BY 1, 2, 3) x
     ORDER BY user_id, n DESC, lastd DESC
  ),
  firstd AS (SELECT user_id, min(date) AS f, count(*) AS ndays FROM src GROUP BY 1),
  wd AS (SELECT user_id, extract(isodow FROM date)::int AS dow, count(*) AS worked FROM src GROUP BY 1, 2),
  wdtot AS (
    SELECT f.user_id, extract(isodow FROM d)::int AS dow, count(*) AS tot
      FROM firstd f CROSS JOIN generate_series(f.f, p_src_to, interval '1 day') d
     GROUP BY 1, 2
  ),
  keepdow AS (
    SELECT t.user_id, t.dow
      FROM wdtot t
      JOIN firstd f USING (user_id)
      LEFT JOIN wd w ON w.user_id = t.user_id AND w.dow = t.dow
     WHERE f.ndays < 7 OR COALESCE(w.worked, 0) * 2 >= t.tot
    UNION
    SELECT f.user_id, g.dow FROM firstd f CROSS JOIN generate_series(1, 7) AS g(dow) WHERE f.ndays < 7
  )
  SELECT e.user_id, e.full_name, h.st, h.en, d::date AS date,
         EXISTS (SELECT 1 FROM shift_assignments sa2 JOIN shifts s2 ON s2.id = sa2.shift_id
                  WHERE sa2.user_id = e.user_id AND s2.date = d::date
                    AND s2.start_time <= h.st AND s2.end_time >= h.en) AS covered
    FROM elig e
    JOIN hrs h USING (user_id)
    CROSS JOIN generate_series(p_dst_from, p_dst_to, interval '1 day') d
   WHERE EXISTS (SELECT 1 FROM keepdow k WHERE k.user_id = e.user_id AND k.dow = extract(isodow FROM d)::int);

  SELECT count(*) FILTER (WHERE covered) INTO _skip FROM _plan;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', user_id, 'name', full_name,
           'hours', to_char(st, 'HH24:MI') || '-' || to_char(en, 'HH24:MI'),
           'weekdays', dows, 'days', days, 'already_covered', covered_days)
           ORDER BY full_name), '[]'::jsonb)
    INTO _people
    FROM (SELECT user_id, full_name, st, en,
                 string_agg(DISTINCT extract(isodow FROM date)::int::text, '') AS dows,
                 count(*) FILTER (WHERE NOT covered) AS days,
                 count(*) FILTER (WHERE covered) AS covered_days
            FROM _plan GROUP BY 1, 2, 3, 4) x;

  -- Active agents the gate would block who have NO pattern in the source window.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', p.full_name) ORDER BY p.full_name), '[]'::jsonb)
    INTO _excl
    FROM profiles p
   WHERE p.is_active
     AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = p.user_id AND r.role IN ('admin', 'manager'))
     AND (p_user_ids IS NULL OR p.user_id = ANY (p_user_ids))
     AND NOT EXISTS (SELECT 1 FROM _plan pl WHERE pl.user_id = p.user_id);

  IF p_apply THEN
    -- one shifts row per (date, start, end) under the month name; reuse it on a re-run
    INSERT INTO shifts (name, date, start_time, end_time, created_by)
    SELECT DISTINCT _name, pl.date, pl.st, pl.en, p_actor
      FROM _plan pl
     WHERE NOT pl.covered
       AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.name = _name AND s.date = pl.date
                          AND s.start_time = pl.st AND s.end_time = pl.en);
    GET DIAGNOSTICS _shifts = ROW_COUNT;

    INSERT INTO shift_assignments (shift_id, user_id)
    SELECT s.id, pl.user_id
      FROM _plan pl
      JOIN LATERAL (SELECT id FROM shifts s WHERE s.name = _name AND s.date = pl.date
                       AND s.start_time = pl.st AND s.end_time = pl.en
                     ORDER BY created_at LIMIT 1) s ON true
     WHERE NOT pl.covered
    ON CONFLICT (shift_id, user_id) DO NOTHING;
    GET DIAGNOSTICS _rows = ROW_COUNT;

    INSERT INTO audit_log (actor_id, action, target_type, target_name, payload)
    VALUES (p_actor, 'shifts.roll_forward', 'shifts', _name,
            jsonb_build_object('src', jsonb_build_array(p_src_from, p_src_to),
                               'dst', jsonb_build_array(p_dst_from, p_dst_to),
                               'people', jsonb_array_length(_people),
                               'shifts_created', _shifts, 'assignments_created', _rows,
                               'skipped_covered', _skip));
  END IF;

  RETURN jsonb_build_object(
    'apply', p_apply, 'name', _name,
    'src', jsonb_build_array(p_src_from, p_src_to), 'dst', jsonb_build_array(p_dst_from, p_dst_to),
    'people', _people, 'excluded', _excl,
    'person_days', (SELECT count(*) FILTER (WHERE NOT covered) FROM _plan),
    'skipped_covered', _skip,
    'shifts_created', _shifts, 'assignments_created', _rows);
END
$fn$;

COMMENT ON FUNCTION public.shifts_roll_forward(date, date, date, date, uuid[], boolean, uuid, text) IS
  'Copy each active agent''s shift pattern (most frequent daily window + weekdays worked on ≥ half of them) from a source window into a destination window; fills only person-days not already covered; apply=false = preview. One shifts row per (date,start,end) named after the month + assignments + audit_log. Owner 30.09.2026 (the login gate stays). Migration 20260943000100.';

CREATE OR REPLACE FUNCTION public.shifts_runway(p_warn_days int DEFAULT 5)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH today AS (SELECT (now() AT TIME ZONE 'Europe/Skopje')::date AS d),
  agents AS (       -- active, gated (not admin/manager), worked in the last 14 days
    SELECT DISTINCT p.user_id, p.full_name
      FROM profiles p
      JOIN shift_assignments sa ON sa.user_id = p.user_id
      JOIN shifts s ON s.id = sa.shift_id, today t
     WHERE p.is_active
       AND s.date BETWEEN t.d - 14 AND t.d
       AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = p.user_id AND r.role IN ('admin', 'manager'))
  ),
  last AS (
    SELECT a.user_id, a.full_name,
           (SELECT max(s.date) FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id
             WHERE sa.user_id = a.user_id
               AND NOT (s.start_time = '00:00' AND s.end_time = '00:00')) AS last_date
      FROM agents a
  )
  SELECT jsonb_build_object(
    'today', (SELECT d FROM today),
    'warn_days', p_warn_days,
    'agents', (SELECT count(*) FROM last),
    'min_last_date', (SELECT min(last_date) FROM last),
    'running_out', COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id', user_id, 'name', full_name, 'last_date', last_date)
                                               ORDER BY last_date NULLS FIRST, full_name)
                               FROM last, today t WHERE last_date IS NULL OR last_date < t.d + p_warn_days), '[]'::jsonb));
$fn$;

COMMENT ON FUNCTION public.shifts_runway(int) IS
  'Who of the active gated agents (worked in the last 14 days) has no shift on or after today + warn_days (Skopje). Read-only. Migration 20260943000100.';

CREATE OR REPLACE FUNCTION public.shifts_runway_alert()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _local timestamp := now() AT TIME ZONE 'Europe/Skopje';
  _r     jsonb;
  _n     int;
  _first date;
BEGIN
  -- 17:xx Skopje only (DST-proof: exactly one of the two UTC slots fires here)
  IF extract(hour FROM _local) <> 17 THEN RETURN; END IF;
  _r := public.shifts_runway(5);
  _n := jsonb_array_length(_r -> 'running_out');
  IF _n = 0 THEN RETURN; END IF;
  _first := (SELECT min((x ->> 'last_date')::date) FROM jsonb_array_elements(_r -> 'running_out') x);

  INSERT INTO notifications (user_id, type, title, message, link, meta)
  SELECT DISTINCT r.user_id,
         'shifts_runway',
         'Shifts are running out',
         _n || ' agent(s) have no shift after ' || COALESCE(to_char(_first, 'DD.MM'), 'today')
           || ' — without a shift they cannot log in. Roll the month over in Shifts.',
         '/shifts',
         jsonb_build_object('i18n', 'notif.shiftsRunway', 'count', _n,
                            'date', COALESCE(to_char(_first, 'DD.MM'), '—'), 'day', _local::date)
    FROM user_roles r
    JOIN profiles p ON p.user_id = r.user_id AND p.is_active
   WHERE r.role IN ('admin', 'manager')
     AND NOT EXISTS (SELECT 1 FROM notifications n
                      WHERE n.user_id = r.user_id AND n.type = 'shifts_runway'
                        AND n.created_at >= date_trunc('day', now() AT TIME ZONE 'Europe/Skopje') AT TIME ZONE 'Europe/Skopje');
END
$fn$;

COMMENT ON FUNCTION public.shifts_runway_alert() IS
  'Daily 17:00 Skopje: notify active admins + managers (type shifts_runway, meta.i18n notif.shiftsRunway) when an active agent has no shift within 5 days — the login gate would block them. Once per recipient per day. Migration 20260943000100.';

REVOKE ALL ON FUNCTION public.shifts_roll_forward(date, date, date, date, uuid[], boolean, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shifts_runway(int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shifts_runway_alert() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shifts_roll_forward(date, date, date, date, uuid[], boolean, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shifts_runway(int) TO service_role;
GRANT EXECUTE ON FUNCTION public.shifts_runway_alert() TO service_role;

-- 17:05 Skopje = 15:05 UTC in summer, 16:05 UTC in winter; the function gates on the local hour.
SELECT cron.unschedule('shifts-runway-alert') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shifts-runway-alert');
SELECT cron.schedule('shifts-runway-alert', '5 15,16 * * *', $$SELECT public.shifts_runway_alert()$$);
