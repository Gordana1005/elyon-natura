-- ============================================================================
-- AlterCPA guarantee alerts v2 (plan 01.10.2026, Фаза 5) — far less noise
-- ============================================================================
-- APPLY IN THE QUIET WINDOW (after 20:55 Skopje): it drops a trigger on
-- public.orders (ACCESS EXCLUSIVE, lock_timeout 5 s).
--
-- Before: 9.153 notifications in 30 days to 14 people (~22 a day each) — a ping
-- on every 10th lead and every 10th confirmation (trg_altercpa_lead_rate,
-- trg_altercpa_confirm_rate, 20260922000000 / 20260934000200), counted with the
-- OLD sticky-CRM metric. The /altercpa Денес tab now does that job live.
--
-- After (expected 1–3 a day per person), counted with the NEW metric of
-- 20260944000210 — (approved + cancel_other) ÷ every MK lead, test leads apart —
-- and only for a webmaster with at least altercpa_rate_min_cohort leads:
--   digest        at altercpa_rate_digest_hour (18:xx): ONE notification per
--                 person, only if some webmaster of TODAY is still under target;
--                 lists them "Fomikch 27.4% +4/12 · …" (rate, confirmations
--                 still needed / open)
--   unreachable   12:00–20:59, once per webmaster per day: even confirming every
--                 open lead cannot reach the target today
--   verdict_close 21:xx, only a webmaster under target today
--   verdict_final 10:xx, the cohort settle_days old, only if still under
-- Every alert fires once: the altercpa_rate_alerts ledger (PK webmaster,
-- cohort_date, kind, milestone = the target) with ON CONFLICT DO NOTHING; the
-- digest is the row webmaster '*'.
--
-- The pure twin is alertDecisions() in supabase/functions/api/altercpaGuarantee.ts
-- (unit-tested). Notification types are the existing altercpa_rate /
-- altercpa_rate_below, so the bell needs no change; English in the DB +
-- meta.i18n (notif.altercpaGuaranteeDigest / Unreachable / Close / Final).
--
-- What changes:
--   * the two old triggers are DROPPED; their functions (tg_altercpa_lead_rate,
--     tg_altercpa_confirm_rate, notify_altercpa_rate, altercpa_rate_cohort,
--     altercpa_rate_verdict*, altercpa_daily_rates) stay dormant until Фаза 8
--   * cron altercpa-rate-verdicts → altercpa-guarantee-sweep ('5 * * * *'; the
--     function picks the local hours, so DST cannot move it)
--   * the ledger CHECK gains 'digest', 'unreachable', 'verdict_close' (old kinds kept)
-- altercpa-sync is not touched. Check: node scripts/verify-altercpa-guarantee.mjs (G8).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $req$
BEGIN
  IF to_regprocedure('public.altercpa_guarantee_rates(date,date)') IS NULL
     OR to_regprocedure('public.altercpa_need_confirm(integer,integer,numeric)') IS NULL THEN
    RAISE EXCEPTION 'apply 20260944000210 (the guarantee read model) first';
  END IF;
END
$req$;

-- ── 1. The old pings stop ──────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_altercpa_lead_rate ON public.altercpa_leads;
DROP TRIGGER IF EXISTS trg_altercpa_confirm_rate ON public.orders;

-- ── 2. The ledger knows the new kinds (the old ones stay valid) ────────────
ALTER TABLE public.altercpa_rate_alerts DROP CONSTRAINT IF EXISTS altercpa_rate_alerts_kind_check;
ALTER TABLE public.altercpa_rate_alerts ADD CONSTRAINT altercpa_rate_alerts_kind_check
  CHECK (kind IN ('leads', 'confirms', 'verdict_day', 'verdict_final', 'digest', 'unreachable', 'verdict_close'));

