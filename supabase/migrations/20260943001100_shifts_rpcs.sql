-- Shifts: the RPCs behind the one-page "Смени" (plan Фаза 8, owner 30.09.2026).
-- Needs 20260943001000 (shift_assignments.shift_date + UNIQUE (user_id, shift_date),
-- shifts.template_id, the window CHECK).
--
-- Storage stays one `shifts` row per (date, window, name) + one `shift_assignments` row per
-- person-day, because the login gate (GET /shifts/check-login), shift_login_logs, the
-- assigner board's shift tooltip and /presence/day all read it that way. The grid is a VIEW
-- of that storage: a cell = the person's assignment that day.
--
--   shifts_slot(date, start, end, name, template_id, actor)  find-or-create the slot row.
--   shifts_grid(from, to)            people (active; gated first; admins/managers only when
--                                    they have a cell) × days → cells, templates, the windows
--                                    in use (brushes). Team = sales_team_members today.
--   shifts_set_cells(cells, actor)   the grid's atomic save. A cell is {user_id, date} plus ONE
--                                    of {off:true} | {shift_id} | {template_id} | {start, end,
--                                    name?}. Replaces the person's assignment that day, returns
--                                    every change with its before/after and the `undo` cells
--                                    (the same call with them reverts it), one audit_log row.
--   shifts_copy_range(src_from, src_to, dst_from, mode, apply, actor)
--                                    "copy the previous week": fill_empty (default) only fills
--                                    empty person-days; overwrite also replaces different ones
--                                    and clears the days the person had off in the source.
--                                    Preview = the cells (the grid stages them); apply = one
--                                    shifts_set_cells call.
--   shift_update(id, patch, agent_ids, actor)
--                                    PATCH /shifts/:id, whitelisted + atomic (it used to write the
--                                    raw body, then delete + insert the agents, ignoring errors).
--   shift_template_update(id, patch, actor)
--                                    a template edit moves its future rows BY template_id from the
--                                    Skopje today (it matched by name with a UTC date).
--   shifts_statistics(from, to)      per person, one SQL aggregate (the api read 1.000 rows max:
--                                    1.782 September assignments were cut).
--   shifts_login_activity(from, to, user, status, limit, offset)
--                                    logins + blocked attempts, Skopje times, status CODES
--                                    on_time | late | early | blocked (+ reason_code), paged.
-- Every write takes the same transaction advisory lock, so two saves never interleave.
-- Service role only; the api checks the caller (admin/manager with the `shifts` module).

SET LOCAL lock_timeout = '10s';

DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shift_assignments_user_day_key') THEN
    RAISE EXCEPTION 'apply 20260943001000_shifts_integrity.sql first';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.shifts_month_name(p_date date)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT (ARRAY['Јануари','Февруари','Март','Април','Мај','Јуни','Јули','Август',
                'Септември','Октомври','Ноември','Декември'])[extract(month FROM p_date)::int]
$fn$;

-- ── find-or-create the slot row ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shifts_slot(
  p_date date, p_start time, p_end time, p_name text, p_template_id uuid, p_actor uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _id   uuid;
  _name text := NULLIF(btrim(COALESCE(p_name, '')), '');
BEGIN
  IF p_date IS NULL OR p_start IS NULL OR p_end IS NULL THEN
    RAISE EXCEPTION 'shifts_slot: date, start and end are required' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_end > p_start) THEN
    RAISE EXCEPTION 'shifts_slot: end must be after start' USING ERRCODE = '22023';
  END IF;
  IF _name IS NULL THEN
    -- a custom window: reuse whatever row that day already has it (a month roll, a template)
    SELECT id INTO _id FROM shifts
     WHERE date = p_date AND start_time = p_start AND end_time = p_end
     ORDER BY (template_id IS NOT DISTINCT FROM p_template_id) DESC, created_at, id
     LIMIT 1;
    IF _id IS NOT NULL THEN RETURN _id; END IF;
    _name := public.shifts_month_name(p_date);
  ELSE
    SELECT id INTO _id FROM shifts
     WHERE date = p_date AND start_time = p_start AND end_time = p_end AND name = _name
     ORDER BY (template_id IS NOT DISTINCT FROM p_template_id) DESC, created_at, id
     LIMIT 1;
    IF _id IS NOT NULL THEN
      -- a template painted onto an unlinked row of its own name + window links it
      IF p_template_id IS NOT NULL THEN
        UPDATE shifts SET template_id = p_template_id WHERE id = _id AND template_id IS NULL;
      END IF;
      RETURN _id;
    END IF;
  END IF;
  INSERT INTO shifts (name, date, start_time, end_time, template_id, created_by)
  VALUES (_name, p_date, p_start, p_end, p_template_id, p_actor)
  RETURNING id INTO _id;
  RETURN _id;
END
$fn$;

