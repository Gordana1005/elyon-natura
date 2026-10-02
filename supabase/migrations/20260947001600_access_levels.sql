-- ============================================================================
-- ACCESS LEVELS — one money level per person + a department scope
-- (owner's decisions, 02.10.2026 evening; design: exports/roles/predlog-ulogi-2026-10-02 "Како се гради")
-- ============================================================================
-- The app roles (user_roles / app_role) stay exactly as they are: they decide the PAGES. What a
-- person may see of the MONEY is now a LEVEL, one per person, plus — for a department admin —
-- the departments (cohort keys) they may see:
--
--   level          money                                              departments
--   super_admin    everything (revenue, margins, purchase costs, MEX)  all
--   owner          everything                                          all
--   finance        everything (all orders + margins, like the owner)   all
--   administrator  revenue + returns company-wide; NO margins /        all
--                  purchase cost / net profit / MEX cash
--   dept_admin     revenue + наплата + returns of THEIR departments    user_departments
--   team_lead · operator · warehouse · partner   no company money     none
--
--   public.user_access        (user_id, level, note)            — one row per managed person
--   public.user_departments   (user_id, dept, valid_from/to)    — dated; inclusive Skopje days
--   access_level(uid)         the row's level; NO row → today's rule (business_owners → owner,
--                             active admin → administrator, manager → team_lead,
--                             warehouse-only → warehouse, affiliate-only → partner, else operator)
--   can_see_margins(uid)      super_admin / owner / finance, active profile
--   can_see_revenue(uid)      can_see_margins OR administrator (company-wide), active profile
--   dept_scope(uid)           NULL = every department · text[] = a dept_admin's · '{}' = none
--   is_business_owner(uid)    := can_see_revenue(uid)  (signature kept — every revenue gate keeps
--                             working; MARGIN gates move to can_see_margins in the api wiring)
--   can_see_mex_cash(uid)     := can_see_margins(uid)  (app_settings.mex_cash.viewers superseded —
--                             the key stays, nothing reads it)
--   can_see_mex_cash_dept(uid) NULL = the whole tab · text[] = a dept_admin's departments · '{}'
--   my_access()               the caller's answer for the UI; get_my_permissions() gains the same
--   access_set(...)           THE writer — super_admin only, audited (audit_log 'access.set')
--
-- Writes: only through access_set() (→ access_write()). authenticated reads its own row (admins
-- all) and holds no write grant; service_role only SELECT — the api must call the writer.
--
-- Behaviour today: the seed below gives every former admin a row. Revenue gates
-- (is_business_owner) answer exactly as before for them, except Teodora Krstevska (dept_admin, no
-- company-wide money). Finance (ema@naturatherapy.mk) is added in 20260947001620. The MEX cash tab
-- opens for the super admins Мики Митров, Lazar Delev and Radislava Maneska.
--
-- Rollback: re-run is_business_owner / can_see_mex_cash / get_my_permissions from
-- 20260939000500 / 20260947001300 / the body below minus the new keys, then DROP the tables.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── 1. Tables ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_access (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  level      text NOT NULL CHECK (level IN ('super_admin', 'owner', 'finance', 'administrator', 'dept_admin',
                                            'team_lead', 'operator', 'warehouse', 'partner')),
  note       text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- SET NULL: an attribution column must never block deleting the login that made the change.
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);
COMMENT ON TABLE public.user_access IS
  'One money LEVEL per person (owner 02.10.2026, 20260947001600). No row = today''s rule via access_level(). Written only by access_set() (super_admin, audited).';
COMMENT ON COLUMN public.user_access.note IS
  'Free note about this person''s access (e.g. Kalina Tajkovska works with Dragana on partner deals).';

CREATE TABLE IF NOT EXISTS public.user_departments (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  dept       text NOT NULL CHECK (dept IN ('altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other',
                                           'social', 'web', 'management')),
  valid_from date NOT NULL DEFAULT ((now() AT TIME ZONE 'Europe/Skopje')::date),
  valid_to   date,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, dept, valid_from),
  CONSTRAINT user_departments_range_chk CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
-- One OPEN grant per person × department.
CREATE UNIQUE INDEX IF NOT EXISTS user_departments_open_uq
  ON public.user_departments (user_id, dept) WHERE valid_to IS NULL;
COMMENT ON TABLE public.user_departments IS
  'Departments (cohort keys) a person may see, dated — valid_from / valid_to are INCLUSIVE Skopje days (like sales_team_members). Used by dept_scope() for level dept_admin. Written only by access_set().';

-- RLS: your own rows; admins (the app role) read all. No write policy, no write grant.
ALTER TABLE public.user_access      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_departments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_access_select ON public.user_access;
CREATE POLICY user_access_select ON public.user_access
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid())
         OR (SELECT public.has_role((SELECT auth.uid()), 'admin'::app_role)));

