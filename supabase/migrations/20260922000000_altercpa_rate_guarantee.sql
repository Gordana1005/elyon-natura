-- ============================================================================
-- AlterCPA 30% guarantee — per-affiliate daily confirmation rate + alerts
-- ============================================================================
-- WHY: every affiliate guarantees ~30% of the leads they send us get confirmed,
-- and we pay on that. The operator was tracking it by hand. Nothing watched it,
-- and nothing told anyone when a day slipped under.
--
-- PORTED FROM BULGARIA (`20260922000000_affiliate_daily_rate_alerts.sql`) but
-- NOT a copy. BG reads `affiliates` + `affiliate_leads`; in Macedonia both are
-- EMPTY (0 rows, verified 2026-08-13) — our leads arrive through the AlterCPA
-- bridge and live in `altercpa_leads`. A literal port would have rendered a
-- permanently blank screen. BG's own migration carries a port note naming this
-- project; this honours it and swaps the data source.
--
-- ── The metric (operator, 2026-08-13) ───────────────────────────────────────
-- COHORT BY ARRIVAL DAY, 00:00-00:00 Europe/Skopje. "Of the N leads that
-- arrived on 12.08, how many ever got confirmed." A lead that arrives Tuesday
-- and confirms Thursday still counts to TUESDAY, so a cohort keeps improving
-- after its day ends — measured settle time is ~2-3 days (13.08 had 45 leads
-- still open, 12.08 had 7, 11.08 had 1).
--
-- DENOMINATOR = EVERY Macedonian lead. Explicitly: trashed, cancelled, never
-- mapped to an offer, no phone, never even promoted to an order. The affiliate
-- sent it, so it counts. Do NOT "improve" this by filtering to callable leads —
-- that was asked and answered.
--
-- NUMERATOR = ever reached confirmed or beyond (confirmed/shipped/delivered/
-- paid/returned). STICKY: a later cancel does not un-confirm. `confirmed_at` is
-- useless here — the AlterCPA status sync only ever stamps paid/cancelled/
-- trashed/returned_at, never confirmed_at — so the sticky truth is
-- `order_history`, which the sync writes on every transition. Verified: over 7
-- days both definitions agree exactly (614 = 614).
--
-- ── Grain: judge per AFFILIATE, diagnose per OFFER ──────────────────────────
-- The deal is per affiliate, and that is also the only grain with enough daily
-- volume to mean anything: 3221 sends 27-146 leads/day across 12 offers, while
-- 20 of the 31 affiliate x offer pairs get under 12 leads a WEEK
-- (2676 x "Adenofrin +" = 2 leads = 0%). Alerting per offer would fire red
-- alarms off two leads every day. The per-offer split is still computed and
-- shown, so you can see WHICH offer dragged an affiliate down — it just never
-- raises an alarm on its own.
--
-- ── Alerts ─────────────────────────────────────────────────────────────────
-- BG alerts when a cohort REACHES target. Macedonia is the inverse (operator):
-- being above 30% is fine and needs no announcement; what matters is falling
-- BELOW. So the running pings are informational and the judgement is a verdict:
--   * every STEP-th lead      -> today's running %
--   * every STEP-th confirm   -> that COHORT DATE's % (a 12.08 lead confirmed
--     on 13.08 says "cohort 12.08", never today — so the day is never ambiguous)
--   * provisional verdict at 23:xx local, ONLY if under target
--   * final verdict at cohort + settle_days, ONLY if still under target
-- A verdict needs `min_cohort` leads first, or a 0/3 morning fires nonsense.
--
-- STEP is 10 by operator choice (~19 pings/day at current volume). BG ships 5;
-- its port note warns that 5 here would be ~100 alerts/day per person. If the
-- bell gets noisy, raise altercpa_rate_milestone_step — no migration needed.
-- ============================================================================

BEGIN;