-- ── the grid ───────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shifts_grid(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _r     jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'shifts_grid: bad date range' USING ERRCODE = '22023';
  END IF;
  IF p_to - p_from > 62 THEN
    RAISE EXCEPTION 'shifts_grid: at most 63 days' USING ERRCODE = '22023';
  END IF;

  WITH
  rl AS (
    SELECT r.user_id, array_agg(r.role::text ORDER BY r.role::text) AS roles
      FROM user_roles r GROUP BY r.user_id
  ),
  cells AS (
    SELECT sa.user_id, sa.shift_date AS date, s.id AS shift_id, s.start_time, s.end_time, s.name, s.template_id
      FROM shift_assignments sa
      JOIN shifts s ON s.id = sa.shift_id
     WHERE sa.shift_date BETWEEN p_from AND p_to
  ),
  tm AS (
    SELECT DISTINCT ON (sp.user_id) sp.user_id, m.team_key, t.name AS team_name
      FROM sales_people sp
      JOIN sales_team_members m ON m.person_id = sp.id
      LEFT JOIN sales_teams t ON t.key = m.team_key
     WHERE sp.user_id IS NOT NULL
       AND m.valid_from <= _today AND COALESCE(m.valid_to, 'infinity'::date) >= _today
     ORDER BY sp.user_id, m.is_primary DESC, m.valid_from DESC
  ),
  ppl AS (
    SELECT p.user_id, p.full_name, COALESCE(rl.roles, '{}'::text[]) AS roles,
           NOT (COALESCE(rl.roles, '{}'::text[]) && ARRAY['admin', 'manager']) AS gated,
           tm.team_key, tm.team_name
      FROM profiles p
      LEFT JOIN rl ON rl.user_id = p.user_id
      LEFT JOIN tm ON tm.user_id = p.user_id
     WHERE p.is_active AND p.user_id IS NOT NULL
       -- an affiliate-only login is an external partner, never staff
       AND NOT (cardinality(COALESCE(rl.roles, '{}'::text[])) > 0
                AND COALESCE(rl.roles, '{}'::text[]) <@ ARRAY['affiliate']::text[])
       -- admins / managers pass the gate without a shift: listed only when they have one
       AND (NOT (COALESCE(rl.roles, '{}'::text[]) && ARRAY['admin', 'manager'])
            OR EXISTS (SELECT 1 FROM cells c WHERE c.user_id = p.user_id))
  ),
  wins AS (      -- the custom windows in use lately: the grid's extra brushes
    SELECT to_char(s.start_time, 'HH24:MI') AS st, to_char(s.end_time, 'HH24:MI') AS en,
           mode() WITHIN GROUP (ORDER BY s.name) AS name, count(*) AS n
      FROM shift_assignments sa
      JOIN shifts s ON s.id = sa.shift_id
     WHERE sa.shift_date BETWEEN p_from - 35 AND p_to
       AND s.template_id IS NULL
       AND NOT (s.start_time = '00:00' AND s.end_time = '00:00')
     GROUP BY 1, 2
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'today', _today,
    'people', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'user_id', user_id, 'name', full_name, 'roles', to_jsonb(roles), 'gated', gated,
                  'team_key', team_key, 'team_name', team_name)
                ORDER BY gated DESC, team_key NULLS LAST, full_name) FROM ppl), '[]'::jsonb),
    'cells', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'user_id', c.user_id, 'date', c.date, 'shift_id', c.shift_id,
                  'start', to_char(c.start_time, 'HH24:MI'), 'end', to_char(c.end_time, 'HH24:MI'),
                  'name', c.name, 'template_id', c.template_id)
                ORDER BY c.user_id, c.date)
               FROM cells c WHERE EXISTS (SELECT 1 FROM ppl WHERE ppl.user_id = c.user_id)), '[]'::jsonb),
    'templates', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'id', t.id, 'name', t.name,
                  'start', to_char(t.start_time, 'HH24:MI'), 'end', to_char(t.end_time, 'HH24:MI'))
                ORDER BY t.start_time, t.name) FROM shift_templates t), '[]'::jsonb),
    'windows', COALESCE((SELECT jsonb_agg(jsonb_build_object('start', st, 'end', en, 'name', name, 'count', n)
                ORDER BY n DESC, st, en) FROM wins), '[]'::jsonb))
  INTO _r;
  RETURN _r;
END
$fn$;

