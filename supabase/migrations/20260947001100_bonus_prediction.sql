-- ============================================================================
-- Bonuses — PREDICTION (Out): a daily target with three milestones and a shared pool (owner, Mile, 02.10.2026)
-- ============================================================================
-- Owner: "кај предикцијата треба да направеме milestone кое активира бонуси … бонусот ќе го покажува во евра …
--   предикцијата(out) ќе се води по исполнет дневен таргет … ќе има 3 отварање на бонуси на 1/3 од таргетот активираат
--   еден бонус, на 2/3 и на 3/3 друг, и тука од вкупниот бонус што го активираат, се поделува на кој/колку има
--   изработено од бонусот, т.е колку од делот придонесол па толку % ќе земе и од бонсуот и се ќе биде фер плеј".
-- Owner's answers (02.10): the target is VALUE in денари · live progress = the day's sales without cancels, the payout
--   only for what MEX collected · everyone sees the euros on the TV board · the pool is shared by VALUE contributed.
-- (Bonus math was deferred until today; this is the first piece the owner asked for. The legacy v1 board's
--   leaderboard_bonus_rules / packageBonusRate stay untouched — they belong to the old board.)
--
-- bonus_prediction_targets — one row per department × valid_from (versions: a new target never rewrites a past day):
--   department teleshop_out (Тим Центар Out) | elyon_crm (Тим Маџари Out), daily_target_mkd, m1_eur / m2_eur / m3_eur
--   (the bonus each milestone unlocks: 1/3, 2/3, 3/3 of the target). Written only by bonus_prediction_target_set
--   (owners, through the api, audited).
-- bonus_prediction_day(day) → jsonb: for each department with a target that day, from THE calculation
--   (insights_sale_rows — the cohort the Табла and the board count):
--   live  = the day's sales of the department, in_total (a cancelled / trashed after the sale never counts):
--           value, milestones reached (value ≥ target × k/3), pool € = Σ the reached milestones' €, and each seller's
--           share = her value ÷ the department's value × pool (to the cent; a sale with no seller keeps its share
--           unassigned — shown, never handed to someone else);
--   paid  = the same formula on the rows MEX has COLLECTED (bucket paid) — the amount that is paid out; it grows as
--           parcels are delivered and settles when the day's last parcel does.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.bonus_prediction_targets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department       text NOT NULL CHECK (department IN ('teleshop_out', 'elyon_crm')),
  valid_from       date NOT NULL,
  daily_target_mkd numeric NOT NULL CHECK (daily_target_mkd > 0),
  m1_eur           numeric NOT NULL DEFAULT 0 CHECK (m1_eur >= 0),
  m2_eur           numeric NOT NULL DEFAULT 0 CHECK (m2_eur >= 0),
  m3_eur           numeric NOT NULL DEFAULT 0 CHECK (m3_eur >= 0),
  note             text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (department, valid_from)
);
COMMENT ON TABLE public.bonus_prediction_targets IS
  'Owner 02.10.2026: the daily prediction (Out) target per department and the € each milestone (1/3, 2/3, 3/3) unlocks; versioned by valid_from (the row in force on a day = the latest valid_from ≤ that day). Written only by bonus_prediction_target_set. Migration 20260947001100.';
ALTER TABLE public.bonus_prediction_targets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bonus_prediction_targets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bonus_prediction_targets TO service_role;

-- ── the writer (owners, via the api — p_actor is the caller) ────────────────
CREATE OR REPLACE FUNCTION public.bonus_prediction_target_set(p_actor uuid, p_department text, p_valid_from date,
                                                             p_target_mkd numeric, p_m1 numeric, p_m2 numeric,
                                                             p_m3 numeric, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _before jsonb;
  _row    public.bonus_prediction_targets;
BEGIN
  IF p_actor IS NULL OR NOT public.is_business_owner(p_actor) THEN
    RAISE EXCEPTION 'owners_only' USING ERRCODE = '42501';
  END IF;
  IF p_department NOT IN ('teleshop_out', 'elyon_crm') THEN
    RAISE EXCEPTION 'bad_department' USING ERRCODE = '22023';
  END IF;
  IF p_valid_from IS NULL OR p_target_mkd IS NULL OR p_target_mkd <= 0
     OR coalesce(p_m1, -1) < 0 OR coalesce(p_m2, -1) < 0 OR coalesce(p_m3, -1) < 0 THEN
    RAISE EXCEPTION 'bad_values' USING ERRCODE = '22023';
  END IF;
  SELECT to_jsonb(t) INTO _before FROM public.bonus_prediction_targets t
   WHERE t.department = p_department AND t.valid_from = p_valid_from;
  INSERT INTO public.bonus_prediction_targets (department, valid_from, daily_target_mkd, m1_eur, m2_eur, m3_eur, note, created_by)
  VALUES (p_department, p_valid_from, round(p_target_mkd), round(p_m1, 2), round(p_m2, 2), round(p_m3, 2),
          nullif(btrim(coalesce(p_note, '')), ''), p_actor)
  ON CONFLICT (department, valid_from) DO UPDATE
     SET daily_target_mkd = EXCLUDED.daily_target_mkd, m1_eur = EXCLUDED.m1_eur, m2_eur = EXCLUDED.m2_eur,
         m3_eur = EXCLUDED.m3_eur, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = now()
  RETURNING * INTO _row;
  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, (SELECT u.email FROM auth.users u WHERE u.id = p_actor), 'bonus.prediction_target_set',
          'bonus_prediction_target', _row.id::text, p_department || ' from ' || p_valid_from,
          jsonb_build_object('before', _before, 'after', to_jsonb(_row)));
  RETURN to_jsonb(_row);