-- ── 1. Operator-local calendar timezone ────────────────────────────────────
-- The ONE place the day boundary is defined. Macedonia is Europe/Skopje
-- (CET/CEST) — NOT Europe/Sofia, which is an hour ahead and would put every
-- cohort boundary in the wrong place.
CREATE OR REPLACE FUNCTION public.crm_tz()
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 'Europe/Skopje'
$$;
COMMENT ON FUNCTION public.crm_tz() IS
  'Operator-local calendar timezone for day bucketing. Macedonia = Europe/Skopje. This is the ONLY place it is defined.';
REVOKE ALL ON FUNCTION public.crm_tz() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_tz() TO service_role;

-- ── 2. Knobs (no migration needed to retune) ───────────────────────────────
INSERT INTO public.app_settings (key, value) VALUES
  ('altercpa_rate_target_pct',     '30'::jsonb),   -- the guaranteed %
  ('altercpa_rate_milestone_step', '10'::jsonb),   -- ping every N leads / N confirms
  ('altercpa_rate_min_cohort',     '20'::jsonb),   -- no verdict below this many leads
  ('altercpa_rate_settle_days',    '3'::jsonb),    -- cohort is final after N days
  ('altercpa_rate_geo',            '"MK"'::jsonb)  -- Macedonia only, for now
ON CONFLICT (key) DO NOTHING;

-- ── 3. Alert ledger — the idempotency guarantee ────────────────────────────
CREATE TABLE IF NOT EXISTS public.altercpa_rate_alerts (
  webmaster   text NOT NULL,          -- AlterCPA `wm` — the affiliate
  cohort_date date NOT NULL,          -- crm_tz()-local ARRIVAL day
  kind        text NOT NULL CHECK (kind IN ('leads', 'confirms', 'verdict_day', 'verdict_final')),
  milestone   int  NOT NULL,          -- leads/confirms: count reached. verdicts: the target %,
                                      -- so raising 30 -> 35 naturally re-arms a fresh verdict.
  sent        int  NOT NULL,
  confirmed   int  NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (webmaster, cohort_date, kind, milestone)
);
COMMENT ON TABLE public.altercpa_rate_alerts IS
  'Append-only record of guarantee-rate alerts already fired. The 4-column PK is what makes each milestone fire exactly once, race-safe via ON CONFLICT DO NOTHING. Internal only — no client reads this.';

ALTER TABLE public.altercpa_rate_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.altercpa_rate_alerts FROM PUBLIC;
REVOKE ALL ON public.altercpa_rate_alerts FROM anon, authenticated;

-- Sticky-confirm lookups run once per lead in a cohort tally.
CREATE INDEX IF NOT EXISTS idx_order_history_order_to_status
  ON public.order_history (order_id, to_status);

-- Cohort scans are (geo, arrival time) with a webmaster filter.
CREATE INDEX IF NOT EXISTS idx_altercpa_leads_geo_created_remote
  ON public.altercpa_leads (geo, created_remote);

-- ── 4. The counting rule, defined exactly once ─────────────────────────────