-- ── the atomic save ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shifts_set_cells(
  p_cells jsonb, p_actor uuid, p_action text DEFAULT 'shifts.set_cells'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  c        jsonb;
  _uid     uuid;
  _date    date;
  _off     boolean;
  _sid     uuid;
  _had     boolean;
  _pid     uuid;
  _psid    uuid;
  _pst     time;
  _pen     time;
  _pname   text;
  _ptid    uuid;
  _tst     time;
  _ten     time;
  _tname   text;
  _changes jsonb := '[]'::jsonb;
  _undo    jsonb := '[]'::jsonb;
  _n       int := 0;
  _same    int := 0;
  _from    date;
  _to      date;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'shifts_set_cells: an actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_cells IS NULL OR jsonb_typeof(p_cells) <> 'array' THEN
    RAISE EXCEPTION 'shifts_set_cells: cells must be an array' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_cells) > 3000 THEN
    RAISE EXCEPTION 'shifts_set_cells: at most 3000 cells per save' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_cells) AS e(v)
              GROUP BY e.v ->> 'user_id', e.v ->> 'date' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'shifts_set_cells: the same person-day twice' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('elyon.shifts.write'));

  FOR c IN SELECT e.v FROM jsonb_array_elements(p_cells) AS e(v) LOOP
    _uid  := NULLIF(c ->> 'user_id', '')::uuid;
    _date := NULLIF(c ->> 'date', '')::date;
    IF _uid IS NULL OR _date IS NULL THEN
      RAISE EXCEPTION 'shifts_set_cells: every cell needs user_id and date' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = _uid) THEN
      RAISE EXCEPTION 'shifts_set_cells: unknown user %', _uid USING ERRCODE = '22023';
    END IF;
    _from := LEAST(COALESCE(_from, _date), _date);
    _to   := GREATEST(COALESCE(_to, _date), _date);

    SELECT sa.id, sa.shift_id, s.start_time, s.end_time, s.name, s.template_id
      INTO _pid, _psid, _pst, _pen, _pname, _ptid
      FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id
     WHERE sa.user_id = _uid AND sa.shift_date = _date;
    _had := FOUND;

    _off := COALESCE((c ->> 'off')::boolean, false);
    _sid := NULL;
    IF _off THEN
      NULL;
    ELSIF NULLIF(c ->> 'shift_id', '') IS NOT NULL THEN
      SELECT id INTO _sid FROM shifts WHERE id = (c ->> 'shift_id')::uuid AND date = _date;
      IF _sid IS NULL THEN
        RAISE EXCEPTION 'shifts_set_cells: shift % is not on %', c ->> 'shift_id', _date USING ERRCODE = '22023';
      END IF;
    ELSIF NULLIF(c ->> 'template_id', '') IS NOT NULL THEN
      SELECT t.start_time, t.end_time, t.name INTO _tst, _ten, _tname
        FROM shift_templates t WHERE t.id = (c ->> 'template_id')::uuid;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'shifts_set_cells: unknown template %', c ->> 'template_id' USING ERRCODE = '22023';
      END IF;
      _sid := public.shifts_slot(_date, _tst, _ten, _tname, (c ->> 'template_id')::uuid, p_actor);
    ELSIF NULLIF(c ->> 'start', '') IS NOT NULL AND NULLIF(c ->> 'end', '') IS NOT NULL THEN
      _sid := public.shifts_slot(_date, (c ->> 'start')::time, (c ->> 'end')::time, c ->> 'name', NULL, p_actor);
    ELSE
      RAISE EXCEPTION 'shifts_set_cells: a cell needs off, shift_id, template_id or start + end' USING ERRCODE = '22023';
    END IF;

    IF _off THEN
      IF NOT _had THEN _same := _same + 1; CONTINUE; END IF;
      DELETE FROM shift_assignments WHERE id = _pid;
    ELSE
      IF _had AND _psid = _sid THEN _same := _same + 1; CONTINUE; END IF;
      IF _had THEN
        UPDATE shift_assignments SET shift_id = _sid WHERE id = _pid;
      ELSE
        INSERT INTO shift_assignments (shift_id, user_id) VALUES (_sid, _uid);
      END IF;
    END IF;
    _n := _n + 1;

    _changes := _changes || jsonb_build_array(jsonb_build_object(
      'user_id', _uid, 'date', _date,
      'before', CASE WHEN _had THEN jsonb_build_object(
                  'shift_id', _psid, 'start', to_char(_pst, 'HH24:MI'), 'end', to_char(_pen, 'HH24:MI'),
                  'name', _pname, 'template_id', _ptid) END,
      'after', CASE WHEN _off THEN NULL ELSE (
                  SELECT jsonb_build_object('shift_id', s.id, 'start', to_char(s.start_time, 'HH24:MI'),
                                            'end', to_char(s.end_time, 'HH24:MI'), 'name', s.name,
                                            'template_id', s.template_id)
                    FROM shifts s WHERE s.id = _sid) END));
    _undo := _undo || jsonb_build_array(CASE
      WHEN _had THEN jsonb_build_object('user_id', _uid, 'date', _date, 'shift_id', _psid)
      ELSE jsonb_build_object('user_id', _uid, 'date', _date, 'off', true) END);
  END LOOP;

  IF _n > 0 THEN
    INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_name, payload)
    VALUES (p_actor, (SELECT email FROM profiles WHERE user_id = p_actor LIMIT 1),
            COALESCE(NULLIF(p_action, ''), 'shifts.set_cells'), 'shifts',
            to_char(_from, 'DD.MM.YYYY') || CASE WHEN _to > _from THEN ' – ' || to_char(_to, 'DD.MM.YYYY') ELSE '' END,
            jsonb_build_object('changed', _n, 'unchanged', _same, 'cells', _changes));
  END IF;

  RETURN jsonb_build_object('changed', _n, 'unchanged', _same, 'cells', _changes, 'undo', _undo);
END
$fn$;

