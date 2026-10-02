-- ============================================================================
-- Bonuses — the MONTH and the RETURN cut (owner, Mile, 02.10.2026)
-- ============================================================================
-- Owner: "Дневно покажува се за бонусите, но потоа кога ќе помине месецот, се чекаат уште 2-3 дена и тогаш базирано на
--   колку е имало return од тие порачки се одлучува крајниот бонус … пример ако агентот имал 15% ретурн тој месец,
--   бонусот се намалува за 20%, ако имал 18 се намалува за 25%, ако имал над 20, се намалува за 33% … се надевам ќе
--   имаме таква опција во поставки кај тв."
-- The day stays live on the TV board (bonus_prediction_day, 20260947001100). The FINAL bonus is per month:
--   days_bonus = Σ over the month's days of the seller's live share (the same formula as the board, day by day, with
--                the target in force that day);
--   return %   = the seller's returned ÷ (delivered + returned) among her prediction (Out) sales of the month — MEX
--                decides (buckets paid / paid_unproven / paid_legacy = delivered, returned = returned); parcels still on
--                the road count in neither;
--   cut %      = the highest tier whose min_pct ≤ return % (app_settings.bonus_rules.return_tiers; owner's example
--                seeded: 15 → 20 %, 18 → 25 %, 20 → 33 %);
--   final      = days_bonus × (1 − cut %).
-- A month is SETTLED settle_after_days (default 3) after it ends — cron bonus-month-settle 06:30 Skopje, or an owner by
--   hand: the rows are frozen in bonus_month_settlements with the rules used; later rule changes never move a settled
--   month. Before that bonus_month(month) answers provisionally.
-- Settings: app_settings.bonus_rules = {settle_after_days, return_tiers [{min_pct, cut_pct}]} — an OWNER key, written by
--   bonus_rules_set (owners, audited). Shown in Поставки → ТВ табла.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $drift$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.tg_app_settings_guard_owner_keys()')
                   AND md5(replace(p.prosrc, chr(13), '')) = 'd2f48dee61c3efccfd9f4f1941d53cd1')
     OR to_regprocedure('public.bonus_prediction_day(date)') IS NULL THEN
    RAISE EXCEPTION 'bonus month: the owner-key guard changed or 20260947001100 is missing';
  END IF;
END
$drift$;