-- ── 3. Fan-out: one race-safe ledger row, then DISTINCT active admins + managers ──
CREATE OR REPLACE FUNCTION public.notify_altercpa_guarantee(
  _wm      text,
  _cohort  date,
  _kind    text,
  _target  numeric,
  _leads   integer,
  _counted integer,
  _open    integer,
  _items   text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _t      numeric := LEAST(100, GREATEST(1, coalesce(_target, 30)));
  _ti     integer := round(LEAST(100, GREATEST(1, coalesce(_target, 30))))::integer;
  _n_l    integer := GREATEST(coalesce(_leads, 0), 0);
  _n_c    integer := GREATEST(coalesce(_counted, 0), 0);
  _n_o    integer := GREATEST(coalesce(_open, 0), 0);
  _need   integer;
  _pct    numeric;
  _max    numeric;
  _dd     text := to_char(_cohort, 'DD.MM');
  _iso    text := to_char(_cohort, 'YYYY-MM-DD');
  _name   text;
  _key    text;
  _type   text;
  _title  text;
  _msg    text;
  _link   text;
  _sent   integer;
BEGIN
  IF _kind NOT IN ('digest', 'unreachable', 'verdict_close', 'verdict_final') OR _wm IS NULL OR _cohort IS NULL THEN
    RAISE EXCEPTION 'notify_altercpa_guarantee: bad kind/webmaster/cohort (%, %, %)', _kind, _wm, _cohort;
  END IF;

  -- The single dedupe gate: a fired (webmaster, cohort, kind, target) never fires again.
  INSERT INTO public.altercpa_rate_alerts (webmaster, cohort_date, kind, milestone, sent, confirmed)
  VALUES (_wm, _cohort, _kind, _ti, _n_l, _n_c)
  ON CONFLICT (webmaster, cohort_date, kind, milestone) DO NOTHING;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  _need := public.altercpa_need_confirm(_n_c, _n_l, _t);
  _pct  := CASE WHEN _n_l > 0 THEN round(_n_c * 100.0 / _n_l, 1) ELSE 0 END;
  _max  := CASE WHEN _n_l > 0 THEN round((_n_c + _n_o) * 100.0 / _n_l, 1) ELSE 0 END;

  IF _wm <> '*' THEN
    SELECT w.name INTO _name
    FROM public.altercpa_webmasters w
    WHERE w.wm_id = _wm AND w.name IS NOT NULL
    ORDER BY w.seen_count DESC
    LIMIT 1;
    _name := coalesce(_name, '#' || _wm);
  END IF;

  IF _kind = 'digest' THEN
    _key := 'notif.altercpaGuaranteeDigest'; _type := 'altercpa_rate';
    _title := 'Affiliates under the guarantee today';
    _msg := 'Under the ' || _ti || '% guarantee on ' || _dd
            || ' (rate, confirmations still needed / open): ' || coalesce(_items, '');
    _link := '/altercpa?tab=today&day=' || _iso;
  ELSIF _kind = 'unreachable' THEN
    _key := 'notif.altercpaGuaranteeUnreachable'; _type := 'altercpa_rate_below';
    _title := 'Affiliate cannot reach the guarantee today';
    _msg := 'Affiliate ' || _name || ' — ' || _dd || ': even with all ' || _n_o
            || ' open leads confirmed it ends at ' || _max || '% (' || _n_c || '/' || _n_l
            || ' now) — under the ' || _ti || '% guarantee.';
    _link := '/altercpa?tab=rates&wm=' || _wm || '&date=' || _iso;
  ELSIF _kind = 'verdict_close' THEN
    _key := 'notif.altercpaGuaranteeClose'; _type := 'altercpa_rate_below';
    _title := 'Affiliate closes the day under the guarantee';
    _msg := 'Affiliate ' || _name || ' closes ' || _dd || ' at ' || _pct || '% (' || _n_c || '/' || _n_l
            || ') — under the ' || _ti || '% guarantee. ' || _need || ' more confirmations needed, '
            || _n_o || ' leads still open.';
    _link := '/altercpa?tab=rates&wm=' || _wm || '&date=' || _iso;
  ELSE
    _key := 'notif.altercpaGuaranteeFinal'; _type := 'altercpa_rate_below';
    _title := 'Affiliate finished under the guarantee';
    _msg := 'Affiliate ' || _name || ' finished ' || _dd || ' at ' || _pct || '% (' || _n_c || '/' || _n_l
            || ') — under the ' || _ti || '% guarantee. This cohort has settled.';
    _link := '/altercpa?tab=rates&wm=' || _wm || '&date=' || _iso;
  END IF;

  -- DISTINCT: somebody holding both roles gets ONE copy.
  INSERT INTO public.notifications (user_id, type, title, message, link, meta)
  SELECT DISTINCT ur.user_id, _type, _title, _msg, _link,
         jsonb_build_object(
           'i18n', _key, 'affiliate', _name, 'wm', _wm, 'date', _dd, 'dateIso', _iso,
           'leads', _n_l, 'counted', _n_c, 'open', _n_o, 'need', _need,
           'pct', _pct, 'maxPct', _max, 'target', _ti, 'items', _items)
  FROM public.user_roles ur
  JOIN public.profiles p ON p.user_id = ur.user_id AND p.is_active
  WHERE ur.role IN ('admin', 'manager');
  GET DIAGNOSTICS _sent = ROW_COUNT;
  RETURN _sent;
END;
$fn$;
COMMENT ON FUNCTION public.notify_altercpa_guarantee(text, date, text, numeric, integer, integer, integer, text) IS
  'AlterCPA guarantee alert fan-out (v2): one altercpa_rate_alerts row (race-safe, fires once), then one notification per active admin/manager. English + meta.i18n notif.altercpaGuarantee{Digest,Unreachable,Close,Final}; types altercpa_rate / altercpa_rate_below. Migration 20260944000300.';

-- ── 4. The hourly sweep — the function picks the local hours ───────────────
CREATE OR REPLACE FUNCTION public.altercpa_guarantee_sweep()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _hour   integer   := extract(hour FROM (now() AT TIME ZONE public.crm_tz()))::integer;
  _today  date      := (now() AT TIME ZONE public.crm_tz())::date;
  _target numeric;
  _min    integer;
  _settle integer;
  _digest integer;
  _items  text;
  _tl     integer;
  _tc     integer;
  _to     integer;
  r       record;
BEGIN
  -- app_settings.value is jsonb: the #>> '{}' unwrap is required.
  SELECT (value #>> '{}')::numeric INTO _target FROM public.app_settings WHERE key = 'altercpa_rate_target_pct';
  _target := LEAST(100, GREATEST(1, coalesce(_target, 30)));
  SELECT (value #>> '{}')::integer INTO _min FROM public.app_settings WHERE key = 'altercpa_rate_min_cohort';
  _min := GREATEST(coalesce(_min, 20), 1);
  SELECT (value #>> '{}')::integer INTO _settle FROM public.app_settings WHERE key = 'altercpa_rate_settle_days';
  _settle := GREATEST(coalesce(_settle, 3), 1);
  SELECT (value #>> '{}')::integer INTO _digest FROM public.app_settings WHERE key = 'altercpa_rate_digest_hour';
  _digest := CASE WHEN _digest BETWEEN 0 AND 23 THEN _digest ELSE 18 END;

  -- unreachable: 12:00–20:59, today, C + O < required
  IF _hour BETWEEN 12 AND 20 THEN
    FOR r IN
      SELECT x.webmaster, x.leads, x.counted, x.open
      FROM public.altercpa_guarantee_rates(_today, _today) x
      WHERE x.grain = 'webmaster' AND x.leads >= _min
        AND public.altercpa_need_confirm(x.counted, x.leads, _target) > x.open
    LOOP
      PERFORM public.notify_altercpa_guarantee(r.webmaster, _today, 'unreachable', _target, r.leads, r.counted, r.open, NULL);
    END LOOP;
  END IF;

  -- digest: one per person, only if some webmaster of today still needs confirmations
  IF _hour = _digest THEN
    SELECT string_agg(coalesce(w.name, '#' || x.webmaster) || ' '
                      || round(x.counted * 100.0 / x.leads, 1) || '% +' || x.need || '/' || x.open,
                      ' · ' ORDER BY x.need DESC, x.webmaster),
           sum(x.leads)::integer, sum(x.counted)::integer, sum(x.open)::integer
      INTO _items, _tl, _tc, _to
    FROM (
      SELECT g.webmaster, g.leads, g.counted, g.open,
             public.altercpa_need_confirm(g.counted, g.leads, _target) AS need
      FROM public.altercpa_guarantee_rates(_today, _today) g
      WHERE g.grain = 'webmaster' AND g.leads >= _min
    ) x
    LEFT JOIN LATERAL (
      SELECT aw.name FROM public.altercpa_webmasters aw
      WHERE aw.wm_id = x.webmaster AND aw.name IS NOT NULL
      ORDER BY aw.seen_count DESC LIMIT 1
    ) w ON true
    WHERE x.need > 0;
    IF _items IS NOT NULL THEN
      PERFORM public.notify_altercpa_guarantee('*', _today, 'digest', _target, _tl, _tc, _to, _items);
    END IF;
  END IF;

  -- verdict_close: 21:xx, today, under target
  IF _hour = 21 THEN
    FOR r IN
      SELECT x.webmaster, x.leads, x.counted, x.open
      FROM public.altercpa_guarantee_rates(_today, _today) x
      WHERE x.grain = 'webmaster' AND x.leads >= _min
        AND public.altercpa_need_confirm(x.counted, x.leads, _target) > 0
    LOOP
      PERFORM public.notify_altercpa_guarantee(r.webmaster, _today, 'verdict_close', _target, r.leads, r.counted, r.open, NULL);
    END LOOP;
  END IF;

  -- verdict_final: 10:xx, the cohort settle_days old, still under target
  IF _hour = 10 THEN
    FOR r IN
      SELECT x.webmaster, x.leads, x.counted, x.open
      FROM public.altercpa_guarantee_rates(_today - _settle, _today - _settle) x
      WHERE x.grain = 'webmaster' AND x.leads >= _min
        AND public.altercpa_need_confirm(x.counted, x.leads, _target) > 0
    LOOP
      PERFORM public.notify_altercpa_guarantee(r.webmaster, _today - _settle, 'verdict_final', _target, r.leads, r.counted, r.open, NULL);
    END LOOP;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- The scheduler must never error the cron job; a warning lands in the log.
  RAISE WARNING 'altercpa_guarantee_sweep failed: % (%)', SQLERRM, SQLSTATE;
  RETURN;
END;
$fn$;
COMMENT ON FUNCTION public.altercpa_guarantee_sweep() IS
  'AlterCPA guarantee alerts v2, hourly at :05 (cron altercpa-guarantee-sweep): unreachable 12–20 h · digest at altercpa_rate_digest_hour · verdict_close 21 h · verdict_final 10 h (cohort settle_days old). Webmasters with ≥ min_cohort leads only. Twin: alertDecisions() in altercpaGuarantee.ts. Migration 20260944000300.';

REVOKE ALL ON FUNCTION public.notify_altercpa_guarantee(text, date, text, numeric, integer, integer, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.altercpa_guarantee_sweep() FROM PUBLIC, anon, authenticated;

-- ── 5. The cron: the old verdict sweep out, the new one in ─────────────────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'altercpa-rate-verdicts') THEN
    PERFORM cron.unschedule('altercpa-rate-verdicts');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'altercpa-guarantee-sweep') THEN
    PERFORM cron.unschedule('altercpa-guarantee-sweep');
  END IF;
END
$cron$;
-- Hourly; the function picks the local hours (pg_cron fires in UTC).
SELECT cron.schedule('altercpa-guarantee-sweep', '5 * * * *',
  $job$SELECT public.altercpa_guarantee_sweep();$job$);

COMMIT;

NOTIFY pgrst, 'reload schema';