-- ── copy a range (the previous week) ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shifts_copy_range(
  p_src_from date, p_src_to date, p_dst_from date,
  p_mode text DEFAULT 'fill_empty', p_apply boolean DEFAULT false, p_actor uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _shift  int;
  _dst_to date;
  _cells  jsonb;
  _counts jsonb;
  _people jsonb;
  _res    jsonb;
BEGIN
  IF p_src_from IS NULL OR p_src_to IS NULL OR p_dst_from IS NULL OR p_src_to < p_src_from THEN
    RAISE EXCEPTION 'shifts_copy_range: bad date range' USING ERRCODE = '22023';
  END IF;
  IF p_src_to - p_src_from > 62 THEN
    RAISE EXCEPTION 'shifts_copy_range: at most 63 days' USING ERRCODE = '22023';
  END IF;
  IF p_mode IS NULL OR p_mode NOT IN ('fill_empty', 'overwrite') THEN
    RAISE EXCEPTION 'shifts_copy_range: mode is fill_empty or overwrite' USING ERRCODE = '22023';
  END IF;
  IF p_apply AND p_actor IS NULL THEN
    RAISE EXCEPTION 'shifts_copy_range: apply needs an actor' USING ERRCODE = '22023';
  END IF;
  _shift  := p_dst_from - p_src_from;
  _dst_to := p_dst_from + (p_src_to - p_src_from);
  IF NOT (p_dst_from > p_src_to OR _dst_to < p_src_from) THEN
    RAISE EXCEPTION 'shifts_copy_range: the source and destination overlap' USING ERRCODE = '22023';
  END IF;

  DROP TABLE IF EXISTS _cp;
  CREATE TEMP TABLE _cp ON COMMIT DROP AS
  WITH src AS (
    SELECT sa.user_id, sa.shift_date + _shift AS date, s.start_time AS st, s.end_time AS en,
           s.name, s.template_id, t.start_time AS t_st, t.end_time AS t_en
      FROM shift_assignments sa
      JOIN shifts s ON s.id = sa.shift_id
      JOIN profiles p ON p.user_id = sa.user_id AND p.is_active
      LEFT JOIN shift_templates t ON t.id = s.template_id
     WHERE sa.shift_date BETWEEN p_src_from AND p_src_to
  ),
  dst AS (
    SELECT sa.user_id, sa.shift_date AS date, s.start_time AS st, s.end_time AS en
      FROM shift_assignments sa
      JOIN shifts s ON s.id = sa.shift_id
     WHERE sa.shift_date BETWEEN p_dst_from AND _dst_to
  ),
  who AS (SELECT DISTINCT user_id FROM src)
  SELECT COALESCE(s.user_id, d.user_id) AS user_id, COALESCE(s.date, d.date) AS date,
         s.st, s.en, s.name, s.template_id, (s.t_st = s.st AND s.t_en = s.en) AS tpl_same,
         CASE
           WHEN s.user_id IS NULL THEN
             CASE WHEN p_mode = 'overwrite' AND d.user_id IN (SELECT user_id FROM who) THEN 'clear' ELSE 'untouched' END
           WHEN d.user_id IS NULL THEN 'fill'
           WHEN s.st = d.st AND s.en = d.en THEN 'same'
           WHEN p_mode = 'overwrite' THEN 'replace'
           ELSE 'kept'
         END AS op
    FROM src s
    FULL JOIN dst d ON d.user_id = s.user_id AND d.date = s.date;

  SELECT COALESCE(jsonb_agg(CASE
           WHEN op = 'clear' THEN jsonb_build_object('user_id', user_id, 'date', date, 'off', true)
           WHEN tpl_same THEN jsonb_build_object('user_id', user_id, 'date', date, 'template_id', template_id)
           ELSE jsonb_build_object('user_id', user_id, 'date', date, 'start', to_char(st, 'HH24:MI'),
                                   'end', to_char(en, 'HH24:MI'), 'name', name) END
           ORDER BY user_id, date), '[]'::jsonb)
    INTO _cells
    FROM _cp WHERE op IN ('fill', 'replace', 'clear');

  SELECT jsonb_build_object(
           'fill',    count(*) FILTER (WHERE op = 'fill'),
           'replace', count(*) FILTER (WHERE op = 'replace'),
           'clear',   count(*) FILTER (WHERE op = 'clear'),
           'same',    count(*) FILTER (WHERE op = 'same'),
           'kept',    count(*) FILTER (WHERE op = 'kept'))
    INTO _counts FROM _cp;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('user_id', x.user_id, 'name', p.full_name, 'days', x.n)
                            ORDER BY p.full_name), '[]'::jsonb)
    INTO _people
    FROM (SELECT user_id, count(*) AS n FROM _cp WHERE op IN ('fill', 'replace', 'clear') GROUP BY 1) x
    JOIN profiles p ON p.user_id = x.user_id;

  IF p_apply AND jsonb_array_length(_cells) > 0 THEN
    _res := public.shifts_set_cells(_cells, p_actor, 'shifts.copy_range');
  END IF;

  RETURN jsonb_build_object(
    'apply', p_apply, 'mode', p_mode,
    'src', jsonb_build_array(p_src_from, p_src_to), 'dst', jsonb_build_array(p_dst_from, _dst_to),
    'counts', _counts, 'people', _people, 'cells', _cells,
    'changed', COALESCE((_res ->> 'changed')::int, 0), 'undo', COALESCE(_res -> 'undo', '[]'::jsonb));
END
$fn$;

