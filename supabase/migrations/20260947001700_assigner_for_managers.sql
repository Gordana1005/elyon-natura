-- ============================================================================
-- The Assigner for the manager role (owner's decisions, 02.10.2026 evening)
-- ============================================================================
-- What: role_permissions manager · assigner  can_view false → TRUE; can_edit stays as it is (false).
--   The same write PUT /api/settings/role-permissions makes for the patch {can_view: true}
--   (SA.nextPermission: edit is kept, view on), audited the same way as 'settings.role_permission'.
--   module_settings 'assigner' is NOT touched (is_enabled = true live, 02.10.2026).
--
-- Why: Teodora Krstevska (dept admin, Тим Центар) lost the admin role in 20260947001610 and is now
--   manager + pending_agent + prediction_agent. She distributes work on /assigner every day; with
--   manager · assigner off she is locked out of it (ProtectedRoute moduleKey="assigner", and every
--   assigner route answers 403 on !canViewModule("assigner")).
--
-- Why can_edit stays false: nothing reads it for this module. The api gates every assigner route on
--   canViewModule("assigner") (+ isAdminOrManager on assigner/board, lists, distribute, unassign-all;
--   assignment-summary and call-agains/auto-assign on isAdminOrManager alone) — orders/:id/assign,
--   orders/bulk-assign, orders/bulk-unassign, segments/:id/assign, /auto-assign, /bulk-unassign,
--   call-agains/assign included. canEditModule is read only for 'orders' and 'call_scripts'; the SPA
--   never calls canAction('assigner', …); the assigner SQL functions are service_role-only and check
--   no role_permissions. So view alone lets a manager distribute, assign and unassign.
--
-- Who it reaches (live 02.10.2026): every login holding `manager` without `admin` (admins pass
--   canViewModule anyway): Teodora Krstevska, Mirjana Stefanovski (Тим Центар), Martina Bundova,
--   Simona Krstevska, Kalina Tajkovska (Тим Маџари) — all dept_admin — and Ema (finance). The Assigner
--   is NOT department-scoped: each of them sees and can move every department's lists and pendings.
--   Its payloads carry no money. A signed-in manager sees it after a reload (get_my_permissions).
--
-- Actor = Mile Stoev (as in 20260947000900 / 1610). Idempotent: when the row already reads
--   view = true, nothing is written and no audit row is added.
--
-- Rollback: Settings → Пристап по улога → manager · Assigner → view off (the same route, audited), or
--   UPDATE public.role_permissions SET can_view = false, can_edit = false, updated_at = now()
--    WHERE role = 'manager' AND module_key = 'assigner';  + an audit_log 'settings.role_permission' row.
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE
  _mile   constant uuid := '27f13f6e-fd19-44bb-a3c8-a6855a887cc7';
  _role   constant text := 'manager';
  _module constant text := 'assigner';
  _reason constant text := 'owner''s decisions 02.10.2026 — Teodora Krstevska (dept admin, Тим Центар) uses the Assigner daily (migration 20260947001700)';
  _email   text;
  _label   text;
  _enabled boolean;
  _cur     public.role_permissions%ROWTYPE;
  _had     boolean;
  _view    boolean;
  _edit    boolean;
  _after   public.role_permissions%ROWTYPE;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = _mile AND p.full_name = 'Mile Stoev') THEN
    RAISE EXCEPTION 'the actor id is not Mile Stoev';
  END IF;
  SELECT u.email INTO _email FROM auth.users u WHERE u.id = _mile;
  IF _email IS NULL THEN RAISE EXCEPTION 'actor Mile Stoev not found in auth.users'; END IF;

  -- The module must exist (the route answers 404 unknown_module otherwise). Its global switch is
  -- left alone — only reported.
  SELECT ms.module_label, ms.is_enabled INTO _label, _enabled
    FROM public.module_settings ms WHERE ms.module_key = _module;
  IF NOT FOUND THEN RAISE EXCEPTION 'module "%" is not in module_settings', _module; END IF;
  IF _enabled IS NOT TRUE THEN
    RAISE WARNING 'module_settings "%" is switched OFF globally — the permission is saved, the page stays closed until an admin switches the module on', _module;
  END IF;

  SELECT * INTO _cur FROM public.role_permissions rp
   WHERE rp.role = _role AND rp.module_key = _module
   FOR UPDATE;
  _had := FOUND;

  -- SA.nextPermission(cur, {can_view: true}): view on, edit kept.
  _view := true;
  _edit := _had AND _cur.can_edit IS TRUE;

  IF _had AND _cur.can_view IS TRUE THEN
    RAISE NOTICE 'role_permissions %:% already view = true (edit = %) — nothing written', _role, _module, _edit;
    RETURN;
  END IF;

  INSERT INTO public.role_permissions AS rp (role, module_key, can_view, can_edit, updated_at)
  VALUES (_role, _module, _view, _edit, now())
  ON CONFLICT (role, module_key) DO UPDATE
    SET can_view   = EXCLUDED.can_view,
        can_edit   = EXCLUDED.can_edit,
        updated_at = EXCLUDED.updated_at
  RETURNING * INTO _after;

  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (_mile, _email, 'settings.role_permission', 'role_permissions', _role || ':' || _module,
          _role || ' · ' || coalesce(_label, _module),
          jsonb_build_object(
            'role',       _role,
            'module_key', _module,
            'from',       CASE WHEN _had
                               THEN jsonb_build_object('can_view', _cur.can_view IS TRUE, 'can_edit', _cur.can_edit IS TRUE)
                          END,
            'to',         jsonb_build_object('can_view', _after.can_view, 'can_edit', _after.can_edit),
            'by',         'claude-code',
            'reason',     _reason));

  RAISE NOTICE 'role_permissions %:% view %→% edit %→%', _role, _module,
    CASE WHEN _had THEN _cur.can_view::text ELSE 'none' END, _after.can_view,
    CASE WHEN _had THEN _cur.can_edit::text ELSE 'none' END, _after.can_edit;
END
$m$;

COMMIT;
