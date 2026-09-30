-- Shifts: integrity before the one-page "Смени" redesign (plan Фаза 8, owner 30.09.2026).
--
-- A shift is the LOGIN GATE here: GET /shifts/check-login lets a non-admin/manager in when ANY
-- of today's (Skopje) shifts covers "now" (HH:MM, inclusive end; 00:00–00:00 = "no shift").
-- Nothing below changes who may log in when — the rolled-back test proves the gate's window
-- (earliest start, latest end, no gaps) is identical for every person-day of the last 30 days
-- and October before and after.
--
--   1. shift_login_logs.shift_id → nullable, FK ON DELETE SET NULL. Deleting a shift used to
--      CASCADE-delete its login history (leaderboard first login, insights_work_day, presence,
--      operations and the stats tabs all read it). The row keeps shift_date + the window it
--      was logged against, so nothing is lost when the shift goes.
--   2. shifts CHECK (end > start, or the 00:00–00:00 "no shift" marker). One live row broke it:
--      18.08.2026 "Август" 06:00–00:00 (e42e1b43…, 33 people) — an end of 00:00 the gate read as
--      "never"; it meant midnight, so it becomes 06:00–23:59 (a past day).
--   3. shifts.template_id (FK shift_templates, ON DELETE SET NULL), backfilled by name, so a
--      template edit follows its shifts by id instead of by a name a rename breaks.
--      + index shifts(date).
--   4. shift_assignments.shift_date — a copy of shifts.date kept by triggers, so the table can
--      say "one shift per person per day":
--   5. the double-booked person-days (700 on 30.09: the September roster + "цело дневна" +
--      the October roll) are cleaned to ONE assignment each, then UNIQUE (user_id, shift_date).
--      Kept: the one whose shift has this person's login logs, else the widest window, else
--      the oldest. Because the gate lets you in when ANY shift covers now, the kept row is first
--      widened to the day's union (earliest start → latest end; the windows overlap, so the
--      union is that one span): an existing shift row with that window on that date is reused
--      (the person's own first), else one is created under the kept shift's name, and the kept
--      assignment is re-pointed to it. Nobody's allowed hours narrow.
--      Every removed row AND every re-pointed row is in shift_assignments_removed_20261001
--      (action removed | repointed, with the old shift_id) — the rollback is in the table.
--   6. shifts_roll_forward (20260943000100) re-emitted: with one assignment per day it can no
--      longer add a second row next to a narrower one — it widens that day's row to the union
--      of the old window and the rolled one instead (same "never narrow" rule).
--
-- Service role only; RLS on the backup table with no policies. Apply outside 06:30–08:00
-- (agents log in then); lock_timeout keeps it from queueing behind a login.

SET LOCAL lock_timeout = '10s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.oid = to_regprocedure('public.shifts_roll_forward(date,date,date,date,uuid[],boolean,uuid,text)')
                    AND md5(replace(p.prosrc, chr(13), '')) = '2a92ad2437bb2df7eb44ef9d96ad3fe5') THEN
    RAISE EXCEPTION 'shifts_roll_forward changed since this migration was written — re-emit it from the live body';
  END IF;
END
$drift$;

-- ── 1. login history survives a deleted shift ───────────────────────────────────────────────
ALTER TABLE public.shift_login_logs ALTER COLUMN shift_id DROP NOT NULL;
ALTER TABLE public.shift_login_logs DROP CONSTRAINT IF EXISTS shift_login_logs_shift_id_fkey;
ALTER TABLE public.shift_login_logs
  ADD CONSTRAINT shift_login_logs_shift_id_fkey
  FOREIGN KEY (shift_id) REFERENCES public.shifts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_shift_login_logs_date_user ON public.shift_login_logs (shift_date, user_id);