-- ── PATCH /shifts/:id ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shift_update(
  p_id uuid, p_patch jsonb, p_agent_ids uuid[], p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _old     shifts%ROWTYPE;
  _new     shifts%ROWTYPE;
  _k       text;
  _target  uuid[];
  _clash   text;
  _removed int := 0;
  _moved   int := 0;
  _added   int := 0;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'shift_update: an actor is required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('elyon.shifts.write'));

  SELECT * INTO _old FROM shifts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift_update: shift not found' USING ERRCODE = 'P0002';
  END IF;

  p_patch := COALESCE(p_patch, '{}'::jsonb);
  IF jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'shift_update: patch must be an object' USING ERRCODE = '22023';
  END IF;
  FOR _k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF _k NOT IN ('name', 'date', 'start_time', 'end_time', 'template_id') THEN
      RAISE EXCEPTION 'shift_update: % cannot be changed', _k USING ERRCODE = '22023';
    END IF;
  END LOOP;

  _new := _old;
  IF p_patch ? 'name' THEN
    _new.name := NULLIF(btrim(COALESCE(p_patch ->> 'name', '')), '');
    IF _new.name IS NULL THEN RAISE EXCEPTION 'shift_update: a name is required' USING ERRCODE = '22023'; END IF;
  END IF;
  IF p_patch ? 'date'        THEN _new.date        := (p_patch ->> 'date')::date; END IF;
  IF p_patch ? 'start_time'  THEN _new.start_time  := (p_patch ->> 'start_time')::time; END IF;
  IF p_patch ? 'end_time'    THEN _new.end_time    := (p_patch ->> 'end_time')::time; END IF;
  IF p_patch ? 'template_id' THEN _new.template_id := NULLIF(p_patch ->> 'template_id', '')::uuid; END IF;
  IF _new.date IS NULL OR _new.start_time IS NULL OR _new.end_time IS NULL THEN
    RAISE EXCEPTION 'shift_update: date, start and end are required' USING ERRCODE = '22023';
  END IF;
  IF NOT (_new.end_time > _new.start_time OR (_new.start_time = '00:00' AND _new.end_time = '00:00')) THEN
    RAISE EXCEPTION 'shift_update: end must be after start' USING ERRCODE = '22023';
  END IF;

  _target := COALESCE(p_agent_ids,
                      ARRAY(SELECT user_id FROM shift_assignments WHERE shift_id = p_id));

  -- someone who already works ANOTHER shift on the (new) day: moved onto this one when the agents
  -- were listed explicitly; a date move alone must not silently drop anyone's other shift
  SELECT string_agg(COALESCE(p.full_name, sa.user_id::text), ', ' ORDER BY p.full_name) INTO _clash
    FROM shift_assignments sa
    LEFT JOIN profiles p ON p.user_id = sa.user_id
   WHERE sa.shift_date = _new.date AND sa.shift_id <> p_id AND sa.user_id = ANY (_target);
  IF _clash IS NOT NULL AND p_agent_ids IS NULL THEN
    RAISE EXCEPTION 'shift_update: already on another shift that day: %', _clash USING ERRCODE = '23505';
  END IF;

  IF p_agent_ids IS NOT NULL THEN
    DELETE FROM shift_assignments WHERE shift_id = p_id AND NOT (user_id = ANY (_target));
    GET DIAGNOSTICS _removed = ROW_COUNT;
    DELETE FROM shift_assignments
     WHERE shift_date = _new.date AND shift_id <> p_id AND user_id = ANY (_target);
    GET DIAGNOSTICS _moved = ROW_COUNT;
  END IF;

  UPDATE shifts
     SET name = _new.name, date = _new.date, start_time = _new.start_time, end_time = _new.end_time,
         template_id = _new.template_id, updated_at = now()
   WHERE id = p_id;

  IF p_agent_ids IS NOT NULL THEN
    INSERT INTO shift_assignments (shift_id, user_id)
    SELECT p_id, u FROM unnest(_target) AS u
     WHERE EXISTS (SELECT 1 FROM profiles WHERE user_id = u)
    ON CONFLICT (shift_id, user_id) DO NOTHING;
    GET DIAGNOSTICS _added = ROW_COUNT;
  END IF;

  INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, (SELECT email FROM profiles WHERE user_id = p_actor LIMIT 1), 'shifts.update', 'shift',
          p_id::text, _new.name,
          jsonb_build_object(
            'before', jsonb_build_object('name', _old.name, 'date', _old.date,
                                         'start', to_char(_old.start_time, 'HH24:MI'), 'end', to_char(_old.end_time, 'HH24:MI'),
                                         'template_id', _old.template_id),
            'after', jsonb_build_object('name', _new.name, 'date', _new.date,
                                        'start', to_char(_new.start_time, 'HH24:MI'), 'end', to_char(_new.end_time, 'HH24:MI'),
                                        'template_id', _new.template_id),
            'agents_added', _added, 'agents_removed', _removed, 'moved_from_other_shift', _moved));

  RETURN jsonb_build_object(
    'id', p_id, 'name', _new.name, 'date', _new.date,
    'start_time', to_char(_new.start_time, 'HH24:MI'), 'end_time', to_char(_new.end_time, 'HH24:MI'),
    'template_id', _new.template_id,
    'agents', COALESCE((SELECT jsonb_agg(jsonb_build_object('user_id', sa.user_id, 'full_name', p.full_name) ORDER BY p.full_name)
                          FROM shift_assignments sa LEFT JOIN profiles p ON p.user_id = sa.user_id
                         WHERE sa.shift_id = p_id), '[]'::jsonb),
    'added', _added, 'removed', _removed, 'moved', _moved);
END
$fn$;

