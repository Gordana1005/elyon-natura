-- Inbound Teleshop calls ring the operators' browsers (owner, 05.11.2026).
--
-- The two TV numbers 02 512 8888 / 02 620 2515 land on PBX queue 700 "Teleshop In"; the queue's members are pulled from
-- the CRM every 30 s (GET /api/voip/inbound-members, HMAC with the recordings key). WHO rings is decided here:
--   mode 'always'  — rings whenever the person's line is registered and free (Татјана Кипровска, Александра Чима,
--                    Ангела Ристеска)
--   mode 'manual'  — rings only while the person switched themselves in with the "Примам ТВ повици" button on /calls
--                    (Dzenet Ramadani, Mirjana Stefanovski — "кога има многу повеќе клиенти … да помагаат")
--   mode 'off'     — never (everyone else; the default)
-- The row is per LOGIN, not per telephony extension: the extension pool is re-claimed by the next login
-- (voip/credentials), so a flag on telephony_extensions would silently follow the line to another person.
-- Writes go only through inbound_ring_set() from the api (audited there); the browser may read its own row.
-- The manual switch is reset every evening at 21:05 Skopje (the queue closes at 21:00), so a manager who helped
-- on a busy afternoon never rings by accident the next morning.
--
-- Also here: the softphone state 'incoming' (the browser is ringing, not yet a call) joins profiles.voip_state.

BEGIN;

CREATE TABLE IF NOT EXISTS public.inbound_ring_settings (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  mode       text NOT NULL DEFAULT 'off'
             CONSTRAINT inbound_ring_settings_mode_check CHECK (mode IN ('always', 'manual', 'off')),
  manual_on  boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- the manual switch means something only in mode 'manual'
  CONSTRAINT inbound_ring_settings_manual_check CHECK (mode = 'manual' OR manual_on = false)
);
COMMENT ON TABLE public.inbound_ring_settings IS
  'Who rings on PBX queue 700 "Teleshop In" (02 512 8888 / 02 620 2515): always | manual (the /calls button) | off. Pulled by the PBX every 30 s through GET /api/voip/inbound-members. Written only by inbound_ring_set() via the api (05.11.2026).';

ALTER TABLE public.inbound_ring_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users read own inbound ring row" ON public.inbound_ring_settings;
CREATE POLICY "Users read own inbound ring row" ON public.inbound_ring_settings
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
-- no INSERT / UPDATE / DELETE policy: the service role (api) is the only writer
GRANT SELECT ON public.inbound_ring_settings TO authenticated;
GRANT ALL ON public.inbound_ring_settings TO service_role;

-- The one writer. p_mode NULL keeps the mode; p_manual_on NULL keeps the switch; leaving 'manual' clears the switch.
CREATE OR REPLACE FUNCTION public.inbound_ring_set(
  p_user_id uuid, p_mode text DEFAULT NULL, p_manual_on boolean DEFAULT NULL, p_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _before public.inbound_ring_settings;
  _after  public.inbound_ring_settings;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_login');
  END IF;
  IF p_mode IS NOT NULL AND p_mode NOT IN ('always', 'manual', 'off') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_mode');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_login');
  END IF;
  SELECT * INTO _before FROM public.inbound_ring_settings WHERE user_id = p_user_id;
  INSERT INTO public.inbound_ring_settings AS s (user_id, mode, manual_on, updated_at, updated_by)
  VALUES (p_user_id, COALESCE(p_mode, 'off'),
          CASE WHEN COALESCE(p_mode, 'off') = 'manual' THEN COALESCE(p_manual_on, false) ELSE false END,
          now(), p_actor)
  ON CONFLICT (user_id) DO UPDATE SET
    mode       = COALESCE(p_mode, s.mode),
    manual_on  = CASE WHEN COALESCE(p_mode, s.mode) <> 'manual' THEN false
                      ELSE COALESCE(p_manual_on, s.manual_on) END,
    updated_at = now(),
    updated_by = p_actor
  RETURNING * INTO _after;
  RETURN jsonb_build_object('ok', true, 'before', to_jsonb(_before), 'after', to_jsonb(_after));
END;
$fn$;
REVOKE ALL ON FUNCTION public.inbound_ring_set(uuid, text, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inbound_ring_set(uuid, text, boolean, uuid) TO service_role;

-- 21:05 Skopje: the manual switches go off (cron runs in UTC — both candidate hours, the function checks Skopje).
CREATE OR REPLACE FUNCTION public.inbound_ring_manual_reset()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE _n integer := 0;
BEGIN
  IF extract(hour FROM (now() AT TIME ZONE 'Europe/Skopje')) <> 21 THEN
    RETURN 0;
  END IF;
  UPDATE public.inbound_ring_settings SET manual_on = false, updated_at = now(), updated_by = NULL
   WHERE manual_on;
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n > 0 THEN
    INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_name, payload)
    VALUES (NULL, 'cron', 'voip.inbound_ring.reset', 'inbound_ring_settings', 'manual -> off at 21:05',
            jsonb_build_object('rows', _n));
  END IF;
  RETURN _n;
END;
$fn$;
REVOKE ALL ON FUNCTION public.inbound_ring_manual_reset() FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule('inbound-ring-manual-reset') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'inbound-ring-manual-reset');
SELECT cron.schedule('inbound-ring-manual-reset', '5 19,20 * * *', $job$SELECT public.inbound_ring_manual_reset()$job$);

-- 'incoming' = the browser softphone is ringing (an inbound INVITE, not yet a call)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_voip_state_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_voip_state_check
  CHECK (voip_state IN ('idle', 'dialing', 'incoming', 'in_call', 'wrapping', 'ending'));

COMMIT;

NOTIFY pgrst, 'reload schema';
