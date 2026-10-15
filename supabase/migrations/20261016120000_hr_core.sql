-- ============================================================================
-- HR — Човечки ресурси, Фаза 1 (owner 15.10.2026): the dossier, absences, holidays, and the link
-- to the shift roster. Plan: C:\Users\Mile\.claude\plans\wondrous-tinkering-pearl.md
-- ============================================================================
-- Owner's decisions (15.10.2026):
--   · EVERY employee — call centre, the 22 shops, warehouse, office. An employee is NOT a login:
--     hr_employees.user_id is optional (shop staff have no CRM account).
--   · Leave is approved by the TEAM first (the employee's explicit approver, else the dept_admins of
--     the employee's team), then by a MANAGER (the final approvers: access level administrator /
--     owner / super_admin, or app_settings.hr.final_approvers). A super admin may decide at any stage.
--   · The dossier (personal data, contract) is seen by super_admin / owner / finance only
--     (can_see_margins) — the api strips those fields for everyone else.
--
-- Labour law (ЗРО; the accountant confirms the numbers — they are DEFAULTS, every one editable):
--   · annual leave ≥ 20 working days; a new employee earns 2 days per month worked until 6 months;
--     +days for age / disability are the employee's extra_leave_days;
--   · carry-over from last year is usable until 30.06 (taken leave dated ≤ 30.06 uses it first);
--   · the first part of the year's leave is ≥ 12 working days in one go (a warning, not a block);
--   · sick leave: the first 30 days of an uninterrupted spell are paid by the employer, from day 31
--     ФЗОМ refunds (computed per spell, never typed);
--   · the default work week is Mon–Fri (the shift roster is a login window, not the work days):
--     HR sets each person's work_days (a shop Mon–Sat) — annual leave counts those days;
--   · paid personal leave (wedding, death, birth) up to 7 days a year (a warning);
--   · holidays: the state days for everyone + the religious / community days for their believers
--     (hr_employees.holiday_calendars); a state holiday on a Sunday moves to the Monday (stored).
--
--   hr_employees            the dossier (one row per person; user_id optional, unique)
--   hr_leave_types          the absence kinds and how they count (working / calendar days)
--   hr_leave_requests       pending_team → pending_manager → approved | rejected | cancelled
--   hr_leave_entitlements   a year's right per person (no row = hr_default_entitlement)
--   hr_holidays             dated, scoped (all / orthodox / muslim / catholic / jewish / communities)
--
--   hr_working_days(emp, from, to)       the person's work days minus their holidays
--   hr_request_days(emp, type, from, to) working or calendar days by the type
--   hr_balance(emp, year[, today])       right / taken / planned / pending / carry / expiring / sick split
--   hr_balances(year, emp_ids)           the same for many
--   hr_absence_on(user, day)             the approved absence of a LOGIN on a day (shifts + login gate)
--   hr_leave_request / hr_leave_decide / hr_leave_cancel / hr_employee_save / hr_entitlement_set /
--   hr_holiday_save / hr_holiday_delete  the only writers — audited (audit_log hr.*), service role only;
--                                        the api checks the caller and passes p_actor
--
-- Shifts (the roster is the LOGIN GATE):
--   · approving an absence removes the person's shifts on its days (kept in removed_shifts; a cancel
--     before the day puts them back);
--   · no shift can be put on an approved-absence day: shifts_set_cells skips the cell (and reports it),
--     a trigger skips any other insert (roll-forward, copy, the legacy form);
--   · shifts_grid returns the absences (the grid shows О / Б / П …);
--   · shifts_runway counts an approved absence as covered;
--   · GET /shifts/check-login answers code on_leave (api).
--
-- Tables: RLS on, no policy — read and written only through the api (service role).
-- Rollback: DROP the trigger + the hr_* functions and tables; re-run shifts_grid / shifts_set_cells /
-- shifts_runway from 20260943001100 / 20260943000100.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '10s';

-- ── 1. Tables ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.hr_employees (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  full_name          text NOT NULL CHECK (btrim(full_name) <> ''),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  company            text,
  workplace          text NOT NULL DEFAULT 'call_centre'
                       CHECK (workplace IN ('call_centre', 'shop', 'warehouse', 'office', 'field')),
  shop_name          text,
  position           text,
  team_key           text CHECK (team_key IS NULL OR team_key IN ('teleshop', 'affiliate', 'management')),
  approver_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  work_days          smallint[] NOT NULL DEFAULT '{1,2,3,4,5}'
                       CHECK (cardinality(work_days) BETWEEN 1 AND 7 AND work_days <@ '{1,2,3,4,5,6,7}'::smallint[]),
  holiday_calendars  text[] NOT NULL DEFAULT '{orthodox}'
                       CHECK (holiday_calendars <@ ARRAY['orthodox', 'muslim', 'catholic', 'jewish', 'albanian',
                                                       'turkish', 'roma', 'vlach', 'serbian', 'bosniak']),
  -- the dossier (super_admin / owner / finance only — the api strips these)
  phone              text,
  email              text,
  birth_date         date,
  address            text,
  emergency_contact  text,
  hire_date          date,
  contract_type      text CHECK (contract_type IS NULL OR contract_type IN
                       ('indefinite', 'fixed', 'part_time', 'seasonal', 'student', 'other')),
  contract_end       date,
  probation_end      date,
  prior_service_months int NOT NULL DEFAULT 0 CHECK (prior_service_months BETWEEN 0 AND 720),
  extra_leave_days   smallint NOT NULL DEFAULT 0 CHECK (extra_leave_days BETWEEN 0 AND 15),
  extra_leave_reason text,
  left_at            date,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
COMMENT ON TABLE public.hr_employees IS
  'HR dossier, one row per employee — call centre, shops, warehouse, office (owner 15.10.2026). user_id optional (shop staff have no login). Personal fields are for super_admin / owner / finance only (the api strips them). Written only by hr_employee_save(). 20261016120000.';

CREATE TABLE IF NOT EXISTS public.hr_leave_types (
  key           text PRIMARY KEY,
  day_basis     text NOT NULL CHECK (day_basis IN ('working', 'calendar')),
  counts_annual boolean NOT NULL DEFAULT false,
  paid          boolean NOT NULL DEFAULT true,
  needs_doc     boolean NOT NULL DEFAULT false,
  letter        text NOT NULL,
  sort          int NOT NULL DEFAULT 100,
  active        boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE public.hr_leave_types IS
  'Absence kinds: how their days count (working = the person''s work days minus holidays; calendar = every day), whether they use the annual leave, the grid letter. Names are translated in the UI (hrPage.types.<key>). 20261016120000.';

INSERT INTO public.hr_leave_types (key, day_basis, counts_annual, paid, needs_doc, letter, sort) VALUES
  ('annual',        'working',  true,  true,  false, 'О', 10),
  ('sick',          'calendar', false, true,  true,  'Б', 20),
  ('personal_paid', 'working',  false, true,  false, 'П', 30),
  ('unpaid',        'working',  false, false, false, 'Н', 40),
  ('maternity',     'calendar', false, true,  true,  'М', 50),
  ('business_trip', 'working',  false, true,  false, 'С', 60),
  ('comp_day',      'working',  false, true,  false, 'К', 70),
  ('other',         'working',  false, true,  false, 'Д', 90)
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.hr_leave_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  type           text NOT NULL REFERENCES public.hr_leave_types(key),
  date_from      date NOT NULL,
  date_to        date NOT NULL,
  days           numeric(6,1) NOT NULL DEFAULT 0,
  status         text NOT NULL CHECK (status IN ('pending_team', 'pending_manager', 'approved', 'rejected', 'cancelled')),
  note           text,
  doc_ref        text,
  requested_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  team_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  team_at        timestamptz,
  team_note      text,
  decided_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at     timestamptz,
  decision_note  text,
  cancelled_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at   timestamptz,
  cancel_note    text,
  removed_shifts jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT hr_leave_requests_range_chk CHECK (date_to >= date_from AND date_to - date_from <= 366)
);
CREATE INDEX IF NOT EXISTS hr_leave_requests_emp_idx ON public.hr_leave_requests (employee_id, date_from);
CREATE INDEX IF NOT EXISTS hr_leave_requests_open_idx ON public.hr_leave_requests (status)
  WHERE status IN ('pending_team', 'pending_manager');
CREATE INDEX IF NOT EXISTS hr_leave_requests_dates_idx ON public.hr_leave_requests (date_from, date_to)
  WHERE status = 'approved';
COMMENT ON TABLE public.hr_leave_requests IS
  'Absences: pending_team (the team approves) → pending_manager (a manager approves) → approved | rejected | cancelled. days = at request time, by the type''s basis. removed_shifts = the shift assignments the approval took off (a cancel before the day puts them back). Written only by hr_leave_request / hr_leave_decide / hr_leave_cancel. 20261016120000.';

CREATE TABLE IF NOT EXISTS public.hr_leave_entitlements (
  employee_id uuid NOT NULL REFERENCES public.hr_employees(id) ON DELETE CASCADE,
  year        int  NOT NULL CHECK (year BETWEEN 2020 AND 2100),
  base_days   numeric(5,1) NOT NULL CHECK (base_days BETWEEN 0 AND 60),
  extra_days  numeric(5,1) NOT NULL DEFAULT 0 CHECK (extra_days BETWEEN 0 AND 30),
  carry_days  numeric(5,1) NOT NULL DEFAULT 0 CHECK (carry_days BETWEEN 0 AND 60),
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (employee_id, year)
);
COMMENT ON TABLE public.hr_leave_entitlements IS
  'A year''s annual-leave right set by HR (base + extra + carried from last year, usable until 30.06). No row = hr_default_entitlement(). Written only by hr_entitlement_set(). 20261016120000.';

CREATE TABLE IF NOT EXISTS public.hr_holidays (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date       date NOT NULL,
  name       text NOT NULL CHECK (btrim(name) <> ''),
  scope      text NOT NULL DEFAULT 'all'
               CHECK (scope IN ('all', 'orthodox', 'muslim', 'catholic', 'jewish', 'albanian',
                                'turkish', 'roma', 'vlach', 'serbian', 'bosniak')),
  moved_from date,
  verified   boolean NOT NULL DEFAULT true,
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (date, scope, name)
);
CREATE INDEX IF NOT EXISTS hr_holidays_date_idx ON public.hr_holidays (date);
COMMENT ON TABLE public.hr_holidays IS
  'Non-working days: scope all = everyone, else only for employees whose holiday_calendars hold the scope (Закон за празниците). A Sunday state holiday''s Monday is stored with moved_from. verified = false: the date is computed / lunar — check it against the government''s calendar. Written only by hr_holiday_save / hr_holiday_delete. 20261016120000.';

ALTER TABLE public.hr_employees          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_leave_types        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_leave_requests     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_leave_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_holidays           ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hr_employees, public.hr_leave_types, public.hr_leave_requests,
              public.hr_leave_entitlements, public.hr_holidays
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.hr_employees, public.hr_leave_types, public.hr_leave_requests,
                public.hr_leave_entitlements, public.hr_holidays TO service_role;

-- ── 2. Holidays and days ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_is_holiday(p_cals text[], p_day date)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.hr_holidays h
                  WHERE h.date = p_day AND (h.scope = 'all' OR h.scope = ANY (coalesce(p_cals, '{}'::text[]))))