-- STICKY confirm truth. Current status OR anything in this order's history:
-- a confirmed sale that is later cancelled still counted as a confirm on the
-- day it arrived, which is what the affiliate is paid on.
CREATE OR REPLACE FUNCTION public.altercpa_lead_is_confirmed(_order_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT _order_id IS NOT NULL
     AND (EXISTS (SELECT 1 FROM public.orders o
                   WHERE o.id = _order_id
                     AND o.status IN ('confirmed','shipped','delivered','paid','returned'))
       OR EXISTS (SELECT 1 FROM public.order_history h
                   WHERE h.order_id = _order_id
                     AND h.to_status IN ('confirmed','shipped','delivered','paid','returned')));
$$;
COMMENT ON FUNCTION public.altercpa_lead_is_confirmed(uuid) IS
  'Sticky "this lead ever became a sale". Uses order_history because the AlterCPA status sync never stamps confirmed_at (only paid/cancelled/trashed/returned_at).';
REVOKE ALL ON FUNCTION public.altercpa_lead_is_confirmed(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.altercpa_lead_is_confirmed(uuid) TO service_role;

-- One cohort's numbers. Every path below counts through THIS function, so the
-- table, the pings and the verdicts can never disagree.
CREATE OR REPLACE FUNCTION public.altercpa_rate_cohort(_webmaster text, _day date)
RETURNS TABLE (sent int, confirmed int)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  -- (_day + 1)::timestamp AT TIME ZONE, never "+ interval '1 day'" on the
  -- timestamptz: DST days are 23h/25h long and a cohort must span local
  -- midnight to local midnight regardless.
  SELECT count(*)::int,
         count(*) FILTER (WHERE public.altercpa_lead_is_confirmed(l.order_id))::int
  FROM public.altercpa_leads l
  WHERE COALESCE(l.webmaster, '(none)') = _webmaster
    AND upper(COALESCE(l.geo, '')) = upper(COALESCE(
          (SELECT value #>> '{}' FROM public.app_settings WHERE key = 'altercpa_rate_geo'), 'MK'))
    AND COALESCE(l.created_remote, l.first_seen_at) >= (_day::timestamp AT TIME ZONE public.crm_tz())
    AND COALESCE(l.created_remote, l.first_seen_at) <  ((_day + 1)::timestamp AT TIME ZONE public.crm_tz());
$$;
COMMENT ON FUNCTION public.altercpa_rate_cohort(text, date) IS
  'Leads sent and ever-confirmed for one affiliate on one local arrival day. Denominator is EVERY lead in the geo - trashed, cancelled, unmapped, phoneless and never-promoted included. Do not filter it.';
REVOKE ALL ON FUNCTION public.altercpa_rate_cohort(text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.altercpa_rate_cohort(text, date) TO service_role;

-- ── 5. Fan-out ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_altercpa_rate(
  _webmaster text,
  _cohort    date,
  _kind      text,
  _milestone int,
  _sent      int,
  _confirmed int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _target int;
  _pct    numeric;
  _dd     text;
  _iso    text;
  _key    text;
  _type   text;
  _title  text;
  _msg    text;
BEGIN
  -- The single race-safe dedupe gate for all four kinds.
  INSERT INTO public.altercpa_rate_alerts (webmaster, cohort_date, kind, milestone, sent, confirmed)
  VALUES (_webmaster, _cohort, _kind, _milestone, _sent, _confirmed)
  ON CONFLICT (webmaster, cohort_date, kind, milestone) DO NOTHING;
  IF NOT FOUND THEN
    RETURN;  -- already fired, or a concurrent trigger won the race
  END IF;

  -- app_settings.value is jsonb: the `#>> '{}'` unwrap is required. `value::int`
  -- compiles fine and fails at runtime.
  SELECT (value #>> '{}')::int INTO _target
  FROM public.app_settings WHERE key = 'altercpa_rate_target_pct';
  _target := GREATEST(COALESCE(_target, 30), 1);

  _pct := COALESCE(round(_confirmed * 100.0 / NULLIF(_sent, 0), 1), 0);
  _dd  := to_char(_cohort, 'DD.MM');
  _iso := to_char(_cohort, 'YYYY-MM-DD');

  -- English in the DB + meta.i18n; the bell translates and a missing key
  -- degrades to this stored English (the notifications law).
  IF _kind = 'leads' THEN
    _key := 'notif.altercpaRateLeads'; _type := 'altercpa_rate';
    _title := 'Affiliate leads milestone';
    _msg := 'Affiliate ' || _webmaster || ' — ' || _dd || ': ' || _sent || ' leads, '
            || _confirmed || ' confirmed, ' || _pct || '% / guarantee ' || _target || '%';
  ELSIF _kind = 'confirms' THEN
    _key := 'notif.altercpaRateConfirms'; _type := 'altercpa_rate';
    _title := 'Affiliate confirmations';
    _msg := 'Affiliate ' || _webmaster || ' — cohort ' || _dd || ': ' || _confirmed || '/' || _sent
            || ' confirmed, ' || _pct || '% / guarantee ' || _target || '%';
  ELSIF _kind = 'verdict_day' THEN
    _key := 'notif.altercpaRateBelowDay'; _type := 'altercpa_rate_below';
    _title := 'Affiliate below guarantee today';
    _msg := 'Affiliate ' || _webmaster || ' closed ' || _dd || ' at ' || _pct || '% ('
            || _confirmed || '/' || _sent || ') — under the ' || _target
            || '% guarantee. Late confirmations may still lift it.';
  ELSE
    _key := 'notif.altercpaRateBelowFinal'; _type := 'altercpa_rate_below';
    _title := 'Affiliate finished below guarantee';
    _msg := 'Affiliate ' || _webmaster || ' finished ' || _dd || ' at ' || _pct || '% ('
            || _confirmed || '/' || _sent || ') — under the ' || _target
            || '% guarantee. This cohort has settled.';
  END IF;

  -- DISTINCT: somebody holding both roles gets ONE copy, not two.
  INSERT INTO public.notifications (user_id, type, title, message, link, meta)
  SELECT DISTINCT ur.user_id, _type, _title, _msg,
         '/altercpa?tab=rates&wm=' || _webmaster || '&date=' || _iso,
         jsonb_build_object(
           'i18n', _key, 'affiliate', _webmaster, 'date', _dd, 'dateIso', _iso,
           'sent', _sent, 'confirmed', _confirmed, 'pct', _pct, 'target', _target)
  FROM public.user_roles ur
  JOIN public.profiles p ON p.user_id = ur.user_id AND p.is_active
  WHERE ur.role IN ('admin', 'manager');
END;
$fn$;
REVOKE ALL ON FUNCTION public.notify_altercpa_rate(text, date, text, int, int, int) FROM PUBLIC, anon, authenticated;

-- ── 6. Lead-side trigger: every STEP-th lead of the affiliate's local day ──
CREATE OR REPLACE FUNCTION public.tg_altercpa_lead_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _step int; _geo text; _wm text; _day date; _c record;
BEGIN
  SELECT value #>> '{}' INTO _geo FROM public.app_settings WHERE key = 'altercpa_rate_geo';
  IF upper(COALESCE(NEW.geo, '')) <> upper(COALESCE(_geo, 'MK')) THEN
    RETURN NEW;   -- other countries are mirrored but not tracked (operator)
  END IF;

  SELECT (value #>> '{}')::int INTO _step
  FROM public.app_settings WHERE key = 'altercpa_rate_milestone_step';
  _step := GREATEST(COALESCE(_step, 10), 1);

  _wm  := COALESCE(NEW.webmaster, '(none)');
  _day := (COALESCE(NEW.created_remote, NEW.first_seen_at, now()) AT TIME ZONE public.crm_tz())::date;

  SELECT * INTO _c FROM public.altercpa_rate_cohort(_wm, _day);
  IF _c.sent % _step <> 0 THEN
    RETURN NEW;
  END IF;

  PERFORM public.notify_altercpa_rate(_wm, _day, 'leads', _c.sent, _c.sent, _c.confirmed);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A stats ping must NEVER bounce a partner's lead.
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.tg_altercpa_lead_rate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_altercpa_lead_rate ON public.altercpa_leads;
CREATE TRIGGER trg_altercpa_lead_rate
  AFTER INSERT ON public.altercpa_leads
  FOR EACH ROW EXECUTE FUNCTION public.tg_altercpa_lead_rate();

-- ── 7. Confirm-side trigger: cohort progress, announced by COHORT date ─────
CREATE OR REPLACE FUNCTION public.tg_altercpa_confirm_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _lead record; _step int; _geo text; _cohort date; _c record;
BEGIN
  IF NEW.status NOT IN ('confirmed','shipped','delivered','paid','returned') THEN
    RETURN NEW;
  END IF;

  SELECT value #>> '{}' INTO _geo FROM public.app_settings WHERE key = 'altercpa_rate_geo';

  -- orders carry no affiliate columns; the ledger row is the linkage.
  SELECT l.webmaster, l.geo, l.created_remote, l.first_seen_at INTO _lead
  FROM public.altercpa_leads l WHERE l.order_id = NEW.id LIMIT 1;
  -- NOT FOUND, never `_lead IS NULL`: a record tests NULL only when EVERY
  -- field is null, and webmaster alone could legitimately be.
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF upper(COALESCE(_lead.geo, '')) <> upper(COALESCE(_geo, 'MK')) THEN RETURN NEW; END IF;

  SELECT (value #>> '{}')::int INTO _step
  FROM public.app_settings WHERE key = 'altercpa_rate_milestone_step';
  _step := GREATEST(COALESCE(_step, 10), 1);

  -- The cohort is the lead's ARRIVAL day, never today. A 12.08 lead confirmed
  -- on 13.08 updates — and is announced as — the 12.08 cohort. This was the
  -- operator's explicit requirement: the day must never be ambiguous.
  _cohort := (COALESCE(_lead.created_remote, _lead.first_seen_at) AT TIME ZONE public.crm_tz())::date;

  SELECT * INTO _c FROM public.altercpa_rate_cohort(COALESCE(_lead.webmaster,'(none)'), _cohort);
  IF _c.confirmed = 0 OR _c.confirmed % _step <> 0 THEN
    RETURN NEW;
  END IF;

  PERFORM public.notify_altercpa_rate(
    COALESCE(_lead.webmaster,'(none)'), _cohort, 'confirms', _c.confirmed, _c.sent, _c.confirmed);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A stats ping must NEVER roll back a confirm.
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.tg_altercpa_confirm_rate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_altercpa_confirm_rate ON public.orders;
CREATE TRIGGER trg_altercpa_confirm_rate
  AFTER UPDATE OF status ON public.orders
  FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.tg_altercpa_confirm_rate();

-- ── 8. Verdicts: the alert that actually matters ───────────────────────────
-- Only fires when a cohort is UNDER the guarantee. Above target needs no
-- announcement (operator): "even if we have more it's not a problem".
CREATE OR REPLACE FUNCTION public.altercpa_rate_verdict(_cohort date, _kind text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _target int; _min int; _geo text; _wm text; _c record; _n int := 0;
BEGIN
  SELECT (value #>> '{}')::int INTO _target FROM public.app_settings WHERE key = 'altercpa_rate_target_pct';
  _target := GREATEST(COALESCE(_target, 30), 1);
  SELECT (value #>> '{}')::int INTO _min FROM public.app_settings WHERE key = 'altercpa_rate_min_cohort';
  _min := GREATEST(COALESCE(_min, 20), 1);
  SELECT value #>> '{}' INTO _geo FROM public.app_settings WHERE key = 'altercpa_rate_geo';

  FOR _wm IN
    SELECT DISTINCT COALESCE(l.webmaster, '(none)')
    FROM public.altercpa_leads l
    WHERE upper(COALESCE(l.geo,'')) = upper(COALESCE(_geo,'MK'))
      AND COALESCE(l.created_remote, l.first_seen_at) >= (_cohort::timestamp AT TIME ZONE public.crm_tz())
      AND COALESCE(l.created_remote, l.first_seen_at) <  ((_cohort + 1)::timestamp AT TIME ZONE public.crm_tz())
  LOOP
    SELECT * INTO _c FROM public.altercpa_rate_cohort(_wm, _cohort);
    -- A quiet affiliate is not a failing one: 0/3 is noise, not a breach.
    CONTINUE WHEN _c.sent < _min;
    CONTINUE WHEN (_c.confirmed * 100.0 / NULLIF(_c.sent,0)) >= _target;
    -- milestone = the target itself, so raising 30 -> 35 re-arms a fresh verdict.
    PERFORM public.notify_altercpa_rate(_wm, _cohort, _kind, _target, _c.sent, _c.confirmed);
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END;
$fn$;
REVOKE ALL ON FUNCTION public.altercpa_rate_verdict(date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.altercpa_rate_verdict(date, text) TO service_role;

CREATE OR REPLACE FUNCTION public.altercpa_rate_verdict_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _tz text := public.crm_tz();
  _now timestamp := now() AT TIME ZONE _tz;
  _settle int;
BEGIN
  SELECT (value #>> '{}')::int INTO _settle FROM public.app_settings WHERE key = 'altercpa_rate_settle_days';
  _settle := GREATEST(COALESCE(_settle, 3), 1);

  -- Provisional, just before local midnight: "you closed today under target".
  IF extract(hour FROM _now)::int = 23 THEN
    PERFORM public.altercpa_rate_verdict(_now::date, 'verdict_day');
  END IF;

  -- Final, once the cohort has settled. Separate from the provisional because
  -- cohorts measurably keep improving for ~2-3 days — a midnight verdict alone
  -- would condemn days that go on to clear the guarantee.
  IF extract(hour FROM _now)::int = 10 THEN
    PERFORM public.altercpa_rate_verdict((_now::date - _settle), 'verdict_final');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RETURN;  -- the scheduler must never error the cron job
END;
$fn$;
REVOKE ALL ON FUNCTION public.altercpa_rate_verdict_sweep() FROM PUBLIC, anon, authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'altercpa-rate-verdicts') THEN
    PERFORM cron.unschedule('altercpa-rate-verdicts');
  END IF;
END
$cron$;
-- Hourly; the function itself picks the two local hours that matter, which is
-- what makes it DST-proof (pg_cron fires in UTC).
SELECT cron.schedule('altercpa-rate-verdicts', '5 * * * *',
  $job$SELECT public.altercpa_rate_verdict_sweep();$job$);

-- ── 9. Read model for the UI ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.altercpa_daily_rates(_from date, _to date)
RETURNS TABLE (
  day date, webmaster text, offer_name text,
  leads int, confirmed int, pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH base AS (
    SELECT (COALESCE(l.created_remote, l.first_seen_at) AT TIME ZONE public.crm_tz())::date AS day,
           COALESCE(l.webmaster, '(none)')  AS webmaster,
           COALESCE(l.offer_name, '(blank)') AS offer_name,
           public.altercpa_lead_is_confirmed(l.order_id) AS ok
    FROM public.altercpa_leads l
    WHERE upper(COALESCE(l.geo,'')) = upper(COALESCE(
            (SELECT value #>> '{}' FROM public.app_settings WHERE key='altercpa_rate_geo'), 'MK'))
      AND COALESCE(l.created_remote, l.first_seen_at) >= (_from::timestamp AT TIME ZONE public.crm_tz())
      AND COALESCE(l.created_remote, l.first_seen_at) <  ((_to + 1)::timestamp AT TIME ZONE public.crm_tz())
  )
  -- GROUPING SETS gives the affiliate total (offer_name NULL = "all offers",
  -- the row the guarantee is judged on) and the per-offer split in ONE pass,
  -- so the two can never disagree with each other.
  SELECT day, webmaster,
         offer_name,
         count(*)::int,
         count(*) FILTER (WHERE ok)::int,
         round(100.0 * count(*) FILTER (WHERE ok) / NULLIF(count(*), 0), 1)
  FROM base
  GROUP BY GROUPING SETS ((day, webmaster), (day, webmaster, offer_name))
  ORDER BY day DESC, webmaster, offer_name NULLS FIRST;
$$;
COMMENT ON FUNCTION public.altercpa_daily_rates(date, date) IS
  'Guarantee tracking for /altercpa Rates. offer_name IS NULL = the affiliate total for that day, which is the row the 30% deal is judged on; non-null rows are the per-offer split for diagnosis only.';
REVOKE ALL ON FUNCTION public.altercpa_daily_rates(date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.altercpa_daily_rates(date, date) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