END
$fn$;
COMMENT ON FUNCTION public.bonus_prediction_target_set(uuid, text, date, numeric, numeric, numeric, numeric, text) IS
  'Owner 02.10.2026: sets the prediction target + milestone € of a department from a day (a new version, or that day''s version replaced); owners only (is_business_owner); audited. Migration 20260947001100.';

-- ── the day ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bonus_prediction_day(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _from timestamptz := (p_day::timestamp AT TIME ZONE 'Europe/Skopje');
  _to   timestamptz := ((p_day + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond';
  _out  jsonb;
BEGIN
  IF p_day IS NULL THEN RETURN NULL; END IF;
  WITH tg AS (
    SELECT DISTINCT ON (t.department) t.department, t.daily_target_mkd AS target, t.m1_eur, t.m2_eur, t.m3_eur, t.valid_from
    FROM public.bonus_prediction_targets t
    WHERE t.valid_from <= p_day
    ORDER BY t.department, t.valid_from DESC
  ), sr AS (
    SELECT s.source, s.person_id, coalesce(s.value_mkd, 0) AS v, (s.bucket = 'paid') AS paid
    FROM public.insights_sale_rows(_from, _to, false) s
    WHERE s.in_total AND s.source IN (SELECT department FROM tg)
  ), dept AS (
    SELECT tg.*,
           coalesce((SELECT sum(sr.v) FROM sr WHERE sr.source = tg.department), 0) AS value,
           coalesce((SELECT sum(sr.v) FROM sr WHERE sr.source = tg.department AND sr.paid), 0) AS paid_value
    FROM tg
  ), dm AS (
    SELECT d.*,
           (d.value >= d.target / 3.0)::int + (d.value >= d.target * 2 / 3.0)::int + (d.value >= d.target)::int AS reached,
           (d.paid_value >= d.target / 3.0)::int + (d.paid_value >= d.target * 2 / 3.0)::int + (d.paid_value >= d.target)::int AS paid_reached
    FROM dept d
  ), dp AS (
    SELECT dm.*,
           (CASE WHEN dm.reached >= 1 THEN dm.m1_eur ELSE 0 END + CASE WHEN dm.reached >= 2 THEN dm.m2_eur ELSE 0 END
            + CASE WHEN dm.reached >= 3 THEN dm.m3_eur ELSE 0 END) AS pool,
           (CASE WHEN dm.paid_reached >= 1 THEN dm.m1_eur ELSE 0 END + CASE WHEN dm.paid_reached >= 2 THEN dm.m2_eur ELSE 0 END
            + CASE WHEN dm.paid_reached >= 3 THEN dm.m3_eur ELSE 0 END) AS paid_pool
    FROM dm
  ), ppl AS (
    SELECT sr.source, sr.person_id, sum(sr.v) AS v, sum(sr.v) FILTER (WHERE sr.paid) AS pv
    FROM sr GROUP BY 1, 2
  )
  SELECT jsonb_build_object(
    'day', p_day,
    'departments', coalesce(jsonb_agg(jsonb_build_object(
      'department', dp.department,
      'valid_from', dp.valid_from,
      'target_mkd', round(dp.target),
      'thresholds_mkd', jsonb_build_array(round(dp.target / 3.0), round(dp.target * 2 / 3.0), round(dp.target)),
      'milestones_eur', jsonb_build_array(dp.m1_eur, dp.m2_eur, dp.m3_eur),
      'value_mkd', round(dp.value),
      'reached', dp.reached,
      'pool_eur', round(dp.pool, 2),
      'paid_value_mkd', round(dp.paid_value),
      'paid_reached', dp.paid_reached,
      'paid_pool_eur', round(dp.paid_pool, 2),
      'people', coalesce((SELECT jsonb_agg(jsonb_build_object(
          'person_id', p.person_id,
          'value_mkd', round(p.v),
          'share', CASE WHEN dp.value > 0 THEN round(p.v / dp.value, 4) END,
          'bonus_eur', CASE WHEN dp.value > 0 THEN round(dp.pool * p.v / dp.value, 2) ELSE 0 END,
          'paid_value_mkd', round(coalesce(p.pv, 0)),
          'paid_bonus_eur', CASE WHEN dp.paid_value > 0 THEN round(dp.paid_pool * coalesce(p.pv, 0) / dp.paid_value, 2) ELSE 0 END)
          ORDER BY p.v DESC)
        FROM ppl p WHERE p.source = dp.department), '[]'::jsonb))
      ORDER BY CASE dp.department WHEN 'teleshop_out' THEN 1 ELSE 2 END), '[]'::jsonb))
  INTO _out
  FROM dp;
  RETURN _out;
END
$fn$;
COMMENT ON FUNCTION public.bonus_prediction_day(date) IS
  'Owner 02.10.2026: the prediction (Out) bonus of a Skopje day per department with a target — live (the day''s sales, in_total) and paid (MEX-collected): value, milestones reached (1/3, 2/3, 3/3 of the target), pool € and each seller''s € share by value. From insights_sale_rows (the cohort). Migration 20260947001100.';

DO $g$
BEGIN
  REVOKE ALL ON FUNCTION public.bonus_prediction_target_set(uuid, text, date, numeric, numeric, numeric, numeric, text) FROM PUBLIC, anon, authenticated;
  REVOKE ALL ON FUNCTION public.bonus_prediction_day(date) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.bonus_prediction_target_set(uuid, text, date, numeric, numeric, numeric, numeric, text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.bonus_prediction_day(date) TO service_role;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT SELECT ON public.bonus_prediction_targets TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.bonus_prediction_day(date) TO supabase_read_only_user;
  END IF;
END
$g$;

COMMIT;
