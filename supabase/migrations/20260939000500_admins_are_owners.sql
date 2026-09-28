-- ============================================================================
-- Every admin sees the whole business view (owner ruling 2026-09-28)
-- ============================================================================
-- 2026-09-27 the owner limited the money view to a named list
-- (public.business_owners: Mile, Miki/Mitrov, Hedi, Nina, Dragana, Mr Tony)
-- with no admin bypass. 2026-09-28 he reversed that: "all admins should be
-- able to see it all" (Radislava Maneska could not see the money tabs).
--
-- So the ONE predicate every surface reads — RLS policies, the api edge
-- function (rpc is_business_owner), get_my_permissions().isBusinessOwner →
-- the frontend's canSeeBusiness — now answers true for:
--   * anyone on public.business_owners (kept for non-admin owners), OR
--   * an ACTIVE profile holding the 'admin' role ("Суперадмин" in the UI).
-- Managers still get the operational view without money.
--
-- is_active is required: the Suspend button only flips profiles.is_active
-- (sign-in is blocked by an auth ban), and a suspended admin must not keep
-- the money view.
--
-- The presence "owners" recipient group follows the same predicate, so idle
-- alerts reach every admin too.
-- Rollback: re-run the function bodies from 20260934000000 / 20260935000200.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.is_business_owner(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p_uid IS NOT NULL AND (
    EXISTS (SELECT 1 FROM public.business_owners b WHERE b.user_id = p_uid)
    OR EXISTS (
      SELECT 1
        FROM public.user_roles ur
        JOIN public.profiles pr ON pr.user_id = ur.user_id AND pr.is_active
       WHERE ur.user_id = p_uid AND ur.role = 'admin'
    )
  );
$$;

COMMENT ON FUNCTION public.is_business_owner(uuid) IS
  'True for anyone on public.business_owners OR any active admin (owner ruling 2026-09-28: all admins see everything; managers do not). THE owner predicate: RLS, the api edge function and get_my_permissions() all call it.';

REVOKE ALL ON FUNCTION public.is_business_owner(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_business_owner(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_business_owner(uuid) TO authenticated, service_role;

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
  -- "owners" = the same people is_business_owner() lets in: the list + active admins.
  SELECT b.user_id
    FROM public.business_owners b
   WHERE EXISTS (SELECT 1 FROM items WHERE v = 'owners')
  UNION
  SELECT ur.user_id
    FROM public.user_roles ur
    JOIN public.profiles pr ON pr.user_id = ur.user_id AND pr.is_active
   WHERE ur.role = 'admin'
     AND EXISTS (SELECT 1 FROM items WHERE v IN ('owners', 'admins'))
  UNION
  -- CASE, not a bare cast: a cast in the select list is not guaranteed to run
  -- only on rows the WHERE kept.
  SELECT CASE WHEN v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              THEN v::uuid END
    FROM items
   WHERE v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$fn$;

COMMENT ON FUNCTION public.presence_alert_recipients(jsonb) IS
  'Resolves presence_idle_alert_recipients ("owners" = business_owners + active admins since 2026-09-28 | "admins" | user uuid, or an array) to user ids. Internal to the presence engine.';

REVOKE ALL ON FUNCTION public.presence_alert_recipients(jsonb) FROM PUBLIC;

COMMIT;
