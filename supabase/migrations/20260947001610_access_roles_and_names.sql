-- ============================================================================
-- Role + name changes that go with the access levels (owner's decisions, 02.10.2026 evening)
-- ============================================================================
-- 1. Teodora Krstevska is a department admin (Тим Центар), no longer an admin. Granting `admin`
--    had fanned out every role (trg_admin_grant_all_roles); her roles are now set explicitly to
--    manager + pending_agent + prediction_agent. `warehouse` is NOT kept: she never packed an
--    order, counted, moved stock, approved a recipe or pushed to MEX (checked 02.10.2026). The
--    same write PUT /api/users/:id/roles makes, audited as 'user.set_roles'.
-- 2. "Simona" → "Simona Krstevska" (profiles.full_name), with the same denormalized copies
--    PATCH /api/users/:id refreshes: her segment-member rows and her OPEN orders' (pending / take /
--    call_again) assigned_agent_name; audited as 'user.update'. sales_people.display_name and its
--    order_name identity "Simona" stay as they are (author matching).
-- The 4 managers keep their roles; the administrators keep `admin`.
-- Actor = Mile Stoev (as in 20260947000900). Bulk-write rule: orders.updated_at is kept.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE
  _mile   constant uuid := '27f13f6e-fd19-44bb-a3c8-a6855a887cc7';
  _keep   constant text[] := ARRAY['manager', 'pending_agent', 'prediction_agent'];
  _reason constant text := 'owner''s decisions 02.10.2026 — claude-code (migration 20260947001610)';
  _email  text;
  _n      int;
  _teo    uuid;
  _sim    uuid;
  _before text[];
  _after  text[];
  _seg    int;
  _ord    int;
BEGIN
  SELECT u.email INTO _email FROM auth.users u WHERE u.id = _mile;
  IF _email IS NULL THEN RAISE EXCEPTION 'actor Mile Stoev not found'; END IF;

  -- ── 1. Teodora Krstevska: manager + pending_agent + prediction_agent ─────
  SELECT count(*), (array_agg(p.user_id))[1] INTO _n, _teo FROM public.profiles p WHERE p.full_name = 'Teodora Krstevska';
  IF _n <> 1 THEN RAISE EXCEPTION '% profile(s) named "Teodora Krstevska" — expected exactly one', _n; END IF;
  IF public.access_level(_teo) IS DISTINCT FROM 'dept_admin' THEN
    RAISE EXCEPTION 'Teodora Krstevska must be level dept_admin first (20260947001600)';
  END IF;

  SELECT array_agg(r.role::text ORDER BY r.role::text) INTO _before FROM public.user_roles r WHERE r.user_id = _teo;
  DELETE FROM public.user_roles r WHERE r.user_id = _teo AND NOT r.role::text = ANY (_keep);
  INSERT INTO public.user_roles (user_id, role)
  SELECT _teo, k::public.app_role FROM unnest(_keep) k
  ON CONFLICT (user_id, role) DO NOTHING;
  SELECT array_agg(r.role::text ORDER BY r.role::text) INTO _after FROM public.user_roles r WHERE r.user_id = _teo;
  IF _after IS DISTINCT FROM ARRAY['manager', 'pending_agent', 'prediction_agent'] THEN
    RAISE EXCEPTION 'Teodora''s roles ended as % — expected manager, pending_agent, prediction_agent', _after;
  END IF;

  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (_mile, _email, 'user.set_roles', 'user', _teo::text, 'Teodora Krstevska',
          jsonb_build_object('roles', to_jsonb(_after), 'before', to_jsonb(_before),
                             'by', 'claude-code', 'reason', _reason,
                             'why', 'department admin (Тим Центар), not an admin; warehouse not kept — never used'));

  -- ── 2. Simona → Simona Krstevska ─────────────────────────────────────────
  SELECT count(*), (array_agg(p.user_id))[1] INTO _n, _sim FROM public.profiles p WHERE p.full_name = 'Simona';
  IF _n <> 1 THEN RAISE EXCEPTION '% profile(s) named exactly "Simona" — expected exactly one', _n; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.full_name = 'Simona Krstevska') THEN
    RAISE EXCEPTION 'a profile named "Simona Krstevska" already exists';
  END IF;

  UPDATE public.profiles SET full_name = 'Simona Krstevska' WHERE user_id = _sim;

  -- the copies, as PATCH /api/users/:id does — without bumping updated_at (call-again recency)
  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  UPDATE public.prediction_segment_members SET assigned_agent_name = 'Simona Krstevska'
   WHERE assigned_agent_id = _sim;
  GET DIAGNOSTICS _seg = ROW_COUNT;
  UPDATE public.orders SET assigned_agent_name = 'Simona Krstevska'
   WHERE assigned_agent_id = _sim AND status IN ('pending', 'take', 'call_again');
  GET DIAGNOSTICS _ord = ROW_COUNT;

  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (_mile, _email, 'user.update', 'user', _sim::text, 'Simona Krstevska',
          jsonb_build_object('full_name', 'Simona Krstevska', 'email', NULL, 'password_changed', false,
                             'before', jsonb_build_object('full_name', 'Simona'),
                             'segment_member_rows', _seg, 'open_order_rows', _ord,
                             'kept', 'sales_people.display_name and its order_name identity stay "Simona"',
                             'by', 'claude-code', 'reason', _reason));

  RAISE NOTICE 'Teodora roles % → %; Simona renamed (segment rows %, open orders %)', _before, _after, _seg, _ord;
END
$m$;

COMMIT;
