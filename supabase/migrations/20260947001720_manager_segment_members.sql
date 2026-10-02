-- ============================================================================
-- Department admins can see who is on a list (owner's decisions 02.10.2026).
--
-- The five department admins (Тим Центар: Teodora Krstevska, Mirjana Stefanovski; Тим Маџари:
-- Martina Bundova, Simona Krstevska, Kalina Tajkovska) run the Assigner for their department
-- (20260947001700 turned it on for the manager role). Four of them already saw list members
-- through an agent role; Mirjana (manager + warehouse) got `members_restricted`, because the
-- manager role's privacy row has every flag off. This turns on ONLY `show_segment_members` for
-- the manager role — phone / name / address / order history / recordings stay as they are.
-- Same audit shape as the settings route ('settings.role_privacy').
-- ============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $m$
DECLARE
  _mile   constant uuid := '27f13f6e-fd19-44bb-a3c8-a6855a887cc7';
  _reason constant text := 'owner''s decisions 02.10.2026 — department admins distribute their department''s lists; Mirjana Stefanovski had members_restricted (migration 20260947001720)';
  _email  text;
  _before boolean;
BEGIN
  SELECT email INTO _email FROM public.profiles WHERE user_id = _mile;
  SELECT show_segment_members INTO _before FROM public.role_privacy WHERE role = 'manager';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no role_privacy row for manager';
  END IF;

  UPDATE public.role_privacy
     SET show_segment_members = true, updated_at = now()
   WHERE role = 'manager';

  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (_mile, _email, 'settings.role_privacy', 'role_privacy', 'manager:show_segment_members',
          'manager · show_segment_members',
          jsonb_build_object(
            'role',  'manager',
            'field', 'show_segment_members',
            'from',  _before,
            'to',    true,
            'by',    'claude-code',
            'reason', _reason));
END
$m$;

COMMIT;