-- ── PATCH /shift-templates/:id ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shift_template_update(p_id uuid, p_patch jsonb, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _old   shift_templates%ROWTYPE;
  _new   shift_templates%ROWTYPE;
  _k     text;
  _n     int := 0;
  _today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'shift_template_update: an actor is required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('elyon.shifts.write'));
  SELECT * INTO _old FROM shift_templates WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift_template_update: template not found' USING ERRCODE = 'P0002';
  END IF;
  p_patch := COALESCE(p_patch, '{}'::jsonb);
  FOR _k IN SELECT jsonb_object_keys(p_patch) LOOP
    IF _k NOT IN ('name', 'start_time', 'end_time') THEN
      RAISE EXCEPTION 'shift_template_update: % cannot be changed', _k USING ERRCODE = '22023';
    END IF;
  END LOOP;
  _new := _old;
  IF p_patch ? 'name' THEN
    _new.name := NULLIF(btrim(COALESCE(p_patch ->> 'name', '')), '');
    IF _new.name IS NULL THEN RAISE EXCEPTION 'shift_template_update: a name is required' USING ERRCODE = '22023'; END IF;
  END IF;
  IF p_patch ? 'start_time' THEN _new.start_time := (p_patch ->> 'start_time')::time; END IF;
  IF p_patch ? 'end_time'   THEN _new.end_time   := (p_patch ->> 'end_time')::time; END IF;
  IF NOT (_new.end_time > _new.start_time) THEN
    RAISE EXCEPTION 'shift_template_update: end must be after start' USING ERRCODE = '22023';
  END IF;

  UPDATE shift_templates
     SET name = _new.name, start_time = _new.start_time, end_time = _new.end_time, updated_at = now()
   WHERE id = p_id;

  -- its rows from the Skopje today on follow it (by id, so a rename no longer breaks this)
  UPDATE shifts
     SET name = _new.name, start_time = _new.start_time, end_time = _new.end_time, updated_at = now()
   WHERE template_id = p_id AND date >= _today
     AND (name, start_time, end_time) IS DISTINCT FROM (_new.name, _new.start_time, _new.end_time);
  GET DIAGNOSTICS _n = ROW_COUNT;

  INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, (SELECT email FROM profiles WHERE user_id = p_actor LIMIT 1), 'shifts.template_update',
          'shift_template', p_id::text, _new.name,
          jsonb_build_object(
            'before', jsonb_build_object('name', _old.name, 'start', to_char(_old.start_time, 'HH24:MI'), 'end', to_char(_old.end_time, 'HH24:MI')),
            'after',  jsonb_build_object('name', _new.name, 'start', to_char(_new.start_time, 'HH24:MI'), 'end', to_char(_new.end_time, 'HH24:MI')),
            'from', _today, 'shifts_updated', _n));

  RETURN jsonb_build_object(
    'id', p_id, 'name', _new.name,
    'start_time', to_char(_new.start_time, 'HH24:MI'), 'end_time', to_char(_new.end_time, 'HH24:MI'),
    'shifts_updated', _n, 'from', _today);
END
$fn$;

-- ── statistics: one aggregate, no row cap ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shifts_statistics(p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE _r jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'shifts_statistics: bad date range' USING ERRCODE = '22023';
  END IF;
  IF p_to - p_from > 400 THEN
    RAISE EXCEPTION 'shifts_statistics: at most 401 days' USING ERRCODE = '22023';
  END IF;

  WITH
  a AS (
    SELECT sa.user_id, sa.shift_date AS date, s.start_time AS st,
           extract(epoch FROM (s.end_time - s.start_time)) / 3600.0 AS hrs,
           extract(isodow FROM sa.shift_date) >= 6 AS weekend
      FROM shift_assignments sa
      JOIN shifts s ON s.id = sa.shift_id
     WHERE sa.shift_date BETWEEN p_from AND p_to
       AND NOT (s.start_time = '00:00' AND s.end_time = '00:00')
  ),
  sched AS (
    SELECT user_id,
           count(*) AS shifts,
           count(DISTINCT date) AS days,
           count(DISTINCT date) FILTER (WHERE weekend) AS weekend_days,
           count(*) FILTER (WHERE NOT weekend) AS weekday_shifts,
           count(*) FILTER (WHERE weekend) AS weekend_shifts,
           sum(hrs) AS hours
      FROM a GROUP BY 1
  ),
  lg AS (
    SELECT l.user_id, l.shift_date AS date, min(l.login_time) AS first_login,
           sum(extract(epoch FROM (l.logout_time - l.login_time)))
             FILTER (WHERE l.logout_time IS NOT NULL AND l.logout_time > l.login_time) AS secs
      FROM shift_login_logs l
     WHERE l.shift_date BETWEEN p_from AND p_to
     GROUP BY 1, 2
  ),
  att AS (
    SELECT lg.user_id,
           count(*) AS days_logged_in,
           count(*) FILTER (WHERE a.st IS NOT NULL
                              AND to_char(lg.first_login AT TIME ZONE 'Europe/Skopje', 'HH24:MI') > to_char(a.st, 'HH24:MI')) AS late_days,
           COALESCE(sum(lg.secs), 0) / 3600.0 AS actual_hours
      FROM lg
      LEFT JOIN a ON a.user_id = lg.user_id AND a.date = lg.date
     GROUP BY 1
  ),
  bl AS (
    SELECT user_id, count(*) AS blocked
      FROM blocked_login_attempts
     WHERE (attempt_time AT TIME ZONE 'Europe/Skopje')::date BETWEEN p_from AND p_to
     GROUP BY 1
  ),
  ids AS (SELECT user_id FROM sched UNION SELECT user_id FROM att UNION SELECT user_id FROM bl),
  rs AS (
    SELECT i.user_id, COALESCE(p.full_name, '') AS full_name,
           COALESCE(s.days, 0) AS total_worked_days,
           COALESCE(s.weekend_days, 0) AS total_weekend_days,
           round(COALESCE(s.hours, 0)::numeric, 2) AS total_hours_scheduled,
           round(COALESCE(t.actual_hours, 0)::numeric, 2) AS total_hours_actual,
           COALESCE(s.shifts, 0) AS total_shifts,
           CASE WHEN COALESCE(s.shifts, 0) > 0 THEN round((s.hours / s.shifts)::numeric, 2) ELSE 0 END AS average_hours_per_shift,
           COALESCE(s.weekday_shifts, 0) AS weekday_shifts,
           COALESCE(s.weekend_shifts, 0) AS weekend_shifts,
           COALESCE(t.days_logged_in, 0) AS days_logged_in,
           COALESCE(t.late_days, 0) AS late_days,
           COALESCE(b.blocked, 0) AS blocked_attempts
      FROM ids i
      LEFT JOIN profiles p ON p.user_id = i.user_id
      LEFT JOIN sched s ON s.user_id = i.user_id
      LEFT JOIN att t ON t.user_id = i.user_id
      LEFT JOIN bl b ON b.user_id = i.user_id
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to,
    'rows', COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.full_name) FROM rs r), '[]'::jsonb),
    'totals', (SELECT jsonb_build_object(
                 'people', count(*),
                 'scheduled_hours', COALESCE(sum(total_hours_scheduled), 0),
                 'actual_hours', COALESCE(sum(total_hours_actual), 0),
                 'shifts', COALESCE(sum(total_shifts), 0),
                 'weekday_shifts', COALESCE(sum(weekday_shifts), 0),
                 'weekend_shifts', COALESCE(sum(weekend_shifts), 0),
                 'days_logged_in', COALESCE(sum(days_logged_in), 0),
                 'late_days', COALESCE(sum(late_days), 0),
                 'blocked_attempts', COALESCE(sum(blocked_attempts), 0)) FROM rs))
  INTO _r;
  RETURN _r;
