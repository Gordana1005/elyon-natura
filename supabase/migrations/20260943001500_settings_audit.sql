-- Settings → Пристап по улога / Правила go through the api with an audit trail (Phase 10, 2026-10-01).
--
-- Why: the old Settings page wrote module_settings, role_permissions, role_privacy and
-- financial_visibility straight from the browser through PostgREST — one click, no confirm and no
-- audit_log row (audit_log had not one module or permission entry). A module switched off hides it
-- from EVERYONE, admins included. The new page writes through
--   PUT /api/settings/modules · PUT /api/settings/role-permissions · PUT /api/settings/privacy
-- (admins only, service role, one audit_log row per change with the before and after). So the
-- browser's write policies go; the tables stay readable exactly as before, and get_my_permissions()
-- (SECURITY DEFINER) keeps returning all four to the client.
--
-- app_settings and courier_rates: their "manage" policies let a MANAGER write them from the browser
-- (is_admin_or_manager) — e.g. flip the no-parcel rule to APPLY or the CPA push, or re-price the
-- courier cost behind Pure Profit — while the api only lets admins / owners. Both are narrowed to
-- admins. Nothing in the app writes either table from the browser (every write is PATCH
-- /api/app-settings, the no-parcel mode route or PATCH /api/courier-rates, all service role), and
-- SQL functions / cron run as the table owner, so no job is affected.
--
-- Deploy order: the api (with the PUT /settings/* routes) first, then this migration, then the UI.
-- Rolled back cleanly by re-creating the four "manage" policies (their definitions are below, in
-- the comments next to each DROP).

-- module_settings: was "Admins can manage module_settings" FOR ALL TO authenticated USING has_role(admin)
DROP POLICY IF EXISTS "Admins can manage module_settings" ON public.module_settings;
DROP POLICY IF EXISTS "Admins can view module_settings" ON public.module_settings;
CREATE POLICY "Admins can view module_settings" ON public.module_settings
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- role_permissions: was "Admins can manage role_permissions" FOR ALL TO authenticated USING has_role(admin)
DROP POLICY IF EXISTS "Admins can manage role_permissions" ON public.role_permissions;
DROP POLICY IF EXISTS "Admins can view role_permissions" ON public.role_permissions;
CREATE POLICY "Admins can view role_permissions" ON public.role_permissions
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));

-- role_privacy: was "Admins can manage role_privacy" FOR ALL TO authenticated USING has_role(admin).
-- Reading stays with "Admins and managers view role_privacy".
DROP POLICY IF EXISTS "Admins can manage role_privacy" ON public.role_privacy;

-- financial_visibility: the Settings tab is gone (it controlled nothing — canSeeFinancial() has no
-- caller); the table stays because get_my_permissions() still returns it. Was "Admins can manage
-- financial_visibility" FOR ALL TO authenticated USING has_role(admin). Reading stays with
-- "Admins and managers view financial_visibility".
DROP POLICY IF EXISTS "Admins can manage financial_visibility" ON public.financial_visibility;

-- app_settings: was "Admins can manage app_settings" FOR ALL TO public USING/CHECK is_admin_or_manager.
DROP POLICY IF EXISTS "Admins can manage app_settings" ON public.app_settings;
CREATE POLICY "Admins can manage app_settings" ON public.app_settings
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- courier_rates: was "Admins/Managers manage courier rates" FOR ALL TO authenticated USING/CHECK is_admin_or_manager.
DROP POLICY IF EXISTS "Admins/Managers manage courier rates" ON public.courier_rates;
DROP POLICY IF EXISTS "Admins manage courier rates" ON public.courier_rates;
CREATE POLICY "Admins manage courier rates" ON public.courier_rates
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

-- GET /api/settings/meta reads audit_log by action: idx_audit_log_action (action, created_at DESC) already serves it.