$$;

CREATE OR REPLACE FUNCTION public.hr_working_days(p_emp uuid, p_from date, p_to date)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN 0 ELSE (
    SELECT count(*)::int
      FROM public.hr_employees e,
           generate_series(p_from, p_to, interval '1 day') g(d)
     WHERE e.id = p_emp
       AND extract(isodow FROM g.d)::smallint = ANY (e.work_days)
       AND NOT EXISTS (SELECT 1 FROM public.hr_holidays h
                        WHERE h.date = g.d::date
                          AND (h.scope = 'all' OR h.scope = ANY (e.holiday_calendars)))) END
$$;
COMMENT ON FUNCTION public.hr_working_days(uuid, date, date) IS
  'The employee''s working days in [from, to]: their work_days (ISO weekdays) minus the holidays that apply to them. 20261016120000.';

CREATE OR REPLACE FUNCTION public.hr_request_days(p_emp uuid, p_type text, p_from date, p_to date)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_to < p_from THEN 0
              WHEN (SELECT t.day_basis FROM public.hr_leave_types t WHERE t.key = p_type) = 'calendar'
                THEN (p_to - p_from + 1)
              ELSE public.hr_working_days(p_emp, p_from, p_to) END
$$;

-- ── 3. The year's right and the balance ─────────────────────────────────────
-- Default right when HR has not set the year: 20 days; hired during the year → 2 per full month
-- worked by 31.12 until 6 months (then the full 20); + the person's extra_leave_days. Carry: from
-- 2027 on, what was left of last year (2026, the first HR year, starts at 0 unless HR sets it).
CREATE OR REPLACE FUNCTION public.hr_default_entitlement(p_emp uuid, p_year int)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _e      public.hr_employees%ROWTYPE;
  _y0     date := make_date(p_year, 1, 1);
  _y1     date := make_date(p_year, 12, 31);
  _months int;
  _base   numeric;
  _carry  numeric := 0;
BEGIN
  SELECT * INTO _e FROM public.hr_employees WHERE id = p_emp;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF _e.hire_date IS NULL OR _e.hire_date < _y0 THEN
    _base := 20;
  ELSIF _e.hire_date > _y1 THEN
    _base := 0;
  ELSE
    _months := (extract(year FROM age(_y1 + 1, _e.hire_date)) * 12 + extract(month FROM age(_y1 + 1, _e.hire_date)))::int;
    _base := CASE WHEN _months >= 6 THEN 20 ELSE 2 * _months END;
  END IF;
  -- 2026 holds no leave from before HR existed: last year's rest carries over automatically only
  -- from 2028, or when HR set last year's right (= that year is tracked); else HR types the carry
  IF (_e.hire_date IS NULL OR _e.hire_date < _y0)
     AND (p_year >= 2028 OR EXISTS (SELECT 1 FROM public.hr_leave_entitlements x
                                     WHERE x.employee_id = p_emp AND x.year = p_year - 1)) THEN
    _carry := greatest(0, coalesce((public.hr_balance(p_emp, p_year - 1, _y1) ->> 'remaining_year')::numeric, 0));
  END IF;
  RETURN jsonb_build_object('base_days', _base, 'extra_days', _e.extra_leave_days, 'carry_days', _carry,
                            'note', NULL, 'source', 'default');
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_balance(p_emp uuid, p_year int, p_today date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _today   date := coalesce(p_today, (now() AT TIME ZONE 'Europe/Skopje')::date);
  _y0      date := make_date(p_year, 1, 1);
  _h1      date := make_date(p_year, 6, 30);
  _y1      date := make_date(p_year, 12, 31);
  _ent     jsonb;
  _base    numeric;
  _extra   numeric;
  _carry   numeric;
  _taken   numeric := 0;   -- approved annual days in the year (past + future)
  _past    numeric := 0;   -- of them before today
  _h1days  numeric := 0;   -- of them on or before 30.06
  _pending numeric := 0;   -- requested, not decided
  _longest numeric := 0;   -- the longest single approved annual request (working days in the year)
  _personal numeric := 0;
  _unpaid  numeric := 0;
  _sick_er int := 0;
  _sick_fz int := 0;
  _carry_used numeric;
  _carry_avail numeric;
BEGIN
  SELECT CASE WHEN x.employee_id IS NULL THEN public.hr_default_entitlement(p_emp, p_year)
              ELSE jsonb_build_object('base_days', x.base_days, 'extra_days', x.extra_days, 'carry_days', x.carry_days,
                                      'note', x.note, 'source', 'set') END
    INTO _ent
    FROM (SELECT 1) one
    LEFT JOIN public.hr_leave_entitlements x ON x.employee_id = p_emp AND x.year = p_year;
  IF _ent IS NULL THEN RETURN NULL; END IF;
  _base  := (_ent ->> 'base_days')::numeric;
  _extra := (_ent ->> 'extra_days')::numeric;
  _carry := (_ent ->> 'carry_days')::numeric;

  SELECT coalesce(sum(public.hr_working_days(p_emp, greatest(r.date_from, _y0), least(r.date_to, _y1))), 0),
         coalesce(sum(public.hr_working_days(p_emp, greatest(r.date_from, _y0), least(r.date_to, _today - 1))), 0),
         coalesce(sum(public.hr_working_days(p_emp, greatest(r.date_from, _y0), least(r.date_to, _h1))), 0),
         coalesce(max(public.hr_working_days(p_emp, greatest(r.date_from, _y0), least(r.date_to, _y1))), 0)
    INTO _taken, _past, _h1days, _longest
    FROM public.hr_leave_requests r
   WHERE r.employee_id = p_emp AND r.type = 'annual' AND r.status = 'approved'
     AND r.date_from <= _y1 AND r.date_to >= _y0;

  SELECT coalesce(sum(public.hr_working_days(p_emp, greatest(r.date_from, _y0), least(r.date_to, _y1))), 0)
    INTO _pending
    FROM public.hr_leave_requests r
   WHERE r.employee_id = p_emp AND r.type = 'annual' AND r.status IN ('pending_team', 'pending_manager')
     AND r.date_from <= _y1 AND r.date_to >= _y0;

  SELECT coalesce(sum(public.hr_request_days(p_emp, r.type, greatest(r.date_from, _y0), least(r.date_to, _y1)))
                    FILTER (WHERE r.type = 'personal_paid'), 0),
         coalesce(sum(public.hr_request_days(p_emp, r.type, greatest(r.date_from, _y0), least(r.date_to, _y1)))
                    FILTER (WHERE r.type = 'unpaid'), 0)
    INTO _personal, _unpaid
    FROM public.hr_leave_requests r
   WHERE r.employee_id = p_emp AND r.status = 'approved' AND r.type IN ('personal_paid', 'unpaid')
     AND r.date_from <= _y1 AND r.date_to >= _y0;

  -- sick leave: uninterrupted spells (an approved sick request starting the day after another ends
  -- continues it); day 1–30 of a spell = the employer, from day 31 = ФЗОМ
  WITH s AS (
    SELECT r.date_from, r.date_to FROM public.hr_leave_requests r
     WHERE r.employee_id = p_emp AND r.type = 'sick' AND r.status = 'approved'
       AND r.date_to >= _y0 - 400 AND r.date_from <= _y1
  ), o AS (
    SELECT date_from, date_to,
           CASE WHEN date_from <= coalesce(max(date_to) OVER (ORDER BY date_from, date_to
                                                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), date_from - 2) + 1
                THEN 0 ELSE 1 END AS starts
      FROM s
  ), i AS (
    SELECT date_from, date_to, sum(starts) OVER (ORDER BY date_from, date_to) AS spell FROM o
  ), sp AS (
    SELECT spell, min(date_from) AS spell_start FROM i GROUP BY spell
  ), d AS (
    SELECT DISTINCT g.d::date AS day, sp.spell_start
      FROM i JOIN sp USING (spell), generate_series(i.date_from, i.date_to, interval '1 day') g(d)
  )
  SELECT count(*) FILTER (WHERE day - spell_start < 30), count(*) FILTER (WHERE day - spell_start >= 30)
    INTO _sick_er, _sick_fz
    FROM d WHERE day BETWEEN _y0 AND _y1;

  _carry_used  := least(_carry, _h1days);
  _carry_avail := CASE WHEN _today <= _h1 THEN _carry ELSE _carry_used END;

  RETURN jsonb_build_object(
    'employee_id', p_emp, 'year', p_year, 'today', _today,
    'source', _ent ->> 'source', 'note', _ent ->> 'note',
    'base_days', _base, 'extra_days', _extra, 'carry_days', _carry,
    'carry_until', _h1,
    'carry_available', _carry_avail,
    'carry_expiring', CASE WHEN _today <= _h1 THEN greatest(0, _carry - _h1days) ELSE 0 END,
    'carry_lost', CASE WHEN _today > _h1 THEN greatest(0, _carry - _carry_used) ELSE 0 END,
    'entitled', _base + _extra + _carry_avail,
    'taken', _taken, 'used', _past, 'planned', _taken - _past, 'pending', _pending,
    'remaining', _base + _extra + _carry_avail - _taken,
    -- what is left of THIS year's own right (next year's carry): the carry is spent first
    'remaining_year', _base + _extra - greatest(0, _taken - _carry_used),
    'longest_block', _longest,
    'first_part_ok', _longest >= 12 OR (_base + _extra) < 12,
    'personal_paid_days', _personal, 'personal_paid_over', _personal > 7,
    'unpaid_days', _unpaid,
    'sick_employer_days', _sick_er, 'sick_fzom_days', _sick_fz);