END
$fn$;

-- ── login activity: paged, Skopje times, status codes ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.shifts_login_activity(
  p_from date, p_to date, p_user_id uuid DEFAULT NULL, p_status text DEFAULT NULL,
  p_limit int DEFAULT 50, p_offset int DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _r      jsonb;
  _limit  int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  _offset int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'shifts_login_activity: bad date range' USING ERRCODE = '22023';
  END IF;
  IF p_to - p_from > 400 THEN
    RAISE EXCEPTION 'shifts_login_activity: at most 401 days' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('on_time', 'late', 'early', 'blocked') THEN
    RAISE EXCEPTION 'shifts_login_activity: status is on_time, late, early or blocked' USING ERRCODE = '22023';
  END IF;

  WITH
  ev AS (
    SELECT l.id, 'login'::text AS kind, l.user_id, l.shift_date AS date, l.login_time AS at,
           to_char(l.shift_start_time, 'HH24:MI') AS shift_start,
           to_char(l.shift_end_time, 'HH24:MI') AS shift_end,
           to_char(l.login_time AT TIME ZONE 'Europe/Skopje', 'HH24:MI') AS login_local,
           CASE WHEN l.logout_time IS NOT NULL
                THEN to_char(l.logout_time AT TIME ZONE 'Europe/Skopje', 'HH24:MI') END AS logout_local,
           l.logout_time,
           CASE WHEN l.logout_time IS NOT NULL AND l.logout_time > l.login_time
                THEN round(extract(epoch FROM (l.logout_time - l.login_time)) / 60)::int END AS minutes,
           CASE
             WHEN to_char(l.login_time AT TIME ZONE 'Europe/Skopje', 'HH24:MI') > to_char(l.shift_start_time, 'HH24:MI') THEN 'late'
             WHEN l.logout_time IS NOT NULL
                  AND (l.logout_time AT TIME ZONE 'Europe/Skopje')::date = l.shift_date
                  AND to_char(l.logout_time AT TIME ZONE 'Europe/Skopje', 'HH24:MI') < to_char(l.shift_end_time, 'HH24:MI') THEN 'early'
             ELSE 'on_time'
           END AS status,
           NULL::text AS reason_code, NULL::text AS reason_detail, NULL::text AS logged_name, NULL::text AS logged_role
      FROM shift_login_logs l
     WHERE l.shift_date BETWEEN p_from AND p_to
       AND (p_user_id IS NULL OR l.user_id = p_user_id)
    UNION ALL
    SELECT b.id, 'blocked', b.user_id, (b.attempt_time AT TIME ZONE 'Europe/Skopje')::date, b.attempt_time,
           NULL, NULL, to_char(b.attempt_time AT TIME ZONE 'Europe/Skopje', 'HH24:MI'), NULL, NULL, NULL,
           'blocked',
           CASE WHEN b.reason ILIKE 'No active shift assignment%' THEN 'no_assignment'
                WHEN b.reason ILIKE 'No shift scheduled for today%' THEN 'no_shift_today'
                WHEN b.reason ILIKE 'Shift set to 00:00%' THEN 'zero_shift'
                WHEN b.reason ILIKE 'Outside shift hours%' THEN 'outside_hours'
                ELSE 'other' END,
           CASE WHEN b.reason ILIKE 'Outside shift hours%' THEN substring(b.reason FROM '\(([^)]*)\)') END,
           NULLIF(b.user_name, ''), NULLIF(b.role, '')
      FROM blocked_login_attempts b
     WHERE (b.attempt_time AT TIME ZONE 'Europe/Skopje')::date BETWEEN p_from AND p_to
       AND (p_user_id IS NULL OR b.user_id = p_user_id)
  ),
  f AS (SELECT * FROM ev WHERE p_status IS NULL OR status = p_status),
  pg AS (SELECT * FROM f ORDER BY at DESC, id LIMIT _limit OFFSET _offset),
  rl AS (
    SELECT r.user_id,
           (array_agg(r.role::text ORDER BY CASE r.role::text WHEN 'admin' THEN 1 WHEN 'manager' THEN 2
                                                              WHEN 'warehouse' THEN 3 ELSE 4 END, r.role::text))[1] AS role
      FROM user_roles r WHERE r.user_id IN (SELECT user_id FROM ev) GROUP BY 1
  ),
  summ AS (
    SELECT e.user_id,
           count(*) FILTER (WHERE kind = 'login') AS logins,
           count(DISTINCT date) FILTER (WHERE kind = 'login') AS days,
           count(*) FILTER (WHERE status = 'on_time') AS on_time,
           count(*) FILTER (WHERE status = 'late') AS late,
           count(*) FILTER (WHERE status = 'early') AS early,
           count(*) FILTER (WHERE status = 'blocked') AS blocked,
           max(logged_name) AS logged_name
      FROM ev e GROUP BY 1
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'limit', _limit, 'offset', _offset,
    'total', (SELECT count(*) FROM f),
    'counts', (SELECT jsonb_build_object(
                 'on_time', count(*) FILTER (WHERE status = 'on_time'),
                 'late',    count(*) FILTER (WHERE status = 'late'),
                 'early',   count(*) FILTER (WHERE status = 'early'),
                 'blocked', count(*) FILTER (WHERE status = 'blocked')) FROM ev),
    'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'id', pg.id, 'kind', pg.kind, 'user_id', pg.user_id,
               'user_name', COALESCE(p.full_name, pg.logged_name, ''),
               'role', COALESCE(rl.role, pg.logged_role),
               'date', pg.date, 'at', pg.at,
               'shift_start', pg.shift_start, 'shift_end', pg.shift_end,
               'login_local', pg.login_local, 'logout_local', pg.logout_local, 'logout_time', pg.logout_time,
               'minutes', pg.minutes, 'status', pg.status,
               'reason_code', pg.reason_code, 'reason_detail', pg.reason_detail)
             ORDER BY pg.at DESC, pg.id)
             FROM pg
             LEFT JOIN profiles p ON p.user_id = pg.user_id
             LEFT JOIN rl ON rl.user_id = pg.user_id), '[]'::jsonb),
    'summary', COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'user_id', s.user_id, 'user_name', COALESCE(p.full_name, s.logged_name, ''),
               'logins', s.logins, 'days', s.days, 'on_time', s.on_time,
               'late', s.late, 'early', s.early, 'blocked', s.blocked)
             ORDER BY COALESCE(p.full_name, s.logged_name, ''))
             FROM summ s LEFT JOIN profiles p ON p.user_id = s.user_id), '[]'::jsonb))
  INTO _r;
  RETURN _r;
