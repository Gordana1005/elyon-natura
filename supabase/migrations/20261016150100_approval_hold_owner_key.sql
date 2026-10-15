-- app_settings.approval_hold (20261016150000, owner 15.10.2026 — Dragana's and Nina's approvals count only once MEX or
-- collabBox shows them) is an OWNER key: no browser session may write it (tg_app_settings_guard_owner_keys).
BEGIN;

DO $guard$
BEGIN
  IF md5(replace(pg_get_functiondef('public.tg_app_settings_guard_owner_keys()'::regprocedure), chr(13), ''))
     <> md5(replace($body$CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at', 'mex_push', 'link_lead_parcels', 'leads_parcel_orders', 'stock_v2', 'shops_reader', 'call_scripts', 'collab_entry_rule', 'bonus_rules', 'mex_cash'];
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
$function$
$body$, chr(13), '')) THEN
    RAISE EXCEPTION 'tg_app_settings_guard_owner_keys changed since this migration was written: re-read the live body';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at', 'mex_push', 'link_lead_parcels', 'leads_parcel_orders', 'stock_v2', 'shops_reader', 'call_scripts', 'collab_entry_rule', 'bonus_rules', 'mex_cash', 'approval_hold'];
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

COMMIT;