-- ── 1. the rules (an owner key) ─────────────────────────────────────────────
INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('bonus_rules', '{"settle_after_days":3,"return_tiers":[{"min_pct":15,"cut_pct":20},{"min_pct":18,"cut_pct":25},{"min_pct":20,"cut_pct":33}]}'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at', 'mex_push', 'link_lead_parcels', 'leads_parcel_orders', 'stock_v2', 'shops_reader', 'call_scripts', 'collab_entry_rule', 'bonus_rules'];
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

CREATE OR REPLACE FUNCTION public.bonus_rules_set(p_actor uuid, p_rules jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _days  integer;
  _tiers jsonb;
  _t     jsonb;
  _prev  numeric := -1;
  _clean jsonb := '[]'::jsonb;
  _before jsonb;
  _after jsonb;
BEGIN
  IF p_actor IS NULL OR NOT public.is_business_owner(p_actor) THEN
    RAISE EXCEPTION 'owners_only' USING ERRCODE = '42501';
  END IF;
  _days := CASE WHEN coalesce(p_rules->>'settle_after_days', '') ~ '^[0-9]{1,2}$' THEN (p_rules->>'settle_after_days')::int END;
  IF _days IS NULL OR _days > 31 THEN RAISE EXCEPTION 'bad_settle_days' USING ERRCODE = '22023'; END IF;
  _tiers := coalesce(p_rules->'return_tiers', '[]'::jsonb);
  IF jsonb_typeof(_tiers) <> 'array' OR jsonb_array_length(_tiers) > 20 THEN RAISE EXCEPTION 'bad_tiers' USING ERRCODE = '22023'; END IF;
  FOR _t IN SELECT x FROM jsonb_array_elements(_tiers) x
              ORDER BY (CASE WHEN x->>'min_pct' ~ '^[0-9]+(\.[0-9]+)?$' THEN (x->>'min_pct')::numeric END) NULLS FIRST LOOP
    IF coalesce(_t->>'min_pct', '') !~ '^[0-9]+(\.[0-9]+)?$' OR coalesce(_t->>'cut_pct', '') !~ '^[0-9]+(\.[0-9]+)?$'
       OR (_t->>'min_pct')::numeric > 100 OR (_t->>'cut_pct')::numeric > 100 OR (_t->>'min_pct')::numeric <= _prev THEN
      RAISE EXCEPTION 'bad_tiers' USING ERRCODE = '22023';
    END IF;
    _prev := (_t->>'min_pct')::numeric;
    _clean := _clean || jsonb_build_array(jsonb_build_object('min_pct', round((_t->>'min_pct')::numeric, 1),
                                                             'cut_pct', round((_t->>'cut_pct')::numeric, 1)));
  END LOOP;
  SELECT value INTO _before FROM public.app_settings WHERE key = 'bonus_rules';
  _after := jsonb_build_object('settle_after_days', _days, 'return_tiers', _clean);
  INSERT INTO public.app_settings (key, value, updated_at, updated_by) VALUES ('bonus_rules', _after, now(), p_actor)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = p_actor;
  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, (SELECT u.email FROM auth.users u WHERE u.id = p_actor), 'bonus.rules_set', 'app_settings',
          'bonus_rules', 'bonus_rules', jsonb_build_object('before', _before, 'after', _after));
  RETURN _after;
END
$fn$;
COMMENT ON FUNCTION public.bonus_rules_set(uuid, jsonb) IS
  'Owner 02.10.2026: sets app_settings.bonus_rules = {settle_after_days 0–31, return_tiers [{min_pct, cut_pct}] strictly rising} — owners only, audited. Migration 20260947001200.';

-- ── 2. the settled months ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bonus_month_settlements (
  month           date NOT NULL,          -- the 1st of the month
  person_id       uuid NOT NULL,
  days_bonus_eur  numeric NOT NULL,
  delivered_n     integer NOT NULL,
  returned_n      integer NOT NULL,
  return_pct      numeric,
  cut_pct         numeric NOT NULL,
  final_eur       numeric NOT NULL,
  rules           jsonb NOT NULL,
  settled_at      timestamptz NOT NULL DEFAULT now(),
  settled_by      uuid,
  PRIMARY KEY (month, person_id)
);
COMMENT ON TABLE public.bonus_month_settlements IS
  'Owner 02.10.2026: each seller''s FINAL prediction bonus of a month, frozen when the month is settled (settle_after_days after it ends): Σ daily shares, return % (returned ÷ delivered + returned), the cut of the tier, final €, and the rules used. Migration 20260947001200.';
ALTER TABLE public.bonus_month_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bonus_month_settlements FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bonus_month_settlements TO service_role;

-- ── 3. the month (provisional, or the settled rows) ─────────────────────────
CREATE OR REPLACE FUNCTION public.bonus_month(p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _m0    date := date_trunc('month', p_month)::date;
  _m1    date := (date_trunc('month', p_month) + interval '1 month')::date;
  _from  timestamptz := (_m0::timestamp AT TIME ZONE 'Europe/Skopje');
  _to    timestamptz := (_m1::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond';
  _rules jsonb := coalesce((SELECT value FROM public.app_settings WHERE key = 'bonus_rules'), '{}'::jsonb);
  _days  integer := coalesce(CASE WHEN coalesce(_rules->>'settle_after_days', '') ~ '^[0-9]{1,2}$' THEN (_rules->>'settle_after_days')::int END, 3);
  _today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _out   jsonb;
BEGIN
  IF p_month IS NULL THEN RETURN NULL; END IF;

  IF EXISTS (SELECT 1 FROM public.bonus_month_settlements s WHERE s.month = _m0) THEN
    SELECT jsonb_build_object(
      'month', _m0, 'settled', true, 'settled_at', max(s.settled_at), 'settle_on', _m1 + _days,
      'rules', (array_agg(s.rules))[1],
      'people', coalesce(jsonb_agg(jsonb_build_object(
          'person_id', s.person_id, 'name', sp.display_name, 'days_bonus_eur', s.days_bonus_eur,
          'delivered', s.delivered_n, 'returned', s.returned_n, 'return_pct', s.return_pct, 'cut_pct', s.cut_pct,
          'final_eur', s.final_eur) ORDER BY s.final_eur DESC), '[]'::jsonb),
      'total_final_eur', round(sum(s.final_eur), 2), 'total_days_bonus_eur', round(sum(s.days_bonus_eur), 2))
    INTO _out
    FROM public.bonus_month_settlements s LEFT JOIN public.sales_people sp ON sp.id = s.person_id
    WHERE s.month = _m0;
    RETURN _out;
  END IF;

  WITH sr AS MATERIALIZED (
    SELECT s.source, s.person_id, s.sale_day, coalesce(s.value_mkd, 0) AS v, s.bucket
    FROM public.insights_sale_rows(_from, _to, false) s
    WHERE s.in_total AND s.source IN ('teleshop_out', 'elyon_crm')
  ), dd AS (
    SELECT sr.sale_day, sr.source, sum(sr.v) AS value FROM sr GROUP BY 1, 2
  ), dt AS (
    SELECT dd.*, t.daily_target_mkd AS target, t.m1_eur, t.m2_eur, t.m3_eur
    FROM dd
    JOIN LATERAL (SELECT * FROM public.bonus_prediction_targets t
                   WHERE t.department = dd.source AND t.valid_from <= dd.sale_day
                   ORDER BY t.valid_from DESC LIMIT 1) t ON true
  ), dp AS (
    SELECT dt.*,
           (CASE WHEN dt.value >= dt.target / 3.0     THEN dt.m1_eur ELSE 0 END
          + CASE WHEN dt.value >= dt.target * 2 / 3.0 THEN dt.m2_eur ELSE 0 END
          + CASE WHEN dt.value >= dt.target           THEN dt.m3_eur ELSE 0 END) AS pool
    FROM dt
  ), share AS (
    SELECT p.person_id, sum(CASE WHEN dp.value > 0 THEN dp.pool * p.v / dp.value ELSE 0 END) AS days_bonus
    FROM (SELECT sale_day, source, person_id, sum(v) AS v FROM sr WHERE person_id IS NOT NULL GROUP BY 1, 2, 3) p
    JOIN dp ON dp.sale_day = p.sale_day AND dp.source = p.source
    GROUP BY 1
  ), ret AS (
    SELECT sr.person_id,
           count(*) FILTER (WHERE sr.bucket IN ('paid', 'paid_unproven', 'paid_legacy')) AS delivered,
           count(*) FILTER (WHERE sr.bucket = 'returned') AS returned
    FROM sr WHERE sr.person_id IS NOT NULL GROUP BY 1
  ), ppl AS (
    SELECT sh.person_id, sh.days_bonus, coalesce(r.delivered, 0) AS delivered, coalesce(r.returned, 0) AS returned,
           CASE WHEN coalesce(r.delivered, 0) + coalesce(r.returned, 0) > 0
                THEN round(100.0 * r.returned / (r.delivered + r.returned), 1) END AS return_pct
    FROM share sh LEFT JOIN ret r ON r.person_id = sh.person_id
    WHERE sh.days_bonus > 0
  ), cut AS (
    SELECT p.*, coalesce((SELECT max((t->>'cut_pct')::numeric) FROM jsonb_array_elements(coalesce(_rules->'return_tiers', '[]'::jsonb)) t
                           WHERE p.return_pct IS NOT NULL AND p.return_pct >= (t->>'min_pct')::numeric), 0) AS cut_pct
    FROM ppl p
  )
  SELECT jsonb_build_object(
    'month', _m0, 'settled', false, 'settle_on', _m1 + _days, 'rules', _rules,
    'people', coalesce(jsonb_agg(jsonb_build_object(
        'person_id', c.person_id, 'name', sp.display_name, 'days_bonus_eur', round(c.days_bonus, 2),
        'delivered', c.delivered, 'returned', c.returned, 'return_pct', c.return_pct, 'cut_pct', c.cut_pct,
        'final_eur', round(c.days_bonus * (1 - c.cut_pct / 100.0), 2)) ORDER BY c.days_bonus DESC), '[]'::jsonb),
    'total_final_eur', round(coalesce(sum(c.days_bonus * (1 - c.cut_pct / 100.0)), 0), 2),
    'total_days_bonus_eur', round(coalesce(sum(c.days_bonus), 0), 2))
  INTO _out
  FROM cut c LEFT JOIN public.sales_people sp ON sp.id = c.person_id;
  RETURN _out;
END
$fn$;
COMMENT ON FUNCTION public.bonus_month(date) IS
  'Owner 02.10.2026: a month''s prediction (Out) bonus per seller — Σ daily shares (the board''s formula, day by day), return % (returned ÷ delivered + returned of her Out sales), the cut of the bonus_rules tier, final €; the frozen rows once settled. Migration 20260947001200.';

-- ── 4. settle a month (cron after settle_after_days, or an owner) ───────────
CREATE OR REPLACE FUNCTION public.bonus_month_settle(p_month date, p_actor uuid DEFAULT NULL, p_force boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _m0    date := date_trunc('month', p_month)::date;
  _rules jsonb := coalesce((SELECT value FROM public.app_settings WHERE key = 'bonus_rules'), '{}'::jsonb);
  _days  integer := coalesce(CASE WHEN coalesce(_rules->>'settle_after_days', '') ~ '^[0-9]{1,2}$' THEN (_rules->>'settle_after_days')::int END, 3);
  _today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  _m     jsonb;
  _n     integer;
BEGIN
  IF p_actor IS NOT NULL AND NOT public.is_business_owner(p_actor) THEN
    RAISE EXCEPTION 'owners_only' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.bonus_month_settlements WHERE month = _m0) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'already settled', 'month', _m0);
  END IF;
  IF NOT p_force AND _today < (_m0 + interval '1 month')::date + _days THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'too early', 'month', _m0, 'settle_on', (_m0 + interval '1 month')::date + _days);
  END IF;
  _m := public.bonus_month(_m0);
  INSERT INTO public.bonus_month_settlements (month, person_id, days_bonus_eur, delivered_n, returned_n, return_pct,
                                              cut_pct, final_eur, rules, settled_by)
  SELECT _m0, (p->>'person_id')::uuid, (p->>'days_bonus_eur')::numeric, (p->>'delivered')::int, (p->>'returned')::int,
         (p->>'return_pct')::numeric, (p->>'cut_pct')::numeric, (p->>'final_eur')::numeric, _rules, p_actor
  FROM jsonb_array_elements(coalesce(_m->'people', '[]'::jsonb)) p;
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF p_actor IS NOT NULL THEN
    INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    VALUES (p_actor, (SELECT u.email FROM auth.users u WHERE u.id = p_actor), 'bonus.month_settle', 'bonus_month',
            _m0::text, to_char(_m0, 'YYYY-MM'), jsonb_build_object('people', _n, 'total_final_eur', _m->'total_final_eur', 'rules', _rules));
  END IF;
  RETURN jsonb_build_object('ok', true, 'month', _m0, 'people', _n, 'total_final_eur', _m->'total_final_eur');
END
$fn$;
COMMENT ON FUNCTION public.bonus_month_settle(date, uuid, boolean) IS
  'Owner 02.10.2026: freezes a month''s final prediction bonuses (bonus_month) into bonus_month_settlements once settle_after_days have passed after it (p_force: an owner settles earlier); never twice. Cron bonus-month-settle 06:30 Skopje settles the previous month. Migration 20260947001200.';

DO $g$
BEGIN
  REVOKE ALL ON FUNCTION public.bonus_rules_set(uuid, jsonb)                 FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.bonus_month(date)                            FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.bonus_month_settle(date, uuid, boolean)      FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.bonus_rules_set(uuid, jsonb)              TO service_role;
  GRANT EXECUTE ON FUNCTION public.bonus_month(date)                         TO service_role;
  GRANT EXECUTE ON FUNCTION public.bonus_month_settle(date, uuid, boolean)   TO service_role;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT SELECT ON public.bonus_month_settlements TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.bonus_month(date) TO supabase_read_only_user;
  END IF;
END
$g$;

-- ── 5. the cron: the previous month, daily at 06:30 Skopje (≈ 04:30 UTC; waits until settle_after_days have passed) ──
DO $cron$
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = 'bonus-month-settle';
  PERFORM cron.schedule('bonus-month-settle', '30 4 * * *',
    $$SELECT public.bonus_month_settle(((now() AT TIME ZONE 'Europe/Skopje')::date - interval '1 month')::date)$$);
END
$cron$;

COMMIT;