END;
$$;
COMMENT ON FUNCTION public.hr_balance(uuid, int, date) IS
  'Annual leave of one employee in one year: right (base + extra + carry usable until 30.06), taken / used / planned / pending, remaining, the expiring carry, the longest block (first part ≥ 12), personal paid days (> 7 = warning), sick days split employer (day 1–30 of a spell) / ФЗОМ (31+). 20261016120000.';

CREATE OR REPLACE FUNCTION public.hr_balances(p_year int, p_emp_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(jsonb_agg(public.hr_balance(e.id, p_year) ORDER BY e.full_name), '[]'::jsonb)
    FROM public.hr_employees e
   WHERE (p_emp_ids IS NULL OR e.id = ANY (p_emp_ids))
     AND (e.status = 'active' OR e.left_at >= make_date(p_year, 1, 1))
$$;

-- ── 4. Who approves ─────────────────────────────────────────────────────────
-- The team step: the employee's explicit approver, else the dept_admins (access level) whose
-- departments are the employee's team (teleshop ↔ teleshop_out / teleshop_other / social,
-- affiliate ↔ altercpa / elyon_crm). Never the employee themselves.
CREATE OR REPLACE FUNCTION public.hr_team_approvers(p_emp uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH e AS (SELECT * FROM public.hr_employees WHERE id = p_emp)
  SELECT coalesce(array_agg(DISTINCT u ORDER BY u), '{}'::uuid[]) FROM (
    SELECT e.approver_id AS u FROM e
     WHERE e.approver_id IS NOT NULL AND public.access_is_active(e.approver_id)
    UNION ALL
    SELECT ud.user_id FROM e, public.user_departments ud
     WHERE e.approver_id IS NULL
       AND public.access_level(ud.user_id) = 'dept_admin' AND public.access_is_active(ud.user_id)
       AND ud.valid_from <= (now() AT TIME ZONE 'Europe/Skopje')::date
       AND (ud.valid_to IS NULL OR ud.valid_to >= (now() AT TIME ZONE 'Europe/Skopje')::date)
       AND ((e.team_key = 'teleshop' AND ud.dept IN ('teleshop_out', 'teleshop_other', 'social'))
         OR (e.team_key = 'affiliate' AND ud.dept IN ('altercpa', 'elyon_crm')))
  ) x
  WHERE u IS DISTINCT FROM (SELECT user_id FROM e)
$$;

-- The manager step: app_settings.hr.final_approvers (uuids) when set, else every active person of
-- access level administrator; nobody → the owner + super admins.
CREATE OR REPLACE FUNCTION public.hr_final_approvers()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT x::uuid) INTO _ids
    FROM public.app_settings s, jsonb_array_elements_text(coalesce(s.value -> 'final_approvers', '[]'::jsonb)) x
   WHERE s.key = 'hr' AND x ~* '^[0-9a-f-]{36}$' AND public.access_is_active(x::uuid);
  IF coalesce(cardinality(_ids), 0) > 0 THEN RETURN _ids; END IF;
  SELECT array_agg(p.user_id ORDER BY p.user_id) INTO _ids
    FROM public.profiles p WHERE p.is_active AND public.access_level(p.user_id) = 'administrator';
  IF coalesce(cardinality(_ids), 0) > 0 THEN RETURN _ids; END IF;
  SELECT array_agg(p.user_id ORDER BY p.user_id) INTO _ids
    FROM public.profiles p WHERE p.is_active AND public.access_level(p.user_id) IN ('owner', 'super_admin');
  RETURN coalesce(_ids, '{}'::uuid[]);
END;
$$;

-- May this login decide at the manager step? (the final approvers, the owner, the super admins)
CREATE OR REPLACE FUNCTION public.hr_can_decide_final(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_uid IS NOT NULL AND public.access_is_active(p_uid)
     AND (public.access_level(p_uid) IN ('super_admin', 'owner', 'administrator')
          OR p_uid = ANY (public.hr_final_approvers()))
$$;

INSERT INTO public.app_settings (key, value)
VALUES ('hr', jsonb_build_object('final_approvers', '[]'::jsonb,
                                 'rule', 'HR, owner 15.10.2026 (20261016120000)'))
ON CONFLICT (key) DO NOTHING;

-- ── 5. Absence of a login on a day (shifts + the login gate) ───────────────
CREATE OR REPLACE FUNCTION public.hr_absence_on(p_user uuid, p_day date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object('id', r.id, 'type', r.type, 'date_from', r.date_from, 'date_to', r.date_to)
    FROM public.hr_employees e
    JOIN public.hr_leave_requests r ON r.employee_id = e.id AND r.status = 'approved'
   WHERE e.user_id = p_user AND p_day BETWEEN r.date_from AND r.date_to
   ORDER BY r.date_to DESC
   LIMIT 1
$$;

-- No shift on an approved-absence day, whoever writes it (roll-forward, copy, the legacy form):
-- the row is skipped. shifts_set_cells checks first and reports the skipped cells.
CREATE OR REPLACE FUNCTION public.tg_shift_assignments_hr_absence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL AND NEW.shift_date IS NOT NULL
     AND public.hr_absence_on(NEW.user_id, NEW.shift_date) IS NOT NULL THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
-- named to sort after trg_shift_assignments_set_date (which fills shift_date first)
DROP TRIGGER IF EXISTS trg_shift_assignments_zz_hr_absence ON public.shift_assignments;
CREATE TRIGGER trg_shift_assignments_zz_hr_absence
  BEFORE INSERT OR UPDATE OF shift_id ON public.shift_assignments
  FOR EACH ROW EXECUTE FUNCTION public.tg_shift_assignments_hr_absence();

-- Approving: take the person's shifts off the absence's days (returned for removed_shifts).
CREATE OR REPLACE FUNCTION public.hr_clear_shifts(p_user uuid, p_from date, p_to date)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _gone jsonb;
BEGIN
  IF p_user IS NULL THEN RETURN '[]'::jsonb; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('elyon.shifts.write'));
  WITH d AS (
    DELETE FROM public.shift_assignments sa
     WHERE sa.user_id = p_user AND sa.shift_date BETWEEN p_from AND p_to
    RETURNING sa.shift_date, sa.shift_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('date', shift_date, 'shift_id', shift_id) ORDER BY shift_date), '[]'::jsonb)
    INTO _gone FROM d;
  RETURN _gone;