DROP POLICY IF EXISTS user_departments_select ON public.user_departments;
CREATE POLICY user_departments_select ON public.user_departments
  FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid())
         OR (SELECT public.has_role((SELECT auth.uid()), 'admin'::app_role)));

-- Default privileges hand new public tables to anon/authenticated/service_role in full; take
-- that back. service_role (the api) reads; it WRITES only through access_set().
REVOKE ALL ON public.user_access      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.user_departments FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.user_access      TO authenticated, service_role;
GRANT SELECT ON public.user_departments TO authenticated, service_role;

-- ── 2. The level ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.access_level(p_uid uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_uid IS NULL THEN NULL ELSE coalesce(
    (SELECT a.level FROM public.user_access a WHERE a.user_id = p_uid),
    -- No row → today's rule (before 20260947001600), so an unmanaged login behaves as it did.
    CASE
      WHEN EXISTS (SELECT 1 FROM public.business_owners b WHERE b.user_id = p_uid) THEN 'owner'
      WHEN EXISTS (SELECT 1 FROM public.user_roles r
                     JOIN public.profiles pr ON pr.user_id = r.user_id AND pr.is_active
                    WHERE r.user_id = p_uid AND r.role = 'admin') THEN 'administrator'
      WHEN EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p_uid AND r.role = 'manager') THEN 'team_lead'
      WHEN EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p_uid AND r.role = 'warehouse')
       AND NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p_uid AND r.role <> 'warehouse') THEN 'warehouse'
      WHEN EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p_uid AND r.role = 'affiliate')
       AND NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p_uid AND r.role <> 'affiliate') THEN 'partner'
      ELSE 'operator'
    END) END
$$;
COMMENT ON FUNCTION public.access_level(uuid) IS
  'The person''s money level: user_access.level, else today''s rule (business_owners → owner, active admin → administrator, manager → team_lead, warehouse-only → warehouse, affiliate-only → partner, else operator). 20260947001600.';

-- Active profile: a suspended person keeps their level but sees no money.
CREATE OR REPLACE FUNCTION public.access_is_active(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_uid IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.profiles pr WHERE pr.user_id = p_uid AND pr.is_active)
$$;