END
$fn$;

COMMENT ON FUNCTION public.shifts_slot(date, time, time, text, uuid, uuid) IS
  'Find-or-create the shifts row for (date, start, end, name); no name = reuse any row with that window that day, else the month''s name. Migration 20260943001100.';
COMMENT ON FUNCTION public.shifts_grid(date, date) IS
  'GET /api/shifts/grid: people × days → cells (the person''s assignment that day), templates, custom windows in use. Migration 20260943001100.';
COMMENT ON FUNCTION public.shifts_set_cells(jsonb, uuid, text) IS
  'POST /api/shifts/cells: the grid''s atomic save; returns the changes and the undo cells; one audit_log row. Migration 20260943001100.';
COMMENT ON FUNCTION public.shifts_copy_range(date, date, date, text, boolean, uuid) IS
  'POST /api/shifts/copy: copy a range (the previous week) — fill_empty | overwrite; preview = cells, apply = shifts_set_cells. Migration 20260943001100.';
COMMENT ON FUNCTION public.shift_update(uuid, jsonb, uuid[], uuid) IS
  'PATCH /api/shifts/:id: whitelisted (name, date, start_time, end_time, template_id) and atomic with the agents. Migration 20260943001100.';
COMMENT ON FUNCTION public.shift_template_update(uuid, jsonb, uuid) IS
  'PATCH /api/shift-templates/:id: the template and its rows from the Skopje today on, by template_id. Migration 20260943001100.';
COMMENT ON FUNCTION public.shifts_statistics(date, date) IS
  'GET /api/shifts/statistics: per person, one SQL aggregate (no 1.000-row cap). Migration 20260943001100.';
COMMENT ON FUNCTION public.shifts_login_activity(date, date, uuid, text, integer, integer) IS
  'GET /api/shifts/login-activity: logins + blocked attempts, Skopje times, status codes on_time|late|early|blocked, paged. Migration 20260943001100.';

REVOKE ALL ON FUNCTION public.shifts_month_name(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shifts_slot(date, time, time, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shifts_grid(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shifts_set_cells(jsonb, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shifts_copy_range(date, date, date, text, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shift_update(uuid, jsonb, uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shift_template_update(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shifts_statistics(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shifts_login_activity(date, date, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shifts_month_name(date) TO service_role;
GRANT EXECUTE ON FUNCTION public.shifts_slot(date, time, time, text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.shifts_grid(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.shifts_set_cells(jsonb, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shifts_copy_range(date, date, date, text, boolean, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.shift_update(uuid, jsonb, uuid[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.shift_template_update(uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.shifts_statistics(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.shifts_login_activity(date, date, uuid, text, integer, integer) TO service_role;