END;
$$;

-- Cancelling an approved absence: put back its removed shifts from today on (where the day is
-- still free and the shift row still exists).
CREATE OR REPLACE FUNCTION public.hr_restore_shifts(p_user uuid, p_removed jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _n int := 0;
  _today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
BEGIN
  IF p_user IS NULL OR p_removed IS NULL OR jsonb_typeof(p_removed) <> 'array' THEN RETURN 0; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('elyon.shifts.write'));
  INSERT INTO public.shift_assignments (shift_id, user_id)
  SELECT (x ->> 'shift_id')::uuid, p_user
    FROM jsonb_array_elements(p_removed) x
   WHERE (x ->> 'date')::date >= _today
     AND EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = (x ->> 'shift_id')::uuid)
     AND NOT EXISTS (SELECT 1 FROM public.shift_assignments sa
                      WHERE sa.user_id = p_user AND sa.shift_date = (x ->> 'date')::date)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$$;

-- ── 6. The writers ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.hr_audit(p_actor uuid, p_action text, p_target_type text, p_target_id text,
                                           p_target_name text, p_payload jsonb)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, (SELECT u.email FROM auth.users u WHERE u.id = p_actor), p_action, p_target_type, p_target_id,
          p_target_name, coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('rule', 'HR, owner 15.10.2026 (20261016120000)'))
  RETURNING id
$$;

