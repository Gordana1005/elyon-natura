-- ============================================================================
-- BUSINESS OWNERS — who may see the money (owner ruling 2026-09-27)
--
-- The full business/money view (Pure Profit, channel P&L, COD totals, the MEX
-- parcel register) belongs to NAMED PEOPLE, not to a role. `admin` cannot be
-- the gate: granting it fans out to eight roles (trg_admin_grant_all_roles)
-- and nine active logins hold it today, most of them because they needed to
-- reassign a lead or fix an order, not because they should read the margins.
-- The operator's ruling: only Mile, Miki, Hedi, Nina, Dragana and Toni see the
-- full business view.
--
-- So ownership is a LIST, and admin does NOT bypass it:
--   public.business_owners          who is on the list
--   public.is_business_owner(uid)   THE predicate. RLS (here and on
--                                   mex_parcels), the api edge function's
--                                   isBusinessOwner() and get_my_permissions()
--                                   all ask this one function, so server and
--                                   UI can never disagree about who is an owner
--   get_my_permissions()            gains `isBusinessOwner` for
--                                   PermissionsContext
--
-- Writes go through the api edge function only (service role, audited,
-- refuses affiliate-only logins, never removes the last owner). There are
-- deliberately NO insert/update/delete policies: no browser session can put
-- itself on the list.
-- ============================================================================

-- Fail fast rather than queue other sessions behind this migration's locks
-- (the auth.users FK below briefly locks auth.users). Transaction-scoped.
SET LOCAL lock_timeout = '5s';

-- ── 1. The list ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.business_owners (
  user_id  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- SET NULL, not the default NO ACTION: an attribution column must never
  -- block deleting the login that made the change.
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  note     text
);

COMMENT ON TABLE public.business_owners IS
  'People who may see the full business/money view (owner ruling 2026-09-27). A named list, NOT a role: admin does not bypass it. Read via is_business_owner(); written only by the api edge function (service role, audited).';
COMMENT ON COLUMN public.business_owners.added_by IS
  'Login that put this person on the list (NULL if that login was deleted).';

-- ── 2. The predicate ───────────────────────────────────────────────────────
-- SECURITY DEFINER so the policy below can read the table it protects without
-- recursing into its own RLS. NULL uid (anon, no session) → false.
CREATE OR REPLACE FUNCTION public.is_business_owner(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.business_owners b WHERE b.user_id = p_uid
  );
$$;

COMMENT ON FUNCTION public.is_business_owner(uuid) IS
  'True when the login is on public.business_owners. THE owner predicate: RLS, the api edge function and get_my_permissions() all call it. Deliberately no admin bypass (owner ruling 2026-09-27).';

REVOKE ALL ON FUNCTION public.is_business_owner(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_business_owner(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_business_owner(uuid) TO authenticated, service_role;

-- ── 3. RLS — owners see the list, nobody writes it from a browser ──────────
ALTER TABLE public.business_owners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS business_owners_select_owners ON public.business_owners;
CREATE POLICY business_owners_select_owners ON public.business_owners
  FOR SELECT TO authenticated
  -- Wrapped in a scalar sub-select: evaluated once per statement, not per row.
  USING ((SELECT public.is_business_owner(auth.uid())));

-- Default privileges hand every new public table to anon/authenticated in
-- full; take that back so SELECT (through the policy) is all that remains.
REVOKE ALL ON public.business_owners FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.business_owners TO authenticated;
GRANT ALL ON public.business_owners TO service_role;

-- ── 4. get_my_permissions() + isBusinessOwner ──────────────────────────────
-- Re-emitted from the LIVE definition (pg_get_functiondef, 2026-09-27) with
-- exactly one addition: the `isBusinessOwner` key. Nothing else changes.
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

    -- Owner ruling 2026-09-27: the business/money view is a named list, not a
    -- role — no admin bypass. Same predicate the api edge function asks.
    'isBusinessOwner', public.is_business_owner(auth.uid())
  );
$function$;

-- Grants unchanged: CREATE OR REPLACE keeps the live ACL (anon,
-- authenticated, service_role). Restated the way every earlier re-emit did.
REVOKE ALL ON FUNCTION public.get_my_permissions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_permissions() TO authenticated, service_role;

-- ── 5. Seed — the six people named in the ruling ───────────────────────────
-- Resolved by EXACT profiles.full_name among ACTIVE profiles, and the whole
-- migration aborts unless every name resolves to exactly one person: a typo,
-- a rename or a namesake must never silently hand the money view to the wrong
-- login, or quietly leave someone off. Verified 2026-09-27: each name below
-- matches exactly one active profile.
--   Toni = the 'Mr Tony' profile.
--   Miki = the 'Mitrov' account (confirmed by Mile 2026-09-27).
-- added_by = Mile, whose ruling this is.
DO $seed$
DECLARE
  _names text[] := ARRAY['Mile Stoev', 'Hedi', 'Nina', 'Dragana', 'Mr Tony', 'Mitrov'];
  _name  text;
  _n     integer;
  _uid   uuid;
  _uids  uuid[] := ARRAY[]::uuid[];
  _mile  uuid;
BEGIN
  -- A fresh database (local reset, branch) has no staff yet: skip rather than
  -- fail, so the migration chain stays replayable. On the live project the
  -- strict check below always runs.
  IF NOT EXISTS (SELECT 1 FROM public.profiles) THEN
    RAISE NOTICE 'business_owners seed skipped: public.profiles is empty (fresh database)';
    RETURN;
  END IF;

  FOREACH _name IN ARRAY _names LOOP
    SELECT count(*)::int, (array_agg(p.user_id))[1]
      INTO _n, _uid
      FROM public.profiles p
     WHERE p.full_name = _name
       AND p.is_active;

    IF _n <> 1 OR _uid IS NULL THEN
      RAISE EXCEPTION 'business_owners seed: expected exactly 1 active profile named "%", found %', _name, _n
        USING HINT = 'Fix the name list (or the profile) and re-run. Nothing was written.';
    END IF;

    _uids := _uids || _uid;
    IF _name = 'Mile Stoev' THEN
      _mile := _uid;
    END IF;
  END LOOP;

  INSERT INTO public.business_owners (user_id, added_by, note)
  SELECT u, _mile, 'seed 2026-09-27 (Mile)'
    FROM unnest(_uids) AS u
  ON CONFLICT (user_id) DO NOTHING;
END
$seed$;

NOTIFY pgrst, 'reload schema';
