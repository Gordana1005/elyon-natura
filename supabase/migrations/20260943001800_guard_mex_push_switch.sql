-- The "Испрати до MEX" switch (app_settings.mex_push, migration 20260943001200) is changed only through its
-- audited api route (PATCH /warehouse/mex-push/settings) — never straight from a browser session, where it
-- would leave no audit row. Same guard as the no-parcel rule and the stock switches.
DO $drift$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE proname = 'tg_app_settings_guard_owner_keys') IS DISTINCT FROM '0bffecdebea7c2b224b8dc9e96e74175' THEN
    RAISE EXCEPTION 'tg_app_settings_guard_owner_keys drifted from its 01.10.2026 body — re-read it before replacing';
  END IF;
END
$drift$;

CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at', 'mex_push'];
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (CASE WHEN TG_OP = 'DELETE' THEN OLD.key ELSE NEW.key END = ANY (_guarded)
          OR (TG_OP = 'UPDATE' AND OLD.key = ANY (_guarded))) THEN
    RAISE EXCEPTION 'app_settings.% is changed only through its owners'' switch in the app',
                    CASE WHEN TG_OP = 'INSERT' THEN NEW.key ELSE OLD.key END
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;