CREATE OR REPLACE FUNCTION public.can_see_margins(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_uid IS NOT NULL
     AND public.access_level(p_uid) IN ('super_admin', 'owner', 'finance')
     AND public.access_is_active(p_uid)
$$;
COMMENT ON FUNCTION public.can_see_margins(uuid) IS
  'Margins, purchase costs (Sigma), VAT per product, profit, the MEX cash tab: super_admin / owner / finance with an active profile. 20260947001600.';

CREATE OR REPLACE FUNCTION public.can_see_revenue(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_uid IS NOT NULL
     AND public.access_level(p_uid) IN ('super_admin', 'owner', 'finance', 'administrator')
     AND public.access_is_active(p_uid)
$$;
COMMENT ON FUNCTION public.can_see_revenue(uuid) IS
  'Company-wide revenue + returns: can_see_margins OR level administrator, active profile. A dept_admin is NOT here — their revenue is scoped by dept_scope(). 20260947001600.';

CREATE OR REPLACE FUNCTION public.dept_scope(p_uid uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN NOT public.access_is_active(p_uid) THEN '{}'::text[]
    WHEN lv IN ('super_admin', 'owner', 'finance', 'administrator') THEN NULL
    WHEN lv = 'dept_admin' THEN coalesce((
      SELECT array_agg(d.dept ORDER BY array_position(
               ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management'], d.dept))
        FROM (SELECT DISTINCT ud.dept
                FROM public.user_departments ud
               WHERE ud.user_id = p_uid
                 AND ud.valid_from <= (now() AT TIME ZONE 'Europe/Skopje')::date
                 AND (ud.valid_to IS NULL OR ud.valid_to >= (now() AT TIME ZONE 'Europe/Skopje')::date)) d),
      '{}'::text[])
    ELSE '{}'::text[]
  END
  FROM (SELECT public.access_level(p_uid) AS lv) x
$$;
COMMENT ON FUNCTION public.dept_scope(uuid) IS
  'Departments (cohort keys) whose money the person may see: NULL = every department (super_admin / owner / finance / administrator), the dept_admin''s departments valid today (Skopje), ''{}'' = none (everyone else, and any inactive profile). The api intersects requested p_sources with this. 20260947001600.';

-- ── 3. The existing gates, redefined (signatures kept) ─────────────────────
CREATE OR REPLACE FUNCTION public.is_business_owner(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.can_see_revenue(p_uid)
$$;
COMMENT ON FUNCTION public.is_business_owner(uuid) IS
  'Since 20260947001600 = can_see_revenue(uid): super_admin / owner / finance / administrator with an active profile (no row in user_access → business_owners or active admin, as before). Company-wide REVENUE gate — RLS, the api and get_my_permissions().isBusinessOwner read it. Margin gates use can_see_margins().';
-- ACL as live (authenticated, service_role) — restated, unchanged.
REVOKE ALL ON FUNCTION public.is_business_owner(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_business_owner(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.can_see_mex_cash(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT public.can_see_margins(p_uid)
$$;
COMMENT ON FUNCTION public.can_see_mex_cash(uuid) IS
  'The whole Insights → Наплата (MEX) tab: = can_see_margins (super_admin / owner / finance), 20260947001600. app_settings.mex_cash.viewers is superseded and no longer read.';
REVOKE ALL ON FUNCTION public.can_see_mex_cash(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_see_mex_cash(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.can_see_mex_cash_dept(p_uid uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN public.can_see_mex_cash(p_uid) THEN NULL
    WHEN public.access_level(p_uid) = 'dept_admin' THEN public.dept_scope(p_uid)
    ELSE '{}'::text[]
  END
$$;
COMMENT ON FUNCTION public.can_see_mex_cash_dept(uuid) IS
  'Department-scoped наплата: NULL = the whole tab (can_see_mex_cash), a dept_admin''s departments, ''{}'' = none (administrator included — no MEX cash). 20260947001600.';

UPDATE public.app_settings
   SET value = value || jsonb_build_object('superseded_by',
         'can_see_mex_cash() = can_see_margins() since 20260947001600 — viewers is no longer read')
 WHERE key = 'mex_cash' AND NOT value ? 'superseded_by';

-- ── 4. The caller's own answer ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.my_access()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'level',                public.access_level(me.uid),
    'departments',          to_jsonb(public.dept_scope(me.uid)),
    'can_see_margins',      public.can_see_margins(me.uid),
    'can_see_revenue',      public.can_see_revenue(me.uid),
    'can_see_mex_cash',     public.can_see_mex_cash(me.uid),
    'mex_cash_departments', to_jsonb(public.can_see_mex_cash_dept(me.uid)))
  FROM (SELECT (SELECT auth.uid()) AS uid) me
$$;
COMMENT ON FUNCTION public.my_access() IS
  'The caller''s level and money scope for the UI: {level, departments (null = all), can_see_margins, can_see_revenue, can_see_mex_cash, mex_cash_departments (null = all)}. 20260947001600.';

-- Re-emitted from the LIVE definition (pg_get_functiondef, 02.10.2026) with the access keys
-- added at the end. Every existing key is unchanged.
CREATE OR REPLACE FUNCTION public.get_my_permissions()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH my_role_names AS (
    SELECT ur.role::text AS role_name
    FROM public.user_roles ur
    WHERE ur.user_id = auth.uid()
  ),
  is_priv AS (
    SELECT public.is_admin_or_manager(auth.uid()) AS yes
  ),
  acc AS (
    SELECT public.my_access() AS a
  )
  SELECT jsonb_build_object(
    'modules', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'module_key',   ms.module_key,
        'module_label', ms.module_label,
        'is_enabled',   ms.is_enabled,
        'is_protected', ms.is_protected
      ) ORDER BY ms.module_label)
      FROM public.module_settings ms
    ), '[]'::jsonb),

    'rolePermissions', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'role',       rp.role,
        'module_key', rp.module_key,
        'can_view',   rp.can_view,
        'can_create', rp.can_create,
        'can_edit',   rp.can_edit,
        'can_delete', rp.can_delete,
        'can_export', rp.can_export
      ))
      FROM public.role_permissions rp
      WHERE (SELECT yes FROM is_priv)
         OR rp.role IN (SELECT role_name FROM my_role_names)
    ), '[]'::jsonb),

    'financialVisibility', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'role',                    fv.role,
        'show_profit',             fv.show_profit,
        'show_net_contribution',   fv.show_net_contribution,
        'show_cost',               fv.show_cost,
        'show_returned_value',     fv.show_returned_value,
        'show_financial_insights', fv.show_financial_insights
      ))
      FROM public.financial_visibility fv
      WHERE (SELECT yes FROM is_priv)
         OR fv.role IN (SELECT role_name FROM my_role_names)
    ), '[]'::jsonb),

    'privacy', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'role',                    pv.role,
        'show_customer_phone',     pv.show_customer_phone,
        'show_customer_name',      pv.show_customer_name,
        'show_customer_address',   pv.show_customer_address,
        'show_order_history',      pv.show_order_history,
        'show_segment_members',    pv.show_segment_members,
        'can_hear_recordings',     pv.can_hear_recordings,
        'can_hear_own_recordings', pv.can_hear_own_recordings
      ))
      FROM public.role_privacy pv
      WHERE (SELECT yes FROM is_priv)
         OR pv.role IN (SELECT role_name FROM my_role_names)
    ), '[]'::jsonb),

    -- Company-wide revenue gate (= can_see_revenue since 20260947001600).
    'isBusinessOwner', public.is_business_owner(auth.uid()),

    -- Access model (20260947001600) — the same answer as my_access().
    'accessLevel',        (SELECT a -> 'level'                FROM acc),
    'departments',        (SELECT a -> 'departments'          FROM acc),
    'canSeeMargins',      (SELECT a -> 'can_see_margins'      FROM acc),
    'canSeeRevenue',      (SELECT a -> 'can_see_revenue'      FROM acc),
    'canSeeMexCash',      (SELECT a -> 'can_see_mex_cash'     FROM acc),
    'mexCashDepartments', (SELECT a -> 'mex_cash_departments' FROM acc)
  );