CREATE INDEX IF NOT EXISTS idx_shift_login_logs_user_login ON public.shift_login_logs (user_id, login_time DESC);
CREATE INDEX IF NOT EXISTS idx_shift_login_logs_shift ON public.shift_login_logs (shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_blocked_login_attempts_time ON public.blocked_login_attempts (attempt_time DESC);

-- ── 2. a window ends after it starts (or is the 00:00–00:00 "no shift" marker) ─────────────
ALTER TABLE public.shifts DROP CONSTRAINT IF EXISTS shifts_window_check;
ALTER TABLE public.shifts
  ADD CONSTRAINT shifts_window_check
  CHECK (end_time > start_time OR (start_time = '00:00' AND end_time = '00:00')) NOT VALID;
-- an end of 00:00 after a real start meant midnight
UPDATE public.shifts
   SET end_time = '23:59', updated_at = now()
 WHERE end_time = '00:00' AND start_time > '00:00';
ALTER TABLE public.shifts VALIDATE CONSTRAINT shifts_window_check;

-- ── 3. template link + date index ──────────────────────────────────────────────────────────
ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS template_id uuid REFERENCES public.shift_templates(id) ON DELETE SET NULL;
UPDATE public.shifts s
   SET template_id = t.id
  FROM (SELECT DISTINCT ON (lower(btrim(name))) id, lower(btrim(name)) AS k
          FROM public.shift_templates ORDER BY lower(btrim(name)), created_at) t
 WHERE s.template_id IS NULL
   AND lower(btrim(s.name)) = t.k;
CREATE INDEX IF NOT EXISTS idx_shifts_date ON public.shifts (date);
CREATE INDEX IF NOT EXISTS idx_shifts_template_date ON public.shifts (template_id, date) WHERE template_id IS NOT NULL;

-- ── 4. shift_assignments.shift_date, kept equal to shifts.date ─────────────────────────────
ALTER TABLE public.shift_assignments ADD COLUMN IF NOT EXISTS shift_date date;

CREATE OR REPLACE FUNCTION public.shift_assignments_set_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  NEW.shift_date := (SELECT s.date FROM public.shifts s WHERE s.id = NEW.shift_id);
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION public.shifts_sync_assignment_dates()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- a moved shift moves its people; UNIQUE (user_id, shift_date) refuses a move onto a day
  -- someone already works (the api's shift_update says who before it tries)
  UPDATE public.shift_assignments SET shift_date = NEW.date WHERE shift_id = NEW.id;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS trg_shift_assignments_set_date ON public.shift_assignments;
CREATE TRIGGER trg_shift_assignments_set_date
  BEFORE INSERT OR UPDATE ON public.shift_assignments
  FOR EACH ROW EXECUTE FUNCTION public.shift_assignments_set_date();

DROP TRIGGER IF EXISTS trg_shifts_sync_assignment_dates ON public.shifts;
CREATE TRIGGER trg_shifts_sync_assignment_dates
  AFTER UPDATE OF date ON public.shifts
  FOR EACH ROW WHEN (OLD.date IS DISTINCT FROM NEW.date)
  EXECUTE FUNCTION public.shifts_sync_assignment_dates();

REVOKE ALL ON FUNCTION public.shift_assignments_set_date() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shifts_sync_assignment_dates() FROM PUBLIC, anon, authenticated;

UPDATE public.shift_assignments sa
   SET shift_date = s.date
  FROM public.shifts s
 WHERE s.id = sa.shift_id AND sa.shift_date IS DISTINCT FROM s.date;
ALTER TABLE public.shift_assignments ALTER COLUMN shift_date SET NOT NULL;

-- ── 5. one assignment per person per day ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.shift_assignments_removed_20261001 (
  id            uuid PRIMARY KEY,            -- the shift_assignments.id
  action        text NOT NULL CHECK (action IN ('removed', 'repointed')),
  shift_id      uuid NOT NULL,               -- what it pointed at before this migration
  user_id       uuid NOT NULL,
  shift_date    date NOT NULL,
  created_at    timestamptz NOT NULL,        -- the assignment's own created_at
  shift_name    text,
  start_time    time,
  end_time      time,
  had_logins    boolean NOT NULL,
  kept_id       uuid NOT NULL,               -- the assignment kept for that person-day
  new_shift_id  uuid,                        -- repointed: the union-window shift it points at now
  backed_up_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.shift_assignments_removed_20261001 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shift_assignments_removed_20261001 FROM anon, authenticated;
COMMENT ON TABLE public.shift_assignments_removed_20261001 IS
  'Backup of migration 20260943001000: every double-booked shift assignment removed (action=removed) and every kept one re-pointed to the day''s union window (action=repointed, new_shift_id). Rollback: re-insert the removed rows and set shift_id back on the repointed ones (drop UNIQUE (user_id, shift_date) first).';

CREATE TEMP TABLE _sa ON COMMIT DROP AS
SELECT sa.id, sa.user_id, sa.shift_id, sa.created_at, sa.shift_date AS date,
       s.name, s.start_time AS st, s.end_time AS en, s.created_by, s.template_id,
       (s.start_time = '00:00' AND s.end_time = '00:00') AS zero,
       (SELECT count(*) FROM public.shift_login_logs l
         WHERE l.shift_id = sa.shift_id AND l.user_id = sa.user_id) AS nlogs
  FROM public.shift_assignments sa
  JOIN public.shifts s ON s.id = sa.shift_id
 WHERE (sa.user_id, sa.shift_date) IN (SELECT user_id, shift_date FROM public.shift_assignments
                                        GROUP BY 1, 2 HAVING count(*) > 1);

CREATE TEMP TABLE _keep ON COMMIT DROP AS
WITH hull AS (
  SELECT user_id, date,
         min(st) FILTER (WHERE NOT zero) AS h_st,
         max(en) FILTER (WHERE NOT zero) AS h_en
    FROM _sa GROUP BY 1, 2
),
ranked AS (
  SELECT a.*, h.h_st, h.h_en,
         row_number() OVER (PARTITION BY a.user_id, a.date
                            ORDER BY (a.nlogs > 0) DESC, a.nlogs DESC, a.zero,
                                     (a.en - a.st) DESC, a.created_at, a.id) AS rn
    FROM _sa a JOIN hull h USING (user_id, date)
)
SELECT r.*,
       -- all-zero days stay as they are; otherwise the kept row must carry the union
       (r.h_st IS NOT NULL AND (r.st, r.en) IS DISTINCT FROM (r.h_st, r.h_en)) AS repoint,
       NULL::uuid AS new_shift_id
  FROM ranked r;

-- the union-window shift rows that do not exist yet on that date
INSERT INTO public.shifts (name, date, start_time, end_time, created_by)
SELECT DISTINCT ON (k.date, k.h_st, k.h_en) k.name, k.date, k.h_st, k.h_en, k.created_by
  FROM _keep k
 WHERE k.rn = 1 AND k.repoint
   AND NOT EXISTS (SELECT 1 FROM public.shifts s
                    WHERE s.date = k.date AND s.start_time = k.h_st AND s.end_time = k.h_en)
 ORDER BY k.date, k.h_st, k.h_en, k.name;

UPDATE _keep k
   SET new_shift_id = (
         SELECT s.id FROM public.shifts s
          WHERE s.date = k.date AND s.start_time = k.h_st AND s.end_time = k.h_en
          ORDER BY EXISTS (SELECT 1 FROM _sa a WHERE a.user_id = k.user_id AND a.shift_id = s.id) DESC,
                   (s.name = k.name) DESC, s.created_at, s.id
          LIMIT 1)
 WHERE k.rn = 1 AND k.repoint;

INSERT INTO public.shift_assignments_removed_20261001
       (id, action, shift_id, user_id, shift_date, created_at, shift_name, start_time, end_time,
        had_logins, kept_id, new_shift_id)
SELECT k.id, CASE WHEN k.rn = 1 THEN 'repointed' ELSE 'removed' END,
       k.shift_id, k.user_id, k.date, k.created_at, k.name, k.st, k.en,
       k.nlogs > 0, kk.id, CASE WHEN k.rn = 1 THEN k.new_shift_id END
  FROM _keep k
  JOIN _keep kk ON kk.user_id = k.user_id AND kk.date = k.date AND kk.rn = 1
 WHERE k.rn > 1 OR k.repoint
ON CONFLICT (id) DO NOTHING;

DELETE FROM public.shift_assignments sa
 USING _keep k
 WHERE k.id = sa.id AND k.rn > 1;

UPDATE public.shift_assignments sa
   SET shift_id = k.new_shift_id
  FROM _keep k
 WHERE k.id = sa.id AND k.rn = 1 AND k.repoint AND k.new_shift_id IS NOT NULL;

ALTER TABLE public.shift_assignments DROP CONSTRAINT IF EXISTS shift_assignments_user_day_key;
ALTER TABLE public.shift_assignments
  ADD CONSTRAINT shift_assignments_user_day_key UNIQUE (user_id, shift_date);

COMMENT ON COLUMN public.shift_assignments.shift_date IS
  'Copy of shifts.date (triggers trg_shift_assignments_set_date / trg_shifts_sync_assignment_dates) so UNIQUE (user_id, shift_date) can say one shift per person per day — the login gate reads that day''s window. Migration 20260943001000.';
COMMENT ON COLUMN public.shifts.template_id IS
  'The shift template this row was painted from (NULL = a custom window or a month roll). A template edit moves the future (Skopje today on) rows that carry its id. Migration 20260943001000.';

-- ── 6. shifts_roll_forward: never a second row on a day, widen the one that is there ───────
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
  _wide   int := 0;
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

  -- every shift write is serialised (shifts_set_cells / shifts_copy_range / shift_update take the same lock)
  IF p_apply THEN PERFORM pg_advisory_xact_lock(hashtext('elyon.shifts.write')); END IF;

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
    -- One assignment per person-day (UNIQUE (user_id, shift_date), 20260943001000): a day that
    -- already has a narrower row gets that row widened to the union of the two windows (the
    -- gate never narrows); a 00:00–00:00 "no shift" marker is replaced by the rolled window.
    DROP TABLE IF EXISTS _ap;
    CREATE TEMP TABLE _ap ON COMMIT DROP AS
    SELECT pl.user_id, pl.date, ex.aid,
           CASE WHEN ex.aid IS NULL OR ex.zero THEN pl.st ELSE LEAST(pl.st, ex.st) END AS st,
           CASE WHEN ex.aid IS NULL OR ex.zero THEN pl.en ELSE GREATEST(pl.en, ex.en) END AS en
      FROM _plan pl
      LEFT JOIN LATERAL (
        SELECT sa.id AS aid, s.start_time AS st, s.end_time AS en,
               (s.start_time = '00:00' AND s.end_time = '00:00') AS zero
          FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id
         WHERE sa.user_id = pl.user_id AND sa.shift_date = pl.date
         LIMIT 1) ex ON true
     WHERE NOT pl.covered;

    -- one shifts row per (date, start, end) under the month name; reuse it on a re-run
    INSERT INTO shifts (name, date, start_time, end_time, created_by)
    SELECT DISTINCT _name, a.date, a.st, a.en, p_actor
      FROM _ap a
     WHERE NOT EXISTS (SELECT 1 FROM shifts s WHERE s.name = _name AND s.date = a.date
                          AND s.start_time = a.st AND s.end_time = a.en);
    GET DIAGNOSTICS _shifts = ROW_COUNT;

    INSERT INTO shift_assignments (shift_id, user_id)
    SELECT s.id, a.user_id
      FROM _ap a
      JOIN LATERAL (SELECT id FROM shifts s WHERE s.name = _name AND s.date = a.date
                       AND s.start_time = a.st AND s.end_time = a.en
                     ORDER BY created_at LIMIT 1) s ON true
     WHERE a.aid IS NULL
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS _rows = ROW_COUNT;

    UPDATE shift_assignments sa
       SET shift_id = s.id
      FROM _ap a
      JOIN LATERAL (SELECT id FROM shifts s WHERE s.name = _name AND s.date = a.date
                       AND s.start_time = a.st AND s.end_time = a.en
                     ORDER BY created_at LIMIT 1) s ON true
     WHERE a.aid IS NOT NULL AND sa.id = a.aid AND sa.shift_id <> s.id;
    GET DIAGNOSTICS _wide = ROW_COUNT;

    INSERT INTO audit_log (actor_id, action, target_type, target_name, payload)
    VALUES (p_actor, 'shifts.roll_forward', 'shifts', _name,
            jsonb_build_object('src', jsonb_build_array(p_src_from, p_src_to),
                               'dst', jsonb_build_array(p_dst_from, p_dst_to),
                               'people', jsonb_array_length(_people),
                               'shifts_created', _shifts, 'assignments_created', _rows,
                               'assignments_widened', _wide,
                               'skipped_covered', _skip));
  END IF;

  RETURN jsonb_build_object(
    'apply', p_apply, 'name', _name,
    'src', jsonb_build_array(p_src_from, p_src_to), 'dst', jsonb_build_array(p_dst_from, p_dst_to),
    'people', _people, 'excluded', _excl,
    'person_days', (SELECT count(*) FILTER (WHERE NOT covered) FROM _plan),
    'skipped_covered', _skip,
    'shifts_created', _shifts, 'assignments_created', _rows, 'assignments_widened', _wide);
END
$fn$;

COMMENT ON FUNCTION public.shifts_roll_forward(date, date, date, date, uuid[], boolean, uuid, text) IS
  'Copy each active agent''s shift pattern (most frequent daily window + weekdays worked on ≥ half of them) from a source window into a destination window; fills only person-days not already covered, and widens (never narrows) a day that already has a narrower shift — one assignment per person-day; apply=false = preview. One shifts row per (date,start,end) named after the month + assignments + audit_log. Migrations 20260943000100, 20260943001000.';

REVOKE ALL ON FUNCTION public.shifts_roll_forward(date, date, date, date, uuid[], boolean, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shifts_roll_forward(date, date, date, date, uuid[], boolean, uuid, text) TO service_role;