CREATE OR REPLACE FUNCTION public.hr_request_json(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT to_jsonb(r) - 'removed_shifts' || jsonb_build_object(
           'employee_name', e.full_name, 'employee_user_id', e.user_id,
           'removed_shifts_count', jsonb_array_length(r.removed_shifts))
    FROM public.hr_leave_requests r JOIN public.hr_employees e ON e.id = r.employee_id
   WHERE r.id = p_id
$$;

-- A new absence. p_record = entered by HR / a manager as already approved (sick leave with the
-- doctor's note, an absence of shop staff); the api allows it only to the final approvers.
-- Otherwise: pending_team when the employee has a team approver who is not the requester, else
-- pending_manager. Returns {request, notify: [user ids], stage}.
CREATE OR REPLACE FUNCTION public.hr_leave_request(p_actor uuid, p_employee uuid, p_type text, p_from date,
                                                   p_to date, p_note text DEFAULT NULL, p_doc_ref text DEFAULT NULL,
                                                   p_record boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _e      public.hr_employees%ROWTYPE;
  _t      public.hr_leave_types%ROWTYPE;
  _days   int;
  _status text;
  _team   uuid[];
  _id     uuid;
  _clash  text;
  _gone   jsonb := '[]'::jsonb;
  _notify uuid[];
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'hr_leave_request: an actor is required' USING ERRCODE = '22023'; END IF;
  SELECT * INTO _e FROM public.hr_employees WHERE id = p_employee FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hr_leave_request: unknown employee' USING ERRCODE = 'P0002'; END IF;
  IF _e.status <> 'active' THEN RAISE EXCEPTION 'hr_leave_request: the employee has left' USING ERRCODE = '22023'; END IF;
  SELECT * INTO _t FROM public.hr_leave_types WHERE key = p_type AND active;
  IF NOT FOUND THEN RAISE EXCEPTION 'hr_leave_request: unknown type %', p_type USING ERRCODE = '22023'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'hr_leave_request: bad date range' USING ERRCODE = '22023';
  END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'hr_leave_request: at most 367 days' USING ERRCODE = '22023'; END IF;
  -- a person asks for themselves from at most 31 days back (a sick note arrives late); HR records any date
  IF NOT p_record AND p_from < (now() AT TIME ZONE 'Europe/Skopje')::date - 31 THEN
    RAISE EXCEPTION 'hr_leave_request: more than 31 days in the past — ask HR to record it' USING ERRCODE = '22023';
  END IF;

  SELECT string_agg(to_char(r.date_from, 'DD.MM') || '–' || to_char(r.date_to, 'DD.MM'), ', ') INTO _clash
    FROM public.hr_leave_requests r
   WHERE r.employee_id = p_employee AND r.status IN ('pending_team', 'pending_manager', 'approved')
     AND r.date_from <= p_to AND r.date_to >= p_from;
  IF _clash IS NOT NULL THEN
    RAISE EXCEPTION 'hr_leave_request: overlaps %', _clash USING ERRCODE = '23505';
  END IF;

  _days := public.hr_request_days(p_employee, p_type, p_from, p_to);
  IF _days = 0 AND _t.day_basis = 'working' THEN
    RAISE EXCEPTION 'hr_leave_request: no working days in the range' USING ERRCODE = '22023';
  END IF;

  _team := array_remove(public.hr_team_approvers(p_employee), p_actor);
  _status := CASE WHEN p_record THEN 'approved'
                  WHEN cardinality(_team) > 0 AND NOT public.hr_can_decide_final(p_actor) THEN 'pending_team'
                  ELSE 'pending_manager' END;

  INSERT INTO public.hr_leave_requests (employee_id, type, date_from, date_to, days, status, note, doc_ref,
                                        requested_by, decided_by, decided_at, decision_note)
  VALUES (p_employee, p_type, p_from, p_to, _days, _status, nullif(btrim(coalesce(p_note, '')), ''),
          nullif(btrim(coalesce(p_doc_ref, '')), ''), p_actor,
          CASE WHEN p_record THEN p_actor END, CASE WHEN p_record THEN now() END,
          CASE WHEN p_record THEN 'recorded by HR' END)
  RETURNING id INTO _id;

  IF _status = 'approved' THEN
    _gone := public.hr_clear_shifts(_e.user_id, p_from, p_to);
    UPDATE public.hr_leave_requests SET removed_shifts = _gone WHERE id = _id;
  END IF;

  _notify := CASE _status
               WHEN 'pending_team' THEN _team
               WHEN 'pending_manager' THEN array_remove(public.hr_final_approvers(), p_actor)
               ELSE CASE WHEN _e.user_id IS NOT NULL AND _e.user_id <> p_actor THEN ARRAY[_e.user_id] ELSE '{}'::uuid[] END
             END;

  PERFORM public.hr_audit(p_actor, CASE WHEN p_record THEN 'hr.leave_record' ELSE 'hr.leave_request' END,
                          'hr_leave_request', _id::text, _e.full_name,
                          jsonb_build_object('type', p_type, 'from', p_from, 'to', p_to, 'days', _days,
                                             'status', _status, 'shifts_removed', jsonb_array_length(_gone)));

  RETURN jsonb_build_object('request', public.hr_request_json(_id), 'notify', to_jsonb(coalesce(_notify, '{}'::uuid[])),
                            'stage', _status, 'shifts_removed', jsonb_array_length(_gone));
END;
$$;

-- Approve / reject. The capacity is decided HERE: the team step by a team approver of the
-- employee, the manager step (or any open step) by hr_can_decide_final(). Nobody decides their own
-- request except a super admin. A rejection needs a note (≥ 3 characters).
CREATE OR REPLACE FUNCTION public.hr_leave_decide(p_actor uuid, p_id uuid, p_decision text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _r      public.hr_leave_requests%ROWTYPE;
  _e      public.hr_employees%ROWTYPE;
  _final  boolean := public.hr_can_decide_final(p_actor);
  _team   boolean;
  _note   text := nullif(btrim(coalesce(p_note, '')), '');
  _new    text;
  _gone   jsonb := '[]'::jsonb;
  _notify uuid[] := '{}';
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'hr_leave_decide: an actor is required' USING ERRCODE = '22023'; END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'hr_leave_decide: decision is approve or reject' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO _r FROM public.hr_leave_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hr_leave_decide: request not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO _e FROM public.hr_employees WHERE id = _r.employee_id;
  IF _r.status NOT IN ('pending_team', 'pending_manager') THEN
    RAISE EXCEPTION 'hr_leave_decide: the request is already %', _r.status USING ERRCODE = '22023';
  END IF;
  IF _e.user_id = p_actor AND public.access_level(p_actor) <> 'super_admin' THEN
    RAISE EXCEPTION 'hr_leave_decide: nobody decides their own request' USING ERRCODE = '42501';
  END IF;
  _team := p_actor = ANY (public.hr_team_approvers(_r.employee_id));
  IF NOT _final AND NOT (_team AND _r.status = 'pending_team') THEN
    RAISE EXCEPTION 'hr_leave_decide: not yours to decide' USING ERRCODE = '42501';
  END IF;
  IF p_decision = 'reject' AND coalesce(length(_note), 0) < 3 THEN
    RAISE EXCEPTION 'hr_leave_decide: a rejection needs a note' USING ERRCODE = '22023';
  END IF;

  IF p_decision = 'reject' THEN
    _new := 'rejected';
  ELSIF _final THEN
    _new := 'approved';
  ELSE
    _new := 'pending_manager';
  END IF;

  IF _r.status = 'pending_team' THEN
    UPDATE public.hr_leave_requests SET team_by = p_actor, team_at = now(), team_note = _note WHERE id = p_id;
  END IF;
  IF _new IN ('approved', 'rejected') THEN
    UPDATE public.hr_leave_requests
       SET status = _new, decided_by = p_actor, decided_at = now(), decision_note = _note WHERE id = p_id;
  ELSE
    UPDATE public.hr_leave_requests SET status = _new WHERE id = p_id;
  END IF;

  IF _new = 'approved' THEN
    -- the overlap rule again: an approval never lands on another approved absence
    IF EXISTS (SELECT 1 FROM public.hr_leave_requests x
                WHERE x.employee_id = _r.employee_id AND x.id <> p_id AND x.status = 'approved'
                  AND x.date_from <= _r.date_to AND x.date_to >= _r.date_from) THEN
      RAISE EXCEPTION 'hr_leave_decide: overlaps another approved absence' USING ERRCODE = '23505';
    END IF;
    _gone := public.hr_clear_shifts(_e.user_id, _r.date_from, _r.date_to);
    UPDATE public.hr_leave_requests SET removed_shifts = _gone WHERE id = p_id;
  END IF;

  _notify := CASE WHEN _new = 'pending_manager' THEN array_remove(public.hr_final_approvers(), p_actor)
                  WHEN _e.user_id IS NOT NULL AND _e.user_id <> p_actor THEN ARRAY[_e.user_id]
                  ELSE '{}'::uuid[] END;

  PERFORM public.hr_audit(p_actor, 'hr.leave_' || p_decision, 'hr_leave_request', p_id::text, _e.full_name,
                          jsonb_build_object('before', _r.status, 'after', _new, 'note', _note,
                                             'as', CASE WHEN _final THEN 'manager' ELSE 'team' END,
                                             'shifts_removed', jsonb_array_length(_gone)));

  RETURN jsonb_build_object('request', public.hr_request_json(p_id), 'notify', to_jsonb(_notify), 'stage', _new,
                            'shifts_removed', jsonb_array_length(_gone));
END;
$$;

-- Cancel. The employee (or whoever asked) while undecided, or an approved one before it starts;
-- a final approver at any time (a note ≥ 3 characters). An approved absence gives back its shifts
-- from today on.
CREATE OR REPLACE FUNCTION public.hr_leave_cancel(p_actor uuid, p_id uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _r     public.hr_leave_requests%ROWTYPE;
  _e     public.hr_employees%ROWTYPE;
  _today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _final boolean := public.hr_can_decide_final(p_actor);
  _own   boolean;
  _note  text := nullif(btrim(coalesce(p_note, '')), '');
  _back  int := 0;
  _notify uuid[] := '{}';
BEGIN
  SELECT * INTO _r FROM public.hr_leave_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'hr_leave_cancel: request not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO _e FROM public.hr_employees WHERE id = _r.employee_id;
  IF _r.status IN ('rejected', 'cancelled') THEN
    RAISE EXCEPTION 'hr_leave_cancel: the request is already %', _r.status USING ERRCODE = '22023';
  END IF;
  _own := p_actor = _e.user_id OR p_actor = _r.requested_by;
  IF NOT _final AND NOT (_own AND (_r.status <> 'approved' OR _r.date_from > _today)) THEN
    RAISE EXCEPTION 'hr_leave_cancel: not yours to cancel' USING ERRCODE = '42501';
  END IF;
  IF _final AND NOT _own AND coalesce(length(_note), 0) < 3 THEN
    RAISE EXCEPTION 'hr_leave_cancel: a cancel needs a note' USING ERRCODE = '22023';
  END IF;

  UPDATE public.hr_leave_requests
     SET status = 'cancelled', cancelled_by = p_actor, cancelled_at = now(), cancel_note = _note
   WHERE id = p_id;
  IF _r.status = 'approved' THEN
    _back := public.hr_restore_shifts(_e.user_id, _r.removed_shifts);
  END IF;

  IF _e.user_id IS NOT NULL AND _e.user_id <> p_actor THEN _notify := ARRAY[_e.user_id]; END IF;
  PERFORM public.hr_audit(p_actor, 'hr.leave_cancel', 'hr_leave_request', p_id::text, _e.full_name,
                          jsonb_build_object('before', _r.status, 'note', _note, 'shifts_restored', _back));
  RETURN jsonb_build_object('request', public.hr_request_json(p_id), 'notify', to_jsonb(_notify),
                            'shifts_restored', _back);
END;
$$;

-- The dossier: create (p_id NULL) or update. Only the listed keys; '' clears a text. The audit row
-- names the changed keys, never the personal values.
CREATE OR REPLACE FUNCTION public.hr_employee_save(p_actor uuid, p_id uuid, p_data jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _allowed constant text[] := ARRAY['user_id', 'full_name', 'status', 'company', 'workplace', 'shop_name', 'position',
    'team_key', 'approver_id', 'work_days', 'holiday_calendars', 'phone', 'email', 'birth_date', 'address',
    'emergency_contact', 'hire_date', 'contract_type', 'contract_end', 'probation_end', 'prior_service_months',
    'extra_leave_days', 'extra_leave_reason', 'left_at', 'notes'];
  _k    text;
  _id   uuid := p_id;
  _old  jsonb;
  _new  jsonb;
  _chg  text[];
  _d    jsonb := coalesce(p_data, '{}'::jsonb);
  _txt  constant text[] := ARRAY['full_name', 'company', 'shop_name', 'position', 'phone', 'email', 'address',
    'emergency_contact', 'extra_leave_reason', 'notes'];
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'hr_employee_save: an actor is required' USING ERRCODE = '22023'; END IF;
  IF jsonb_typeof(_d) <> 'object' THEN RAISE EXCEPTION 'hr_employee_save: data must be an object' USING ERRCODE = '22023'; END IF;
  FOR _k IN SELECT jsonb_object_keys(_d) LOOP
    IF NOT _k = ANY (_allowed) THEN
      RAISE EXCEPTION 'hr_employee_save: % cannot be set', _k USING ERRCODE = '22023';
    END IF;
  END LOOP;
  -- '' → NULL for the text keys
  FOR _k IN SELECT unnest(_txt) LOOP
    IF _d ? _k AND jsonb_typeof(_d -> _k) = 'string' AND btrim(_d ->> _k) = '' THEN
      _d := jsonb_set(_d, ARRAY[_k], 'null'::jsonb);
    END IF;
  END LOOP;

  IF _id IS NULL THEN
    IF nullif(btrim(coalesce(_d ->> 'full_name', '')), '') IS NULL THEN
      RAISE EXCEPTION 'hr_employee_save: a name is required' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.hr_employees (full_name, updated_by) VALUES (btrim(_d ->> 'full_name'), p_actor) RETURNING id INTO _id;
    _old := '{}'::jsonb;
  ELSE
    SELECT to_jsonb(e) INTO _old FROM public.hr_employees e WHERE e.id = _id FOR UPDATE;
    IF _old IS NULL THEN RAISE EXCEPTION 'hr_employee_save: employee not found' USING ERRCODE = 'P0002'; END IF;
  END IF;

  UPDATE public.hr_employees e SET
    user_id            = CASE WHEN _d ? 'user_id' THEN nullif(_d ->> 'user_id', '')::uuid ELSE e.user_id END,
    full_name          = CASE WHEN _d ? 'full_name' THEN coalesce(btrim(_d ->> 'full_name'), e.full_name) ELSE e.full_name END,
    status             = CASE WHEN _d ? 'status' THEN _d ->> 'status' ELSE e.status END,
    company            = CASE WHEN _d ? 'company' THEN btrim(_d ->> 'company') ELSE e.company END,
    workplace          = CASE WHEN _d ? 'workplace' THEN _d ->> 'workplace' ELSE e.workplace END,
    shop_name          = CASE WHEN _d ? 'shop_name' THEN btrim(_d ->> 'shop_name') ELSE e.shop_name END,
    position           = CASE WHEN _d ? 'position' THEN btrim(_d ->> 'position') ELSE e.position END,
    team_key           = CASE WHEN _d ? 'team_key' THEN nullif(_d ->> 'team_key', '') ELSE e.team_key END,
    approver_id        = CASE WHEN _d ? 'approver_id' THEN nullif(_d ->> 'approver_id', '')::uuid ELSE e.approver_id END,
    work_days          = CASE WHEN _d ? 'work_days'
                              THEN ARRAY(SELECT DISTINCT x::smallint FROM jsonb_array_elements_text(_d -> 'work_days') x ORDER BY 1)
                              ELSE e.work_days END,
    holiday_calendars  = CASE WHEN _d ? 'holiday_calendars'
                              THEN ARRAY(SELECT DISTINCT x FROM jsonb_array_elements_text(_d -> 'holiday_calendars') x ORDER BY 1)
                              ELSE e.holiday_calendars END,
    phone              = CASE WHEN _d ? 'phone' THEN btrim(_d ->> 'phone') ELSE e.phone END,
    email              = CASE WHEN _d ? 'email' THEN btrim(_d ->> 'email') ELSE e.email END,
    birth_date         = CASE WHEN _d ? 'birth_date' THEN nullif(_d ->> 'birth_date', '')::date ELSE e.birth_date END,
    address            = CASE WHEN _d ? 'address' THEN btrim(_d ->> 'address') ELSE e.address END,
    emergency_contact  = CASE WHEN _d ? 'emergency_contact' THEN btrim(_d ->> 'emergency_contact') ELSE e.emergency_contact END,
    hire_date          = CASE WHEN _d ? 'hire_date' THEN nullif(_d ->> 'hire_date', '')::date ELSE e.hire_date END,
    contract_type      = CASE WHEN _d ? 'contract_type' THEN nullif(_d ->> 'contract_type', '') ELSE e.contract_type END,
    contract_end       = CASE WHEN _d ? 'contract_end' THEN nullif(_d ->> 'contract_end', '')::date ELSE e.contract_end END,
    probation_end      = CASE WHEN _d ? 'probation_end' THEN nullif(_d ->> 'probation_end', '')::date ELSE e.probation_end END,
    prior_service_months = CASE WHEN _d ? 'prior_service_months' THEN coalesce((_d ->> 'prior_service_months')::int, 0) ELSE e.prior_service_months END,
    extra_leave_days   = CASE WHEN _d ? 'extra_leave_days' THEN coalesce((_d ->> 'extra_leave_days')::smallint, 0) ELSE e.extra_leave_days END,
    extra_leave_reason = CASE WHEN _d ? 'extra_leave_reason' THEN btrim(_d ->> 'extra_leave_reason') ELSE e.extra_leave_reason END,
    left_at            = CASE WHEN _d ? 'left_at' THEN nullif(_d ->> 'left_at', '')::date ELSE e.left_at END,
    notes              = CASE WHEN _d ? 'notes' THEN btrim(_d ->> 'notes') ELSE e.notes END,
    updated_at = now(), updated_by = p_actor
  WHERE e.id = _id;

  SELECT to_jsonb(e) INTO _new FROM public.hr_employees e WHERE e.id = _id;
  IF (_new ->> 'status') = 'left' AND (_new ->> 'left_at') IS NULL THEN
    RAISE EXCEPTION 'hr_employee_save: a person who left needs the date they left' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(k ORDER BY k) INTO _chg FROM unnest(_allowed) k
   WHERE coalesce(_old -> k, 'null'::jsonb) IS DISTINCT FROM coalesce(_new -> k, 'null'::jsonb);

  PERFORM public.hr_audit(p_actor, CASE WHEN p_id IS NULL THEN 'hr.employee_create' ELSE 'hr.employee_update' END,
                          'hr_employee', _id::text, _new ->> 'full_name',
                          jsonb_build_object('changed', to_jsonb(coalesce(_chg, '{}'::text[]))));
  RETURN jsonb_build_object('id', _id, 'changed', to_jsonb(coalesce(_chg, '{}'::text[])));
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_entitlement_set(p_actor uuid, p_emp uuid, p_year int, p_base numeric,
                                                     p_extra numeric, p_carry numeric, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _before jsonb;
  _name   text;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'hr_entitlement_set: an actor is required' USING ERRCODE = '22023'; END IF;
  SELECT full_name INTO _name FROM public.hr_employees WHERE id = p_emp;
  IF NOT FOUND THEN RAISE EXCEPTION 'hr_entitlement_set: unknown employee' USING ERRCODE = 'P0002'; END IF;
  _before := public.hr_balance(p_emp, p_year);
  IF p_base IS NULL THEN
    DELETE FROM public.hr_leave_entitlements WHERE employee_id = p_emp AND year = p_year;   -- back to the default
  ELSE
    INSERT INTO public.hr_leave_entitlements AS x (employee_id, year, base_days, extra_days, carry_days, note, updated_at, updated_by)
    VALUES (p_emp, p_year, p_base, coalesce(p_extra, 0), coalesce(p_carry, 0), nullif(btrim(coalesce(p_note, '')), ''), now(), p_actor)
    ON CONFLICT (employee_id, year) DO UPDATE
      SET base_days = EXCLUDED.base_days, extra_days = EXCLUDED.extra_days, carry_days = EXCLUDED.carry_days,
          note = EXCLUDED.note, updated_at = now(), updated_by = p_actor;
  END IF;
  PERFORM public.hr_audit(p_actor, 'hr.entitlement_set', 'hr_employee', p_emp::text, _name,
    jsonb_build_object('year', p_year,
      'before', jsonb_build_object('base', _before -> 'base_days', 'extra', _before -> 'extra_days', 'carry', _before -> 'carry_days', 'source', _before -> 'source'),
      'after', CASE WHEN p_base IS NULL THEN jsonb_build_object('source', 'default')
                    ELSE jsonb_build_object('base', p_base, 'extra', coalesce(p_extra, 0), 'carry', coalesce(p_carry, 0)) END));
  RETURN public.hr_balance(p_emp, p_year);
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_holiday_save(p_actor uuid, p_id uuid, p_date date, p_name text, p_scope text,
                                                  p_moved_from date DEFAULT NULL, p_verified boolean DEFAULT true,
                                                  p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _id  uuid := p_id;
  _old jsonb;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'hr_holiday_save: an actor is required' USING ERRCODE = '22023'; END IF;
  IF p_date IS NULL OR nullif(btrim(coalesce(p_name, '')), '') IS NULL THEN
    RAISE EXCEPTION 'hr_holiday_save: a date and a name are required' USING ERRCODE = '22023';
  END IF;
  IF _id IS NULL THEN
    INSERT INTO public.hr_holidays (date, name, scope, moved_from, verified, note, updated_by)
    VALUES (p_date, btrim(p_name), coalesce(p_scope, 'all'), p_moved_from, coalesce(p_verified, true),
            nullif(btrim(coalesce(p_note, '')), ''), p_actor)
    RETURNING id INTO _id;
  ELSE
    SELECT to_jsonb(h) INTO _old FROM public.hr_holidays h WHERE h.id = _id FOR UPDATE;
    IF _old IS NULL THEN RAISE EXCEPTION 'hr_holiday_save: holiday not found' USING ERRCODE = 'P0002'; END IF;
    UPDATE public.hr_holidays
       SET date = p_date, name = btrim(p_name), scope = coalesce(p_scope, 'all'), moved_from = p_moved_from,
           verified = coalesce(p_verified, true), note = nullif(btrim(coalesce(p_note, '')), ''),
           updated_at = now(), updated_by = p_actor
     WHERE id = _id;
  END IF;
  PERFORM public.hr_audit(p_actor, 'hr.holiday_save', 'hr_holiday', _id::text, btrim(p_name),
                          jsonb_build_object('before', _old, 'after', (SELECT to_jsonb(h) FROM public.hr_holidays h WHERE h.id = _id)));
  RETURN (SELECT to_jsonb(h) FROM public.hr_holidays h WHERE h.id = _id);
END;
$$;

CREATE OR REPLACE FUNCTION public.hr_holiday_delete(p_actor uuid, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _old jsonb;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'hr_holiday_delete: an actor is required' USING ERRCODE = '22023'; END IF;
  DELETE FROM public.hr_holidays h WHERE h.id = p_id RETURNING to_jsonb(h) INTO _old;
  IF _old IS NULL THEN RAISE EXCEPTION 'hr_holiday_delete: holiday not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.hr_audit(p_actor, 'hr.holiday_delete', 'hr_holiday', p_id::text, _old ->> 'name',
                          jsonb_build_object('before', _old));
  RETURN jsonb_build_object('deleted', true, 'holiday', _old);
END;
$$;

-- The calendar: employees (in scope) × absences × holidays in [from, to].
CREATE OR REPLACE FUNCTION public.hr_calendar(p_from date, p_to date, p_emp_ids uuid[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _r jsonb;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92 THEN
    RAISE EXCEPTION 'hr_calendar: bad date range (at most 93 days)' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'today', (now() AT TIME ZONE 'Europe/Skopje')::date,
    'employees', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', e.id, 'user_id', e.user_id, 'name', e.full_name, 'team_key', e.team_key, 'workplace', e.workplace,
        'shop_name', e.shop_name, 'position', e.position, 'work_days', to_jsonb(e.work_days),
        'holiday_calendars', to_jsonb(e.holiday_calendars))
      ORDER BY e.workplace, e.team_key NULLS LAST, e.shop_name NULLS LAST, e.full_name)
      FROM public.hr_employees e
     WHERE (p_emp_ids IS NULL OR e.id = ANY (p_emp_ids))
       AND (e.status = 'active' OR e.left_at >= p_from)), '[]'::jsonb),
    'absences', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', r.id, 'employee_id', r.employee_id, 'type', r.type, 'status', r.status,
        'date_from', r.date_from, 'date_to', r.date_to, 'days', r.days)
      ORDER BY r.date_from)
      FROM public.hr_leave_requests r
     WHERE r.status IN ('pending_team', 'pending_manager', 'approved')
       AND r.date_from <= p_to AND r.date_to >= p_from
       AND (p_emp_ids IS NULL OR r.employee_id = ANY (p_emp_ids))), '[]'::jsonb),
    'holidays', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', h.id, 'date', h.date, 'name', h.name, 'scope', h.scope, 'moved_from', h.moved_from, 'verified', h.verified)
      ORDER BY h.date, h.scope)
      FROM public.hr_holidays h WHERE h.date BETWEEN p_from AND p_to), '[]'::jsonb))
  INTO _r;
  RETURN _r;