$function$;
-- Grants untouched: CREATE OR REPLACE keeps the live ACL (anon, authenticated, service_role).

-- ── 5. The writer ──────────────────────────────────────────────────────────
-- Internal: does the write + the audit row. No permission check — only access_set() and this
-- migration's seed call it. p_note NULL keeps the current note, '' clears it. p_level NULL
-- removes the row (back to today's rule) and closes every open department.
CREATE OR REPLACE FUNCTION public.access_write(p_actor uuid, p_user uuid, p_level text, p_depts text[],
                                               p_note text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _keys   constant text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'management'];
  _levels constant text[] := ARRAY['super_admin', 'owner', 'finance', 'administrator', 'dept_admin',
                                   'team_lead', 'operator', 'warehouse', 'partner'];
  _today  date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _level  text := nullif(lower(btrim(coalesce(p_level, ''))), '');
  _depts  text[];
  _bad    text[];
  _cur    public.user_access%ROWTYPE;
  _was    text;
  _before jsonb;
  _after  jsonb;
  _name   text;
  _email  text;
  _audit  uuid;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023'; END IF;
  IF p_user  IS NULL THEN RAISE EXCEPTION 'user is required'  USING ERRCODE = '22023'; END IF;
  SELECT pr.full_name INTO _name FROM public.profiles pr WHERE pr.user_id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'no profile for user %', p_user USING ERRCODE = 'P0002'; END IF;

  IF _level IS NOT NULL AND NOT _level = ANY (_levels) THEN
    RAISE EXCEPTION 'unknown level "%" (one of %)', p_level, array_to_string(_levels, ', ') USING ERRCODE = '22023';
  END IF;

  -- departments: trimmed, lower-case, distinct, display order
  SELECT coalesce(array_agg(k ORDER BY array_position(_keys, k)), '{}'::text[])
    INTO _depts
    FROM (SELECT DISTINCT lower(btrim(x)) AS k FROM unnest(coalesce(p_depts, '{}'::text[])) x
           WHERE nullif(btrim(x), '') IS NOT NULL) s;
  SELECT array_agg(k) INTO _bad FROM unnest(_depts) k WHERE NOT k = ANY (_keys);
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'unknown department(s) %', array_to_string(_bad, ', ') USING ERRCODE = '22023';
  END IF;
  IF _level = 'dept_admin' AND cardinality(_depts) = 0 THEN
    RAISE EXCEPTION 'a dept_admin needs at least one department' USING ERRCODE = '22023';
  END IF;
  IF cardinality(_depts) > 0 AND _level IS DISTINCT FROM 'dept_admin' AND _level IS DISTINCT FROM 'team_lead' THEN
    RAISE EXCEPTION 'departments apply only to dept_admin / team_lead (level %)', coalesce(_level, 'none') USING ERRCODE = '22023';
  END IF;

  -- the partner wall: an affiliate-only login is a partner and nothing else, and a partner level
  -- never goes to a staff login
  IF EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p_user AND r.role = 'affiliate')
     AND NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p_user AND r.role <> 'affiliate') THEN
    IF _level IS DISTINCT FROM 'partner' AND _level IS NOT NULL THEN
      RAISE EXCEPTION 'an affiliate (partner) login can only hold level partner' USING ERRCODE = '42501';
    END IF;
  ELSIF _level = 'partner' THEN
    RAISE EXCEPTION 'level partner is only for affiliate (partner) logins' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO _cur FROM public.user_access a WHERE a.user_id = p_user FOR UPDATE;
  _was := public.access_level(p_user);

  -- never leave the system without an active super admin
  IF _was = 'super_admin' AND _level IS DISTINCT FROM 'super_admin'
     AND NOT EXISTS (SELECT 1 FROM public.user_access a JOIN public.profiles pr ON pr.user_id = a.user_id AND pr.is_active
                      WHERE a.level = 'super_admin' AND a.user_id <> p_user) THEN
    RAISE EXCEPTION 'refused: % is the last active super admin', _name USING ERRCODE = '42501';
  END IF;

  _before := jsonb_build_object(
    'row', _cur.user_id IS NOT NULL,
    'level', _was,
    'note', _cur.note,
    'departments', coalesce((SELECT to_jsonb(array_agg(ud.dept ORDER BY array_position(_keys, ud.dept)))
                               FROM public.user_departments ud WHERE ud.user_id = p_user AND ud.valid_to IS NULL), '[]'::jsonb));

  -- level
  IF _level IS NULL THEN
    DELETE FROM public.user_access WHERE user_id = p_user;
  ELSE
    INSERT INTO public.user_access AS a (user_id, level, note, updated_at, updated_by)
    VALUES (p_user, _level, nullif(btrim(coalesce(p_note, '')), ''), now(), p_actor)
    ON CONFLICT (user_id) DO UPDATE
      SET level      = EXCLUDED.level,
          note       = CASE WHEN p_note IS NULL THEN a.note ELSE EXCLUDED.note END,
          updated_at = now(),
          updated_by = p_actor;
  END IF;

  -- departments: close what is no longer granted (from today on — a grant made today is simply
  -- removed, its trace is the audit row), open what is new
  DELETE FROM public.user_departments ud
   WHERE ud.user_id = p_user AND ud.valid_to IS NULL AND NOT ud.dept = ANY (_depts) AND ud.valid_from >= _today;
  UPDATE public.user_departments ud
     SET valid_to = _today - 1
   WHERE ud.user_id = p_user AND ud.valid_to IS NULL AND NOT ud.dept = ANY (_depts) AND ud.valid_from < _today;
  INSERT INTO public.user_departments (user_id, dept, valid_from, valid_to, granted_by)
  SELECT p_user, k, _today, NULL, p_actor
    FROM unnest(_depts) k
   WHERE NOT EXISTS (SELECT 1 FROM public.user_departments ud
                      WHERE ud.user_id = p_user AND ud.dept = k AND ud.valid_to IS NULL)
  ON CONFLICT (user_id, dept, valid_from) DO UPDATE SET valid_to = NULL, granted_by = EXCLUDED.granted_by;

  _after := jsonb_build_object(
    'row', _level IS NOT NULL,
    'level', public.access_level(p_user),
    'note', (SELECT a.note FROM public.user_access a WHERE a.user_id = p_user),
    'departments', to_jsonb(_depts));

  SELECT u.email INTO _email FROM auth.users u WHERE u.id = p_actor;
  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, _email, 'access.set', 'user_access', p_user::text, _name,
          jsonb_build_object('before', _before, 'after', _after,
                             'reason', nullif(btrim(coalesce(p_reason, '')), ''),
                             'rule', 'access levels, owner 02.10.2026 (20260947001600)'))
  RETURNING id INTO _audit;

  RETURN jsonb_build_object('ok', true, 'user_id', p_user, 'name', _name,
                            'before', _before, 'after', _after, 'audit_id', _audit);
