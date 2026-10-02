-- ============================================================================
-- Finance (Финансиски): ema@naturatherapy.mk (owner's decision, 02.10.2026 evening)
-- ============================================================================
-- The login was created on 02.10.2026 with scripts/create-user-mk.mjs (role manager, full_name
-- "Ema"; the password is in docs/VAULT.md §3 only). That script writes no audit row, so the
-- creation is recorded here as 'user.create' (the shape POST /api/users writes), and the level is
-- set through the same writer as every other person: finance = all orders + margins, like the
-- owner (can_see_margins, can_see_revenue, the MEX cash tab). Actor = Mile Stoev.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE
  _mile constant uuid := '27f13f6e-fd19-44bb-a3c8-a6855a887cc7';
  _n    int;
  _ema  uuid;
  _roles text[];
BEGIN
  SELECT count(*), (array_agg(u.id))[1] INTO _n, _ema FROM auth.users u WHERE lower(u.email) = 'ema@naturatherapy.mk';
  IF _n <> 1 THEN RAISE EXCEPTION '% login(s) ema@naturatherapy.mk — expected exactly one (create it first)', _n; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = _ema AND p.full_name = 'Ema' AND p.is_active) THEN
    RAISE EXCEPTION 'ema@naturatherapy.mk has no active profile named "Ema"';
  END IF;
  SELECT array_agg(r.role::text ORDER BY r.role::text) INTO _roles FROM public.user_roles r WHERE r.user_id = _ema;
  IF _roles IS DISTINCT FROM ARRAY['manager'] THEN
    RAISE EXCEPTION 'ema@naturatherapy.mk roles are % — expected exactly manager', _roles;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'user.create' AND a.target_id = _ema::text) THEN
    INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    VALUES (_mile, (SELECT u.email FROM auth.users u WHERE u.id = _mile), 'user.create', 'user', _ema::text, 'Ema',
            jsonb_build_object('full_name', 'Ema', 'email', 'ema@naturatherapy.mk', 'roles', jsonb_build_array('manager'),
                               'via', 'scripts/create-user-mk.mjs', 'by', 'claude-code',
                               'reason', 'owner''s decisions 02.10.2026 — finance login (migration 20260947001620)'));
  END IF;

  PERFORM public.access_write(_mile, _ema, 'finance', NULL, 'Финансиски — new login 02.10.2026',
                              'owner''s decisions 02.10.2026 — finance login, claude-code (migration 20260947001620)');
END
$m$;

COMMIT;