END;
$$;

-- ── 7. Shifts: the grid shows absences, the save skips them, the runway counts them ──
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
  ab AS (       -- approved HR absences of logins in the range (20261016120000)
    SELECT e.user_id, r.id, r.type, r.date_from, r.date_to, t.letter
      FROM hr_leave_requests r
      JOIN hr_employees e ON e.id = r.employee_id AND e.user_id IS NOT NULL
      JOIN hr_leave_types t ON t.key = r.type
     WHERE r.status = 'approved' AND r.date_from <= p_to AND r.date_to >= p_from
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
       AND NOT (cardinality(COALESCE(rl.roles, '{}'::text[])) > 0
                AND COALESCE(rl.roles, '{}'::text[]) <@ ARRAY['affiliate']::text[])
       AND (NOT (COALESCE(rl.roles, '{}'::text[]) && ARRAY['admin', 'manager'])
            OR EXISTS (SELECT 1 FROM cells c WHERE c.user_id = p.user_id))
  ),
  wins AS (
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
    'absences', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'user_id', a.user_id, 'date', g.d::date, 'type', a.type, 'letter', a.letter, 'request_id', a.id)
                ORDER BY a.user_id, g.d)
               FROM ab a, generate_series(greatest(a.date_from, p_from), least(a.date_to, p_to), interval '1 day') g(d)
              WHERE EXISTS (SELECT 1 FROM ppl WHERE ppl.user_id = a.user_id)), '[]'::jsonb),
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
  _abs     jsonb;
  _changes jsonb := '[]'::jsonb;
  _undo    jsonb := '[]'::jsonb;
  _skipped jsonb := '[]'::jsonb;
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
    -- an approved HR absence that day: no shift goes on it (20261016120000) — reported, not an error
    IF NOT _off THEN
      _abs := public.hr_absence_on(_uid, _date);
      IF _abs IS NOT NULL THEN
        _skipped := _skipped || jsonb_build_array(jsonb_build_object('user_id', _uid, 'date', _date,
                                                                     'type', _abs ->> 'type', 'request_id', _abs ->> 'id'));
        CONTINUE;
      END IF;
    END IF;
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
            jsonb_build_object('changed', _n, 'unchanged', _same, 'cells', _changes,
                               'skipped_absence', jsonb_array_length(_skipped)));
  END IF;

  RETURN jsonb_build_object('changed', _n, 'unchanged', _same, 'cells', _changes, 'undo', _undo,
                            'skipped_absence', _skipped);