END;
$$;
COMMENT ON FUNCTION public.access_write(uuid, uuid, text, text[], text, text) IS
  'INTERNAL writer behind access_set() — no permission check. Never grant it. 20260947001600.';

-- THE writer: a super admin only. From the api (service role) p_actor names the signed-in caller;
-- from a user session the caller IS the actor (p_actor may not name anyone else).
CREATE OR REPLACE FUNCTION public.access_set(p_user uuid, p_level text, p_depts text[] DEFAULT NULL,
                                             p_note text DEFAULT NULL, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _uid   uuid := (SELECT auth.uid());
  _actor uuid;
BEGIN
  IF _uid IS NOT NULL AND p_actor IS NOT NULL AND p_actor <> _uid THEN
    RAISE EXCEPTION 'p_actor must be the caller' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  _actor := coalesce(_uid, p_actor);
  IF _actor IS NULL THEN RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023'; END IF;
  IF NOT (public.access_level(_actor) = 'super_admin' AND public.access_is_active(_actor)) THEN
    RAISE EXCEPTION 'only a super admin sets access levels' USING ERRCODE = '42501', HINT = 'forbidden';
  END IF;
  RETURN public.access_write(_actor, p_user, p_level, p_depts, p_note, NULL);
END;
$$;
COMMENT ON FUNCTION public.access_set(uuid, text, text[], text, uuid) IS
  'Set a person''s level, departments (dept_admin / team_lead) and note. Super admin only, audited (audit_log access.set). p_note NULL keeps the note, '''' clears it; p_level NULL removes the row (back to today''s rule). The api calls it with p_actor = the signed-in user. 20260947001600.';

-- ── 6. Grants ───────────────────────────────────────────────────────────────
-- Supabase's default privileges grant EXECUTE on new public functions to anon/authenticated:
-- revoke everything, then grant what each needs.
REVOKE ALL ON FUNCTION public.access_level(uuid)                               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.access_is_active(uuid)                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_see_margins(uuid)                            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_see_revenue(uuid)                            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.dept_scope(uuid)                                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_see_mex_cash_dept(uuid)                      FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.my_access()                                      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.access_write(uuid, uuid, text, text[], text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.access_set(uuid, text, text[], text, uuid)       FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.access_level(uuid)          TO service_role;
GRANT EXECUTE ON FUNCTION public.access_is_active(uuid)      TO service_role;
-- booleans like is_business_owner: callable from RLS policies (e.g. a future cost-column policy)
GRANT EXECUTE ON FUNCTION public.can_see_margins(uuid)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_see_revenue(uuid)       TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dept_scope(uuid)            TO service_role;
GRANT EXECUTE ON FUNCTION public.can_see_mex_cash_dept(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.my_access()                 TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.access_set(uuid, text, text[], text, uuid) TO service_role;

DO $g$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    EXECUTE 'GRANT SELECT ON public.user_access, public.user_departments TO supabase_read_only_user';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.access_level(uuid), public.access_is_active(uuid), public.can_see_margins(uuid), public.can_see_revenue(uuid), public.dept_scope(uuid), public.can_see_mex_cash_dept(uuid) TO supabase_read_only_user';
  END IF;
END
$g$;

-- ── 7. Seed — the owner's decisions, 02.10.2026 ────────────────────────────
-- Matched on profiles.full_name exactly; any name that does not match exactly ONE profile
-- aborts the whole migration. Actor = Mile Stoev (as in 20260947000900).
DO $seed$
DECLARE
  _mile constant uuid := '27f13f6e-fd19-44bb-a3c8-a6855a887cc7';
  r   record;
  _n  int;
  _id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _mile AND full_name = 'Mile Stoev') THEN
    RAISE EXCEPTION 'seed: the actor id is not Mile Stoev';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      (1,  'Mile Stoev',          'super_admin',   NULL::text[],                                        NULL::text),
      (2,  'Mitrov',              'super_admin',   NULL,                                                'Мики Митров'),
      (3,  'Lazar Delev',         'super_admin',   NULL,                                                NULL),
      (4,  'Radislava Maneska',   'super_admin',   NULL,                                                NULL),
      (5,  'Hedi',                'owner',         NULL,                                                NULL),
      (6,  'Mr Tony',             'administrator', NULL,                                                NULL),
      (7,  'Nina',                'administrator', NULL,                                                NULL),
      (8,  'Dragana',             'administrator', NULL,                                                NULL),
      (9,  'Dzenet Ramadani',     'administrator', NULL,                                                NULL),
      (10, 'Teodora Krstevska',   'dept_admin',    ARRAY['teleshop_out', 'teleshop_other', 'social'],   'Тим Центар'),
      (11, 'Mirjana Stefanovski', 'dept_admin',    ARRAY['teleshop_out', 'teleshop_other', 'social'],   'Тим Центар'),
      (12, 'Martina Bundova',     'dept_admin',    ARRAY['altercpa', 'elyon_crm'],                      'Тим Маџари'),
      (13, 'Simona',              'dept_admin',    ARRAY['altercpa', 'elyon_crm'],                      'Тим Маџари'),
      (14, 'Kalina Tajkovska',    'dept_admin',    ARRAY['altercpa', 'elyon_crm'],
           'Тим Маџари · works with Dragana on partner (AlterCPA CPA) deals')
    ) v(ord, full_name, level, depts, note)
    ORDER BY ord
  LOOP
    SELECT count(*), (array_agg(p.user_id))[1] INTO _n, _id FROM public.profiles p WHERE p.full_name = r.full_name;
    IF _n <> 1 THEN
      RAISE EXCEPTION 'seed: % profile(s) named "%" — expected exactly one', _n, r.full_name;
    END IF;
    PERFORM public.access_write(_mile, _id, r.level, r.depts, r.note,
                                'owner''s decisions 02.10.2026 — seed by claude-code (migration 20260947001600)');
  END LOOP;
END
$seed$;

COMMIT;