END
$fn$;

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
    -- an approved HR absence covers its days like a shift (20261016120000): someone on leave
    -- until the 30th is not "running out" on the 25th
    SELECT a.user_id, a.full_name,
           NULLIF(GREATEST(
             COALESCE((SELECT max(s.date) FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id
                        WHERE sa.user_id = a.user_id
                          AND NOT (s.start_time = '00:00' AND s.end_time = '00:00')), '-infinity'::date),
             COALESCE((SELECT max(r.date_to) FROM hr_employees e
                         JOIN hr_leave_requests r ON r.employee_id = e.id AND r.status = 'approved'
                        WHERE e.user_id = a.user_id), '-infinity'::date)), '-infinity'::date) AS last_date
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

-- ── 8. Grants ───────────────────────────────────────────────────────────────
DO $g$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.hr_is_holiday(text[], date)',
    'public.hr_working_days(uuid, date, date)',
    'public.hr_request_days(uuid, text, date, date)',
    'public.hr_default_entitlement(uuid, int)',
    'public.hr_balance(uuid, int, date)',
    'public.hr_balances(int, uuid[])',
    'public.hr_team_approvers(uuid)',
    'public.hr_final_approvers()',
    'public.hr_can_decide_final(uuid)',
    'public.hr_absence_on(uuid, date)',
    'public.hr_clear_shifts(uuid, date, date)',
    'public.hr_restore_shifts(uuid, jsonb)',
    'public.hr_audit(uuid, text, text, text, text, jsonb)',
    'public.hr_request_json(uuid)',
    'public.hr_leave_request(uuid, uuid, text, date, date, text, text, boolean)',
    'public.hr_leave_decide(uuid, uuid, text, text)',
    'public.hr_leave_cancel(uuid, uuid, text)',
    'public.hr_employee_save(uuid, uuid, jsonb)',
    'public.hr_entitlement_set(uuid, uuid, int, numeric, numeric, numeric, text)',
    'public.hr_holiday_save(uuid, uuid, date, text, text, date, boolean, text)',
    'public.hr_holiday_delete(uuid, uuid)',
    'public.hr_calendar(date, date, uuid[])'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END
$g$;
-- internal helpers: not even the api calls them directly
REVOKE ALL ON FUNCTION public.hr_clear_shifts(uuid, date, date) FROM service_role;
REVOKE ALL ON FUNCTION public.hr_restore_shifts(uuid, jsonb) FROM service_role;
REVOKE ALL ON FUNCTION public.hr_audit(uuid, text, text, text, text, jsonb) FROM service_role;
REVOKE ALL ON FUNCTION public.tg_shift_assignments_hr_absence() FROM PUBLIC, anon, authenticated;

DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT SELECT ON public.hr_employees, public.hr_leave_types, public.hr_leave_requests, public.hr_leave_entitlements, public.hr_holidays TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.hr_working_days(uuid, date, date), public.hr_request_days(uuid, text, date, date), public.hr_default_entitlement(uuid, int), public.hr_balance(uuid, int, date), public.hr_balances(int, uuid[]), public.hr_team_approvers(uuid), public.hr_final_approvers(), public.hr_absence_on(uuid, date), public.hr_calendar(date, date, uuid[]) TO supabase_read_only_user';
  END IF;
END
$g$;

-- ── 9. Module: everyone on staff opens /hr (their own leave); the api decides the rest ──
INSERT INTO public.module_settings (module_key, module_label, is_enabled, is_protected) VALUES
  ('hr', 'Human resources', true, false)
ON CONFLICT (module_key) DO NOTHING;

INSERT INTO public.role_permissions (role, module_key, can_view, can_create, can_edit, can_delete, can_export) VALUES
  ('admin',            'hr', true, true,  true,  true,  true),
  ('manager',          'hr', true, true,  true,  false, true),
  ('agent',            'hr', true, true,  false, false, false),
  ('pending_agent',    'hr', true, true,  false, false, false),
  ('prediction_agent', 'hr', true, true,  false, false, false),
  ('inbound_agent',    'hr', true, true,  false, false, false),
  ('warehouse',        'hr', true, true,  false, false, false),
  ('ads_admin',        'hr', true, true,  false, false, false)
ON CONFLICT (role, module_key) DO NOTHING;

-- ── 10. Seed ────────────────────────────────────────────────────────────────
-- Every active staff login gets a dossier row (name, email, team, workplace). Affiliate-only logins
-- (external partners) and the test profile ("ТЕСТ …") are not employees. Shop and warehouse staff
-- without a login are added in /hr by HR.
INSERT INTO public.hr_employees (user_id, full_name, email, workplace, team_key, updated_by)
SELECT p.user_id, btrim(p.full_name), p.email,
       CASE WHEN rl.roles <@ ARRAY['warehouse']::text[] THEN 'warehouse'
            WHEN tm.team_key = 'management' THEN 'office'
            ELSE 'call_centre' END,
       CASE WHEN tm.team_key IN ('teleshop', 'affiliate', 'management') THEN tm.team_key END,
       NULL
  FROM public.profiles p
  LEFT JOIN LATERAL (SELECT array_agg(r.role::text) AS roles FROM public.user_roles r WHERE r.user_id = p.user_id) rl ON true
  LEFT JOIN LATERAL (
    SELECT m.team_key FROM public.sales_people sp
      JOIN public.sales_team_members m ON m.person_id = sp.id
     WHERE sp.user_id = p.user_id
       AND m.valid_from <= (now() AT TIME ZONE 'Europe/Skopje')::date
       AND (m.valid_to IS NULL OR m.valid_to >= (now() AT TIME ZONE 'Europe/Skopje')::date)
     ORDER BY m.is_primary DESC, m.valid_from DESC LIMIT 1) tm ON true
 WHERE p.is_active AND p.user_id IS NOT NULL
   AND nullif(btrim(coalesce(p.full_name, '')), '') IS NOT NULL
   AND p.full_name NOT ILIKE 'ТЕСТ%'
   AND NOT (coalesce(rl.roles, '{}'::text[]) <@ ARRAY['affiliate']::text[] AND cardinality(coalesce(rl.roles, '{}'::text[])) > 0)
ON CONFLICT (user_id) DO NOTHING;

-- Holidays 2026–2027 (Закон за празниците на РСМ). State days for everyone (a Sunday one moves to
-- the Monday, stored with moved_from); religious and community days only for their calendars.
-- verified = false: computed / lunar dates — HR checks them against the government's calendar.
INSERT INTO public.hr_holidays (date, name, scope, moved_from, verified) VALUES
  -- 2026 · everyone
  ('2026-01-01', 'Нова Година', 'all', NULL, true),
  ('2026-01-07', 'Божик (православен)', 'all', NULL, true),
  ('2026-03-20', 'Рамазан Бајрам (прв ден)', 'all', NULL, false),
  ('2026-04-13', 'Велигден — втор ден (православен)', 'all', NULL, true),
  ('2026-05-01', 'Ден на трудот', 'all', NULL, true),
  ('2026-05-25', 'Св. Кирил и Методиј (поместен од недела)', 'all', '2026-05-24', true),
  ('2026-08-03', 'Ден на Републиката — Илинден (поместен од недела)', 'all', '2026-08-02', true),
  ('2026-09-08', 'Ден на независноста', 'all', NULL, true),
  ('2026-10-12', 'Ден на народното востание (поместен од недела)', 'all', '2026-10-11', true),
  ('2026-10-23', 'Ден на македонската револуционерна борба', 'all', NULL, true),
  ('2026-12-08', 'Св. Климент Охридски', 'all', NULL, true),
  -- 2026 · orthodox
  ('2026-01-06', 'Бадник', 'orthodox', NULL, true),
  ('2026-01-19', 'Богојавление', 'orthodox', NULL, true),
  ('2026-04-10', 'Велики Петок', 'orthodox', NULL, true),
  ('2026-05-29', 'Духовден', 'orthodox', NULL, false),
  ('2026-08-28', 'Успение на Пресвета Богородица', 'orthodox', NULL, true),
  -- 2026 · muslim / catholic / jewish
  ('2026-05-27', 'Курбан Бајрам', 'muslim', NULL, false),
  ('2026-04-06', 'Велигден — втор ден (католички)', 'catholic', NULL, true),
  ('2026-11-01', 'Сите светии', 'catholic', NULL, true),
  ('2026-12-25', 'Божик (католички)', 'catholic', NULL, true),
  ('2026-09-21', 'Јом Кипур', 'jewish', NULL, false),
  -- 2026 · communities
  ('2026-01-27', 'Св. Сава', 'serbian', NULL, true),
  ('2026-04-08', 'Меѓународен ден на Ромите', 'roma', NULL, true),
  ('2026-05-23', 'Национален ден на Власите', 'vlach', NULL, true),
  ('2026-09-28', 'Меѓународен ден на Бошњаците', 'bosniak', NULL, true),
  ('2026-11-22', 'Ден на Албанската азбука', 'albanian', NULL, true),
  ('2026-12-21', 'Ден на настава на турски јазик', 'turkish', NULL, true),
  -- 2027 · everyone
  ('2027-01-01', 'Нова Година', 'all', NULL, true),
  ('2027-01-07', 'Божик (православен)', 'all', NULL, true),
  ('2027-03-10', 'Рамазан Бајрам (прв ден)', 'all', NULL, false),
  ('2027-05-03', 'Велигден — втор ден (православен)', 'all', NULL, true),
  ('2027-05-01', 'Ден на трудот', 'all', NULL, true),
  ('2027-05-24', 'Св. Кирил и Методиј', 'all', NULL, true),
  ('2027-08-02', 'Ден на Републиката — Илинден', 'all', NULL, true),
  ('2027-09-08', 'Ден на независноста', 'all', NULL, true),
  ('2027-10-11', 'Ден на народното востание', 'all', NULL, true),
  ('2027-10-23', 'Ден на македонската револуционерна борба', 'all', NULL, true),
  ('2027-12-08', 'Св. Климент Охридски', 'all', NULL, true),
  -- 2027 · orthodox
  ('2027-01-06', 'Бадник', 'orthodox', NULL, true),
  ('2027-01-19', 'Богојавление', 'orthodox', NULL, true),
  ('2027-04-30', 'Велики Петок', 'orthodox', NULL, true),
  ('2027-06-18', 'Духовден', 'orthodox', NULL, false),
  ('2027-08-28', 'Успение на Пресвета Богородица', 'orthodox', NULL, true),
  -- 2027 · muslim / catholic / jewish
  ('2027-05-16', 'Курбан Бајрам', 'muslim', NULL, false),
  ('2027-03-29', 'Велигден — втор ден (католички)', 'catholic', NULL, true),
  ('2027-11-01', 'Сите светии', 'catholic', NULL, true),
  ('2027-12-25', 'Божик (католички)', 'catholic', NULL, true),
  ('2027-10-11', 'Јом Кипур', 'jewish', NULL, false),
  -- 2027 · communities
  ('2027-01-27', 'Св. Сава', 'serbian', NULL, true),
  ('2027-04-08', 'Меѓународен ден на Ромите', 'roma', NULL, true),
  ('2027-05-23', 'Национален ден на Власите', 'vlach', NULL, true),
  ('2027-09-28', 'Меѓународен ден на Бошњаците', 'bosniak', NULL, true),
  ('2027-11-22', 'Ден на Албанската азбука', 'albanian', NULL, true),
  ('2027-12-21', 'Ден на настава на турски јазик', 'turkish', NULL, true)
ON CONFLICT (date, scope, name) DO NOTHING;

COMMENT ON FUNCTION public.hr_leave_request(uuid, uuid, text, date, date, text, text, boolean) IS
  'POST /api/hr/requests: a new absence (pending_team → pending_manager → approved), or p_record = HR records it approved. Overlaps refused (23505). Approval takes the person''s shifts off those days. Audited hr.leave_request / hr.leave_record. 20261016120000.';
COMMENT ON FUNCTION public.hr_leave_decide(uuid, uuid, text, text) IS
  'POST /api/hr/requests/:id/decide: the team step (hr_team_approvers) or the manager step (hr_can_decide_final); never one''s own (super admin excepted); a rejection needs a note. Audited. 20261016120000.';
COMMENT ON FUNCTION public.hr_leave_cancel(uuid, uuid, text) IS
  'POST /api/hr/requests/:id/cancel: the employee while undecided / before an approved one starts; a manager any time (note). Gives back the removed shifts from today on. Audited. 20261016120000.';

COMMIT;
